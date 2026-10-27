"""Sanar y Criar: sign-up rate limits (per IP, per org, per address)."""

import pytest

from src.services.newsletter.common import client_rate_key
from src.tests.newsletter.conftest import BASE


@pytest.fixture
def limiter(monkeypatch):
    """A counting ``check_rate_limit`` in place of Redis; rate limits switched on."""
    monkeypatch.setenv("TESTING", "false")
    monkeypatch.setenv("LEARNHOUSE_SECURITY__TRUST_PROXY_HEADERS", "true")
    counts: dict[str, int] = {}

    def fake_check_rate_limit(key, max_attempts, window_seconds, r=None):
        counts[key] = counts.get(key, 0) + 1
        return counts[key] <= max_attempts, counts[key], window_seconds

    monkeypatch.setattr("src.services.security.rate_limiting.check_rate_limit", fake_check_rate_limit)
    return counts


async def _post(client, email, ip, **extra):
    payload = {"email": email, "website": "", "source": "popup", "page": "/"}
    payload.update(extra)
    return await client.post(f"{BASE}/subscribe", json=payload, headers={"X-Forwarded-For": ip})


class TestRateLimit:
    async def test_eleventh_request_from_one_ip_is_429(self, client, org, limiter):
        for i in range(10):
            response = await _post(client, f"persona{i}@example.com", "81.2.69.10")
            assert response.status_code == 200, (i, response.text)
        blocked = await _post(client, "persona10@example.com", "81.2.69.10")
        assert blocked.status_code == 429
        assert blocked.headers["retry-after"] == "600"
        assert blocked.json()["detail"] == "Demasiados intentos. Espera un momento e inténtalo de nuevo."
        # Another address from another IP still gets through.
        assert (await _post(client, "otra@example.com", "81.2.69.11")).status_code == 200

    async def test_honeypot_hits_count_against_the_ip(self, client, org, limiter):
        for _ in range(10):
            assert (await _post(client, "bot@example.com", "81.2.69.20", website="x")).status_code == 200
        assert (await _post(client, "bot@example.com", "81.2.69.20", website="x")).status_code == 429

    async def test_sixth_attempt_same_address_from_many_ips_is_429(self, client, org, limiter):
        for i in range(5):
            response = await _post(client, "ana@example.com", f"81.2.70.{i + 1}")
            assert response.status_code == 200, (i, response.text)
        blocked = await _post(client, "ANA@example.com", "81.2.70.99")
        assert blocked.status_code == 429
        assert blocked.headers["retry-after"] == "3600"
        # The address is keyed by a hash: it never reaches Redis in clear.
        assert all("@" not in key and "ana" not in key for key in limiter)
        assert any(key.startswith("sc_nl_sub_email:1:") for key in limiter)

    async def test_org_limit_key(self, client, org, limiter):
        await _post(client, "ana@example.com", "81.2.69.30")
        assert limiter["sc_nl_sub_org:1"] == 1
        assert limiter["sc_nl_sub_ip:81.2.69.30"] == 1

    async def test_bots_and_junk_do_not_use_up_the_org_quota(self, client, org, limiter):
        await _post(client, "bot@example.com", "81.2.69.50", website="x")
        await _post(client, "no-es-un-correo", "81.2.69.51")
        assert "sc_nl_sub_org:1" not in limiter
        await _post(client, "ana@example.com", "81.2.69.52")
        assert limiter["sc_nl_sub_org:1"] == 1

    async def test_known_and_new_addresses_both_count_for_the_org(self, client, org, limiter):
        # Counting only new rows would let a 429 tell which addresses exist.
        await _post(client, "ana@example.com", "81.2.69.60")
        await _post(client, "ana@example.com", "81.2.69.61")
        assert limiter["sc_nl_sub_org:1"] == 2

    async def test_ipv6_is_limited_per_64(self, client, org, limiter):
        for i in range(10):
            response = await _post(client, f"v6persona{i}@example.com", f"2a01:4f8:1:2::{i + 1:x}")
            assert response.status_code == 200, (i, response.text)
        # Another address of the same /64 shares the quota...
        blocked = await _post(client, "v6otra@example.com", "2a01:4f8:1:2:ffff::1")
        assert blocked.status_code == 429
        assert "sc_nl_sub_ip:2a01:4f8:1:2::/64" in limiter
        # ...while a different /64 does not.
        assert (await _post(client, "v6tercera@example.com", "2a01:4f8:1:3::1")).status_code == 200

    async def test_redis_failure_lets_requests_through(self, client, org, monkeypatch):
        monkeypatch.setenv("TESTING", "false")

        def broken(*args, **kwargs):
            raise RuntimeError("redis down")

        monkeypatch.setattr("src.services.security.rate_limiting.check_rate_limit", broken)
        for i in range(12):
            response = await _post(client, "ana@example.com", "81.2.69.40")
            assert response.status_code == 200, (i, response.text)


class TestClientRateKey:
    def test_keys(self):
        assert client_rate_key("81.2.69.10") == "81.2.69.10"
        assert client_rate_key("2001:db8:1:2:3:4:5:6") == "2001:db8:1:2::/64"
        assert client_rate_key("::ffff:81.2.69.10") == "81.2.69.10"
        assert client_rate_key("unknown") == "unknown"

"""Sanar y Criar: BCV rate for Pago Móvil (src/services/payments/fx.py):
validation of the dolarapi answer, Redis cache and negative cache, the ±20 %
band with a candidate confirmed 10 min later, the 96 h reference and stale
fallback, one download at a time (deadline, 64 KB cap) and the manual rate.
The download function is patched: no test reaches the network."""

import asyncio
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pytest
from sqlmodel import select

from src.db.payments.purchases import PaymentsFxRate
from src.services.payments import fx
from src.services.payments.common import utcnow

PAYLOAD = {
    "moneda": "USD", "fuente": "oficial", "nombre": "Dólar", "compra": None, "venta": None,
    "promedio": 887.302, "fechaActualizacion": "2026-10-27T00:00:00-04:00",
}


class FakeRedis:
    def __init__(self):
        self.data: dict = {}
        self.ttl: dict = {}

    def get(self, key):
        return self.data.get(key)

    def set(self, key, value, ex=None, nx=False):
        if nx and key in self.data:
            return None
        self.data[key] = value.encode() if isinstance(value, str) else value
        self.ttl[key] = ex
        return True


@pytest.fixture
def source():
    """The rate source: tests set ``payload`` or ``error``; ``calls`` counts."""
    state = SimpleNamespace(payload=dict(PAYLOAD), error=None, calls=0)

    async def fake_fetch():
        state.calls += 1
        if state.error is not None:
            raise state.error
        return state.payload

    with patch.object(fx, "fetch_bcv_payload", new=fake_fetch):
        yield state


async def _stored(db) -> list[PaymentsFxRate]:
    return list((await db.execute(
        select(PaymentsFxRate).order_by(PaymentsFxRate.id).execution_options(populate_existing=True)
    )).scalars().all())


async def _store(db, rate: str, rate_date: date, age: timedelta) -> None:
    db.add(PaymentsFxRate(source="bcv", rate=Decimal(rate), rate_date=rate_date, fetched_at=utcnow() - age))
    await db.commit()


class TestParse:
    def test_valid_answer(self):
        rate, value_date = fx.parse_bcv_payload(PAYLOAD)
        assert rate == Decimal("887.302") and rate.as_tuple().exponent == -6
        assert value_date == date(2026, 10, 27)

    @pytest.mark.parametrize("change", [
        {"moneda": "EUR"},
        {"fuente": "paralelo"},
        {"promedio": None},
        {"promedio": "887.30"},
        {"promedio": True},
        {"promedio": 0},
        {"promedio": -5.5},
        {"promedio": float("inf")},
        {"promedio": float("nan")},
        {"promedio": 10_000_000},
    ])
    def test_invalid_answer(self, change):
        with pytest.raises(ValueError):
            fx.parse_bcv_payload({**PAYLOAD, **change})

    @pytest.mark.parametrize("payload", [[], "887.3", None])
    def test_not_an_object(self, payload):
        with pytest.raises(ValueError):
            fx.parse_bcv_payload(payload)

    def test_value_date_is_the_caracas_date(self):
        # 03:00 UTC on the 28th is still the 27th in Caracas (UTC-4).
        _, value_date = fx.parse_bcv_payload({**PAYLOAD, "fechaActualizacion": "2026-10-28T03:00:00Z"})
        assert value_date == date(2026, 10, 27)
        _, value_date = fx.parse_bcv_payload({**PAYLOAD, "fechaActualizacion": "2026-10-28"})
        assert value_date == date(2026, 10, 28)

    def test_six_decimals(self):
        rate, _ = fx.parse_bcv_payload({**PAYLOAD, "promedio": 36.12345678})
        assert rate == Decimal("36.123457")

    def test_to_ves_rounds_half_up(self):
        assert fx.to_ves(Decimal("40.00"), Decimal("887.302")) == Decimal("35492.08")
        assert fx.to_ves(Decimal("19.99"), Decimal("36.123456")) == Decimal("722.11")
        assert fx.to_ves(Decimal("0.01"), Decimal("0.5")) == Decimal("0.01")  # 0.005 -> 0.01
        assert fx.to_ves(Decimal("0.03"), Decimal("0.5")) == Decimal("0.02")  # 0.015 -> 0.02


class TestBcvRate:
    async def test_fresh_rate_is_stored_once_per_day(self, db, source):
        quote = await fx.bcv_rate(db)
        assert (quote.rate, quote.source, quote.rate_date, quote.stale) == (
            Decimal("887.302"), "bcv", date(2026, 10, 27), False,
        )
        rows = await _stored(db)
        assert len(rows) == 1 and rows[0].rate == Decimal("887.302")

        source.payload = {**PAYLOAD, "promedio": 890.5}
        quote = await fx.bcv_rate(db)
        assert quote.rate == Decimal("890.5")
        rows = await _stored(db)
        assert len(rows) == 1 and rows[0].rate == Decimal("890.5")  # same value date: updated

    async def test_cached_for_half_an_hour(self, db, source):
        redis = FakeRedis()
        with patch.object(fx, "_redis", return_value=redis):
            first = await fx.bcv_rate(db)
            second = await fx.bcv_rate(db)
        assert source.calls == 1
        assert second.rate == first.rate and second.rate_date == first.rate_date and second.stale is False
        assert redis.ttl[fx.CACHE_KEY] == 1800

    async def test_failure_serves_a_recent_rate_as_stale(self, db, source):
        await _store(db, "880", date(2026, 10, 26), timedelta(hours=90))
        source.error = httpx.ConnectError("down")
        redis = FakeRedis()
        with patch.object(fx, "_redis", return_value=redis):
            quote = await fx.bcv_rate(db)
            assert quote.stale is True and quote.rate == Decimal("880") and quote.rate_date == date(2026, 10, 26)
            assert redis.ttl[fx.FAIL_KEY] == 60
            await fx.bcv_rate(db)  # negative cache: the source is not asked again
        assert source.calls == 1

    async def test_nothing_recent_is_unavailable(self, db, source):
        await _store(db, "880", date(2026, 10, 22), timedelta(hours=100))
        source.error = httpx.ConnectError("down")
        with pytest.raises(fx.FxUnavailable):
            await fx.bcv_rate(db)

    async def test_an_invalid_answer_is_a_failure(self, db, source):
        source.payload = {**PAYLOAD, "moneda": "EUR"}
        with pytest.raises(fx.FxUnavailable):
            await fx.bcv_rate(db)
        assert await _stored(db) == []

    async def test_within_twenty_percent_is_accepted(self, db, source):
        await _store(db, "800", date(2026, 10, 26), timedelta(hours=20))
        source.payload = {**PAYLOAD, "promedio": 959.0}  # +19.9 %
        quote = await fx.bcv_rate(db)
        assert (quote.rate, quote.stale, quote.warning) == (Decimal("959"), False, None)
        assert [r.rate for r in await _stored(db)] == [Decimal("800"), Decimal("959")]

    async def test_a_jump_waits_for_a_confirming_reading(self, db, source, caplog):
        await _store(db, "800", date(2026, 10, 26), timedelta(hours=20))
        source.payload = {**PAYLOAD, "promedio": 1000.0}  # +25 %
        quote = await fx.bcv_rate(db)
        # Not accepted yet: the reference is served, with a warning for the admin.
        assert (quote.rate, quote.stale, quote.warning) == (Decimal("800"), True, fx.JUMP_WARNING)
        assert [(r.source, r.rate) for r in await _stored(db)] == [
            ("bcv", Decimal("800")), ("bcv_candidate", Decimal("1000")),
        ]
        assert any(r.levelname == "ERROR" and "20%" in r.getMessage() for r in caplog.records)

        # The same reading 5 min later (within 1 %): still too soon.
        source.payload = {**PAYLOAD, "promedio": 1005.0}
        with patch.object(fx, "utcnow", return_value=utcnow() + timedelta(minutes=5)):
            quote = await fx.bcv_rate(db)
        assert (quote.rate, quote.warning) == (Decimal("800"), fx.JUMP_WARNING)
        candidate = [r for r in await _stored(db) if r.source == "bcv_candidate"]
        assert len(candidate) == 1 and candidate[0].rate == Decimal("1000")  # first-seen time kept

        # 10 min after it was first seen, a matching reading confirms it.
        with patch.object(fx, "utcnow", return_value=utcnow() + timedelta(minutes=11)):
            quote = await fx.bcv_rate(db)
        assert (quote.rate, quote.stale, quote.warning) == (Decimal("1005"), False, None)
        assert [(r.source, r.rate) for r in await _stored(db)] == [
            ("bcv", Decimal("800")), ("bcv", Decimal("1005")),
        ]

    async def test_a_different_second_reading_starts_over(self, db, source):
        await _store(db, "800", date(2026, 10, 26), timedelta(hours=20))
        source.payload = {**PAYLOAD, "promedio": 1000.0}
        await fx.bcv_rate(db)
        source.payload = {**PAYLOAD, "promedio": 1200.0}  # not within 1 % of the candidate
        with patch.object(fx, "utcnow", return_value=utcnow() + timedelta(minutes=30)):
            quote = await fx.bcv_rate(db)
        assert (quote.rate, quote.warning) == (Decimal("800"), fx.JUMP_WARNING)
        candidate = [r for r in await _stored(db) if r.source == "bcv_candidate"]
        assert len(candidate) == 1 and candidate[0].rate == Decimal("1200")

    async def test_the_reference_is_at_most_96_hours_old(self, db, source, caplog):
        # A row older than 96 h is no reference: the first valid reading wins.
        await _store(db, "100", date(2026, 10, 20), timedelta(hours=100))
        with caplog.at_level("INFO", logger="src.services.payments.fx"):
            quote = await fx.bcv_rate(db)
        assert (quote.rate, quote.stale) == (Decimal("887.302"), False)
        assert any("no reference" in r.getMessage() for r in caplog.records)

    async def test_a_new_install_accepts_the_first_reading(self, db, source):
        quote = await fx.bcv_rate(db)
        assert (quote.rate, quote.stale, quote.warning) == (Decimal("887.302"), False, None)

    async def test_a_cached_stale_quote_never_outlives_96_hours(self):
        old = fx.FxQuote(rate=Decimal("800"), source="bcv", rate_date=date(2026, 10, 20),
                         fetched_at=utcnow() - timedelta(hours=97), stale=True)
        assert fx._decode(fx._encode(old)) is None
        fresh = fx.FxQuote(rate=Decimal("800"), source="bcv", rate_date=date(2026, 10, 27),
                           fetched_at=utcnow() - timedelta(hours=1), stale=True, warning=fx.JUMP_WARNING)
        assert fx._decode(fx._encode(fresh)) == fresh

    async def test_one_download_at_a_time(self, db, source):
        gate = asyncio.Event()
        real_fetch = fx.fetch_bcv_payload

        async def slow_fetch():
            await gate.wait()
            return await real_fetch()

        with patch.object(fx, "fetch_bcv_payload", new=slow_fetch):
            first = asyncio.create_task(fx.bcv_rate(db))
            await asyncio.sleep(0.01)
            second = asyncio.create_task(fx.bcv_rate(db))
            await asyncio.sleep(0.01)
            gate.set()
            quotes = await asyncio.gather(first, second)
        assert source.calls == 1  # the second request shared the first one's answer
        assert quotes[0] == quotes[1] and quotes[0].rate == Decimal("887.302")


class TestCurrentRate:
    async def test_manual_rate(self, db, source):
        updated = datetime(2026, 10, 27, 12, 0, tzinfo=timezone.utc)
        cfg = SimpleNamespace(provider_config={"fx_mode": "manual", "fx_manual_rate": "36.5"}, update_date=updated)
        quote = await fx.current_rate(db, cfg)
        assert (quote.rate, quote.source, quote.rate_date, quote.fetched_at, quote.stale) == (
            Decimal("36.5"), "manual", None, updated, False,
        )
        assert source.calls == 0

    async def test_manual_mode_without_rate(self, db, source):
        cfg = SimpleNamespace(provider_config={"fx_mode": "manual", "fx_manual_rate": None}, update_date=None)
        with pytest.raises(fx.FxUnavailable):
            await fx.current_rate(db, cfg)

    async def test_automatic_mode_and_no_config_use_the_bcv(self, db, source):
        cfg = SimpleNamespace(provider_config={"fx_mode": "auto", "fx_manual_rate": "36.5"}, update_date=None)
        assert (await fx.current_rate(db, cfg)).source == "bcv"
        assert (await fx.current_rate(db, None)).rate == Decimal("887.302")


class TestSource:
    def test_url_override_only_in_development(self, monkeypatch):
        monkeypatch.setenv("SC_PAY_FX_URL", "http://localhost:9000/rate")
        with patch.object(fx, "is_development_mode", return_value=False):
            assert fx.fx_url() == fx.BCV_URL
        with patch.object(fx, "is_development_mode", return_value=True):
            assert fx.fx_url() == "http://localhost:9000/rate"
            monkeypatch.setenv("SC_PAY_FX_URL", "javascript:alert(1)")
            assert fx.fx_url() == fx.BCV_URL

    async def test_tests_never_reach_the_network(self):
        with pytest.raises(RuntimeError):
            await fx.fetch_bcv_payload()

    async def test_download_identifies_itself_and_never_follows_redirects(self, monkeypatch):
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            if request.url.path.endswith("/moved"):
                return httpx.Response(301, headers={"Location": "https://evil.example/rate"})
            return httpx.Response(200, json=PAYLOAD)

        real_client = httpx.AsyncClient

        def client(**kwargs):
            assert kwargs["follow_redirects"] is False and kwargs["timeout"] == 8
            return real_client(transport=httpx.MockTransport(handler), **kwargs)

        monkeypatch.setenv("TESTING", "false")
        with patch.object(fx.httpx, "AsyncClient", side_effect=client):
            assert await fx.fetch_bcv_payload() == PAYLOAD
            assert str(seen[0].url) == fx.BCV_URL
            assert seen[0].headers["user-agent"] == "SanaryCriar/1.0"
            with patch.object(fx, "fx_url", return_value="https://ve.dolarapi.com/moved"):
                with pytest.raises(ValueError):
                    await fx.fetch_bcv_payload()
        assert len(seen) == 2  # the redirect target was never requested

    async def test_download_body_is_capped_while_streaming(self, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            # No Content-Length to trust: the cap applies to what is read.
            return httpx.Response(200, stream=httpx.ByteStream(b'{"x": "' + b"a" * (70 * 1024) + b'"}'))

        real_client = httpx.AsyncClient
        monkeypatch.setenv("TESTING", "false")
        with patch.object(fx.httpx, "AsyncClient",
                          side_effect=lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw)):
            with pytest.raises(ValueError, match="too large"):
                await fx.fetch_bcv_payload()

    async def test_download_has_an_overall_deadline(self, monkeypatch):
        async def handler(request: httpx.Request) -> httpx.Response:
            await asyncio.sleep(5)
            return httpx.Response(200, json=PAYLOAD)

        real_client = httpx.AsyncClient
        monkeypatch.setenv("TESTING", "false")
        with patch.object(fx, "DOWNLOAD_DEADLINE_SECONDS", 0.05), \
                patch.object(fx.httpx, "AsyncClient",
                             side_effect=lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw)):
            with pytest.raises(TimeoutError):
                await fx.fetch_bcv_payload()

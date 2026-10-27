"""Sanar y Criar: the static site may POST the newsletter sign-up cross-origin
(credential-less), and nothing else."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from httpx import ASGITransport, AsyncClient

from src.core.middleware.extra_cors import ExtraOriginsCORSMiddleware

SITE = "https://www.example.com"
SUBSCRIBE = "/api/v1/newsletter/1/subscribe"
OTHER_WRITE = "/api/v1/payments/1/offers"


def _cors_app(origins):
    app = FastAPI()

    @app.post(SUBSCRIBE)
    async def subscribe():
        return {"ok": True}

    @app.post(OTHER_WRITE)
    async def offers():
        return {"ok": True}

    @app.put(SUBSCRIBE)
    async def put_subscribe():
        return {"ok": True}

    @app.get("/api/v1/newsletter/1/public-config")
    async def public_config():
        return {"enabled": False}

    regex = r"^https?://(?:(?:www\.)?cursos\.example\.com|localhost|127\.0\.0\.1)(:\d+)?$"
    app.add_middleware(CORSMiddleware, allow_origin_regex=regex, allow_methods=["*"],
                       allow_credentials=True, allow_headers=["*"])
    app.add_middleware(ExtraOriginsCORSMiddleware, origins=origins, main_origin_regex=regex)
    return app


async def _client():
    return AsyncClient(transport=ASGITransport(app=_cors_app([SITE])), base_url="http://api")


def _preflight_headers(method, request_headers=None):
    headers = {"Origin": SITE, "Access-Control-Request-Method": method}
    if request_headers:
        headers["Access-Control-Request-Headers"] = request_headers
    return headers


class TestNewsletterCors:
    async def test_preflight_post_to_subscribe_is_allowed(self):
        async with await _client() as client:
            response = await client.options(SUBSCRIBE, headers=_preflight_headers("POST", "content-type"))
        assert response.status_code == 200
        assert response.headers["access-control-allow-origin"] == SITE
        methods = [m.strip() for m in response.headers["access-control-allow-methods"].split(",")]
        assert "POST" in methods and "PUT" not in methods
        assert response.headers["access-control-allow-headers"] == "content-type"
        assert "access-control-allow-credentials" not in response.headers

    async def test_post_to_subscribe_gets_credentialless_cors(self):
        async with await _client() as client:
            response = await client.post(SUBSCRIBE, json={"email": "ana@example.com"}, headers={"Origin": SITE})
        assert response.status_code == 200
        assert response.headers["access-control-allow-origin"] == SITE
        assert "access-control-allow-credentials" not in response.headers
        assert "origin" in response.headers.get("vary", "").lower()

    async def test_other_write_route_stays_closed(self):
        async with await _client() as client:
            preflight = await client.options(OTHER_WRITE, headers=_preflight_headers("POST", "content-type"))
            assert preflight.status_code == 400
            post = await client.post(OTHER_WRITE, json={}, headers={"Origin": SITE})
            assert "access-control-allow-origin" not in post.headers

    async def test_lookalike_paths_stay_closed(self):
        async with await _client() as client:
            for path in (SUBSCRIBE + "/", SUBSCRIBE + "x", "/api/v1/newsletter/abc/subscribe",
                         "/x" + SUBSCRIBE):
                preflight = await client.options(path, headers=_preflight_headers("POST"))
                assert preflight.status_code == 400, path

    async def test_subscribe_preflight_rejects_authorization_and_put(self):
        async with await _client() as client:
            auth = await client.options(SUBSCRIBE, headers=_preflight_headers("POST", "content-type, authorization"))
            assert auth.status_code == 400
            put = await client.options(SUBSCRIBE, headers=_preflight_headers("PUT", "content-type"))
            assert put.status_code == 400
            put_request = await client.put(SUBSCRIBE, json={}, headers={"Origin": SITE})
            assert "access-control-allow-origin" not in put_request.headers

    async def test_reads_unchanged(self):
        async with await _client() as client:
            response = await client.get("/api/v1/newsletter/1/public-config", headers={"Origin": SITE})
            assert response.headers["access-control-allow-origin"] == SITE
            preflight = await client.options("/api/v1/newsletter/1/public-config", headers=_preflight_headers("GET"))
            assert preflight.status_code == 200
            assert preflight.headers["access-control-allow-methods"] == "GET, HEAD, OPTIONS"

    async def test_main_policy_origin_untouched(self):
        async with await _client() as client:
            response = await client.post(SUBSCRIBE, json={}, headers={"Origin": "http://localhost:4321"})
        assert response.headers["access-control-allow-origin"] == "http://localhost:4321"
        assert response.headers["access-control-allow-credentials"] == "true"

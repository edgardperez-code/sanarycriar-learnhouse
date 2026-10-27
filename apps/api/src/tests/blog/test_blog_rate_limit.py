"""Sanar y Criar: blog rate limits (AI per org and hour, previews per user, covers per org)."""

from datetime import datetime, timezone

from src.db.blog.blog import BlogAIJob
from src.services.blog import jobs
from src.tests.blog.conftest import BASE, create_post

GENERATE = {"prompt": "Un tema de prueba para el blog", "kind": "informativo", "audience": "familias", "length": "corto"}


class TestAIRateLimit:
    async def test_sixteenth_generation_in_the_hour_is_429(self, admin_client, mock_ai, limiter):
        for i in range(15):
            response = await admin_client.post(f"{BASE}/ai/generate", json=GENERATE)
            assert response.status_code == 202, (i, response.text)
            await jobs.wait_for_background()
        blocked = await admin_client.post(f"{BASE}/ai/generate", json=GENERATE)
        assert blocked.status_code == 429
        assert blocked.headers["retry-after"] == "3600"
        assert blocked.json()["detail"] == "Llegaste al límite de 15 usos de la IA por hora. Intenta de nuevo más tarde."
        assert limiter["sc_blog_ai_org:1"] == 16

    async def test_revisions_share_the_quota(self, admin_client, mock_ai, limiter):
        created = await create_post(admin_client)
        limiter["sc_blog_ai_org:1"] = 15
        blocked = await admin_client.post(f"{BASE}/posts/{created['id']}/ai/revise", json={"instruction": "Mejóralo"})
        assert blocked.status_code == 429

    async def test_a_409_does_not_use_the_quota(self, admin_client, db, mock_ai, limiter):
        now = datetime.now(timezone.utc)
        db.add(BlogAIJob(org_id=1, operation="generate", status="running", creation_date=now, update_date=now))
        await db.commit()
        response = await admin_client.post(f"{BASE}/ai/generate", json=GENERATE)
        assert response.status_code == 409
        assert "sc_blog_ai_org:1" not in limiter

    async def test_invalid_bodies_do_not_use_the_quota(self, admin_client, mock_ai, limiter):
        response = await admin_client.post(f"{BASE}/ai/generate", json={**GENERATE, "prompt": "corto"})
        assert response.status_code == 400
        assert "sc_blog_ai_org:1" not in limiter

    async def test_redis_failure_lets_requests_through(self, admin_client, mock_ai, monkeypatch):
        monkeypatch.setenv("TESTING", "false")

        def broken(*args, **kwargs):
            raise RuntimeError("redis down")

        monkeypatch.setattr("src.services.security.rate_limiting.check_rate_limit", broken)
        for _ in range(17):
            response = await admin_client.post(f"{BASE}/ai/generate", json=GENERATE)
            assert response.status_code == 202
            await jobs.wait_for_background()


class TestOtherLimits:
    async def test_preview_limit_per_user(self, admin_client, limiter):
        for _ in range(120):
            assert (await admin_client.post(f"{BASE}/preview", json={"content_md": "Hola"})).status_code == 200
        blocked = await admin_client.post(f"{BASE}/preview", json={"content_md": "Hola"})
        assert blocked.status_code == 429
        assert blocked.headers["retry-after"] == "600"
        assert blocked.json()["detail"] == "Demasiadas vistas previas seguidas. Espera un momento."
        assert "sc_blog_preview:1" in limiter

    async def test_cover_limit_per_org(self, admin_client, limiter):
        created = await create_post(admin_client)
        limiter["sc_blog_cover:1"] = 30
        blocked = await admin_client.put(f"{BASE}/posts/{created['id']}/cover")
        assert blocked.status_code == 429
        assert blocked.headers["retry-after"] == "3600"
        assert blocked.json()["detail"] == "Subiste demasiadas imágenes. Espera un momento e inténtalo de nuevo."

    async def test_public_routes_are_not_limited(self, client, org, limiter):
        for _ in range(5):
            assert (await client.get(f"{BASE}/public/posts")).status_code == 200
        assert limiter == {}

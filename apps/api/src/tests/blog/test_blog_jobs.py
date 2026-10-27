"""Sanar y Criar: background AI jobs of the blog (generate, revise, one at a time, stale jobs)."""

import logging
from datetime import datetime, timedelta, timezone

import pytest
from sqlmodel import select

from src.db.blog.blog import BlogAIJob, BlogPost
from src.services.blog import ai, jobs
from src.tests.blog.conftest import BASE, LONG_MD, article_json, create_post, post_body, publish

GENERATE = {
    "prompt": "Rabietas en niños pequeños y cómo acompañarlas",
    "kind": "informativo",
    "audience": "familias",
    "length": "medio",
    "keyword": "",
    "facts": "",
}


async def _generate(client, **overrides):
    body = dict(GENERATE)
    body.update(overrides)
    return await client.post(f"{BASE}/ai/generate", json=body)


async def _add_job(db, *, org_id=1, minutes_ago=0, status="running", operation="generate", post_id=None):
    created = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    job = BlogAIJob(
        org_id=org_id, operation=operation, status=status, post_id=post_id,
        creation_date=created, update_date=created, started_at=created,
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return job


JOB_KEYS = {
    "id", "operation", "status", "post_id", "applied", "result", "error", "model", "created_at",
    "started_at", "finished_at", "elapsed_seconds", "poll_after_ms",
}


class TestGenerate:
    async def test_generate_with_mock_creates_a_draft(self, admin_client, db, mock_ai):
        response = await _generate(admin_client)
        assert response.status_code == 202, response.text
        job = response.json()
        assert set(job) == JOB_KEYS
        assert (job["operation"], job["status"], job["post_id"], job["applied"]) == ("generate", "pending", None, False)
        assert job["result"] is None and job["error"] is None
        assert job["poll_after_ms"] == 3000
        assert job["elapsed_seconds"] >= 0

        await jobs.wait_for_background()

        done = (await admin_client.get(f"{BASE}/ai/jobs/{job['id']}")).json()
        assert done["status"] == "done", done
        assert done["applied"] is True and done["model"] == "mock"
        assert done["started_at"] is not None and done["finished_at"] is not None
        post = (await admin_client.get(f"{BASE}/posts/{done['post_id']}")).json()
        assert post["status"] == "draft"
        assert post["source"] == "ai" and post["ai_model"] == "mock"
        assert post["slug"] == "rabietas-primera-infancia-acompanar-con-calma"
        assert post["kind"] == "informativo" and post["category"] == "emociones"
        assert post["content_html"].startswith("<p>")
        assert '<h2 id="cuando-consultar">¿Cuándo consultar?</h2>' in post["content_html"]
        assert post["word_count"] >= 350
        assert post["published_at"] is None

        row = (await db.execute(select(BlogAIJob).where(BlogAIJob.id == job["id"]))).scalars().one()
        assert row.created_by_user_id == 1
        assert row.usage_json is None
        # Flags and lengths only: never the owner's text.
        assert row.meta_json == {
            "kind": "informativo", "audience": "familias", "length": "medio",
            "has_keyword": False, "has_facts": False, "prompt_chars": len(GENERATE["prompt"]),
        }

        assert (await admin_client.get(f"{BASE}/ai/jobs/active")).json() == {"job": None}

    async def test_second_draft_gets_a_unique_slug(self, admin_client, mock_ai):
        for _ in range(2):
            assert (await _generate(admin_client)).status_code == 202
            await jobs.wait_for_background()
        listing = (await admin_client.get(f"{BASE}/posts")).json()
        assert sorted(item["slug"] for item in listing["items"]) == [
            "rabietas-primera-infancia-acompanar-con-calma", "rabietas-primera-infancia-acompanar-con-calma-2",
        ]

    async def test_workshop_uses_its_kind_and_the_facts(self, admin_client, mock_ai):
        response = await _generate(admin_client, kind="taller", facts="Sábado 15/11 a las 9:00 a.m. en Lechería.")
        await jobs.wait_for_background()
        job = (await admin_client.get(f"{BASE}/ai/jobs/{response.json()['id']}")).json()
        post = (await admin_client.get(f"{BASE}/posts/{job['post_id']}")).json()
        assert (post["kind"], post["category"]) == ("taller", "talleres-y-novedades")
        assert post["content_md"].endswith("## Cómo participar\n\nSábado 15/11 a las 9:00 a.m. en Lechería.")

    async def test_active_job_is_reported(self, admin_client, db, mock_ai):
        running = await _add_job(db)
        active = (await admin_client.get(f"{BASE}/ai/jobs/active")).json()["job"]
        assert active["id"] == running.id and active["status"] == "running"

    async def test_second_generate_while_one_is_active_is_409(self, admin_client, db, mock_ai):
        await _add_job(db)
        response = await _generate(admin_client)
        assert response.status_code == 409
        assert response.json()["detail"] == "Ya hay una tarea de IA en curso. Espera a que termine."

    async def test_stale_job_is_marked_interrupted(self, admin_client, db, mock_ai):
        stale = await _add_job(db, minutes_ago=11)
        job = (await admin_client.get(f"{BASE}/ai/jobs/{stale.id}")).json()
        assert job["status"] == "error"
        assert job["error"] == jobs.STALE_ERROR == "La tarea se interrumpió. Intenta de nuevo."
        assert job["finished_at"] is not None
        assert (await admin_client.get(f"{BASE}/ai/jobs/active")).json() == {"job": None}
        # And it no longer blocks a new one.
        assert (await _generate(admin_client)).status_code == 202
        await jobs.wait_for_background()

    async def test_result_of_a_job_expired_meanwhile_is_discarded(self, admin_client, db, mock_ai, monkeypatch):
        original = ai.generate_article

        async def slow_generate(params):
            result = await original(params)
            row = (await db.execute(select(BlogAIJob))).scalars().one()
            row.status, row.error = "error", jobs.STALE_ERROR
            db.add(row)
            await db.commit()
            return result

        monkeypatch.setattr(ai, "generate_article", slow_generate)
        await _generate(admin_client)
        await jobs.wait_for_background()
        assert (await db.execute(select(BlogPost))).scalars().first() is None
        row = (await db.execute(select(BlogAIJob))).scalars().one()
        assert (row.status, row.error, row.post_id) == ("error", jobs.STALE_ERROR, None)

    async def test_refusal_ends_in_error_without_a_post(self, admin_client, db, fake_claude):
        fake_claude.stop_reason = "refusal"
        job = (await _generate(admin_client)).json()
        await jobs.wait_for_background()
        done = (await admin_client.get(f"{BASE}/ai/jobs/{job['id']}")).json()
        assert done["status"] == "error"
        assert done["error"].startswith("La IA no pudo escribir sobre este tema.")
        assert done["post_id"] is None
        assert (await db.execute(select(BlogPost))).scalars().first() is None

    async def test_claude_answer_becomes_a_draft(self, admin_client, db, fake_claude):
        job = (await _generate(admin_client, facts="Inscripción: https://inscripcion.example.com/x")).json()
        await jobs.wait_for_background()
        done = (await admin_client.get(f"{BASE}/ai/jobs/{job['id']}")).json()
        assert done["status"] == "done" and done["model"] == "claude-opus-5-5"
        row = await db.get(BlogAIJob, job["id"])
        assert row.usage_json == {
            "input_tokens": 1200, "output_tokens": 900, "cache_read_input_tokens": 1000,
            "cache_creation_input_tokens": 0,
        }
        post = (await admin_client.get(f"{BASE}/posts/{done['post_id']}")).json()
        assert post["slug"] == "miedo-a-la-oscuridad"
        assert post["ai_model"] == "claude-opus-5-5"
        assert '<a href="/agenda">agenda</a>' in post["content_html"]

    async def test_unexpected_error_is_generic_and_not_logged_with_text(
        self, admin_client, db, mock_ai, monkeypatch, caplog
    ):
        secret = "SECRETO-ERROR-9911"

        async def broken(params):
            raise RuntimeError(secret)

        monkeypatch.setattr(ai, "generate_article", broken)
        caplog.set_level(logging.DEBUG)
        job = (await _generate(admin_client, prompt="SECRETO-PROMPT-4242 tema de prueba")).json()
        await jobs.wait_for_background()
        done = (await admin_client.get(f"{BASE}/ai/jobs/{job['id']}")).json()
        assert done["status"] == "error"
        assert done["error"] == "Ocurrió un error inesperado con la IA. Intenta de nuevo."
        assert "RuntimeError" in caplog.text
        assert secret not in caplog.text
        assert "SECRETO-PROMPT-4242" not in caplog.text

    @pytest.mark.parametrize("overrides,detail", [
        ({"prompt": "corto"}, "Escribe el tema o la indicación (entre 10 y 4000 caracteres)."),
        ({"prompt": "x" * 4001}, "Escribe el tema o la indicación (entre 10 y 4000 caracteres)."),
        ({"kind": "otro"}, "Elige un tipo de artículo válido."),
        ({"audience": "nadie"}, "Elige un público válido."),
        ({"length": "enorme"}, "Elige una extensión válida."),
        ({"keyword": "x" * 81}, "La palabra clave admite como máximo 80 caracteres."),
        ({"facts": "x" * 2001}, "Los datos admiten como máximo 2000 caracteres."),
    ])
    async def test_generate_validation(self, admin_client, db, mock_ai, overrides, detail):
        response = await _generate(admin_client, **overrides)
        assert response.status_code == 400
        assert response.json()["detail"] == detail
        assert (await db.execute(select(BlogAIJob))).scalars().first() is None

    async def test_without_key_or_mock_is_503(self, admin_client, db):
        response = await _generate(admin_client)
        assert response.status_code == 503
        assert response.json()["detail"] == "La IA no está configurada en el servidor."
        created = await create_post(admin_client)
        revise = await admin_client.post(f"{BASE}/posts/{created['id']}/ai/revise", json={"instruction": "Más breve"})
        assert revise.status_code == 503
        assert (await admin_client.get(f"{BASE}/config")).json()["ai_enabled"] is False

    async def test_job_of_another_org_is_404(self, admin_client, db, other_org):
        foreign = await _add_job(db, org_id=other_org.id, status="done")
        response = await admin_client.get(f"{BASE}/ai/jobs/{foreign.id}")
        assert response.status_code == 404
        assert response.json()["detail"] == "Tarea no encontrada."
        assert (await admin_client.get(f"{BASE}/ai/jobs/999")).status_code == 404


class TestRevise:
    async def test_revise_of_a_draft_is_applied(self, admin_client, db, mock_ai):
        created = await create_post(admin_client, slug="mi-borrador")
        response = await admin_client.post(f"{BASE}/posts/{created['id']}/ai/revise", json={"instruction": "Mejora el resumen"})
        assert response.status_code == 202
        job = response.json()
        assert (job["operation"], job["post_id"]) == ("revise", created["id"])
        await jobs.wait_for_background()

        done = (await admin_client.get(f"{BASE}/ai/jobs/{job['id']}")).json()
        assert done["status"] == "done" and done["applied"] is True and done["result"] is None
        post = (await admin_client.get(f"{BASE}/posts/{created['id']}")).json()
        assert post["summary"].startswith("Resumen revisado en modo de prueba:")
        assert post["slug"] == "mi-borrador"
        assert post["kind"] == created["kind"]
        assert post["status"] == "draft"
        row = await db.get(BlogAIJob, job["id"])
        assert row.meta_json == {"instruction_chars": len("Mejora el resumen")}

    async def test_revise_of_a_published_post_is_only_proposed(self, admin_client, mock_ai):
        created = await create_post(admin_client, slug="ya-publicado")
        await publish(admin_client, created["id"])
        before = (await admin_client.get(f"{BASE}/posts/{created['id']}")).json()
        job = (await admin_client.post(
            f"{BASE}/posts/{created['id']}/ai/revise", json={"instruction": "Mejora el resumen"}
        )).json()
        await jobs.wait_for_background()

        done = (await admin_client.get(f"{BASE}/ai/jobs/{job['id']}")).json()
        assert done["status"] == "done" and done["applied"] is False
        assert set(done["result"]) == set(ai.ARTICLE_FIELDS)
        assert done["result"]["slug"] == "ya-publicado"
        assert done["result"]["summary"].startswith("Resumen revisado en modo de prueba:")
        after = (await admin_client.get(f"{BASE}/posts/{created['id']}")).json()
        assert after == before

    async def test_revise_of_a_draft_saved_meanwhile_is_only_proposed(self, admin_client, mock_ai, monkeypatch):
        created = await create_post(admin_client, slug="dos-pestanas")
        original = ai.revise_article

        async def saved_in_another_tab(article, kind, instruction):
            result = await original(article, kind, instruction)
            response = await admin_client.put(
                f"{BASE}/posts/{created['id']}",
                json=post_body(slug="dos-pestanas", summary="Cambio guardado en la otra pestaña."),
            )
            assert response.status_code == 200
            return result

        monkeypatch.setattr(ai, "revise_article", saved_in_another_tab)
        job = (await admin_client.post(
            f"{BASE}/posts/{created['id']}/ai/revise", json={"instruction": "Mejora el resumen"}
        )).json()
        await jobs.wait_for_background()

        done = (await admin_client.get(f"{BASE}/ai/jobs/{job['id']}")).json()
        assert done["status"] == "done" and done["applied"] is False
        assert done["result"]["slug"] == "dos-pestanas"
        assert done["result"]["summary"].startswith("Resumen revisado en modo de prueba:")
        post = (await admin_client.get(f"{BASE}/posts/{created['id']}")).json()
        assert post["summary"] == "Cambio guardado en la otra pestaña."
        assert post["status"] == "draft"

    async def test_revise_keeps_only_links_she_made_or_asked_for(self, admin_client, fake_claude):
        created = await create_post(
            admin_client,
            content_md=LONG_MD + "\n\nInscripción: [aquí](https://ok.example/inscripcion). Suelto: https://evil.example/suelto",
        )
        fake_claude.text = article_json(content_md=(
            "## Sección\n\n" + "Texto revisado con varias palabras. " * 8 + "\n\n"
            "[aquí](https://ok.example/inscripcion) [suelto](https://evil.example/suelto) "
            "[nuevo](https://nuevo.example/x) [agenda](/agenda)"
        ))
        job = (await admin_client.post(
            f"{BASE}/posts/{created['id']}/ai/revise", json={"instruction": "Enlaza también https://nuevo.example/x"}
        )).json()
        await jobs.wait_for_background()
        assert (await admin_client.get(f"{BASE}/ai/jobs/{job['id']}")).json()["applied"] is True
        post = (await admin_client.get(f"{BASE}/posts/{created['id']}")).json()
        # Already a link in her article / in her instruction / internal: kept. Plain text before: not.
        assert post["content_md"].endswith(
            "[aquí](https://ok.example/inscripcion) suelto [nuevo](https://nuevo.example/x) [agenda](/agenda)"
        )
        assert "evil.example" not in post["content_html"]

    async def test_revise_validation_and_unknown_post(self, admin_client, mock_ai):
        created = await create_post(admin_client)
        short = await admin_client.post(f"{BASE}/posts/{created['id']}/ai/revise", json={"instruction": "no"})
        assert short.status_code == 400
        assert short.json()["detail"] == "Escribe qué quieres mejorar (entre 5 y 2000 caracteres)."
        long = await admin_client.post(f"{BASE}/posts/{created['id']}/ai/revise", json={"instruction": "x" * 2001})
        assert long.status_code == 400
        missing = await admin_client.post(f"{BASE}/posts/999/ai/revise", json={"instruction": "Mejóralo"})
        assert missing.status_code == 404
        assert missing.json()["detail"] == "Artículo no encontrado."

    async def test_revise_of_a_deleted_post_fails(self, admin_client, db, mock_ai, monkeypatch):
        created = await create_post(admin_client)
        original = ai.revise_article

        async def delete_meanwhile(article, kind, instruction):
            result = await original(article, kind, instruction)
            await db.delete(await db.get(BlogPost, created["id"]))
            await db.commit()
            return result

        monkeypatch.setattr(ai, "revise_article", delete_meanwhile)
        job = (await admin_client.post(
            f"{BASE}/posts/{created['id']}/ai/revise", json={"instruction": "Mejora el resumen"}
        )).json()
        await jobs.wait_for_background()
        done = (await admin_client.get(f"{BASE}/ai/jobs/{job['id']}")).json()
        assert (done["status"], done["error"]) == ("error", "El artículo ya no existe.")

    async def test_delete_while_revising_is_409(self, admin_client, db, mock_ai):
        created = await create_post(admin_client)
        await _add_job(db, operation="revise", post_id=created["id"], status="pending")
        response = await admin_client.delete(f"{BASE}/posts/{created['id']}")
        assert response.status_code == 409
        assert response.json()["detail"] == "Espera a que termine la mejora con IA de este artículo."
        # Revising another article meanwhile is also blocked (one job per org).
        other = await create_post(admin_client)
        blocked = await admin_client.post(f"{BASE}/posts/{other['id']}/ai/revise", json={"instruction": "Mejóralo"})
        assert blocked.status_code == 409

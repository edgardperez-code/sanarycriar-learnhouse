"""Sanar y Criar: blog admin routes (access, CRUD, list, slugs, publishing, limits, preview)."""

from datetime import datetime, timedelta, timezone

import pytest
from sqlmodel import select

from src.db.blog.blog import BlogAIJob, BlogPost
from src.db.users import APITokenUser
from src.services.blog.common import LIMITS, SEO_TARGETS
from src.tests.blog.conftest import BASE, LONG_MD, create_post, post_body, publish

ADMIN_ROUTES = [
    ("get", f"{BASE}/config", None),
    ("post", f"{BASE}/preview", {"content_md": "Hola"}),
    ("post", f"{BASE}/ai/generate", {"prompt": "Un tema cualquiera de prueba"}),
    ("get", f"{BASE}/ai/jobs/active", None),
    ("get", f"{BASE}/ai/jobs/1", None),
    ("get", f"{BASE}/posts", None),
    ("post", f"{BASE}/posts", post_body()),
    ("get", f"{BASE}/posts/1", None),
    ("put", f"{BASE}/posts/1", post_body(slug="algo-de-prueba")),
    ("delete", f"{BASE}/posts/1", None),
    ("post", f"{BASE}/posts/1/publish", None),
    ("post", f"{BASE}/posts/1/unpublish", None),
    ("put", f"{BASE}/posts/1/cover", None),
    ("delete", f"{BASE}/posts/1/cover", None),
    ("post", f"{BASE}/posts/1/ai/revise", {"instruction": "Hazlo más corto"}),
]


async def _call(client, method, url, body):
    if body is None:
        return await getattr(client, method)(url)
    return await getattr(client, method)(url, json=body)


class TestAccess:
    @pytest.mark.parametrize("method,url,body", ADMIN_ROUTES)
    async def test_anonymous_is_401(self, client, org, method, url, body):
        response = await _call(client, method, url, body)
        assert response.status_code == 401
        assert response.json()["detail"] == "Authentication required"

    @pytest.mark.parametrize("method,url,body", ADMIN_ROUTES)
    async def test_regular_user_is_403(self, client, current, regular_user, method, url, body):
        current.set(regular_user)
        response = await _call(client, method, url, body)
        assert response.status_code == 403

    @pytest.mark.parametrize("method,url,body", ADMIN_ROUTES)
    async def test_api_token_is_403(self, client, current, org, method, url, body):
        current.set(APITokenUser(
            id=1, user_uuid="apitoken_x", username="token", org_id=org.id, rights={}, token_name="t",
            created_by_user_id=1,
        ))
        response = await _call(client, method, url, body)
        assert response.status_code == 403
        assert response.json()["detail"] == "API tokens cannot manage the blog"

    @pytest.mark.parametrize("method,url,body", ADMIN_ROUTES)
    async def test_admin_of_unknown_org_is_404(self, client, current, admin_user, method, url, body):
        current.set(admin_user)
        response = await _call(client, method, url.replace("/blog/1/", "/blog/999/"), body)
        assert response.status_code == 404
        assert response.json()["detail"] == "Organization not found"


class TestConfig:
    async def test_config_without_ai(self, admin_client):
        data = (await admin_client.get(f"{BASE}/config")).json()
        assert data == {
            "ai_enabled": False, "ai_mock": False, "ai_model": None, "ai_hourly_limit": 15,
            "limits": LIMITS, "seo": SEO_TARGETS,
        }

    async def test_config_with_key_and_mock(self, admin_client, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
        data = (await admin_client.get(f"{BASE}/config")).json()
        assert (data["ai_enabled"], data["ai_mock"], data["ai_model"]) == (True, False, "claude-opus-5-5")
        monkeypatch.setenv("SC_BLOG_AI_MODEL", "claude-sonnet-5-5")
        assert (await admin_client.get(f"{BASE}/config")).json()["ai_model"] == "claude-sonnet-5-5"
        monkeypatch.setenv("SC_BLOG_AI_MOCK", "1")
        data = (await admin_client.get(f"{BASE}/config")).json()
        assert (data["ai_enabled"], data["ai_mock"], data["ai_model"]) == (True, True, "mock")


class TestCrud:
    async def test_create_read_update_delete(self, admin_client, db, storage):
        created = await create_post(
            admin_client, title="  ¿Qué hago con las rabietas?  ", content_html="<script>x</script>",
            status="published", source="ai", published_at="2020-01-01T00:00:00Z",
        )
        assert created["slug"] == "que-hago-con-las-rabietas"
        assert created["title"] == "¿Qué hago con las rabietas?"
        assert created["status"] == "draft"
        assert created["source"] == "manual"
        assert created["published_at"] is None
        assert created["slug_locked"] is False
        assert created["public_path"] == "/blog/que-hago-con-las-rabietas"
        assert created["content_html"].startswith('<h2 id="primera-seccion">Primera sección</h2>')
        assert "<script>" not in created["content_html"]
        assert created["word_count"] > 40
        assert created["reading_minutes"] == 1
        assert created["cover_url"] is None and created["og_image_url"] is None
        assert len(created["post_uuid"]) == 32
        assert set(created) == {
            "id", "post_uuid", "slug", "slug_locked", "status", "kind", "category", "title", "excerpt",
            "summary", "key_takeaways", "content_md", "content_html", "faq", "meta_title",
            "meta_description", "keywords", "cover_url", "og_image_url", "cover_alt", "word_count",
            "reading_minutes", "source", "ai_model", "public_path", "published_at", "created_at", "updated_at",
        }
        row = await db.get(BlogPost, created["id"])
        assert row.created_by_user_id == 1

        fetched = (await admin_client.get(f"{BASE}/posts/{created['id']}")).json()
        assert fetched == created

        updated = await admin_client.put(f"{BASE}/posts/{created['id']}", json=post_body(
            title="Nuevo título", slug="Nueva Dirección", kind="taller", category="talleres-y-novedades",
            content_md="Texto **nuevo**", keywords=["Uno", "uno", " dos ", ""], key_takeaways=["  a  ", ""],
            faq=[{"question": "", "answer": ""}, {"question": "¿P?", "answer": "R."}],
            summary="Línea uno\r\n\r\n\r\nLínea dos", content_html="<b>ignorado</b>",
        ))
        assert updated.status_code == 200, updated.text
        data = updated.json()
        assert data["slug"] == "nueva-direccion"
        assert (data["kind"], data["category"]) == ("taller", "talleres-y-novedades")
        assert data["content_html"] == "<p>Texto <strong>nuevo</strong></p>\n"
        assert data["word_count"] == 2
        assert data["keywords"] == ["Uno", "dos"]
        assert data["key_takeaways"] == ["a"]
        assert data["faq"] == [{"question": "¿P?", "answer": "R."}]
        assert data["summary"] == "Línea uno\n\nLínea dos"

        deleted = await admin_client.delete(f"{BASE}/posts/{created['id']}")
        assert deleted.status_code == 200
        assert deleted.json() == {"deleted": True}
        assert storage.removed_dirs == [f"org_test/{created['post_uuid']}"]
        assert (await admin_client.get(f"{BASE}/posts/{created['id']}")).status_code == 404

    async def test_unknown_post_is_404(self, admin_client):
        for method, url, body in [
            ("get", f"{BASE}/posts/999", None),
            ("put", f"{BASE}/posts/999", post_body(slug="algo-de-prueba")),
            ("delete", f"{BASE}/posts/999", None),
            ("post", f"{BASE}/posts/999/publish", None),
            ("post", f"{BASE}/posts/999/unpublish", None),
            ("delete", f"{BASE}/posts/999/cover", None),
        ]:
            response = await _call(admin_client, method, url, body)
            assert response.status_code == 404, (method, url)
            assert response.json()["detail"] == "Artículo no encontrado."

    async def test_post_of_another_org_is_404(self, admin_client, db, other_org):
        foreign = BlogPost(org_id=other_org.id, slug="ajeno", title="Ajeno (borrar)")
        db.add(foreign)
        await db.commit()
        await db.refresh(foreign)
        assert (await admin_client.get(f"{BASE}/posts/{foreign.id}")).status_code == 404
        assert (await admin_client.delete(f"{BASE}/posts/{foreign.id}")).status_code == 404

    async def test_wrong_type_is_422(self, admin_client):
        response = await admin_client.post(f"{BASE}/posts", json=post_body(keywords=5))
        assert response.status_code == 422

    async def test_delete_is_refused_while_a_revision_runs(self, admin_client, db, storage):
        created = await create_post(admin_client)
        db.add(BlogAIJob(org_id=1, post_id=created["id"], operation="revise", status="running"))
        await db.commit()
        response = await admin_client.delete(f"{BASE}/posts/{created['id']}")
        assert response.status_code == 409
        assert response.json()["detail"] == "Espera a que termine la mejora con IA de este artículo."
        assert storage.removed_dirs == []

    async def test_stale_revision_does_not_block_delete(self, admin_client, db):
        created = await create_post(admin_client)
        old = datetime.now(timezone.utc) - timedelta(minutes=11)
        db.add(BlogAIJob(
            org_id=1, post_id=created["id"], operation="revise", status="running",
            creation_date=old, update_date=old,
        ))
        await db.commit()
        assert (await admin_client.delete(f"{BASE}/posts/{created['id']}")).status_code == 200


class TestList:
    async def test_list_search_status_counts_and_paging(self, admin_client):
        first = await create_post(admin_client, title="Rabietas en casa (borrar)")
        second = await create_post(admin_client, title="Sueño y RABIETAS (borrar)")
        third = await create_post(admin_client, title="Límites con cariño (borrar)")
        await publish(admin_client, second["id"])

        data = (await admin_client.get(f"{BASE}/posts")).json()
        assert data["total"] == 3 and data["page"] == 1 and data["limit"] == 20
        assert data["counts"] == {"all": 3, "draft": 2, "published": 1}
        # Last updated first (the published one was touched last).
        assert [item["id"] for item in data["items"]] == [second["id"], third["id"], first["id"]]
        assert set(data["items"][0]) == {
            "id", "slug", "title", "status", "kind", "category", "source", "cover_url", "word_count",
            "published_at", "created_at", "updated_at",
        }

        found = (await admin_client.get(f"{BASE}/posts", params={"q": "rabietas"})).json()
        assert {item["id"] for item in found["items"]} == {first["id"], second["id"]}
        assert found["total"] == 2
        assert found["counts"] == {"all": 3, "draft": 2, "published": 1}

        drafts = (await admin_client.get(f"{BASE}/posts", params={"status": "draft", "q": "rabietas"})).json()
        assert [item["id"] for item in drafts["items"]] == [first["id"]]
        published = (await admin_client.get(f"{BASE}/posts", params={"status": "published"})).json()
        assert [item["id"] for item in published["items"]] == [second["id"]]
        ignored = (await admin_client.get(f"{BASE}/posts", params={"status": "otro"})).json()
        assert ignored["total"] == 3

        page2 = (await admin_client.get(f"{BASE}/posts", params={"limit": 2, "page": 2})).json()
        assert page2["total"] == 3 and page2["limit"] == 2
        assert [item["id"] for item in page2["items"]] == [first["id"]]

        none = (await admin_client.get(f"{BASE}/posts", params={"q": "100%_x"})).json()
        assert none["items"] == [] and none["total"] == 0

    async def test_query_bounds(self, admin_client):
        assert (await admin_client.get(f"{BASE}/posts", params={"limit": 101})).status_code == 422
        assert (await admin_client.get(f"{BASE}/posts", params={"page": 0})).status_code == 422
        assert (await admin_client.get(f"{BASE}/posts", params={"page": 4611686018427387904})).status_code == 422
        assert (await admin_client.get(f"{BASE}/posts", params={"page": 100001})).status_code == 422
        assert (await admin_client.get(f"{BASE}/posts", params={"page": 100000})).status_code == 200
        long_q = (await admin_client.get(f"{BASE}/posts", params={"q": "x" * 300})).json()
        assert long_q["items"] == []

    async def test_search_drops_control_characters(self, admin_client):
        # A NUL in the query made PostgreSQL fail (500); it is cleaned like any line of text.
        created = await create_post(admin_client, title="Rabietas en casa (borrar)")
        found = (await admin_client.get(f"{BASE}/posts?q=Rabi%00etas%09en")).json()
        assert [item["id"] for item in found["items"]] == [created["id"]]
        only_controls = (await admin_client.get(f"{BASE}/posts?q=%00%01")).json()
        assert only_controls["total"] == 1


class TestSlugs:
    async def test_slug_from_title_is_made_unique(self, admin_client):
        one = await create_post(admin_client, title="Mismo título")
        two = await create_post(admin_client, title="Mismo título")
        three = await create_post(admin_client, title="  Mismo  título ")
        assert [one["slug"], two["slug"], three["slug"]] == ["mismo-titulo", "mismo-titulo-2", "mismo-titulo-3"]

    async def test_title_without_slug_characters_uses_articulo(self, admin_client):
        one = await create_post(admin_client, title="¿¡!?")
        two = await create_post(admin_client, title="**")
        assert (one["slug"], two["slug"]) == ("articulo", "articulo-2")

    async def test_long_title_slug_is_cut_to_80(self, admin_client):
        one = await create_post(admin_client, title="palabra " * 14)
        two = await create_post(admin_client, title="palabra " * 14)
        assert len(one["slug"]) <= 80 and len(two["slug"]) <= 80
        assert two["slug"].endswith("-2")

    async def test_explicit_slug_taken_is_409(self, admin_client):
        await create_post(admin_client, slug="mi-articulo")
        response = await admin_client.post(f"{BASE}/posts", json=post_body(slug="Mi Artículo"))
        assert response.status_code == 409
        assert response.json()["detail"] == "Ya existe otro artículo con esa dirección. Cambia el slug."

    async def test_put_to_a_taken_slug_is_409(self, admin_client):
        await create_post(admin_client, slug="ocupado")
        other = await create_post(admin_client, slug="libre")
        response = await admin_client.put(f"{BASE}/posts/{other['id']}", json=post_body(slug="ocupado"))
        assert response.status_code == 409

    async def test_same_slug_in_another_org_is_allowed(self, admin_client, db, other_org):
        db.add(BlogPost(org_id=other_org.id, slug="compartido", title="Otra org (borrar)"))
        await db.commit()
        created = await create_post(admin_client, slug="compartido")
        assert created["slug"] == "compartido"

    @pytest.mark.parametrize("slug", ["ab", "***", "x" * 0])
    async def test_invalid_slug_on_put_is_400(self, admin_client, slug):
        created = await create_post(admin_client)
        response = await admin_client.put(f"{BASE}/posts/{created['id']}", json=post_body(slug=slug))
        assert response.status_code == 400
        assert response.json()["detail"] == (
            "La dirección (slug) debe tener entre 3 y 80 caracteres: letras sin acentos, números y guiones."
        )

    async def test_invalid_explicit_slug_on_post_is_400(self, admin_client):
        response = await admin_client.post(f"{BASE}/posts", json=post_body(slug="a!"))
        assert response.status_code == 400


class TestPublishing:
    async def test_publish_unpublish_republish_and_slug_lock(self, admin_client):
        created = await create_post(admin_client, slug="primera-version")
        published = await publish(admin_client, created["id"])
        assert published["status"] == "published"
        assert published["published_at"] is not None
        assert published["slug_locked"] is True
        first_published_at = published["published_at"]

        again = await publish(admin_client, created["id"])  # idempotent
        assert again["published_at"] == first_published_at

        unpublished = await admin_client.post(f"{BASE}/posts/{created['id']}/unpublish")
        assert unpublished.status_code == 200
        data = unpublished.json()
        assert data["status"] == "draft"
        assert data["published_at"] == first_published_at
        assert data["slug_locked"] is True

        republished = await publish(admin_client, created["id"])
        assert republished["published_at"] == first_published_at

        locked = await admin_client.put(f"{BASE}/posts/{created['id']}", json=post_body(slug="otra-direccion"))
        assert locked.status_code == 400
        assert locked.json()["detail"] == "La dirección de un artículo que ya se publicó no se puede cambiar."
        same = await admin_client.put(f"{BASE}/posts/{created['id']}", json=post_body(slug="primera-version"))
        assert same.status_code == 200, same.text

    async def test_publish_requirements(self, admin_client):
        no_excerpt = await create_post(admin_client, excerpt="  ")
        response = await admin_client.post(f"{BASE}/posts/{no_excerpt['id']}/publish")
        assert response.status_code == 400
        assert response.json()["detail"] == "Escribe un extracto antes de publicar."

        short = await create_post(admin_client, content_md="Muy corto.")
        response = await admin_client.post(f"{BASE}/posts/{short['id']}/publish")
        assert response.status_code == 400
        assert response.json()["detail"] == "El contenido es demasiado corto para publicar (mínimo 200 caracteres)."
        assert (await admin_client.get(f"{BASE}/posts/{short['id']}")).json()["status"] == "draft"

    async def test_saving_a_published_post_keeps_the_requirements(self, admin_client):
        created = await create_post(admin_client, slug="publicado")
        await publish(admin_client, created["id"])
        response = await admin_client.put(
            f"{BASE}/posts/{created['id']}", json=post_body(slug="publicado", excerpt="")
        )
        assert response.status_code == 400
        assert response.json()["detail"] == "Escribe un extracto antes de publicar."
        response = await admin_client.put(
            f"{BASE}/posts/{created['id']}", json=post_body(slug="publicado", content_md="corto")
        )
        assert response.json()["detail"] == "El contenido es demasiado corto para publicar (mínimo 200 caracteres)."
        # A draft can be saved without them.
        draft = await create_post(admin_client, excerpt="", content_md="")
        assert draft["excerpt"] == "" and draft["content_html"] == ""


class TestLimits:
    @pytest.mark.parametrize("overrides,detail", [
        ({"title": "   "}, "El título es obligatorio."),
        ({"title": "x" * 121}, "El título admite como máximo 120 caracteres."),
        ({"slug": "-"}, "La dirección (slug) debe tener entre 3 y 80 caracteres: letras sin acentos, números y guiones."),
        ({"kind": "noticia"}, "Elige un tipo de artículo válido."),
        ({"category": "otra"}, "Elige una categoría válida."),
        ({"excerpt": "x" * 301}, "El extracto admite como máximo 300 caracteres."),
        ({"summary": "x" * 801}, "El resumen admite como máximo 800 caracteres."),
        ({"key_takeaways": [f"idea {i}" for i in range(9)]}, "Puedes agregar como máximo 8 ideas clave."),
        ({"key_takeaways": ["x" * 201]}, "Cada idea clave admite como máximo 200 caracteres."),
        ({"content_md": "x" * 60001}, "El contenido admite como máximo 60000 caracteres."),
        ({"faq": [{"question": f"p{i}", "answer": "r"} for i in range(9)]}, "Puedes agregar como máximo 8 preguntas frecuentes."),
        ({"faq": [{"question": "¿Solo pregunta?", "answer": " "}]}, "Cada pregunta frecuente necesita pregunta y respuesta."),
        ({"faq": [{"question": "", "answer": "Solo respuesta"}]}, "Cada pregunta frecuente necesita pregunta y respuesta."),
        ({"faq": [{"question": "x" * 201, "answer": "r"}]}, "Cada pregunta admite como máximo 200 caracteres."),
        ({"faq": [{"question": "p", "answer": "x" * 1201}]}, "Cada respuesta admite como máximo 1200 caracteres."),
        ({"meta_title": "x" * 121}, "El meta título admite como máximo 120 caracteres."),
        ({"meta_description": "x" * 301}, "La meta descripción admite como máximo 300 caracteres."),
        ({"keywords": [f"k{i}" for i in range(13)]}, "Puedes agregar como máximo 12 palabras clave."),
        ({"keywords": ["x" * 61]}, "Cada palabra clave admite como máximo 60 caracteres."),
        ({"cover_alt": "x" * 201}, "El texto alternativo admite como máximo 200 caracteres."),
    ])
    async def test_invalid_values_are_400(self, admin_client, db, overrides, detail):
        response = await admin_client.post(f"{BASE}/posts", json=post_body(**overrides))
        assert response.status_code == 400, response.text
        assert response.json()["detail"] == detail
        assert (await db.execute(select(BlogPost))).scalars().first() is None

    async def test_first_error_wins_in_field_order(self, admin_client):
        response = await admin_client.post(
            f"{BASE}/posts", json=post_body(title="", kind="otro", excerpt="x" * 400)
        )
        assert response.json()["detail"] == "El título es obligatorio."

    async def test_limits_count_after_cleaning(self, admin_client):
        created = await create_post(
            admin_client, title=" " + "x" * 120 + "  ", keywords=["dup", "DUP"] + [f"k{i}" for i in range(11)],
            content_md="a\r\nb\x00c\x07  \n\n",
        )
        assert len(created["title"]) == 120
        assert len(created["keywords"]) == 12
        assert created["content_md"] == "a\nbc"

    async def test_exact_maximums_are_accepted(self, admin_client):
        created = await create_post(
            admin_client, title="x" * 120, excerpt="x" * 300, summary="x" * 800,
            key_takeaways=["x" * 200] * 8, content_md="x" * 60000,
            faq=[{"question": "q" * 200, "answer": "a" * 1200}] * 8,
            meta_title="x" * 120, meta_description="x" * 300,
            keywords=[f"{i}" + "x" * 58 for i in range(12)], cover_alt="x" * 200,
        )
        assert created["word_count"] == 1


class TestPreview:
    async def test_preview_renders_without_storing(self, admin_client, db):
        response = await admin_client.post(f"{BASE}/preview", json={"content_md": "# Hola\n\n<b>x</b> **y**"})
        assert response.status_code == 200
        assert response.json() == {
            "content_html": '<h2 id="hola">Hola</h2>\n<p>&lt;b&gt;x&lt;/b&gt; <strong>y</strong></p>\n',
            # The escaped tag is text the reader sees: "Hola <b>x</b> y".
            "word_count": 5,
        }
        assert (await db.execute(select(BlogPost))).scalars().first() is None

    async def test_preview_limit(self, admin_client):
        ok = await admin_client.post(f"{BASE}/preview", json={"content_md": "x" * 60000})
        assert ok.status_code == 200
        too_long = await admin_client.post(f"{BASE}/preview", json={"content_md": "x" * 60001})
        assert too_long.status_code == 400
        assert too_long.json()["detail"] == "El contenido admite como máximo 60000 caracteres."

    async def test_preview_empty_body(self, admin_client):
        response = await admin_client.post(f"{BASE}/preview", json={})
        assert response.json() == {"content_html": "", "word_count": 0}

    async def test_long_md_is_publishable(self):
        assert len(LONG_MD) >= 200

"""Sanar y Criar: public blog routes (what the marketing site's server reads)."""

from datetime import datetime, timedelta, timezone

from src.db.blog.blog import BlogPost
from src.tests.blog.conftest import BASE

T0 = datetime(2026, 10, 1, 14, 0, tzinfo=timezone.utc)


async def _add(db, slug, *, org_id=1, status="published", days=0, post_id=None, **fields):
    published_at = T0 + timedelta(days=days) if status == "published" else fields.pop("published_at", None)
    row = BlogPost(
        id=post_id,
        org_id=org_id,
        slug=slug,
        title=fields.pop("title", f"Título {slug} (borrar)"),
        status=status,
        published_at=published_at,
        excerpt=fields.pop("excerpt", f"Extracto {slug}"),
        content_html=fields.pop("content_html", "<p>Hola</p>"),
        word_count=fields.pop("word_count", 450),
        creation_date=T0,
        update_date=T0 + timedelta(days=days, hours=1),
        **fields,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


CARD_KEYS = {
    "slug", "title", "excerpt", "kind", "category", "category_label", "cover_url", "cover_alt",
    "published_at", "updated_at", "reading_minutes",
}


class TestPublicList:
    async def test_only_published_of_the_org_newest_first(self, client, db, org, other_org):
        await _add(db, "antiguo", days=0)
        await _add(db, "reciente", days=5, category="sueno-y-rutinas")
        await _add(db, "borrador", status="draft")
        await _add(db, "despublicado", status="draft", published_at=T0)
        await _add(db, "de-otra-org", org_id=other_org.id, days=9)

        response = await client.get(f"{BASE}/public/posts")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        data = response.json()
        assert data["total"] == 2 and data["page"] == 1 and data["limit"] == 12
        assert [item["slug"] for item in data["items"]] == ["reciente", "antiguo"]
        card = data["items"][0]
        assert set(card) == CARD_KEYS
        assert card["category_label"] == "Sueño y rutinas"
        assert card["published_at"] == "2026-10-06T14:00:00+00:00"
        assert card["updated_at"] == "2026-10-06T15:00:00+00:00"
        assert card["reading_minutes"] == 2
        assert card["cover_url"] is None

    async def test_same_date_orders_by_id_desc(self, client, db, org):
        await _add(db, "uno", post_id=10)
        await _add(db, "dos", post_id=11)
        data = (await client.get(f"{BASE}/public/posts")).json()
        assert [item["slug"] for item in data["items"]] == ["dos", "uno"]

    async def test_pagination(self, client, db, org):
        for i in range(5):
            await _add(db, f"articulo-{i}", days=i)
        page = (await client.get(f"{BASE}/public/posts", params={"page": 2, "limit": 2})).json()
        assert page["total"] == 5 and page["page"] == 2 and page["limit"] == 2
        assert [item["slug"] for item in page["items"]] == ["articulo-2", "articulo-1"]
        assert (await client.get(f"{BASE}/public/posts", params={"limit": 51})).status_code == 422
        assert (await client.get(f"{BASE}/public/posts", params={"page": 0})).status_code == 422
        # A huge page would overflow the database's OFFSET (500): capped instead.
        assert (await client.get(f"{BASE}/public/posts", params={"page": 4611686018427387904})).status_code == 422
        assert (await client.get(f"{BASE}/public/posts", params={"page": 100001})).status_code == 422
        last = (await client.get(f"{BASE}/public/posts", params={"page": 100000})).json()
        assert last["items"] == [] and last["total"] == 5

    async def test_empty_and_unknown_org(self, client, org):
        assert (await client.get(f"{BASE}/public/posts")).json() == {"items": [], "total": 0, "page": 1, "limit": 12}
        missing = await client.get("/api/v1/blog/999/public/posts")
        assert missing.status_code == 404
        assert missing.json()["detail"] == "Organization not found"

    async def test_cover_url_is_absolute(self, client, db, org):
        row = await _add(db, "con-portada", cover_image="cover-abc.webp", og_image="og-abc.jpg", cover_alt="Una niña")
        card = (await client.get(f"{BASE}/public/posts")).json()["items"][0]
        assert card["cover_url"].startswith("http")
        assert card["cover_url"].endswith(f"/content/orgs/org_test/blog/{row.post_uuid}/cover-abc.webp")
        assert card["cover_alt"] == "Una niña"


class TestPublicDetail:
    async def test_detail_with_seo_fallbacks(self, client, db, org):
        await _add(
            db, "rabietas", title="Rabietas (borrar)", excerpt="Extracto de rabietas",
            summary="Resumen", key_takeaways=["Uno", "Dos"], faq=[{"question": "¿P?", "answer": "R."}],
            keywords=["rabietas"], content_html='<h2 id="a">A</h2>', word_count=1200,
            og_image="og-1.jpg", cover_image="cover-1.webp",
        )
        response = await client.get(f"{BASE}/public/posts/rabietas")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        post = response.json()
        assert set(post) == CARD_KEYS | {
            "summary", "key_takeaways", "content_html", "faq", "meta_title", "meta_description",
            "keywords", "word_count", "og_image_url",
        }
        assert post["meta_title"] == "Rabietas (borrar)"
        assert post["meta_description"] == "Extracto de rabietas"
        assert post["key_takeaways"] == ["Uno", "Dos"]
        assert post["faq"] == [{"question": "¿P?", "answer": "R."}]
        assert post["content_html"] == '<h2 id="a">A</h2>'
        assert post["reading_minutes"] == 6
        assert post["og_image_url"].endswith("/og-1.jpg")

    async def test_own_meta_fields_win(self, client, db, org):
        await _add(db, "con-meta", meta_title="Meta propio", meta_description="Descripción propia")
        post = (await client.get(f"{BASE}/public/posts/con-meta")).json()
        assert (post["meta_title"], post["meta_description"]) == ("Meta propio", "Descripción propia")

    async def test_not_found_cases(self, client, db, org, other_org):
        await _add(db, "borrador", status="draft")
        await _add(db, "ajeno", org_id=other_org.id)
        for slug in ("borrador", "no-existe", "ajeno", "Mayusculas", "con--doble", "ab", "x" * 81):
            response = await client.get(f"{BASE}/public/posts/{slug}")
            assert response.status_code == 404, slug
            assert response.json()["detail"] == "Artículo no encontrado."

    async def test_public_routes_ignore_the_session(self, client, current, db, org, admin_user):
        # Even a signed-in admin sees drafts as 404 here.
        current.set(admin_user)
        await _add(db, "borrador", status="draft")
        assert (await client.get(f"{BASE}/public/posts/borrador")).status_code == 404


class TestSitemap:
    async def test_sitemap_lists_published_only(self, client, db, org, other_org):
        await _add(db, "uno", days=1)
        await _add(db, "dos", days=3)
        await _add(db, "borrador", status="draft")
        await _add(db, "ajeno", org_id=other_org.id)
        response = await client.get(f"{BASE}/public/sitemap")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert response.json() == {"items": [
            {"slug": "dos", "published_at": "2026-10-04T14:00:00+00:00", "updated_at": "2026-10-04T15:00:00+00:00"},
            {"slug": "uno", "published_at": "2026-10-02T14:00:00+00:00", "updated_at": "2026-10-02T15:00:00+00:00"},
        ]}

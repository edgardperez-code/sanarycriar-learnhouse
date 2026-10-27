"""Sanar y Criar: public newsletter routes (pop-up config and anonymous sign-up)."""

import pytest
from sqlmodel import select

from src.db.newsletter.newsletter import NewsletterSubscriber
from src.services.newsletter.common import (
    EMAIL_RE,
    clean_line,
    clean_multiline,
    csv_safe,
    normalize_email,
    sanitize_page_path,
)
from src.services.newsletter.settings import DEFAULT_SETTINGS
from src.tests.newsletter.conftest import BASE, subscribe


async def _rows(db):
    return (await db.execute(select(NewsletterSubscriber))).scalars().all()


class TestPublicConfig:
    async def test_defaults_without_row(self, client, org):
        response = await client.get(f"{BASE}/public-config")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        data = response.json()
        assert data == DEFAULT_SETTINGS
        assert data["enabled"] is False

    async def test_unknown_org_is_404(self, client, org):
        response = await client.get("/api/v1/newsletter/999/public-config")
        assert response.status_code == 404
        assert response.json()["detail"] == "Organization not found"

    async def test_subscribe_unknown_org_is_404(self, client, org):
        response = await client.post(
            "/api/v1/newsletter/999/subscribe", json={"email": "ana@example.com"}
        )
        assert response.status_code == 404


class TestSubscribe:
    async def test_new_address_is_normalized_and_stored(self, client, db, org):
        response = await subscribe(client, " Ana@Example.COM ", source="footer", page="/cursos")
        assert response.status_code == 200
        assert response.json() == {"ok": True}
        rows = await _rows(db)
        assert len(rows) == 1
        row = rows[0]
        assert row.email == "ana@example.com"
        assert row.source == "footer"
        assert row.page_path == "/cursos"
        assert row.sync_status == "skipped"
        assert row.org_id == org.id
        assert row.resend_contact_id is None

    async def test_repeated_address_same_answer_single_row(self, client, db, org):
        first = await subscribe(client, "ana@example.com", source="popup", page="/")
        second = await subscribe(client, "ANA@example.com ", source="footer", page="/cursos")
        assert first.status_code == second.status_code == 200
        assert first.content == second.content
        rows = await _rows(db)
        assert len(rows) == 1
        # An existing row keeps where it first came from.
        assert rows[0].source == "popup" and rows[0].page_path == "/"

    @pytest.mark.parametrize("email", [
        "", "   ", "ana", "ana@", "@example.com", "ana@example", "ana..b@example.com",
        ".ana@example.com", "ana.@example.com", "ana@-x.com", "ana@example.c",
        "ana perez@example.com", "ñandu@example.com", "ana@example.com\nbcc@example.com",
        "a" * 65 + "@example.com",
    ])
    async def test_invalid_address_is_400(self, client, db, org, email):
        response = await subscribe(client, email)
        assert response.status_code == 400
        assert response.json()["detail"] == "Escribe un correo electrónico válido."
        assert await _rows(db) == []

    async def test_too_long_raw_value_is_400(self, client, db, org):
        response = await subscribe(client, " " * 310 + "ana@example.com")  # 325 characters
        assert response.status_code == 400
        assert await _rows(db) == []

    async def test_missing_email_is_400(self, client, db, org):
        response = await client.post(f"{BASE}/subscribe", json={"source": "popup"})
        assert response.status_code == 400

    async def test_wrong_types_are_422(self, client, org):
        response = await client.post(f"{BASE}/subscribe", json={"email": ["ana@example.com"]})
        assert response.status_code == 422

    async def test_honeypot_answers_ok_and_stores_nothing(self, client, db, org):
        response = await subscribe(client, "bot@example.com", website="http://spam.example.com")
        assert response.status_code == 200
        assert response.json() == {"ok": True}
        assert await _rows(db) == []

    async def test_honeypot_wins_over_invalid_address(self, client, db, org):
        response = await subscribe(client, "not-an-email", website="x")
        assert response.status_code == 200
        assert await _rows(db) == []

    async def test_unknown_source_is_other(self, client, db, org):
        await subscribe(client, "ana@example.com", source="xyz")
        assert (await _rows(db))[0].source == "other"

    async def test_page_query_is_dropped(self, client, db, org):
        await subscribe(client, "ana@example.com", page="/cursos?x=1#top")
        assert (await _rows(db))[0].page_path == "/cursos"

    @pytest.mark.parametrize("page", ["javascript:alert(1)", "cursos", "https://evil.example.com/x", "/a b", "/ñ", None, "/" + "a" * 200])
    async def test_bad_page_is_none(self, client, db, org, page):
        await subscribe(client, "ana@example.com", page=page)
        assert (await _rows(db))[0].page_path is None

    async def test_extra_fields_are_ignored(self, client, db, org):
        response = await subscribe(client, "ana@example.com", org_id=2, sync_status="synced")
        assert response.status_code == 200
        row = (await _rows(db))[0]
        assert row.org_id == 1 and row.sync_status == "skipped"

    async def test_no_enumeration_new_repeated_honeypot_same_body(self, client, org):
        new = await subscribe(client, "nueva@example.com")
        repeated = await subscribe(client, "nueva@example.com")
        honeypot = await subscribe(client, "otra@example.com", website="lleno")
        assert new.status_code == repeated.status_code == honeypot.status_code == 200
        assert new.content == repeated.content == honeypot.content

    async def test_works_while_popup_disabled(self, client, db, org):
        assert (await client.get(f"{BASE}/public-config")).json()["enabled"] is False
        response = await subscribe(client, "pie@example.com", source="footer")
        assert response.status_code == 200
        assert len(await _rows(db)) == 1


class TestHelpers:
    def test_normalize_email(self):
        assert normalize_email(" Ana.Perez+boletin@Gmail.com ") == "ana.perez+boletin@gmail.com"
        assert normalize_email("a_b@sub.dominio.com.ve") == "a_b@sub.dominio.com.ve"
        assert normalize_email("ana@xn--bcher-kva.example") == "ana@xn--bcher-kva.example"
        assert normalize_email("ana@example.com\n") == "ana@example.com"  # stripped first
        assert normalize_email("a" * 250 + "@x.co") is None  # longer than 254
        assert normalize_email(None) is None
        assert EMAIL_RE.fullmatch("=1+2@example.com")

    def test_clean_line(self):
        assert clean_line("  Hola\x00   mundo\n\t ") == "Hola mundo"
        assert clean_line("a\x7fb") == "ab"
        # Line breaks and tabs separate words: they become a space, not nothing.
        assert clean_line("Sin spam.\nPuedes darte de baja.") == "Sin spam. Puedes darte de baja."
        assert clean_line("Sin spam.\r\nPuedes") == "Sin spam. Puedes"
        assert clean_line("Hola\tmundo") == "Hola mundo"

    def test_clean_multiline(self):
        assert clean_multiline("  uno\r\ndos\r\r\r\rtres\x07 ") == "uno\ndos\n\ntres"
        assert clean_multiline("a\n\n\n\n\nb") == "a\n\nb"
        assert clean_multiline("Hola\tmundo\nadios") == "Hola mundo\nadios"

    def test_sanitize_page_path(self):
        assert sanitize_page_path("/blog/mi-post_1.html") == "/blog/mi-post_1.html"
        assert sanitize_page_path("/") == "/"
        assert sanitize_page_path("/x#y") == "/x"
        assert sanitize_page_path("/ñ") is None
        assert sanitize_page_path("") is None
        assert sanitize_page_path(123) is None

    def test_csv_safe(self):
        assert csv_safe("=1+2@example.com") == "'=1+2@example.com"
        for prefix in ("+", "-", "@", "\t", "\r"):
            assert csv_safe(prefix + "x") == "'" + prefix + "x"
        assert csv_safe("ana@example.com") == "ana@example.com"
        assert csv_safe(None) == ""

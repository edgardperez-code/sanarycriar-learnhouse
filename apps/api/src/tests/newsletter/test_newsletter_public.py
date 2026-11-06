"""Sanar y Criar: public newsletter routes (pop-up config and anonymous sign-up)."""

import pytest
from sqlmodel import select

from src.db.newsletter.newsletter import NewsletterSubscriber
from src.services.newsletter import resend_sync
from src.services.newsletter.common import (
    EMAIL_RE,
    clean_line,
    clean_multiline,
    csv_safe,
    normalize_email,
    sanitize_page_path,
)
from src.services.newsletter.settings import DEFAULT_SETTINGS
from src.services.newsletter.subscribers import SOURCES, _clean_name
from src.tests.newsletter.conftest import BASE, HIDDEN_LINK_NAMES, subscribe


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

    async def test_default_texts_are_the_welcome_window(self, client, org):
        data = (await client.get(f"{BASE}/public-config")).json()
        assert data["title"] == "Necesito acompañarte en tu *maternidad*."
        assert data["body"].startswith("Soy Hilda, psicóloga infanto-juvenil y mamá.")
        assert data["button_label"] == "Sí, quiero mi guía gratis"
        assert data["dismiss_label"] == "Ahora no, quiero ver la web"
        assert data["privacy_note"] == (
            "Después te seguiré escribiendo, como una amiga; te das de baja cuando quieras."
        )
        assert (data["delay_seconds"], data["dismiss_days"]) == (5, 7)

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

    @pytest.mark.parametrize("source", ["popup", "footer", "cartas", "test", "guia-gratis", "ventana-web"])
    async def test_known_sources_are_kept(self, client, db, org, source):
        await subscribe(client, "ana@example.com", source=source)
        assert (await _rows(db))[0].source == source

    @pytest.mark.parametrize("source", ["Test", "guia_gratis", "regalo", "ventana-web-2", ""])
    async def test_lookalike_sources_are_other(self, client, db, org, source):
        await subscribe(client, "ana@example.com", source=source)
        assert (await _rows(db))[0].source == "other"

    def test_every_source_fits_the_column(self):
        # The tests' SQLite does not enforce VARCHAR lengths; Postgres does.
        length = NewsletterSubscriber.__table__.c.source.type.length
        assert all(len(source) <= length for source in (*SOURCES, "other"))

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


async def _stored_names(db):
    """What the database holds (not the session's copy of the rows)."""
    return (await db.execute(select(NewsletterSubscriber.name))).scalars().all()


class TestName:
    async def test_name_is_cleaned_and_stored(self, client, db, org):
        response = await subscribe(client, "ana@example.com", name="  Ana\x00   María\nde\tlos Ángeles ")
        assert response.status_code == 200 and response.json() == {"ok": True}
        assert await _stored_names(db) == ["Ana María de los Ángeles"]

    async def test_name_is_cut_to_80_characters(self, client, db, org):
        await subscribe(client, "ana@example.com", name="ñ" * 100)
        await subscribe(client, "bea@example.com", name="é" * 79 + " " + "x" * 30)
        assert sorted(await _stored_names(db)) == sorted(["ñ" * 80, "é" * 79])

    @pytest.mark.parametrize("name", [None, "", "   ", "\n\t\x00"])
    async def test_blank_name_is_null(self, client, db, org, name):
        response = await subscribe(client, "ana@example.com", name=name)
        assert response.status_code == 200
        assert await _stored_names(db) == [None]

    @pytest.mark.parametrize("name", [["Ana"], 7, {"first": "Ana"}])
    async def test_wrong_name_type_is_422(self, client, db, org, name):
        response = await client.post(f"{BASE}/subscribe", json={"email": "ana@example.com", "name": name})
        assert response.status_code == 422
        assert await _rows(db) == []

    async def test_missing_name_is_filled_once_and_never_overwritten(self, client, db, org):
        origin = select(NewsletterSubscriber.source, NewsletterSubscriber.page_path, NewsletterSubscriber.creation_date)
        first = await subscribe(client, "ana@example.com", source="footer", page="/cursos")
        before = tuple((await db.execute(origin)).one())
        filled = await subscribe(client, "ANA@example.com", name="Ana", source="test", page="/regalo")
        again = await subscribe(client, "ana@example.com", name="Otra persona", source="popup", page="/")
        assert first.status_code == filled.status_code == again.status_code == 200
        assert first.content == filled.content == again.content
        assert await _stored_names(db) == ["Ana"]
        # Where and when it first came from does not change.
        assert tuple((await db.execute(origin)).one()) == before
        assert before[:2] == ("footer", "/cursos")

    async def test_name_given_first_is_kept(self, client, db, org):
        await subscribe(client, "ana@example.com", name="Ana")
        await subscribe(client, "ana@example.com")
        await subscribe(client, "ana@example.com", name="Otra")
        assert await _stored_names(db) == ["Ana"]

    async def test_honeypot_stores_no_name(self, client, db, org):
        response = await subscribe(client, "bot@example.com", name="Bot", website="x")
        assert response.json() == {"ok": True}
        assert await _rows(db) == []

    async def test_same_answer_with_or_without_a_name(self, client, org):
        new = await subscribe(client, "nueva@example.com", name="Nueva")
        named_again = await subscribe(client, "nueva@example.com", name="Otra")
        unnamed = await subscribe(client, "otra@example.com")
        honeypot = await subscribe(client, "bot@example.com", name="Bot", website="lleno")
        assert new.content == named_again.content == unnamed.content == honeypot.content

    async def test_name_never_reaches_the_logs(self, client, db, org, caplog):
        import logging

        with caplog.at_level(logging.DEBUG, logger="src"):
            await subscribe(client, "ana@example.com", name="Remedios")
            await subscribe(client, "ana@example.com", name="Remedios")
            await subscribe(client, "bea@example.com", name="Remedios entra a pago-sanarycriar\u3002lat")
        assert "Remedios" not in caplog.text
        assert "pago-sanarycriar" not in caplog.text

    async def test_lone_surrogate_is_dropped_and_never_a_500(self, client, db, org):
        # A JSON "\ud83d" without its pair reaches the model as is, and the
        # database cannot store it. The same 200 whether the address is new,
        # on the list without a name or on it with one: nothing tells them apart.
        await subscribe(client, "sin@example.com")
        await subscribe(client, "con@example.com", name="Ana")
        bodies = []
        for email in (b"nueva@example.com", b"sin@example.com", b"con@example.com"):
            raw = b'{"email": "%s", "name": "x\\ud83d", "website": "", "source": "popup", "page": "/"}' % email
            response = await client.post(f"{BASE}/subscribe", content=raw, headers={"Content-Type": "application/json"})
            await resend_sync.wait_for_background()
            assert response.status_code == 200, (email, response.text)
            bodies.append(response.content)
        assert bodies == [b'{"ok":true}'] * 3
        stored = (await db.execute(select(NewsletterSubscriber.email, NewsletterSubscriber.name))).all()
        assert dict(stored) == {"nueva@example.com": "x", "sin@example.com": "x", "con@example.com": "Ana"}

    @pytest.mark.parametrize("name", ["x.com/a", "www.x", "http://x", "pago-sanarycriar\u200b.com/x", *HIDDEN_LINK_NAMES])
    async def test_name_with_a_link_is_dropped(self, client, db, org, resend_on, name):
        # The same 200 as any sign-up; only the name is gone, from the row and from Resend.
        response = await subscribe(client, "ana@example.com", name=name)
        assert response.status_code == 200 and response.content == b'{"ok":true}'
        assert await _stored_names(db) == [None]
        assert resend_on.calls == [("create", "re_test", "ana@example.com", None, None)]

    @pytest.mark.parametrize("name", [
        "Dr. Strange", "J.R.R. Tolkien", "J.R.R.", "Ma. José", "María José", "O'Neil", "Ana-Lucía",
        "Mª José", "🌷 Ana",
        "Ana \U0001f469\u200d\U0001f467",   # woman, zero-width joiner, girl: one emoji
        "Ana \u2764\ufe0f",                 # red heart: heart and variation selector 16
    ])
    async def test_ordinary_names_reach_resend_as_typed(self, client, db, org, resend_on, name):
        response = await subscribe(client, "ana@example.com", name=name)
        assert response.status_code == 200 and response.content == b'{"ok":true}'
        assert await _stored_names(db) == [name]
        assert resend_on.calls == [("create", "re_test", "ana@example.com", None, name)]


class TestCleanName:
    @pytest.mark.parametrize("raw,clean", [
        ("Ana\ud83d", "Ana"),                        # lone surrogate
        ("\udc00", None),
        ("Ana \u200b María", "Ana María"),           # zero-width space, then single spaces
        ("\u202eAna\u202c", "Ana"),                  # direction override
        ("\ufeffAna\u2060", "Ana"),                  # BOM, word joiner
        ("Ma\u00adría\u200d", "María"),              # soft hyphen, zero-width joiner
        ("Jose\u0301 🌷", "Jose\u0301 🌷"),           # accents and emoji are letters, not format
        ("A\u034fna\ufe0f", "Ana"),                  # combining grapheme joiner, VS16 after a letter
        ("Ana\u180b\u180d\U000e0100", "Ana"),        # Mongolian free variation selectors, VS17
        ("Ana\u2065\U000e0002", "Ana"),              # unassigned, but renderers must hide them
        ("Ana\u3164 María", "Ana María"),            # Hangul filler
        ("An\x81a\x9f", "Ana"),                      # C1 controls
    ])
    def test_invisible_characters_are_dropped(self, raw, clean):
        assert _clean_name(raw) == clean

    @pytest.mark.parametrize("raw,clean", [
        ("Ana\u00a0María", "Ana María"),             # no-break space
        ("Dr.\u2009Strange", "Dr. Strange"),         # thin space
        ("Ana\u3000\u2028María", "Ana María"),       # ideographic space, line separator
        ("Ana\x85María", "Ana María"),               # next line
        # A hair space cannot pass for no space at all: it shows as a full one,
        # the shape of "Dr. Strange", which is no link.
        ("pago-sanarycriar.\u200alat", "pago-sanarycriar. lat"),
    ])
    def test_every_space_becomes_a_plain_one(self, raw, clean):
        assert _clean_name(raw) == clean

    def test_a_huge_name_is_cut(self):
        assert _clean_name("ñ" * 1_000_000) == "ñ" * 80
        assert _clean_name(" " * 100 + "Ana") == "Ana"
        # Only the first 320 characters are looked at, invisible ones included,
        assert _clean_name("\u200b" * 320 + "Ana") is None
        # so a link that starts inside them is still seen whole,
        assert _clean_name("\u200b" * 300 + "pago-sanarycriar.lat") is None
        # and the widest compatibility form (18 characters each) is checked on 80 of them only.
        assert _clean_name("\ufdfa" * 1_000_000) == "\ufdfa" * 80

    @pytest.mark.parametrize("raw", [
        "x.com/a", "www.x", "http://x", "pago-sanarycriar\u200b.com/x",
        "Ana, tu pago falló: entra a pago-sanarycriar.com/x", "Ana evil\u2060.com",
        *HIDDEN_LINK_NAMES,
        # Other characters renderers hide: unassigned default-ignorables, a
        # Hangul filler, a C1 control.
        "pago-sanarycriar.\u2065lat", "pago-sanarycriar.\U000e0002lat", "pago-sanarycriar.\u3164lat",
        "pago-sanarycriar.\x81lat",
        # Dots in disguise: one dot leader, the Lisu tone letter drawn as a dot,
        # an Arabic-Indic zero; fullwidth letters; a combining enclosing circle.
        "pago-sanarycriar\u2024lat", "pago-sanarycriar\ua4f8lat", "pago-sanarycriar\u0660lat",
        "pago-sanarycriar.\uff4c\uff41\uff54", "pago-sanarycriar.l\u20ddat",
        # A dot with two letters after it, whatever comes before.
        "pago-sanarycriar .lat", "pago-sanarycriar..lat",
        # What no first name needs: a path, a scheme, an address, HTML, also fullwidth.
        "Ana/Luis", "Ana\\Luis", "ana@correo", "@ana", "Ana: hola", "<b>Ana</b>", "Ana>",
        "Ana\uff0fLuis", "ana\uff20correo", "\uff1cb\uff1eAna", "Ana \u226e",
        # HTML character references: "&#46" is a dot once the mail is read as HTML.
        "pago-sanarycriar&#46;lat", "pago-sanarycriar&#46lat",
        # IP addresses.
        "203.0.113.5", "Ana 127.1",
    ])
    def test_links_are_dropped(self, raw):
        assert _clean_name(raw) is None

    @pytest.mark.parametrize("raw", [
        "Dr. Strange", "J.R.R. Tolkien", "J.R.R.", "María José", "Mamá de Leo", "Ma. José", "St. John",
        "A.J. Smith", "O'Neil", "O\u2019Neil", "Ana-Lucía", "Mª José", "Gal·la", "Ana & Luis",
        "Ana (mamá de Leo)", "Ana 2", "Мария", "李小龙", "Nguyễn", "🌷", "🇻🇪 Ana",
    ])
    def test_ordinary_names_are_kept(self, raw):
        assert _clean_name(raw) == raw

    @pytest.mark.parametrize("raw", ["Ma.De Los Ángeles", "Dr.Strange", "J.R.R.Tolkien", "Ana...María"])
    def test_no_space_after_a_dot_drops_the_name(self, raw):
        # On purpose: "pago-sanarycriar.lat" has the same shape, a first name
        # never needs it, and the sign-up still succeeds without the name.
        assert _clean_name(raw) is None

    @pytest.mark.parametrize("raw", [
        "Ana \U0001f469\u200d\U0001f467",                                 # woman, ZWJ, girl
        "\U0001f468\u200d\U0001f469\u200d\U0001f467\u200d\U0001f466 Familia",
        "\U0001f3f3\ufe0f\u200d\U0001f308 Ana",                           # rainbow flag: VS16 and ZWJ
        "\U0001f9d4\U0001f3fb\u200d\u2642\ufe0f",                         # skin tone, ZWJ, VS16
        "\U0001f642\u200d\u2194\ufe0f",                                   # head shaking: ZWJ before an arrow
        "Ana \u2764\ufe0f",                                               # red heart
        "Ana \U0001f44b\U0001f3fd",                                       # waving hand, skin tone
    ])
    def test_emoji_sequences_are_kept(self, raw):
        assert _clean_name(raw) == raw

    def test_emoji_glue_elsewhere_is_dropped(self):
        assert _clean_name("An\u200da\ufe0f") == "Ana"
        assert _clean_name("\u200d\ufe0f") is None
        # The cut does not keep the joiner of an emoji whose second half fell off.
        assert _clean_name("x" * 79 + "\U0001f469\u200d\U0001f467") == "x" * 79 + "\U0001f469"
        # Tags are never kept: England's flag shows as the black flag it starts with.
        assert _clean_name("\U0001f3f4\U000e0067\U000e0062\U000e0065\U000e006e\U000e0067\U000e007f") == "\U0001f3f4"


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

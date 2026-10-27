"""Sanar y Criar: newsletter admin routes (settings, subscriber list, CSV, delete)."""

import csv
import io
from datetime import datetime, timedelta, timezone

import pytest
from sqlmodel import select

from src.db.newsletter.newsletter import NewsletterSubscriber
from src.db.users import APITokenUser
from src.services.newsletter.settings import DEFAULT_SETTINGS
from src.tests.newsletter.conftest import BASE, subscribe

T0 = datetime(2026, 10, 26, 14, 0, tzinfo=timezone.utc)


def _settings(**overrides):
    body = dict(DEFAULT_SETTINGS)
    body.update(overrides)
    return body


async def _add(db, email, *, org_id=1, minutes=0, source="popup", page_path=None, sync_status="skipped"):
    row = NewsletterSubscriber(
        org_id=org_id, email=email, source=source, page_path=page_path, sync_status=sync_status,
        creation_date=T0 + timedelta(minutes=minutes), update_date=T0 + timedelta(minutes=minutes),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


ADMIN_ROUTES = [
    ("get", f"{BASE}/settings", None),
    ("put", f"{BASE}/settings", _settings()),
    ("get", f"{BASE}/subscribers", None),
    ("get", f"{BASE}/subscribers/export.csv", None),
    ("post", f"{BASE}/subscribers/sync", None),
    ("delete", f"{BASE}/subscribers/1", None),
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

    async def test_api_token_is_403(self, client, current, org):
        current.set(APITokenUser(
            id=1, user_uuid="apitoken_x", username="token", org_id=org.id, rights={}, token_name="t",
            created_by_user_id=1,
        ))
        response = await client.get(f"{BASE}/settings")
        assert response.status_code == 403
        assert response.json()["detail"] == "API tokens cannot manage the newsletter"

    async def test_admin_of_unknown_org_is_404(self, client, current, admin_user):
        current.set(admin_user)
        assert (await client.get("/api/v1/newsletter/999/settings")).status_code == 404


class TestSettings:
    async def test_admin_reads_defaults(self, client, current, admin_user):
        current.set(admin_user)
        response = await client.get(f"{BASE}/settings")
        assert response.status_code == 200
        data = response.json()
        assert {k: data[k] for k in DEFAULT_SETTINGS} == DEFAULT_SETTINGS
        assert data["defaults"] == DEFAULT_SETTINGS
        assert data["updated_at"] is None
        assert data["resend_enabled"] is False

    async def test_put_updates_public_config(self, client, current, admin_user):
        current.set(admin_user)
        body = _settings(
            enabled=True, title="  Hola   familia ", body="Línea uno\r\n\r\n\r\nLínea dos",
            button_label="Suscribirme", dismiss_label="Luego", success_message="¡Gracias!",
            privacy_note="", delay_seconds=5, dismiss_days=7,
        )
        response = await client.put(f"{BASE}/settings", json=body)
        assert response.status_code == 200, response.text
        saved = response.json()
        assert saved["title"] == "Hola familia"
        assert saved["body"] == "Línea uno\n\nLínea dos"
        assert saved["updated_at"] is not None
        assert saved["defaults"] == DEFAULT_SETTINGS

        current.set(None)
        public = (await client.get(f"{BASE}/public-config")).json()
        assert public == {
            "enabled": True, "title": "Hola familia", "body": "Línea uno\n\nLínea dos",
            "button_label": "Suscribirme", "dismiss_label": "Luego", "success_message": "¡Gracias!",
            "privacy_note": "", "delay_seconds": 5, "dismiss_days": 7,
        }

        # A second save updates the same row (upsert by org).
        current.set(admin_user)
        again = await client.put(f"{BASE}/settings", json=_settings(title="Otro título"))
        assert again.status_code == 200
        assert (await client.get(f"{BASE}/settings")).json()["title"] == "Otro título"

    @pytest.mark.parametrize("overrides,detail", [
        ({"title": "   "}, "El título es obligatorio."),
        ({"title": "x" * 121}, "El título admite como máximo 120 caracteres."),
        ({"body": "x" * 501}, "El texto admite como máximo 500 caracteres."),
        ({"body": "\n\n"}, "El texto es obligatorio."),
        ({"button_label": "x" * 41}, "El texto del botón admite como máximo 40 caracteres."),
        ({"dismiss_label": ""}, "El texto para cerrar es obligatorio."),
        ({"success_message": "x" * 301}, "El mensaje de agradecimiento admite como máximo 300 caracteres."),
        ({"privacy_note": "x" * 301}, "La nota de privacidad admite como máximo 300 caracteres."),
        ({"delay_seconds": 121}, "El retraso debe ser un número entero entre 0 y 120."),
        ({"delay_seconds": -1}, "El retraso debe ser un número entero entre 0 y 120."),
        ({"dismiss_days": 0}, "Los días sin mostrarla deben ser un número entero entre 1 y 365."),
        ({"dismiss_days": 366}, "Los días sin mostrarla deben ser un número entero entre 1 y 365."),
    ])
    async def test_invalid_values_are_400(self, client, current, admin_user, overrides, detail):
        current.set(admin_user)
        response = await client.put(f"{BASE}/settings", json=_settings(**overrides))
        assert response.status_code == 400
        assert response.json()["detail"] == detail
        assert (await client.get(f"{BASE}/settings")).json()["updated_at"] is None

    async def test_limits_count_after_cleaning(self, client, current, admin_user):
        current.set(admin_user)
        response = await client.put(f"{BASE}/settings", json=_settings(title="  " + "x" * 120 + "  "))
        assert response.status_code == 200

    async def test_wrong_types_are_422(self, client, current, admin_user):
        current.set(admin_user)
        assert (await client.put(f"{BASE}/settings", json=_settings(delay_seconds=1.5))).status_code == 422
        missing = _settings()
        del missing["title"]
        assert (await client.put(f"{BASE}/settings", json=missing)).status_code == 422


class TestSubscribers:
    async def test_list_paginates_searches_and_summarizes(self, client, current, db, admin_user):
        await _add(db, "ana@example.com", minutes=0, sync_status="synced")
        await _add(db, "bea@example.com", minutes=1)
        await _add(db, "carla_x@example.com", minutes=2, source="footer", page_path="/cursos")
        current.set(admin_user)

        first = (await client.get(f"{BASE}/subscribers", params={"limit": 1})).json()
        assert first["total"] == 3 and first["page"] == 1 and first["limit"] == 1
        assert [i["email"] for i in first["items"]] == ["carla_x@example.com"]
        assert first["items"][0] == {
            "id": first["items"][0]["id"], "email": "carla_x@example.com", "source": "footer",
            "page_path": "/cursos", "sync_status": "skipped", "sync_error": None,
            "created_at": (T0 + timedelta(minutes=2)).isoformat(), "synced_at": None,
        }
        assert first["summary"] == {"all": 3, "unsynced": 2}

        second = (await client.get(f"{BASE}/subscribers", params={"limit": 1, "page": 2})).json()
        assert [i["email"] for i in second["items"]] == ["bea@example.com"]

        found = (await client.get(f"{BASE}/subscribers", params={"q": "  BEA "})).json()
        assert [i["email"] for i in found["items"]] == ["bea@example.com"]
        assert found["total"] == 1 and found["summary"]["all"] == 3

        # LIKE wildcards are matched literally.
        underscore = (await client.get(f"{BASE}/subscribers", params={"q": "a_x"})).json()
        assert [i["email"] for i in underscore["items"]] == ["carla_x@example.com"]
        percent = (await client.get(f"{BASE}/subscribers", params={"q": "%"})).json()
        assert percent["total"] == 0

    async def test_bad_paging_is_422(self, client, current, admin_user):
        current.set(admin_user)
        assert (await client.get(f"{BASE}/subscribers", params={"page": 0})).status_code == 422
        assert (await client.get(f"{BASE}/subscribers", params={"limit": 101})).status_code == 422

    async def test_org_isolation(self, client, current, db, admin_user, other_org):
        mine = await _add(db, "mia@example.com")
        theirs = await _add(db, "ajena@example.com", org_id=other_org.id)
        current.set(admin_user)

        listing = (await client.get(f"{BASE}/subscribers")).json()
        assert [i["email"] for i in listing["items"]] == ["mia@example.com"]
        assert listing["summary"]["all"] == 1

        response = await client.delete(f"{BASE}/subscribers/{theirs.id}")
        assert response.status_code == 404
        assert response.json()["detail"] == "Suscriptor no encontrado."
        assert await db.get(NewsletterSubscriber, theirs.id) is not None

        exported = (await client.get(f"{BASE}/subscribers/export.csv")).text
        assert "ajena@example.com" not in exported and "mia@example.com" in exported
        assert mine.id

        # The other org's admin endpoints are closed to this admin.
        assert (await client.get(f"/api/v1/newsletter/{other_org.id}/subscribers")).status_code == 403

    async def test_delete(self, client, current, db, admin_user):
        row = await _add(db, "borrar@example.com")
        current.set(admin_user)
        response = await client.delete(f"{BASE}/subscribers/{row.id}")
        assert response.status_code == 200
        assert response.json() == {"deleted": True, "resend_removed": None}
        assert (await db.execute(select(NewsletterSubscriber))).scalars().all() == []
        assert (await client.delete(f"{BASE}/subscribers/{row.id}")).status_code == 404

    async def test_sync_without_resend(self, client, current, db, admin_user):
        await _add(db, "uno@example.com")
        await _add(db, "dos@example.com", sync_status="synced")
        current.set(admin_user)
        response = await client.post(f"{BASE}/subscribers/sync")
        assert response.status_code == 200
        assert response.json() == {"resend_enabled": False, "synced": 0, "failed": 0, "remaining": 1}

    async def test_csv_export(self, client, current, db, admin_user):
        await _add(db, "ana@example.com", minutes=0, source="popup", page_path="/", sync_status="synced")
        await _add(db, "=1+2@example.com", minutes=5, source="footer", sync_status="pending")
        await _add(db, "-x@example.com", minutes=10, source="other", sync_status="error")
        current.set(admin_user)

        response = await client.get(f"{BASE}/subscribers/export.csv", params={"q": "ana"})
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/csv")
        assert "charset=utf-8" in response.headers["content-type"]
        disposition = response.headers["content-disposition"]
        assert disposition.startswith('attachment; filename="suscriptores-boletin-')
        assert disposition.endswith('.csv"')
        assert response.headers["cache-control"] == "no-store"

        raw = response.content
        assert not raw.startswith(b"\xef\xbb\xbf")
        assert raw.split(b"\r\n")[0] == b"email,fecha_alta,origen,pagina,estado_resend"
        rows = list(csv.reader(io.StringIO(response.text)))
        assert rows[1:] == [
            ["ana@example.com", "2026-10-26 10:00", "ventana", "/", "sincronizado"],
            ["'=1+2@example.com", "2026-10-26 10:05", "pie", "", "pendiente"],
            ["'-x@example.com", "2026-10-26 10:10", "otro", "", "error"],
        ]

    async def test_csv_skipped_status_label(self, client, current, admin_user):
        await subscribe(client, "local@example.com")
        current.set(admin_user)
        text = (await client.get(f"{BASE}/subscribers/export.csv")).text
        assert text.splitlines()[1].endswith(",ventana,/,sin_resend")


class TestAccessLogRedaction:
    """The subscriber search (part of an address) never reaches the access log."""

    def _record(self, path):
        import logging

        return logging.LogRecord(
            "uvicorn.access", logging.INFO, __file__, 1,
            '%s - "%s %s HTTP/%s" %d', ("172.18.0.1:5000", "GET", path, "1.1", 200), None,
        )

    def test_filter_is_installed_on_uvicorn_access(self):
        import logging

        import src.routers.newsletter  # noqa: F401  (installs the filter on import)
        from src.services.newsletter.common import NewsletterSearchRedactionFilter

        access_logger = logging.getLogger("uvicorn.access")
        assert sum(isinstance(f, NewsletterSearchRedactionFilter) for f in access_logger.filters) == 1

    def test_search_is_masked(self):
        from src.services.newsletter.common import NewsletterSearchRedactionFilter

        record = self._record("/api/v1/newsletter/1/subscribers?page=2&limit=25&q=maria.perez%40gmail.com")
        assert NewsletterSearchRedactionFilter().filter(record) is True
        message = record.getMessage()
        assert "maria" not in message and "gmail" not in message
        assert "/api/v1/newsletter/1/subscribers?page=2&limit=25&q=[redacted]" in message

        first = self._record("/api/v1/newsletter/1/subscribers?q=ana&page=1")
        NewsletterSearchRedactionFilter().filter(first)
        assert "?q=[redacted]&page=1" in first.getMessage()

    def test_other_paths_are_untouched(self):
        from src.services.newsletter.common import NewsletterSearchRedactionFilter

        path = "/api/v1/search?q=ana"
        record = self._record(path)
        NewsletterSearchRedactionFilter().filter(record)
        assert path in record.getMessage()

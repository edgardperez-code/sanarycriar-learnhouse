"""Sanar y Criar: copying newsletter subscribers to Resend contacts (SDK faked)."""

import logging
from types import SimpleNamespace
from unittest.mock import patch

from sqlmodel import select

from src.db.newsletter.newsletter import NewsletterSubscriber
from src.services.newsletter import resend_sync
from src.services.newsletter.resend_sync import ResendSettings
from src.tests.newsletter.conftest import BASE, subscribe


async def _row(db, email):
    return (await db.execute(
        select(NewsletterSubscriber).where(NewsletterSubscriber.email == email)
    )).scalars().one()


class TestSubscribeSync:
    async def test_create_works(self, client, db, org, resend_on):
        response = await subscribe(client, "Ana@Example.com")
        assert response.status_code == 200 and response.json() == {"ok": True}
        row = await _row(db, "ana@example.com")
        assert row.sync_status == "synced"
        assert row.resend_contact_id == "contact-1"
        assert row.sync_error is None and row.synced_at is not None
        assert resend_on.calls == [("create", "re_test", "ana@example.com", None)]

    async def test_synced_row_is_not_sent_again(self, client, db, org, resend_on):
        await subscribe(client, "ana@example.com")
        await subscribe(client, "ana@example.com")
        assert resend_on.names() == ["create"]

    async def test_create_fails_and_get_finds_it(self, client, db, org, resend_on):
        resend_on.create_error = RuntimeError("contact already exists")
        resend_on.get_result = "existing-42"
        response = await subscribe(client, "ana@example.com")
        assert response.status_code == 200
        row = await _row(db, "ana@example.com")
        assert row.sync_status == "synced" and row.resend_contact_id == "existing-42"
        assert row.sync_error is None
        # An existing contact is never modified (no segment configured here).
        assert resend_on.names() == ["create", "get"]

    async def test_both_fail_marks_error_but_answers_ok(self, client, db, org, resend_on):
        resend_on.create_error = RuntimeError("Resend is down")
        resend_on.get_error = TimeoutError()
        response = await subscribe(client, "ana@example.com")
        assert response.status_code == 200 and response.json() == {"ok": True}
        row = await _row(db, "ana@example.com")
        assert row.sync_status == "error"
        assert row.sync_error == "RuntimeError: Resend is down"
        assert row.resend_contact_id is None

    async def test_not_found_after_failed_create_is_error(self, client, db, org, resend_on):
        resend_on.create_error = ValueError("invalid")
        resend_on.get_result = None
        await subscribe(client, "ana@example.com")
        row = await _row(db, "ana@example.com")
        assert row.sync_status == "error" and row.sync_error.startswith("ValueError")

    async def test_segment_is_passed_to_create(self, client, db, org, resend_on):
        resend_on.settings = ResendSettings(api_key="re_test", segment_id="seg_1")
        await subscribe(client, "ana@example.com")
        assert resend_on.calls == [("create", "re_test", "ana@example.com", "seg_1")]

    async def test_existing_contact_is_added_to_segment(self, client, db, org, resend_on):
        resend_on.settings = ResendSettings(api_key="re_test", segment_id="seg_1")
        resend_on.create_error = RuntimeError("exists")
        resend_on.get_result = "existing-1"
        resend_on.segment_error = RuntimeError("segment failed")
        await subscribe(client, "ana@example.com")
        assert resend_on.names() == ["create", "get", "segment"]
        # A segment failure only logs: the contact exists, the row is synced.
        assert (await _row(db, "ana@example.com")).sync_status == "synced"

    async def test_logs_never_carry_the_address_or_key(self, client, db, org, resend_on, caplog):
        resend_on.create_error = RuntimeError("boom")
        with caplog.at_level(logging.DEBUG, logger="src.services.newsletter.resend_sync"):
            await subscribe(client, "secreta@example.com")
        assert caplog.records
        assert "secreta@example.com" not in caplog.text and "re_test" not in caplog.text

    async def test_slow_resend_times_out(self, client, db, org, resend_on, monkeypatch):
        import time

        monkeypatch.setattr(resend_sync, "RESEND_TIMEOUT_SECONDS", 0.05)
        monkeypatch.setattr(resend_sync, "_create_contact", lambda *a: time.sleep(0.3) or "late")
        resend_on.get_result = "found-anyway"
        response = await subscribe(client, "lenta@example.com")
        assert response.status_code == 200
        row = await _row(db, "lenta@example.com")
        assert row.sync_status == "error" and row.sync_error.startswith("TimeoutError")
        # After a timeout the lookup is not tried: a slow Resend would make it
        # wait as long again. The dashboard's sync retries the row later.
        assert resend_on.names() == []

    async def test_answer_does_not_wait_for_resend(self, client, db, org, resend_on, monkeypatch):
        """The sign-up answers before Resend does; the copy finishes afterwards."""
        import asyncio
        import threading

        release = threading.Event()

        def blocked_create(api_key, email, segment_id):
            release.wait(5)
            return "late-contact"

        monkeypatch.setattr(resend_sync, "_create_contact", blocked_create)
        payload = {"email": "rapida@example.com", "website": "", "source": "popup", "page": "/"}
        response = await asyncio.wait_for(client.post(f"{BASE}/subscribe", json=payload), 2)
        assert response.status_code == 200 and response.json() == {"ok": True}
        assert (await _row(db, "rapida@example.com")).sync_status == "pending"

        release.set()
        await resend_sync.wait_for_background()
        row = await _row(db, "rapida@example.com")
        assert row.sync_status == "synced" and row.resend_contact_id == "late-contact"

    async def test_background_sync_skips_a_row_deleted_meanwhile(self, db, org, resend_on):
        await resend_sync._sync_in_background(987654, resend_on.settings)
        assert resend_on.calls == []

    async def test_honeypot_never_calls_resend(self, client, db, org, resend_on):
        await subscribe(client, "bot@example.com", website="x")
        assert resend_on.calls == []


class TestAdminSync:
    async def test_admin_settings_report_resend(self, client, current, admin_user, resend_on):
        current.set(admin_user)
        assert (await client.get(f"{BASE}/settings")).json()["resend_enabled"] is True

    async def test_sync_retries_error_and_skipped(self, client, current, db, org, admin_user, resend_on):
        db.add(NewsletterSubscriber(org_id=1, email="saltada@example.com", sync_status="skipped"))
        db.add(NewsletterSubscriber(org_id=1, email="fallida@example.com", sync_status="error", sync_error="x"))
        db.add(NewsletterSubscriber(org_id=1, email="lista@example.com", sync_status="synced",
                                    resend_contact_id="c-0"))
        await db.commit()
        current.set(admin_user)

        response = await client.post(f"{BASE}/subscribers/sync")
        assert response.status_code == 200
        assert response.json() == {"resend_enabled": True, "synced": 2, "failed": 0, "remaining": 0}
        assert sorted(call[2] for call in resend_on.calls) == ["fallida@example.com", "saltada@example.com"]
        assert (await _row(db, "fallida@example.com")).sync_error is None

    async def test_sync_reports_failures(self, client, current, db, org, admin_user, resend_on):
        db.add(NewsletterSubscriber(org_id=1, email="uno@example.com", sync_status="pending"))
        await db.commit()
        resend_on.create_error = RuntimeError("down")
        current.set(admin_user)
        response = await client.post(f"{BASE}/subscribers/sync")
        assert response.json() == {"resend_enabled": True, "synced": 0, "failed": 1, "remaining": 1}

    async def test_sync_only_touches_own_org(self, client, current, db, org, other_org, admin_user, resend_on):
        db.add(NewsletterSubscriber(org_id=other_org.id, email="ajena@example.com", sync_status="skipped"))
        await db.commit()
        current.set(admin_user)
        response = await client.post(f"{BASE}/subscribers/sync")
        assert response.json() == {"resend_enabled": True, "synced": 0, "failed": 0, "remaining": 0}
        assert resend_on.calls == []

    async def test_delete_removes_the_contact(self, client, current, db, org, admin_user, resend_on):
        await subscribe(client, "ana@example.com")
        row = await _row(db, "ana@example.com")
        current.set(admin_user)
        response = await client.delete(f"{BASE}/subscribers/{row.id}")
        assert response.status_code == 200
        assert response.json() == {"deleted": True, "resend_removed": True}
        assert resend_on.calls[-1] == ("remove", "re_test", "contact-1")

    async def test_delete_when_resend_removal_fails(self, client, current, db, org, admin_user, resend_on):
        await subscribe(client, "ana@example.com")
        row = await _row(db, "ana@example.com")
        resend_on.remove_error = RuntimeError("down")
        current.set(admin_user)
        response = await client.delete(f"{BASE}/subscribers/{row.id}")
        assert response.status_code == 200
        assert response.json() == {"deleted": True, "resend_removed": False}
        assert (await db.execute(select(NewsletterSubscriber))).scalars().all() == []

    async def test_delete_unsynced_row_without_contact(self, client, current, db, org, admin_user, resend_on):
        db.add(NewsletterSubscriber(org_id=1, email="nunca@example.com", sync_status="error"))
        await db.commit()
        row = await _row(db, "nunca@example.com")
        resend_on.get_result = None
        current.set(admin_user)
        response = await client.delete(f"{BASE}/subscribers/{row.id}")
        assert response.json() == {"deleted": True, "resend_removed": None}
        # No contact id, so Resend is asked by address (a timed-out create may
        # still have made the contact); it has none.
        assert resend_on.calls == [("get", "re_test", "nunca@example.com")]

    async def test_delete_unsynced_row_whose_contact_exists(self, client, current, db, org, admin_user, resend_on):
        db.add(NewsletterSubscriber(org_id=1, email="tardia@example.com", sync_status="error"))
        await db.commit()
        row = await _row(db, "tardia@example.com")
        resend_on.get_result = "made-late"
        current.set(admin_user)
        response = await client.delete(f"{BASE}/subscribers/{row.id}")
        assert response.json() == {"deleted": True, "resend_removed": True}
        assert resend_on.names() == ["get", "remove"]
        assert resend_on.calls[-1] == ("remove", "re_test", "made-late")

    async def test_delete_when_the_lookup_fails(self, client, current, db, org, admin_user, resend_on):
        db.add(NewsletterSubscriber(org_id=1, email="duda@example.com", sync_status="pending"))
        await db.commit()
        row = await _row(db, "duda@example.com")
        resend_on.get_error = RuntimeError("down")
        current.set(admin_user)
        response = await client.delete(f"{BASE}/subscribers/{row.id}")
        assert response.status_code == 200
        assert response.json() == {"deleted": True, "resend_removed": False}
        assert (await db.execute(select(NewsletterSubscriber))).scalars().all() == []

    async def test_delete_synced_row_once_resend_is_off(self, client, current, db, org, admin_user):
        db.add(NewsletterSubscriber(org_id=1, email="vieja@example.com", sync_status="synced",
                                    resend_contact_id="c-old"))
        await db.commit()
        row = await _row(db, "vieja@example.com")
        current.set(admin_user)
        response = await client.delete(f"{BASE}/subscribers/{row.id}")
        # The contact is still in Resend and cannot be removed from here.
        assert response.json() == {"deleted": True, "resend_removed": False}

    async def test_sync_stops_at_the_time_budget(self, client, current, db, org, admin_user, resend_on, monkeypatch):
        from src.services.newsletter import subscribers as subscribers_service

        db.add(NewsletterSubscriber(org_id=1, email="uno@example.com", sync_status="pending"))
        db.add(NewsletterSubscriber(org_id=1, email="dos@example.com", sync_status="error"))
        await db.commit()
        monkeypatch.setattr(subscribers_service, "SYNC_TIME_BUDGET_SECONDS", 0.0)
        current.set(admin_user)
        response = await client.post(f"{BASE}/subscribers/sync")
        assert response.json() == {"resend_enabled": True, "synced": 0, "failed": 0, "remaining": 2}
        assert resend_on.calls == []


class TestResendSettings:
    def _config(self, provider, key):
        return SimpleNamespace(mailing_config=SimpleNamespace(email_provider=provider, resend_api_key=key))

    def test_smtp_or_missing_key_is_none(self, monkeypatch):
        monkeypatch.undo()  # drop the autouse resend_off patch: test the real function
        target = "src.services.newsletter.resend_sync.get_learnhouse_config"
        with patch(target, return_value=self._config("smtp", "re_x")):
            assert resend_sync.resend_settings() is None
        with patch(target, return_value=self._config("resend", "  ")):
            assert resend_sync.resend_settings() is None

    def test_resend_with_key(self, monkeypatch):
        monkeypatch.undo()
        monkeypatch.setenv("LEARNHOUSE_NEWSLETTER_RESEND_SEGMENT_ID", " seg_9 ")
        target = "src.services.newsletter.resend_sync.get_learnhouse_config"
        with patch(target, return_value=self._config("resend", "re_live")):
            settings = resend_sync.resend_settings()
        assert settings == ResendSettings(api_key="re_live", segment_id="seg_9")
        assert "re_live" not in repr(settings)

    def test_sdk_wrappers(self, monkeypatch):
        """The wrappers speak the SDK 2.x contact API (global contacts, no audience)."""
        import resend

        calls = []

        class Contacts:
            class Segments:
                @staticmethod
                def add(params):
                    calls.append(("segments.add", params))

            @staticmethod
            def create(params):
                calls.append(("create", params))
                return {"object": "contact", "id": "c-1"}

            @staticmethod
            def get(email=None, **kwargs):
                calls.append(("get", email))
                raise resend.exceptions.ResendError(
                    code=404, error_type="not_found", message="Contact not found", suggested_action="",
                )

            @staticmethod
            def remove(id=None, **kwargs):
                calls.append(("remove", id))
                return {"deleted": True}

        monkeypatch.setattr(resend, "Contacts", Contacts)
        monkeypatch.setattr(resend, "api_key", None)
        assert resend_sync._create_contact("re_k", "ana@example.com", "seg") == "c-1"
        assert resend.api_key == "re_k"
        assert resend_sync._get_contact_id("re_k", "ana@example.com") is None
        resend_sync._add_to_segment("re_k", "ana@example.com", "seg")
        resend_sync._remove_contact("re_k", "c-1")
        assert calls == [
            # No "unsubscribed" field: an upsert must never undo an opt-out.
            ("create", {"email": "ana@example.com", "segments": [{"id": "seg"}]}),
            ("get", "ana@example.com"),
            ("segments.add", {"segment_id": "seg", "email": "ana@example.com"}),
            ("remove", "c-1"),
        ]

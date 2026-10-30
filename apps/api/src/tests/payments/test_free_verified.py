"""Sanar y Criar: free courses need a signed-in account with a verified email.

Covers the access rule (``get_course_access`` on a course with no live
offer), the reader gate and ``/content`` files, "start course", the access
endpoint, signup (verification mail in OSS mode) and the cache bump after
``verify-email``.
"""

import json
from datetime import datetime
from unittest.mock import AsyncMock, Mock, patch

import pytest
from fastapi import FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient
from sqlmodel import select

from src.core.events.database import get_db_session
from src.db.courses.activities import ActivityRead
from src.db.users import AnonymousUser, APITokenUser, SuperadminAPITokenUser, User, UserCreate
from src.security.auth import get_current_user
from src.services.courses.activities.access import (
    redact_activity_for_reader,
    verify_activity_reader_access,
)
from src.services.payments import access as access_mod
from src.services.payments.access import (
    check_activity_paid_access,
    course_access_decision,
    get_course_access,
    has_course_access,
)
from src.tests.fixtures.rows import activity_row
from src.tests.payments.conftest import ORG_ID
from src.tests.payments.test_access import _enroll, _offer


@pytest.fixture(autouse=True)
def _verification_on(monkeypatch):
    monkeypatch.setenv("SC_EMAIL_VERIFICATION", "1")


async def _set_verified(db, user_id: int, value: bool = True) -> None:
    row = (await db.execute(select(User).where(User.id == user_id))).scalars().first()
    row.email_verified = value
    db.add(row)
    await db.commit()


def _as_tuple(access):
    return access.for_sale, access.has_access, access.reason, access.offers_count


class FakeRedis:
    """Enough of redis for the access cache and verification tokens."""

    def __init__(self):
        self.data: dict[str, str] = {}

    def get(self, key):
        value = self.data.get(key)
        return value.encode() if isinstance(value, str) else value

    def setex(self, key, _ttl, value):
        self.data[key] = value if isinstance(value, str) else str(value)

    def incr(self, key):
        self.data[key] = str(int(self.data.get(key, "0")) + 1)
        return int(self.data[key])

    def delete(self, *keys):
        for key in keys:
            self.data.pop(key, None)


# ------------------------------------------------------------------ access rule


class TestFreeCourseAccess:
    async def test_anonymous_must_sign_in(self, db, course, activity):
        assert _as_tuple(await get_course_access(db, AnonymousUser(), course)) == (False, False, "login_required", 0)
        assert _as_tuple(await get_course_access(db, None, course)) == (False, False, "login_required", 0)
        assert await check_activity_paid_access(None, activity.id, AnonymousUser(), db) is False

    async def test_org_api_token_must_sign_in(self, db, course):
        token = APITokenUser(id=3, org_id=ORG_ID, token_name="integration", created_by_user_id=1)
        assert _as_tuple(await get_course_access(db, token, course)) == (False, False, "login_required", 0)

    async def test_superadmin_token_passes(self, db, course):
        access = await get_course_access(db, SuperadminAPITokenUser(id=1), course)
        assert (access.has_access, access.for_sale) == (True, False)

    async def test_unverified_user_must_verify(self, db, course, activity, regular_user):
        await _set_verified(db, regular_user.id, False)
        assert _as_tuple(await get_course_access(db, regular_user, course)) == (False, False, "verify_email", 0)
        assert await check_activity_paid_access(None, activity.id, regular_user, db) is False

    async def test_verified_user_reads_free(self, db, course, activity, regular_user):
        await _set_verified(db, regular_user.id)
        assert _as_tuple(await get_course_access(db, regular_user, course)) == (False, True, "free", 0)
        assert await check_activity_paid_access(None, activity.id, regular_user, db) is True

    async def test_session_flag_is_not_trusted(self, db, course, regular_user):
        # The session object says verified; the row says otherwise.
        await _set_verified(db, regular_user.id, False)
        stale = regular_user.model_copy()
        object.__setattr__(stale, "email_verified", True)
        assert (await get_course_access(db, stale, course)).reason == "verify_email"

    async def test_admin_passes_unverified(self, db, course, admin_user):
        await _set_verified(db, admin_user.id, False)
        assert _as_tuple(await get_course_access(db, admin_user, course)) == (False, True, "admin", 0)

    async def test_author_passes_unverified(self, db, course, author_user):
        assert _as_tuple(await get_course_access(db, author_user, course)) == (False, True, "author", 0)

    async def test_switch_off_restores_open_free_courses(self, db, course, monkeypatch):
        monkeypatch.setenv("SC_EMAIL_VERIFICATION", "0")
        assert _as_tuple(await get_course_access(db, AnonymousUser(), course)) == (False, True, "free", 0)

    async def test_paid_course_unchanged(self, db, course, regular_user):
        # Unverified buyers keep what they bought; non-buyers still get "none".
        await _set_verified(db, regular_user.id, False)
        offer = await _offer(db, course.course_uuid)
        assert (await get_course_access(db, regular_user, course)).reason == "none"
        await _enroll(db, regular_user.id, offer)
        assert (await get_course_access(db, regular_user, course)).reason == "purchased"
        assert (await get_course_access(db, AnonymousUser(), course)).reason == "anonymous"


# ---------------------------------------------------------- reader gate / trail


class TestFreeReaderGate:
    async def test_anonymous_gets_401(self, db, org_config, course, activity, mock_request):
        with pytest.raises(HTTPException) as exc:
            await verify_activity_reader_access(mock_request, activity, course, AnonymousUser(), db)
        assert exc.value.status_code == 401
        assert exc.value.detail["code"] == "LOGIN_REQUIRED"

    async def test_unverified_gets_403_and_reason_marker(self, db, org_config, course, activity, regular_user, mock_request):
        await _set_verified(db, regular_user.id, False)
        with pytest.raises(HTTPException) as exc:
            await verify_activity_reader_access(mock_request, activity, course, regular_user, db)
        assert exc.value.status_code == 403
        assert exc.value.detail["code"] == "EMAIL_NOT_VERIFIED"
        redacted = await redact_activity_for_reader(
            mock_request, ActivityRead.model_validate(activity), activity, course, regular_user, db
        )
        assert redacted.content == {"paid_access": False, "reason": "verify_email"}

    async def test_verified_passes(self, db, org_config, course, activity, regular_user, mock_request):
        await _set_verified(db, regular_user.id)
        await verify_activity_reader_access(mock_request, activity, course, regular_user, db)

    async def test_paid_course_still_402(self, db, org_config, course, activity, regular_user, mock_request):
        await _set_verified(db, regular_user.id, False)
        await _offer(db, course.course_uuid)
        with pytest.raises(HTTPException) as exc:
            await verify_activity_reader_access(mock_request, activity, course, regular_user, db)
        assert exc.value.status_code == 402


class TestFreeStartCourse:
    async def _trail(self, db, user):
        from src.db.trails import Trail

        db.add(Trail(org_id=ORG_ID, user_id=user.id, trail_uuid="trail_x",
                     creation_date=str(datetime.now()), update_date=str(datetime.now())))
        await db.commit()

    async def test_unverified_gets_403_email_not_verified(self, db, org_config, course, activity, regular_user, mock_request):
        from src.services.trail.trail import add_course_to_trail

        await _set_verified(db, regular_user.id, False)
        await self._trail(db, regular_user)
        with pytest.raises(HTTPException) as exc:
            await add_course_to_trail(mock_request, regular_user, course.course_uuid, db)
        assert exc.value.status_code == 403
        assert exc.value.detail["code"] == "EMAIL_NOT_VERIFIED"

    async def test_verified_starts_free_course(self, db, org_config, course, activity, regular_user, mock_request):
        from src.services.trail.trail import add_course_to_trail

        await _set_verified(db, regular_user.id)
        await self._trail(db, regular_user)
        trail = await add_course_to_trail(mock_request, regular_user, course.course_uuid, db)
        assert len(trail.runs) == 1


class TestAccessEndpoint:
    async def test_reasons_over_http(self, client, current, db, course, regular_user):
        url = f"/api/v1/payments/{ORG_ID}/access?resource_uuid={course.course_uuid}"
        body = (await client.get(url)).json()
        assert (body["reason"], body["has_access"], body["for_sale"], body["payment_pending"]) == (
            "login_required", False, False, False)
        await _set_verified(db, regular_user.id, False)
        current.set(regular_user)
        assert (await client.get(url)).json()["reason"] == "verify_email"
        await _set_verified(db, regular_user.id)
        body = (await client.get(url)).json()
        assert (body["reason"], body["has_access"]) == ("free", True)


# ------------------------------------------------------------- /content (PDF)


@pytest.fixture
def content_app(db):
    from src.routers.local_content import router as local_content_router

    app = FastAPI()
    app.include_router(local_content_router)
    app.dependency_overrides[get_db_session] = lambda: db
    yield app
    app.dependency_overrides.clear()


class TestFreePdfContent:
    async def _get(self, app, user, org, course, tmp_path):
        from src.routers import local_content

        app.dependency_overrides[get_current_user] = lambda: user
        content_root = tmp_path / "content"
        path = (content_root / "orgs" / org.org_uuid / "courses" / course.course_uuid
                / "activities" / "activity_pdf" / "documents" / "ebook.pdf")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"%PDF-1.4")
        original = local_content.CONTENT_DIR
        local_content.CONTENT_DIR = content_root
        try:
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
                return await c.get(
                    f"/content/orgs/{org.org_uuid}/courses/{course.course_uuid}"
                    "/activities/activity_pdf/documents/ebook.pdf"
                )
        finally:
            local_content.CONTENT_DIR = original

    async def test_free_pdf_needs_verified_account(self, db, content_app, org, course, regular_user, tmp_path):
        db.add(activity_row(601, org.id, course.id, "activity_pdf"))
        await db.commit()

        anon = await self._get(content_app, AnonymousUser(), org, course, tmp_path)
        assert anon.status_code == 401

        await _set_verified(db, regular_user.id, False)
        unverified = await self._get(content_app, regular_user, org, course, tmp_path)
        assert unverified.status_code == 403
        assert unverified.json()["detail"]["code"] == "EMAIL_NOT_VERIFIED"

        await _set_verified(db, regular_user.id)
        ok = await self._get(content_app, regular_user, org, course, tmp_path)
        assert ok.status_code == 200
        assert ok.content == b"%PDF-1.4"


# ----------------------------------------------------------------- signup


def _signup_patches(mode="oss"):
    return [
        patch("src.services.users.users.validate_password_complexity", return_value=Mock(is_valid=True)),
        patch("src.services.users.users.check_limits_with_usage", new_callable=AsyncMock),
        patch("src.services.users.users.increase_feature_usage", new_callable=AsyncMock),
        patch("src.services.users.users.track", new_callable=AsyncMock),
        patch("src.services.users.users.dispatch_webhooks", new_callable=AsyncMock),
        patch("src.services.users.users.get_deployment_mode", return_value=mode),
        patch("src.services.users.users.rbac_check", new_callable=AsyncMock),
    ]


class TestSignupVerification:
    async def _signup(self, db, mock_request, org, *, oauth=False, username="nueva", without_org=False,
                      send_side_effect=None):
        from contextlib import ExitStack

        from src.services.users.users import create_user, create_user_without_org

        with ExitStack() as stack:
            for p in _signup_patches():
                stack.enter_context(p)
            welcome = stack.enter_context(patch("src.services.users.users.send_account_creation_email"))
            send = stack.enter_context(patch(
                "src.services.users.email_verification.send_verification_email",
                new_callable=AsyncMock, side_effect=send_side_effect,
            ))
            user_object = UserCreate(
                username=username, first_name="Nueva", last_name="Lectora",
                email=f"{username}@example.com", password="" if oauth else "Password123!",
            )
            if without_org:
                created = await create_user_without_org(mock_request, db, AnonymousUser(), user_object,
                                                        is_oauth=oauth)
            else:
                created = await create_user(mock_request, db, AnonymousUser(), user_object, org.id,
                                            is_oauth=oauth, signup_provider="google" if oauth else "email")
        return created, send, welcome

    async def test_password_signup_is_unverified_and_gets_the_mail(self, db, mock_request, org, org_config):
        created, send, welcome = await self._signup(db, mock_request, org)
        assert created.email_verified is False
        send.assert_awaited_once()
        assert send.await_args.args[3] == org.id
        welcome.assert_not_called()  # one mail, not two

    async def test_mail_failure_does_not_fail_signup(self, db, mock_request, org, org_config):
        created, send, _ = await self._signup(db, mock_request, org, send_side_effect=HTTPException(500))
        assert created.email_verified is False
        send.assert_awaited_once()

    async def test_oauth_signup_stays_verified(self, db, mock_request, org, org_config):
        created, send, _ = await self._signup(db, mock_request, org, oauth=True, username="google")
        assert created.email_verified is True
        send.assert_not_awaited()

    async def test_switch_off_keeps_upstream(self, db, mock_request, org, org_config, monkeypatch):
        monkeypatch.setenv("SC_EMAIL_VERIFICATION", "0")
        created, send, _ = await self._signup(db, mock_request, org, username="sinverif")
        assert created.email_verified is True
        send.assert_not_awaited()

    async def test_orgless_password_signup(self, db, mock_request, org):
        created, send, welcome = await self._signup(db, mock_request, org, username="solo", without_org=True)
        assert created.email_verified is False
        send.assert_awaited_once()
        assert send.await_args.args[3] is None
        welcome.assert_not_called()

    async def test_orgless_switch_off_sends_welcome(self, db, mock_request, org, monkeypatch):
        monkeypatch.setenv("SC_EMAIL_VERIFICATION", "0")
        created, send, welcome = await self._signup(db, mock_request, org, username="solo2", without_org=True)
        assert created.email_verified is True
        send.assert_not_awaited()
        welcome.assert_called_once()


# ------------------------------------------------- verify-email bumps the cache


class TestVerifyBumpsAccess:
    async def test_verification_reopens_cached_denial(self, db, org, course, regular_user, mock_request):
        from src.services.users.email_verification import verify_email_token

        await _set_verified(db, regular_user.id, False)
        fake = FakeRedis()
        with patch.object(access_mod, "_cache_client", return_value=fake):
            assert await has_course_access(None, db, regular_user, course) is False
            # Cached as a denial with its reason.
            assert any(v == "0|verify_email" for v in fake.data.values())
            assert await course_access_decision(None, db, regular_user, course) == (False, "verify_email")

            token_key = f"email_verification:{regular_user.user_uuid}:org:{org.org_uuid}:token:tok"
            fake.data[token_key] = json.dumps({
                "token": "tok", "user_uuid": regular_user.user_uuid, "org_uuid": org.org_uuid,
                "email": regular_user.email, "expires_at": datetime.now().timestamp() + 3600,
            })
            with patch("src.services.users.email_verification.get_redis_connection", return_value=fake), \
                    patch("src.services.users.email_verification.dispatch_webhooks", new_callable=AsyncMock):
                user, message = await verify_email_token(
                    mock_request, db, "tok", regular_user.user_uuid, org.org_uuid
                )
            assert message == "Email verified successfully"
            assert fake.data[access_mod._VERSION_KEY] == "1"
            # A new version: the old denial is not read any more.
            assert await has_course_access(None, db, regular_user, course) is True


# ------------------------------------------------------- review follow-ups


class TestArchivedOfferBuyer:
    async def test_unverified_buyer_keeps_course_after_offer_archived(self, db, course, activity, regular_user,
                                                                       outsider):
        await _set_verified(db, regular_user.id, False)
        offer = await _offer(db, course.course_uuid)
        await _enroll(db, regular_user.id, offer)
        offer.archived = True
        db.add(offer)
        await db.commit()
        # No live offer: the course reads as free, but the buyer keeps it.
        assert _as_tuple(await get_course_access(db, regular_user, course)) == (False, True, "purchased", 0)
        assert await check_activity_paid_access(None, activity.id, regular_user, db) is True
        # A non-buyer still has to verify.
        await _set_verified(db, outsider.id, False)
        assert (await get_course_access(db, outsider, course)).reason == "verify_email"


class TestChapterTreeOnFreeCourse:
    async def _tree(self, db, course, activity, user):
        from src.db.courses.chapters import ChapterRead
        from src.services.courses.chapters import _apply_locks_to_chapters

        act = ActivityRead.model_validate(activity)
        act.content = {"body": "secret"}
        chapter = ChapterRead(
            id=1, name="Capítulo", description="", thumbnail_image="", org_id=course.org_id,
            course_id=course.id, chapter_uuid="chapter_tree", activities=[act],
            creation_date="2024-01-01", update_date="2024-01-01",
        )
        await _apply_locks_to_chapters([chapter], course, user, db)
        return act

    async def test_anonymous_tree_is_stripped(self, db, course, activity):
        act = await self._tree(db, course, activity, AnonymousUser())
        assert act.content == {"paid_access": False}
        assert act.details is None

    async def test_unverified_tree_is_stripped(self, db, course, activity, regular_user):
        await _set_verified(db, regular_user.id, False)
        act = await self._tree(db, course, activity, regular_user)
        assert act.content == {"paid_access": False}

    async def test_verified_tree_keeps_content(self, db, course, activity, regular_user):
        await _set_verified(db, regular_user.id)
        act = await self._tree(db, course, activity, regular_user)
        assert act.content == {"body": "secret"}


class TestRequestMemo:
    async def test_decision_memoized_per_request(self, db, course, regular_user):
        from starlette.requests import Request

        await _set_verified(db, regular_user.id, False)
        request = Request({"type": "http", "method": "GET", "headers": [], "query_string": b""})
        assert await course_access_decision(request, db, regular_user, course) == (False, "verify_email")
        with patch.object(access_mod, "get_course_access", new_callable=AsyncMock) as recompute:
            assert await course_access_decision(request, db, regular_user, course) == (False, "verify_email")
            recompute.assert_not_awaited()

    async def test_legacy_cache_entries_are_not_read(self, db, course):
        fake = FakeRedis()
        fake.data[f"sc_pay:access:v0:{course.id}:anon"] = "1"
        with patch.object(access_mod, "_cache_client", return_value=fake):
            assert await course_access_decision(None, db, AnonymousUser(), course) == (False, "login_required")


class TestGoogleVerifiesAndBumps:
    async def test_google_sign_in_on_unverified_account_bumps_access(self, db):
        from src.tests.security.test_auth_flow_hardening import _google_request, _make_user as _make_auth_user
        from src.services.auth.utils import signWithGoogle

        await _make_auth_user(db, 90, "lectora@test.com", email_verified=False)
        payload = {"email": "lectora@test.com", "email_verified": True}
        with patch("src.services.auth.utils.get_google_user_info", new=AsyncMock(return_value=payload)), \
                patch("src.services.auth.utils.update_login_info", return_value=None), \
                patch("src.security.auth.revoke_user_sessions_before"), \
                patch.object(access_mod, "bump_access_version") as bump:
            await signWithGoogle(_google_request(), access_token="t", email="lectora@test.com",
                                 org_id=None, current_user=None, db_session=db)
        bump.assert_called_once()


class TestSignupMailTimeout:
    async def test_slow_mail_does_not_hold_the_signup(self, db, mock_request, org, org_config, monkeypatch):
        import asyncio

        from src.services.users import users as users_mod

        monkeypatch.setattr(users_mod, "_SC_VERIFICATION_MAIL_TIMEOUT_S", 0.05)

        async def _slow(*_args, **_kw):
            await asyncio.sleep(5)

        created, send, _ = await TestSignupVerification()._signup(
            db, mock_request, org, username="lenta", send_side_effect=_slow,
        )
        assert created.email_verified is False
        send.assert_awaited_once()

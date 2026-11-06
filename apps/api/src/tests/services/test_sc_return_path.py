"""Sanar y Criar: the page a verification link sends a new account back to.

The gift page (``/regalo?…``) is named at signup or on "resend", kept in Redis
next to the verification token and carried by the link as ``&redirect=``.
"""

import html
import re
from contextlib import ExitStack
from unittest.mock import AsyncMock, Mock, patch
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlmodel import select

from src.core.events.database import get_db_session
from src.db.users import AnonymousUser, User, UserCreate, UserRead
from src.services.users.email_verification import TOKEN_TTL_SECONDS
from src.services.users.sc_return_path import RETURN_PATH_MAX_LENGTH, keep_return_path, safe_return_path

GIFT = (
    "/regalo?resultado=limites&origen=test&guia=2999a0ad-1b2c-4d3e-8f40-5a6b7c8d9e0f"
    "&oferta=90785380-aaaa-4bbb-8ccc-dddddddddddd"
)
OTHER_GIFT = "/regalo?origen=guia-gratis"


def _key(user_uuid: str) -> str:
    return f"email_verification_return:{user_uuid}"


class FakeRedis:
    """Enough of redis for verification tokens and the return path."""

    def __init__(self):
        self.data: dict[str, str] = {}
        self.ttl: dict[str, int] = {}

    def get(self, key):
        value = self.data.get(key)
        return value.encode() if isinstance(value, str) else value

    def setex(self, key, ttl, value):
        self.data[key] = value
        self.ttl[key] = ttl


# ------------------------------------------------------------------ the guard


class TestSafeReturnPath:
    @pytest.mark.parametrize("path", [
        "/regalo",
        "/regalo?",
        GIFT,
        OTHER_GIFT,
        "/regalo?x=a%20b",
        "/regalo?next=/store/cart",
        "/regalo?" + "a" * (RETURN_PATH_MAX_LENGTH - len("/regalo?")),
    ])
    def test_accepted(self, path):
        assert safe_return_path(path) == path

    @pytest.mark.parametrize("path", [
        "//evil.com",
        "/regalo/../admin",
        "/regalox",
        "/regalos",
        "/regalo/",
        "https://x",
        "%2f%2fevil",
        "/regalo?x=1\n",
        "/regalo\n",
        "/regalo?x=1\r\n",
        "/regalo?next=//evil.com",
        "/regalo?x=..",
        "/regalo?x=%2f%2fevil.com",
        "/regalo?x=%2F",
        "/regalo?x=%5c",
        "/regalo?x=%5C",
        "/regalo?x=%2e%2E",
        "/regalo?x=\\evil",
        "/regalo#top",
        "/regalo?x=<script>",
        "/regalo?x=a b",
        "/regalo?x=ñ",
        "/Regalo",
        "regalo",
        " /regalo",
        "",
        "/regalo?" + "a" * (RETURN_PATH_MAX_LENGTH - len("/regalo?") + 1),
        None,
        123,
        b"/regalo",
        ["/regalo"],
        {"path": "/regalo"},
    ])
    def test_refused(self, path):
        assert safe_return_path(path) is None


class TestKeepReturnPath:
    def test_new_path_is_stored_for_the_life_of_the_link(self):
        r = FakeRedis()
        assert keep_return_path(r, "user_1", GIFT, 3600) == GIFT
        assert r.data[_key("user_1")] == GIFT and r.ttl[_key("user_1")] == 3600

    def test_stored_path_is_used_again_and_kept_alive(self):
        r = FakeRedis()
        r.data[_key("user_1")] = GIFT
        assert keep_return_path(r, "user_1", None, 3600) == GIFT
        assert r.ttl[_key("user_1")] == 3600

    def test_safe_new_path_replaces_the_stored_one(self):
        r = FakeRedis()
        r.data[_key("user_1")] = GIFT
        assert keep_return_path(r, "user_1", OTHER_GIFT, 3600) == OTHER_GIFT
        assert r.data[_key("user_1")] == OTHER_GIFT

    def test_unsafe_new_path_keeps_the_stored_one(self):
        r = FakeRedis()
        r.data[_key("user_1")] = GIFT
        assert keep_return_path(r, "user_1", "//evil.com", 3600) == GIFT
        assert r.data[_key("user_1")] == GIFT

    def test_a_tampered_stored_value_is_not_used(self):
        r = FakeRedis()
        r.data[_key("user_1")] = "https://evil.example.com"
        assert keep_return_path(r, "user_1", None, 3600) is None

    def test_nothing_kept_nothing_stored(self):
        r = FakeRedis()
        assert keep_return_path(r, "user_1", None, 3600) is None
        assert r.data == {}

    def test_redis_failure_never_raises(self):
        broken = Mock(get=Mock(side_effect=ConnectionError("down")), setex=Mock(side_effect=ConnectionError("down")))
        assert keep_return_path(broken, "user_1", None, 3600) is None
        # The link being sent still carries a safe new path.
        assert keep_return_path(broken, "user_1", GIFT, 3600) == GIFT


# ------------------------------------------------------------------ the link


def _verification_href(return_path) -> str:
    from src.services.users.emails import send_email_verification_email

    user = UserRead(id=1, username="ana", first_name="Ana", last_name="", email="ana@example.com",
                    user_uuid="user_1")
    with patch("src.services.users.emails.send_email", return_value=True) as send:
        send_email_verification_email("tok", user, None, "ana@example.com", "https://cursos.test",
                                      return_path=return_path)
    body = send.call_args.kwargs["body"]
    return html.unescape(re.search(r'href="([^"]*/verify-email\?[^"]*)"', body).group(1))


class TestVerificationLink:
    def test_link_carries_a_safe_path(self):
        href = _verification_href(GIFT)
        assert "&redirect=%2Fregalo%3Fresultado%3Dlimites%26origen%3Dtest%26guia%3D" in href
        query = parse_qs(urlsplit(href).query)
        assert query["redirect"] == [GIFT]
        assert (query["token"], query["user"], query["org"]) == (["tok"], ["user_1"], ["none"])

    @pytest.mark.parametrize("path", [None, "", "//evil.com", "/regalox", "https://x", "/regalo?x=1\n"])
    def test_no_redirect_without_a_safe_path(self, path):
        assert "redirect" not in _verification_href(path)


# ---------------------------------------------- signup, mail and resend


@pytest.fixture
def verification_on(monkeypatch):
    monkeypatch.setenv("SC_EMAIL_VERIFICATION", "1")


@pytest.fixture
def mail():
    """Real verification service; Redis faked and the mail itself captured."""
    redis = FakeRedis()
    with patch("src.services.users.email_verification.get_redis_connection", return_value=redis), \
            patch("src.services.users.email_verification.send_email_verification_email",
                  return_value=True) as send, \
            patch("src.services.users.email_verification.check_verification_resend_rate_limit",
                  return_value=(True, 0)):
        yield redis, send


async def _signup(mock_request, db, org, *, return_path, username="nueva", without_org=False):
    from src.services.users.users import create_user, create_user_without_org

    patches = [
        patch("src.services.users.users.validate_password_complexity", return_value=Mock(is_valid=True)),
        patch("src.services.users.users.check_limits_with_usage", new_callable=AsyncMock),
        patch("src.services.users.users.increase_feature_usage", new_callable=AsyncMock),
        patch("src.services.users.users.track", new_callable=AsyncMock),
        patch("src.services.users.users.dispatch_webhooks", new_callable=AsyncMock),
        patch("src.services.users.users.get_deployment_mode", return_value="oss"),
        patch("src.services.users.users.rbac_check", new_callable=AsyncMock),
    ]
    user_object = UserCreate.model_validate({
        "username": username, "first_name": "Nueva", "last_name": "Lectora",
        "email": f"{username}@example.com", "password": "Password123!", "return_path": return_path,
    })
    with ExitStack() as stack:
        for p in patches:
            stack.enter_context(p)
        if without_org:
            return await create_user_without_org(mock_request, db, AnonymousUser(), user_object)
        return await create_user(mock_request, db, AnonymousUser(), user_object, org.id)


class TestSignup:
    async def test_signup_keeps_the_path_and_the_mail_carries_it(self, mock_request, db, org, verification_on,
                                                                 mail):
        redis, send = mail
        created = await _signup(mock_request, db, org, return_path=GIFT)
        assert created.email_verified is False
        assert redis.data[_key(created.user_uuid)] == GIFT
        assert redis.ttl[_key(created.user_uuid)] == TOKEN_TTL_SECONDS
        assert send.call_args.kwargs["return_path"] == GIFT
        # Never stored on the account.
        assert "return_path" not in created.model_dump()
        row = (await db.execute(select(User).where(User.id == created.id))).scalars().one()
        assert "return_path" not in row.model_dump()
        assert GIFT not in str(row.model_dump())

    async def test_orgless_signup_too(self, mock_request, db, org, verification_on, mail):
        redis, send = mail
        created = await _signup(mock_request, db, org, return_path=GIFT, username="solo", without_org=True)
        assert redis.data[_key(created.user_uuid)] == GIFT
        assert send.call_args.kwargs["return_path"] == GIFT

    @pytest.mark.parametrize("return_path", ["//evil.com", "/regalo/../admin", 123, ["/regalo"], {"x": 1}, None])
    async def test_unsafe_or_missing_path_never_fails_the_signup(self, mock_request, db, org, verification_on,
                                                                 mail, return_path):
        redis, send = mail
        created = await _signup(mock_request, db, org, return_path=return_path)
        assert created.email_verified is False
        assert _key(created.user_uuid) not in redis.data
        send.assert_called_once()
        assert send.call_args.kwargs["return_path"] is None

    def test_model_drops_other_types(self):
        base = {"username": "u", "email": "u@example.com", "password": "pw"}
        assert UserCreate.model_validate({**base, "return_path": 7}).return_path is None
        assert UserCreate.model_validate({**base, "return_path": GIFT}).return_path == GIFT
        assert UserCreate.model_validate(base).return_path is None


class TestResend:
    async def _unverified(self, db, uuid="user_resend"):
        user = User(username="resend", first_name="Re", last_name="Send", email="resend@example.com",
                    password="x", user_uuid=uuid, email_verified=False)
        db.add(user)
        await db.commit()
        await db.refresh(user)
        return user

    async def _resend(self, mock_request, db, org, email="resend@example.com", **kwargs):
        from src.services.users.email_verification import resend_verification_email

        return await resend_verification_email(mock_request, db, email, org.id, **kwargs)

    async def test_resend_keeps_the_signup_path(self, mock_request, db, org, mail):
        redis, send = mail
        user = await self._unverified(db)
        redis.data[_key(user.user_uuid)] = GIFT
        await self._resend(mock_request, db, org)
        assert send.call_args.kwargs["return_path"] == GIFT
        assert redis.ttl[_key(user.user_uuid)] == TOKEN_TTL_SECONDS

    async def test_resend_with_a_safe_path_replaces_it(self, mock_request, db, org, mail):
        redis, send = mail
        user = await self._unverified(db)
        redis.data[_key(user.user_uuid)] = GIFT
        await self._resend(mock_request, db, org, return_path=OTHER_GIFT)
        assert send.call_args.kwargs["return_path"] == OTHER_GIFT
        assert redis.data[_key(user.user_uuid)] == OTHER_GIFT

    async def test_resend_with_an_unsafe_path_keeps_the_stored_one(self, mock_request, db, org, mail):
        redis, send = mail
        user = await self._unverified(db)
        redis.data[_key(user.user_uuid)] = GIFT
        await self._resend(mock_request, db, org, return_path="https://evil.example.com")
        assert send.call_args.kwargs["return_path"] == GIFT

    async def test_resend_can_add_a_path_the_signup_did_not_have(self, mock_request, db, org, mail):
        redis, send = mail
        user = await self._unverified(db)
        await self._resend(mock_request, db, org, return_path=GIFT)
        assert redis.data[_key(user.user_uuid)] == GIFT
        assert send.call_args.kwargs["return_path"] == GIFT

    async def test_unknown_or_verified_address_stores_nothing(self, mock_request, db, org, mail):
        redis, send = mail
        user = await self._unverified(db)
        user.email_verified = True
        db.add(user)
        await db.commit()
        message = await self._resend(mock_request, db, org, return_path=GIFT)
        assert message.startswith("If an account")
        unknown = await self._resend(mock_request, db, org, email="nadie@example.com", return_path=GIFT)
        assert unknown == message
        assert redis.data == {}
        send.assert_not_called()


class TestResendRoute:
    @pytest.fixture
    async def client(self, db):
        from src.routers.auth import router as auth_router

        app = FastAPI()
        app.include_router(auth_router, prefix="/api/v1/auth")
        app.dependency_overrides[get_db_session] = lambda: db
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            yield c

    @pytest.mark.parametrize("sent,expected", [
        (GIFT, GIFT),
        ("//evil.com", None),
        (123, None),
        (["/regalo"], None),
        (None, None),
    ])
    async def test_return_path_never_fails_the_request(self, client, sent, expected):
        with patch("src.routers.auth.resend_verification_email", new_callable=AsyncMock,
                   return_value="sent") as resend:
            response = await client.post("/api/v1/auth/resend-verification", json={
                "email": "ana@example.com", "org_id": 1, "return_path": sent,
            })
        assert response.status_code == 200, response.text
        assert resend.await_args.kwargs["return_path"] == expected

    async def test_without_return_path(self, client):
        with patch("src.routers.auth.resend_verification_email", new_callable=AsyncMock,
                   return_value="sent") as resend:
            response = await client.post("/api/v1/auth/resend-verification", json={"email": "ana@example.com"})
        assert response.status_code == 200
        assert resend.await_args.kwargs["return_path"] is None

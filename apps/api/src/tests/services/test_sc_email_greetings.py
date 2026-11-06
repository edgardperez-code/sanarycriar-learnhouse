"""Sanar y Criar: mail greets the account holder by first name, never by the
username sign-up generates (services/users/sc_username.py).

Every mail that greets its reader (verification and its resend, welcome,
password reset, email changed, org join, role changed, magic login) is
rendered with and without a first name. With one it greets by it,
HTML-escaped (plain in the subject); without one, or with one that carries a
link, it says the same with no name. The generated username shows up in
neither, body or subject. The sign-up route, the resend and the org-join and
role-change callers are checked end to end. All fixtures are synthetic.
"""

import re
from datetime import datetime
from unittest.mock import AsyncMock, Mock, patch

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlmodel import select

from src.core.events.database import get_db_session
from src.db.organizations import OrganizationRead
from src.db.roles import Role, RoleTypeEnum
from src.db.user_organizations import UserOrganization
from src.db.users import AnonymousUser, User, UserRead
from src.routers.users import router as users_router
from src.security.auth import get_current_user
from src.services.auth.magic_login import send_magic_login_email
from src.services.email.sc_greeting import email_first_name
from src.services.email.translations import EMAIL_TRANSLATIONS, NAMELESS_COPY, SUPPORTED_LANGUAGES
from src.services.orgs.join_notifications import notify_user_joined_org
from src.services.orgs.users import update_user_role
from src.services.users.email_verification import resend_verification_email
from src.services.users.emails import (
    send_account_creation_email,
    send_email_changed_notice,
    send_email_verification_email,
    send_org_join_email,
    send_password_reset_email,
    send_password_reset_email_platform,
    send_role_changed_email,
)

GENERATED = "mariapena583735"
PASSWORD = "Password123!"
BASE_URL = "https://cursos.test"
SEND = "src.services.users.emails.send_email"
SEND_MAGIC = "src.services.auth.magic_login.send_email"
REDIS = "src.services.users.email_verification.get_redis_connection"
ORG_BASE_URL = "src.services.email.utils.get_org_signup_base_url"


def _user(first_name: str) -> UserRead:
    return UserRead(
        id=1, username=GENERATED, first_name=first_name, last_name="Peña",
        email="maria@example.com", user_uuid="user_maria",
    )


def _org() -> OrganizationRead:
    return OrganizationRead(
        id=1, name="Acme", slug="acme", email="org@example.com", org_uuid="org_acme",
        creation_date="2026-01-01", update_date="2026-01-01",
    )


def _render_all(first_name: str, lang: str = "es") -> dict[str, dict]:
    """Every greeting mail for an account with this first name (and a
    generated username), keyed by mail: the kwargs ``send_email`` got."""
    user = _user(first_name)
    sent: dict[str, dict] = {}
    with patch(SEND, return_value=True) as mail, patch(SEND_MAGIC, return_value=True) as magic:
        def keep(name, mock=mail):
            sent[name] = mock.call_args.kwargs

        send_email_verification_email("tok", user, None, user.email, BASE_URL, lang=lang)
        keep("verification")
        send_email_verification_email("tok", user, _org(), user.email, BASE_URL, lang=lang)
        keep("verification_org")
        send_account_creation_email(user, user.email, lang=lang)
        keep("welcome")
        send_account_creation_email(user, user.email, lang=lang, org_name="Acme")
        keep("welcome_org")
        send_password_reset_email("CODE1234", user, _org(), user.email, BASE_URL, lang=lang)
        keep("password_reset")
        send_password_reset_email_platform("CODE1234", user, user.email, BASE_URL, lang=lang)
        keep("password_reset_platform")
        send_email_changed_notice(
            email="old@example.com", new_email=user.email, username=GENERATED, lang=lang,
            first_name=first_name,
        )
        keep("email_changed")
        send_org_join_email(
            email=user.email, username=GENERATED, org_name="Acme", cta_url=BASE_URL, lang=lang,
            first_name=first_name,
        )
        keep("org_join")
        send_role_changed_email(
            email=user.email, username=GENERATED, org_name="Acme", new_role_name="Instructora",
            lang=lang, first_name=first_name,
        )
        keep("role_changed")
        send_magic_login_email(user, user.email, BASE_URL, "tok", lang=lang)
        keep("magic_login", magic)
    return sent


# What each mail says, in Spanish: with the first name, and without one.
NAMED_ES = {
    "verification": "Hola María, ¡te damos la bienvenida a Sanar y Criar!",
    "verification_org": "Hola María, ¡te damos la bienvenida a Acme!",
    "welcome": ">¡Hola, María!</h1>",
    "welcome_org": ">¡Hola, María!</h1>",
    "password_reset": "Hola María, recibimos una solicitud para restablecer tu contraseña.",
    "password_reset_platform": "Hola María, recibimos una solicitud para restablecer tu contraseña.",
    "email_changed": "Hola María, el correo de tu cuenta se cambió a maria@example.com.",
    "org_join": ">¡Ya estás dentro, María!</h1>",
    "role_changed": "Hola María, tu rol en <strong>Acme</strong> cambió a <strong>Instructora</strong>.",
    "magic_login": "Hola María, haz clic en el botón de abajo para iniciar sesión.",
}
NAMELESS_ES = {
    "verification": "Hola, ¡te damos la bienvenida a Sanar y Criar!",
    "verification_org": "Hola, ¡te damos la bienvenida a Acme!",
    "welcome": ">¡Hola!</h1>",
    "welcome_org": ">¡Hola!</h1>",
    "password_reset": "Hola, recibimos una solicitud para restablecer tu contraseña.",
    "password_reset_platform": "Hola, recibimos una solicitud para restablecer tu contraseña.",
    "email_changed": "Hola, el correo de tu cuenta se cambió a maria@example.com.",
    "org_join": ">¡Ya estás dentro!</h1>",
    "role_changed": "Hola, tu rol en <strong>Acme</strong> cambió a <strong>Instructora</strong>.",
    "magic_login": "Hola, haz clic en el botón de abajo para iniciar sesión.",
}
NAMED_EN = {
    "verification": "Hi Mary, welcome to Sanar y Criar!",
    "welcome": ">Welcome, Mary!</h1>",
    "password_reset": "Hi Mary, we received a request to reset your password.",
    "email_changed": "Hi Mary, the email address on your account was changed to maria@example.com.",
    "org_join": ">You're in, Mary!</h1>",
    "role_changed": "Hi Mary, your role in <strong>Acme</strong> has been changed to",
    "magic_login": "Hi Mary, click the button below to sign in.",
}
NAMELESS_EN = {
    "verification": "Hi, welcome to Sanar y Criar!",
    "welcome": ">Welcome!</h1>",
    "password_reset": "Hi, we received a request to reset your password.",
    "email_changed": "Hi, the email address on your account was changed to maria@example.com.",
    "org_join": ">You're in!</h1>",
    "role_changed": "Hi, your role in <strong>Acme</strong> has been changed to",
    "magic_login": "Hi, click the button below to sign in.",
}


def _assert_no_username(sent: dict[str, dict]) -> None:
    for name, call in sent.items():
        for part in ("subject", "body"):
            assert GENERATED not in call[part], (name, part)
            assert "{username}" not in call[part], (name, part)
            assert "_noname" not in call[part], (name, part)
            assert "LearnHouse user" not in call[part], (name, part)


def _body_text(body: str) -> str:
    """The body with its whitespace runs collapsed (the templates indent)."""
    return re.sub(r"\s+", " ", body)


# First names that carry a link or an address: never relayed, not even in part.
HOSTILE = [
    "www.evil.com",
    "Ana www.evil.com/x",
    "http://evil.dev/pago",
    "pago-evil.lat",
    "ana@evil.com",
    "<b>evil</b>",
    "Ana\r\nBcc: x@evil.test",
]


class TestFirstName:
    @pytest.mark.parametrize("value,expected", [
        ("María", "María"),
        ("  María   José ", "María José"),
        ("J", "J"),
        ("D'Angelo", "D'Angelo"),
        ("Ana & Luis", "Ana & Luis"),
        ("Ma. José", "Ma. José"),
        ("Ana​", "Ana"),
        ("", ""),
        ("   ", ""),
        (None, ""),
        ("…", ""),
    ])
    def test_the_first_name_or_nothing(self, value, expected):
        assert email_first_name(value) == expected

    @pytest.mark.parametrize("value", HOSTILE)
    def test_a_name_with_a_link_is_dropped_whole(self, value):
        assert email_first_name(value) == ""


class TestGreetings:
    def test_greets_by_first_name(self):
        sent = _render_all("María")
        for name, greeting in NAMED_ES.items():
            assert greeting in _body_text(sent[name]["body"]), name
        _assert_no_username(sent)

    def test_the_verification_mail_of_the_report(self):
        """The mail that said «Hola regalosinusuario583735, …»."""
        body = _body_text(_render_all("María")["verification"]["body"])
        assert "Hola María, ¡te damos la bienvenida a Sanar y Criar!" in body
        assert "Hola, ¡te damos" not in body

    @pytest.mark.parametrize("first_name", ["", "   ", "…"])
    def test_without_a_first_name_no_name_at_all(self, first_name):
        sent = _render_all(first_name)
        for name, greeting in NAMELESS_ES.items():
            assert greeting in _body_text(sent[name]["body"]), name
        _assert_no_username(sent)

    @pytest.mark.parametrize("first_name", HOSTILE)
    def test_a_name_with_a_link_is_left_out(self, first_name):
        sent = _render_all(first_name)
        for name, greeting in NAMELESS_ES.items():
            assert greeting in _body_text(sent[name]["body"]), name
        for call in sent.values():
            assert "evil" not in call["body"] and "evil" not in call["subject"]
        _assert_no_username(sent)

    def test_welcome_subjects(self):
        named, nameless = _render_all("María"), _render_all("")
        assert named["welcome"]["subject"] == "¡Te damos la bienvenida a Sanar y Criar, María!"
        assert named["welcome_org"]["subject"] == "¡Te damos la bienvenida a Acme, María!"
        assert nameless["welcome"]["subject"] == "¡Te damos la bienvenida a Sanar y Criar!"
        assert nameless["welcome_org"]["subject"] == "¡Te damos la bienvenida a Acme!"

    def test_the_name_is_escaped_in_the_body_and_plain_in_the_subject(self):
        sent = _render_all("Ana & Luis")
        for name, call in sent.items():
            assert "Ana &amp; Luis" in call["body"], name
            assert "Ana & Luis" not in call["body"], name
        assert sent["welcome"]["subject"] == "¡Te damos la bienvenida a Sanar y Criar, Ana & Luis!"
        apostrophe = _render_all("D'Angelo")
        assert apostrophe["welcome"]["subject"] == "¡Te damos la bienvenida a Sanar y Criar, D'Angelo!"
        assert "Hola D&#x27;Angelo, ¡te damos la bienvenida" in apostrophe["verification"]["body"]

    def test_english(self):
        named, nameless = _render_all("Mary", lang="en"), _render_all("", lang="en")
        for name, greeting in NAMED_EN.items():
            assert greeting in _body_text(named[name]["body"]), name
        for name, greeting in NAMELESS_EN.items():
            assert greeting in _body_text(nameless[name]["body"]), name
        assert nameless["welcome"]["subject"] == "Welcome to Sanar y Criar!"
        assert named["welcome"]["subject"] == "Welcome to Sanar y Criar, Mary!"
        _assert_no_username(named)
        _assert_no_username(nameless)

    @pytest.mark.parametrize("lang", SUPPORTED_LANGUAGES)
    def test_every_locale_without_a_first_name(self, lang):
        """Locales without name-less copy fall back to Spanish, never to a
        placeholder, a key or the username."""
        _assert_no_username(_render_all("", lang=lang))

    @pytest.mark.parametrize("lang", SUPPORTED_LANGUAGES)
    def test_every_locale_with_a_first_name(self, lang):
        sent = _render_all("Zoë", lang=lang)
        _assert_no_username(sent)
        for name in ("verification", "password_reset", "email_changed", "role_changed", "magic_login"):
            assert "Zoë" in sent[name]["body"], (lang, name)


class TestNamelessCopy:
    def test_spanish_and_english_cover_the_same_keys(self):
        assert NAMELESS_COPY["es"].keys() == NAMELESS_COPY["en"].keys()

    @pytest.mark.parametrize("lang", ["es", "en"])
    def test_each_matches_its_named_copy(self, lang):
        placeholders = re.compile(r"{(\w+)}")
        for key, nameless in NAMELESS_COPY[lang].items():
            assert key.endswith("_noname")
            named = EMAIL_TRANSLATIONS[lang][key.removesuffix("_noname")]
            assert "{username}" in named, key
            assert "{username}" not in nameless, key
            assert EMAIL_TRANSLATIONS[lang][key] == nameless
            assert set(placeholders.findall(named)) - {"username"} == set(placeholders.findall(nameless)), key


# ------------------------------------------------------------------ callers


async def _member(db, org, *, user_id: int, first_name: str, email: str, verified: bool = True) -> User:
    user = User(
        id=user_id, username=f"{GENERATED[:-1]}{user_id}", first_name=first_name, last_name="Peña",
        email=email, password="hashed", user_uuid=f"user_greet_{user_id}", email_verified=verified,
        creation_date=str(datetime.now()), update_date=str(datetime.now()),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    db.add(UserOrganization(
        user_id=user.id, org_id=org.id, role_id=4,
        creation_date=str(datetime.now()), update_date=str(datetime.now()),
    ))
    await db.commit()
    return user


class TestSignupVerificationMail:
    """The sign-up the web form now sends (no username), through the route,
    down to the mail the provider would get."""

    @pytest.fixture
    async def client(self, db, org, monkeypatch):
        monkeypatch.setenv("SC_EMAIL_VERIFICATION", "1")
        app = FastAPI()
        app.include_router(users_router, prefix="/api/v1/users")
        app.dependency_overrides[get_db_session] = lambda: db
        app.dependency_overrides[get_current_user] = lambda: AnonymousUser()
        targets = [
            patch(f"src.services.users.users.{name}", new_callable=AsyncMock)
            for name in ("check_limits_with_usage", "increase_feature_usage", "track", "dispatch_webhooks")
        ] + [
            patch("src.services.users.users.get_deployment_mode", return_value="oss"),
            patch("src.routers.users.check_signup_rate_limit", return_value=(True, 0)),
            patch("src.routers.users._enforce_password_signup_allowed", new_callable=AsyncMock),
            patch("src.routers.users.get_org_join_mechanism", new_callable=AsyncMock, return_value="open"),
            patch(REDIS, return_value=Mock()),
            patch(ORG_BASE_URL, new_callable=AsyncMock, return_value=BASE_URL),
        ]
        for target in targets:
            target.start()
        try:
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
                yield c
        finally:
            for target in reversed(targets):
                target.stop()

    async def _signup(self, client, **names):
        body = {"email": "maria@example.com", "password": PASSWORD, **names}
        with patch(SEND, return_value=True) as mail:
            response = await client.post("/api/v1/users/1", json=body)
        assert response.status_code == 200, response.text
        assert response.json()["email_verified"] is False
        assert mail.call_count == 1
        return response.json()["username"], mail.call_args.kwargs

    async def test_greets_by_first_name(self, client):
        username, sent = await self._signup(client, first_name="María", last_name="Peña")
        assert username.startswith("mariapena")
        assert "Hola María, ¡te damos la bienvenida a Test Org!" in _body_text(sent["body"])
        assert username not in sent["body"] and username not in sent["subject"]

    async def test_without_first_name_greets_without_a_name(self, client):
        username, sent = await self._signup(client, first_name="", last_name="")
        assert "Hola, ¡te damos la bienvenida a Test Org!" in _body_text(sent["body"])
        assert username not in sent["body"] and username not in sent["subject"]

    async def test_a_link_the_signup_check_lets_through_is_left_out(self, client):
        """«pago-evil.lat» passes the sign-up check (no TLD it knows, no
        path), but never reaches the mail."""
        username, sent = await self._signup(client, first_name="pago-evil.lat")
        assert "Hola, ¡te damos la bienvenida a Test Org!" in _body_text(sent["body"])
        assert "evil" not in sent["body"] and "evil" not in sent["subject"]
        assert username not in sent["body"]

    async def test_the_resend_too(self, client, mock_request, db):
        username, _ = await self._signup(client, first_name="", last_name="Peña")
        with patch(SEND, return_value=True) as mail, patch(
            "src.services.users.email_verification.check_verification_resend_rate_limit",
            return_value=(True, 0),
        ):
            await resend_verification_email(mock_request, db, "maria@example.com", 1)
        body = mail.call_args.kwargs["body"]
        assert "Hola, ¡te damos la bienvenida a Test Org!" in _body_text(body)
        assert username not in body


class TestCallers:
    async def test_org_join_mail(self, mock_request, db, org):
        named = await _member(db, org, user_id=41, first_name="María", email="maria@example.com")
        nameless = await _member(db, org, user_id=42, first_name="", email="ana@example.com")
        with patch(ORG_BASE_URL, new_callable=AsyncMock, return_value=BASE_URL), \
                patch(SEND, return_value=True) as mail:
            await notify_user_joined_org(mock_request, db, named, org.id)
            await notify_user_joined_org(mock_request, db, nameless, org.id)
        first, second = (c.kwargs for c in mail.call_args_list)
        assert ">¡Ya estás dentro, María!</h1>" in _body_text(first["body"])
        assert ">¡Ya estás dentro!</h1>" in _body_text(second["body"])
        for call, user in ((first, named), (second, nameless)):
            assert user.username not in call["body"] and user.username not in call["subject"]

    async def test_role_changed_mail(self, mock_request, db, org, admin_user):
        role = Role(
            id=11, name="Instructora", org_id=org.id, role_type=RoleTypeEnum.TYPE_ORGANIZATION,
            role_uuid="role_instructora", rights={},
            creation_date=str(datetime.now()), update_date=str(datetime.now()),
        )
        db.add(role)
        await db.commit()
        named = await _member(db, org, user_id=43, first_name="María", email="maria@example.com")
        nameless = await _member(db, org, user_id=44, first_name="", email="ana@example.com")
        with patch("src.services.orgs.users.rbac_check", new_callable=AsyncMock), \
                patch("src.routers.users._invalidate_session_cache"), \
                patch("src.services.orgs.users.dispatch_webhooks", new_callable=AsyncMock), \
                patch(ORG_BASE_URL, new_callable=AsyncMock, return_value=BASE_URL), \
                patch(SEND, return_value=True) as mail:
            for user in (named, nameless):
                assert await update_user_role(
                    mock_request, org.id, user.id, "role_instructora", db, admin_user
                ) == {"detail": "User role updated"}
        first, second = (c.kwargs for c in mail.call_args_list)
        assert "Hola María, tu rol en <strong>Test Org</strong> cambió a" in _body_text(first["body"])
        assert "Hola, tu rol en <strong>Test Org</strong> cambió a" in _body_text(second["body"])
        for call, user in ((first, named), (second, nameless)):
            assert user.username not in call["body"]
        stored = (await db.execute(select(User).where(User.id == nameless.id))).scalars().one()
        assert stored.first_name == ""

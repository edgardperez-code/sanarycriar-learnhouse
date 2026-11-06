"""Sanar y Criar: sign-ups that send no username get a generated one.

The sign-up form asks a mother for her email, password and name only (client
request 2026-11-05), so the API makes up the username before the conflict
check (services/users/sc_username.py). A username that is sent is kept.
All fixtures are synthetic.
"""

import re
from contextlib import ExitStack
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient
from sqlmodel import select

from src.core.events.database import get_db_session
from src.db.user_organizations import UserOrganization
from src.db.users import AnonymousUser, User, UserCreate
from src.routers.users import router as users_router
from src.security.auth import get_current_user
from src.services.security.profile_validation import contains_url, validate_profile_fields
from src.services.users.sc_username import (
    GENERATED_USERNAME_RE,
    USERNAME_RETRIES,
    fold,
    generate_username,
    needs_generated_username,
    username_base,
)
from src.services.users.users import (
    _reject_urls_in_profile_fields,
    create_user,
    create_user_with_invite,
    create_user_without_org,
)

PATTERN = re.compile(r"^[a-z0-9]{3,20}[0-9]{6}$")
PASSWORD = "Password123!"
GIFT = "/regalo?resultado=limites&origen=test"
DRAW = "src.services.users.sc_username._random_suffix"


def _generated(username: str, base: str) -> bool:
    """A generated username: ``base`` and 6 digits, in the documented shape."""
    return bool(PATTERN.fullmatch(username)) and username[:-6] == base and username[-6:].isdigit()


async def _add_user(db, username: str, email: str) -> User:
    user = User(username=username, first_name="Otra", last_name="Mamá", email=email,
                password="x", user_uuid=f"user_{username}")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def _stored(db, email: str) -> list[User]:
    return list((await db.execute(select(User).where(User.email == email))).scalars().all())


@pytest.fixture
def signup_env():
    """What a public signup touches besides the database, stubbed."""
    with ExitStack() as stack:
        for target in (
            "src.services.users.users.check_limits_with_usage",
            "src.services.users.users.increase_feature_usage",
            "src.services.users.users.track",
            "src.services.users.users.dispatch_webhooks",
        ):
            stack.enter_context(patch(target, new_callable=AsyncMock))
        stack.enter_context(patch("src.services.users.users.get_deployment_mode", return_value="oss"))
        stack.enter_context(patch("src.services.users.users.send_account_creation_email"))
        yield


async def _signup(mock_request, db, org, *, without_org=False, **fields):
    """A signup as the web form now sends it: no username unless one is given."""
    user_object = UserCreate.model_validate({"email": "ana@example.com", "password": PASSWORD, **fields})
    if without_org:
        return await create_user_without_org(mock_request, db, AnonymousUser(), user_object)
    return await create_user(mock_request, db, AnonymousUser(), user_object, org.id)


# ------------------------------------------------------------------ the rule


class TestFold:
    @pytest.mark.parametrize("value,expected", [
        ("María Peña", "mariapena"),
        ("JOSÉ-Ángel Núñez O'Brien", "joseangelnunezobrien"),
        ("Zoë Ürsula Çelik", "zoeursulacelik"),
        ("ｍａｒíａ", "maria"),
        ("Ana 😊 2", "ana2"),
        ("maria.co", "mariaco"),
        ("日本語", ""),
        ("   ", ""),
        ("", ""),
        (None, ""),
    ])
    def test_ascii_letters_and_digits_only(self, value, expected):
        assert fold(value) == expected


class TestUsernameBase:
    def test_first_and_last_name(self):
        assert username_base("María", "Peña", "ana@example.com") == "mariapena"

    def test_empty_names_use_the_email(self):
        assert username_base("", "", "Ana.Lucía+promo@example.com") == "analuciapromo"

    def test_names_shorter_than_three_use_the_email(self):
        assert username_base("Al", "", "al.k@example.com") == "alk"
        assert username_base("李", "伟", "liwei@example.com") == "liwei"

    def test_too_short_everywhere_is_mama(self):
        assert username_base("Li", "", "li@example.com") == "mama"
        assert username_base("", "", "") == "mama"
        assert username_base(None, None, None) == "mama"

    def test_cut_to_twenty(self):
        assert username_base("María Fernanda Alejandra", "González Rodríguez", "x@example.com") == "mariafernandaalejand"
        assert username_base("", "", "una.direccion.muy.larga.de.correo@example.com") == "unadireccionmuylarga"

    @pytest.mark.parametrize("value,expected", [
        ("", True), ("   ", True), ("\t\n", True), (None, True), ("ana", False), (" ana ", False),
    ])
    def test_blank_means_generate(self, value, expected):
        assert needs_generated_username(value) is expected


class TestGenerated:
    async def test_shape(self, db):
        username = await generate_username(db, "María", "Peña", "maria@example.com")
        assert _generated(username, "mariapena")
        assert GENERATED_USERNAME_RE.fullmatch(username)

    @pytest.mark.parametrize("first,last,email", [
        ("maria.co", "", "maria@example.com"),
        ("", "", "maria.co@example.com"),
        ("www", "evil.com", "x@example.com"),
        ("http://evil", "", "x@example.com"),
        ("evil dot com", "", "x@example.com"),
        ("Ana", "punto com", "x@example.com"),
        ("Dot", "Com", "x@example.com"),
        ("", "", "www.evil.dev@example.com"),
    ])
    async def test_never_looks_like_a_link(self, db, first, last, email):
        username = await generate_username(db, first, last, email)
        assert PATTERN.fullmatch(username)
        assert not contains_url(username)
        assert validate_profile_fields({"username": username}).is_valid
        _reject_urls_in_profile_fields(username=username)  # does not raise

    async def test_taken_is_case_insensitive(self, db):
        await _add_user(db, "MariaPena111111", "otra@example.com")
        with patch(DRAW, side_effect=["111111", "222222"]) as draw:
            assert await generate_username(db, "María", "Peña", "maria@example.com") == "mariapena222222"
        assert draw.call_count == 2


# ------------------------------------------------------------------ the model


class TestModel:
    def test_username_is_optional_and_null_is_blank(self):
        base = {"email": "ana@example.com", "password": PASSWORD}
        assert UserCreate.model_validate(base).username == ""
        assert UserCreate.model_validate({**base, "username": None}).username == ""
        assert UserCreate.model_validate({**base, "username": "Ana_Admin"}).username == "Ana_Admin"


# ------------------------------------------------------------------ signup


class TestSignupWithoutUsername:
    async def test_gets_a_generated_username(self, mock_request, db, org, signup_env):
        created = await _signup(mock_request, db, org, first_name="María", last_name="Peña")
        assert _generated(created.username, "mariapena")
        (row,) = await _stored(db, "ana@example.com")
        assert row.username == created.username
        assert (row.first_name, row.last_name) == ("María", "Peña")
        assert row.bio == ""
        member = (await db.execute(select(UserOrganization).where(UserOrganization.user_id == row.id))).scalars().one()
        assert member.org_id == org.id

    @pytest.mark.parametrize("username", ["", "   ", None])
    async def test_blank_or_null_username_too(self, mock_request, db, org, signup_env, username):
        created = await _signup(mock_request, db, org, username=username, first_name="Ana", last_name="Pérez")
        assert _generated(created.username, "anaperez")

    async def test_empty_names_use_the_email(self, mock_request, db, org, signup_env):
        created = await _signup(mock_request, db, org, email="lucia.mamá@example.com")
        assert _generated(created.username, "luciamama")

    async def test_nothing_usable_is_mama(self, mock_request, db, org, signup_env):
        created = await _signup(mock_request, db, org, first_name="Li", email="li@example.com")
        assert _generated(created.username, "mama")

    async def test_same_name_twice_gets_two_usernames(self, mock_request, db, org, signup_env):
        first = await _signup(mock_request, db, org, first_name="Ana", last_name="Pérez", email="ana1@example.com")
        second = await _signup(mock_request, db, org, first_name="Ana", last_name="Pérez", email="ana2@example.com")
        assert _generated(first.username, "anaperez") and _generated(second.username, "anaperez")
        assert first.username != second.username

    async def test_a_drawn_number_already_taken_draws_again(self, mock_request, db, org, signup_env):
        with patch(DRAW, side_effect=["123456", "123456", "654321"]) as draw:
            first = await _signup(mock_request, db, org, first_name="Ana", last_name="Pérez", email="ana1@example.com")
            second = await _signup(mock_request, db, org, first_name="Ana", last_name="Pérez", email="ana2@example.com")
        assert (first.username, second.username) == ("anaperez123456", "anaperez654321")
        assert draw.call_count == 3

    async def test_no_free_number_refuses_without_storing(self, mock_request, db, org, signup_env):
        await _add_user(db, "mariapena111111", "otra@example.com")
        with patch(DRAW, return_value="111111") as draw:
            with pytest.raises(HTTPException) as exc:
                await _signup(mock_request, db, org, first_name="María", last_name="Peña")
        assert exc.value.status_code == 503
        assert draw.call_count == 1 + USERNAME_RETRIES
        assert await _stored(db, "ana@example.com") == []

    async def test_duplicate_email_is_still_refused(self, mock_request, db, org, signup_env):
        await _signup(mock_request, db, org, first_name="Ana")
        with pytest.raises(HTTPException) as exc:
            await _signup(mock_request, db, org, first_name="Ana", email="ANA@example.com")
        # Unchanged: the same generic answer for a taken email or username.
        assert exc.value.status_code == 400
        assert exc.value.detail == "Email or username is already in use"
        assert len(await _stored(db, "ana@example.com")) == 1

    async def test_a_url_in_the_name_is_still_refused(self, mock_request, db, org, signup_env):
        with pytest.raises(HTTPException) as exc:
            await _signup(mock_request, db, org, first_name="maria.co")
        assert exc.value.status_code == 400
        assert exc.value.detail["invalid_fields"] == ["first_name"]

    async def test_orgless_signup_too(self, mock_request, db, org, signup_env):
        created = await _signup(mock_request, db, org, without_org=True, first_name="María", last_name="Peña")
        assert _generated(created.username, "mariapena")
        with pytest.raises(HTTPException) as exc:
            await _signup(mock_request, db, org, without_org=True, first_name="María")
        assert (exc.value.status_code, exc.value.detail) == (400, "Email or username is already in use")

    async def test_invite_signup_too(self, mock_request, db, org, signup_env):
        user_object = UserCreate.model_validate({
            "email": "invitada@example.com", "password": PASSWORD, "first_name": "Inés", "last_name": "Núñez",
        })
        with patch("src.services.users.users.get_invite_code", new_callable=AsyncMock,
                   return_value={"invite_code": "CODE"}):
            created = await create_user_with_invite(mock_request, db, AnonymousUser(), user_object, org.id, "CODE")
        assert _generated(created.username, "inesnunez")


class TestSignupWithUsername:
    async def test_a_sent_username_is_kept_as_is(self, mock_request, db, org, signup_env):
        with patch(DRAW) as draw:
            created = await _signup(mock_request, db, org, username="Ana_Admin", first_name="Ana")
            solo = await _signup(mock_request, db, org, without_org=True, username="solo.user",
                                 email="solo@example.com")
        assert (created.username, solo.username) == ("Ana_Admin", "solo.user")
        draw.assert_not_called()

    async def test_a_taken_sent_username_still_conflicts(self, mock_request, db, org, signup_env):
        await _add_user(db, "ana_admin", "otra@example.com")
        with pytest.raises(HTTPException) as exc:
            await _signup(mock_request, db, org, username="ana_admin")
        assert (exc.value.status_code, exc.value.detail) == (400, "Email or username is already in use")


# ------------------------------------------------------------------ the routes


class TestSignupRoutes:
    """The bodies the web gateway (app/api/signup/route.ts) now sends."""

    @pytest.fixture
    async def client(self, db, org, signup_env):
        app = FastAPI()
        app.include_router(users_router, prefix="/api/v1/users")
        app.dependency_overrides[get_db_session] = lambda: db
        app.dependency_overrides[get_current_user] = lambda: AnonymousUser()
        with patch("src.routers.users.check_signup_rate_limit", return_value=(True, 0)), \
                patch("src.routers.users.check_invite_acceptance_rate_limit", return_value=(True, 0)), \
                patch("src.routers.users._enforce_password_signup_allowed", new_callable=AsyncMock):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
                yield c

    @staticmethod
    def _body(**extra):
        return {"email": "maria@example.com", "password": PASSWORD, "first_name": "María", "last_name": "Peña",
                **extra}

    async def test_org_signup_without_username(self, client, db):
        with patch("src.routers.users.get_org_join_mechanism", new_callable=AsyncMock, return_value="open"):
            response = await client.post("/api/v1/users/1", json=self._body())
        assert response.status_code == 200, response.text
        body = response.json()
        assert _generated(body["username"], "mariapena")
        assert (body["first_name"], body["last_name"], body["bio"]) == ("María", "Peña", "")
        (row,) = await _stored(db, "maria@example.com")
        assert row.username == body["username"]

    async def test_with_verification_the_mail_and_return_path_still_go(self, client, monkeypatch):
        monkeypatch.setenv("SC_EMAIL_VERIFICATION", "1")
        with patch("src.routers.users.get_org_join_mechanism", new_callable=AsyncMock, return_value="open"), \
                patch("src.services.users.email_verification.send_verification_email",
                      new_callable=AsyncMock) as send:
            response = await client.post("/api/v1/users/1", json=self._body(return_path=GIFT))
        assert response.status_code == 200, response.text
        assert response.json()["email_verified"] is False
        sent_user = send.await_args.args[2]
        assert sent_user.username == response.json()["username"]
        assert _generated(sent_user.username, "mariapena")
        assert send.await_args.kwargs["return_path"] == GIFT

    async def test_orgless_signup_without_username(self, client):
        response = await client.post("/api/v1/users/", json=self._body())
        assert response.status_code == 200, response.text
        assert _generated(response.json()["username"], "mariapena")

    async def test_invite_signup_without_username(self, client):
        with patch("src.routers.users.get_org_join_mechanism", new_callable=AsyncMock, return_value="inviteOnly"), \
                patch("src.services.users.users.get_invite_code", new_callable=AsyncMock,
                      return_value={"invite_code": "CODE"}):
            response = await client.post("/api/v1/users/1/invite/CODE", json=self._body())
        assert response.status_code == 200, response.text
        assert _generated(response.json()["username"], "mariapena")

    async def test_duplicate_email_is_still_refused(self, client):
        with patch("src.routers.users.get_org_join_mechanism", new_callable=AsyncMock, return_value="open"):
            first = await client.post("/api/v1/users/1", json=self._body())
            again = await client.post("/api/v1/users/1", json=self._body(email="Maria@example.com"))
        assert first.status_code == 200
        assert again.status_code == 400
        assert again.json()["detail"] == "Email or username is already in use"

"""Sanar y Criar: the signed-in user's own sign-up (``POST /subscribe/me``, the platform's gift page)."""

import pytest
from sqlmodel import select

from src.db.newsletter.newsletter import NewsletterSubscriber
from src.db.users import APITokenUser, SuperadminAPITokenUser, User
from src.services.newsletter import resend_sync
from src.tests.newsletter.conftest import BASE, HIDDEN_LINK_NAMES, subscribe

ME = f"{BASE}/subscribe/me"
GIFT_BODY = {"source": "test", "page": "/regalo"}


async def _rows(db):
    return (await db.execute(select(NewsletterSubscriber))).scalars().all()


async def _account(db, user, *, verified=True, **fields):
    """Set the account row (what the route trusts) and return the session user."""
    row = (await db.execute(select(User).where(User.id == user.id))).scalars().first()
    row.email_verified = verified
    for name, value in fields.items():
        setattr(row, name, value)
    db.add(row)
    await db.commit()
    return user


async def _post(client, body=GIFT_BODY):
    response = await client.post(ME, json=body)
    await resend_sync.wait_for_background()
    return response


class TestAccess:
    async def test_anonymous_is_401(self, client, db, org):
        response = await _post(client)
        assert response.status_code == 401
        assert response.json()["detail"] == "Authentication required"
        assert await _rows(db) == []

    @pytest.mark.parametrize("token", [
        APITokenUser(id=1, user_uuid="apitoken_x", username="token", org_id=1, rights={}, token_name="t",
                     created_by_user_id=1),
        SuperadminAPITokenUser(id=1, user_uuid="satoken_x", token_name="t", created_by_user_id=1),
    ])
    async def test_api_tokens_are_403(self, client, current, db, org, token):
        current.set(token)
        response = await _post(client)
        assert response.status_code == 403
        assert response.json()["detail"] == "API tokens cannot subscribe to the newsletter"
        assert await _rows(db) == []

    async def test_unverified_address_is_403(self, client, current, db, regular_user):
        current.set(await _account(db, regular_user, verified=False))
        response = await _post(client)
        assert response.status_code == 403
        assert response.json() == {"detail": "verify_email"}
        assert await _rows(db) == []

    async def test_session_flag_is_not_trusted(self, client, current, db, regular_user):
        # The session object says verified; the row says otherwise.
        await _account(db, regular_user, verified=False)
        stale = regular_user.model_copy()
        object.__setattr__(stale, "email_verified", True)
        current.set(stale)
        assert (await _post(client)).status_code == 403

    async def test_unknown_org_is_404(self, client, current, db, regular_user):
        current.set(await _account(db, regular_user))
        response = await client.post("/api/v1/newsletter/999/subscribe/me", json=GIFT_BODY)
        assert response.status_code == 404

    async def test_wrong_types_are_422(self, client, current, db, regular_user):
        current.set(await _account(db, regular_user))
        assert (await _post(client, {"source": ["test"]})).status_code == 422


class TestSubscribeMe:
    async def test_verified_user_is_subscribed_with_the_account(self, client, current, db, regular_user):
        current.set(await _account(db, regular_user, email="Regular@Test.com", first_name="  Regular\n Ana "))
        response = await _post(client, {"source": "test", "page": "/regalo?resultado=limites"})
        assert response.status_code == 200
        assert response.json() == {"ok": True}
        rows = await _rows(db)
        assert [(r.email, r.name, r.source, r.page_path, r.org_id) for r in rows] == [
            ("regular@test.com", "Regular Ana", "test", "/regalo", 1),
        ]
        assert rows[0].sync_status == "skipped"

    async def test_body_cannot_choose_the_address_or_the_name(self, client, current, db, regular_user):
        current.set(await _account(db, regular_user))
        response = await _post(client, {**GIFT_BODY, "email": "otra@example.com", "name": "Otra"})
        assert response.status_code == 200
        assert [(r.email, r.name) for r in await _rows(db)] == [("regular@test.com", "Regular")]

    @pytest.mark.parametrize("body,source,page", [
        ({"source": "guia-gratis", "page": "/regalo"}, "guia-gratis", "/regalo"),
        ({"source": "ventana-web"}, "ventana-web", None),
        ({"source": "inventado", "page": "javascript:alert(1)"}, "other", None),
        ({}, "other", None),
    ])
    async def test_source_and_page_follow_the_public_rules(self, client, current, db, regular_user,
                                                           body, source, page):
        current.set(await _account(db, regular_user))
        assert (await _post(client, body)).status_code == 200
        row = (await _rows(db))[0]
        assert (row.source, row.page_path) == (source, page)

    async def test_long_or_blank_first_name(self, client, current, db, regular_user, admin_user):
        current.set(await _account(db, regular_user, first_name="ñ" * 120))
        await _post(client)
        current.set(await _account(db, admin_user, first_name="   "))
        await _post(client)
        names = {r.email: r.name for r in await _rows(db)}
        assert names == {"regular@test.com": "ñ" * 80, "admin@test.com": None}

    async def test_first_name_is_cleaned_like_the_public_one(self, client, current, db, regular_user, admin_user):
        # Invisible characters are dropped; a name that looks like a link, whole.
        current.set(await _account(db, regular_user, first_name="Re\u200bgular\u202e"))
        assert (await _post(client)).status_code == 200
        current.set(await _account(db, admin_user, first_name="www.example"))
        assert (await _post(client)).status_code == 200
        names = {r.email: r.name for r in await _rows(db)}
        assert names == {"regular@test.com": "Regular", "admin@test.com": None}

    @pytest.mark.parametrize("first_name", HIDDEN_LINK_NAMES)
    async def test_first_name_that_carries_a_link_is_dropped(self, client, current, db, regular_user,
                                                             resend_on, first_name):
        # The account's own first name gets the public check: the same 200,
        # the address is subscribed, the name reaches neither the row nor Resend.
        current.set(await _account(db, regular_user, first_name=first_name))
        response = await _post(client)
        assert response.status_code == 200 and response.content == b'{"ok":true}'
        assert [(r.email, r.name) for r in await _rows(db)] == [("regular@test.com", None)]
        assert resend_on.calls == [("create", "re_test", "regular@test.com", None, None)]

    @pytest.mark.parametrize("first_name", ["J.R.R.", "Mª José", "Ana \U0001f469\u200d\U0001f467"])
    async def test_ordinary_first_name_reaches_resend_as_typed(self, client, current, db, regular_user,
                                                               resend_on, first_name):
        current.set(await _account(db, regular_user, first_name=first_name))
        assert (await _post(client)).status_code == 200
        assert resend_on.calls == [("create", "re_test", "regular@test.com", None, first_name)]

    async def test_known_address_gains_the_name_and_keeps_its_origin(self, client, current, db, regular_user):
        await subscribe(client, "regular@test.com", source="footer", page="/cursos")
        current.set(await _account(db, regular_user))
        first = await _post(client)
        again = await _post(client)
        assert first.content == again.content == b'{"ok":true}'
        assert (await db.execute(select(
            NewsletterSubscriber.name, NewsletterSubscriber.source, NewsletterSubscriber.page_path,
        ))).all() == [("Regular", "footer", "/cursos")]

    async def test_stored_name_is_never_overwritten(self, client, current, db, regular_user):
        await subscribe(client, "regular@test.com", name="Mamá de Leo")
        current.set(await _account(db, regular_user))
        await _post(client)
        assert (await db.execute(select(NewsletterSubscriber.name))).scalars().all() == ["Mamá de Leo"]

    async def test_resend_gets_the_account_first_name(self, client, current, db, regular_user, resend_on):
        current.set(await _account(db, regular_user))
        assert (await _post(client)).status_code == 200
        assert resend_on.calls == [("create", "re_test", "regular@test.com", None, "Regular")]
        row = (await _rows(db))[0]
        assert row.sync_status == "synced" and row.resend_contact_id == "contact-1"

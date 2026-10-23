"""Fixtures for the Sanar y Criar payments and progress tests.

A FastAPI app with the payments and progress routers, an in-memory SQLite
database (root conftest), a switchable current user, and a FakePayPal served
through httpx.MockTransport. Emails, outgoing webhooks and analytics are
stubbed.
"""

from datetime import datetime
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient

from src.core.events.database import get_db_session
from src.db.courses.activities import Activity, ActivitySubTypeEnum, ActivityTypeEnum
from src.db.courses.chapter_activities import ChapterActivity
from src.db.organization_config import OrganizationConfig
from src.db.user_organizations import UserOrganization
from src.db.users import AnonymousUser, PublicUser, User
from src.routers.payments import router as payments_router
from src.routers.progress import router as progress_router
from src.security.api_token_utils import get_authenticated_non_api_token_user
from src.security.auth import get_current_user
from src.services.payments.providers.paypal import PayPalProvider
from src.services.payments.providers.registry import register_provider, reset_providers
from src.tests.payments.fake_paypal import FakePayPal

ORG_ID = 1
REDIRECT = "http://localhost:3200/store/offers/x"


class CurrentUser:
    """Mutable holder so a test can switch who is calling."""

    def __init__(self):
        self.user = AnonymousUser()

    def set(self, user):
        self.user = user if user is not None else AnonymousUser()


@pytest.fixture
def current():
    return CurrentUser()


@pytest.fixture(autouse=True)
def _stub_side_effects():
    with patch("src.services.email.utils.send_email") as send_email, \
            patch("src.services.webhooks.dispatch.dispatch_webhooks", new_callable=AsyncMock), \
            patch("src.services.trail.trail.dispatch_webhooks", new_callable=AsyncMock), \
            patch("src.services.trail.trail.track", new_callable=AsyncMock), \
            patch("src.services.trail.trail.record_audit_event", new_callable=AsyncMock):
        yield send_email


@pytest.fixture(autouse=True)
def _production_store():
    """Store checks behave as on a production instance (development mode off)
    unless a test patches it; the configs below are 'live'."""
    with patch("src.services.payments.configs.is_development_mode", return_value=False):
        yield


@pytest.fixture
def sent_emails(_stub_side_effects):
    return _stub_side_effects


@pytest.fixture
def fake_paypal():
    fake = FakePayPal()
    register_provider(PayPalProvider(transport=fake.transport()))
    yield fake
    reset_providers()


@pytest.fixture
async def org_config(db, org):
    cfg = OrganizationConfig(
        org_id=org.id,
        config={"config_version": "2.0", "plan": "free", "admin_toggles": {}},
        creation_date=str(datetime.now()),
        update_date=str(datetime.now()),
    )
    db.add(cfg)
    await db.commit()
    return cfg


async def _make_user(db, org, role_id, *, user_id, username, member=True) -> PublicUser:
    u = User(
        id=user_id,
        username=username,
        first_name=username.capitalize(),
        last_name="Test",
        email=f"{username}@test.com",
        password="hashed_password",
        user_uuid=f"user_{username}",
        creation_date=str(datetime.now()),
        update_date=str(datetime.now()),
    )
    db.add(u)
    await db.commit()
    if member:
        db.add(UserOrganization(
            user_id=u.id, org_id=org.id, role_id=role_id,
            creation_date=str(datetime.now()), update_date=str(datetime.now()),
        ))
        await db.commit()
    return PublicUser(
        id=u.id, username=u.username, first_name=u.first_name, last_name=u.last_name,
        email=u.email, user_uuid=u.user_uuid,
    )


@pytest.fixture
async def outsider(db, org, user_role):
    """A signed-up user who is not yet a member of the org (a fresh buyer)."""
    return await _make_user(db, org, user_role.id, user_id=7, username="outsider", member=False)


@pytest.fixture
async def author_user(db, org, user_role, course):
    from src.db.resource_authors import (
        ResourceAuthor,
        ResourceAuthorshipEnum,
        ResourceAuthorshipStatusEnum,
    )

    user = await _make_user(db, org, user_role.id, user_id=5, username="author")
    db.add(ResourceAuthor(
        resource_uuid=course.course_uuid,
        user_id=user.id,
        authorship=ResourceAuthorshipEnum.CONTRIBUTOR,
        authorship_status=ResourceAuthorshipStatusEnum.ACTIVE,
        creation_date=str(datetime.now()),
        update_date=str(datetime.now()),
    ))
    await db.commit()
    return user


@pytest.fixture
async def video_activity(db, org, course, chapter):
    a = Activity(
        id=2,
        name="Video Activity",
        activity_type=ActivityTypeEnum.TYPE_VIDEO,
        activity_sub_type=ActivitySubTypeEnum.SUBTYPE_VIDEO_HOSTED,
        content={"filename": "clip.mp4"},
        published=True,
        org_id=org.id,
        course_id=course.id,
        activity_uuid="activity_video",
        creation_date=str(datetime.now()),
        update_date=str(datetime.now()),
    )
    db.add(a)
    await db.commit()
    await db.refresh(a)
    db.add(ChapterActivity(
        order=2, chapter_id=chapter.id, activity_id=a.id, course_id=course.id, org_id=org.id,
        creation_date=str(datetime.now()), update_date=str(datetime.now()),
    ))
    await db.commit()
    return a


@pytest.fixture
def app(db, current):
    app = FastAPI()
    app.include_router(payments_router, prefix="/api/v1/payments")
    app.include_router(progress_router, prefix="/api/v1/progress")

    async def _current_user():
        return current.user

    async def _authenticated_user():
        if isinstance(current.user, AnonymousUser):
            raise HTTPException(status_code=401, detail="Authentication required")
        return current.user

    app.dependency_overrides[get_db_session] = lambda: db
    app.dependency_overrides[get_current_user] = _current_user
    app.dependency_overrides[get_authenticated_non_api_token_user] = _authenticated_user
    yield app
    app.dependency_overrides.clear()


@pytest.fixture
async def client(app):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
async def paypal_config(client, current, admin_user, org_config, fake_paypal):
    """An active PayPal configuration created through the API."""
    current.set(admin_user)
    response = await client.post(
        f"/api/v1/payments/{ORG_ID}/config?provider=paypal",
        json={
            "provider": "paypal", "enabled": True, "client_id": "client-abc",
            "client_secret": "super-secret-value", "environment": "live",
            "webhook_id": "WH-TEST",
        },
    )
    assert response.status_code == 200, response.text
    current.set(None)
    return response.json()


@pytest.fixture
async def offer(client, current, admin_user, course, activity, paypal_config):
    """A 25.00 USD offer covering the test course."""
    current.set(admin_user)
    response = await client.post(
        f"/api/v1/payments/{ORG_ID}/offers",
        json={
            "name": "Curso completo", "description": "Todo el curso", "offer_type": "one_time",
            "price_type": "fixed_price", "amount": 25, "currency": "USD", "benefits": "a, b",
            "resource_uuids": [course.course_uuid],
        },
    )
    assert response.status_code == 200, response.text
    current.set(None)
    return response.json()


async def start_checkout(client, current, user, offer, method="paypal"):
    current.set(user)
    response = await client.post(
        f"/api/v1/payments/{ORG_ID}/offers/{offer['offer_uuid']}/checkout",
        params={"redirect_uri": REDIRECT, "provider": "paypal", "method": method},
    )
    return response

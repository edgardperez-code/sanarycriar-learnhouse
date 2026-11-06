"""Fixtures for the Sanar y Criar newsletter tests.

A FastAPI app with the newsletter router, the in-memory SQLite database of the
root conftest and a switchable current user. Resend is off by default
(``resend_off``); ``resend_on`` swaps the blocking SDK wrappers for fakes
that record their calls and lends the test session to the background sync.
"""

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from src.core.events.database import get_db_session
from src.db.users import AnonymousUser
from src.routers.newsletter import router as newsletter_router
from src.security.auth import get_current_user
from src.services.newsletter import resend_sync
from src.services.newsletter.resend_sync import ResendSettings

ORG_ID = 1
BASE = f"/api/v1/newsletter/{ORG_ID}"


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
def resend_off(monkeypatch):
    monkeypatch.setattr(resend_sync, "resend_settings", lambda: None)


class FakeResend:
    """Records the wrapper calls; set ``create_error`` / ``get_result`` ... to steer it."""

    def __init__(self):
        self.calls: list[tuple] = []
        self.settings = ResendSettings(api_key="re_test", segment_id=None)
        self.create_error: Exception | None = None
        self.get_result: str | None = None
        self.get_error: Exception | None = None
        self.segment_error: Exception | None = None
        self.remove_error: Exception | None = None
        self._next = 0

    def create_contact(self, api_key, email, segment_id, first_name=None):
        self.calls.append(("create", api_key, email, segment_id, first_name))
        if self.create_error is not None:
            raise self.create_error
        self._next += 1
        return f"contact-{self._next}"

    def get_contact_id(self, api_key, email):
        self.calls.append(("get", api_key, email))
        if self.get_error is not None:
            raise self.get_error
        return self.get_result

    def add_to_segment(self, api_key, email, segment_id):
        self.calls.append(("segment", api_key, email, segment_id))
        if self.segment_error is not None:
            raise self.segment_error

    def remove_contact(self, api_key, contact_id):
        self.calls.append(("remove", api_key, contact_id))
        if self.remove_error is not None:
            raise self.remove_error

    def names(self) -> list[str]:
        return [call[0] for call in self.calls]


class _BorrowedSession:
    """The test's own session as the background sync's "own" session (not closed)."""

    def __init__(self, session):
        self.session = session

    async def __aenter__(self):
        return self.session

    async def __aexit__(self, *exc):
        return False


@pytest.fixture
def resend_on(monkeypatch, db):
    fake = FakeResend()
    monkeypatch.setattr(resend_sync, "resend_settings", lambda: fake.settings)
    monkeypatch.setattr(resend_sync, "_session_scope", lambda: _BorrowedSession(db))
    monkeypatch.setattr(resend_sync, "_create_contact", fake.create_contact)
    monkeypatch.setattr(resend_sync, "_get_contact_id", fake.get_contact_id)
    monkeypatch.setattr(resend_sync, "_add_to_segment", fake.add_to_segment)
    monkeypatch.setattr(resend_sync, "_remove_contact", fake.remove_contact)
    return fake


@pytest.fixture
def app(db, current):
    app = FastAPI()
    app.include_router(newsletter_router, prefix="/api/v1/newsletter")

    async def _current_user():
        return current.user

    app.dependency_overrides[get_db_session] = lambda: db
    app.dependency_overrides[get_current_user] = _current_user
    yield app
    app.dependency_overrides.clear()


@pytest.fixture
async def client(app):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def subscribe(client, email, **extra):
    """POST a sign-up, then let the Resend sync it scheduled finish."""
    payload = {"email": email, "website": "", "source": "popup", "page": "/"}
    payload.update(extra)
    response = await client.post(f"{BASE}/subscribe", json=payload)
    await resend_sync.wait_for_background()
    return response


# First names that carry a link the first version of the check let through
# (verification F9). Each family also comes bare, without the ":" or the "/x"
# that would give it away on their own.
HIDDEN_LINK_NAMES = [
    # Domains whose TLD contains_url does not list.
    pytest.param("Ana, tu pago fallo: entra a pago-sanarycriar.lat", id="lat"),
    pytest.param("Ana, tu pago fallo: entra a pago-sanarycriar.mx", id="mx"),
    pytest.param("Ana, tu pago fallo: entra a pago-sanarycriar.ve", id="ve"),
    pytest.param("Ana, tu pago fallo: entra a pago-sanarycriar.page", id="page"),
    pytest.param("Ana entra a pago-sanarycriar.lat", id="lat-bare"),
    pytest.param("Ana entra a pago-sanarycriar.mx", id="mx-bare"),
    pytest.param("Ana entra a pago-sanarycriar.ve", id="ve-bare"),
    pytest.param("Ana entra a pago-sanarycriar.page", id="page-bare"),
    # Full stops IDNA reads as dots: fullwidth, ideographic, halfwidth ideographic.
    pytest.param("pago-sanarycriar\uff0ecom/x", id="fullwidth-stop"),
    pytest.param("pago-sanarycriar\u3002com/x", id="ideographic-stop"),
    pytest.param("pago-sanarycriar\uff61com/x", id="halfwidth-ideographic-stop"),
    pytest.param("pago-sanarycriar\uff0elat", id="fullwidth-stop-bare"),
    pytest.param("pago-sanarycriar\u3002lat", id="ideographic-stop-bare"),
    pytest.param("pago-sanarycriar\uff61lat", id="halfwidth-ideographic-stop-bare"),
    # Invisible default-ignorable marks (category Mn) right after the dot.
    pytest.param("pago-sanarycriar.\ufe0fcom/x", id="vs16"),
    pytest.param("pago-sanarycriar.\u034fcom/x", id="cgj"),
    pytest.param("pago-sanarycriar.\u034flat", id="cgj-bare"),
    pytest.param("pago-sanarycriar.\ufe00lat", id="vs1-bare"),
    pytest.param("pago-sanarycriar.\ufe0flat", id="vs16-bare"),
    pytest.param("pago-sanarycriar.\u180blat", id="mongolian-fvs1-bare"),
    pytest.param("pago-sanarycriar.\u180dlat", id="mongolian-fvs3-bare"),
    pytest.param("pago-sanarycriar.\U000e0100lat", id="vs17-bare"),
    pytest.param("pago-sanarycriar.\U000e01eflat", id="vs256-bare"),
]

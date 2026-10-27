"""Fixtures for the Sanar y Criar blog tests.

A FastAPI app with the blog router, the in-memory SQLite database of the root
conftest and a switchable current user. Always on (autouse):
- the AI environment is cleared (``docker compose run`` injects
  ``SC_BLOG_AI_MOCK=1`` from the compose file: each test decides) and the
  mock answers at once;
- the Anthropic client fails loudly if anything reaches it by accident;
- cover files go to an in-memory store;
- background AI jobs borrow the test's session.
Optional: ``mock_ai`` (fixed mock article), ``fake_claude`` (a scripted
stand-in for the SDK that records the request), ``limiter`` (counting rate
limiter instead of Redis).
"""

import json
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from src.core.events.database import get_db_session
from src.db.users import AnonymousUser
from src.routers.blog import router as blog_router
from src.security.auth import get_current_user
from src.services.blog import ai, covers, jobs

ORG_ID = 1
BASE = f"/api/v1/blog/{ORG_ID}"

LONG_MD = (
    "## Primera sección\n\n"
    + "Este es un párrafo de prueba con suficientes palabras para superar el mínimo de publicación. " * 4
    + "\n\n## Segunda sección\n\nMás texto de prueba para el artículo."
)


def post_body(**overrides) -> dict:
    """A complete, valid ``PostBody`` (the dashboard always sends every field)."""
    body = {
        "title": "Artículo de prueba (borrar)",
        "slug": "",
        "kind": "informativo",
        "category": "emociones",
        "excerpt": "Extracto de prueba.",
        "summary": "Resumen de prueba.",
        "key_takeaways": ["Idea uno", "Idea dos"],
        "content_md": LONG_MD,
        "faq": [{"question": "¿Pregunta?", "answer": "Respuesta."}],
        "meta_title": "",
        "meta_description": "",
        "keywords": ["prueba"],
        "cover_alt": "",
    }
    body.update(overrides)
    return body


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
def ai_env(monkeypatch):
    monkeypatch.delenv("SC_BLOG_AI_MOCK", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("SC_BLOG_AI_MODEL", raising=False)
    monkeypatch.setenv("SC_BLOG_AI_MOCK_DELAY", "0")


@pytest.fixture(autouse=True)
def no_real_claude(monkeypatch):
    def _forbidden():
        raise AssertionError("The Anthropic client must not be used in this test")

    monkeypatch.setattr(ai, "_get_client", _forbidden)


class FakeStorage:
    """In-memory replacement for the cover file store."""

    def __init__(self):
        self.files: dict[str, bytes] = {}
        self.removed: list[str] = []
        self.removed_dirs: list[str] = []

    async def store(self, org_uuid, post_uuid, filename, data):
        self.files[f"{org_uuid}/{post_uuid}/{filename}"] = data

    async def remove(self, org_uuid, post_uuid, filename):
        key = f"{org_uuid}/{post_uuid}/{filename}"
        self.removed.append(key)
        self.files.pop(key, None)

    async def remove_dir(self, org_uuid, post_uuid):
        self.removed_dirs.append(f"{org_uuid}/{post_uuid}")

    def names(self) -> list[str]:
        return sorted(key.rsplit("/", 1)[1] for key in self.files)


@pytest.fixture(autouse=True)
def storage(monkeypatch):
    fake = FakeStorage()
    monkeypatch.setattr(covers, "_store", fake.store)
    monkeypatch.setattr(covers, "_remove_file", fake.remove)
    monkeypatch.setattr(covers, "remove_post_files", fake.remove_dir)
    return fake


class _BorrowedSession:
    """The test's own session as the background job's "own" session (not closed)."""

    def __init__(self, session):
        self.session = session

    async def __aenter__(self):
        return self.session

    async def __aexit__(self, *exc):
        return False


@pytest.fixture(autouse=True)
def borrowed_job_session(monkeypatch, db):
    monkeypatch.setattr(jobs, "_session_scope", lambda: _BorrowedSession(db))


@pytest.fixture
def mock_ai(monkeypatch):
    monkeypatch.setenv("SC_BLOG_AI_MOCK", "1")


def article_json(**overrides) -> str:
    """A model answer (``GeneratedArticle`` as JSON) for the fake client."""
    article = {
        "category": "emociones",
        "title": "Cómo acompañar el miedo a la oscuridad",
        "slug": "miedo-a-la-oscuridad",
        "meta_title": "Miedo a la oscuridad en niños",
        "meta_description": "Qué hacer cuando tu hijo tiene miedo a la oscuridad.",
        "excerpt": "Ideas para acompañar el miedo a la oscuridad.",
        "summary": "Un resumen breve del artículo.",
        "key_takeaways": ["Validar el miedo", "Crear rutinas"],
        "content_md": "## ¿Por qué aparece?\n\n" + "Texto del artículo con varias palabras. " * 10 + "\n\n[agenda](/agenda)",
        "faq": [{"question": "¿Es normal?", "answer": "Sí, es frecuente en la infancia."}],
        "keywords": ["miedo", "oscuridad"],
    }
    article.update(overrides)
    return json.dumps(article, ensure_ascii=False)


class _FakeStream:
    def __init__(self, owner):
        self.owner = owner

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get_final_message(self):
        if self.owner.error is not None:
            raise self.owner.error
        return SimpleNamespace(
            stop_reason=self.owner.stop_reason,
            content=[SimpleNamespace(type="thinking", thinking=""), SimpleNamespace(type="text", text=self.owner.text)],
            model=self.owner.model,
            usage=SimpleNamespace(
                input_tokens=1200, output_tokens=900, cache_read_input_tokens=1000, cache_creation_input_tokens=0
            ),
        )


class FakeClaude:
    """Scripted ``AsyncAnthropic``: set ``text`` / ``stop_reason`` / ``error``; ``calls`` keeps the kwargs."""

    def __init__(self):
        self.calls: list[dict] = []
        self.text = article_json()
        self.stop_reason = "end_turn"
        self.model = "claude-opus-5-5"
        self.error: Exception | None = None
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=self._stream))

    def _stream(self, **kwargs):
        self.calls.append(kwargs)
        return _FakeStream(self)


@pytest.fixture
def fake_claude(monkeypatch):
    fake = FakeClaude()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    monkeypatch.setattr(ai, "_get_client", lambda: fake)
    return fake


@pytest.fixture
def limiter(monkeypatch):
    """A counting ``check_rate_limit`` in place of Redis; rate limits switched on."""
    monkeypatch.setenv("TESTING", "false")
    counts: dict[str, int] = {}

    def fake_check_rate_limit(key, max_attempts, window_seconds, r=None):
        counts[key] = counts.get(key, 0) + 1
        return counts[key] <= max_attempts, counts[key], window_seconds

    monkeypatch.setattr("src.services.security.rate_limiting.check_rate_limit", fake_check_rate_limit)
    return counts


@pytest.fixture
def app(db, current):
    app = FastAPI()
    app.include_router(blog_router, prefix="/api/v1/blog")

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


@pytest.fixture
async def admin_client(client, current, admin_user):
    """The client, signed in as the org admin."""
    current.set(admin_user)
    return client


async def create_post(client, **overrides) -> dict:
    response = await client.post(f"{BASE}/posts", json=post_body(**overrides))
    assert response.status_code == 201, response.text
    return response.json()


async def publish(client, post_id: int) -> dict:
    response = await client.post(f"{BASE}/posts/{post_id}/publish")
    assert response.status_code == 200, response.text
    return response.json()

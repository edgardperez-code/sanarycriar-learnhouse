"""Sanar y Criar: the startup helper that adds the newsletter columns create_all cannot,
and its background retry when the startup could not add one."""

import asyncio
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

import src.core.events.events as events
from src.services.newsletter import schema
from src.services.newsletter.schema import ensure_newsletter_schema

ALL_OK = {"sc_newsletter_subscriber.name": True}
MISSING = {"sc_newsletter_subscriber.name": False}

# The table as the first release created it (no ``name``).
OLD_TABLE = (
    "CREATE TABLE sc_newsletter_subscriber (id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, "
    "email VARCHAR(254) NOT NULL, source VARCHAR(16) NOT NULL)"
)


async def _columns(engine) -> list[str]:
    async with engine.connect() as conn:
        return [row[1] for row in (await conn.execute(text("PRAGMA table_info(sc_newsletter_subscriber)"))).all()]


class TestEnsureNewsletterSchema:
    async def test_adds_the_column_to_an_old_table_once(self):
        engine = create_async_engine("sqlite+aiosqlite://")
        try:
            async with engine.begin() as conn:
                await conn.execute(text(OLD_TABLE))
                await conn.execute(text(
                    "INSERT INTO sc_newsletter_subscriber (org_id, email, source) VALUES (1, 'ana@example.com', 'popup')"
                ))
            assert "name" not in await _columns(engine)
            assert await ensure_newsletter_schema(engine) == ALL_OK
            assert (await _columns(engine)).count("name") == 1
            # Idempotent: the next start finds it in place.
            assert await ensure_newsletter_schema(engine) == ALL_OK
            assert (await _columns(engine)).count("name") == 1
            async with engine.connect() as conn:
                rows = (await conn.execute(text("SELECT email, name FROM sc_newsletter_subscriber"))).all()
            assert [tuple(row) for row in rows] == [("ana@example.com", None)]
        finally:
            await engine.dispose()

    async def test_missing_table_is_left_to_create_all(self):
        engine = create_async_engine("sqlite+aiosqlite://")
        try:
            assert await ensure_newsletter_schema(engine) == ALL_OK
            assert await _columns(engine) == []
        finally:
            await engine.dispose()

    async def test_tables_built_by_create_all_already_have_it(self, engine):
        assert "name" in await _columns(engine)
        assert await ensure_newsletter_schema(engine) == ALL_OK

    async def test_default_is_the_app_engine(self, monkeypatch):
        # What ``start_app`` meets under TESTING: the app engine, without any
        # table. A fresh one: other tests reload the database module with fakes.
        import src.core.events.database as database

        app_engine = create_async_engine("sqlite+aiosqlite://")
        monkeypatch.setattr(database, "engine", app_engine)
        try:
            assert await ensure_newsletter_schema() == ALL_OK
            assert await _columns(app_engine) == []
        finally:
            await app_engine.dispose()

    async def test_never_raises(self, caplog):
        class Broken:
            def begin(self):
                raise RuntimeError("database is down")

        with caplog.at_level(logging.ERROR, logger="src.services.newsletter.schema"):
            assert await ensure_newsletter_schema(Broken()) == {"sc_newsletter_subscriber.name": False}
        assert any("sc_newsletter_subscriber.name" in r.getMessage() for r in caplog.records)


# ------------------------------------------------------------ background retry


def _fake_helper(monkeypatch, *answers):
    """``ensure_newsletter_schema`` answering ``answers`` in turn (the last one
    again once they run out; an exception is raised). Returns its calls."""
    calls = []

    async def fake(engine=None):
        answer = answers[min(len(calls), len(answers) - 1)]
        calls.append(engine)
        if isinstance(answer, Exception):
            raise answer
        return dict(answer)

    monkeypatch.setattr(schema, "ensure_newsletter_schema", fake)
    return calls


@pytest.fixture
def delays(monkeypatch):
    """``asyncio.sleep`` records what it was asked to wait and returns at once."""
    asked = []
    real_sleep = asyncio.sleep

    async def fake_sleep(seconds):
        asked.append(seconds)
        await real_sleep(0)

    monkeypatch.setattr(schema.asyncio, "sleep", fake_sleep)
    return asked


@pytest.fixture
async def retries(monkeypatch):
    """Retries are off under TESTING: switch it off, and leave no task behind."""
    monkeypatch.setenv("TESTING", "false")
    monkeypatch.setattr(schema, "_retry_task", None)
    yield
    await schema.stop_retry()


def _stub_other_startup_steps(monkeypatch):
    """Every step of ``start_app`` but the newsletter columns does nothing."""
    import src.services.ai.rag.queue as rag_queue
    import src.services.utils.caption_jobs as caption_jobs
    import src.services.utils.hls_jobs as hls_jobs

    monkeypatch.setattr(events, "get_learnhouse_config", lambda: SimpleNamespace())
    for name in ("connect_to_db", "create_logs_dir", "check_content_directory", "auto_install", "_reconcile_packs"):
        monkeypatch.setattr(events, name, AsyncMock())
    monkeypatch.setattr(events, "init_logging", Mock())
    monkeypatch.setattr(events, "run_ee_startup", Mock())
    monkeypatch.setattr(events, "_periodic_migration_cleanup", AsyncMock())
    monkeypatch.setattr(events, "_cleanup_task", None)
    monkeypatch.setattr("src.services.courses.migration.migration_service.cleanup_old_temp_migrations", Mock())
    monkeypatch.setattr("src.services.payments.schema.ensure_payments_indexes", AsyncMock(return_value={}))
    for module in (rag_queue, caption_jobs, hls_jobs):
        monkeypatch.setattr(module, "get_redis_client", lambda: None)
    monkeypatch.setenv("LEARNHOUSE_RAG_BACKFILL_HOURS", "0")
    monkeypatch.setenv("LEARNHOUSE_BACKFILL_INTERVAL_HOURS", "0")
    monkeypatch.setenv("LEARNHOUSE_PAYMENTS_RECONCILE", "0")


class TestStartupRetry:
    async def test_failed_startup_attempt_is_retried_until_it_works(self, monkeypatch, retries, delays, caplog):
        calls = _fake_helper(monkeypatch, MISSING, MISSING, ALL_OK)
        _stub_other_startup_steps(monkeypatch)

        with caplog.at_level(logging.INFO, logger="src.services.newsletter.schema"):
            await events.startup_app(SimpleNamespace())()
            # The startup attempt failed: the startup goes on, a retry is scheduled.
            assert len(calls) == 1
            task = schema._retry_task
            assert task is not None
            assert await task is True

        # Two retries, 30 s apart; the second one put the column in place.
        assert len(calls) == 3
        assert delays == [30, 30]
        assert "Newsletter columns in place after retry 2 of 10" in caplog.text

    async def test_startup_with_the_columns_in_place_schedules_nothing(self, monkeypatch, retries, delays):
        calls = _fake_helper(monkeypatch, ALL_OK)
        _stub_other_startup_steps(monkeypatch)
        await events.startup_app(SimpleNamespace())()
        assert len(calls) == 1
        assert schema._retry_task is None
        assert delays == []

    async def test_gives_up_after_ten_retries_without_raising(self, monkeypatch, retries, delays, caplog):
        calls = _fake_helper(monkeypatch, MISSING)
        with caplog.at_level(logging.ERROR, logger="src.services.newsletter.schema"):
            assert await schema._retry_until_in_place() is False
        assert len(calls) == 10
        assert delays == [30] * 10
        assert "Newsletter columns still missing after 10 retries" in caplog.text

    async def test_a_raising_helper_is_logged_and_retried(self, monkeypatch, retries, delays, caplog):
        calls = _fake_helper(monkeypatch, RuntimeError("database is down"), ALL_OK)
        with caplog.at_level(logging.ERROR, logger="src.services.newsletter.schema"):
            assert await schema._retry_until_in_place() is True
        assert len(calls) == 2
        assert "retry 1 of 10 failed" in caplog.text

    async def test_one_retry_at_a_time(self, monkeypatch, retries):
        # Real sleeps: the first retry is still waiting its 30 s.
        _fake_helper(monkeypatch, MISSING)
        schema.start_retry()
        first = schema._retry_task
        schema.start_retry()
        assert schema._retry_task is first and not first.done()

    async def test_no_retry_under_testing(self, monkeypatch, retries):
        monkeypatch.setenv("TESTING", "true")
        schema.start_retry()
        assert schema._retry_task is None

    async def test_stop_cancels_a_waiting_retry(self, monkeypatch, retries):
        calls = _fake_helper(monkeypatch, MISSING)
        schema.start_retry()
        task = schema._retry_task
        await asyncio.sleep(0)
        await schema.stop_retry()
        assert task.cancelled()
        assert schema._retry_task is None
        assert calls == []

    async def test_shutdown_stops_the_retry(self, monkeypatch):
        stop = AsyncMock()
        monkeypatch.setattr(schema, "stop_retry", stop)
        monkeypatch.setattr(events, "_cleanup_task", None)
        monkeypatch.setattr(events, "close_database", AsyncMock())
        monkeypatch.setattr("src.services.webhooks.dispatch.close_webhook_client", AsyncMock())
        await events.shutdown_app(SimpleNamespace())()
        stop.assert_awaited_once()

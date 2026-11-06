"""Sanar y Criar: newsletter columns that the startup ``create_all`` cannot add.

Production runs no Alembic: ``create_all`` creates missing tables (with every
column of their models) but never adds a column to a table that already
exists. Every query of the subscriber model names all of its columns, so a
missing one breaks the sign-up itself: ``ensure_newsletter_schema`` runs at
every startup, before any request, and adds them. The catalog is read first,
so a column already in place costs no lock; each addition runs in its own
transaction with a short lock timeout, and a failure is logged and skipped,
so the app always starts. Migration ``9a3f6c2e8b1d`` adds the same column.
A column the startup could not add (say, the table was busy for longer than
the lock timeout) is retried in the background by ``start_retry``: every 30 s,
at most 10 times, until it is in place.

- ``sc_newsletter_subscriber.name``: the subscriber's first name.
"""

import asyncio
import logging
import os
from typing import Optional

from sqlalchemy import text

logger = logging.getLogger(__name__)

SUBSCRIBER_TABLE = "sc_newsletter_subscriber"

COLUMNS = (
    (SUBSCRIBER_TABLE, "name", "VARCHAR(80)"),
)

RETRY_INTERVAL_SECONDS = 30
RETRY_ATTEMPTS = 10

_retry_task: Optional[asyncio.Task] = None


async def _column_names(conn, table: str) -> Optional[set[str]]:
    """Columns of ``table``, or None when the table does not exist."""
    if conn.dialect.name == "sqlite":
        rows = (await conn.execute(text(f"PRAGMA table_info({table})"))).all()
        return {row[1] for row in rows} if rows else None
    rows = (await conn.execute(
        text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = :table"
        ),
        {"table": table},
    )).all()
    return {row[0] for row in rows} if rows else None


async def ensure_newsletter_schema(engine=None) -> dict[str, bool]:
    """Add the columns above when missing. Returns {"table.column": ok}. Never raises."""
    if engine is None:
        from src.core.events.database import engine as app_engine

        engine = app_engine
    results: dict[str, bool] = {}
    for table, column, sql_type in COLUMNS:
        name = f"{table}.{column}"
        try:
            async with engine.begin() as conn:
                existing = await _column_names(conn, table)
                # No table yet: create_all (or the migration) builds it whole.
                if existing is not None and column not in existing:
                    if conn.dialect.name == "postgresql":
                        # A busy table never holds the startup for long.
                        await conn.execute(text("SET LOCAL lock_timeout = '5s'"))
                        await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {sql_type}"))
                    else:
                        await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {sql_type}"))
                    logger.info("Added column %s", name)
            results[name] = True
        except Exception as exc:
            logger.error("Could not add column %s (the app keeps running): %s", name, exc)
            results[name] = False
    return results


async def _retry_until_in_place() -> bool:
    """Run ``ensure_newsletter_schema`` again until every column is in place.

    Returns whether it got there. Never raises (cancellation aside).
    """
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        await asyncio.sleep(RETRY_INTERVAL_SECONDS)
        try:
            results = await ensure_newsletter_schema()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Newsletter columns: retry %s of %s failed", attempt, RETRY_ATTEMPTS)
            continue
        if all(results.values()):
            logger.info("Newsletter columns in place after retry %s of %s", attempt, RETRY_ATTEMPTS)
            return True
    logger.error(
        "Newsletter columns still missing after %s retries; the sign-up fails until the next start",
        RETRY_ATTEMPTS,
    )
    return False


def start_retry() -> None:
    """Retry the columns in the background (call when the startup run left one
    missing). Never raises; no-op in tests or while a retry is already running."""
    global _retry_task
    try:
        if os.getenv("TESTING", "false").lower() == "true":
            return
        if _retry_task is not None and not _retry_task.done():
            return
        _retry_task = asyncio.create_task(_retry_until_in_place())
        logger.warning(
            "Newsletter columns missing; retrying every %ss, at most %s times",
            RETRY_INTERVAL_SECONDS,
            RETRY_ATTEMPTS,
        )
    except Exception:
        logger.exception("Could not schedule the newsletter column retry")


async def stop_retry() -> None:
    """Cancel the retry if it is still running (application shutdown)."""
    global _retry_task
    task, _retry_task = _retry_task, None
    if task is None:
        return
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):
        pass

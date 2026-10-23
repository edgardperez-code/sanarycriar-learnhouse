"""Sanar y Criar: keep the ``activityprogress`` table in step with the model.

The app's startup ``create_all`` creates missing tables but never adds columns
to existing ones, and databases built that way carry no Alembic version, so
the migration (``7b5dee2850d6``) does not reach them. The progress service
calls :func:`ensure_progress_schema` before touching the table; after the
first success in a process it is a flag check.
"""

import logging

from sqlalchemy import text
from sqlmodel.ext.asyncio.session import AsyncSession

logger = logging.getLogger(__name__)

_TABLE = "activityprogress"
_COLUMN = "client_ts"

_ready = False


async def _has_column(conn) -> bool:
    if conn.dialect.name == "sqlite":
        rows = (await conn.execute(text(f"PRAGMA table_info({_TABLE})"))).all()
        # No table at all: nothing to patch (create_all will build it whole).
        return not rows or any(row[1] == _COLUMN for row in rows)
    row = (await conn.execute(
        text(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = :table AND column_name = :column"
        ),
        {"table": _TABLE, "column": _COLUMN},
    )).first()
    if row is not None:
        return True
    exists = (await conn.execute(
        text(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = current_schema() AND table_name = :table"
        ),
        {"table": _TABLE},
    )).first()
    return exists is None


async def ensure_progress_schema(db_session: AsyncSession) -> None:
    """Add ``activityprogress.client_ts`` when the table predates it.

    Idempotent and cheap: a catalog lookup once per process, an ``ALTER``
    only when the column is missing (with a short lock timeout, so a busy
    table never queues requests behind it). Never raises: on failure the
    caller's query reports the real problem and the next call tries again.
    """
    global _ready
    if _ready:
        return
    try:
        conn = await db_session.connection()
        if not await _has_column(conn):
            if conn.dialect.name == "postgresql":
                await conn.execute(text("SET LOCAL lock_timeout = '5s'"))
                await conn.execute(text(f"ALTER TABLE {_TABLE} ADD COLUMN IF NOT EXISTS {_COLUMN} BIGINT"))
            else:
                await conn.execute(text(f"ALTER TABLE {_TABLE} ADD COLUMN {_COLUMN} BIGINT"))
            logger.info("Added %s.%s", _TABLE, _COLUMN)
        await db_session.commit()
        _ready = True
    except Exception:
        logger.exception("Could not ensure %s.%s exists", _TABLE, _COLUMN)
        try:
            await db_session.rollback()
        except Exception:
            pass


def reset_progress_schema_flag() -> None:
    """For tests: forget that the schema was checked in this process."""
    global _ready
    _ready = False

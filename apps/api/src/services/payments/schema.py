"""Sanar y Criar: payment schema changes that the startup ``create_all`` cannot make.

Production runs no Alembic: ``create_all`` creates missing tables (with the
indexes declared on their models) but never changes a table that already
exists. ``ensure_payments_indexes`` runs at every startup and brings the
existing tables up to date, each change in its own transaction with a short
lock timeout; a failure (for instance rows that a unique index refuses, or a
table busy for longer than the timeout) is logged and skipped, so the app
always starts. Migrations ``4d7b1e9a2c6f`` and ``b6e2d9f4a1c8`` make the same
changes.

Columns (the catalog is read first, so a column already in shape costs no
lock; a change the startup could not make is retried on every payments
reconciliation tick, every 5 minutes, until it is in place):

- ``sc_pay_purchase.fx_rate``, ``fx_source``, ``amount_ves``: nullable, for
  the purchases paid in dollars (Zelle) or USDT (Binance), which have no
  exchange rate.
- ``sc_pay_purchase.bank_reference``: up to 100 characters (a USDT
  transaction hash is 64-66).

Indexes:

- ``uq_sc_pay_order_manual_pending``: at most one *pending* manual order
  (any method) per (buyer, offer), the database's own guard against two
  purchases of the same product racing past the per-buyer lock (several
  workers, no Redis).
- ``ix_sc_pay_purchase_status_expires``: the expiry sweep runs every 5 min.
"""

import logging
from typing import Optional

from sqlalchemy import text

logger = logging.getLogger(__name__)

PURCHASE_TABLE = "sc_pay_purchase"
MANUAL_PENDING_INDEX = "uq_sc_pay_order_manual_pending"
PURCHASE_EXPIRY_INDEX = "ix_sc_pay_purchase_status_expires"
REFERENCE_LENGTH = 100

# (column, what it needs): "nullable" drops NOT NULL; an int widens a VARCHAR.
COLUMNS = (
    ("fx_rate", "nullable"),
    ("fx_source", "nullable"),
    ("amount_ves", "nullable"),
    ("bank_reference", REFERENCE_LENGTH),
)

INDEXES = (
    (
        MANUAL_PENDING_INDEX,
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_sc_pay_order_manual_pending ON sc_pay_order (user_id, offer_id) "
        "WHERE provider = 'manual' AND status = 'pending'",
    ),
    (
        PURCHASE_EXPIRY_INDEX,
        "CREATE INDEX IF NOT EXISTS ix_sc_pay_purchase_status_expires ON sc_pay_purchase (status, expires_at)",
    ),
)

# Set once every column change is in place (per process): the retry stops.
_columns_in_place = False


def _engine(engine):
    if engine is None:
        from src.core.events.database import engine as app_engine

        return app_engine
    return engine


async def _purchase_columns(conn) -> Optional[dict[str, tuple[bool, Optional[int]]]]:
    """{column: (nullable, max length)} of sc_pay_purchase, or None without the table."""
    rows = (await conn.execute(
        text(
            "SELECT column_name, is_nullable, character_maximum_length FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = :table"
        ),
        {"table": PURCHASE_TABLE},
    )).all()
    if not rows:
        return None
    return {row[0]: (row[1] == "YES", row[2]) for row in rows}


def _ddl_for(column: str, need, current: tuple[bool, Optional[int]]) -> Optional[str]:
    nullable, length = current
    if need == "nullable":
        return None if nullable else f"ALTER TABLE {PURCHASE_TABLE} ALTER COLUMN {column} DROP NOT NULL"
    if length is not None and length < need:
        return f"ALTER TABLE {PURCHASE_TABLE} ALTER COLUMN {column} TYPE VARCHAR({need})"
    return None


async def ensure_payments_columns(engine=None) -> dict[str, bool]:
    """Make the column changes above when missing. Returns {"table.column": ok}.
    Never raises. Only PostgreSQL needs them: elsewhere (the tests' SQLite)
    ``create_all`` builds the tables from the models."""
    global _columns_in_place
    engine = _engine(engine)
    results: dict[str, bool] = {}
    for column, need in COLUMNS:
        name = f"{PURCHASE_TABLE}.{column}"
        try:
            async with engine.begin() as conn:
                if conn.dialect.name != "postgresql":
                    results[name] = True
                    continue
                existing = await _purchase_columns(conn)
                # No table yet: create_all (or the migration) builds it whole.
                ddl = _ddl_for(column, need, existing[column]) if existing and column in existing else None
                if ddl:
                    # A busy table never holds the startup for long.
                    await conn.execute(text("SET LOCAL lock_timeout = '5s'"))
                    await conn.execute(text(ddl))
                    logger.info("Payments column changed: %s", ddl)
            results[name] = True
        except Exception as exc:
            logger.error("Could not change column %s (the app keeps running): %s", name, exc)
            results[name] = False
    _columns_in_place = all(results.values())
    return results


def columns_in_place() -> bool:
    return _columns_in_place


async def retry_columns_if_needed() -> None:
    """The reconciliation tick calls this: a column change the startup could
    not make is tried again until it is in place. Never raises."""
    if _columns_in_place:
        return
    try:
        results = await ensure_payments_columns()
        if all(results.values()):
            logger.info("Payments columns in place after a retry")
    except Exception:
        logger.exception("Payments columns: retry failed")


async def ensure_payments_indexes(engine=None) -> dict[str, bool]:
    """Bring the payment tables up to date: the columns above (they log their
    own outcome), then the indexes. Returns {index name: ok}. Never raises."""
    engine = _engine(engine)
    await ensure_payments_columns(engine)
    results: dict[str, bool] = {}
    for name, ddl in INDEXES:
        try:
            async with engine.begin() as conn:
                if conn.dialect.name == "postgresql":
                    # A busy table never holds the startup for long.
                    await conn.execute(text("SET LOCAL lock_timeout = '5s'"))
                await conn.execute(text(ddl))
            results[name] = True
        except Exception as exc:
            logger.error("Could not create index %s (the app keeps running): %s", name, exc)
            results[name] = False
    if all(results.values()):
        logger.info("Payment indexes in place: %s", ", ".join(results))
    return results

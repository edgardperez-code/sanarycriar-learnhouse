"""Sanar y Criar: payment indexes that the startup ``create_all`` cannot add.

Production runs no Alembic: ``create_all`` creates missing tables (with the
indexes declared on their models) but never adds an index to a table that
already exists. ``ensure_payments_indexes`` runs at every startup and creates
them with ``IF NOT EXISTS``, each in its own transaction; a failure (for
instance rows that a unique index refuses) is logged and skipped, so the app
always starts. Migration ``4d7b1e9a2c6f`` creates the same indexes.

- ``uq_sc_pay_order_manual_pending``: at most one *pending* Pago Móvil order
  per (buyer, offer), the database's own guard against two purchases of the
  same product racing past the per-buyer lock (several workers, no Redis).
- ``ix_sc_pay_purchase_status_expires``: the expiry sweep runs every 5 min.
"""

import logging

from sqlalchemy import text

logger = logging.getLogger(__name__)

MANUAL_PENDING_INDEX = "uq_sc_pay_order_manual_pending"
PURCHASE_EXPIRY_INDEX = "ix_sc_pay_purchase_status_expires"

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


async def ensure_payments_indexes(engine=None) -> dict[str, bool]:
    """Create the indexes above when missing. Returns {name: ok}. Never raises."""
    if engine is None:
        from src.core.events.database import engine as app_engine

        engine = app_engine
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

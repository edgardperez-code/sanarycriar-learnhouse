"""Sanar y Criar: periodic reconciliation of open orders with the provider.

Backstop for lost webhooks and closed tabs: every 5 minutes, orders still
``created``/``approved`` from the last 24 h, and ``pending`` ones (a capture
under review at the provider, which can take days to clear) from the last
7 days, are looked up at the provider (APPROVED -> capture, COMPLETED ->
fulfill). Orders that never got past ``created``/``approved`` expire after
12 h. A Redis lock keeps several
API workers from doing the same pass at once; correctness does not depend on
it (capture is idempotent and fulfillment locks the order row).

Once a day, paid orders from the last 180 days are also checked against their
capture at the provider: a capture that was REFUNDED or REVERSED (chargeback)
revokes access even when its webhook never arrived or failed to process.
"""

import asyncio
import logging
from datetime import timedelta
from typing import Optional

from sqlalchemy import and_, or_
from sqlmodel import select

from src.db.payments.payments import PaymentsOrder
from src.services.payments.common import as_utc, utcnow
from src.services.payments.settings import reconcile_enabled

logger = logging.getLogger(__name__)

INTERVAL_SECONDS = 300
STARTUP_DELAY_SECONDS = 45
LOOKBACK = timedelta(hours=24)
# Sanar y Criar: a pending capture (e.g. PENDING_REVIEW, eCheck) may take
# several days to settle; keep asking so a lost COMPLETED webhook still grants
# access. Only ``pending`` orders get the longer window.
PENDING_LOOKBACK = timedelta(days=7)
EXPIRE_AFTER = timedelta(hours=12)
_LOCK_KEY = "sc_pay:reconcile:lock"
_LOCK_TTL_SECONDS = 240
REFUND_CHECK_LOOKBACK = timedelta(days=180)
REFUND_CHECK_EVERY_SECONDS = 24 * 3600
REFUND_CHECK_DELAY_SECONDS = 0.3  # a few PayPal calls per second at most
_REFUND_LOCK_KEY = "sc_pay:reconcile:refunds"
REVOKING_CAPTURE_STATUSES = ("REFUNDED", "REVERSED")

_task: Optional[asyncio.Task] = None


def _claim_lock() -> bool:
    try:
        from src.core.redis import get_redis_client

        client = get_redis_client()
        if client is None:
            return True
        return bool(client.set(_LOCK_KEY, "1", nx=True, ex=_LOCK_TTL_SECONDS))
    except Exception:
        logger.debug("Reconcile lock unavailable, running anyway", exc_info=True)
        return True


def _claim_refund_check() -> bool:
    """At most one refund check per day across workers (fails open)."""
    try:
        from src.core.redis import get_redis_client

        client = get_redis_client()
        if client is None:
            return True
        return bool(client.set(_REFUND_LOCK_KEY, "1", nx=True, ex=REFUND_CHECK_EVERY_SECONDS))
    except Exception:
        logger.debug("Refund check lock unavailable, running anyway", exc_info=True)
        return True


async def reconcile_refunds_once(db_session, *, delay: float = REFUND_CHECK_DELAY_SECONDS) -> dict:
    """Revoke paid orders whose capture was fully refunded or reversed at the
    provider. Partial refunds keep access (same rule as the webhook)."""
    from src.services.payments.checkout import _config_for
    from src.services.payments.fulfillment import PAID_STATUSES, revoke_order
    from src.services.payments.providers.registry import get_provider

    stats = {"checked": 0, "revoked": 0, "errors": 0}
    orders = (await db_session.execute(
        select(PaymentsOrder).where(
            PaymentsOrder.status.in_(PAID_STATUSES),  # type: ignore[attr-defined]
            PaymentsOrder.paid_at >= utcnow() - REFUND_CHECK_LOOKBACK,
            PaymentsOrder.provider_capture_id.is_not(None),  # type: ignore[union-attr]
            # Sanar y Criar: Pago Móvil has no capture to ask about (its
            # "capture id" is the bank reference); an admin voids it by hand.
            PaymentsOrder.provider != "manual",
        ).order_by(PaymentsOrder.id)
    )).scalars().all()
    for order in orders:
        provider = get_provider(order.provider)
        if provider is None or not hasattr(provider, "get_capture_status"):
            continue
        stats["checked"] += 1
        try:
            cfg = await _config_for(db_session, order, order.provider)
            if cfg is None:
                continue
            status = await provider.get_capture_status(cfg, order.provider_capture_id)
            if status in REVOKING_CAPTURE_STATUSES:
                reason = "reversed" if status == "REVERSED" else "refunded"
                if await revoke_order(db_session, order.id, reason=f"{reason}_reconciled"):
                    stats["revoked"] += 1
        except Exception as exc:
            stats["errors"] += 1
            logger.warning("Refund check of order %s failed: %s", order.order_uuid, getattr(exc, "detail", exc))
            try:
                await db_session.rollback()
            except Exception:
                pass
        if delay:
            await asyncio.sleep(delay)
    return stats


async def reconcile_once(db_session) -> dict:
    """One pass over open orders. Returns counters (for logs and tests)."""
    from src.services.payments.checkout import refresh_order
    from src.services.payments.fulfillment import apply_result
    from src.services.payments.providers.base import PaymentResult

    now = utcnow()
    stats = {"checked": 0, "paid": 0, "expired": 0, "errors": 0}

    # Long-abandoned checkouts: expire without asking the provider.
    stale = (await db_session.execute(
        select(PaymentsOrder).where(
            PaymentsOrder.status.in_(("created", "approved")),  # type: ignore[attr-defined]
            PaymentsOrder.creation_date < now - LOOKBACK,
        )
    )).scalars().all()
    for order in stale:
        await apply_result(db_session, order.id, PaymentResult(status="expired", reason="ABANDONED"))
        stats["expired"] += 1

    recent = (await db_session.execute(
        select(PaymentsOrder).where(
            or_(
                and_(
                    PaymentsOrder.status.in_(("created", "approved")),  # type: ignore[attr-defined]
                    PaymentsOrder.creation_date >= now - LOOKBACK,
                ),
                and_(
                    PaymentsOrder.status == "pending",
                    PaymentsOrder.creation_date >= now - PENDING_LOOKBACK,
                ),
            ),
            PaymentsOrder.provider_order_id.is_not(None),  # type: ignore[union-attr]
        ).order_by(PaymentsOrder.id)
    )).scalars().all()
    for order in recent:
        stats["checked"] += 1
        try:
            status = await refresh_order(db_session, order)
        except Exception as exc:
            stats["errors"] += 1
            logger.warning("Reconcile of order %s failed: %s", order.order_uuid, getattr(exc, "detail", exc))
            try:
                await db_session.rollback()
            except Exception:
                pass
            continue
        if status == "paid":
            stats["paid"] += 1
            continue
        await db_session.refresh(order)
        created_at = as_utc(order.creation_date)
        if order.status in ("created", "approved") and created_at and created_at < now - EXPIRE_AFTER:
            await apply_result(db_session, order.id, PaymentResult(status="expired", reason="ABANDONED"))
            stats["expired"] += 1
    return stats


async def _tick() -> None:
    if not _claim_lock():
        return
    from src.core.events.database import _async_session_factory

    # Sanar y Criar: unpaid Pago Móvil purchases past their deadline expire.
    try:
        from src.services.payments.purchases import expire_due_purchases

        async with _async_session_factory() as db_session:
            expired = await expire_due_purchases(db_session)
        if expired:
            logger.info("Pago Móvil purchases expired: %s", expired)
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("Expiring Pago Móvil purchases failed")

    try:
        async with _async_session_factory() as db_session:
            stats = await reconcile_once(db_session)
        if stats["checked"] or stats["expired"]:
            logger.info("Payments reconciliation: %s", stats)
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("Payments reconciliation failed")
    if not _claim_refund_check():
        return
    try:
        async with _async_session_factory() as db_session:
            stats = await reconcile_refunds_once(db_session)
        logger.info("Payments refund check: %s", stats)
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("Payments refund check failed")


async def _loop() -> None:
    await asyncio.sleep(STARTUP_DELAY_SECONDS)
    while True:
        await _tick()
        await asyncio.sleep(INTERVAL_SECONDS)


def start_scheduler() -> None:
    """Start the 5-minute tick. Never raises; no-op in tests or when disabled."""
    global _task
    try:
        if not reconcile_enabled() or _task is not None:
            return
        _task = asyncio.create_task(_loop())
        logger.info("Payments reconciliation scheduled every %ss", INTERVAL_SECONDS)
    except Exception:
        logger.exception("Could not start payments reconciliation")


async def stop_scheduler() -> None:
    global _task
    task, _task = _task, None
    if task is None:
        return
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):
        pass

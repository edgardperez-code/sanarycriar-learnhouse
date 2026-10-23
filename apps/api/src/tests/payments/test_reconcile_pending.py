"""Sanar y Criar: reconciliation keeps checking ``pending`` captures for 7 days
(``created``/``approved`` orders stay on the 24 h window), under the Redis lock."""

from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlmodel import select

from src.db.payments.payments import PaymentsEnrollment, PaymentsOrder
from src.services.payments import reconcile
from src.services.payments.common import utcnow
from src.services.payments.reconcile import reconcile_once
from src.tests.payments.conftest import ORG_ID, start_checkout

BASE = f"/api/v1/payments/{ORG_ID}"


@pytest.fixture(autouse=True)
def hosting():
    config = SimpleNamespace(hosting_config=SimpleNamespace(
        allowed_origins=["http://localhost:3200"], frontend_domain="", domain="", ssl=False,
    ))
    with patch("src.services.payments.checkout.get_learnhouse_config", return_value=config), \
            patch("src.services.payments.checkout.is_development_mode", return_value=False):
        yield


async def _pending_order(client, current, db, user, offer, fake_paypal, *, age: timedelta):
    """A checkout whose capture PayPal left PENDING, created ``age`` ago."""
    fake_paypal.capture_hook = lambda order, capture: capture.update(
        status="PENDING", status_details={"reason": "PENDING_REVIEW"}
    )
    order_uuid = (await start_checkout(client, current, user, offer)).json()["order_uuid"]
    paypal_order = fake_paypal.order_for_custom_id(order_uuid)
    fake_paypal.approve(paypal_order["id"])
    response = await client.post(f"{BASE}/orders/{order_uuid}/capture")
    assert response.json()["status"] == "pending", response.text
    fake_paypal.capture_hook = None

    row = (await db.execute(select(PaymentsOrder).where(PaymentsOrder.order_uuid == order_uuid))).scalars().one()
    row.creation_date = utcnow() - age
    db.add(row)
    await db.commit()
    return order_uuid, paypal_order


def _settle(paypal_order: dict) -> None:
    """PayPal finishes its review: the capture becomes COMPLETED."""
    capture = paypal_order["purchase_units"][0]["payments"]["captures"][0]
    capture["status"] = "COMPLETED"
    capture.pop("status_details", None)


async def _status(db, order_uuid: str) -> str:
    row = (await db.execute(
        select(PaymentsOrder).where(PaymentsOrder.order_uuid == order_uuid).execution_options(populate_existing=True)
    )).scalars().one()
    return row.status


class TestPendingLookback:
    async def test_pending_capture_from_three_days_ago_is_fulfilled(self, client, current, db, outsider, offer,
                                                                    fake_paypal):
        order_uuid, paypal_order = await _pending_order(client, current, db, outsider, offer, fake_paypal,
                                                        age=timedelta(days=3))
        # Still under review: checked, nothing granted, nothing expired.
        stats = await reconcile_once(db)
        assert stats == {"checked": 1, "paid": 0, "expired": 0, "errors": 0}
        assert await _status(db, order_uuid) == "pending"

        _settle(paypal_order)
        stats = await reconcile_once(db)
        assert stats["checked"] == 1 and stats["paid"] == 1 and stats["errors"] == 0
        assert await _status(db, order_uuid) == "paid"
        enrollment = (await db.execute(select(PaymentsEnrollment))).scalars().one()
        assert enrollment.status == "active"

    async def test_pending_capture_older_than_seven_days_is_left_alone(self, client, current, db, outsider, offer,
                                                                       fake_paypal):
        order_uuid, paypal_order = await _pending_order(client, current, db, outsider, offer, fake_paypal,
                                                        age=timedelta(days=8))
        _settle(paypal_order)
        stats = await reconcile_once(db)
        assert stats == {"checked": 0, "paid": 0, "expired": 0, "errors": 0}
        # Not expired either: a late COMPLETED webhook can still fulfil it.
        assert await _status(db, order_uuid) == "pending"

    async def test_created_orders_keep_the_24h_window(self, client, current, db, outsider, regular_user, offer,
                                                      fake_paypal):
        old = (await start_checkout(client, current, outsider, offer)).json()["order_uuid"]
        fresh = (await start_checkout(client, current, regular_user, offer)).json()["order_uuid"]
        fake_paypal.approve(fake_paypal.order_for_custom_id(old)["id"])
        row = (await db.execute(select(PaymentsOrder).where(PaymentsOrder.order_uuid == old))).scalars().one()
        row.creation_date = utcnow() - timedelta(days=2)
        db.add(row)
        await db.commit()

        stats = await reconcile_once(db)
        # The 2-day-old checkout is expired without asking PayPal (even though
        # it was approved there); only the fresh one is looked up.
        assert stats["checked"] == 1 and stats["expired"] == 1 and stats["paid"] == 0
        assert await _status(db, old) == "expired"
        assert await _status(db, fresh) == "created"
        assert reconcile.LOOKBACK == timedelta(hours=24)
        assert reconcile.PENDING_LOOKBACK == timedelta(days=7)


class TestReconcileLock:
    async def test_tick_skips_when_another_worker_holds_the_lock(self):
        client = MagicMock()
        client.set.return_value = None  # SET NX failed: the lock is taken
        with patch("src.core.redis.get_redis_client", return_value=client), \
                patch.object(reconcile, "reconcile_once", new_callable=AsyncMock) as once:
            await reconcile._tick()
        once.assert_not_called()
        client.set.assert_called_once()
        args, kwargs = client.set.call_args
        assert args[0] == "sc_pay:reconcile:lock"
        assert kwargs.get("nx") is True and kwargs.get("ex") == reconcile._LOCK_TTL_SECONDS

    def test_lock_is_claimed_with_set_nx(self):
        client = MagicMock()
        client.set.return_value = True
        with patch("src.core.redis.get_redis_client", return_value=client):
            assert reconcile._claim_lock() is True
        client.set.return_value = None
        with patch("src.core.redis.get_redis_client", return_value=client):
            assert reconcile._claim_lock() is False

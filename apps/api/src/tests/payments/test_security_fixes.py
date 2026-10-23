"""Sanar y Criar: regressions for the security review of the payments module
(docs/progreso/seguridad.md): no double charge, refunds of a duplicate charge,
sandbox configs on production, webhook-less live configs, the daily refund
check, cheap webhook pre-checks and rate limit, and PayPal payer data."""

import asyncio
import os
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from uuid import uuid4

import pytest
from sqlmodel import select

from src.db.payments.payments import PaymentsEnrollment, PaymentsOrder
from src.services.payments.checkout import (
    _capture_and_fulfill_locked,
    _capture_lock,
    capture_and_fulfill,
    capture_lock_id,
)
from src.services.payments.providers.base import WebhookVerificationError
from src.services.payments.providers.paypal import _trim, precheck_webhook_headers
from src.services.payments.reconcile import reconcile_refunds_once
from src.tests.payments.conftest import ORG_ID, start_checkout
from src.tests.payments.fake_paypal import (
    capture_completed_event,
    refund_event,
    webhook_headers,
)
from src.tests.payments.test_checkout_flow import BASE, _checkout_and_approve, _webhook, hosting  # noqa: F401


async def _order(db, order_uuid: str) -> PaymentsOrder:
    return (await db.execute(
        select(PaymentsOrder).where(PaymentsOrder.order_uuid == order_uuid)
        .execution_options(populate_existing=True)
    )).scalars().one()


async def _enrollment(db, enrollment_id: int) -> PaymentsEnrollment:
    return (await db.execute(
        select(PaymentsEnrollment).where(PaymentsEnrollment.id == enrollment_id)
        .execution_options(populate_existing=True)
    )).scalars().one()


async def _access(client, course) -> dict:
    return (await client.get(f"{BASE}/access", params={"resource_uuid": course.course_uuid})).json()


async def _paid_order(client, current, user, offer, fake_paypal):
    data, pp_order = await _checkout_and_approve(client, current, user, offer, fake_paypal)
    response = await client.post(f"{BASE}/orders/{data['order_uuid']}/capture")
    assert response.json()["status"] == "paid", response.text
    return data["order_uuid"], pp_order["purchase_units"][0]["payments"]["captures"][0]


async def _duplicate_paid_order(client, current, db, user, offer, fake_paypal, sent_emails):
    """Two paid orders on one enrollment (the pre-fix double charge): the
    first granted access, the second's capture completes afterwards."""
    first_uuid, first_capture = await _paid_order(client, current, user, offer, fake_paypal)
    first = await _order(db, first_uuid)
    second_uuid = str(uuid4())
    db.add(PaymentsOrder(
        order_uuid=second_uuid, org_id=ORG_ID, offer_id=first.offer_id, user_id=user.id,
        enrollment_id=first.enrollment_id, provider="paypal", method="paypal", status="pending",
        amount=first.amount, currency="USD", provider_order_id="ORDER-DUP", redirect_uri="", raw={},
    ))
    await db.commit()
    second_capture = {
        "id": "CAP-DUP", "status": "COMPLETED", "custom_id": second_uuid,
        "amount": {"currency_code": "USD", "value": "25.00"},
    }
    fake_paypal.captures["CAP-DUP"] = second_capture
    emails_before = sent_emails.call_count
    response = await _webhook(client, capture_completed_event("WH-DUP-CAP", second_capture, "ORDER-DUP"))
    assert response.json()["events"][0]["result"] == "paid"
    assert sent_emails.call_count == emails_before  # no second "ya tienes acceso"
    return first_uuid, first_capture, second_uuid, second_capture


class TestNoDoubleCharge:
    async def test_pending_payment_blocks_a_second_checkout(self, client, current, db, outsider, offer, course,
                                                            fake_paypal):
        fake_paypal.capture_hook = lambda order, capture: capture.update(
            status="PENDING", status_details={"reason": "PENDING_REVIEW"}
        )
        data, _ = await _checkout_and_approve(client, current, outsider, offer, fake_paypal)
        assert (await client.post(f"{BASE}/orders/{data['order_uuid']}/capture")).json()["status"] == "pending"

        again = await start_checkout(client, current, outsider, offer)
        assert again.status_code == 409
        assert again.json()["detail"] == {"code": "PAYMENT_PENDING", "order_uuid": data["order_uuid"]}
        assert len((await db.execute(select(PaymentsOrder))).scalars().all()) == 1

        access = await _access(client, course)
        assert access["has_access"] is False and access["payment_pending"] is True

    async def test_recent_approval_blocks_but_old_one_does_not(self, client, current, db, outsider, offer,
                                                              fake_paypal):
        response = await start_checkout(client, current, outsider, offer)
        order = await _order(db, response.json()["order_uuid"])
        order.status = "approved"
        db.add(order)
        await db.commit()
        assert (await start_checkout(client, current, outsider, offer)).json()["detail"]["code"] == "PAYMENT_PENDING"

        order = await _order(db, order.order_uuid)
        order.update_date = datetime.now(timezone.utc) - timedelta(hours=2)
        db.add(order)
        await db.commit()
        assert (await start_checkout(client, current, outsider, offer)).status_code == 200

    async def test_concurrent_captures_of_two_approved_orders_charge_once(self, client, current, db, outsider,
                                                                         offer, fake_paypal):
        first, _ = await _checkout_and_approve(client, current, outsider, offer, fake_paypal)
        second, _ = await _checkout_and_approve(client, current, outsider, offer, fake_paypal)
        order1 = await _order(db, first["order_uuid"])
        order2 = await _order(db, second["order_uuid"])
        assert capture_lock_id(order1) == capture_lock_id(order2)

        # Order 1 is mid-capture (holding the pair lock) when order 2's
        # confirmation arrives: order 2 waits, then sees the purchase owned.
        async with _capture_lock(capture_lock_id(order1)):
            waiting = asyncio.create_task(capture_and_fulfill(db, order2))
            await asyncio.sleep(0.05)
            assert not waiting.done()
            assert (await _capture_and_fulfill_locked(db, order1, None, None))[0] == "paid"
        status, extra = await waiting
        assert status == "paid" and extra == {"already_owned": True}
        assert sum(1 for _, p in fake_paypal.calls if p.endswith("/capture")) == 1
        assert (await _order(db, second["order_uuid"])).status == "cancelled"

    async def test_duplicate_charge_is_flagged_and_does_not_steal_the_grant(self, client, current, db, admin_user,
                                                                           outsider, offer, fake_paypal,
                                                                           sent_emails):
        first_uuid, _, second_uuid, _ = await _duplicate_paid_order(
            client, current, db, outsider, offer, fake_paypal, sent_emails
        )
        second = await _order(db, second_uuid)
        assert second.status == "paid" and second.raw["duplicate_of"] == first_uuid
        enrollment = await _enrollment(db, second.enrollment_id)
        assert enrollment.status == "active"
        assert enrollment.provider_specific_data["order_uuid"] == first_uuid

        current.set(admin_user)
        charges = {c["id"]: c for c in (await client.get(f"{BASE}/transactions")).json()["data"]}
        assert charges[second_uuid]["needs_refund"] is True and charges[second_uuid]["duplicate_of"] == first_uuid
        assert charges[first_uuid]["needs_refund"] is False
        assert (await client.get(f"{BASE}/overview")).json()["duplicate_charges"] == 1


class TestRefundOfADuplicateCharge:
    async def test_refunding_the_granting_order_keeps_access_through_the_other(self, client, current, db, outsider,
                                                                              offer, course, fake_paypal,
                                                                              sent_emails):
        first_uuid, first_capture, second_uuid, second_capture = await _duplicate_paid_order(
            client, current, db, outsider, offer, fake_paypal, sent_emails
        )
        first_capture["status"] = "REFUNDED"
        response = await _webhook(client, refund_event("WH-REF-1", first_capture["id"], "25.00"))
        assert response.json()["events"][0]["result"] == "refunded"

        assert (await _order(db, first_uuid)).status == "refunded"
        second = await _order(db, second_uuid)
        enrollment = await _enrollment(db, second.enrollment_id)
        assert enrollment.status == "active"
        assert enrollment.provider_specific_data["order_uuid"] == second_uuid
        assert "duplicate_of" not in second.raw  # no longer a charge to refund
        current.set(outsider)
        assert (await _access(client, course))["has_access"] is True

        # Refunding the last paid order does take access away.
        second_capture["status"] = "REFUNDED"
        await _webhook(client, refund_event("WH-REF-2", second_capture["id"], "25.00"))
        assert (await _enrollment(db, second.enrollment_id)).status == "refunded"
        assert (await _access(client, course))["has_access"] is False

    async def test_refunding_the_duplicate_keeps_the_grant(self, client, current, db, outsider, offer, course,
                                                          fake_paypal, sent_emails):
        first_uuid, _, second_uuid, second_capture = await _duplicate_paid_order(
            client, current, db, outsider, offer, fake_paypal, sent_emails
        )
        second_capture["status"] = "REFUNDED"
        await _webhook(client, refund_event("WH-REF-DUP", second_capture["id"], "25.00"))
        assert (await _order(db, second_uuid)).status == "refunded"
        enrollment = await _enrollment(db, (await _order(db, first_uuid)).enrollment_id)
        assert enrollment.status == "active" and enrollment.provider_specific_data["order_uuid"] == first_uuid
        current.set(outsider)
        assert (await _access(client, course))["has_access"] is True


class TestSandboxOnProduction:
    async def _to_sandbox(self, client, current, admin_user, offer):
        current.set(admin_user)
        cfg = (await client.get(f"{BASE}/config")).json()[0]
        response = await client.put(f"{BASE}/config/{cfg['id']}", json={"environment": "sandbox"})
        assert response.status_code == 200, response.text
        current.set(None)

    async def test_only_the_team_can_buy_and_sales_are_tagged(self, client, current, db, admin_user, outsider,
                                                              offer, fake_paypal):
        await self._to_sandbox(client, current, admin_user, offer)
        providers = (await client.get(f"{BASE}/checkout/providers")).json()
        assert providers[0]["environment"] == "sandbox" and providers[0]["test_mode"] is True

        refused = await start_checkout(client, current, outsider, offer)
        assert refused.status_code == 403
        assert refused.json()["detail"]["code"] == "STORE_TEST_MODE"
        assert (await db.execute(select(PaymentsOrder))).scalars().all() == []

        allowed = await start_checkout(client, current, admin_user, offer)
        assert allowed.status_code == 200, allowed.text
        assert (await _order(db, allowed.json()["order_uuid"])).raw["environment"] == "sandbox"

    async def test_development_instance_may_use_sandbox(self, client, current, admin_user, outsider, offer,
                                                        fake_paypal):
        await self._to_sandbox(client, current, admin_user, offer)
        with patch("src.services.payments.configs.is_development_mode", return_value=True):
            assert (await client.get(f"{BASE}/checkout/providers")).json()[0]["test_mode"] is False
            assert (await start_checkout(client, current, outsider, offer)).status_code == 200

    async def test_test_sales_are_marked_in_transactions(self, client, current, db, admin_user, offer, fake_paypal):
        await self._to_sandbox(client, current, admin_user, offer)
        data, _ = await _checkout_and_approve(client, current, admin_user, offer, fake_paypal)
        assert (await client.post(f"{BASE}/orders/{data['order_uuid']}/capture")).json()["status"] == "paid"
        charge = (await client.get(f"{BASE}/transactions")).json()["data"][0]
        assert charge["test_mode"] is True and charge["environment"] == "sandbox"
        with patch("src.services.payments.settings.is_development_mode", return_value=False):
            overview = (await client.get(f"{BASE}/overview")).json()
        assert overview["test_orders"] == 1 and overview["total_revenue"] == 0


class TestLiveNeedsWebhook:
    async def test_live_config_without_webhook_id_is_refused(self, client, current, db, admin_user, org_config,
                                                             fake_paypal):
        current.set(admin_user)
        response = await client.post(f"{BASE}/config?provider=paypal", json={
            "client_id": "x", "client_secret": "y", "environment": "live",
        })
        assert response.status_code == 400 and "Webhook ID" in response.json()["detail"]
        ok = await client.post(f"{BASE}/config?provider=paypal", json={
            "client_id": "x", "client_secret": "y", "environment": "live", "webhook_id": "WH-1",
        })
        assert ok.status_code == 200
        cleared = await client.put(f"{BASE}/config/{ok.json()['id']}", json={"webhook_id": ""})
        assert cleared.status_code == 400
        sandbox = await client.put(f"{BASE}/config/{ok.json()['id']}", json={"webhook_id": "", "environment": "sandbox"})
        assert sandbox.status_code == 200


class TestDailyRefundCheck:
    async def test_refund_without_webhook_revokes_access(self, client, current, db, outsider, offer, course,
                                                         fake_paypal):
        order_uuid, capture = await _paid_order(client, current, outsider, offer, fake_paypal)
        capture["status"] = "PARTIALLY_REFUNDED"
        stats = await reconcile_refunds_once(db, delay=0)
        assert stats == {"checked": 1, "revoked": 0, "errors": 0}
        assert (await _order(db, order_uuid)).status == "paid"

        capture["status"] = "REVERSED"  # chargeback won by the buyer
        stats = await reconcile_refunds_once(db, delay=0)
        assert stats["revoked"] == 1
        order = await _order(db, order_uuid)
        assert order.status == "refunded" and order.failure_reason == "reversed_reconciled"
        assert (await _enrollment(db, order.enrollment_id)).status == "refunded"
        current.set(outsider)
        assert (await _access(client, course))["has_access"] is False
        # Refunded orders are not looked at again.
        assert (await reconcile_refunds_once(db, delay=0))["checked"] == 0


class TestWebhookPrechecks:
    @pytest.mark.parametrize("override", [
        {"paypal-auth-algo": "HS256"},
        {"paypal-cert-url": "https://evil.example/cert"},
        {"paypal-cert-url": "http://api.paypal.com/v1/notifications/certs/X"},
        {"paypal-transmission-time": "2020-01-01T00:00:00Z"},
        {"paypal-transmission-time": "not-a-date"},
    ])
    async def test_forged_headers_never_reach_paypal(self, client, db, offer, fake_paypal, override):
        verify_calls = len(fake_paypal.verify_payloads)
        # Production base URL: the cert host check applies (no local mock).
        with patch("src.services.payments.providers.paypal.paypal_api_base",
                   return_value="https://api-m.paypal.com"):
            response = await client.post(
                f"/api/v1/payments/webhooks/paypal/{ORG_ID}",
                content=b'{"id":"WH-FORGED","event_type":"PAYMENT.CAPTURE.COMPLETED"}',
                headers=webhook_headers(**override),
            )
        assert response.status_code == 400
        assert len(fake_paypal.verify_payloads) == verify_calls

    def test_precheck_rules(self):
        now = datetime(2026, 10, 23, 12, 0, tzinfo=timezone.utc).timestamp()
        ok = {
            "paypal-auth-algo": "SHA256withRSA",
            "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
            "paypal-transmission-time": "2026-10-23T11:50:00Z",
        }
        precheck_webhook_headers(ok, "sandbox", now=now)
        with pytest.raises(WebhookVerificationError):
            precheck_webhook_headers(ok, "live", now=now)  # sandbox cert on a live config
        precheck_webhook_headers({**ok, "paypal-cert-url": "http://localhost:8099/c"}, "sandbox",
                                 allow_any_cert_host=True, now=now)
        with pytest.raises(WebhookVerificationError):
            precheck_webhook_headers({**ok, "paypal-transmission-time": "2026-10-23T10:00:00Z"}, "sandbox", now=now)

    async def test_webhook_is_rate_limited_before_verification(self, client, db, offer, fake_paypal, monkeypatch):
        monkeypatch.setitem(os.environ, "TESTING", "false")
        with patch("src.services.security.rate_limiting.check_rate_limit", return_value=(False, 0, 30)):
            response = await client.post(
                f"/api/v1/payments/webhooks/paypal/{ORG_ID}",
                content=b'{"id":"WH-FLOOD","event_type":"X"}', headers=webhook_headers(),
            )
        assert response.status_code == 429
        assert fake_paypal.verify_payloads == []


class TestPayerDataNotStored:
    def test_trim_drops_payer_payee_and_shipping(self):
        trimmed = _trim({
            "id": "O1", "status": "COMPLETED",
            "payer": {"email_address": "buyer@example.com", "payer_id": "PAYERID9", "name": {"given_name": "Ana"}},
            "purchase_units": [{
                "reference_id": "r", "custom_id": "c", "amount": {"value": "25.00", "currency_code": "USD"},
                "payee": {"email_address": "hilda@example.com", "merchant_id": "M1"},
                "shipping": {"name": {"full_name": "Ana"}, "address": {"address_line_1": "Calle 1"}},
                "payments": {"captures": [{
                    "id": "CAP1", "status": "COMPLETED", "amount": {"value": "25.00"},
                    "seller_receivable_breakdown": {"net_amount": {"value": "23.80"}},
                    "links": [{"href": "x"}],
                }]},
            }],
        })
        text = repr(trimmed)
        for leaked in ("buyer@example.com", "PAYERID9", "Ana", "hilda@example.com", "M1", "Calle 1"):
            assert leaked not in text
        unit = trimmed["purchase_units"][0]
        assert unit["custom_id"] == "c" and unit["payments"]["captures"][0]["id"] == "CAP1"
        assert unit["payments"]["captures"][0]["seller_receivable_breakdown"]["net_amount"]["value"] == "23.80"

    async def test_captured_order_row_has_no_payer(self, client, current, db, outsider, offer, fake_paypal):
        view = fake_paypal._view
        fake_paypal._view = lambda order: {**view(order), "payer": {"email_address": "buyer@example.com"}}
        order_uuid, _ = await _paid_order(client, current, outsider, offer, fake_paypal)
        raw = repr((await _order(db, order_uuid)).raw)
        assert "buyer@example.com" not in raw and "'payer'" not in raw

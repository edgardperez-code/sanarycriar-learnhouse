"""Sanar y Criar: checkout -> PayPal -> capture/webhook -> fulfillment, end to
end through the router with a FakePayPal (httpx.MockTransport)."""

import json
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from sqlmodel import func, select

from src.db.payments.payments import (
    PaymentsConfig,
    PaymentsEnrollment,
    PaymentsOrder,
    PaymentsWebhookEvent,
)
from src.db.trail_runs import TrailRun
from src.db.trails import Trail
from src.db.user_organizations import UserOrganization
from src.tests.payments.conftest import ORG_ID, REDIRECT, start_checkout
from src.tests.payments.fake_paypal import (
    capture_completed_event,
    order_approved_event,
    refund_event,
    webhook_headers,
)

BASE = f"/api/v1/payments/{ORG_ID}"


def _config(**hosting):
    values = dict(
        allowed_origins=["http://localhost:3200"],
        frontend_domain="cursos.sanarycriarve.com",
        domain="cursos.sanarycriarve.com",
        ssl=True,
    )
    values.update(hosting)
    return SimpleNamespace(hosting_config=SimpleNamespace(**values))


@pytest.fixture(autouse=True)
def hosting():
    """Production-like hosting; development mode off unless a test says so."""
    with patch("src.services.payments.checkout.get_learnhouse_config", return_value=_config()), \
            patch("src.services.payments.checkout.is_development_mode", return_value=False):
        yield


async def _count(db, model, *where):
    stmt = select(func.count()).select_from(model)
    for clause in where:
        stmt = stmt.where(clause)
    return (await db.execute(stmt)).scalar()


async def _checkout_and_approve(client, current, user, offer, fake_paypal):
    response = await start_checkout(client, current, user, offer)
    assert response.status_code == 200, response.text
    data = response.json()
    order = fake_paypal.order_for_custom_id(data["order_uuid"])
    fake_paypal.approve(order["id"])
    return data, order


async def _webhook(client, event: dict):
    raw = json.dumps(event).encode()
    return await client.post(f"/api/v1/payments/webhooks/paypal/{ORG_ID}", content=raw, headers=webhook_headers())


class TestCheckout:
    async def test_checkout_creates_paypal_order_from_db_price(self, client, current, db, outsider, offer, fake_paypal):
        response = await start_checkout(client, current, outsider, offer, method="card")
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["provider"] == "paypal"
        assert "checkoutnow?token=" in data["checkout_url"]

        order_row = (await db.execute(select(PaymentsOrder))).scalars().one()
        assert order_row.status == "created" and order_row.amount == Decimal("25.00")
        assert order_row.method == "card"
        enrollment = (await db.execute(select(PaymentsEnrollment))).scalars().one()
        assert enrollment.status == "pending" and enrollment.user_id == outsider.id

        sent = fake_paypal.order_for_custom_id(data["order_uuid"])["body"]
        unit = sent["purchase_units"][0]
        assert unit["custom_id"] == data["order_uuid"] == unit["reference_id"]
        assert unit["invoice_id"] == f"SYC-{data['order_uuid']}"
        assert unit["amount"]["value"] == "25.00" and unit["amount"]["currency_code"] == "USD"
        assert unit["items"][0]["category"] == "DIGITAL_GOODS"
        context = sent["payment_source"]["paypal"]["experience_context"]
        assert context["landing_page"] == "GUEST_CHECKOUT"
        assert context["payment_method_preference"] == "IMMEDIATE_PAYMENT_REQUIRED"
        assert context["shipping_preference"] == "NO_SHIPPING" and context["locale"] == "es-VE"
        assert context["return_url"] == f"{REDIRECT}?checkout=return&order={data['order_uuid']}"
        assert context["cancel_url"] == f"{REDIRECT}?checkout=cancelled&order={data['order_uuid']}"

    async def test_checkout_requires_login(self, client, current, offer):
        current.set(None)
        response = await client.post(f"{BASE}/offers/{offer['offer_uuid']}/checkout", params={"redirect_uri": REDIRECT})
        assert response.status_code == 401

    async def test_checkout_accepts_numeric_offer_id(self, client, current, outsider, offer):
        current.set(outsider)
        response = await client.post(f"{BASE}/offers/{offer['id']}/checkout", params={"redirect_uri": REDIRECT})
        assert response.status_code == 200, response.text

    @pytest.mark.parametrize("redirect", [
        "https://evil.example.com/store",
        "https://cursos.sanarycriarve.com.evil.com/x",
        "http://cursos.sanarycriarve.com/x",          # ssl configured: https only
        "javascript:alert(1)",
        "//evil.example.com/x",
        "https://user:pw@cursos.sanarycriarve.com/x",
        "http://localhost:9999/x",                     # not an allowed origin outside dev
    ])
    async def test_redirect_uri_rejected(self, client, current, db, outsider, offer, redirect):
        current.set(outsider)
        response = await client.post(f"{BASE}/offers/{offer['offer_uuid']}/checkout", params={"redirect_uri": redirect})
        assert response.status_code == 400
        assert await _count(db, PaymentsOrder) == 0

    async def test_redirect_uri_allowed(self, client, current, outsider, offer):
        current.set(outsider)
        for redirect in ("https://cursos.sanarycriarve.com/store/offers/x?a=1",
                         "https://www.cursos.sanarycriarve.com/x"):
            response = await client.post(
                f"{BASE}/offers/{offer['offer_uuid']}/checkout", params={"redirect_uri": redirect}
            )
            assert response.status_code == 200, (redirect, response.text)

    async def test_localhost_allowed_only_in_development(self, client, current, outsider, offer):
        current.set(outsider)
        with patch("src.services.payments.checkout.is_development_mode", return_value=True):
            response = await client.post(
                f"{BASE}/offers/{offer['offer_uuid']}/checkout", params={"redirect_uri": "http://localhost:4321/cursos"}
            )
        assert response.status_code == 200

    async def test_subscription_offers_rejected(self, client, current, admin_user, course, paypal_config):
        current.set(admin_user)
        response = await client.post(f"{BASE}/offers", json={
            "name": "Mensual", "description": "", "offer_type": "subscription", "amount": 10,
            "currency": "USD", "resource_uuids": [course.course_uuid],
        })
        assert response.status_code == 400


class TestCaptureAndFulfillment:
    async def test_capture_grants_access_once(self, client, current, db, outsider, offer, course, activity, fake_paypal, sent_emails):
        data, _ = await _checkout_and_approve(client, current, outsider, offer, fake_paypal)

        response = await client.post(f"{BASE}/orders/{data['order_uuid']}/capture")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "paid" and body["offer_uuid"] == offer["offer_uuid"]
        assert body["resources"][0]["course_uuid"] == course.course_uuid
        assert body["resources"][0]["first_activity_uuid"] == activity.activity_uuid
        assert body["resources"][0]["product_type"] == "course"

        access = (await client.get(f"{BASE}/access", params={"resource_uuid": course.course_uuid})).json()
        assert access == {
            "for_sale": True, "has_access": True, "reason": "purchased", "offers_count": 1, "payment_pending": False,
        }

        # Buyer joined the org, has a Trail and a TrailRun for the course.
        assert await _count(db, UserOrganization, UserOrganization.user_id == outsider.id) == 1
        assert await _count(db, Trail, Trail.user_id == outsider.id) == 1
        assert await _count(db, TrailRun, TrailRun.user_id == outsider.id, TrailRun.course_id == course.id) == 1
        assert sent_emails.call_count == 1
        assert "Ya tienes acceso" in sent_emails.call_args.kwargs["subject"]

        # Capturing again is idempotent: no second PayPal capture, no new rows.
        captures_before = sum(1 for m, p in fake_paypal.calls if p.endswith("/capture"))
        again = await client.post(f"{BASE}/orders/{data['order_uuid']}/capture")
        assert again.json()["status"] == "paid"
        assert sum(1 for m, p in fake_paypal.calls if p.endswith("/capture")) == captures_before
        assert await _count(db, PaymentsEnrollment) == 1
        assert await _count(db, TrailRun, TrailRun.user_id == outsider.id) == 1
        assert await _count(db, Trail, Trail.user_id == outsider.id) == 1
        assert sent_emails.call_count == 1

        mine = (await client.get(f"{BASE}/enrollments/mine")).json()
        assert len(mine) == 1 and mine[0]["status"] == "active" and mine[0]["offer_uuid"] == offer["offer_uuid"]
        assert mine[0]["resources"][0]["course_uuid"] == course.course_uuid

        # Buying again is refused.
        retry = await start_checkout(client, current, outsider, offer)
        assert retry.status_code == 409 and retry.json()["detail"] == {"code": "ALREADY_OWNED"}

    async def test_capture_then_webhook_single_fulfillment(self, client, current, db, outsider, offer, fake_paypal, sent_emails):
        data, order = await _checkout_and_approve(client, current, outsider, offer, fake_paypal)
        assert (await client.post(f"{BASE}/orders/{data['order_uuid']}/capture")).json()["status"] == "paid"
        capture = order["purchase_units"][0]["payments"]["captures"][0]

        response = await _webhook(client, capture_completed_event("WH-1", capture, order["id"]))
        assert response.status_code == 200
        assert response.json()["events"][0]["result"] == "paid"
        assert await _count(db, PaymentsEnrollment, PaymentsEnrollment.status == "active") == 1
        assert await _count(db, TrailRun) == 1
        assert sent_emails.call_count == 1

    async def test_webhook_completed_before_return(self, client, current, db, outsider, offer, fake_paypal, course):
        """The buyer closed the tab after approving: CHECKOUT.ORDER.APPROVED
        makes the server capture, and the return page later just reads it."""
        data, order = await _checkout_and_approve(client, current, outsider, offer, fake_paypal)
        current.set(None)
        response = await _webhook(client, order_approved_event("WH-APPROVED", order))
        assert response.status_code == 200
        assert response.json()["events"][0]["result"] == "paid"
        row = (await db.execute(select(PaymentsOrder))).scalars().one()
        assert row.status == "paid" and row.provider_capture_id

        current.set(outsider)
        assert (await client.post(f"{BASE}/orders/{data['order_uuid']}/capture")).json()["status"] == "paid"
        assert await _count(db, PaymentsEnrollment, PaymentsEnrollment.status == "active") == 1

    @pytest.mark.parametrize("tamper", [
        lambda order, capture: capture["amount"].update(value="1.00"),
        lambda order, capture: capture["amount"].update(value="25.001"),
        lambda order, capture: capture["amount"].update(currency_code="EUR"),
        lambda order, capture: capture.update(custom_id="someone-else"),
    ])
    async def test_capture_mismatch_grants_nothing(self, client, current, db, outsider, offer, course, fake_paypal, tamper):
        fake_paypal.capture_hook = tamper
        data, _ = await _checkout_and_approve(client, current, outsider, offer, fake_paypal)
        response = await client.post(f"{BASE}/orders/{data['order_uuid']}/capture")
        assert response.json()["status"] == "failed"
        row = (await db.execute(select(PaymentsOrder))).scalars().one()
        assert row.status == "failed" and row.failure_reason == "MISMATCH"
        access = (await client.get(f"{BASE}/access", params={"resource_uuid": course.course_uuid})).json()
        assert access["has_access"] is False
        assert await _count(db, TrailRun) == 0

    async def test_pending_capture_grants_nothing_until_completed(self, client, current, db, outsider, offer, course, fake_paypal):
        fake_paypal.capture_hook = lambda order, capture: capture.update(
            status="PENDING", status_details={"reason": "PENDING_REVIEW"}
        )
        data, order = await _checkout_and_approve(client, current, outsider, offer, fake_paypal)
        response = await client.post(f"{BASE}/orders/{data['order_uuid']}/capture")
        assert response.json()["status"] == "pending"
        access = (await client.get(f"{BASE}/access", params={"resource_uuid": course.course_uuid})).json()
        assert access["has_access"] is False

        # Shown to the buyer as a payment under review.
        mine = (await client.get(f"{BASE}/enrollments/mine")).json()
        assert mine[0]["status"] == "pending"

        capture = order["purchase_units"][0]["payments"]["captures"][0]
        capture["status"] = "COMPLETED"
        capture.pop("status_details")
        response = await _webhook(client, capture_completed_event("WH-LATE", capture, order["id"]))
        assert response.json()["events"][0]["result"] == "paid"
        access = (await client.get(f"{BASE}/access", params={"resource_uuid": course.course_uuid})).json()
        assert access["has_access"] is True

    async def test_instrument_declined_is_retry(self, client, current, outsider, offer, fake_paypal):
        fake_paypal.capture_error = "INSTRUMENT_DECLINED"
        data, _ = await _checkout_and_approve(client, current, outsider, offer, fake_paypal)
        response = await client.post(f"{BASE}/orders/{data['order_uuid']}/capture")
        assert response.json()["status"] == "retry"

    async def test_not_yet_approved_stays_pending(self, client, current, db, outsider, offer, fake_paypal):
        response = await start_checkout(client, current, outsider, offer)
        order_uuid = response.json()["order_uuid"]
        response = await client.post(f"{BASE}/orders/{order_uuid}/capture")
        assert response.json()["status"] == "pending"
        assert (await db.execute(select(PaymentsOrder))).scalars().one().status == "created"

    async def test_other_signed_in_user_cannot_capture(self, client, current, outsider, regular_user, offer, fake_paypal):
        data, _ = await _checkout_and_approve(client, current, outsider, offer, fake_paypal)
        current.set(regular_user)
        assert (await client.post(f"{BASE}/orders/{data['order_uuid']}/capture")).status_code == 404
        assert (await client.get(f"{BASE}/orders/{data['order_uuid']}")).status_code == 404
        # Anonymous (expired session on return) may confirm with the secret uuid.
        current.set(None)
        assert (await client.post(f"{BASE}/orders/{data['order_uuid']}/capture")).json()["status"] == "paid"

    async def test_cancel_marks_order_cancelled(self, client, current, db, outsider, offer, fake_paypal):
        response = await start_checkout(client, current, outsider, offer)
        order_uuid = response.json()["order_uuid"]
        response = await client.post(f"{BASE}/orders/{order_uuid}/cancel")
        assert response.status_code == 200 and response.json()["status"] == "cancelled"
        assert (await client.get(f"{BASE}/orders/{order_uuid}")).json()["status"] == "cancelled"


class TestWebhooks:
    async def test_bad_signature_is_rejected_without_state_change(self, client, current, db, outsider, offer, fake_paypal):
        data, order = await _checkout_and_approve(client, current, outsider, offer, fake_paypal)
        fake_paypal.verify_status = "FAILURE"
        response = await _webhook(client, order_approved_event("WH-FORGED", order))
        assert response.status_code == 400
        row = (await db.execute(select(PaymentsOrder))).scalars().one()
        assert row.status == "created"
        assert await _count(db, PaymentsWebhookEvent) == 0
        assert not any(p.endswith("/capture") for _, p in fake_paypal.calls)

    async def test_missing_transmission_headers_rejected(self, client, db, offer, fake_paypal):
        response = await client.post(
            f"/api/v1/payments/webhooks/paypal/{ORG_ID}",
            content=b'{"id":"WH-X","event_type":"PAYMENT.CAPTURE.COMPLETED"}',
            headers={"content-type": "application/json"},
        )
        assert response.status_code == 400
        assert await _count(db, PaymentsWebhookEvent) == 0

    async def test_raw_body_is_spliced_into_verification(self, client, offer, fake_paypal):
        raw = b'{"id":"WH-RAW",  "event_type":"SOMETHING.ELSE",   "resource":{"x":1.10}}'
        response = await client.post(f"/api/v1/payments/webhooks/paypal/{ORG_ID}", content=raw, headers=webhook_headers())
        assert response.status_code == 200
        sent = fake_paypal.verify_payloads[-1]
        assert raw in sent  # exactly as received, not re-serialized
        assert json.loads(sent)["webhook_id"] == "WH-TEST"

    async def test_duplicate_event_processed_once(self, client, current, db, outsider, offer, fake_paypal):
        data, order = await _checkout_and_approve(client, current, outsider, offer, fake_paypal)
        event = order_approved_event("WH-DUP", order)
        first = await _webhook(client, event)
        second = await _webhook(client, event)
        assert first.json()["events"][0]["result"] == "paid"
        assert second.status_code == 200
        assert second.json()["events"][0]["result"] == "duplicate"
        assert await _count(db, PaymentsWebhookEvent) == 1
        assert sum(1 for _, p in fake_paypal.calls if p.endswith("/capture")) == 1

    async def test_full_refund_revokes_partial_keeps(self, client, current, db, outsider, offer, course, fake_paypal):
        data, order = await _checkout_and_approve(client, current, outsider, offer, fake_paypal)
        await client.post(f"{BASE}/orders/{data['order_uuid']}/capture")
        capture = order["purchase_units"][0]["payments"]["captures"][0]

        capture["status"] = "PARTIALLY_REFUNDED"
        response = await _webhook(client, refund_event("WH-R1", capture["id"], "5.00"))
        assert response.json()["events"][0]["result"] == "partial_refund"
        assert (await client.get(f"{BASE}/access", params={"resource_uuid": course.course_uuid})).json()["has_access"]

        capture["status"] = "REFUNDED"
        response = await _webhook(client, refund_event("WH-R2", capture["id"], "20.00"))
        assert response.json()["events"][0]["result"] == "refunded"
        access = (await client.get(f"{BASE}/access", params={"resource_uuid": course.course_uuid})).json()
        assert access["has_access"] is False
        enrollment = (await db.execute(select(PaymentsEnrollment))).scalars().one()
        assert enrollment.status == "refunded"
        # Progress container is kept.
        assert await _count(db, TrailRun) == 1

        # A late or replayed completion never resurrects a refunded purchase.
        late = await _webhook(client, capture_completed_event("WH-LATE2", {**capture, "status": "COMPLETED"}, order["id"]))
        assert late.status_code == 200
        assert (await db.execute(select(PaymentsEnrollment))).scalars().one().status == "refunded"


class TestProviderAndConfig:
    async def test_config_never_returns_secret(self, client, current, db, admin_user, paypal_config):
        assert paypal_config["active"] is True
        assert paypal_config["provider_specific_id"] == "APP-CLIENT-ABC"
        current.set(admin_user)
        response = await client.get(f"{BASE}/config")
        assert response.status_code == 200
        assert "super-secret-value" not in response.text
        assert "client_secret" not in response.text
        settings = response.json()[0]["settings"]
        assert settings["has_secret"] is True and settings["client_id"] == "client-abc"
        assert settings["environment"] == "live" and settings["webhook_id"] == "WH-TEST"

        stored = (await db.execute(select(PaymentsConfig))).scalars().one().provider_config
        assert "super-secret-value" not in json.dumps(stored)
        from src.services.webhooks.crypto import decrypt_secret

        assert decrypt_secret(stored["client_secret_enc"]) == "super-secret-value"

        # Public checkout providers expose the public client id only.
        current.set(None)
        providers = (await client.get(f"{BASE}/checkout/providers")).json()
        assert providers == [{
            "provider": "paypal", "label": "PayPal", "environment": "live", "test_mode": False,
            "client_id": "client-abc",
            "methods": ["paypal", "card"], "currencies": ["USD"],
        }]

    async def test_invalid_credentials_rejected(self, client, current, db, admin_user, org_config, fake_paypal):
        fake_paypal.reject_credentials = True
        current.set(admin_user)
        response = await client.post(f"{BASE}/config?provider=paypal", json={
            "client_id": "x", "client_secret": "y", "environment": "sandbox",
        })
        assert response.status_code == 400
        assert await _count(db, PaymentsConfig) == 0

    async def test_duplicate_config_409_and_update(self, client, current, admin_user, paypal_config, fake_paypal):
        current.set(admin_user)
        dup = await client.post(f"{BASE}/config?provider=paypal", json={"client_id": "a", "client_secret": "b"})
        assert dup.status_code == 409
        updated = await client.put(f"{BASE}/config/{paypal_config['id']}", json={"webhook_id": "WH-NEW"})
        assert updated.status_code == 200
        assert updated.json()["settings"]["webhook_id"] == "WH-NEW"
        assert updated.json()["settings"]["has_secret"] is True

    async def test_config_requires_admin(self, client, current, regular_user, paypal_config):
        current.set(regular_user)
        assert (await client.get(f"{BASE}/config")).status_code == 403
        current.set(None)
        assert (await client.get(f"{BASE}/config")).status_code == 401

    async def test_token_is_cached_and_refreshed_on_401(self, client, current, outsider, regular_user, offer, fake_paypal):
        before = fake_paypal.token_requests
        await start_checkout(client, current, outsider, offer)
        await start_checkout(client, current, regular_user, offer)
        assert fake_paypal.token_requests == before  # cached from config validation
        fake_paypal.expire_next_token = True
        response = await start_checkout(client, current, outsider, offer)
        assert response.status_code == 200
        assert fake_paypal.token_requests == before + 1


class TestRoutesAndOffers:
    async def test_literal_routes_not_swallowed_by_offer_id(self, client, current, course, offer):
        current.set(None)
        listing = await client.get(f"{BASE}/offers/public-listing")
        assert listing.status_code == 200
        items = listing.json()
        assert [o["offer_uuid"] for o in items] == [offer["offer_uuid"]]
        resource = items[0]["included_resources"][0]
        assert resource["product_type"] == "course" and resource["course_uuid"] == course.course_uuid
        assert "thumbnail_url" in resource

        for uuid in (course.course_uuid, course.course_uuid.removeprefix("course_")):
            by_resource = await client.get(f"{BASE}/offers/by-resource", params={"resource_uuid": uuid})
            assert by_resource.status_code == 200
            assert by_resource.json()[0]["offer_id"] == offer["id"]
            assert by_resource.json()[0]["offer_name"] == "Curso completo"

        for ref in (offer["offer_uuid"], str(offer["id"])):
            public = await client.get(f"{BASE}/offers/{ref}/public")
            assert public.status_code == 200 and public.json()["offer_uuid"] == offer["offer_uuid"]

    async def test_free_listing_lists_only_uncovered_courses(self, client, current, admin_user, db, course, offer):
        # Sanar y Criar: a course sold by a live offer is not free; once the
        # offer is archived (and the course is public) the site lists it free.
        course.public = True
        db.add(course)
        await db.commit()
        current.set(None)
        free = await client.get(f"{BASE}/offers/free-listing")
        assert free.status_code == 200
        assert course.course_uuid not in [c["course_uuid"] for c in free.json()]

        current.set(admin_user)
        assert (await client.delete(f"{BASE}/offers/{offer['id']}")).status_code == 200
        current.set(None)
        items = (await client.get(f"{BASE}/offers/free-listing")).json()
        listed = [c for c in items if c["course_uuid"] == course.course_uuid]
        assert len(listed) == 1
        assert listed[0]["product_type"] == "course" and "course_url" in listed[0] and "description" in listed[0]

    async def test_archive_returns_200_and_hides_offer(self, client, current, admin_user, course, offer):
        current.set(admin_user)
        response = await client.delete(f"{BASE}/offers/{offer['id']}")
        assert response.status_code == 200
        assert response.json() == {"detail": "Offer archived"}
        assert (await client.get(f"{BASE}/offers")).json() == []
        current.set(None)
        assert (await client.get(f"{BASE}/offers/{offer['offer_uuid']}/public")).status_code == 404
        assert (await client.get(f"{BASE}/offers/public-listing")).json() == []
        access = (await client.get(f"{BASE}/access", params={"resource_uuid": course.course_uuid})).json()
        assert access["for_sale"] is False

    async def test_partial_update_and_resources(self, client, current, admin_user, course, offer):
        current.set(admin_user)
        response = await client.put(f"{BASE}/offers/{offer['id']}", json={"name": "Nuevo nombre", "amount": 30})
        assert response.status_code == 200
        body = response.json()
        assert body["name"] == "Nuevo nombre" and body["amount"] == 30.0
        assert body["resource_uuids"] == [course.course_uuid]
        assert (await client.get(f"{BASE}/offers/{offer['id']}/resources")).json() == [course.course_uuid]
        assert (await client.delete(f"{BASE}/offers/{offer['id']}/resources",
                                    params={"resource_uuid": course.course_uuid})).status_code == 200
        assert (await client.get(f"{BASE}/offers/{offer['id']}/resources")).json() == []

    async def test_admin_lists_customers_and_transactions(self, client, current, admin_user, outsider, offer, fake_paypal):
        data, _ = await _checkout_and_approve(client, current, outsider, offer, fake_paypal)
        await client.post(f"{BASE}/orders/{data['order_uuid']}/capture")
        current.set(admin_user)
        customers = (await client.get(f"{BASE}/customers")).json()
        assert customers[0]["status"] == "active" and customers[0]["stripe"] is None
        assert customers[0]["payment"]["provider"] == "paypal"
        overview = (await client.get(f"{BASE}/overview")).json()
        assert overview["total_revenue"] == 25.0 and len(overview["recent_charges"]) == 1
        transactions = (await client.get(f"{BASE}/transactions", params={"limit": 10})).json()
        assert transactions["has_more"] is False and transactions["data"][0]["paid"] is True
        assert (await client.get(f"{BASE}/stripe/subscriptions")).json() == {"data": []}
        assert (await client.post(f"{BASE}/billing/portal")).status_code == 404

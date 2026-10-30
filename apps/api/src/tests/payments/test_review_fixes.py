"""Sanar y Criar: regressions for the backend review (API tokens and the
paywall, double enrollment rows, transient webhook failures)."""

from uuid import uuid4
from unittest.mock import AsyncMock, patch

from sqlmodel import select

from src.db.payments.payments import PaymentsEnrollment, PaymentsOrder, PaymentsWebhookEvent
from src.db.users import APITokenUser, SuperadminAPITokenUser
from src.services.payments.access import check_activity_paid_access, get_course_access
from src.services.payments.providers.base import ProviderError
from src.services.payments.providers.paypal import PayPalProvider
from src.tests.payments.conftest import ORG_ID, start_checkout
from src.tests.payments.fake_paypal import order_approved_event
from src.tests.payments.test_access import _offer
from src.tests.payments.test_checkout_flow import BASE, _checkout_and_approve, _webhook, hosting  # noqa: F401


def _org_token(**kwargs) -> APITokenUser:
    return APITokenUser(id=3, org_id=ORG_ID, token_name="integration", created_by_user_id=1, **kwargs)


class TestApiTokensAndPaywall:
    async def test_org_api_token_never_unlocks_a_course_for_sale(self, db, course, activity):
        await _offer(db, course.course_uuid)
        access = await get_course_access(db, _org_token(rights={"courses": {"action_read": True}}), course)
        assert (access.for_sale, access.has_access, access.reason) == (True, False, "none")
        assert await check_activity_paid_access(None, activity.id, _org_token(), db) is False

    async def test_org_api_token_and_free_courses(self, db, course, activity, monkeypatch):
        # Upstream behaviour (switch off): free is open, tokens included.
        access = await get_course_access(db, _org_token(), course)
        assert (access.for_sale, access.has_access, access.reason) == (False, True, "free")
        # Ours: free needs a signed-in, verified account; a token is neither.
        monkeypatch.setenv("SC_EMAIL_VERIFICATION", "1")
        access = await get_course_access(db, _org_token(), course)
        assert (access.for_sale, access.has_access, access.reason) == (False, False, "login_required")

    async def test_token_principals_cannot_capture_an_order(self, client, current, db, outsider, offer, fake_paypal):
        data, _ = await _checkout_and_approve(client, current, outsider, offer, fake_paypal)
        # Token ids are not user ids, even when the numbers happen to match.
        for principal in (_org_token(), SuperadminAPITokenUser(id=outsider.id)):
            current.set(principal)
            response = await client.post(f"{BASE}/orders/{data['order_uuid']}/capture")
            assert response.status_code == 404
        assert not any(p.endswith("/capture") for _, p in fake_paypal.calls)


class TestNoSecondCharge:
    async def test_second_enrollment_row_is_not_charged_again(self, client, current, db, outsider, offer, fake_paypal):
        first, first_pp = await _checkout_and_approve(client, current, outsider, offer, fake_paypal)
        # A double-click raced two checkouts: a second enrollment row exists.
        db.add(PaymentsEnrollment(
            enrollment_uuid=str(uuid4()), offer_id=offer["id"], user_id=outsider.id, org_id=ORG_ID,
            status="pending", provider_specific_data={},
        ))
        await db.commit()
        second, second_pp = await _checkout_and_approve(client, current, outsider, offer, fake_paypal)
        orders = {o.order_uuid: o for o in (await db.execute(select(PaymentsOrder))).scalars().all()}
        assert orders[first["order_uuid"]].enrollment_id != orders[second["order_uuid"]].enrollment_id

        paid = await client.post(f"{BASE}/orders/{first['order_uuid']}/capture")
        assert paid.json()["status"] == "paid"
        again = await client.post(f"{BASE}/orders/{second['order_uuid']}/capture")
        assert again.status_code == 200
        assert again.json()["status"] == "paid" and again.json()["already_owned"] is True

        captures = [p for _, p in fake_paypal.calls if p.endswith("/capture")]
        assert captures == [f"/v2/checkout/orders/{first_pp['id']}/capture"]
        second_row = (await db.execute(
            select(PaymentsOrder).where(PaymentsOrder.order_uuid == second["order_uuid"])
            .execution_options(populate_existing=True)
        )).scalars().one()
        assert second_row.status == "cancelled"


class TestTransientWebhookFailure:
    async def test_provider_outage_answers_503_and_redelivery_fulfills(self, client, current, db, outsider, offer,
                                                                       course, fake_paypal):
        data, order = await _checkout_and_approve(client, current, outsider, offer, fake_paypal)
        event = order_approved_event("WH-OUTAGE", order)
        with patch.object(PayPalProvider, "confirm",
                          new=AsyncMock(side_effect=ProviderError("PayPal unreachable", retryable=True))):
            response = await _webhook(client, event)
        assert response.status_code == 503
        row = (await db.execute(
            select(PaymentsWebhookEvent).execution_options(populate_existing=True)
        )).scalars().one()
        assert row.status == "failed"

        # PayPal redelivers the same event: it is re-run, not deduplicated away.
        retry = await _webhook(client, event)
        assert retry.status_code == 200
        assert retry.json()["events"][0]["result"] == "paid"
        current.set(outsider)
        access = (await client.get(f"{BASE}/access", params={"resource_uuid": course.course_uuid})).json()
        assert access["has_access"] is True

    async def test_definitive_failure_still_answers_2xx(self, client, current, db, outsider, offer, fake_paypal):
        data, order = await _checkout_and_approve(client, current, outsider, offer, fake_paypal)
        with patch.object(PayPalProvider, "confirm", new=AsyncMock(side_effect=ValueError("bad payload"))):
            response = await _webhook(client, order_approved_event("WH-BROKEN", order))
        assert response.status_code == 200
        assert response.json()["events"][0]["result"] == "error"

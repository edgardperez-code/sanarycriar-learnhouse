"""Sanar y Criar: reconciliation pass, PayPal result evaluation, extra CORS."""

from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlmodel import select

from src.core.middleware.extra_cors import ExtraOriginsCORSMiddleware, parse_extra_origins
from src.db.payments.payments import PaymentsEnrollment, PaymentsOrder
from src.services.payments.common import utcnow
from src.services.payments.providers.paypal import PayPalProvider
from src.services.payments.reconcile import reconcile_once
from src.tests.payments.conftest import start_checkout


@pytest.fixture(autouse=True)
def hosting():
    config = SimpleNamespace(hosting_config=SimpleNamespace(
        allowed_origins=["http://localhost:3200"], frontend_domain="", domain="", ssl=False,
    ))
    with patch("src.services.payments.checkout.get_learnhouse_config", return_value=config), \
            patch("src.services.payments.checkout.is_development_mode", return_value=False):
        yield


class TestReconcile:
    async def test_approved_order_is_captured_and_stale_one_expires(self, client, current, db, outsider,
                                                                     regular_user, offer, fake_paypal):
        approved = (await start_checkout(client, current, outsider, offer)).json()["order_uuid"]
        stale = (await start_checkout(client, current, regular_user, offer)).json()["order_uuid"]
        fake_paypal.approve(fake_paypal.order_for_custom_id(approved)["id"])

        row = (await db.execute(select(PaymentsOrder).where(PaymentsOrder.order_uuid == stale))).scalars().one()
        row.creation_date = utcnow() - timedelta(hours=13)
        db.add(row)
        await db.commit()

        stats = await reconcile_once(db)
        assert stats["paid"] == 1 and stats["expired"] == 1 and stats["errors"] == 0

        orders = {o.order_uuid: o for o in (await db.execute(select(PaymentsOrder))).scalars().all()}
        assert orders[approved].status == "paid"
        assert orders[stale].status == "expired"
        enrollments = {e.user_id: e.status for e in (await db.execute(select(PaymentsEnrollment))).scalars().all()}
        assert enrollments == {outsider.id: "active", regular_user.id: "cancelled"}

        # A second pass has nothing left to do.
        again = await reconcile_once(db)
        assert again["paid"] == 0 and again["checked"] == 0


class TestEvaluateOrder:
    def _order(self):
        return SimpleNamespace(order_uuid="ord-1", provider_order_id="PP1", amount=Decimal("25.00"), currency="USD")

    def _paypal(self, **capture):
        base = {"id": "CAP1", "status": "COMPLETED", "amount": {"currency_code": "USD", "value": "25.00"},
                "custom_id": "ord-1"}
        base.update(capture)
        return {"id": "PP1", "status": "COMPLETED", "purchase_units": [{"payments": {"captures": [base]}}]}

    def test_completed_match_is_paid(self):
        result = PayPalProvider.evaluate_order(self._order(), self._paypal())
        assert result.status == "paid" and result.charged_amount == Decimal("25.00")

    def test_decimal_equality_not_float(self):
        assert PayPalProvider.evaluate_order(self._order(), self._paypal(amount={"currency_code": "USD", "value": "25"})).status == "paid"
        assert PayPalProvider.evaluate_order(self._order(), self._paypal(amount={"currency_code": "USD", "value": "24.999999999"})).status == "failed"

    def test_other_order_id_fails(self):
        data = self._paypal()
        data["id"] = "PP2"
        assert PayPalProvider.evaluate_order(self._order(), data).reason == "ORDER_ID_MISMATCH"

    def test_pending_and_declined(self):
        assert PayPalProvider.evaluate_order(self._order(), self._paypal(status="PENDING")).status == "pending"
        assert PayPalProvider.evaluate_order(self._order(), self._paypal(status="DECLINED")).status == "failed"

    def test_approved_without_capture(self):
        result = PayPalProvider.evaluate_order(self._order(), {"id": "PP1", "status": "APPROVED", "purchase_units": [{}]})
        assert result.status == "approved"


def _cors_app(origins):
    from fastapi.middleware.cors import CORSMiddleware

    app = FastAPI()

    @app.get("/catalog")
    async def catalog():
        return {"ok": True}

    @app.post("/catalog")
    async def write():
        return {"ok": True}

    regex = r"^https?://(?:(?:www\.)?cursos\.example\.com|localhost|127\.0\.0\.1)(:\d+)?$"
    app.add_middleware(CORSMiddleware, allow_origin_regex=regex, allow_methods=["*"],
                       allow_credentials=True, allow_headers=["*"])
    app.add_middleware(ExtraOriginsCORSMiddleware, origins=origins, main_origin_regex=regex)
    return app


class TestExtraCors:
    def test_parse(self):
        assert parse_extra_origins(" https://www.Example.com/ ,https://example.com,ftp://x,https://a.com/path,") == [
            "https://www.example.com", "https://example.com",
        ]

    async def test_extra_origin_gets_credentialless_read_cors(self):
        app = _cors_app(["https://www.example.com"])
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://api") as client:
            response = await client.get("/catalog", headers={"Origin": "https://www.example.com"})
            assert response.headers["access-control-allow-origin"] == "https://www.example.com"
            assert "access-control-allow-credentials" not in response.headers

            preflight = await client.options("/catalog", headers={
                "Origin": "https://www.example.com", "Access-Control-Request-Method": "GET",
            })
            assert preflight.status_code == 200
            assert "access-control-allow-credentials" not in preflight.headers

            denied = await client.options("/catalog", headers={
                "Origin": "https://www.example.com", "Access-Control-Request-Method": "POST",
            })
            assert denied.status_code == 400
            auth = await client.options("/catalog", headers={
                "Origin": "https://www.example.com", "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "authorization",
            })
            assert auth.status_code == 400

            post = await client.post("/catalog", headers={"Origin": "https://www.example.com"})
            assert "access-control-allow-origin" not in post.headers

    async def test_main_policy_untouched(self):
        app = _cors_app(["https://www.example.com"])
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://api") as client:
            main = await client.get("/catalog", headers={"Origin": "https://cursos.example.com"})
            assert main.headers["access-control-allow-origin"] == "https://cursos.example.com"
            assert main.headers["access-control-allow-credentials"] == "true"
            other = await client.get("/catalog", headers={"Origin": "https://evil.example.org"})
            assert "access-control-allow-origin" not in other.headers

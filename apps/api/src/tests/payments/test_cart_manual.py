"""Sanar y Criar: cart + Pago Móvil purchases confirmed by an admin
(src/services/payments/purchases.py), end to end through the router.

The BCV source and send_email are stubbed: nothing leaves the process. The
money rule under test everywhere: a manual child order only becomes paid when
an admin confirms its purchase.
"""

import asyncio
import os
import re
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import ANY, AsyncMock, patch
from urllib.parse import unquote
from uuid import uuid4

import pytest
from sqlalchemy import event, text
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlmodel import delete, select

from src.db.courses.courses import Course
from src.db.payments.payments import PaymentsConfig, PaymentsEnrollment, PaymentsOrder
from src.db.payments.purchases import PaymentsFxRate, PaymentsPurchase, PaymentsPurchaseItem
from src.db.trail_runs import TrailRun
from src.services.payments import checkout, fx, purchase_emails, reconcile
from src.services.payments import purchases as purchases_module
from src.services.payments.checkout import _capture_lock
from src.services.payments.common import utcnow
from src.services.payments.providers.base import ProviderError, WebhookVerificationError
from src.services.payments.providers.manual import InvalidSetting, ManualProvider, parse_rate_text
from src.services.payments.purchases import expire_due_purchases, normalize_reference
from src.services.payments.schema import ensure_payments_indexes
from src.tests.payments.conftest import ORG_ID, REDIRECT, start_checkout
from src.tests.payments.test_checkout_flow import _checkout_and_approve, hosting  # noqa: F401

BASE = f"/api/v1/payments/{ORG_ID}"
CODE = re.compile(r"^SYC-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$")
BCV = {
    "moneda": "USD", "fuente": "oficial", "nombre": "Dólar", "compra": None, "venta": None,
    "promedio": 887.302, "fechaActualizacion": "2026-10-27T00:00:00-04:00",
}
MANUAL = {
    "enabled": True,
    "bank_name": "Banesco",
    "bank_code": "0134",
    "phone": "0424-1234567",
    "id_document": "V-12345678",
    "holder_name": "Hilda Hernández (borrar)",
    "whatsapp": "584248824634",
    "instructions": "Escribe el código del pedido en el concepto.",
    "payment_window_hours": 24,
    "notify_email": "avisos@example.com",
}
DEFAULT_SETTINGS = {
    "bank_name": "", "bank_code": "", "phone": "", "id_document": "", "holder_name": "",
    "whatsapp": "", "instructions": "", "payment_window_hours": 24,
    "fx_mode": "auto", "fx_manual_rate": None, "notify_email": "",
}


# ---------------------------------------------------------------- fixtures


@pytest.fixture(autouse=True)
def bcv_source():
    """The BCV rate source, never reached: tests set ``payload`` or ``error``."""
    state = SimpleNamespace(payload=dict(BCV), error=None, calls=0)

    async def fake_fetch():
        state.calls += 1
        if state.error is not None:
            raise state.error
        return state.payload

    with patch.object(fx, "fetch_bcv_payload", new=fake_fetch):
        yield state


@pytest.fixture(autouse=True)
async def _drain_emails():
    yield
    await purchase_emails.drain_background_tasks()


@pytest.fixture
async def manual(client, current, admin_user, org_config):
    """Pago Móvil configured and on."""
    current.set(admin_user)
    response = await client.put(f"{BASE}/manual/settings", json=MANUAL)
    assert response.status_code == 200, response.text
    current.set(None)
    return response.json()


@pytest.fixture
async def ebook_course(db, org):
    course = Course(
        id=2, name="Ebook de límites", description="", public=True, published=True,
        open_to_contributors=False, org_id=org.id, course_uuid="course_ebook",
        extra_metadata={"product_type": "ebook"},
        creation_date=str(datetime.now()), update_date=str(datetime.now()),
    )
    db.add(course)
    await db.commit()
    await db.refresh(course)
    return course


async def _new_offer(client, current, admin_user, name: str, amount, course_uuid: str) -> dict:
    current.set(admin_user)
    response = await client.post(f"{BASE}/offers", json={
        "name": name, "description": "", "offer_type": "one_time", "price_type": "fixed_price",
        "amount": amount, "currency": "USD", "resource_uuids": [course_uuid],
    })
    assert response.status_code == 200, response.text
    current.set(None)
    return response.json()


@pytest.fixture
async def ebook_offer(client, current, admin_user, ebook_course, paypal_config):
    return await _new_offer(client, current, admin_user, "Ebook de límites", 15, ebook_course.course_uuid)


@pytest.fixture
async def cart(offer, ebook_offer, manual) -> list[str]:
    """The course (US$ 25) and the ebook (US$ 15), Pago Móvil on, PayPal too."""
    return [offer["offer_uuid"], ebook_offer["offer_uuid"]]


# ----------------------------------------------------------------- helpers


async def _checkout(client, current, user, uuids, **body):
    current.set(user)
    payload = {"offer_uuids": uuids, "provider": "manual", "method": "pago_movil", **body}
    return await client.post(f"{BASE}/cart/checkout", json=payload)


async def _purchase(client, current, user, uuids) -> dict:
    response = await _checkout(client, current, user, uuids)
    assert response.status_code == 201, response.text
    return response.json()


async def _quote(client, current, user, uuids) -> dict:
    current.set(user)
    response = await client.post(f"{BASE}/cart/quote", json={"offer_uuids": uuids})
    assert response.status_code == 200, response.text
    return response.json()


async def _act(client, current, user, purchase: dict, action: str, body: dict):
    current.set(user)
    return await client.post(f"{BASE}/purchases/{purchase['purchase_uuid']}/{action}", json=body)


async def _rows(db, model, *where) -> list:
    stmt = select(model).order_by(model.id).execution_options(populate_existing=True)
    for clause in where:
        stmt = stmt.where(clause)
    return list((await db.execute(stmt)).scalars().all())


async def _emails(sent_emails) -> list[tuple[str, str]]:
    await purchase_emails.drain_background_tasks()
    return sorted((c.kwargs["to"], c.kwargs["subject"]) for c in sent_emails.call_args_list)


async def _access(client, current, user, course) -> dict:
    current.set(user)
    return (await client.get(f"{BASE}/access", params={"resource_uuid": course.course_uuid})).json()


async def _set_settings(client, current, admin_user, body: dict) -> dict:
    current.set(admin_user)
    response = await client.put(f"{BASE}/manual/settings", json=body)
    current.set(None)
    return response


# ---------------------------------------------------------------- settings


class TestManualSettings:
    async def test_defaults_and_todays_rate(self, client, current, admin_user, org_config):
        current.set(admin_user)
        response = await client.get(f"{BASE}/manual/settings")
        assert response.status_code == 200, response.text
        assert response.json() == {
            "enabled": False,
            "active": False,
            "missing": ["bank_name", "bank_code", "phone", "id_document", "whatsapp"],
            "settings": DEFAULT_SETTINGS,
            "fx": {"rate": 887.302, "rate_date": "2026-10-27", "source": "bcv", "fetched_at": ANY,
                   "stale": False, "error": None, "warning": None},
        }

    async def test_only_admins(self, client, current, regular_user, org_config):
        current.set(None)
        assert (await client.get(f"{BASE}/manual/settings")).status_code == 401
        assert (await client.put(f"{BASE}/manual/settings", json={})).status_code == 401
        current.set(regular_user)
        assert (await client.get(f"{BASE}/manual/settings")).status_code == 403
        assert (await client.put(f"{BASE}/manual/settings", json={"enabled": False})).status_code == 403

    async def test_every_field_is_normalized(self, client, current, db, admin_user, org_config):
        response = await _set_settings(client, current, admin_user, {
            "enabled": True,
            "bank_name": "  Banco   Mercantil ",
            "bank_code": " 0105 ",
            "phone": "+58 (424) 123.45.67",
            "id_document": "v-12.345.678",
            "holder_name": "  Hilda   H. ",
            "whatsapp": "0424-882 4634",
            "instructions": "  Línea 1\r\nLínea 2  ",
            "payment_window_hours": "48",
            "fx_mode": "MANUAL",
            "fx_manual_rate": "1.234,56",
            "notify_email": " Avisos@Example.com ",
        })
        assert response.status_code == 200, response.text
        body = response.json()
        assert (body["enabled"], body["active"], body["missing"]) == (True, True, [])
        assert body["settings"] == {
            "bank_name": "Banco Mercantil", "bank_code": "0105", "phone": "0424-1234567",
            "id_document": "V-12345678", "holder_name": "Hilda H.", "whatsapp": "584248824634",
            "instructions": "Línea 1\nLínea 2", "payment_window_hours": 48, "fx_mode": "manual",
            "fx_manual_rate": 1234.56, "notify_email": "avisos@example.com",
        }
        assert body["fx"]["source"] == "manual" and body["fx"]["rate"] == 1234.56 and body["fx"]["rate_date"] is None
        stored = (await _rows(db, PaymentsConfig, PaymentsConfig.provider == "manual"))[0]
        assert stored.provider_config["environment"] == "live"
        assert stored.provider_config["fx_manual_rate"] == "1234.56"

    @pytest.mark.parametrize("raw,expected", [
        ("887,30", 887.3), ("887.30", 887.3), (887.3, 887.3), (900, 900.0), ("1,234.5", 1234.5), ("36,1234", 36.1234),
    ])
    async def test_manual_rate_formats(self, client, current, admin_user, org_config, raw, expected):
        response = await _set_settings(client, current, admin_user, {"fx_mode": "manual", "fx_manual_rate": raw})
        assert response.status_code == 200, response.text
        assert response.json()["settings"]["fx_manual_rate"] == expected

    @pytest.mark.parametrize("field,value", [
        ("bank_name", "B"), ("bank_name", "B" * 61),
        ("bank_code", "134"), ("bank_code", "01345"), ("bank_code", "AB12"),
        ("phone", "0212-1234567"), ("phone", "0424-123"), ("phone", "teléfono"),
        ("id_document", "X-1234567"), ("id_document", "V-1234"), ("id_document", "V-12345678901"),
        ("holder_name", "H" * 81),
        ("whatsapp", "123"), ("whatsapp", "1" * 16), ("whatsapp", "sin número"), ("whatsapp", "4248824634"),
        ("instructions", "x" * 501),
        ("payment_window_hours", 0), ("payment_window_hours", 169), ("payment_window_hours", 24.5),
        ("payment_window_hours", "un día"), ("payment_window_hours", True),
        ("fx_mode", "paralelo"),
        ("fx_manual_rate", "0"), ("fx_manual_rate", "-5"), ("fx_manual_rate", "887,12345"),
        ("fx_manual_rate", "abc"), ("fx_manual_rate", 100000001), ("fx_manual_rate", "1e3"),
        ("notify_email", "no-es-un-correo"), ("notify_email", "a@b"),
        ("enabled", "sí"),
    ])
    async def test_invalid_field(self, client, current, db, admin_user, org_config, field, value):
        body = {field: value}
        if field == "fx_manual_rate":
            body["fx_mode"] = "manual"  # with the BCV rate an invalid manual rate is ignored
        response = await _set_settings(client, current, admin_user, body)
        assert response.status_code == 400, response.text
        detail = response.json()["detail"]
        assert detail["code"] == "INVALID_FIELD" and detail["field"] == field and detail["message"]
        assert await _rows(db, PaymentsConfig) == []

    async def test_field_messages(self, client, current, admin_user, org_config):
        messages = {
            "bank_name": ("B", "Escribe el nombre del banco."),
            "bank_code": ("12", "El código del banco tiene 4 dígitos, por ejemplo 0134."),
            "phone": ("123", "Escribe el teléfono del Pago Móvil, por ejemplo 0424-1234567."),
            "id_document": ("123", "Escribe la cédula o el RIF, por ejemplo V-12345678 o J-412345678."),
            "whatsapp": ("12", "Escribe el WhatsApp con código de país, por ejemplo 58 424 8824634."),
            "payment_window_hours": (0, "El plazo debe estar entre 1 y 168 horas."),
            "fx_manual_rate": ("x", "Escribe la tasa en Bs. por dólar, por ejemplo 887,30."),
            "notify_email": ("x", "Escribe un correo válido."),
        }
        for field, (value, message) in messages.items():
            body = {field: value, **({"fx_mode": "manual"} if field == "fx_manual_rate" else {})}
            response = await _set_settings(client, current, admin_user, body)
            assert response.json()["detail"]["message"] == message, field

    async def test_turning_on_needs_the_required_fields(self, client, current, admin_user, org_config):
        response = await _set_settings(client, current, admin_user, {"enabled": True, "bank_name": "Banesco"})
        assert response.status_code == 400
        assert response.json()["detail"] == {
            "code": "INCOMPLETE",
            "message": "Completa banco, código, teléfono, cédula o RIF y WhatsApp antes de activar Pago Móvil.",
            "missing": ["bank_code", "phone", "id_document", "whatsapp"],
        }
        # While off, partial data is saved and reported as missing.
        saved = await _set_settings(client, current, admin_user, {"bank_name": "Banesco", "bank_code": "0134"})
        assert saved.status_code == 200
        assert (saved.json()["enabled"], saved.json()["active"]) == (False, False)
        assert saved.json()["missing"] == ["phone", "id_document", "whatsapp"]

        on = await _set_settings(client, current, admin_user, MANUAL)
        assert (on.json()["enabled"], on.json()["active"], on.json()["missing"]) == (True, True, [])
        # A required field cannot be cleared while it is on, nor the rate go
        # manual without a rate.
        cleared = await _set_settings(client, current, admin_user, {"whatsapp": ""})
        assert cleared.status_code == 400 and cleared.json()["detail"]["missing"] == ["whatsapp"]
        no_rate = await _set_settings(client, current, admin_user, {"fx_mode": "manual"})
        assert no_rate.status_code == 400 and no_rate.json()["detail"]["missing"] == ["fx_manual_rate"]
        # Omitted fields keep their value; "" clears an optional one.
        off = await _set_settings(client, current, admin_user, {"enabled": False, "holder_name": ""})
        assert off.status_code == 200
        assert (off.json()["enabled"], off.json()["active"]) == (False, True)
        assert off.json()["settings"]["holder_name"] == "" and off.json()["settings"]["bank_name"] == "Banesco"

    async def test_rate_error_is_reported(self, client, current, admin_user, org_config, bcv_source):
        bcv_source.error = RuntimeError("dolarapi down")
        current.set(admin_user)
        fx_block = (await client.get(f"{BASE}/manual/settings")).json()["fx"]
        assert fx_block == {"rate": None, "rate_date": None, "source": "bcv", "fetched_at": None, "stale": False,
                            "error": "No pudimos obtener la tasa del BCV.", "warning": None}


class TestConfigAndProviders:
    async def test_generic_config_routes_leave_the_manual_row_alone(self, client, current, admin_user,
                                                                   paypal_config, manual):
        current.set(admin_user)
        created = await client.post(f"{BASE}/config?provider=manual", json={})
        assert created.status_code == 400
        assert created.json()["detail"] == "Configura Pago Móvil desde su tarjeta en Pagos → Configuración."
        row = next(c for c in (await client.get(f"{BASE}/config")).json() if c["provider"] == "manual")
        assert (row["enabled"], row["active"]) == (True, True)
        assert row["settings"]["bank_name"] == "Banesco" and row["settings"]["environment"] == "live"
        assert "webhook_url" not in row["settings"]
        updated = await client.put(f"{BASE}/config/{row['id']}", json={"enabled": False})
        assert updated.status_code == 400
        assert updated.json()["detail"] == "Configura Pago Móvil desde su tarjeta en Pagos → Configuración."

    async def test_checkout_providers(self, client, current, admin_user, paypal_config):
        assert [p["provider"] for p in (await client.get(f"{BASE}/checkout/providers")).json()] == ["paypal"]
        await _set_settings(client, current, admin_user, MANUAL)
        providers = (await client.get(f"{BASE}/checkout/providers")).json()
        assert providers[1] == {
            "provider": "manual", "label": "Pago Móvil", "environment": "live", "test_mode": False,
            "client_id": None, "methods": ["pago_movil"], "currencies": ["USD"],
        }
        await _set_settings(client, current, admin_user, {"enabled": False})
        assert [p["provider"] for p in (await client.get(f"{BASE}/checkout/providers")).json()] == ["paypal"]


class TestPayPalCheckoutUnaffected:
    async def test_default_provider_is_never_manual(self, client, current, db, outsider, manual, offer):
        configs = await _rows(db, PaymentsConfig)
        assert [c.provider for c in configs] == ["manual", "paypal"]  # manual has the lower id
        current.set(outsider)
        response = await client.post(f"{BASE}/offers/{offer['offer_uuid']}/checkout", params={"redirect_uri": REDIRECT})
        assert response.status_code == 200, response.text
        assert response.json()["provider"] == "paypal"

    async def test_manual_provider_is_refused(self, client, current, db, outsider, manual, offer):
        current.set(outsider)
        response = await client.post(
            f"{BASE}/offers/{offer['offer_uuid']}/checkout",
            params={"redirect_uri": REDIRECT, "provider": "manual", "method": "pago_movil"},
        )
        assert response.status_code == 400
        assert response.json()["detail"]["message"] == "Pago Móvil se paga desde el carrito."
        assert await _rows(db, PaymentsOrder) == []

    async def test_with_paypal_off_there_is_no_offer_checkout(self, client, current, db, admin_user, outsider,
                                                              offer, manual):
        current.set(admin_user)
        paypal = next(c for c in (await client.get(f"{BASE}/config")).json() if c["provider"] == "paypal")
        assert (await client.put(f"{BASE}/config/{paypal['id']}", json={"enabled": False})).status_code == 200
        current.set(outsider)
        response = await client.post(f"{BASE}/offers/{offer['offer_uuid']}/checkout", params={"redirect_uri": REDIRECT})
        assert response.status_code == 400
        assert response.json()["detail"] == "Los pagos no están configurados en este momento"
        assert await _rows(db, PaymentsOrder) == []

    async def test_paypal_charges_have_no_purchase_code(self, client, current, admin_user, outsider, offer,
                                                        fake_paypal):
        data, _ = await _checkout_and_approve(client, current, outsider, offer, fake_paypal)
        captured = await client.post(f"{BASE}/orders/{data['order_uuid']}/capture")
        assert captured.json()["status"] == "paid" and captured.json()["purchase"] is None
        current.set(admin_user)
        charge = (await client.get(f"{BASE}/transactions")).json()["data"][0]
        assert charge["provider"] == "paypal" and charge["purchase_code"] is None
        assert (await client.get(f"{BASE}/customers")).json()[0]["payment"]["purchase_code"] is None
        assert (await client.get(f"{BASE}/overview")).json()["recent_charges"][0]["purchase_code"] is None


# ------------------------------------------------------------------- quote


class TestQuote:
    async def test_anonymous_quote(self, client, current, cart):
        body = await _quote(client, current, None, [*cart, "no-existe", cart[0]])
        assert [i["status"] for i in body["items"]] == ["available", "available", "unavailable"]
        course_item, ebook_item, unknown = body["items"]
        assert course_item == {
            "offer_uuid": cart[0], "name": "Curso completo", "description": "Todo el curso", "amount": 25.0,
            "currency": "USD", "thumbnail_url": None, "status": "available",
            "resources": [{"course_uuid": "course_test", "name": "Test Course", "product_type": "course",
                           "thumbnail_url": None}],
        }
        assert ebook_item["resources"][0]["product_type"] == "ebook" and ebook_item["amount"] == 15.0
        assert unknown == {
            "offer_uuid": "no-existe", "name": None, "description": None, "amount": None, "currency": None,
            "thumbnail_url": None, "resources": [], "status": "unavailable",
        }
        assert (body["count"], body["total"], body["currency"]) == (2, 40.0, "USD")
        assert body["pago_movil"] == {
            "enabled": True, "rate": 887.302, "rate_date": "2026-10-27", "rate_source": "bcv",
            "amount_ves": 35492.08, "error": None,
        }
        assert body["paypal"] == {"enabled": True}

    async def test_empty_and_too_large(self, client, current, cart):
        empty = await _quote(client, current, None, [])
        assert (empty["items"], empty["count"], empty["total"]) == ([], 0, 0.0)
        current.set(None)
        too_many = await client.post(f"{BASE}/cart/quote", json={"offer_uuids": [str(uuid4()) for _ in range(21)]})
        assert too_many.status_code == 400
        assert too_many.json()["detail"] == {"code": "CART_TOO_LARGE",
                                             "message": "Puedes pagar hasta 20 productos por pedido."}
        # Thirty copies of one product are one product.
        assert (await _quote(client, current, None, [cart[0]] * 30))["count"] == 1

    async def test_owned_and_pending_items(self, client, current, db, outsider, cart, offer, ebook_offer):
        db.add(PaymentsEnrollment(enrollment_uuid=str(uuid4()), offer_id=offer["id"], user_id=outsider.id,
                                  org_id=ORG_ID, status="active", provider_specific_data={}))
        await db.commit()
        purchase = await _purchase(client, current, outsider, [ebook_offer["offer_uuid"]])
        body = await _quote(client, current, outsider, cart)
        assert [i["status"] for i in body["items"]] == ["owned", "pending"]
        assert "pending_purchase" not in body["items"][0]
        assert body["items"][1]["pending_purchase"] == {"purchase_uuid": purchase["purchase_uuid"],
                                                        "code": purchase["code"]}
        assert (body["count"], body["total"], body["pago_movil"]["amount_ves"]) == (0, 0.0, 0.0)
        # Without a session the same cart is simply available.
        assert [i["status"] for i in (await _quote(client, current, None, cart))["items"]] == ["available"] * 2

    async def test_open_paypal_order_is_pending_without_purchase(self, client, current, db, outsider, cart, offer,
                                                                 fake_paypal):
        await start_checkout(client, current, outsider, offer)
        order = (await _rows(db, PaymentsOrder))[0]
        order.status = "approved"
        db.add(order)
        await db.commit()
        item = (await _quote(client, current, outsider, cart))["items"][0]
        assert item["status"] == "pending" and item["pending_purchase"] is None

    async def test_admins_can_try_the_flow(self, client, current, admin_user, cart):
        body = await _quote(client, current, admin_user, cart)
        assert [i["status"] for i in body["items"]] == ["available", "available"]

    async def test_unlisted_and_archived_offers_say_nothing(self, client, current, admin_user, cart, offer,
                                                            ebook_offer):
        current.set(admin_user)
        await client.put(f"{BASE}/offers/{offer['id']}", json={"is_publicly_listed": False})
        await client.delete(f"{BASE}/offers/{ebook_offer['id']}")
        items = (await _quote(client, current, None, cart))["items"]
        assert [(i["status"], i["name"], i["amount"]) for i in items] == [("unavailable", None, None)] * 2

    async def test_rate_down_and_pago_movil_off(self, client, current, db, admin_user, cart, bcv_source):
        bcv_source.error = RuntimeError("down")
        stale = (await _quote(client, current, None, cart))["pago_movil"]
        assert stale["rate"] == 887.302 and stale["error"] is None  # the stored rate, under 96 h old
        await db.execute(delete(PaymentsFxRate))
        await db.commit()
        body = await _quote(client, current, None, cart)
        assert body["pago_movil"] == {"enabled": True, "rate": None, "rate_date": None, "rate_source": None,
                                      "amount_ves": None, "error": "FX_UNAVAILABLE"}
        assert body["total"] == 40.0
        await _set_settings(client, current, admin_user, {"enabled": False})
        assert (await _quote(client, current, None, cart))["pago_movil"] == {"enabled": False}

    async def test_manual_rate(self, client, current, admin_user, cart, bcv_source):
        saved = await _set_settings(client, current, admin_user, {"fx_mode": "manual", "fx_manual_rate": "900,5"})
        assert saved.status_code == 200, saved.text
        calls = bcv_source.calls
        pago_movil = (await _quote(client, current, None, cart))["pago_movil"]
        assert pago_movil == {"enabled": True, "rate": 900.5, "rate_date": None, "rate_source": "manual",
                              "amount_ves": 36020.0, "error": None}
        assert bcv_source.calls == calls


# ---------------------------------------------------------------- checkout


class TestCheckout:
    async def test_creates_the_purchase(self, client, current, db, outsider, cart, course, activity, sent_emails):
        response = await _checkout(client, current, outsider, cart)
        assert response.status_code == 201, response.text
        body = response.json()
        assert CODE.match(body["code"]) and re.fullmatch(r"[0-9a-f]{32}", body["purchase_uuid"])
        assert (body["status"], body["provider"], body["method"], body["currency"]) == (
            "pending", "manual", "pago_movil", "USD",
        )
        assert (body["amount"], body["amount_ves"], body["fx_rate"], body["fx_source"], body["fx_date"]) == (
            40.0, 35492.08, 887.302, "bcv", "2026-10-27",
        )
        assert (body["closed_at"], body["confirmed_at"], body["reject_reason"], body["can_cancel"]) == (
            None, None, None, True,
        )
        lasts = datetime.fromisoformat(body["expires_at"]) - datetime.fromisoformat(body["created_at"])
        assert timedelta(hours=23, minutes=59) < lasts < timedelta(hours=24, minutes=1)
        assert [(i["name"], i["amount"]) for i in body["items"]] == [("Curso completo", 25.0), ("Ebook de límites", 15.0)]
        resource = body["items"][0]["resources"][0]
        assert resource["resource_uuid"] == resource["course_uuid"] == course.course_uuid
        assert resource["first_activity_uuid"] == activity.activity_uuid
        assert resource["course_url"].endswith("/course/test") and resource["product_type"] == "course"
        assert body["items"][1]["resources"][0]["product_type"] == "ebook"
        assert body["payment"] == {
            "bank_name": "Banesco", "bank_code": "0134", "phone": "0424-1234567", "id_document": "V-12345678",
            "holder_name": "Hilda Hernández (borrar)", "instructions": "Escribe el código del pedido en el concepto.",
        }
        assert body["whatsapp_number"] == "584248824634"
        assert body["whatsapp_url"].startswith("https://wa.me/584248824634?text=")
        assert unquote(body["whatsapp_url"].split("?text=", 1)[1]) == (
            f"Hola, hice un Pago Móvil para mi pedido {body['code']} en Sanar y Criar.\n"
            "Monto: Bs. 35.492,08 (US$ 40,00)\n"
            "Productos: Curso completo, Ebook de límites\n"
            "Nombre: Outsider Test\n"
            "Te envío el comprobante."
        )
        assert "customer" not in body and "bank_reference" not in body

        purchase = (await _rows(db, PaymentsPurchase))[0]
        assert (purchase.amount, purchase.amount_ves, purchase.fx_rate) == (
            Decimal("40.00"), Decimal("35492.08"), Decimal("887.302"),
        )
        assert purchase.payment_details["whatsapp"] == "584248824634" and purchase.user_id == outsider.id
        orders = await _rows(db, PaymentsOrder)
        assert [(o.provider, o.method, o.status, o.amount, o.currency, o.provider_order_id) for o in orders] == [
            ("manual", "pago_movil", "pending", Decimal("25.00"), "USD", None),
            ("manual", "pago_movil", "pending", Decimal("15.00"), "USD", None),
        ]
        for order in orders:
            assert order.fx_rate == Decimal("887.302")
            assert order.raw == {"environment": "live", "purchase_code": body["code"],
                                 "purchase_uuid": body["purchase_uuid"]}
        items = await _rows(db, PaymentsPurchaseItem)
        assert [i.order_id for i in items] == [o.id for o in orders]
        assert [e.status for e in await _rows(db, PaymentsEnrollment)] == ["pending", "pending"]

        assert await _emails(sent_emails) == sorted([
            ("outsider@test.com", f"Tu pedido {body['code']}: datos para pagar con Pago Móvil"),
            ("avisos@example.com", f"Nuevo pedido {body['code']} por confirmar"),
        ])
        documents = {c.kwargs["to"]: c.kwargs["body"] for c in sent_emails.call_args_list}
        buyer_email = documents["outsider@test.com"]
        assert "Bs. 35.492,08" in buyer_email and "Enviar comprobante por WhatsApp" in buyer_email
        assert f"/store/purchases/{body['purchase_uuid']}" in buyer_email and "Banesco (0134)" in buyer_email
        assert "Tasa BCV del 27/10/2026: 887,30 Bs. por US$" in buyer_email
        assert f'<span style="white-space: nowrap;">{body["code"]}</span>' in buyer_email
        assert f"/dash/orders?code={body['code']}" in documents["avisos@example.com"]
        assert f'Nuevo pedido <span style="white-space: nowrap;">{body["code"]}</span>' in documents["avisos@example.com"]

    async def test_bolivares_are_rounded_half_up(self, client, current, db, admin_user, outsider, course, manual,
                                                 bcv_source):
        # A different rate (the stored 887,302 would make it fail the 50 % check).
        await db.execute(delete(PaymentsFxRate))
        await db.commit()
        bcv_source.payload = {**BCV, "promedio": 36.123456, "fechaActualizacion": "2026-10-28T00:00:00-04:00"}
        offer = await _new_offer(client, current, admin_user, "Taller", "19.99", course.course_uuid)
        body = await _purchase(client, current, outsider, [offer["offer_uuid"]])
        assert (body["amount"], body["fx_rate"], body["amount_ves"]) == (19.99, 36.123456, 722.11)

    async def test_requires_a_session(self, client, current, cart):
        assert (await _checkout(client, current, None, cart)).status_code == 401

    @pytest.mark.parametrize("override", [{"provider": "paypal"}, {"method": "card"}, {"provider": None}])
    async def test_only_pago_movil(self, client, current, outsider, cart, override):
        response = await _checkout(client, current, outsider, cart, **override)
        assert response.status_code == 400
        assert response.json()["detail"] == {"code": "METHOD_UNAVAILABLE",
                                             "message": "Pago Móvil no está disponible en este momento."}

    async def test_pago_movil_off(self, client, current, admin_user, outsider, cart):
        await _set_settings(client, current, admin_user, {"enabled": False})
        response = await _checkout(client, current, outsider, cart)
        assert response.status_code == 400 and response.json()["detail"]["code"] == "METHOD_UNAVAILABLE"

    async def test_cart_size_and_availability(self, client, current, db, outsider, cart):
        empty = await _checkout(client, current, outsider, [])
        assert empty.status_code == 400
        assert empty.json()["detail"] == {"code": "EMPTY_CART", "message": "Tu carrito está vacío."}
        too_many = await _checkout(client, current, outsider, [str(uuid4()) for _ in range(21)])
        assert too_many.status_code == 400 and too_many.json()["detail"]["code"] == "CART_TOO_LARGE"
        unknown = await _checkout(client, current, outsider, [*cart, "no-existe"])
        assert unknown.status_code == 400
        assert unknown.json()["detail"] == {"code": "OFFER_UNAVAILABLE",
                                            "message": "Algunos productos ya no están disponibles.",
                                            "offer_uuids": ["no-existe"]}
        assert await _rows(db, PaymentsPurchase) == []
        # Duplicates count once.
        body = await _purchase(client, current, outsider, [cart[0], cart[0], cart[1]])
        assert len(body["items"]) == 2

    async def test_already_owned(self, client, current, db, outsider, cart, offer):
        db.add(PaymentsEnrollment(enrollment_uuid=str(uuid4()), offer_id=offer["id"], user_id=outsider.id,
                                  org_id=ORG_ID, status="active", provider_specific_data={}))
        await db.commit()
        response = await _checkout(client, current, outsider, cart)
        assert response.status_code == 409
        assert response.json()["detail"] == {"code": "ALREADY_OWNED",
                                             "message": "Ya tienes acceso a algunos productos del carrito.",
                                             "offer_uuids": [offer["offer_uuid"]]}
        assert await _rows(db, PaymentsPurchase) == []

    async def test_a_pending_purchase_blocks_its_products(self, client, current, outsider, cart, ebook_offer):
        first = await _purchase(client, current, outsider, [ebook_offer["offer_uuid"]])
        response = await _checkout(client, current, outsider, cart)
        assert response.status_code == 409
        assert response.json()["detail"] == {
            "code": "PAYMENT_PENDING", "message": "Ya tienes un pedido pendiente con estos productos.",
            "offer_uuids": [ebook_offer["offer_uuid"]],
            "purchase_uuid": first["purchase_uuid"], "purchase_code": first["code"],
        }

    async def test_an_open_paypal_order_blocks_its_product(self, client, current, db, outsider, cart, offer,
                                                          fake_paypal):
        paypal = (await start_checkout(client, current, outsider, offer)).json()
        order = (await _rows(db, PaymentsOrder))[0]
        order.status = "approved"
        db.add(order)
        await db.commit()
        detail = (await _checkout(client, current, outsider, cart)).json()["detail"]
        assert detail["code"] == "PAYMENT_PENDING" and detail["order_uuid"] == paypal["order_uuid"]
        assert detail["offer_uuids"] == [offer["offer_uuid"]] and "purchase_code" not in detail

    async def test_three_pending_purchases_at_most(self, client, current, db, admin_user, outsider, course, manual):
        offers = [await _new_offer(client, current, admin_user, f"Oferta {n}", 10, course.course_uuid)
                  for n in range(4)]
        for offer in offers[:3]:
            await _purchase(client, current, outsider, [offer["offer_uuid"]])
        response = await _checkout(client, current, outsider, [offers[3]["offer_uuid"]])
        assert response.status_code == 409
        assert response.json()["detail"] == {
            "code": "TOO_MANY_PENDING",
            "message": "Tienes varios pedidos sin pagar. Págalos o cancélalos antes de hacer otro.",
        }
        # One of them expiring frees a slot.
        oldest = (await _rows(db, PaymentsPurchase))[0]
        oldest.expires_at = utcnow() - timedelta(minutes=1)
        db.add(oldest)
        await db.commit()
        assert (await _checkout(client, current, outsider, [offers[3]["offer_uuid"]])).status_code == 201

    async def test_rate_unavailable(self, client, current, db, outsider, cart, bcv_source):
        await db.execute(delete(PaymentsFxRate))
        await db.commit()
        bcv_source.error = RuntimeError("down")
        response = await _checkout(client, current, outsider, cart)
        assert response.status_code == 503
        assert response.json()["detail"] == {
            "code": "FX_UNAVAILABLE",
            "message": "No pudimos obtener la tasa del BCV. Intenta de nuevo en unos minutos.",
        }
        assert await _rows(db, PaymentsPurchase) == [] and await _rows(db, PaymentsOrder) == []

    async def test_a_recent_stored_rate_still_sells(self, client, current, db, outsider, cart, bcv_source):
        bcv_source.error = RuntimeError("down")
        body = await _purchase(client, current, outsider, cart)
        assert body["fx_rate"] == 887.302
        assert (await _rows(db, PaymentsPurchase))[0].raw["fx_stale"] is True

    async def test_one_checkout_at_a_time_per_buyer(self, client, current, db, outsider, cart):
        current.set(outsider)
        body = {"offer_uuids": cart, "provider": "manual", "method": "pago_movil"}
        async with _capture_lock(f"cart:{outsider.id}"):
            task = asyncio.create_task(client.post(f"{BASE}/cart/checkout", json=body))
            await asyncio.sleep(0.05)
            assert not task.done()
        assert (await task).status_code == 201
        # A double click: the second request finds the first purchase.
        again = await client.post(f"{BASE}/cart/checkout", json=body)
        assert again.status_code == 409 and again.json()["detail"]["code"] == "PAYMENT_PENDING"
        assert len(await _rows(db, PaymentsPurchase)) == 1


# ------------------------------------------------- other entry points


class TestOtherEntryPoints:
    async def test_paywall_names_the_pending_purchase(self, client, current, outsider, cart, course):
        purchase = await _purchase(client, current, outsider, cart)
        access = await _access(client, current, outsider, course)
        assert (access["has_access"], access["payment_pending"]) == (False, True)
        assert access["pending_purchase"] == {"purchase_uuid": purchase["purchase_uuid"], "code": purchase["code"]}

    async def test_order_endpoints_never_pay_a_child(self, client, current, db, outsider, cart, offer, course):
        purchase = await _purchase(client, current, outsider, cart)
        child = purchase["items"][0]["order_uuid"]
        reference = {"purchase_uuid": purchase["purchase_uuid"], "code": purchase["code"]}
        current.set(outsider)
        captured = await client.post(f"{BASE}/orders/{child}/capture")
        assert captured.status_code == 200
        assert captured.json()["status"] == "pending" and captured.json()["purchase"] == reference
        current.set(None)  # the uuid alone (expired session) changes nothing either
        assert (await client.post(f"{BASE}/orders/{child}/capture")).json()["status"] == "pending"
        current.set(outsider)
        assert (await client.get(f"{BASE}/orders/{child}")).json()["status"] == "pending"
        assert (await client.post(f"{BASE}/orders/{child}/cancel")).json()["status"] == "pending"
        assert {o.status for o in await _rows(db, PaymentsOrder)} == {"pending"}
        assert (await _access(client, current, outsider, course))["has_access"] is False
        # A PayPal checkout of the same offer points at the purchase.
        again = await start_checkout(client, current, outsider, offer)
        assert again.status_code == 409
        assert again.json()["detail"] == {"code": "PAYMENT_PENDING", "order_uuid": child,
                                          "purchase_uuid": purchase["purchase_uuid"], "purchase_code": purchase["code"]}

    async def test_manual_webhooks_are_rejected(self, client, db, cart):
        response = await client.post(f"/api/v1/payments/webhooks/manual/{ORG_ID}", content=b'{"id":"WH-1"}',
                                     headers={"content-type": "application/json"})
        assert response.status_code == 400

    async def test_reconciliation_leaves_children_alone(self, client, current, db, outsider, cart):
        from src.services.payments.reconcile import reconcile_once, reconcile_refunds_once

        await _purchase(client, current, outsider, cart)
        assert await reconcile_once(db) == {"checked": 0, "paid": 0, "expired": 0, "errors": 0}
        assert await reconcile_refunds_once(db, delay=0) == {"checked": 0, "revoked": 0, "errors": 0}
        assert {o.status for o in await _rows(db, PaymentsOrder)} == {"pending"}

    async def test_provider_never_reports_paid(self):
        provider = ManualProvider()
        for status in ("paid", "accredited", "pending", "approved", "created", "failed", "expired",
                       "cancelled", "refunded"):
            order = SimpleNamespace(status=status, failure_reason=None)
            assert (await provider.confirm(None, order, {})).status != "paid"
            assert (await provider.fetch_status(None, order)).status != "paid"
        pending = SimpleNamespace(status="pending", failure_reason=None)
        assert (await provider.confirm(None, pending, {})).status == "pending"
        with pytest.raises(ProviderError) as exc:
            await provider.create_checkout(None, None, None, None, return_url="", cancel_url="", method="pago_movil")
        assert exc.value.code == "MANUAL_ONLY"
        with pytest.raises(WebhookVerificationError):
            await provider.handle_webhook(None, None)
        assert await provider.get_capture_status(None, "REF") is None


# ------------------------------------------------------------------- reads


class TestPurchaseReads:
    async def test_buyer_admin_and_everyone_else(self, client, current, outsider, regular_user, admin_user, cart):
        purchase = await _purchase(client, current, outsider, cart)
        path = f"{BASE}/purchases/{purchase['purchase_uuid']}"
        current.set(outsider)
        mine = (await client.get(path)).json()
        assert mine["code"] == purchase["code"] and "customer" not in mine
        current.set(regular_user)
        response = await client.get(path)
        assert response.status_code == 404
        assert response.json()["detail"] == {"code": "NOT_FOUND", "message": "No encontramos este pedido."}
        current.set(None)
        assert (await client.get(path)).status_code == 401
        current.set(admin_user)
        view = (await client.get(path)).json()
        assert view["customer"] == {
            "user_id": outsider.id, "user_uuid": "user_outsider", "username": "outsider",
            "first_name": "Outsider", "last_name": "Test", "email": "outsider@test.com",
        }
        assert (view["bank_reference"], view["note"], view["confirmed_by"], view["reference_reused_in"]) == (
            None, None, None, [],
        )
        assert (await client.get(f"{BASE}/purchases/{'0' * 32}")).status_code == 404
        assert (await client.get(f"/api/v1/payments/2/purchases/{purchase['purchase_uuid']}")).status_code == 404

    async def test_mine_newest_first_and_only_mine(self, client, current, admin_user, outsider, regular_user,
                                                   course, manual):
        offers = [await _new_offer(client, current, admin_user, f"Oferta {n}", 10, course.course_uuid)
                  for n in range(3)]
        first = await _purchase(client, current, outsider, [offers[0]["offer_uuid"]])
        second = await _purchase(client, current, outsider, [offers[1]["offer_uuid"]])
        await _purchase(client, current, regular_user, [offers[2]["offer_uuid"]])
        current.set(outsider)
        items = (await client.get(f"{BASE}/purchases/mine")).json()["items"]
        assert [i["code"] for i in items] == [second["code"], first["code"]]
        current.set(None)
        assert (await client.get(f"{BASE}/purchases/mine")).status_code == 401

    async def test_buyer_cancels(self, client, current, db, outsider, regular_user, admin_user, cart):
        purchase = await _purchase(client, current, outsider, cart)
        assert (await _act(client, current, regular_user, purchase, "cancel", {})).status_code == 404
        assert (await _act(client, current, admin_user, purchase, "cancel", {})).status_code == 404
        response = await _act(client, current, outsider, purchase, "cancel", {})
        assert response.status_code == 200
        body = response.json()
        assert (body["status"], body["can_cancel"], body["payment"], body["whatsapp_url"]) == (
            "cancelled", False, None, None,
        )
        assert body["closed_at"]
        assert {(o.status, o.failure_reason) for o in await _rows(db, PaymentsOrder)} == {
            ("cancelled", "cancelled_by_user"),
        }
        assert {e.status for e in await _rows(db, PaymentsEnrollment)} == {"cancelled"}
        again = await _act(client, current, outsider, purchase, "cancel", {})
        assert again.status_code == 409
        assert again.json()["detail"] == {"code": "NOT_PENDING", "message": "Este pedido ya no está pendiente.",
                                          "status": "cancelled"}
        # The products can be bought again (the enrollment rows are reused).
        assert (await _checkout(client, current, outsider, cart)).status_code == 201
        assert len(await _rows(db, PaymentsEnrollment)) == 2


# ----------------------------------------------------------------- confirm


class TestConfirm:
    async def test_grants_course_and_ebook_with_one_email(self, client, current, db, admin_user, outsider, cart,
                                                          course, ebook_course, sent_emails):
        purchase = await _purchase(client, current, outsider, cart)
        await _emails(sent_emails)
        sent_emails.reset_mock()

        response = await _act(client, current, admin_user, purchase, "confirm",
                              {"bank_reference": " 0012-3456.78 ", "note": "Visto en Banesco"})
        assert response.status_code == 200, response.text
        body = response.json()
        assert (body["status"], body["bank_reference"], body["note"], body["can_cancel"], body["payment"]) == (
            "paid", "0012345678", "Visto en Banesco", False, None,
        )
        assert body["confirmed_by"] == {"user_id": admin_user.id, "username": "admin", "name": "Admin User"}
        assert body["confirmed_at"] and body["closed_at"]
        orders = await _rows(db, PaymentsOrder)
        assert {(o.status, o.provider_capture_id, o.charged_currency) for o in orders} == {
            ("paid", "0012345678", "USD"),
        }
        assert all(o.charged_amount == o.amount and o.paid_at for o in orders)
        assert {e.status for e in await _rows(db, PaymentsEnrollment)} == {"active"}
        for resource in (course, ebook_course):
            access = await _access(client, current, outsider, resource)
            assert (access["has_access"], access["reason"]) == (True, "purchased")
        runs = await _rows(db, TrailRun, TrailRun.user_id == outsider.id)
        assert {r.course_id for r in runs} == {course.id, ebook_course.id}
        assert await _emails(sent_emails) == [("outsider@test.com", f"Ya tienes acceso: pedido {purchase['code']}")]
        document = sent_emails.call_args.kwargs["body"]
        assert "Test Course" in document and "Ebook de límites" in document and "(ebook)" in document
        assert "Empezar ahora" in document

        # Confirming again changes nothing and sends nothing.
        again = await _act(client, current, admin_user, purchase, "confirm", {"bank_reference": "OTRA-REF-99"})
        assert again.status_code == 200 and again.json()["bank_reference"] == "0012345678"
        assert len(await _emails(sent_emails)) == 1
        assert len(await _rows(db, TrailRun, TrailRun.user_id == outsider.id)) == 2

        # Customers and transactions point at the purchase.
        current.set(admin_user)
        charges = (await client.get(f"{BASE}/transactions")).json()["data"]
        assert {(c["provider"], c["purchase_code"], c["paid"]) for c in charges} == {("manual", purchase["code"], True)}
        customers = (await client.get(f"{BASE}/customers")).json()
        assert {(c["payment"]["provider"], c["payment"]["purchase_code"]) for c in customers} == {
            ("manual", purchase["code"]),
        }
        assert (await client.get(f"{BASE}/overview")).json()["total_revenue"] == 40.0
        # The buyer's view.
        current.set(outsider)
        mine = (await client.get(f"{BASE}/purchases/{purchase['purchase_uuid']}")).json()
        assert (mine["status"], mine["whatsapp_url"]) == ("paid", None) and "bank_reference" not in mine
        mine_list = (await client.get(f"{BASE}/enrollments/mine")).json()
        assert {(e["status"], e["provider"]) for e in mine_list} == {("active", "manual")}

    async def test_a_crash_half_way_is_healed_by_confirming_again(self, client, current, db, admin_user, outsider,
                                                                  cart, ebook_course, sent_emails):
        from src.services.payments import purchases as purchases_module

        purchase = await _purchase(client, current, outsider, cart)
        await _emails(sent_emails)
        sent_emails.reset_mock()
        # The app shares this test's session: its rollback after the failure
        # expires the fixture's ORM objects, so keep plain values.
        ebook = SimpleNamespace(course_uuid=ebook_course.course_uuid)
        real_fulfill = purchases_module.fulfill_order
        calls = []

        async def flaky_fulfill(db_session, order_id, result=None, **kwargs):
            calls.append(order_id)
            if len(calls) == 2:
                raise RuntimeError("database hiccup")
            return await real_fulfill(db_session, order_id, result, **kwargs)

        with patch.object(purchases_module, "fulfill_order", new=flaky_fulfill):
            first = await _act(client, current, admin_user, purchase, "confirm", {"bank_reference": "31415926"})
        # That request's rollback expired the rows memoized on the (shared)
        # session by org_auth.get_user_org; a real request has its own session.
        db._user_org_cache = {}
        assert first.status_code == 500
        assert first.json()["detail"]["code"] == "FULFILLMENT_INCOMPLETE"
        assert (await _rows(db, PaymentsPurchase))[0].status == "paid"
        assert [o.status for o in await _rows(db, PaymentsOrder)] == ["paid", "pending"]
        assert (await _access(client, current, outsider, ebook))["has_access"] is False
        assert await _emails(sent_emails) == []  # no "ya tienes acceso" while something is missing
        current.set(admin_user)
        assert (await client.get(f"{BASE}/purchases/{purchase['purchase_uuid']}")).json()["needs_fulfillment"] is True

        healed = await _act(client, current, admin_user, purchase, "confirm", {"bank_reference": "31415926"})
        assert healed.status_code == 200 and healed.json()["status"] == "paid"
        assert [o.status for o in await _rows(db, PaymentsOrder)] == ["paid", "paid"]
        assert (await _access(client, current, outsider, ebook))["has_access"] is True
        assert healed.json()["needs_fulfillment"] is False
        assert await _emails(sent_emails) == [("outsider@test.com", f"Ya tienes acceso: pedido {purchase['code']}")]

    @pytest.mark.parametrize("reference", ["", "12", "A B", "ÑANDU123", "1" * 31, None, 12, "REF#1234"])
    async def test_invalid_reference(self, client, current, db, admin_user, outsider, cart, reference):
        purchase = await _purchase(client, current, outsider, cart)
        response = await _act(client, current, admin_user, purchase, "confirm", {"bank_reference": reference})
        assert response.status_code == 400
        assert response.json()["detail"] == {"code": "INVALID_REFERENCE",
                                             "message": "La referencia debe tener entre 4 y 30 letras o números."}
        assert (await _rows(db, PaymentsPurchase))[0].status == "pending"

    def test_reference_normalization(self):
        assert normalize_reference(" 12-34.56 78 ") == "12345678"
        assert normalize_reference("abc123") == "ABC123"
        assert normalize_reference(123456) == "123456"
        assert normalize_reference("1" * 30) == "1" * 30
        assert normalize_reference("12\t34") == "1234"

    async def test_reference_used_in_another_paid_purchase(self, client, current, db, admin_user, outsider,
                                                          regular_user, cart):
        first = await _purchase(client, current, outsider, cart)
        second = await _purchase(client, current, regular_user, cart)
        ok = await _act(client, current, admin_user, first, "confirm", {"bank_reference": "REF-1234"})
        assert ok.status_code == 200
        used = await _act(client, current, admin_user, second, "confirm", {"bank_reference": "ref.1234"})
        assert used.status_code == 409
        assert used.json()["detail"] == {"code": "REFERENCE_USED",
                                         "message": "Esa referencia ya se usó en otro pedido pagado.",
                                         "purchases": [first["code"]]}
        current.set(admin_user)
        assert (await client.get(f"{BASE}/purchases/{second['purchase_uuid']}")).json()["status"] == "pending"

        forced = await _act(client, current, admin_user, second, "confirm",
                            {"bank_reference": "ref1234", "allow_reused_reference": True})
        assert forced.status_code == 200
        assert (forced.json()["status"], forced.json()["reference_reused_in"]) == ("paid", [first["code"]])
        row = (await _rows(db, PaymentsPurchase, PaymentsPurchase.code == second["code"]))[0]
        assert row.raw["reference_reused"] == [first["code"]]
        current.set(admin_user)
        first_view = (await client.get(f"{BASE}/purchases/{first['purchase_uuid']}")).json()
        assert first_view["reference_reused_in"] == [second["code"]]

    async def test_an_expired_purchase_can_be_confirmed(self, client, current, db, admin_user, outsider, cart,
                                                        course):
        purchase = await _purchase(client, current, outsider, cart)
        row = (await _rows(db, PaymentsPurchase))[0]
        row.expires_at = utcnow() - timedelta(minutes=1)
        db.add(row)
        await db.commit()
        current.set(admin_user)
        view = (await client.get(f"{BASE}/purchases/{purchase['purchase_uuid']}")).json()
        assert view["status"] == "expired" and view["payment"]["bank_name"] == "Banesco" and view["whatsapp_url"]
        response = await _act(client, current, admin_user, purchase, "confirm", {"bank_reference": "99887766"})
        assert response.status_code == 200 and response.json()["status"] == "paid"
        assert (await _access(client, current, outsider, course))["has_access"] is True
        assert (await _rows(db, PaymentsPurchase))[0].raw["confirmed_from"] == "expired"

    async def test_rejected_and_cancelled_can_be_confirmed(self, client, current, db, admin_user, outsider,
                                                           regular_user, cart, course):
        rejected = await _purchase(client, current, outsider, cart)
        await _act(client, current, admin_user, rejected, "reject", {"reason": "No vimos el pago."})
        assert {e.status for e in await _rows(db, PaymentsEnrollment, PaymentsEnrollment.user_id == outsider.id)} == {"failed"}
        ok = await _act(client, current, admin_user, rejected, "confirm", {"bank_reference": "11223344"})
        assert ok.json()["status"] == "paid"
        assert (await _access(client, current, outsider, course))["has_access"] is True

        cancelled = await _purchase(client, current, regular_user, cart)
        await _act(client, current, regular_user, cancelled, "cancel", {})
        ok = await _act(client, current, admin_user, cancelled, "confirm", {"bank_reference": "55667788"})
        assert ok.json()["status"] == "paid"
        assert {e.status for e in await _rows(db, PaymentsEnrollment, PaymentsEnrollment.user_id == regular_user.id)} == {"active"}

    async def test_only_admins_act(self, client, current, db, outsider, regular_user, cart):
        purchase = await _purchase(client, current, outsider, cart)
        for user, status in ((outsider, 403), (regular_user, 403), (None, 401)):
            for action, body in (("confirm", {"bank_reference": "12345678"}), ("reject", {"reason": "No llegó"}),
                                 ("void", {"reason": "Por error"})):
                assert (await _act(client, current, user, purchase, action, body)).status_code == status, (user, action)
        assert (await _rows(db, PaymentsPurchase))[0].status == "pending"


# ------------------------------------------------------------ reject, void


class TestReject:
    async def test_reject_notifies_once(self, client, current, db, admin_user, outsider, cart, sent_emails):
        purchase = await _purchase(client, current, outsider, cart)
        await _emails(sent_emails)
        sent_emails.reset_mock()
        for reason in ("no", "x" * 301, "", None):
            response = await _act(client, current, admin_user, purchase, "reject", {"reason": reason})
            assert response.status_code == 400
            assert response.json()["detail"] == {"code": "INVALID_REASON",
                                                 "message": "Escribe un motivo de 3 a 300 caracteres."}
        response = await _act(client, current, admin_user, purchase, "reject",
                              {"reason": "No vimos el pago en el banco."})
        assert response.status_code == 200
        body = response.json()
        assert (body["status"], body["reject_reason"], body["payment"], body["whatsapp_url"]) == (
            "rejected", "No vimos el pago en el banco.", None, None,
        )
        assert body["whatsapp_number"] == "584248824634"
        assert body["closed_at"]
        assert {(o.status, o.failure_reason) for o in await _rows(db, PaymentsOrder)} == {("failed", "REJECTED")}
        assert {e.status for e in await _rows(db, PaymentsEnrollment)} == {"failed"}
        assert await _emails(sent_emails) == [
            ("outsider@test.com", f"No pudimos confirmar el pago del pedido {purchase['code']}"),
        ]
        document = sent_emails.call_args.kwargs["body"]
        assert "No vimos el pago en el banco." in document and "https://wa.me/584248824634" in document

        again = await _act(client, current, admin_user, purchase, "reject", {"reason": "Otro motivo"})
        assert again.status_code == 200 and again.json()["reject_reason"] == "No vimos el pago en el banco."
        assert len(await _emails(sent_emails)) == 1

    async def test_reject_without_email(self, client, current, admin_user, outsider, cart, sent_emails):
        purchase = await _purchase(client, current, outsider, cart)
        await _emails(sent_emails)
        sent_emails.reset_mock()
        response = await _act(client, current, admin_user, purchase, "reject",
                              {"reason": "Pago duplicado", "notify": False})
        assert response.status_code == 200 and response.json()["status"] == "rejected"
        assert await _emails(sent_emails) == []

    async def test_paid_and_closed_purchases(self, client, current, admin_user, outsider, regular_user, cart):
        purchase = await _purchase(client, current, outsider, cart)
        await _act(client, current, admin_user, purchase, "confirm", {"bank_reference": "77778888"})
        paid = await _act(client, current, admin_user, purchase, "reject", {"reason": "No llegó"})
        assert paid.status_code == 409
        assert paid.json()["detail"] == {"code": "ALREADY_PAID",
                                         "message": "Este pedido ya está pagado. Si fue un error, anúlalo."}
        cancelled = await _purchase(client, current, regular_user, cart)
        await _act(client, current, regular_user, cancelled, "cancel", {})
        response = await _act(client, current, admin_user, cancelled, "reject", {"reason": "No llegó"})
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "NOT_PENDING" and response.json()["detail"]["status"] == "cancelled"


class TestVoid:
    async def test_void_takes_access_away(self, client, current, db, admin_user, outsider, cart, course,
                                          ebook_course, sent_emails):
        purchase = await _purchase(client, current, outsider, cart)
        not_paid = await _act(client, current, admin_user, purchase, "void", {"reason": "Marcado por error"})
        assert not_paid.status_code == 409
        assert not_paid.json()["detail"] == {"code": "NOT_PAID", "message": "Solo se pueden anular pedidos pagados."}
        await _act(client, current, admin_user, purchase, "confirm", {"bank_reference": "11112222"})
        assert (await _access(client, current, outsider, course))["has_access"] is True
        await _emails(sent_emails)
        sent_emails.reset_mock()

        assert (await _act(client, current, admin_user, purchase, "void", {"reason": "x"})).json()["detail"]["code"] == "INVALID_REASON"
        response = await _act(client, current, admin_user, purchase, "void", {"reason": "Marcado por error"})
        assert response.status_code == 200
        assert (response.json()["status"], response.json()["reject_reason"]) == ("voided", "Marcado por error")
        assert (response.json()["whatsapp_number"], response.json()["whatsapp_url"], response.json()["payment"]) == (
            "584248824634", None, None,
        )
        assert {(o.status, o.failure_reason) for o in await _rows(db, PaymentsOrder)} == {("refunded", "voided")}
        assert {e.status for e in await _rows(db, PaymentsEnrollment)} == {"refunded"}
        for resource in (course, ebook_course):
            access = await _access(client, current, outsider, resource)
            assert (access["has_access"], access["payment_pending"]) == (False, False)
        assert await _emails(sent_emails) == []

        again = await _act(client, current, admin_user, purchase, "void", {"reason": "Marcado por error"})
        assert again.status_code == 200 and again.json()["status"] == "voided"
        refused = await _act(client, current, admin_user, purchase, "confirm", {"bank_reference": "11112222"})
        assert refused.status_code == 409
        assert refused.json()["detail"] == {"code": "VOIDED",
                                            "message": "Este pedido fue anulado. Pide a la persona que haga un pedido nuevo."}
        assert (await _access(client, current, outsider, course))["has_access"] is False
        # The products can be bought again.
        assert (await _checkout(client, current, outsider, cart)).status_code == 201

    async def test_void_closes_an_order_a_crash_left_open(self, client, current, db, admin_user, outsider, cart):
        purchase = await _purchase(client, current, outsider, cart)
        await _act(client, current, admin_user, purchase, "confirm", {"bank_reference": "27182818"})
        # As if the confirmation died before paying the second order.
        stuck = (await _rows(db, PaymentsOrder))[1]
        stuck.status = "pending"
        enrollment = (await _rows(db, PaymentsEnrollment, PaymentsEnrollment.id == stuck.enrollment_id))[0]
        enrollment.status = "pending"
        db.add_all([stuck, enrollment])
        await db.commit()
        response = await _act(client, current, admin_user, purchase, "void", {"reason": "Pago no recibido"})
        assert response.status_code == 200 and response.json()["status"] == "voided"
        assert [(o.status, o.failure_reason) for o in await _rows(db, PaymentsOrder)] == [
            ("refunded", "voided"), ("cancelled", "voided"),
        ]
        # Nothing is left open: both products can be bought again.
        assert [i["status"] for i in (await _quote(client, current, outsider, cart))["items"]] == ["available"] * 2


# ------------------------------------------------------------------ expiry


class TestExpiry:
    async def _overdue(self, db):
        row = (await _rows(db, PaymentsPurchase))[0]
        row.expires_at = utcnow() - timedelta(seconds=1)
        db.add(row)
        await db.commit()
        return row

    async def test_due_purchases_expire(self, client, current, db, outsider, cart):
        purchase = await _purchase(client, current, outsider, cart)
        assert await expire_due_purchases(db) == 0
        await self._overdue(db)
        assert await expire_due_purchases(db, ORG_ID) == 1
        assert await expire_due_purchases(db) == 0
        row = (await _rows(db, PaymentsPurchase))[0]
        assert row.status == "expired" and row.closed_at is not None
        assert {(o.status, o.failure_reason) for o in await _rows(db, PaymentsOrder)} == {("expired", "EXPIRED")}
        assert {e.status for e in await _rows(db, PaymentsEnrollment)} == {"cancelled"}

        current.set(outsider)
        view = (await client.get(f"{BASE}/purchases/{purchase['purchase_uuid']}")).json()
        assert (view["status"], view["can_cancel"]) == ("expired", False)
        assert view["payment"]["bank_name"] == "Banesco" and view["whatsapp_url"]
        cancel = await _act(client, current, outsider, purchase, "cancel", {})
        assert cancel.status_code == 409 and cancel.json()["detail"]["status"] == "expired"
        # Its products are free to buy again.
        assert (await _checkout(client, current, outsider, cart)).status_code == 201

    async def test_reads_expire_first(self, client, current, db, admin_user, outsider, cart):
        await _purchase(client, current, outsider, cart)
        await self._overdue(db)
        current.set(outsider)
        assert (await client.get(f"{BASE}/purchases/mine")).json()["items"][0]["status"] == "expired"
        current.set(admin_user)
        assert (await client.get(f"{BASE}/purchases/summary")).json() == {"pending": 0}

    async def test_the_quote_does_not_show_an_overdue_purchase_as_pending(self, client, current, db, outsider,
                                                                         cart):
        await _purchase(client, current, outsider, cart)
        await self._overdue(db)
        body = await _quote(client, current, outsider, cart)
        assert [i["status"] for i in body["items"]] == ["available", "available"]

    async def test_reconciliation_tick_expires_purchases(self):
        @asynccontextmanager
        async def session_factory():
            yield "session"

        with patch.object(reconcile, "_claim_lock", return_value=True), \
                patch.object(reconcile, "_claim_refund_check", return_value=False), \
                patch("src.core.events.database._async_session_factory", new=session_factory), \
                patch("src.services.payments.purchases.expire_due_purchases", new_callable=AsyncMock,
                      return_value=2) as expire, \
                patch.object(reconcile, "reconcile_once", new_callable=AsyncMock,
                             return_value={"checked": 0, "expired": 0}) as once:
            await reconcile._tick()
        expire.assert_awaited_once_with("session")
        once.assert_awaited_once()

        # A failure while expiring never stops the reconciliation pass.
        with patch.object(reconcile, "_claim_lock", return_value=True), \
                patch.object(reconcile, "_claim_refund_check", return_value=False), \
                patch("src.core.events.database._async_session_factory", new=session_factory), \
                patch("src.services.payments.purchases.expire_due_purchases", new_callable=AsyncMock,
                      side_effect=RuntimeError("db down")), \
                patch.object(reconcile, "reconcile_once", new_callable=AsyncMock,
                             return_value={"checked": 0, "expired": 0}) as once:
            await reconcile._tick()
        once.assert_awaited_once()


# -------------------------------------------------------------- formatting


class TestFormatting:
    def test_amounts_in_es_ve(self):
        assert purchase_emails.format_bs(Decimal("35492.08")) == "35.492,08"
        assert purchase_emails.format_bs(40) == "40,00"
        assert purchase_emails.format_bs(Decimal("1234567.5")) == "1.234.567,50"
        assert purchase_emails.format_bs(Decimal("0.005")) == "0,01"

    def test_rates_have_two_decimals_like_the_web(self):
        assert purchase_emails.format_rate(Decimal("887.302")) == "887,30"
        assert purchase_emails.format_rate(Decimal("887.305")) == "887,31"
        assert purchase_emails.format_rate(Decimal("36.123456")) == "36,12"
        assert purchase_emails.format_rate(Decimal("1234.5")) == "1.234,50"

    def test_caracas_dates(self):
        from datetime import timezone

        utc = timezone.utc
        assert purchase_emails.format_caracas(datetime(2026, 10, 28, 19, 45, tzinfo=utc)) == "28/10/2026, 3:45 p. m."
        assert purchase_emails.format_caracas(datetime(2026, 10, 28, 0, 0, tzinfo=utc)) == "27/10/2026, 8:00 p. m."
        assert purchase_emails.format_caracas(datetime(2026, 10, 28, 16, 5, tzinfo=utc)) == "28/10/2026, 12:05 p. m."
        assert purchase_emails.format_caracas(datetime(2026, 10, 28, 4, 30, tzinfo=utc)) == "28/10/2026, 12:30 a. m."
        assert purchase_emails.format_caracas(datetime(2026, 10, 28, 15, 0)) == "28/10/2026, 11:00 a. m."  # naive = UTC


# -------------------------------------------------------------- admin list


class TestAdminList:
    async def test_filters_counts_search_and_order(self, client, current, admin_user, outsider, regular_user,
                                                   course, manual):
        offers = [await _new_offer(client, current, admin_user, f"Oferta {n}", 10 + n, course.course_uuid)
                  for n in range(4)]
        p1 = await _purchase(client, current, outsider, [offers[0]["offer_uuid"]])
        p2 = await _purchase(client, current, regular_user, [offers[1]["offer_uuid"]])
        p3 = await _purchase(client, current, outsider, [offers[2]["offer_uuid"]])
        p4 = await _purchase(client, current, regular_user, [offers[3]["offer_uuid"]])
        await _act(client, current, admin_user, p3, "confirm", {"bank_reference": "4455-6677"})
        await _act(client, current, regular_user, p4, "cancel", {})
        current.set(admin_user)

        async def codes(**params) -> list[str]:
            response = await client.get(f"{BASE}/purchases", params=params)
            assert response.status_code == 200, response.text
            return [i["code"] for i in response.json()["items"]]

        listing = (await client.get(f"{BASE}/purchases")).json()
        assert [i["code"] for i in listing["items"]] == [p1["code"], p2["code"]]  # pending: oldest first
        assert listing["total"] == 2
        assert listing["counts"] == {"pending": 2, "paid": 1, "rejected": 0, "cancelled": 1, "expired": 0,
                                     "voided": 0, "all": 4}
        assert listing["items"][0]["customer"]["email"] == "outsider@test.com"
        assert await codes(status="all") == [p4["code"], p3["code"], p2["code"], p1["code"]]
        assert await codes(status="paid") == [p3["code"]]
        assert await codes(status="cancelled") == [p4["code"]]

        assert await codes(status="all", q=p2["code"].lower()) == [p2["code"]]
        assert await codes(status="all", q="4455-6677") == [p3["code"]]
        assert await codes(status="all", q="5566") == [p3["code"]]
        assert set(await codes(status="all", q="REGULAR@TEST")) == {p2["code"], p4["code"]}
        assert set(await codes(status="all", q="outsider test")) == {p1["code"], p3["code"]}
        assert await codes(status="all", q="%") == []
        assert await codes(status="all", q="\x00" + p1["code"]) == [p1["code"]]
        assert await codes(status="all", q="x" * 150) == []
        searched = (await client.get(f"{BASE}/purchases", params={"status": "all", "q": "outsider"})).json()
        assert searched["total"] == 2 and searched["counts"]["all"] == 4  # counts ignore q

        page = (await client.get(f"{BASE}/purchases", params={"status": "all", "limit": 2, "offset": 1})).json()
        assert [i["code"] for i in page["items"]] == [p3["code"], p2["code"]] and page["total"] == 4
        bad = await client.get(f"{BASE}/purchases", params={"status": "raro"})
        assert bad.status_code == 400 and bad.json()["detail"]["field"] == "status"
        assert (await client.get(f"{BASE}/purchases", params={"limit": 101})).status_code == 422
        assert (await client.get(f"{BASE}/purchases/summary")).json() == {"pending": 2}

        current.set(outsider)
        assert (await client.get(f"{BASE}/purchases")).status_code == 403
        assert (await client.get(f"{BASE}/purchases/summary")).status_code == 403


# --------------------------------------------- correction round (review)


class TestManualRateRule:
    """The exact rule the dashboard replicates (providers/manual.py)."""

    @pytest.mark.parametrize("typed,expected", [
        ("887,30", "887.30"), ("887.30", "887.30"), ("887,3", "887.3"), ("887,3021", "887.3021"),
        ("1.234,56", "1234.56"), ("1,234.56", "1234.56"), ("1.234,567", "1234.567"),
        ("1.050.000", "1050000"), ("1,050,000", "1050000"), ("900", "900"),
        (" 887,30 ", "887.30"), ("887 ,30", "887.30"),
        (887.302, "887.302"), (900, "900"),  # JSON numbers are never ambiguous
    ])
    def test_accepted(self, typed, expected):
        assert parse_rate_text(typed) == Decimal(expected)

    @pytest.mark.parametrize("typed", ["1.050", "887,302", "0,125", "1234.567"])
    def test_one_separator_before_three_digits_is_ambiguous(self, typed):
        with pytest.raises(InvalidSetting) as exc:
            parse_rate_text(typed)
        assert exc.value.field == "fx_manual_rate"
        assert exc.value.message == (
            "Escribe la tasa con 2 decimales (por ejemplo 887,30) para que no se confunda con miles."
        )

    @pytest.mark.parametrize("typed", [
        "887,30215", "1.05.000", "1..050", "1.234,5,6", "887,", ",5", "abc", "887;30", "887\t30", "1e3", "-5",
        "0", "0,00", "100000001", 100000001, 0.00001, True,
    ])
    def test_refused(self, typed):
        with pytest.raises(InvalidSetting) as exc:
            parse_rate_text(typed)
        assert exc.value.message == "Escribe la tasa en Bs. por dólar, por ejemplo 887,30."

    @pytest.mark.parametrize("typed", ["", None])
    def test_empty_clears(self, typed):
        assert parse_rate_text(typed) is None


class TestManualRateSettings:
    async def test_far_from_the_bcv_rate_is_refused(self, client, current, admin_user, manual):
        # The `manual` fixture stored today's BCV rate (887,302).
        response = await _set_settings(client, current, admin_user, {"fx_mode": "manual", "fx_manual_rate": "300"})
        assert response.status_code == 400
        assert response.json()["detail"] == {
            "code": "INVALID_FIELD", "field": "fx_manual_rate",
            "message": "La tasa manual (300,00 Bs.) se aleja mucho de la del BCV (887,30 Bs.). Revísala.",
        }
        ok = await _set_settings(client, current, admin_user, {"fx_mode": "manual", "fx_manual_rate": "1300"})
        assert ok.status_code == 200 and ok.json()["settings"]["fx_manual_rate"] == 1300.0  # +46.5 %

    async def test_ambiguous_rate_message(self, client, current, admin_user, org_config):
        response = await _set_settings(client, current, admin_user, {"fx_mode": "manual", "fx_manual_rate": "1.050"})
        assert response.status_code == 400
        assert response.json()["detail"]["message"] == (
            "Escribe la tasa con 2 decimales (por ejemplo 887,30) para que no se confunda con miles."
        )

    async def test_with_the_bcv_rate_a_bad_manual_rate_never_blocks_saving(self, client, current, admin_user,
                                                                          manual):
        first = await _set_settings(client, current, admin_user, {"fx_manual_rate": "900,50"})
        assert first.status_code == 200 and first.json()["settings"]["fx_manual_rate"] == 900.5
        for leftover in ("abc", "1.050", "300"):  # invalid, ambiguous, far from the BCV
            response = await _set_settings(client, current, admin_user,
                                           {"fx_manual_rate": leftover, "holder_name": f"Titular {leftover} (borrar)"})
            assert response.status_code == 200, (leftover, response.text)
            assert response.json()["settings"]["fx_manual_rate"] == 900.5
            assert response.json()["settings"]["holder_name"] == f"Titular {leftover} (borrar)"
            assert response.json()["settings"]["fx_mode"] == "auto"

    async def test_only_checked_when_sent(self, client, current, admin_user, org_config):
        # Saved before any BCV rate was stored (the save itself then fetches it)...
        saved = await _set_settings(client, current, admin_user, {"fx_manual_rate": "300"})
        assert saved.json()["settings"]["fx_manual_rate"] == 300.0 and saved.json()["fx"]["rate"] == 887.302
        # ...and switching to the manual rate without sending it does not re-check it.
        switched = await _set_settings(client, current, admin_user, {"fx_mode": "manual"})
        assert switched.status_code == 200 and switched.json()["fx"]["rate"] == 300.0

    @pytest.mark.parametrize("typed,stored", [
        ("04248824634", "584248824634"), ("+58 424-882.4634", "584248824634"), ("+1 555 123 4567", "15551234567"),
    ])
    async def test_whatsapp_needs_the_country_code(self, client, current, admin_user, org_config, typed, stored):
        response = await _set_settings(client, current, admin_user, {"whatsapp": typed})
        assert response.status_code == 200 and response.json()["settings"]["whatsapp"] == stored

    async def test_a_bcv_jump_shows_a_warning(self, client, current, db, admin_user, org_config):
        db.add(PaymentsFxRate(source="bcv", rate=Decimal("700"), rate_date=date(2026, 10, 26),
                              fetched_at=utcnow() - timedelta(hours=2)))
        await db.commit()
        current.set(admin_user)
        fx_block = (await client.get(f"{BASE}/manual/settings")).json()["fx"]
        assert (fx_block["rate"], fx_block["stale"], fx_block["error"]) == (700.0, True, None)
        assert fx_block["warning"] == "La tasa del BCV cambió más de 20 %: la confirmamos en unos minutos."

    async def test_a_concurrent_change_is_a_conflict(self, client, current, db, admin_user, org_config):
        async def conflicting_commit():
            raise IntegrityError("INSERT INTO sc_pay_config", {}, Exception("uq_sc_pay_config_org_provider"))

        current.set(admin_user)
        with patch.object(db, "commit", new=conflicting_commit):
            response = await client.put(f"{BASE}/manual/settings", json={"bank_name": "Banesco"})
        assert response.status_code == 409
        assert response.json()["detail"] == {"code": "CONFLICT",
                                             "message": "Otro cambio se guardó al mismo tiempo. Vuelve a intentarlo."}


class TestQuoteRateLimit:
    async def test_per_user_with_a_session_and_per_ip_without(self, client, current, monkeypatch, regular_user,
                                                              cart):
        calls = []

        def fake_limit(key, limit, window):
            calls.append((key, limit, window))
            return True, 1, 0

        monkeypatch.setitem(os.environ, "TESTING", "false")  # _check_rate is off under tests
        with patch("src.services.security.rate_limiting.check_rate_limit", side_effect=fake_limit):
            await _quote(client, current, None, cart)
            await _quote(client, current, regular_user, cart)
        assert calls[0][0].startswith("sc_pay_cart_quote:") and calls[0][1:] == (600, 60)
        assert calls[1] == (f"sc_pay_cart_quote_user:{regular_user.id}", 60, 60)


class TestCaptureLockSharing:
    async def test_three_coroutines_never_overlap(self):
        lock_id = "test:three-coroutines"
        events: list[tuple[str, int]] = []
        inside = 0
        release_first = asyncio.Event()

        async def worker(name: str, wait: asyncio.Event = None):
            nonlocal inside
            async with checkout._capture_lock(lock_id):
                inside += 1
                events.append((name, inside))
                if wait is not None:
                    await wait.wait()
                await asyncio.sleep(0.01)
                inside -= 1

        async def first_then_third():
            await worker("a", release_first)
            # "c" arrives right after "a" lets go, while "b" is taking over.
            return asyncio.create_task(worker("c"))

        first = asyncio.create_task(first_then_third())
        await asyncio.sleep(0.01)
        second = asyncio.create_task(worker("b"))
        await asyncio.sleep(0.01)
        release_first.set()
        third = await first
        await asyncio.gather(second, third)
        assert events == [("a", 1), ("b", 1), ("c", 1)]
        assert lock_id not in checkout._LOCAL_CAPTURE_LOCKS and lock_id not in checkout._LOCAL_CAPTURE_USERS


class TestDatabaseGuards:
    async def test_startup_indexes(self, engine, db, org):
        await db.commit()
        results = await ensure_payments_indexes(engine)
        assert results == {"uq_sc_pay_order_manual_pending": True, "ix_sc_pay_purchase_status_expires": True}
        assert await ensure_payments_indexes(engine) == results  # idempotent
        order_indexes = {row[1] for row in (await db.execute(text("PRAGMA index_list(sc_pay_order)"))).all()}
        purchase_indexes = {row[1] for row in (await db.execute(text("PRAGMA index_list(sc_pay_purchase)"))).all()}
        assert "uq_sc_pay_order_manual_pending" in order_indexes
        assert "ix_sc_pay_purchase_status_expires" in purchase_indexes
        assert "ix_sc_pay_purchase_status_expires" in {ix.name for ix in PaymentsPurchase.__table__.indexes}

    async def test_an_index_that_cannot_be_built_never_stops_the_app(self, client, current, db, engine, outsider,
                                                                    cart, caplog):
        purchase = await _purchase(client, current, outsider, cart)
        child = (await _rows(db, PaymentsOrder, PaymentsOrder.order_uuid == purchase["items"][0]["order_uuid"]))[0]
        db.add(PaymentsOrder(  # a duplicate that the unique index refuses
            order_uuid=str(uuid4()), org_id=ORG_ID, offer_id=child.offer_id, user_id=child.user_id,
            enrollment_id=child.enrollment_id, provider="manual", method="pago_movil", status="pending",
            amount=child.amount, currency="USD", redirect_uri="", raw={},
        ))
        await db.commit()
        results = await ensure_payments_indexes(engine)
        assert results == {"uq_sc_pay_order_manual_pending": False, "ix_sc_pay_purchase_status_expires": True}
        assert any(r.levelname == "ERROR" and "uq_sc_pay_order_manual_pending" in r.getMessage()
                   for r in caplog.records)

    async def test_a_race_past_the_buyer_lock_answers_payment_pending(self, client, current, db, engine, outsider,
                                                                      cart, ebook_offer):
        await db.commit()
        assert all((await ensure_payments_indexes(engine)).values())
        first = await _purchase(client, current, outsider, [ebook_offer["offer_uuid"]])
        real_check = purchases_module._payment_pending_error
        calls = []

        async def blind_first_check(db_session, user_id, lines):
            calls.append(user_id)
            if len(calls) == 1:
                return None  # the other worker's purchase was not visible yet
            return await real_check(db_session, user_id, lines)

        with patch.object(purchases_module, "_payment_pending_error", new=blind_first_check):
            response = await _checkout(client, current, outsider, cart)
        assert response.status_code == 409, response.text
        detail = response.json()["detail"]
        assert (detail["code"], detail["purchase_code"], detail["offer_uuids"]) == (
            "PAYMENT_PENDING", first["code"], [ebook_offer["offer_uuid"]],
        )
        assert len(await _rows(db, PaymentsPurchase)) == 1


class TestOverlapAndDuplicates:
    async def test_two_offers_with_the_same_course(self, client, current, db, admin_user, outsider, course, offer,
                                                   manual):
        bundle = await _new_offer(client, current, admin_user, "Pack completo", 30, course.course_uuid)
        response = await _checkout(client, current, outsider, [offer["offer_uuid"], bundle["offer_uuid"]])
        assert response.status_code == 400
        assert response.json()["detail"] == {
            "code": "OVERLAPPING_OFFERS",
            "message": "«Curso completo» y «Pack completo» incluyen el mismo curso. Quita uno de los dos del carrito.",
            "offer_uuids": [offer["offer_uuid"], bundle["offer_uuid"]],
        }
        assert await _rows(db, PaymentsPurchase) == []

    async def _expire(self, db, code: str) -> None:
        row = (await _rows(db, PaymentsPurchase, PaymentsPurchase.code == code))[0]
        row.expires_at = utcnow() - timedelta(minutes=1)
        db.add(row)
        await db.commit()

    async def test_confirming_cancels_the_buyers_other_pending_purchases(self, client, current, db, admin_user,
                                                                         outsider, cart, offer, ebook_offer,
                                                                         sent_emails):
        old = await _purchase(client, current, outsider, [offer["offer_uuid"]])
        await self._expire(db, old["code"])
        # She buys the course again, with the ebook; then the first payment shows up.
        new = await _purchase(client, current, outsider, cart)
        await _emails(sent_emails)
        sent_emails.reset_mock()
        response = await _act(client, current, admin_user, old, "confirm", {"bank_reference": "12121212"})
        assert response.status_code == 200 and response.json()["status"] == "paid"

        current.set(admin_user)
        cancelled = (await client.get(f"{BASE}/purchases/{new['purchase_uuid']}")).json()
        assert (cancelled["status"], cancelled["reject_reason"]) == (
            "cancelled", f"Estos productos ya se pagaron en el pedido {old['code']}.",
        )
        new_orders = await _rows(db, PaymentsOrder,
                                 PaymentsOrder.order_uuid.in_([i["order_uuid"] for i in new["items"]]))
        assert {(o.status, o.failure_reason) for o in new_orders} == {("cancelled", "paid_in_other_purchase")}
        statuses = {e.offer_id: e.status for e in await _rows(db, PaymentsEnrollment)}
        assert statuses == {offer["id"]: "active", ebook_offer["id"]: "cancelled"}
        # No email for the cancelled purchase.
        assert await _emails(sent_emails) == [("outsider@test.com", f"Ya tienes acceso: pedido {old['code']}")]

    async def test_paid_twice_is_flagged_for_a_refund(self, client, current, db, admin_user, outsider, offer,
                                                      manual):
        old = await _purchase(client, current, outsider, [offer["offer_uuid"]])
        await self._expire(db, old["code"])
        new = await _purchase(client, current, outsider, [offer["offer_uuid"]])
        # The admin confirms the new one, then finds the old payment in the bank too.
        confirmed = await _act(client, current, admin_user, new, "confirm", {"bank_reference": "30303030"})
        assert confirmed.status_code == 200
        response = await _act(client, current, admin_user, old, "confirm", {"bank_reference": "40404040"})
        body = response.json()
        assert (body["status"], body["needs_fulfillment"]) == ("paid", False)
        assert body["items"][0]["duplicate_of"] == {"order_uuid": new["items"][0]["order_uuid"],
                                                    "purchase_code": new["code"]}
        current.set(admin_user)
        new_view = (await client.get(f"{BASE}/purchases/{new['purchase_uuid']}")).json()
        assert new_view["items"][0]["duplicate_of"] is None
        charges = {c["id"]: c for c in (await client.get(f"{BASE}/transactions")).json()["data"]}
        assert charges[old["items"][0]["order_uuid"]]["needs_refund"] is True
        # The buyer's own view has no admin fields.
        current.set(outsider)
        mine = (await client.get(f"{BASE}/purchases/{old['purchase_uuid']}")).json()
        assert "duplicate_of" not in mine["items"][0] and "needs_fulfillment" not in mine


class TestRobustness:
    async def test_quote_queries_do_not_grow_with_the_cart(self, client, current, engine, admin_user, outsider,
                                                           course, manual):
        offers = [await _new_offer(client, current, admin_user, f"Oferta {n}", 10, course.course_uuid)
                  for n in range(6)]
        await _purchase(client, current, outsider, [offers[0]["offer_uuid"]])
        statements: list[str] = []

        def count(conn, cursor, statement, parameters, context, executemany):
            statements.append(statement)

        event.listen(engine.sync_engine, "before_cursor_execute", count)
        try:
            await _quote(client, current, outsider, [o["offer_uuid"] for o in offers[:2]])
            small = len(statements)
            statements.clear()
            await _quote(client, current, outsider, [o["offer_uuid"] for o in offers])
            large = len(statements)
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", count)
        assert large <= small + 1, (small, large)

    async def test_an_email_commit_failure_never_fails_a_saved_purchase(self, client, current, db, outsider, cart):
        state = {"armed": False, "failed": False}
        real_commit = db.commit

        def scheduled(*args, **kwargs):
            state["armed"] = True
            return True

        async def flaky_commit():
            if state["armed"] and not state["failed"]:
                state["failed"] = True
                raise OperationalError("COMMIT", {}, Exception("connection lost"))
            return await real_commit()

        with patch.object(purchase_emails, "schedule_email", new=scheduled), \
                patch.object(db, "commit", new=flaky_commit):
            response = await _checkout(client, current, outsider, cart)
        assert state["failed"] is True
        assert response.status_code == 201, response.text
        assert response.json()["status"] == "pending"
        assert len(await _rows(db, PaymentsPurchase)) == 1

    async def test_an_email_context_failure_never_fails_a_saved_purchase(self, client, current, db, outsider, cart):
        with patch.object(purchases_module, "_email_context",
                          side_effect=OperationalError("SELECT", {}, Exception("db hiccup"))):
            response = await _checkout(client, current, outsider, cart)
        assert response.status_code == 201, response.text
        assert len(await _rows(db, PaymentsPurchase)) == 1

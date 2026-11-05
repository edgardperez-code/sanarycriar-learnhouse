"""Sanar y Criar: bank transfer, Zelle and Binance next to Pago Móvil
(src/services/payments/manual_methods.py and purchases.py), end to end
through the router. Same stubs as test_cart_manual.py: the BCV source and
send_email never leave the process.
"""

from decimal import Decimal
from urllib.parse import unquote

import pytest
from sqlmodel import delete, select

from src.db.payments.payments import PaymentsConfig, PaymentsOrder
from src.db.payments.purchases import PaymentsFxRate, PaymentsPurchase
from src.services.payments import manual_methods as mm
from src.services.payments import schema
from src.services.payments.purchases import normalize_reference
from src.tests.payments.test_cart_manual import (  # noqa: F401  (fixtures)
    BASE,
    _access,
    _act,
    _checkout,
    _drain_emails,
    _emails,
    _quote,
    _rows,
    _set_settings,
    bcv_source,
    cart,
    ebook_course,
    ebook_offer,
    manual,
)
from src.tests.payments.test_checkout_flow import hosting  # noqa: F401

TRC20 = "T" + "Ab1" * 11
EVM = "0x" + "a1" * 20
ZELLE = {
    "enabled": True,
    "email": " Pagos@Example.com ",
    "phone": "(305) 555-1234",
    "holder_name": "  Hilda   Hernández (borrar) ",
    "instructions": "Pon el código del pedido en la nota.",
}
TRANSFER = {
    "enabled": True,
    "bank_name": "Banesco",
    "bank_code": "0134",
    "account_number": "0134-0000-00 0000000001",
    "account_type": "Corriente",
    "holder_name": "Hilda Hernández (borrar)",
    "id_document": "v-12.345.678",
}
BINANCE = {"enabled": True, "pay_id": "123 456 789", "usdt_address": TRC20, "usdt_network": "trc20"}


async def _set_method(client, current, admin_user, method: str, body: dict):
    current.set(admin_user)
    response = await client.put(f"{BASE}/manual/methods/{method}", json=body)
    current.set(None)
    return response


async def _methods(client, current, admin_user) -> dict:
    current.set(admin_user)
    response = await client.get(f"{BASE}/manual/methods")
    current.set(None)
    assert response.status_code == 200, response.text
    return response.json()


async def _buy(client, current, user, uuids, method: str) -> dict:
    response = await _checkout(client, current, user, uuids, method=method)
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture
async def all_methods(client, current, admin_user, cart):
    """Pago Móvil (from ``cart``) plus the three others, all on."""
    for method, body in ((mm.TRANSFERENCIA, TRANSFER), (mm.ZELLE, ZELLE), (mm.BINANCE, BINANCE)):
        response = await _set_method(client, current, admin_user, method, body)
        assert response.status_code == 200, response.text
    return cart


@pytest.fixture
async def zelle_only(client, current, admin_user, cart):
    """Zelle on, Pago Móvil off (its WhatsApp stays: every method shares it)."""
    assert (await _set_settings(client, current, admin_user, {"enabled": False})).status_code == 200
    assert (await _set_method(client, current, admin_user, mm.ZELLE, ZELLE)).status_code == 200
    return cart


# ---------------------------------------------------------------- settings


class TestMethodSettings:
    async def test_defaults(self, client, current, admin_user, org_config):
        assert await _methods(client, current, admin_user) == {
            "transferencia": {
                "method": "transferencia", "enabled": False, "active": False,
                "missing": ["bank_name", "account_number", "account_type", "holder_name", "id_document", "whatsapp"],
                "settings": {"bank_name": "", "bank_code": "", "account_number": "", "account_type": "",
                             "holder_name": "", "id_document": "", "instructions": ""},
            },
            "zelle": {
                "method": "zelle", "enabled": False, "active": False,
                "missing": ["email_or_phone", "holder_name", "whatsapp"],
                "settings": {"email": "", "phone": "", "holder_name": "", "instructions": ""},
            },
            "binance": {
                "method": "binance", "enabled": False, "active": False,
                "missing": ["pay_id_or_address", "whatsapp"],
                "settings": {"pay_id": "", "usdt_address": "", "usdt_network": "", "instructions": ""},
            },
        }

    async def test_only_admins(self, client, current, regular_user, org_config):
        current.set(None)
        assert (await client.get(f"{BASE}/manual/methods")).status_code == 401
        assert (await client.put(f"{BASE}/manual/methods/zelle", json={})).status_code == 401
        current.set(regular_user)
        assert (await client.get(f"{BASE}/manual/methods")).status_code == 403
        assert (await client.put(f"{BASE}/manual/methods/zelle", json={"enabled": False})).status_code == 403

    async def test_unknown_method(self, client, current, admin_user, org_config):
        for method in ("pago_movil", "paypal", "x"):
            response = await _set_method(client, current, admin_user, method, {"enabled": True})
            assert response.status_code == 404
            assert response.json()["detail"] == {"code": "UNKNOWN_METHOD", "message": "Ese método de pago no existe."}

    async def test_zelle_is_normalized_and_needs_the_whatsapp(self, client, current, db, admin_user, org_config):
        response = await _set_method(client, current, admin_user, mm.ZELLE, ZELLE)
        assert response.status_code == 400
        assert response.json()["detail"] == {
            "code": "INCOMPLETE", "message": "Para activar Zelle falta: WhatsApp.", "missing": ["whatsapp"],
        }
        assert await _rows(db, PaymentsConfig) == []
        saved = await _set_method(client, current, admin_user, mm.ZELLE, {**ZELLE, "enabled": False})
        assert saved.status_code == 200, saved.text
        assert saved.json() == {
            "method": "zelle", "enabled": False, "active": False, "missing": ["whatsapp"],
            "settings": {"email": "pagos@example.com", "phone": "+1 305-555-1234",
                         "holder_name": "Hilda Hernández (borrar)",
                         "instructions": "Pon el código del pedido en la nota."},
        }
        assert (await _set_settings(client, current, admin_user, {"whatsapp": "0424-8824634"})).status_code == 200
        on = await _set_method(client, current, admin_user, mm.ZELLE, {"enabled": True})
        assert (on.json()["enabled"], on.json()["active"], on.json()["missing"]) == (True, True, [])
        # The row's own columns stay Pago Móvil's: still off and incomplete.
        row = (await _rows(db, PaymentsConfig))[0]
        assert (row.enabled, row.active) == (False, False)
        assert row.provider_config["zelle"]["enabled"] is True
        current.set(admin_user)
        settings = (await client.get(f"{BASE}/manual/settings")).json()
        assert (settings["enabled"], settings["active"]) == (False, False)

    async def test_zelle_takes_the_email_or_the_phone(self, client, current, admin_user, org_config):
        await _set_settings(client, current, admin_user, {"whatsapp": "584248824634"})
        only_phone = await _set_method(client, current, admin_user, mm.ZELLE,
                                       {"enabled": True, "phone": "+1 786 555 0000", "holder_name": "Hilda"})
        assert only_phone.status_code == 200, only_phone.text
        assert only_phone.json()["settings"]["phone"] == "+1 786-555-0000"
        neither = await _set_method(client, current, admin_user, mm.ZELLE, {"phone": ""})
        assert neither.status_code == 400
        assert neither.json()["detail"]["missing"] == ["email_or_phone"]
        assert neither.json()["detail"]["message"] == "Para activar Zelle falta: correo o teléfono de Zelle."

    async def test_transfer(self, client, current, admin_user, org_config):
        await _set_settings(client, current, admin_user, {"whatsapp": "584248824634"})
        response = await _set_method(client, current, admin_user, mm.TRANSFERENCIA, TRANSFER)
        assert response.status_code == 200, response.text
        assert response.json()["settings"] == {
            "bank_name": "Banesco", "bank_code": "0134", "account_number": "01340000000000000001",
            "account_type": "corriente", "holder_name": "Hilda Hernández (borrar)", "id_document": "V-12345678",
            "instructions": "",
        }
        assert response.json()["active"] is True
        # The account must belong to the bank; without a code, the account gives it.
        other_bank = await _set_method(client, current, admin_user, mm.TRANSFERENCIA,
                                       {"bank_name": "Mercantil", "bank_code": "0105"})
        assert other_bank.status_code == 400
        assert other_bank.json()["detail"] == {
            "code": "INVALID_FIELD", "field": "account_number",
            "message": "La cuenta debe empezar por el código del banco (0105).",
        }
        no_code = await _set_method(client, current, admin_user, mm.TRANSFERENCIA,
                                    {"bank_name": "Mercantil", "bank_code": "", "account_number": "0105" + "1" * 16,
                                     "account_type": "Ahorros"})
        assert no_code.status_code == 200, no_code.text
        settings = no_code.json()["settings"]
        assert (settings["bank_code"], settings["account_number"], settings["account_type"]) == (
            "0105", "0105" + "1" * 16, "ahorro",
        )

    async def test_transfer_with_the_manual_rate_needs_it(self, client, current, admin_user, org_config):
        await _set_settings(client, current, admin_user, {"whatsapp": "584248824634"})
        assert (await _set_method(client, current, admin_user, mm.TRANSFERENCIA, TRANSFER)).status_code == 200
        # Switching the shared rate to manual without a rate would break it.
        response = await _set_settings(client, current, admin_user, {"fx_mode": "manual"})
        assert response.status_code == 400
        assert response.json()["detail"] == {
            "code": "INCOMPLETE", "missing": ["fx_manual_rate"], "method": "transferencia",
            "message": "Escribe la tasa manual: la transferencia bancaria la usa para calcular el monto en bolívares.",
        }
        ok = await _set_settings(client, current, admin_user, {"fx_mode": "manual", "fx_manual_rate": "900,50"})
        assert ok.status_code == 200, ok.text

    async def test_binance(self, client, current, admin_user, org_config):
        await _set_settings(client, current, admin_user, {"whatsapp": "584248824634"})
        response = await _set_method(client, current, admin_user, mm.BINANCE, BINANCE)
        assert response.status_code == 200, response.text
        assert response.json()["settings"] == {
            "pay_id": "123456789", "usdt_address": TRC20, "usdt_network": "TRC20", "instructions": "",
        }
        # An address of another network is refused, naming the network.
        evm = await _set_method(client, current, admin_user, mm.BINANCE, {"usdt_address": EVM})
        assert evm.status_code == 400
        assert evm.json()["detail"]["message"] == "Revisa la dirección USDT: no corresponde a la red TRC20 (Tron)."
        bep20 = await _set_method(client, current, admin_user, mm.BINANCE, {"usdt_address": EVM, "usdt_network": "BSC"})
        assert bep20.status_code == 200 and bep20.json()["settings"]["usdt_network"] == "BEP20"
        # The Pay ID alone is enough; an address without its network is not.
        pay_id_only = await _set_method(client, current, admin_user, mm.BINANCE,
                                        {"usdt_address": "", "usdt_network": ""})
        assert pay_id_only.status_code == 200 and pay_id_only.json()["active"] is True
        no_network = await _set_method(client, current, admin_user, mm.BINANCE, {"pay_id": "", "usdt_address": TRC20})
        assert no_network.status_code == 400
        assert no_network.json()["detail"]["missing"] == ["usdt_network"]

    @pytest.mark.parametrize("method,field,value", [
        ("transferencia", "bank_name", "B"),
        ("transferencia", "bank_code", "134"),
        ("transferencia", "account_number", "0134-1234"),
        ("transferencia", "account_number", "0134" + "x" * 16),
        ("transferencia", "account_type", "nómina"),
        ("transferencia", "holder_name", "H" * 81),
        ("transferencia", "id_document", "X-1"),
        ("transferencia", "instructions", "x" * 501),
        ("zelle", "email", "no-es-un-correo"),
        ("zelle", "phone", "0424-1234567"),
        ("zelle", "phone", "123"),
        ("zelle", "holder_name", "H" * 81),
        ("binance", "pay_id", "abc123"),
        ("binance", "pay_id", "1234"),
        ("binance", "usdt_network", "BTC"),
        ("binance", "usdt_address", "T" + "0" * 33),
        ("binance", "usdt_address", "dirección con ñ"),
        ("zelle", "enabled", "sí"),
    ])
    async def test_invalid_field(self, client, current, db, admin_user, org_config, method, field, value):
        body = {field: value}
        if field == "usdt_address":
            body["usdt_network"] = "TRC20"
        response = await _set_method(client, current, admin_user, method, body)
        assert response.status_code == 400, response.text
        detail = response.json()["detail"]
        assert detail["code"] == "INVALID_FIELD" and detail["field"] == field and detail["message"]
        assert await _rows(db, PaymentsConfig) == []

    async def test_fields_of_other_methods_are_ignored(self, client, current, admin_user, org_config):
        response = await _set_method(client, current, admin_user, mm.ZELLE, {"pay_id": "123456", "bank_name": "X"})
        assert response.status_code == 200
        assert response.json()["settings"] == {"email": "", "phone": "", "holder_name": "", "instructions": ""}

    async def test_the_whatsapp_cannot_go_while_another_method_is_on(self, client, current, admin_user, zelle_only):
        response = await _set_settings(client, current, admin_user, {"whatsapp": ""})
        assert response.status_code == 400
        assert response.json()["detail"] == {
            "code": "INCOMPLETE", "missing": ["whatsapp"], "method": "zelle",
            "message": "Para quitar el WhatsApp, primero desactiva Zelle: lo usa para los comprobantes.",
        }
        assert (await _set_method(client, current, admin_user, mm.ZELLE, {"enabled": False})).status_code == 200
        assert (await _set_settings(client, current, admin_user, {"whatsapp": ""})).status_code == 200

    async def test_a_saved_pago_movil_stays_as_it_was(self, client, current, db, admin_user, manual):
        before = (await _rows(db, PaymentsConfig))[0]
        state = (before.enabled, before.active, dict(before.provider_config))
        assert (await _set_method(client, current, admin_user, mm.BINANCE, BINANCE)).status_code == 200
        after = (await _rows(db, PaymentsConfig))[0]
        assert (after.enabled, after.active) == state[:2]
        assert {k: v for k, v in after.provider_config.items() if k != "binance"} == state[2]


class TestProvidersAndQuote:
    async def test_checkout_providers_list_the_methods_on(self, client, current, admin_user, paypal_config):
        await _set_settings(client, current, admin_user, {"whatsapp": "584248824634"})
        assert [p["provider"] for p in (await client.get(f"{BASE}/checkout/providers")).json()] == ["paypal"]
        await _set_method(client, current, admin_user, mm.ZELLE, ZELLE)
        manual_entry = (await client.get(f"{BASE}/checkout/providers")).json()[1]
        assert (manual_entry["provider"], manual_entry["methods"]) == ("manual", ["zelle"])
        await _set_method(client, current, admin_user, mm.BINANCE, BINANCE)
        assert (await client.get(f"{BASE}/checkout/providers")).json()[1]["methods"] == ["zelle", "binance"]
        await _set_method(client, current, admin_user, mm.ZELLE, {"enabled": False})
        await _set_method(client, current, admin_user, mm.BINANCE, {"enabled": False})
        assert [p["provider"] for p in (await client.get(f"{BASE}/checkout/providers")).json()] == ["paypal"]

    async def test_quote_lists_every_method(self, client, current, all_methods):
        body = await _quote(client, current, None, all_methods)
        bcv = {"rate": 887.302, "rate_date": "2026-10-27", "rate_source": "bcv", "error": None}
        assert body["methods"] == [
            {"method": "pago_movil", "currency": "VES", "amount": 35492.08, **bcv},
            {"method": "transferencia", "currency": "VES", "amount": 35492.08, **bcv},
            {"method": "zelle", "currency": "USD", "amount": 40.0, "rate": None, "rate_date": None,
             "rate_source": None, "error": None},
            {"method": "binance", "currency": "USDT", "amount": 40.0, "rate": None, "rate_date": None,
             "rate_source": None, "error": None},
        ]
        assert body["pago_movil"] == {"enabled": True, "rate": 887.302, "rate_date": "2026-10-27",
                                      "rate_source": "bcv", "amount_ves": 35492.08, "error": None}

    async def test_without_a_rate_only_the_bolivares_fail(self, client, current, db, all_methods, bcv_source):
        bcv_source.error = RuntimeError("dolarapi down")
        await db.execute(delete(PaymentsFxRate))  # no stored rate to fall back on
        await db.commit()
        methods = {m["method"]: m for m in (await _quote(client, current, None, all_methods))["methods"]}
        assert methods["transferencia"]["error"] == "FX_UNAVAILABLE" and methods["transferencia"]["amount"] is None
        assert methods["pago_movil"]["error"] == "FX_UNAVAILABLE"
        assert (methods["zelle"]["amount"], methods["zelle"]["error"]) == (40.0, None)

    async def test_dollar_methods_never_ask_for_the_rate(self, client, current, zelle_only, bcv_source):
        calls = bcv_source.calls
        body = await _quote(client, current, None, zelle_only)
        assert [m["method"] for m in body["methods"]] == ["zelle"] and body["pago_movil"] == {"enabled": False}
        assert bcv_source.calls == calls


# ---------------------------------------------------------------- checkout


class TestCheckoutByMethod:
    async def test_zelle(self, client, current, db, outsider, zelle_only, sent_emails, bcv_source):
        calls = bcv_source.calls
        body = await _buy(client, current, outsider, zelle_only, mm.ZELLE)
        assert bcv_source.calls == calls
        assert (body["method"], body["pay_currency"], body["pay_amount"], body["amount"]) == ("zelle", "USD", 40.0, 40.0)
        assert (body["amount_ves"], body["fx_rate"], body["fx_source"], body["fx_date"]) == (None, None, None, None)
        assert body["payment"] == {"email": "pagos@example.com", "phone": "+1 305-555-1234",
                                   "holder_name": "Hilda Hernández (borrar)",
                                   "instructions": "Pon el código del pedido en la nota."}
        assert unquote(body["whatsapp_url"].split("?text=", 1)[1]) == (
            f"Hola, hice un pago por Zelle para mi pedido {body['code']} en Sanar y Criar.\n"
            "Monto: US$ 40,00\n"
            "Productos: Curso completo, Ebook de límites\n"
            "Nombre: Outsider Test\n"
            "Te envío el comprobante."
        )
        purchase = (await _rows(db, PaymentsPurchase))[0]
        assert (purchase.method, purchase.amount_ves, purchase.fx_rate, purchase.fx_source) == ("zelle", None, None, None)
        assert purchase.payment_details["email"] == "pagos@example.com"
        assert purchase.payment_details["whatsapp"] == "584248824634"
        orders = await _rows(db, PaymentsOrder)
        assert [(o.provider, o.method, o.fx_rate, o.currency) for o in orders] == [
            ("manual", "zelle", None, "USD"), ("manual", "zelle", None, "USD"),
        ]
        assert await _emails(sent_emails) == sorted([
            ("outsider@test.com", f"Tu pedido {body['code']}: datos para pagar con Zelle"),
            ("avisos@example.com", f"Nuevo pedido {body['code']} por confirmar"),
        ])
        documents = {c.kwargs["to"]: c.kwargs["body"] for c in sent_emails.call_args_list}
        buyer_email, notice = documents["outsider@test.com"], documents["avisos@example.com"]
        assert "envía <strong>US$ 40,00</strong> por Zelle" in buyer_email
        assert "Correo de Zelle" in buyer_email and "pagos@example.com" in buyer_email and "Tasa" not in buyer_email
        assert "hizo un pedido con Zelle por" in notice and "US$ 40,00" in notice and "Bs." not in notice
        assert "en tu Zelle" in notice

    async def test_binance(self, client, current, outsider, all_methods, sent_emails):
        body = await _buy(client, current, outsider, all_methods, mm.BINANCE)
        assert (body["method"], body["pay_currency"], body["pay_amount"], body["amount_ves"]) == ("binance", "USDT", 40.0, None)
        assert body["payment"] == {"pay_id": "123456789", "usdt_address": TRC20, "usdt_network": "TRC20",
                                   "instructions": ""}
        message = unquote(body["whatsapp_url"].split("?text=", 1)[1])
        assert message.startswith(f"Hola, hice un pago por Binance para mi pedido {body['code']}")
        assert "Monto: 40,00 USDT\n" in message
        await _emails(sent_emails)
        buyer_email = {c.kwargs["to"]: c.kwargs["body"] for c in sent_emails.call_args_list}["outsider@test.com"]
        assert "40,00 USDT" in buyer_email and TRC20 in buyer_email and "TRC20 (Tron)" in buyer_email
        assert "usa solo la red" in buyer_email

    async def test_transfer(self, client, current, outsider, all_methods, sent_emails):
        body = await _buy(client, current, outsider, all_methods, mm.TRANSFERENCIA)
        assert (body["method"], body["pay_currency"], body["pay_amount"], body["amount_ves"], body["fx_rate"]) == (
            "transferencia", "VES", 35492.08, 35492.08, 887.302,
        )
        assert body["payment"] == {
            "bank_name": "Banesco", "bank_code": "0134", "account_number": "01340000000000000001",
            "account_type": "corriente", "holder_name": "Hilda Hernández (borrar)", "id_document": "V-12345678",
            "instructions": "",
        }
        message = unquote(body["whatsapp_url"].split("?text=", 1)[1])
        assert message.startswith(f"Hola, hice una transferencia bancaria para mi pedido {body['code']}")
        assert "Monto: Bs. 35.492,08 (US$ 40,00)\n" in message
        await _emails(sent_emails)
        documents = {c.kwargs["to"]: c.kwargs for c in sent_emails.call_args_list}
        assert documents["outsider@test.com"]["subject"].endswith("datos para pagar con transferencia bancaria")
        assert "01340000000000000001" in documents["outsider@test.com"]["body"]
        assert "Tasa BCV del 27/10/2026" in documents["outsider@test.com"]["body"]

    async def test_pago_movil_is_unchanged(self, client, current, outsider, all_methods):
        body = await _buy(client, current, outsider, all_methods, mm.PAGO_MOVIL)
        assert (body["method"], body["pay_currency"], body["pay_amount"], body["amount_ves"]) == (
            "pago_movil", "VES", 35492.08, 35492.08,
        )
        assert set(body["payment"]) == {"bank_name", "bank_code", "phone", "id_document", "holder_name", "instructions"}

    async def test_a_method_that_is_off(self, client, current, outsider, zelle_only):
        for method, label in (("binance", "Binance"), ("transferencia", "Transferencia bancaria"),
                              ("pago_movil", "Pago Móvil")):
            response = await _checkout(client, current, outsider, zelle_only, method=method)
            assert response.status_code == 400
            assert response.json()["detail"] == {"code": "METHOD_UNAVAILABLE",
                                                 "message": f"{label} no está disponible en este momento."}

    async def test_transfer_without_a_rate(self, client, current, db, outsider, all_methods, bcv_source):
        bcv_source.error = RuntimeError("dolarapi down")
        await db.execute(delete(PaymentsFxRate))  # no stored rate to fall back on
        await db.commit()
        response = await _checkout(client, current, outsider, all_methods, method=mm.TRANSFERENCIA)
        assert response.status_code == 503 and response.json()["detail"]["code"] == "FX_UNAVAILABLE"
        assert (await _checkout(client, current, outsider, all_methods, method=mm.ZELLE)).status_code == 201

    async def test_one_pending_order_per_product_whatever_the_method(self, client, current, outsider, all_methods):
        first = await _buy(client, current, outsider, all_methods, mm.ZELLE)
        again = await _checkout(client, current, outsider, all_methods, method=mm.PAGO_MOVIL)
        assert again.status_code == 409
        detail = again.json()["detail"]
        assert (detail["code"], detail["purchase_code"]) == ("PAYMENT_PENDING", first["code"])


# ----------------------------------------------------------------- confirm


class TestConfirmByMethod:
    async def test_zelle_is_confirmed_like_pago_movil(self, client, current, outsider, admin_user, course, zelle_only,
                                                      sent_emails):
        purchase = await _buy(client, current, outsider, zelle_only, mm.ZELLE)
        assert (await _access(client, current, outsider, course))["has_access"] is False
        response = await _act(client, current, admin_user, purchase, "confirm", {"bank_reference": "ab12-cd34"})
        assert response.status_code == 200, response.text
        body = response.json()
        assert (body["status"], body["bank_reference"], body["method"], body["pay_amount"]) == (
            "paid", "AB12CD34", "zelle", 40.0,
        )
        assert (await _access(client, current, outsider, course))["has_access"] is True
        assert (f"outsider@test.com", f"Ya tienes acceso: pedido {purchase['code']}") in await _emails(sent_emails)
        voided = await _act(client, current, admin_user, purchase, "void", {"reason": "Pago duplicado"})
        assert voided.status_code == 200 and voided.json()["status"] == "voided"
        assert (await _access(client, current, outsider, course))["has_access"] is False

    async def test_binance_takes_a_transaction_hash(self, client, current, outsider, admin_user, all_methods):
        purchase = await _buy(client, current, outsider, all_methods, mm.BINANCE)
        too_long = await _act(client, current, admin_user, purchase, "confirm", {"bank_reference": "a" * 101})
        assert too_long.status_code == 400
        assert too_long.json()["detail"] == {"code": "INVALID_REFERENCE",
                                             "message": "La referencia debe tener entre 4 y 100 letras o números."}
        txid = "0x" + "9f" * 32
        response = await _act(client, current, admin_user, purchase, "confirm", {"bank_reference": txid})
        assert response.status_code == 200, response.text
        assert response.json()["bank_reference"] == txid.upper()

    async def test_bank_references_stay_short(self, client, current, outsider, admin_user, all_methods):
        purchase = await _buy(client, current, outsider, all_methods, mm.TRANSFERENCIA)
        response = await _act(client, current, admin_user, purchase, "confirm", {"bank_reference": "1" * 31})
        assert response.status_code == 400
        assert response.json()["detail"]["message"] == "La referencia debe tener entre 4 y 30 letras o números."

    async def test_rejecting_a_binance_order(self, client, current, outsider, admin_user, all_methods, sent_emails):
        purchase = await _buy(client, current, outsider, all_methods, mm.BINANCE)
        response = await _act(client, current, admin_user, purchase, "reject",
                              {"reason": "No vimos el pago", "notify": True})
        assert response.status_code == 200 and response.json()["status"] == "rejected"
        assert ("outsider@test.com", f"No pudimos confirmar el pago del pedido {purchase['code']}") in \
            await _emails(sent_emails)

    async def test_a_reference_is_reused_only_within_its_statement(self, client, current, db, outsider, regular_user,
                                                                  admin_user, ebook_offer, all_methods):
        course_offer, ebook = all_methods
        # A Zelle code equal to a Pago Móvil reference is a coincidence...
        zelle = await _buy(client, current, outsider, [course_offer], mm.ZELLE)
        assert (await _act(client, current, admin_user, zelle, "confirm", {"bank_reference": "123456"})).status_code == 200
        pago_movil = await _buy(client, current, outsider, [ebook], mm.PAGO_MOVIL)
        response = await _act(client, current, admin_user, pago_movil, "confirm", {"bank_reference": "123456"})
        assert response.status_code == 200, response.text
        assert response.json()["reference_reused_in"] == []
        # ...but Pago Móvil and transfers land in the same bank statement.
        transfer = await _buy(client, current, regular_user, [course_offer], mm.TRANSFERENCIA)
        reused = await _act(client, current, admin_user, transfer, "confirm", {"bank_reference": "123456"})
        assert reused.status_code == 409
        assert reused.json()["detail"]["code"] == "REFERENCE_USED"
        assert reused.json()["detail"]["purchases"] == [pago_movil["code"]]

    async def test_a_pending_order_shows_the_current_details(self, client, current, outsider, admin_user, zelle_only):
        purchase = await _buy(client, current, outsider, zelle_only, mm.ZELLE)
        await _set_method(client, current, admin_user, mm.ZELLE, {"email": "nuevo@example.com"})
        current.set(outsider)
        fresh = (await client.get(f"{BASE}/purchases/{purchase['purchase_uuid']}")).json()
        assert fresh["payment"]["email"] == "nuevo@example.com"
        # Incomplete now (no holder): the order keeps the details it was created with.
        await _set_method(client, current, admin_user, mm.ZELLE, {"enabled": False, "holder_name": ""})
        current.set(outsider)
        fresh = (await client.get(f"{BASE}/purchases/{purchase['purchase_uuid']}")).json()
        assert fresh["payment"]["email"] == "pagos@example.com"
        assert fresh["payment"]["holder_name"] == "Hilda Hernández (borrar)"

    async def test_admin_list_and_my_purchases(self, client, current, outsider, admin_user, all_methods):
        course_offer, ebook = all_methods
        await _buy(client, current, outsider, [course_offer], mm.BINANCE)
        await _buy(client, current, outsider, [ebook], mm.TRANSFERENCIA)
        current.set(admin_user)
        listed = (await client.get(f"{BASE}/purchases", params={"status": "pending"})).json()["items"]
        assert [(p["method"], p["pay_currency"], p["pay_amount"]) for p in listed] == [
            ("binance", "USDT", 25.0), ("transferencia", "VES", round(15 * 887.302, 2)),
        ]
        current.set(outsider)
        mine = (await client.get(f"{BASE}/purchases/mine")).json()["items"]
        assert {p["method"] for p in mine} == {"binance", "transferencia"}


# ------------------------------------------------------------------ pieces


class TestPieces:
    def test_reference_lengths(self):
        assert normalize_reference("1" * 30) == "1" * 30
        assert normalize_reference("1" * 31) is None
        assert normalize_reference("ab" * 50, max_length=100) == "AB" * 50
        assert normalize_reference("abc", max_length=100) is None

    @pytest.mark.parametrize("address,network,ok", [
        (TRC20, "TRC20", True), (EVM, "TRC20", False), ("T" + "0" * 33, "TRC20", False),
        (EVM, "ERC20", True), (EVM, "BEP20", True), (EVM, "POLYGON", True), (EVM, "ARBITRUM", True),
        ("0x" + "g1" * 20, "ERC20", False), (TRC20, "BEP20", False),
        ("7" * 44, "SOL", True), ("7" * 31, "SOL", False), (EVM, "SOL", False),
    ])
    def test_address_shapes(self, address, network, ok):
        assert mm.address_matches_network(address, network) is ok

    def test_missing_message(self):
        assert mm.missing_message("binance", ["pay_id_or_address", "whatsapp"]) == (
            "Para activar Binance falta: Binance Pay ID o dirección USDT y WhatsApp."
        )
        assert mm.missing_message("transferencia", ["bank_name", "account_number", "whatsapp"]) == (
            "Para activar Transferencia bancaria falta: banco, número de cuenta y WhatsApp."
        )

    @pytest.mark.parametrize("column,need,current,ddl", [
        ("fx_rate", "nullable", (False, None), "ALTER TABLE sc_pay_purchase ALTER COLUMN fx_rate DROP NOT NULL"),
        ("fx_rate", "nullable", (True, None), None),
        ("bank_reference", 100, (True, 32), "ALTER TABLE sc_pay_purchase ALTER COLUMN bank_reference TYPE VARCHAR(100)"),
        ("bank_reference", 100, (True, 100), None),
        ("bank_reference", 100, (True, 120), None),
    ])
    def test_column_changes(self, column, need, current, ddl):
        assert schema._ddl_for(column, need, current) == ddl

    async def test_columns_on_sqlite_need_nothing(self, engine, db, org):
        await db.commit()
        results = await schema.ensure_payments_columns(engine)
        assert results == {f"sc_pay_purchase.{c}": True for c in ("fx_rate", "fx_source", "amount_ves", "bank_reference")}
        assert schema.columns_in_place() is True
        await schema.retry_columns_if_needed()  # nothing left to do: a no-op
        nullable = {c.name: c.nullable for c in PaymentsPurchase.__table__.columns}
        assert nullable["fx_rate"] and nullable["fx_source"] and nullable["amount_ves"]
        assert PaymentsPurchase.__table__.columns["bank_reference"].type.length == 100
        assert (await db.execute(select(PaymentsPurchase))).first() is None

    def test_pay_amounts(self):
        from src.services.payments.purchase_emails import amount_text, pay_text

        assert pay_text("zelle", Decimal("40"), None) == "US$ 40,00"
        assert pay_text("binance", Decimal("40"), None) == "40,00 USDT"
        assert pay_text("transferencia", Decimal("40"), Decimal("35492.08")) == "Bs. 35.492,08"
        assert amount_text("pago_movil", Decimal("40"), Decimal("35492.08")) == "Bs. 35.492,08 (US$ 40,00)"
        assert amount_text("zelle", Decimal("40"), None) == "US$ 40,00"

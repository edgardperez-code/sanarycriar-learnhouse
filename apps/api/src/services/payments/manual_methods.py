"""Sanar y Criar: the manual payment methods of the cart.

Four ways to pay that the buyer does on her own and an admin confirms in
Pedidos (``purchases.confirm_purchase``):

- ``pago_movil``: Pago Móvil, in bolívares at the day's rate (``fx.py``).
- ``transferencia``: a bank transfer in Venezuela, in bolívares at that rate.
- ``zelle``: Zelle, in US dollars.
- ``binance``: Binance (Pay ID or a USDT address), in USDT (1 USDT = 1 US$).

Storage, in the ``provider_config`` of the org's
``PaymentsConfig(provider="manual")`` row:

- Flat keys, as before these methods existed: the Pago Móvil details
  (``providers/manual.py``) and the settings every method shares: the
  WhatsApp for the receipts, the time to pay, the exchange rate and the
  e-mail for new-order notices.
- ``"transferencia"``, ``"zelle"``, ``"binance"``: ``{"enabled": bool, ...its
  details}``.

The row's ``enabled`` and ``active`` columns keep meaning "Pago Móvil on" and
"Pago Móvil complete", so an image without these methods (a rollback) sees
Pago Móvil exactly as it was and never offers the others. None of this is
secret: it is what every buyer is shown.
"""

import re
from typing import Any, Optional

from src.services.payments.providers.manual import (
    REQUIRED_FIELDS as PAGO_MOVIL_REQUIRED,
    InvalidSetting,
    _as_text,
    _bank_code,
    _bank_name,
    _holder_name,
    _id_document,
    _instructions,
    _notify_email,
    missing_fields as pago_movil_missing,
    payment_details_of as pago_movil_details,
    settings_of,
)

PAGO_MOVIL = "pago_movil"
TRANSFERENCIA = "transferencia"
ZELLE = "zelle"
BINANCE = "binance"

# Display order (cart, settings, quote).
METHODS = (PAGO_MOVIL, TRANSFERENCIA, ZELLE, BINANCE)
# Configured through /manual/methods (Pago Móvil keeps /manual/settings).
EXTRA_METHODS = (TRANSFERENCIA, ZELLE, BINANCE)

LABELS = {
    PAGO_MOVIL: "Pago Móvil",
    TRANSFERENCIA: "Transferencia bancaria",
    ZELLE: "Zelle",
    BINANCE: "Binance",
}

# What the buyer pays in: bolívares at the rate, dollars, or USDT at par.
CURRENCY = {PAGO_MOVIL: "VES", TRANSFERENCIA: "VES", ZELLE: "USD", BINANCE: "USDT"}
VES_METHODS = (PAGO_MOVIL, TRANSFERENCIA)

# Purchases whose references come from the same statement: a reference
# already used by one of them is a reused one (REFERENCE_USED).
REFERENCE_CHANNELS = {
    PAGO_MOVIL: VES_METHODS,
    TRANSFERENCIA: VES_METHODS,
    ZELLE: (ZELLE,),
    BINANCE: (BINANCE,),
}
REFERENCE_MAX_LENGTH = 30
# A USDT transaction hash (TxID) is 64-66 characters.
REFERENCE_MAX_LENGTHS = {BINANCE: 100}

ACCOUNT_TYPES = ("corriente", "ahorro")
ACCOUNT_TYPE_LABELS = {"corriente": "Corriente", "ahorro": "Ahorro"}

NETWORKS = ("TRC20", "BEP20", "ERC20", "SOL", "POLYGON", "ARBITRUM")
NETWORK_LABELS = {
    "TRC20": "TRC20 (Tron)",
    "BEP20": "BEP20 (BNB Smart Chain)",
    "ERC20": "ERC20 (Ethereum)",
    "SOL": "Solana",
    "POLYGON": "Polygon",
    "ARBITRUM": "Arbitrum One",
}
_NETWORK_ALIASES = {
    "TRON": "TRC20", "TRX": "TRC20",
    "BSC": "BEP20", "BNB": "BEP20", "BNBSMARTCHAIN": "BEP20",
    "ETH": "ERC20", "ETHEREUM": "ERC20",
    "SOLANA": "SOL",
    "MATIC": "POLYGON", "POL": "POLYGON",
    "ARB": "ARBITRUM", "ARBITRUMONE": "ARBITRUM",
}
_EVM_NETWORKS = ("BEP20", "ERC20", "POLYGON", "ARBITRUM")
_BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

FIELDS: dict[str, tuple[str, ...]] = {
    TRANSFERENCIA: ("bank_name", "bank_code", "account_number", "account_type", "holder_name", "id_document",
                    "instructions"),
    ZELLE: ("email", "phone", "holder_name", "instructions"),
    BINANCE: ("pay_id", "usdt_address", "usdt_network", "instructions"),
}

# Keys of ``payment`` in a purchase (what the buyer is shown), per method.
PAYMENT_KEYS: dict[str, tuple[str, ...]] = {
    PAGO_MOVIL: ("bank_name", "bank_code", "phone", "id_document", "holder_name", "instructions"),
    TRANSFERENCIA: FIELDS[TRANSFERENCIA],
    ZELLE: FIELDS[ZELLE],
    BINANCE: FIELDS[BINANCE],
}

FIELD_MESSAGES = {
    "bank_name": "Escribe el nombre del banco.",
    "bank_code": "El código del banco tiene 4 dígitos, por ejemplo 0134.",
    "account_number": "Escribe los 20 dígitos de la cuenta, por ejemplo 0134 0000 00 0000000000.",
    "account_type": "Elige el tipo de cuenta: corriente o ahorro.",
    "holder_name": "El nombre del titular admite hasta 80 caracteres.",
    "id_document": "Escribe la cédula o el RIF, por ejemplo V-12345678 o J-412345678.",
    "email": "Escribe un correo válido.",
    "phone": "Escribe el teléfono de Zelle con código de área, por ejemplo +1 305 555 1234.",
    "pay_id": "El Binance Pay ID son solo números, por ejemplo 123456789.",
    "usdt_address": "Revisa la dirección USDT.",
    "usdt_network": "Elige la red de la dirección USDT.",
    "instructions": "Las instrucciones admiten hasta 500 caracteres.",
}

# Names of the missing data, for the INCOMPLETE message.
MISSING_LABELS = {
    "bank_name": "banco",
    "bank_code": "código del banco",
    "phone": "teléfono",
    "id_document": "cédula o RIF",
    "account_number": "número de cuenta",
    "account_type": "tipo de cuenta",
    "holder_name": "titular",
    "email_or_phone": "correo o teléfono de Zelle",
    "pay_id_or_address": "Binance Pay ID o dirección USDT",
    "usdt_network": "red de la dirección USDT",
    "whatsapp": "WhatsApp",
    "fx_manual_rate": "tasa manual",
}


# ----------------------------------------------------------- normalization


def _field_error(field: str, message: Optional[str] = None) -> InvalidSetting:
    return InvalidSetting(field, message or FIELD_MESSAGES.get(field))


def _wrap(field: str, normalize):
    """Reuse a Pago Móvil normalizer under this method's field name/message."""
    def run(value: Any):
        try:
            return normalize(value)
        except InvalidSetting:
            raise _field_error(field)
    return run


def _account_number(value: Any) -> str:
    text = re.sub(r"[\s.\-]", "", _as_text("account_number", value))
    if not text:
        return ""
    if not re.fullmatch(r"\d{20}", text):
        raise _field_error("account_number")
    return text


def _account_type(value: Any) -> str:
    text = _as_text("account_type", value).strip().lower()
    if not text:
        return ""
    text = {"ahorros": "ahorro", "de ahorro": "ahorro", "cuenta corriente": "corriente"}.get(text, text)
    if text not in ACCOUNT_TYPES:
        raise _field_error("account_type")
    return text


def _zelle_phone(value: Any) -> str:
    text = _as_text("phone", value).strip()
    if not text:
        return ""
    digits = re.sub(r"\D", "", text)
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    # A US number: area code and exchange never start with 0 or 1.
    if not re.fullmatch(r"[2-9]\d{2}[2-9]\d{6}", digits):
        raise _field_error("phone")
    return f"+1 {digits[:3]}-{digits[3:6]}-{digits[6:]}"


def _pay_id(value: Any) -> str:
    text = re.sub(r"\s", "", _as_text("pay_id", value))
    if not text:
        return ""
    if not re.fullmatch(r"\d{5,20}", text):
        raise _field_error("pay_id")
    return text


def _network(value: Any) -> str:
    text = re.sub(r"[\s_\-()]", "", _as_text("usdt_network", value)).upper()
    if not text:
        return ""
    text = _NETWORK_ALIASES.get(text, text)
    if text not in NETWORKS:
        raise _field_error("usdt_network")
    return text


def _address(value: Any) -> str:
    text = re.sub(r"\s", "", _as_text("usdt_address", value))
    if not text:
        return ""
    if len(text) > 100 or not re.fullmatch(r"[A-Za-z0-9]+", text):
        raise _field_error("usdt_address")
    return text


def address_matches_network(address: str, network: str) -> bool:
    """Whether a USDT address has the shape of ``network``'s addresses."""
    if network == "TRC20":
        return len(address) == 34 and address[0] == "T" and all(c in _BASE58 for c in address)
    if network in _EVM_NETWORKS:
        return re.fullmatch(r"0x[0-9a-fA-F]{40}", address) is not None
    if network == "SOL":
        return 32 <= len(address) <= 44 and all(c in _BASE58 for c in address)
    return True


_NORMALIZERS = {
    TRANSFERENCIA: {
        "bank_name": _wrap("bank_name", _bank_name),
        "bank_code": _wrap("bank_code", _bank_code),
        "account_number": _account_number,
        "account_type": _account_type,
        "holder_name": _wrap("holder_name", _holder_name),
        "id_document": _wrap("id_document", _id_document),
        "instructions": _wrap("instructions", _instructions),
    },
    ZELLE: {
        "email": _wrap("email", _notify_email),
        "phone": _zelle_phone,
        "holder_name": _wrap("holder_name", _holder_name),
        "instructions": _wrap("instructions", _instructions),
    },
    BINANCE: {
        "pay_id": _pay_id,
        "usdt_address": _address,
        "usdt_network": _network,
        "instructions": _wrap("instructions", _instructions),
    },
}


# ------------------------------------------------------------------ reads


def _stored(cfg) -> dict:
    return dict(getattr(cfg, "provider_config", None) or {})


def method_settings(cfg, method: str) -> dict:
    """The details of one of EXTRA_METHODS ("" for the missing ones)."""
    stored = _stored(cfg).get(method)
    stored = stored if isinstance(stored, dict) else {}
    result = {}
    for field in FIELDS[method]:
        value = stored.get(field)
        result[field] = value if isinstance(value, str) else ""
    return result


def method_enabled(cfg, method: str) -> bool:
    """Its switch. Pago Móvil's is the row's ``enabled`` column."""
    if cfg is None:
        return False
    if method == PAGO_MOVIL:
        return bool(cfg.enabled)
    stored = _stored(cfg).get(method)
    return isinstance(stored, dict) and stored.get("enabled") is True


def common_missing(common: dict, method: str) -> list[str]:
    """Shared settings ``method`` needs: the WhatsApp for the receipts and,
    for bolívares with the manual rate, that rate."""
    missing = []
    if not common.get("whatsapp"):
        missing.append("whatsapp")
    if method in VES_METHODS and common.get("fx_mode") == "manual" and not common.get("fx_manual_rate"):
        missing.append("fx_manual_rate")
    return missing


def own_missing(method: str, settings: dict) -> list[str]:
    """The method's own required details still empty, in form order."""
    if method == TRANSFERENCIA:
        return [f for f in ("bank_name", "account_number", "account_type", "holder_name", "id_document")
                if not settings.get(f)]
    if method == ZELLE:
        missing = [] if settings.get("email") or settings.get("phone") else ["email_or_phone"]
        return missing + ([] if settings.get("holder_name") else ["holder_name"])
    if method == BINANCE:
        if not settings.get("pay_id") and not settings.get("usdt_address"):
            return ["pay_id_or_address"]
        return ["usdt_network"] if settings.get("usdt_address") and not settings.get("usdt_network") else []
    return []


def missing_of(method: str, settings: dict, common: dict) -> list[str]:
    return own_missing(method, settings) + common_missing(common, method)


def method_missing(cfg, method: str) -> list[str]:
    common = settings_of(cfg)
    if method == PAGO_MOVIL:
        return pago_movil_missing(common)
    return missing_of(method, method_settings(cfg, method), common)


def method_ready(cfg, method: str) -> bool:
    """On and complete: the cart offers it."""
    if cfg is None or method not in METHODS:
        return False
    if method == PAGO_MOVIL:
        # Exactly as before the other methods existed.
        return bool(cfg.active) and bool(cfg.enabled)
    return method_enabled(cfg, method) and not method_missing(cfg, method)


def ready_methods(cfg) -> list[str]:
    return [m for m in METHODS if method_ready(cfg, m)]


def payment_details(cfg, method: str) -> dict:
    """What a buyer needs to pay with ``method`` (and the receipt WhatsApp)."""
    common = settings_of(cfg)
    if method == PAGO_MOVIL:
        return pago_movil_details(common)
    return {**method_settings(cfg, method), "whatsapp": common.get("whatsapp") or ""}


def buyer_payment_details(cfg, method: str, snapshot: Optional[dict]) -> dict:
    """The admin's current details for ``method`` (she may have changed
    account); the ones shown at checkout when the current ones are incomplete."""
    common = settings_of(cfg)
    if method == PAGO_MOVIL:
        complete = all(common.get(field) for field in PAGO_MOVIL_REQUIRED)
    else:
        complete = not own_missing(method, method_settings(cfg, method)) and bool(common.get("whatsapp"))
    return payment_details(cfg, method) if complete else dict(snapshot or {})


def reference_max_length(method: Optional[str]) -> int:
    return REFERENCE_MAX_LENGTHS.get(method or "", REFERENCE_MAX_LENGTH)


def reference_channel(method: Optional[str]) -> tuple[str, ...]:
    return REFERENCE_CHANNELS.get(method or PAGO_MOVIL, (method or PAGO_MOVIL,))


# ----------------------------------------------------------------- writes


def apply_method_settings(method: str, current: dict, changes: dict) -> dict:
    """Validate and merge ``changes`` (only that method's fields that were
    sent) into ``current``. Omitted fields keep their value; ``""`` or null
    clears one. Raises InvalidSetting on the first invalid field, in form
    order, then on the checks between fields:

    - transferencia: the account starts with the bank's code (when the bank
      has one; otherwise the code is taken from the account);
    - binance: the address has the shape of its network's addresses.
    """
    result = dict(current)
    for field in FIELDS[method]:
        if field in changes:
            result[field] = _NORMALIZERS[method][field](changes[field])
    sent = set(changes)
    if method == TRANSFERENCIA and sent & {"bank_code", "account_number"}:
        account, code = result.get("account_number") or "", result.get("bank_code") or ""
        if account and not code:
            result["bank_code"] = account[:4]
        elif account and account[:4] != code:
            raise InvalidSetting("account_number", f"La cuenta debe empezar por el código del banco ({code}).")
    if method == BINANCE and sent & {"usdt_address", "usdt_network"}:
        address, network = result.get("usdt_address") or "", result.get("usdt_network") or ""
        if address and network and not address_matches_network(address, network):
            raise InvalidSetting(
                "usdt_address", f"Revisa la dirección USDT: no corresponde a la red {NETWORK_LABELS[network]}."
            )
    return result


def _join(items: list[str]) -> str:
    if len(items) <= 1:
        return "".join(items)
    return f"{', '.join(items[:-1])} y {items[-1]}"


def missing_message(method: str, missing: list[str]) -> str:
    """``Para activar Zelle falta: titular y WhatsApp.``"""
    names = [MISSING_LABELS.get(field, field) for field in missing]
    return f"Para activar {LABELS.get(method, method)} falta: {_join(names)}."


# How a switch is named in a sentence ("primero desactiva Zelle").
SWITCH_NAMES = {
    PAGO_MOVIL: "Pago Móvil",
    TRANSFERENCIA: "la transferencia bancaria",
    ZELLE: "Zelle",
    BINANCE: "Binance",
}


def needed_message(method: str, lacking: list[str]) -> str:
    """A shared setting that ``method`` (on) needs was left empty."""
    name = SWITCH_NAMES.get(method, method)
    if "whatsapp" in lacking:
        return f"Para quitar el WhatsApp, primero desactiva {name}: lo usa para los comprobantes."
    return f"Escribe la tasa manual: {name} la usa para calcular el monto en bolívares."


def enabled_message(method: str) -> str:
    return f"Indica si {LABELS.get(method, method)} está activo."


def unavailable_message(method: str) -> str:
    return f"{LABELS[method]} no está disponible en este momento."

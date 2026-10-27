"""Sanar y Criar: Pago Móvil paid by hand ("manual" provider).

The buyer pays in bolívares from her bank and sends the receipt by WhatsApp;
an org admin marks the purchase paid from the dashboard (Pedidos). Nothing
ever reaches this provider from outside: it has no checkout of its own (the
cart creates the orders), no webhooks, and it never reports ``paid``: a
manual order only becomes paid through ``purchases.confirm_purchase``.

Its settings live in the ``provider_config`` of the org's
``PaymentsConfig(provider="manual")`` row, normalized here. They hold no
secrets: they are the details shown to every buyer.
"""

import math
import re
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

from src.services.payments.providers.base import (
    PaymentResult,
    ProviderError,
    WebhookVerificationError,
)

PROVIDER_ID = "manual"
METHOD_ID = "pago_movil"

REQUIRED_FIELDS = ("bank_name", "bank_code", "phone", "id_document", "whatsapp")
FX_MODES = ("auto", "manual")
DEFAULT_WINDOW_HOURS = 24
MIN_WINDOW_HOURS = 1
MAX_WINDOW_HOURS = 168
MAX_MANUAL_RATE = Decimal("100000000")

DEFAULT_SETTINGS: dict = {
    "bank_name": "",
    "bank_code": "",
    "phone": "",
    "id_document": "",
    "holder_name": "",
    "whatsapp": "",
    "instructions": "",
    "payment_window_hours": DEFAULT_WINDOW_HOURS,
    "fx_mode": "auto",
    "fx_manual_rate": None,
    "notify_email": "",
}
SETTING_FIELDS = tuple(DEFAULT_SETTINGS.keys())

FIELD_MESSAGES = {
    "enabled": "Indica si Pago Móvil está activo.",
    "bank_name": "Escribe el nombre del banco.",
    "bank_code": "El código del banco tiene 4 dígitos, por ejemplo 0134.",
    "phone": "Escribe el teléfono del Pago Móvil, por ejemplo 0424-1234567.",
    "id_document": "Escribe la cédula o el RIF, por ejemplo V-12345678 o J-412345678.",
    "holder_name": "El nombre del titular admite hasta 80 caracteres.",
    "whatsapp": "Escribe el WhatsApp con código de país, por ejemplo 58 424 8824634.",
    "instructions": "Las instrucciones admiten hasta 500 caracteres.",
    "payment_window_hours": "El plazo debe estar entre 1 y 168 horas.",
    "fx_mode": "Elige la tasa automática (BCV) o una tasa manual.",
    "fx_manual_rate": "Escribe la tasa en Bs. por dólar, por ejemplo 887,30.",
    "notify_email": "Escribe un correo válido.",
}

AMBIGUOUS_RATE_MESSAGE = (
    "Escribe la tasa con 2 decimales (por ejemplo 887,30) para que no se confunda con miles."
)
MAX_RATE_DECIMALS = 4

_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class InvalidSetting(ValueError):
    """A Pago Móvil setting failed validation (``field`` names it)."""

    def __init__(self, field: str, message: Optional[str] = None):
        self.field = field
        self.message = message or FIELD_MESSAGES.get(field, "Valor no válido.")
        super().__init__(self.message)


# ----------------------------------------------------------- normalization


def _as_text(field: str, value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        raise InvalidSetting(field)
    if isinstance(value, int):
        return str(value)
    if not isinstance(value, str):
        raise InvalidSetting(field)
    return value


def _one_line(text: str) -> str:
    return " ".join(_CONTROL_CHARS.sub(" ", text).split())


def _bank_name(value: Any) -> str:
    text = _one_line(_as_text("bank_name", value))
    if text and not (2 <= len(text) <= 60):
        raise InvalidSetting("bank_name")
    return text


def _bank_code(value: Any) -> str:
    text = _as_text("bank_code", value).strip()
    if text and not re.fullmatch(r"\d{4}", text):
        raise InvalidSetting("bank_code")
    return text


def _phone(value: Any) -> str:
    text = _as_text("phone", value).strip()
    if not text:
        return ""
    digits = re.sub(r"\D", "", text)
    if digits.startswith("58") and len(digits) == 12:
        digits = "0" + digits[2:]
    if not re.fullmatch(r"04\d{9}", digits):
        raise InvalidSetting("phone")
    return f"{digits[:4]}-{digits[4:]}"


def _id_document(value: Any) -> str:
    text = re.sub(r"[\s.\-]", "", _as_text("id_document", value)).upper()
    if not text:
        return ""
    if not re.fullmatch(r"[VEJGP]\d{5,10}", text):
        raise InvalidSetting("id_document")
    return f"{text[0]}-{text[1:]}"


def _holder_name(value: Any) -> str:
    text = _one_line(_as_text("holder_name", value))
    if len(text) > 80:
        raise InvalidSetting("holder_name")
    return text


def _whatsapp(value: Any) -> str:
    text = _as_text("whatsapp", value).strip()
    if not text:
        return ""
    digits = re.sub(r"\D", "", text)
    if digits.startswith("0") and len(digits) == 11:
        digits = "58" + digits[1:]
    # Sanar y Criar: with the country code, no number is shorter than 11.
    if not re.fullmatch(r"\d{11,15}", digits):
        raise InvalidSetting("whatsapp")
    return digits


def _instructions(value: Any) -> str:
    text = _as_text("instructions", value).replace("\r\n", "\n").replace("\r", "\n")
    text = _CONTROL_CHARS.sub("", text).strip()
    if len(text) > 500:
        raise InvalidSetting("instructions")
    return text


def _window_hours(value: Any) -> int:
    if value is None or value == "":
        return DEFAULT_WINDOW_HOURS
    if isinstance(value, bool):
        raise InvalidSetting("payment_window_hours")
    if isinstance(value, float):
        if not value.is_integer():
            raise InvalidSetting("payment_window_hours")
        value = int(value)
    if isinstance(value, str):
        text = value.strip()
        if not re.fullmatch(r"\d{1,4}", text):
            raise InvalidSetting("payment_window_hours")
        value = int(text)
    if not isinstance(value, int) or not (MIN_WINDOW_HOURS <= value <= MAX_WINDOW_HOURS):
        raise InvalidSetting("payment_window_hours")
    return value


def _fx_mode(value: Any) -> str:
    if value is None or value == "":
        return "auto"
    if not isinstance(value, str) or value.strip().lower() not in FX_MODES:
        raise InvalidSetting("fx_mode")
    return value.strip().lower()


def _checked_rate(rate: Decimal) -> Decimal:
    if not rate.is_finite() or rate <= 0 or rate > MAX_MANUAL_RATE:
        raise InvalidSetting("fx_manual_rate")
    if -rate.as_tuple().exponent > MAX_RATE_DECIMALS:
        raise InvalidSetting("fx_manual_rate")
    return rate


def parse_rate_text(value: Any) -> Optional[Decimal]:
    """A Bs./US$ rate as the admin typed it, or a JSON number. None when empty.

    The dashboard applies the same rule before sending (keep them in step):
    1. Spaces and non-breaking spaces are removed; only ``0-9 . ,`` may remain.
    2. Both ``.`` and ``,``: the last one is the decimal separator and the
       other one groups thousands (removed); a second decimal one is invalid.
    3. One kind repeated (``1.050.000``): thousands. Groups of 3, no decimals.
    4. One separator once: followed by exactly 3 digits (``1.050``,
       ``887,302``) it is ambiguous (thousands or decimals?) and refused with
       its own message; otherwise it is the decimal separator.
    Then: digits on both sides of the decimal separator, more than 0, at most
    100 000 000 and at most 4 decimals. Raises InvalidSetting.
    """
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise InvalidSetting("fx_manual_rate")
    if isinstance(value, (int, float)):
        # A JSON number is never ambiguous: its "." is the decimal point.
        if isinstance(value, float) and not math.isfinite(value):
            raise InvalidSetting("fx_manual_rate")
        return _checked_rate(Decimal(str(value)))
    if not isinstance(value, str):
        raise InvalidSetting("fx_manual_rate")
    text = value.replace(" ", "").replace(" ", "")
    if not text:
        return None
    if not re.fullmatch(r"[0-9.,]+", text):
        raise InvalidSetting("fx_manual_rate")

    integer, fraction = text, None
    if "." in text and "," in text:
        decimal_sep = "," if text.rfind(",") > text.rfind(".") else "."
        text = text.replace("." if decimal_sep == "," else ",", "")
        if text.count(decimal_sep) != 1:
            raise InvalidSetting("fx_manual_rate")
        integer, fraction = text.split(decimal_sep)
    elif "." in text or "," in text:
        sep = "." if "." in text else ","
        if text.count(sep) > 1:
            groups = text.split(sep)
            if not (1 <= len(groups[0]) <= 3) or any(len(group) != 3 for group in groups[1:]):
                raise InvalidSetting("fx_manual_rate")
            integer = "".join(groups)
        else:
            integer, fraction = text.split(sep)
            if len(fraction) == 3:
                raise InvalidSetting("fx_manual_rate", AMBIGUOUS_RATE_MESSAGE)
    if not integer or fraction == "":
        raise InvalidSetting("fx_manual_rate")
    try:
        rate = Decimal(f"{integer}.{fraction}" if fraction else integer)
    except InvalidOperation:
        raise InvalidSetting("fx_manual_rate")
    return _checked_rate(rate)


def _fx_manual_rate(value: Any) -> Optional[str]:
    rate = parse_rate_text(value)
    return None if rate is None else format(rate, "f")


def _notify_email(value: Any) -> str:
    text = _as_text("notify_email", value).strip().lower()
    if not text:
        return ""
    if len(text) > 254 or _CONTROL_CHARS.search(text) or not _EMAIL.fullmatch(text):
        raise InvalidSetting("notify_email")
    return text


_NORMALIZERS = {
    "bank_name": _bank_name,
    "bank_code": _bank_code,
    "phone": _phone,
    "id_document": _id_document,
    "holder_name": _holder_name,
    "whatsapp": _whatsapp,
    "instructions": _instructions,
    "payment_window_hours": _window_hours,
    "fx_mode": _fx_mode,
    "fx_manual_rate": _fx_manual_rate,
    "notify_email": _notify_email,
}


def settings_of(cfg) -> dict:
    """Stored settings merged over the defaults (``cfg`` may be None)."""
    stored = dict(getattr(cfg, "provider_config", None) or {})
    result = {}
    for key, default in DEFAULT_SETTINGS.items():
        value = stored.get(key)
        result[key] = default if value is None else value
    return result


def apply_settings(current: dict, changes: dict) -> dict:
    """Validate and merge ``changes`` (only the fields sent) into ``current``.

    Omitted fields keep their value; ``""`` or null clears a field (the
    config is then incomplete if it was a required one). Raises
    InvalidSetting on the first invalid field, in form order.

    ``fx_manual_rate`` is only checked when it is sent, after ``fx_mode`` is
    known: with the automatic (BCV) rate it is unused, so an invalid value is
    ignored (the stored one stays) instead of blocking the rest of the form.
    """
    result = dict(current)
    for field in SETTING_FIELDS:
        if field in changes and field != "fx_manual_rate":
            result[field] = _NORMALIZERS[field](changes[field])
    if "fx_manual_rate" in changes:
        try:
            result["fx_manual_rate"] = _fx_manual_rate(changes["fx_manual_rate"])
        except InvalidSetting:
            if result.get("fx_mode") == "manual":
                raise
    return result


def missing_fields(settings: dict) -> list[str]:
    missing = [field for field in REQUIRED_FIELDS if not settings.get(field)]
    if settings.get("fx_mode") == "manual" and not settings.get("fx_manual_rate"):
        missing.append("fx_manual_rate")
    return missing


def serialize_settings(settings: dict) -> dict:
    """Settings as returned to the dashboard (the manual rate as a number)."""
    body = {field: settings.get(field, DEFAULT_SETTINGS[field]) for field in SETTING_FIELDS}
    rate = body.get("fx_manual_rate")
    try:
        body["fx_manual_rate"] = float(Decimal(str(rate))) if rate not in (None, "") else None
    except (InvalidOperation, ValueError):
        body["fx_manual_rate"] = None
    return body


def payment_details_of(settings: dict) -> dict:
    """What a buyer needs to pay (and the receipt WhatsApp)."""
    return {
        key: settings.get(key) or ""
        for key in ("bank_name", "bank_code", "phone", "id_document", "holder_name", "whatsapp", "instructions")
    }


# ---------------------------------------------------------------- provider


class ManualProvider:
    id = PROVIDER_ID
    label = "Pago Móvil"
    supports_subscriptions = False
    supported_currencies = {"USD"}
    methods = [METHOD_ID]

    async def validate_config(self, cfg) -> tuple[bool, Optional[str], Optional[str]]:
        if missing_fields(settings_of(cfg)):
            return False, None, "incomplete"
        return True, None, None

    async def create_checkout(self, cfg, order, offer, user, *, return_url: str,
                              cancel_url: str, method: str):
        raise ProviderError("Pago Móvil se paga desde el carrito", code="MANUAL_ONLY")

    @staticmethod
    def _current(order) -> PaymentResult:
        """Never ``paid``: only an admin confirms a manual order. Statuses
        with nothing to report map to ``created``, a no-op for callers."""
        status = getattr(order, "status", None)
        if status in ("pending", "expired", "failed"):
            return PaymentResult(status=status, reason=getattr(order, "failure_reason", None))
        return PaymentResult(status="created", reason="MANUAL")

    async def confirm(self, cfg, order, params: dict) -> PaymentResult:
        return self._current(order)

    async def fetch_status(self, cfg, order) -> PaymentResult:
        return self._current(order)

    async def handle_webhook(self, cfg, request):
        raise WebhookVerificationError("Pago Móvil does not receive webhooks")

    async def get_capture_status(self, cfg, capture_id: str) -> Optional[str]:
        return None

    def public_settings(self, cfg) -> dict:
        return {**serialize_settings(settings_of(cfg)), "environment": "live"}

"""Sanar y Criar: cart and Pago Móvil purchases confirmed by an admin.

A buyer quotes her cart (``cart_quote``), then creates a purchase
(``cart_checkout``): one ``sc_pay_purchase`` with a public code
(``SYC-7K4P9Q``), the total in US$ and in Bs. at the day's BCV rate, and one
child order (``sc_pay_order``, provider ``manual``) plus enrollment per offer.
She pays by Pago Móvil and sends the receipt by WhatsApp; an org admin then
confirms (``confirm_purchase``), rejects or voids it from Pedidos. Unpaid
purchases expire (``expire_due_purchases``, every reconciliation tick and
before the purchase reads).

Money safety: a child order only becomes ``paid`` through
``confirm_purchase`` (the manual provider never reports paid, has no
webhooks and no checkout of its own). Every action locks the purchase (an
app-level lock across its several commits, then ``SELECT ... FOR UPDATE``)
and re-reads its status, so repeating or racing an action is harmless.

Errors are ``{"code", "message", ...}`` with Spanish messages ready to show.
"""

import logging
import re
import secrets
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal
from typing import Any, Iterable, Optional
from urllib.parse import quote
from uuid import uuid4

from fastapi import HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from src.db.courses.courses import Course
from src.db.organization_config import OrganizationConfig
from src.db.organizations import Organization
from src.db.payments.payments import PaymentsConfig, PaymentsEnrollment, PaymentsOffer, PaymentsOrder
from src.db.payments.purchases import PaymentsPurchase, PaymentsPurchaseItem
from src.db.users import AnonymousUser, APITokenUser, SuperadminAPITokenUser, User
from src.services.payments import purchase_emails
from src.services.payments.access import ACCESS_STATUSES, get_course_access
from src.services.payments.checkout import (
    _capture_lock,
    _is_org_admin,
    _open_payment_clause,
    capture_lock_id,
)
from src.services.payments.common import (
    as_utc,
    course_url,
    courses_by_uuid,
    first_activity_uuids,
    get_org_or_404,
    iso,
    money,
    offer_resource_map,
    platform_base_url,
    product_type_of,
    resource_summary,
    utcnow,
)
from src.services.payments.configs import get_active_config, is_test_mode
from src.services.payments.fulfillment import (
    PAID_STATUSES,
    _locked_enrollment,
    fulfill_order,
    revoke_order,
)
from src.services.payments.fx import FxQuote, FxUnavailable, current_rate, recent_bcv_rate, to_ves
from src.services.payments.providers.base import PaymentResult
from src.services.payments.providers.manual import (
    METHOD_ID,
    PROVIDER_ID,
    REQUIRED_FIELDS,
    InvalidSetting,
    apply_settings,
    missing_fields,
    payment_details_of,
    serialize_settings,
    settings_of,
)

logger = logging.getLogger(__name__)

CART_MAX_ITEMS = 20
MAX_PENDING_PURCHASES = 3
STATUSES = ("pending", "paid", "rejected", "cancelled", "expired", "voided")
LIST_STATUSES = STATUSES + ("all",)
CODE_PREFIX = "SYC-"
CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"  # no 0/O/1/I/L
CODE_LENGTH = 6
CODE_ATTEMPTS = 5
CREATE_ATTEMPTS = 3
MINE_LIMIT = 50
QUERY_MAX_LENGTH = 100
NOTE_MAX_LENGTH = 500
REASON_MIN_LENGTH = 3
REASON_MAX_LENGTH = 300
WHATSAPP_ORG_NAME = "Sanar y Criar"
# A manual rate this far from a BCV rate stored in the last week is a typo.
MANUAL_RATE_BCV_MAX_AGE = timedelta(days=7)
MANUAL_RATE_MAX_DEVIATION = Decimal("0.5")

_REFERENCE = re.compile(r"^[A-Z0-9]{4,30}$")
_REFERENCE_NOISE = re.compile(r"[\s.\-]")
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

ERRORS: dict[str, tuple[int, str]] = {
    "EMPTY_CART": (400, "Tu carrito está vacío."),
    "CART_TOO_LARGE": (400, "Puedes pagar hasta 20 productos por pedido."),
    "METHOD_UNAVAILABLE": (400, "Pago Móvil no está disponible en este momento."),
    "OFFER_UNAVAILABLE": (400, "Algunos productos ya no están disponibles."),
    "ALREADY_OWNED": (409, "Ya tienes acceso a algunos productos del carrito."),
    "PAYMENT_PENDING": (409, "Ya tienes un pedido pendiente con estos productos."),
    "TOO_MANY_PENDING": (409, "Tienes varios pedidos sin pagar. Págalos o cancélalos antes de hacer otro."),
    "FX_UNAVAILABLE": (503, "No pudimos obtener la tasa del BCV. Intenta de nuevo en unos minutos."),
    "NOT_PENDING": (409, "Este pedido ya no está pendiente."),
    "INVALID_REFERENCE": (400, "La referencia debe tener entre 4 y 30 letras o números."),
    "REFERENCE_USED": (409, "Esa referencia ya se usó en otro pedido pagado."),
    "VOIDED": (409, "Este pedido fue anulado. Pide a la persona que haga un pedido nuevo."),
    "ALREADY_PAID": (409, "Este pedido ya está pagado. Si fue un error, anúlalo."),
    "NOT_PAID": (409, "Solo se pueden anular pedidos pagados."),
    "INVALID_REASON": (400, "Escribe un motivo de 3 a 300 caracteres."),
    "INCOMPLETE": (400, "Completa banco, código, teléfono, cédula o RIF y WhatsApp antes de activar Pago Móvil."),
    # The message names both offers: «A» y «B» incluyen el mismo curso...
    "OVERLAPPING_OFFERS": (400, "Dos productos del carrito incluyen el mismo curso. Quita uno de los dos del carrito."),
    "CONFLICT": (409, "Otro cambio se guardó al mismo tiempo. Vuelve a intentarlo."),
    # Not in the shared table: unexpected states, shown as they come.
    "NOT_FOUND": (404, "No encontramos este pedido."),
    "FULFILLMENT_INCOMPLETE": (
        500, "El pago quedó registrado, pero no pudimos dar acceso a todo. Vuelve a marcarlo como pagado.",
    ),
    "BUSY": (503, "No pudimos crear el pedido. Intenta de nuevo en unos segundos."),
}


def purchase_error(code: str, message: Optional[str] = None, **extra) -> HTTPException:
    status, default_message = ERRORS[code]
    return HTTPException(status_code=status, detail={"code": code, "message": message or default_message, **extra})


def invalid_field(field: str, message: str) -> HTTPException:
    return HTTPException(status_code=400, detail={"code": "INVALID_FIELD", "message": message, "field": field})


# ------------------------------------------------------------------ bodies


class CartBody(BaseModel):
    offer_uuids: Optional[list[str]] = None


class CartCheckoutBody(BaseModel):
    offer_uuids: Optional[list[str]] = None
    provider: Optional[str] = None
    method: Optional[str] = None


class ManualSettingsBody(BaseModel):
    """Every field optional: omitted = unchanged, ``""`` clears it. Typed
    loosely so a wrong value answers ``INVALID_FIELD`` (with ``field``)
    instead of a generic 422."""

    enabled: Any = None
    bank_name: Any = None
    bank_code: Any = None
    phone: Any = None
    id_document: Any = None
    holder_name: Any = None
    whatsapp: Any = None
    instructions: Any = None
    payment_window_hours: Any = None
    fx_mode: Any = None
    fx_manual_rate: Any = None
    notify_email: Any = None


class ConfirmBody(BaseModel):
    bank_reference: Any = None
    note: Any = None
    allow_reused_reference: Optional[bool] = False


class RejectBody(BaseModel):
    reason: Any = None
    notify: Optional[bool] = True


class VoidBody(BaseModel):
    reason: Any = None


# ----------------------------------------------------------------- helpers


def normalize_reference(value: Any) -> Optional[str]:
    """Bank reference without spaces, dashes or dots, upper case; None when
    it is not 4-30 letters or digits."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        value = str(value)
    if not isinstance(value, str):
        return None
    text = _REFERENCE_NOISE.sub("", value).upper()
    return text if _REFERENCE.fullmatch(text) else None


def _clean_reason(value: Any) -> str:
    text = " ".join(_CONTROL_CHARS.sub(" ", value).split()) if isinstance(value, str) else ""
    if not (REASON_MIN_LENGTH <= len(text) <= REASON_MAX_LENGTH):
        raise purchase_error("INVALID_REASON")
    return text


def _clean_note(value: Any) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        raise invalid_field("note", "La nota admite hasta 500 caracteres.")
    text = _CONTROL_CHARS.sub("", value.replace("\r\n", "\n")).strip()
    if len(text) > NOTE_MAX_LENGTH:
        raise invalid_field("note", "La nota admite hasta 500 caracteres.")
    return text or None


def clean_query(value: Optional[str]) -> str:
    return (value or "").replace("\x00", "").strip()[:QUERY_MAX_LENGTH]


def dedupe(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result = []
    for value in values or []:
        if isinstance(value, str) and value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def new_code() -> str:
    return CODE_PREFIX + "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def is_signed_in(user) -> bool:
    """A real session (never an API token)."""
    return (
        user is not None
        and not isinstance(user, (AnonymousUser, APITokenUser, SuperadminAPITokenUser))
        and bool(getattr(user, "id", None))
    )


def _require_user(user):
    if not is_signed_in(user):
        raise HTTPException(status_code=401, detail="Authentication required")
    return user


def display_name(user) -> str:
    if user is None:
        return ""
    full = " ".join(p for p in [(user.first_name or "").strip(), (user.last_name or "").strip()] if p)
    return full or (user.username or "")


def whatsapp_message(code: str, amount_ves, amount, names: list[str], buyer: str) -> str:
    return (
        f"Hola, hice un Pago Móvil para mi pedido {code} en {WHATSAPP_ORG_NAME}.\n"
        f"Monto: Bs. {purchase_emails.format_bs(amount_ves)} (US$ {purchase_emails.format_bs(amount)})\n"
        f"Productos: {', '.join(names)}\n"
        f"Nombre: {buyer}\n"
        "Te envío el comprobante."
    )


def whatsapp_url(number: str, message: str) -> str:
    return f"https://wa.me/{number}?text={quote(message)}"


async def manual_config(db_session: AsyncSession, org_id: int) -> Optional[PaymentsConfig]:
    return (await db_session.execute(
        select(PaymentsConfig).where(PaymentsConfig.org_id == org_id, PaymentsConfig.provider == PROVIDER_ID)
    )).scalars().first()


def manual_ready(cfg: Optional[PaymentsConfig]) -> bool:
    return cfg is not None and bool(cfg.active) and bool(cfg.enabled)


def buyer_payment_details(current: dict, snapshot: Optional[dict]) -> dict:
    """The admin's current Pago Móvil details (she may have changed account);
    the ones shown at checkout when the current ones are incomplete."""
    if all(current.get(field) for field in REQUIRED_FIELDS):
        return payment_details_of(current)
    return dict(snapshot or {})


async def _locked_purchase(db_session: AsyncSession, purchase_id: int) -> Optional[PaymentsPurchase]:
    return (await db_session.execute(
        select(PaymentsPurchase)
        .where(PaymentsPurchase.id == purchase_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )).scalars().first()


async def _purchase_or_404(db_session: AsyncSession, org_id: int, purchase_uuid: str) -> PaymentsPurchase:
    purchase_uuid = (purchase_uuid or "").strip()
    purchase = None
    if purchase_uuid and len(purchase_uuid) <= 64:
        purchase = (await db_session.execute(
            select(PaymentsPurchase).where(
                PaymentsPurchase.purchase_uuid == purchase_uuid, PaymentsPurchase.org_id == org_id
            ).execution_options(populate_existing=True)
        )).scalars().first()
    if purchase is None:
        raise purchase_error("NOT_FOUND")
    return purchase


async def _child_orders(db_session: AsyncSession, purchase_id: int, *, lock: bool = False) -> list[PaymentsOrder]:
    stmt = (
        select(PaymentsOrder)
        .join(PaymentsPurchaseItem, PaymentsPurchaseItem.order_id == PaymentsOrder.id)  # type: ignore[arg-type]
        .where(PaymentsPurchaseItem.purchase_id == purchase_id)
        .order_by(PaymentsPurchaseItem.id)
        .execution_options(populate_existing=True)
    )
    if lock:
        stmt = stmt.with_for_update(of=PaymentsOrder)
    return list((await db_session.execute(stmt)).scalars().all())


async def _close_children(db_session: AsyncSession, purchase_id: int, *, from_statuses: Optional[tuple],
                          to_status: str, reason: str, enrollment_status: str) -> None:
    """Move the purchase's open child orders to ``to_status`` (no commit).

    An enrollment changes only while it is ``pending``: one that grants access
    (bought through another order) is never touched.
    """
    now = utcnow()
    for order in await _child_orders(db_session, purchase_id, lock=True):
        if from_statuses is not None and order.status not in from_statuses:
            continue
        if order.status in PAID_STATUSES or order.status == "refunded":
            continue
        order.status = to_status
        order.failure_reason = reason
        order.update_date = now
        db_session.add(order)
        enrollment = await _locked_enrollment(db_session, order.enrollment_id)
        if enrollment is not None and enrollment.status == "pending":
            enrollment.status = enrollment_status
            enrollment.update_date = now
            db_session.add(enrollment)


# ------------------------------------------------------------------ offers


def _listed(offer: Optional[PaymentsOffer]) -> bool:
    return offer is not None and not offer.archived and bool(offer.is_publicly_listed)


def _available(offer: Optional[PaymentsOffer], courses: list[Course]) -> bool:
    return (
        _listed(offer)
        and offer.offer_type == "one_time"
        and (offer.currency or "").upper() == "USD"
        and bool(courses)
    )


async def _offers_by_uuid(db_session: AsyncSession, org_id: int, uuids: list[str]) -> dict[str, PaymentsOffer]:
    if not uuids:
        return {}
    offers = (await db_session.execute(
        select(PaymentsOffer).where(
            PaymentsOffer.org_id == org_id,
            PaymentsOffer.offer_uuid.in_(uuids),  # type: ignore[attr-defined]
        )
    )).scalars().all()
    return {o.offer_uuid: o for o in offers}


async def _courses_by_offer(db_session: AsyncSession, org_id: int,
                            offers: Iterable[PaymentsOffer]) -> dict[int, list[Course]]:
    """offer id -> its published courses in resource order (``offer_courses``
    for many offers at once)."""
    offers = [o for o in offers if o is not None]
    resource_map = await offer_resource_map(db_session, offers)
    uuids = {u for values in resource_map.values() for u in values}
    courses = await courses_by_uuid(db_session, uuids, org_id, published_only=True)
    return {o.id: [courses[u] for u in resource_map.get(o.id, []) if u in courses] for o in offers}


async def _owned_offer_ids(db_session: AsyncSession, user, offers: list[PaymentsOffer],
                           courses: dict[int, list[Course]], *, enrollments_only: bool) -> set[int]:
    """``checkout._user_owns_offer`` for many offers at once: one query for
    the enrollments, then each distinct course's access at most once."""
    if not offers:
        return set()
    owned = set((await db_session.execute(
        select(PaymentsEnrollment.offer_id).where(
            PaymentsEnrollment.user_id == user.id,
            PaymentsEnrollment.offer_id.in_([o.id for o in offers]),  # type: ignore[attr-defined]
            PaymentsEnrollment.status.in_(ACCESS_STATUSES),  # type: ignore[attr-defined]
        )
    )).scalars().all())
    if enrollments_only:
        return owned
    access: dict[int, bool] = {}
    for offer in offers:
        offer_courses_ = courses.get(offer.id, [])
        if offer.id in owned or not offer_courses_:
            continue
        for course in offer_courses_:
            if course.id not in access:
                access[course.id] = (await get_course_access(db_session, user, course)).has_access
            if not access[course.id]:
                break
        else:
            owned.add(offer.id)
    return owned


async def _open_orders(db_session: AsyncSession, user_id: int, offer_ids: list[int]) -> dict[int, PaymentsOrder]:
    """offer id -> its latest open order (``open_payment_for`` in one query)."""
    if not offer_ids:
        return {}
    orders = (await db_session.execute(
        select(PaymentsOrder).where(
            PaymentsOrder.user_id == user_id,
            PaymentsOrder.offer_id.in_(offer_ids),  # type: ignore[attr-defined]
            _open_payment_clause(),
        ).order_by(PaymentsOrder.id.desc())  # type: ignore[union-attr]
    )).scalars().all()
    latest: dict[int, PaymentsOrder] = {}
    for order in orders:
        latest.setdefault(order.offer_id, order)
    return latest


async def _purchase_refs(db_session: AsyncSession, orders: Iterable[PaymentsOrder]) -> dict[int, dict]:
    """order id -> ``{purchase_uuid, code}`` of its Pago Móvil purchase."""
    ids = [o.id for o in orders if o.provider == PROVIDER_ID]
    if not ids:
        return {}
    rows = (await db_session.execute(
        select(PaymentsPurchaseItem.order_id, PaymentsPurchase.purchase_uuid, PaymentsPurchase.code)
        .join(PaymentsPurchase, PaymentsPurchase.id == PaymentsPurchaseItem.purchase_id)  # type: ignore[arg-type]
        .where(PaymentsPurchaseItem.order_id.in_(ids))  # type: ignore[attr-defined]
    )).all()
    return {order_id: {"purchase_uuid": uuid, "code": code} for order_id, uuid, code in rows}


async def _payment_pending_error(db_session: AsyncSession, user_id: int,
                                 lines: list["_Line"]) -> Optional[HTTPException]:
    """``PAYMENT_PENDING`` when some product already has an open payment: it
    names that purchase (or the PayPal order)."""
    open_by_offer = await _open_orders(db_session, user_id, [line.offer_id for line in lines])
    pending = [line for line in lines if line.offer_id in open_by_offer]
    if not pending:
        return None
    first = open_by_offer[pending[0].offer_id]
    extra: dict = {"offer_uuids": [line.offer_uuid for line in pending]}
    ref = (await _purchase_refs(db_session, [first])).get(first.id)
    if ref is not None:
        extra.update(purchase_uuid=ref["purchase_uuid"], purchase_code=ref["code"])
    else:
        extra["order_uuid"] = first.order_uuid
    return purchase_error("PAYMENT_PENDING", **extra)


def _overlap_error(uuids: list[str], offers: dict[str, PaymentsOffer],
                   courses: dict[int, list[Course]]) -> Optional[HTTPException]:
    """``OVERLAPPING_OFFERS`` when two offers of the cart include one course
    (the second one would be a charge for something already bought)."""
    first_offer_of: dict[int, str] = {}
    for uuid in uuids:
        for course in courses.get(offers[uuid].id, []):
            other = first_offer_of.setdefault(course.id, uuid)
            if other != uuid:
                message = (f"«{offers[other].name}» y «{offers[uuid].name}» incluyen el mismo curso. "
                           "Quita uno de los dos del carrito.")
                return purchase_error("OVERLAPPING_OFFERS", message=message, offer_uuids=[other, uuid])
    return None


# --------------------------------------------------------------- settings


async def _fx_status(db_session: AsyncSession, cfg: Optional[PaymentsConfig]) -> dict:
    manual = settings_of(cfg).get("fx_mode") == "manual"
    try:
        fx = await current_rate(db_session, cfg)
    except Exception as exc:
        if not isinstance(exc, FxUnavailable):
            logger.warning("FX lookup failed", exc_info=True)
        return {
            "rate": None, "rate_date": None, "source": "manual" if manual else "bcv",
            "fetched_at": None, "stale": False,
            "error": "Falta la tasa manual." if manual else "No pudimos obtener la tasa del BCV.",
            "warning": None,
        }
    return {
        "rate": float(fx.rate),
        "rate_date": fx.rate_date.isoformat() if fx.rate_date else None,
        "source": fx.source,
        "fetched_at": iso(fx.fetched_at),
        "stale": fx.stale,
        "error": None,
        # e.g. a BCV jump of more than 20 % waiting for confirmation.
        "warning": fx.warning,
    }


async def _settings_response(db_session: AsyncSession, cfg: Optional[PaymentsConfig]) -> dict:
    settings = settings_of(cfg)
    return {
        "enabled": bool(cfg.enabled) if cfg is not None else False,
        "active": bool(cfg.active) if cfg is not None else False,
        "missing": missing_fields(settings),
        "settings": serialize_settings(settings),
        "fx": await _fx_status(db_session, cfg),
    }


async def _check_manual_rate(db_session: AsyncSession, settings: dict, current: dict) -> None:
    """A manual rate more than 50 % away from a BCV rate stored in the last
    7 days is refused (``INVALID_FIELD``) when it will be used; with the
    automatic rate it is ignored instead (the stored one stays)."""
    bcv = await recent_bcv_rate(db_session, MANUAL_RATE_BCV_MAX_AGE)
    manual = Decimal(str(settings["fx_manual_rate"]))
    if bcv is None or abs(manual - bcv) / bcv <= MANUAL_RATE_MAX_DEVIATION:
        return
    if settings.get("fx_mode") != "manual":
        settings["fx_manual_rate"] = current.get("fx_manual_rate")
        return
    raise invalid_field(
        "fx_manual_rate",
        f"La tasa manual ({purchase_emails.format_rate(manual)} Bs.) se aleja mucho de la del BCV "
        f"({purchase_emails.format_rate(bcv)} Bs.). Revísala.",
    )


async def get_manual_settings(db_session: AsyncSession, org_id: int) -> dict:
    return await _settings_response(db_session, await manual_config(db_session, org_id))


async def update_manual_settings(db_session: AsyncSession, org_id: int, body: ManualSettingsBody) -> dict:
    changes = body.model_dump(exclude_unset=True)
    cfg = await manual_config(db_session, org_id)
    current = settings_of(cfg)
    try:
        settings = apply_settings(current, changes)
    except InvalidSetting as exc:
        raise invalid_field(exc.field, exc.message)
    if "fx_manual_rate" in changes and settings.get("fx_manual_rate"):
        await _check_manual_rate(db_session, settings, current)
    enabled = bool(cfg.enabled) if cfg is not None else False
    if changes.get("enabled") is not None:
        if not isinstance(changes["enabled"], bool):
            raise invalid_field("enabled", "Indica si Pago Móvil está activo.")
        enabled = changes["enabled"]
    missing = missing_fields(settings)
    if enabled and missing:
        raise purchase_error("INCOMPLETE", missing=missing)

    if cfg is None:
        cfg = PaymentsConfig(org_id=org_id, provider=PROVIDER_ID, enabled=enabled, active=False, provider_config={})
    was = (bool(cfg.enabled), bool(cfg.active))
    stored = dict(cfg.provider_config or {})
    stored.update(settings)
    stored["environment"] = "live"
    cfg.provider_config = stored
    cfg.enabled = enabled
    cfg.active = not missing
    cfg.update_date = utcnow()
    db_session.add(cfg)
    try:
        await db_session.commit()
    except IntegrityError:
        await db_session.rollback()
        raise purchase_error("CONFLICT")
    await db_session.refresh(cfg)
    if was != (bool(cfg.enabled), bool(cfg.active)):
        logger.info("Pago Móvil of org %s: enabled=%s active=%s", org_id, cfg.enabled, cfg.active)
    return await _settings_response(db_session, cfg)


# ------------------------------------------------------------------- quote


def _quote_item(uuid: str, offer: Optional[PaymentsOffer], courses: list[Course], org_uuid: str,
                request: Optional[Request]) -> dict:
    if not _listed(offer):
        # Unknown, archived or unlisted: nothing about it is public.
        return {
            "offer_uuid": uuid, "name": None, "description": None, "amount": None, "currency": None,
            "thumbnail_url": None, "resources": [],
        }
    resources = []
    for course in courses:
        summary = resource_summary(course, org_uuid, request)
        resources.append({k: summary[k] for k in ("course_uuid", "name", "product_type", "thumbnail_url")})
    return {
        "offer_uuid": uuid,
        "name": offer.name,
        "description": offer.description,
        "amount": money(offer.amount),
        "currency": offer.currency,
        "thumbnail_url": resources[0]["thumbnail_url"] if resources else None,
        "resources": resources,
    }


async def _pago_movil_quote(db_session: AsyncSession, cfg: Optional[PaymentsConfig], total: Decimal) -> dict:
    if not manual_ready(cfg):
        return {"enabled": False}
    try:
        fx = await current_rate(db_session, cfg)
    except Exception as exc:
        if not isinstance(exc, FxUnavailable):
            logger.warning("FX lookup failed", exc_info=True)
        return {"enabled": True, "rate": None, "rate_date": None, "rate_source": None, "amount_ves": None,
                "error": "FX_UNAVAILABLE"}
    return {
        "enabled": True,
        "rate": float(fx.rate),
        "rate_date": fx.rate_date.isoformat() if fx.rate_date else None,
        "rate_source": fx.source,
        "amount_ves": money(to_ves(total, fx.rate)),
        "error": None,
    }


async def cart_quote(db_session: AsyncSession, request: Optional[Request], org_id: int,
                     offer_uuids: list[str], user) -> dict:
    org = await get_org_or_404(db_session, org_id)
    uuids = dedupe(offer_uuids)
    if len(uuids) > CART_MAX_ITEMS:
        raise purchase_error("CART_TOO_LARGE")
    signed_in = is_signed_in(user)
    if signed_in and uuids:
        # A purchase past its deadline must not show its items as "pending".
        await expire_due_purchases(db_session, org_id)
    is_admin = signed_in and await _is_org_admin(db_session, user, org_id)
    offers = await _offers_by_uuid(db_session, org_id, uuids)
    courses = await _courses_by_offer(db_session, org_id, offers.values())
    available = {
        u: offers[u] for u in uuids if u in offers and _available(offers[u], courses.get(offers[u].id, []))
    }
    owned_ids: set[int] = set()
    open_by_offer: dict[int, PaymentsOrder] = {}
    refs: dict[int, dict] = {}
    if signed_in and available:
        # Admins see every course anyway: only a purchase counts, so the flow
        # can be tried out (as in start_checkout).
        owned_ids = await _owned_offer_ids(db_session, user, list(available.values()), courses,
                                           enrollments_only=is_admin)
        open_by_offer = await _open_orders(
            db_session, user.id, [o.id for o in available.values() if o.id not in owned_ids]
        )
        refs = await _purchase_refs(db_session, open_by_offer.values())

    items, total, count = [], Decimal("0"), 0
    for uuid in uuids:
        offer = offers.get(uuid)
        item = _quote_item(uuid, offer, courses.get(offer.id, []) if offer is not None else [],
                           org.org_uuid, request)
        status = "unavailable"
        if uuid in available:
            if offer.id in owned_ids:
                status = "owned"
            elif offer.id in open_by_offer:
                status = "pending"
                # The purchase it belongs to; None for a PayPal order.
                item["pending_purchase"] = refs.get(open_by_offer[offer.id].id)
            else:
                status = "available"
                total += Decimal(str(offer.amount))
                count += 1
        item["status"] = status
        items.append(item)

    paypal_cfg = await get_active_config(db_session, org_id, "paypal")
    return {
        "items": items,
        "count": count,
        "total": money(total),
        "currency": "USD",
        "pago_movil": await _pago_movil_quote(db_session, await manual_config(db_session, org_id), total),
        "paypal": {"enabled": paypal_cfg is not None and (not is_test_mode(paypal_cfg) or is_admin)},
    }


# ---------------------------------------------------------------- checkout


@dataclass(frozen=True)
class _Line:
    offer_id: int
    offer_uuid: str
    name: str
    amount: Decimal


async def cart_checkout(db_session: AsyncSession, request: Optional[Request], org_id: int,
                        body: CartCheckoutBody, user) -> dict:
    _require_user(user)
    await get_org_or_404(db_session, org_id)
    if (body.provider or "").strip().lower() != PROVIDER_ID or (body.method or "").strip().lower() != METHOD_ID:
        raise purchase_error("METHOD_UNAVAILABLE")
    cfg = await manual_config(db_session, org_id)
    if not manual_ready(cfg):
        raise purchase_error("METHOD_UNAVAILABLE")
    uuids = dedupe(body.offer_uuids)
    if not uuids:
        raise purchase_error("EMPTY_CART")
    if len(uuids) > CART_MAX_ITEMS:
        raise purchase_error("CART_TOO_LARGE")
    offers = await _offers_by_uuid(db_session, org_id, uuids)
    courses = await _courses_by_offer(db_session, org_id, offers.values())
    unavailable = [
        u for u in uuids
        if not _available(offers.get(u), courses.get(offers[u].id, []) if u in offers else [])
    ]
    if unavailable:
        raise purchase_error("OFFER_UNAVAILABLE", offer_uuids=unavailable)
    overlap = _overlap_error(uuids, offers, courses)
    if overlap is not None:
        raise overlap

    # Plain values from here on: nothing below re-reads an ORM row that a
    # rollback (retrying a code collision) could have expired.
    lines = [_Line(offers[u].id, u, offers[u].name, Decimal(str(offers[u].amount))) for u in uuids]
    settings = settings_of(cfg)
    is_admin = await _is_org_admin(db_session, user, org_id)

    async with _capture_lock(f"cart:{user.id}"):
        await expire_due_purchases(db_session, org_id)
        owned_ids = await _owned_offer_ids(db_session, user, [offers[u] for u in uuids], courses,
                                           enrollments_only=is_admin)
        owned = [line.offer_uuid for line in lines if line.offer_id in owned_ids]
        if owned:
            raise purchase_error("ALREADY_OWNED", offer_uuids=owned)
        pending_error = await _payment_pending_error(db_session, user.id, lines)
        if pending_error is not None:
            raise pending_error

        pending_count = (await db_session.execute(
            select(func.count()).select_from(PaymentsPurchase).where(
                PaymentsPurchase.org_id == org_id,
                PaymentsPurchase.user_id == user.id,
                PaymentsPurchase.status == "pending",
                PaymentsPurchase.expires_at > utcnow(),
            )
        )).scalar()
        if int(pending_count or 0) >= MAX_PENDING_PURCHASES:
            raise purchase_error("TOO_MANY_PENDING")

        try:
            fx = await current_rate(db_session, cfg)
        except FxUnavailable:
            raise purchase_error("FX_UNAVAILABLE")

        purchase_id = await _create_purchase(db_session, org_id, user.id, lines, settings, fx)

    purchase = await db_session.get(PaymentsPurchase, purchase_id)
    logger.info("Purchase %s created by user %s (%s items, US$ %s)", purchase.code, user.id,
                len(lines), purchase.amount)
    # The purchase exists from here on: nothing below may turn this into an
    # error (the emails roll back their own failures).
    await _send_created_emails(db_session, request, purchase)
    return await _payload(db_session, request, purchase_id, admin=False)


async def _create_purchase(db_session: AsyncSession, org_id: int, user_id: int, lines: list[_Line],
                           settings: dict, fx: FxQuote) -> int:
    """Purchase, enrollments, child orders and items in one transaction."""
    for attempt in range(CREATE_ATTEMPTS):
        try:
            return await _insert_purchase(db_session, org_id, user_id, lines, settings, fx)
        except IntegrityError:
            await db_session.rollback()
            # uq_sc_pay_order_manual_pending: a concurrent purchase (another
            # worker) took one of these products first.
            pending_error = await _payment_pending_error(db_session, user_id, lines)
            if pending_error is not None:
                raise pending_error
            # Otherwise a code taken between the check and the insert: retry.
            logger.warning("Purchase insert collided (attempt %s)", attempt + 1)
    raise purchase_error("BUSY")


async def _new_unique_code(db_session: AsyncSession) -> str:
    for _ in range(CODE_ATTEMPTS):
        code = new_code()
        taken = (await db_session.execute(
            select(PaymentsPurchase.id).where(PaymentsPurchase.code == code)
        )).first()
        if taken is None:
            return code
    raise purchase_error("BUSY")


async def _insert_purchase(db_session: AsyncSession, org_id: int, user_id: int, lines: list[_Line],
                           settings: dict, fx: FxQuote) -> int:
    now = utcnow()
    code = await _new_unique_code(db_session)
    purchase_uuid = uuid4().hex
    amount = sum((line.amount for line in lines), Decimal("0")).quantize(Decimal("0.01"))
    hours = int(settings.get("payment_window_hours") or 24)
    raw: dict = {"emails": {}}
    if fx.stale:
        raw["fx_stale"] = True
    purchase = PaymentsPurchase(
        purchase_uuid=purchase_uuid,
        code=code,
        org_id=org_id,
        user_id=user_id,
        provider=PROVIDER_ID,
        method=METHOD_ID,
        status="pending",
        currency="USD",
        amount=amount,  # from the database, never from the client
        fx_rate=fx.rate,
        fx_source=fx.source,
        fx_date=fx.rate_date,
        amount_ves=to_ves(amount, fx.rate),
        expires_at=now + timedelta(hours=hours),
        payment_details=payment_details_of(settings),
        raw=raw,
    )
    db_session.add(purchase)
    await db_session.flush()

    for line in lines:
        # One enrollment row per (user, offer): reuse the latest one that does
        # not grant access, like start_checkout.
        enrollment = (await db_session.execute(
            select(PaymentsEnrollment).where(
                PaymentsEnrollment.user_id == user_id, PaymentsEnrollment.offer_id == line.offer_id
            ).order_by(PaymentsEnrollment.id.desc())  # type: ignore[union-attr]
        )).scalars().first()
        if enrollment is None:
            enrollment = PaymentsEnrollment(
                enrollment_uuid=str(uuid4()), offer_id=line.offer_id, user_id=user_id, org_id=org_id,
                status="pending", provider_specific_data={},
            )
        elif enrollment.status not in ACCESS_STATUSES:
            enrollment.status = "pending"
            enrollment.update_date = now
        db_session.add(enrollment)
        await db_session.flush()

        order = PaymentsOrder(
            order_uuid=str(uuid4()),
            org_id=org_id,
            offer_id=line.offer_id,
            user_id=user_id,
            enrollment_id=enrollment.id,
            provider=PROVIDER_ID,
            method=METHOD_ID,
            status="pending",
            amount=line.amount,
            currency="USD",
            fx_rate=fx.rate,
            redirect_uri="",
            raw={"environment": "live", "purchase_code": code, "purchase_uuid": purchase_uuid},
        )
        db_session.add(order)
        await db_session.flush()
        db_session.add(PaymentsPurchaseItem(
            purchase_id=purchase.id, order_id=order.id, offer_id=line.offer_id, org_id=org_id,
            name=(line.name or "")[:255], amount=line.amount,
        ))
    await db_session.commit()
    return purchase.id


# ----------------------------------------------------------- serialization


async def serialize_purchases(db_session: AsyncSession, request: Optional[Request],
                              purchases: list[PaymentsPurchase], *, admin: bool) -> list[dict]:
    """``Purchase`` (owner) or ``PurchaseAdmin`` dicts, loading everything in
    a few queries (all purchases belong to one org)."""
    if not purchases:
        return []
    org_id = purchases[0].org_id
    org = await db_session.get(Organization, org_id)
    org_uuid = org.org_uuid if org is not None else ""
    ids = [p.id for p in purchases]

    rows = (await db_session.execute(
        select(PaymentsPurchaseItem, PaymentsOrder, PaymentsOffer)
        .join(PaymentsOrder, PaymentsOrder.id == PaymentsPurchaseItem.order_id)  # type: ignore[arg-type]
        .join(PaymentsOffer, PaymentsOffer.id == PaymentsPurchaseItem.offer_id)  # type: ignore[arg-type]
        .where(PaymentsPurchaseItem.purchase_id.in_(ids))  # type: ignore[attr-defined]
        .order_by(PaymentsPurchaseItem.id)
        .execution_options(populate_existing=True)
    )).all()
    offers = {offer.id: offer for _, _, offer in rows}
    orders_of: dict[int, list[PaymentsOrder]] = {}
    for item, order, _ in rows:
        orders_of.setdefault(item.purchase_id, []).append(order)
    courses = await _courses_by_offer(db_session, org_id, offers.values())
    first = await first_activity_uuids(db_session, [c.id for cs in courses.values() for c in cs])
    resources_of: dict[int, list[dict]] = {}
    for offer_id, offer_courses_ in courses.items():
        resources = []
        for course in offer_courses_:
            summary = resource_summary(course, org_uuid, request)
            summary["first_activity_uuid"] = first.get(course.id)
            resources.append(summary)
        resources_of[offer_id] = resources
    # Admin view: a child paid twice (another paid order already granted the
    # same product) carries ``duplicate_of``: refund one of the two.
    duplicates: dict[int, dict] = {}
    if admin:
        granting_uuids = {
            order.id: (order.raw or {}).get("duplicate_of")
            for _, order, _ in rows
            if order.status in PAID_STATUSES and (order.raw or {}).get("duplicate_of")
        }
        if granting_uuids:
            codes = dict((await db_session.execute(
                select(PaymentsOrder.order_uuid, PaymentsPurchase.code)
                .join(PaymentsPurchaseItem, PaymentsPurchaseItem.order_id == PaymentsOrder.id)  # type: ignore[arg-type]
                .join(PaymentsPurchase, PaymentsPurchase.id == PaymentsPurchaseItem.purchase_id)  # type: ignore[arg-type]
                .where(PaymentsOrder.order_uuid.in_(list(set(granting_uuids.values()))))  # type: ignore[attr-defined]
            )).all())
            duplicates = {
                order_id: {"order_uuid": uuid, "purchase_code": codes.get(uuid)}
                for order_id, uuid in granting_uuids.items()
            }
    items_of: dict[int, list[dict]] = {}
    for item, order, offer in rows:
        entry = {
            "offer_uuid": offer.offer_uuid,
            "order_uuid": order.order_uuid,
            "name": item.name,
            "amount": money(item.amount),
            "resources": [dict(r) for r in resources_of.get(offer.id, [])],
        }
        if admin:
            entry["duplicate_of"] = duplicates.get(order.id)
        items_of.setdefault(item.purchase_id, []).append(entry)

    user_ids = {p.user_id for p in purchases} | {p.confirmed_by_user_id for p in purchases if p.confirmed_by_user_id}
    users = {u.id: u for u in (await db_session.execute(
        select(User).where(User.id.in_(list(user_ids)))  # type: ignore[attr-defined]
    )).scalars().all()}

    current = settings_of(await manual_config(db_session, org_id))

    reused: dict[str, list[tuple[int, str]]] = {}
    if admin:
        references = {p.bank_reference for p in purchases if p.bank_reference}
        if references:
            for pid, code, reference in (await db_session.execute(
                select(PaymentsPurchase.id, PaymentsPurchase.code, PaymentsPurchase.bank_reference)
                .where(
                    PaymentsPurchase.org_id == org_id,
                    PaymentsPurchase.status == "paid",
                    PaymentsPurchase.bank_reference.in_(list(references)),  # type: ignore[union-attr]
                ).order_by(PaymentsPurchase.creation_date, PaymentsPurchase.id)
            )).all():
                reused.setdefault(reference, []).append((pid, code))

    result = []
    for purchase in purchases:
        items = items_of.get(purchase.id, [])
        buyer = users.get(purchase.user_id)
        payment = number = url = None
        if purchase.status in ("pending", "expired"):
            details = buyer_payment_details(current, purchase.payment_details)
            payment = {k: details.get(k) or "" for k in (
                "bank_name", "bank_code", "phone", "id_document", "holder_name", "instructions"
            )}
            number = details.get("whatsapp") or None
            if number:
                url = whatsapp_url(number, whatsapp_message(
                    purchase.code, purchase.amount_ves, purchase.amount,
                    [i["name"] for i in items], display_name(buyer),
                ))
        elif purchase.status in ("rejected", "voided"):
            # Only the number, so the buyer can ask what happened.
            number = buyer_payment_details(current, purchase.payment_details).get("whatsapp") or None
        fx_date = purchase.fx_date
        body = {
            "purchase_uuid": purchase.purchase_uuid,
            "code": purchase.code,
            "status": purchase.status,
            "provider": purchase.provider,
            "method": purchase.method,
            "currency": purchase.currency,
            "amount": money(purchase.amount),
            "amount_ves": money(purchase.amount_ves),
            "fx_rate": float(purchase.fx_rate) if purchase.fx_rate is not None else None,
            "fx_source": purchase.fx_source,
            "fx_date": fx_date.isoformat() if hasattr(fx_date, "isoformat") else fx_date,
            "created_at": iso(purchase.creation_date),
            "expires_at": iso(purchase.expires_at),
            "closed_at": iso(purchase.closed_at),
            "confirmed_at": iso(purchase.confirmed_at),
            "items": items,
            "payment": payment,
            "whatsapp_number": number,
            "whatsapp_url": url,
            "reject_reason": purchase.reject_reason,
            "can_cancel": purchase.status == "pending",
        }
        if admin:
            confirmer = users.get(purchase.confirmed_by_user_id) if purchase.confirmed_by_user_id else None
            body.update({
                "customer": {
                    "user_id": purchase.user_id,
                    "user_uuid": buyer.user_uuid if buyer else None,
                    "username": buyer.username if buyer else None,
                    "first_name": buyer.first_name if buyer else None,
                    "last_name": buyer.last_name if buyer else None,
                    "email": buyer.email if buyer else None,
                },
                "bank_reference": purchase.bank_reference,
                "note": purchase.note,
                # Paid, but some order never got its access (a confirmation
                # that failed half way): confirming again finishes it.
                "needs_fulfillment": purchase.status == "paid" and any(
                    order.status not in PAID_STATUSES for order in orders_of.get(purchase.id, [])
                ),
                "confirmed_by": {
                    "user_id": confirmer.id,
                    "username": confirmer.username,
                    "name": display_name(confirmer),
                } if confirmer is not None else None,
                "reference_reused_in": [
                    code for pid, code in reused.get(purchase.bank_reference or "", []) if pid != purchase.id
                ],
            })
        result.append(body)
    return result


async def _payload(db_session: AsyncSession, request: Optional[Request], purchase_id: int, *, admin: bool) -> dict:
    purchase = (await db_session.execute(
        select(PaymentsPurchase).where(PaymentsPurchase.id == purchase_id).execution_options(populate_existing=True)
    )).scalars().one()
    (payload,) = await serialize_purchases(db_session, request, [purchase], admin=admin)
    return payload


# ------------------------------------------------------------------ reads


async def my_purchases(db_session: AsyncSession, request: Optional[Request], org_id: int, user) -> dict:
    _require_user(user)
    await get_org_or_404(db_session, org_id)
    await expire_due_purchases(db_session, org_id)
    purchases = (await db_session.execute(
        select(PaymentsPurchase)
        .where(PaymentsPurchase.org_id == org_id, PaymentsPurchase.user_id == user.id)
        .order_by(PaymentsPurchase.creation_date.desc(), PaymentsPurchase.id.desc())  # type: ignore[attr-defined]
        .limit(MINE_LIMIT)
    )).scalars().all()
    return {"items": await serialize_purchases(db_session, request, list(purchases), admin=False)}


async def purchases_summary(db_session: AsyncSession, org_id: int) -> dict:
    await expire_due_purchases(db_session, org_id)
    pending = (await db_session.execute(
        select(func.count()).select_from(PaymentsPurchase).where(
            PaymentsPurchase.org_id == org_id,
            PaymentsPurchase.status == "pending",
            PaymentsPurchase.expires_at >= utcnow(),
        )
    )).scalar()
    return {"pending": int(pending or 0)}


def _like(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


async def list_purchases(db_session: AsyncSession, request: Optional[Request], org_id: int, *,
                         status: str = "pending", q: Optional[str] = None, limit: int = 25,
                         offset: int = 0) -> dict:
    status = (status or "pending").strip().lower()
    if status not in LIST_STATUSES:
        raise invalid_field("status", "Estado no válido.")
    limit = max(1, min(int(limit or 25), 100))
    offset = max(0, int(offset or 0))
    await expire_due_purchases(db_session, org_id)

    filters = [PaymentsPurchase.org_id == org_id]
    if status != "all":
        filters.append(PaymentsPurchase.status == status)
    text = clean_query(q)
    if text:
        pattern = _like(text)
        conditions = [
            PaymentsPurchase.code.ilike(pattern, escape="\\"),  # type: ignore[union-attr]
            PaymentsPurchase.bank_reference.ilike(pattern, escape="\\"),  # type: ignore[union-attr]
            User.email.ilike(pattern, escape="\\"),  # type: ignore[union-attr]
            User.username.ilike(pattern, escape="\\"),  # type: ignore[union-attr]
            User.first_name.ilike(pattern, escape="\\"),  # type: ignore[union-attr]
            User.last_name.ilike(pattern, escape="\\"),  # type: ignore[union-attr]
            (User.first_name + " " + User.last_name).ilike(pattern, escape="\\"),  # type: ignore[operator]
        ]
        reference = _REFERENCE_NOISE.sub("", text).upper()
        if reference and reference != text.upper():
            conditions.append(PaymentsPurchase.bank_reference.ilike(_like(reference), escape="\\"))  # type: ignore[union-attr]
        filters.append(or_(*conditions))

    if status == "pending":
        order_by = (PaymentsPurchase.creation_date.asc(), PaymentsPurchase.id.asc())  # type: ignore[attr-defined]
    elif status == "all":
        order_by = (PaymentsPurchase.creation_date.desc(), PaymentsPurchase.id.desc())  # type: ignore[attr-defined]
    else:
        order_by = (PaymentsPurchase.update_date.desc(), PaymentsPurchase.id.desc())  # type: ignore[attr-defined]

    base = select(PaymentsPurchase).join(User, User.id == PaymentsPurchase.user_id).where(*filters)  # type: ignore[arg-type]
    total = (await db_session.execute(
        select(func.count()).select_from(base.subquery())
    )).scalar()
    purchases = (await db_session.execute(
        base.order_by(*order_by).limit(limit).offset(offset)
    )).scalars().all()

    counts = {s: 0 for s in STATUSES}
    for row_status, n in (await db_session.execute(
        select(PaymentsPurchase.status, func.count())
        .where(PaymentsPurchase.org_id == org_id)
        .group_by(PaymentsPurchase.status)
    )).all():
        if row_status in counts:
            counts[row_status] = int(n)
    counts["all"] = sum(counts[s] for s in STATUSES)
    return {
        "items": await serialize_purchases(db_session, request, list(purchases), admin=True),
        "total": int(total or 0),
        "counts": counts,
    }


async def get_purchase(db_session: AsyncSession, request: Optional[Request], org_id: int,
                       purchase_uuid: str, user) -> dict:
    """``PurchaseAdmin`` for an org admin, ``Purchase`` for the buyer, 404
    for anyone else."""
    from src.security.org_auth import enforce_org_mfa

    _require_user(user)
    await expire_due_purchases(db_session, org_id)
    purchase = await _purchase_or_404(db_session, org_id, purchase_uuid)
    is_owner = purchase.user_id == user.id
    if await _is_org_admin(db_session, user, org_id):
        try:
            await enforce_org_mfa(user.id, org_id, db_session)
            return await _payload(db_session, request, purchase.id, admin=True)
        except HTTPException:
            if not is_owner:
                raise
    if is_owner:
        return await _payload(db_session, request, purchase.id, admin=False)
    raise purchase_error("NOT_FOUND")


# ---------------------------------------------------------------- actions


async def expire_due_purchases(db_session: AsyncSession, org_id: Optional[int] = None) -> int:
    """Pending purchases past ``expires_at`` -> ``expired`` (their pending
    child orders -> ``expired``, pending enrollments -> ``cancelled``).
    Returns how many expired. One commit per purchase, each under its row lock."""
    now = utcnow()
    stmt = select(PaymentsPurchase.id).where(
        PaymentsPurchase.status == "pending", PaymentsPurchase.expires_at < now
    ).order_by(PaymentsPurchase.id)
    if org_id is not None:
        stmt = stmt.where(PaymentsPurchase.org_id == org_id)
    ids = list((await db_session.execute(stmt)).scalars().all())
    expired = 0
    for purchase_id in ids:
        purchase = await _locked_purchase(db_session, purchase_id)
        due = purchase is not None and (as_utc(purchase.expires_at) or now) < now
        if purchase is None or purchase.status != "pending" or not due:
            await db_session.commit()
            continue
        purchase.status = "expired"
        purchase.closed_at = now
        purchase.update_date = now
        db_session.add(purchase)
        await _close_children(db_session, purchase_id, from_statuses=("pending",), to_status="expired",
                              reason="EXPIRED", enrollment_status="cancelled")
        await db_session.commit()
        expired += 1
        logger.info("Purchase %s expired", purchase.code)
    return expired


async def cancel_purchase(db_session: AsyncSession, request: Optional[Request], org_id: int,
                          purchase_uuid: str, user) -> dict:
    _require_user(user)
    purchase = await _purchase_or_404(db_session, org_id, purchase_uuid)
    if purchase.user_id != user.id:
        raise purchase_error("NOT_FOUND")
    purchase_id = purchase.id
    async with _capture_lock(f"purchase:{purchase_id}"):
        purchase = await _locked_purchase(db_session, purchase_id)
        if purchase.status != "pending":
            status = purchase.status
            await db_session.commit()
            raise purchase_error("NOT_PENDING", status=status)
        now = utcnow()
        purchase.status = "cancelled"
        purchase.closed_at = now
        purchase.update_date = now
        db_session.add(purchase)
        await _close_children(db_session, purchase_id, from_statuses=("pending",), to_status="cancelled",
                              reason="cancelled_by_user", enrollment_status="cancelled")
        await db_session.commit()
        logger.info("Purchase %s cancelled by its buyer", purchase.code)
    return await _payload(db_session, request, purchase_id, admin=False)


async def _paid_codes_with_reference(db_session: AsyncSession, org_id: int, reference: str,
                                     exclude_id: int) -> list[str]:
    return list((await db_session.execute(
        select(PaymentsPurchase.code).where(
            PaymentsPurchase.org_id == org_id,
            PaymentsPurchase.status == "paid",
            PaymentsPurchase.bank_reference == reference,
            PaymentsPurchase.id != exclude_id,
        ).order_by(PaymentsPurchase.creation_date, PaymentsPurchase.id)
    )).scalars().all())


async def confirm_purchase(db_session: AsyncSession, request: Optional[Request], org_id: int,
                           purchase_uuid: str, body: ConfirmBody, admin) -> dict:
    """Mark paid (the only way a manual order is ever paid) and grant access.

    Allowed from pending, expired, rejected and cancelled (the money may
    arrive late). Confirming a paid purchase again re-runs the fulfillment of
    its orders (healing a crash half way) and sends no new email.
    """
    reference = normalize_reference(body.bank_reference)
    if reference is None:
        raise purchase_error("INVALID_REFERENCE")
    note = _clean_note(body.note)
    purchase = await _purchase_or_404(db_session, org_id, purchase_uuid)
    purchase_id = purchase.id

    async with _capture_lock(f"purchase:{purchase_id}"):
        # Two purchases confirmed with one reference at the same time must
        # not both pass the reuse check.
        async with _capture_lock(f"purchase_ref:{org_id}:{reference}"):
            purchase = await _locked_purchase(db_session, purchase_id)
            status = purchase.status
            if status == "voided":
                await db_session.commit()
                raise purchase_error("VOIDED")
            if status != "paid":
                reused = await _paid_codes_with_reference(db_session, org_id, reference, purchase_id)
                if reused and not body.allow_reused_reference:
                    await db_session.commit()
                    raise purchase_error("REFERENCE_USED", purchases=reused)
                now = utcnow()
                purchase.status = "paid"
                purchase.bank_reference = reference
                purchase.note = note
                purchase.confirmed_by_user_id = admin.id
                purchase.confirmed_at = now
                purchase.closed_at = now
                purchase.update_date = now
                raw = dict(purchase.raw or {})
                if reused:
                    raw["reference_reused"] = reused
                if status != "pending":
                    raw["confirmed_from"] = status
                purchase.raw = raw
                db_session.add(purchase)
                await db_session.commit()
                logger.info("Purchase %s confirmed by admin %s (reference %s, was %s)",
                            purchase.code, admin.id, reference, status)
            else:
                await db_session.commit()
            code = purchase.code
            buyer_id = purchase.user_id
            capture_reference = purchase.bank_reference or reference

        # Its products are paid: another pending purchase of them must not be
        # paid again (also on a repeated confirmation, which heals a crash).
        await _cancel_duplicate_purchases(db_session, org_id, purchase_id, buyer_id, code)
        failures = await _fulfill_children(db_session, request, purchase_id, code, capture_reference, admin.id)
        children = await _child_orders(db_session, purchase_id)
        if failures or any(o.status not in PAID_STATUSES for o in children):
            logger.error("Purchase %s: %s orders could not be fulfilled", code, failures)
            raise purchase_error("FULFILLMENT_INCOMPLETE")
        await _send_paid_email_once(db_session, request, purchase_id)
    return await _payload(db_session, request, purchase_id, admin=True)


async def _cancel_duplicate_purchases(db_session: AsyncSession, org_id: int, purchase_id: int, user_id: int,
                                      code: str) -> list[str]:
    """Cancel the buyer's other *pending* purchases that include one of this
    purchase's offers (no email). Each under its row lock, status re-read; the
    purchase's own lock is not taken, so two confirmations never wait on each
    other (if both get paid, fulfillment flags the second as a duplicate)."""
    offer_ids = select(PaymentsPurchaseItem.offer_id).where(PaymentsPurchaseItem.purchase_id == purchase_id)
    duplicate_ids = list((await db_session.execute(
        select(PaymentsPurchase.id)
        .join(PaymentsPurchaseItem, PaymentsPurchaseItem.purchase_id == PaymentsPurchase.id)  # type: ignore[arg-type]
        .where(
            PaymentsPurchase.org_id == org_id,
            PaymentsPurchase.user_id == user_id,
            PaymentsPurchase.status == "pending",
            PaymentsPurchase.id != purchase_id,
            PaymentsPurchaseItem.offer_id.in_(offer_ids),  # type: ignore[attr-defined]
        ).distinct().order_by(PaymentsPurchase.id)
    )).scalars().all())
    cancelled = []
    for duplicate_id in duplicate_ids:
        duplicate = await _locked_purchase(db_session, duplicate_id)
        if duplicate is None or duplicate.status != "pending":
            await db_session.commit()
            continue
        now = utcnow()
        duplicate.status = "cancelled"
        duplicate.reject_reason = f"Estos productos ya se pagaron en el pedido {code}."
        duplicate.closed_at = now
        duplicate.update_date = now
        duplicate.raw = {**(duplicate.raw or {}), "cancelled_as_duplicate_of": code}
        db_session.add(duplicate)
        await _close_children(db_session, duplicate_id, from_statuses=("pending",), to_status="cancelled",
                              reason="paid_in_other_purchase", enrollment_status="cancelled")
        await db_session.commit()
        cancelled.append(duplicate.code)
        logger.info("Purchase %s cancelled: its products were paid in %s", duplicate.code, code)
    return cancelled


async def _fulfill_children(db_session: AsyncSession, request: Optional[Request], purchase_id: int, code: str,
                            reference: str, admin_id: int) -> int:
    """fulfill_order for every child (idempotent). Returns how many failed."""
    children = [(o.id, capture_lock_id(o), Decimal(str(o.amount)), o.order_uuid)
                for o in await _child_orders(db_session, purchase_id)]
    failures = 0
    for order_id, lock_id, amount, order_uuid in children:
        result = PaymentResult(
            status="paid",
            provider_capture_id=reference,
            charged_amount=amount,
            charged_currency="USD",
            raw={"confirmed_by": admin_id, "purchase_code": code},
        )
        try:
            # Same lock as a PayPal capture of this (buyer, offer): an approved
            # PayPal order confirmed meanwhile sees the purchase owned.
            async with _capture_lock(lock_id):
                await fulfill_order(db_session, order_id, result, request=request, send_email=False)
        except Exception:
            failures += 1
            logger.exception("Fulfillment of order %s (purchase %s) failed", order_uuid, code)
            try:
                await db_session.rollback()
            except Exception:
                pass
    return failures


async def reject_purchase(db_session: AsyncSession, request: Optional[Request], org_id: int,
                          purchase_uuid: str, body: RejectBody, admin) -> dict:
    reason = _clean_reason(body.reason)
    notify = body.notify is not False
    purchase = await _purchase_or_404(db_session, org_id, purchase_uuid)
    purchase_id = purchase.id
    async with _capture_lock(f"purchase:{purchase_id}"):
        purchase = await _locked_purchase(db_session, purchase_id)
        status = purchase.status
        if status == "paid":
            await db_session.commit()
            raise purchase_error("ALREADY_PAID")
        if status in ("voided", "cancelled"):
            await db_session.commit()
            raise purchase_error("NOT_PENDING", status=status)
        if status == "rejected":
            await db_session.commit()
            return await _payload(db_session, request, purchase_id, admin=True)
        now = utcnow()
        purchase.status = "rejected"
        purchase.reject_reason = reason
        purchase.closed_at = now
        purchase.update_date = now
        raw = dict(purchase.raw or {})
        raw["rejected_by"] = admin.id
        if notify:
            raw["emails"] = {**(raw.get("emails") or {}), "rejected": iso(now)}
        purchase.raw = raw
        db_session.add(purchase)
        await _close_children(db_session, purchase_id, from_statuses=None, to_status="failed",
                              reason="REJECTED", enrollment_status="failed")
        await db_session.commit()
        logger.info("Purchase %s rejected by admin %s", purchase.code, admin.id)
    if notify:
        await _send_rejected_email(db_session, request, purchase_id)
    return await _payload(db_session, request, purchase_id, admin=True)


async def void_purchase(db_session: AsyncSession, request: Optional[Request], org_id: int,
                        purchase_uuid: str, body: VoidBody, admin) -> dict:
    """Undo a paid purchase marked by mistake: every child order is revoked
    (``revoke_order``: access goes away unless another purchase grants it)."""
    reason = _clean_reason(body.reason)
    purchase = await _purchase_or_404(db_session, org_id, purchase_uuid)
    purchase_id = purchase.id
    async with _capture_lock(f"purchase:{purchase_id}"):
        purchase = await _locked_purchase(db_session, purchase_id)
        status = purchase.status
        await db_session.commit()
        if status not in ("paid", "voided"):
            raise purchase_error("NOT_PAID")
        # Orders first, the purchase last: a crash half way leaves it "paid",
        # and voiding again finishes the job (revoke_order is idempotent).
        for order in await _child_orders(db_session, purchase_id):
            if order.status in PAID_STATUSES:
                await revoke_order(db_session, order.id, reason="voided")
        if status == "paid":
            purchase = await _locked_purchase(db_session, purchase_id)
            if purchase.status == "paid":
                now = utcnow()
                purchase.status = "voided"
                purchase.reject_reason = reason
                purchase.update_date = now
                purchase.raw = {**(purchase.raw or {}), "voided_by": admin.id, "voided_at": iso(now)}
                db_session.add(purchase)
                # An order a crashed confirmation never paid must not stay open
                # (it would block its offer for good).
                await _close_children(db_session, purchase_id, from_statuses=("pending",), to_status="cancelled",
                                      reason="voided", enrollment_status="cancelled")
            await db_session.commit()
            logger.warning("Purchase %s voided by admin %s: %s", purchase.code, admin.id, reason)
    return await _payload(db_session, request, purchase_id, admin=True)


# ------------------------------------------------------------------ emails


@dataclass
class _EmailContext:
    purchase: PaymentsPurchase
    buyer: Optional[User]
    branding: Any
    items: list[PaymentsPurchaseItem]
    platform: str
    settings: dict


async def _email_context(db_session: AsyncSession, request: Optional[Request],
                         purchase: PaymentsPurchase) -> _EmailContext:
    from src.services.email.branding import resolve_org_email_branding

    org = await db_session.get(Organization, purchase.org_id)
    org_config = (await db_session.execute(
        select(OrganizationConfig).where(OrganizationConfig.org_id == purchase.org_id)
    )).scalars().first()
    items = list((await db_session.execute(
        select(PaymentsPurchaseItem).where(PaymentsPurchaseItem.purchase_id == purchase.id)
        .order_by(PaymentsPurchaseItem.id)
    )).scalars().all())
    return _EmailContext(
        purchase=purchase,
        buyer=await db_session.get(User, purchase.user_id),
        branding=resolve_org_email_branding(org, org_config, request),
        items=items,
        platform=platform_base_url(request),
        settings=settings_of(await manual_config(db_session, purchase.org_id)),
    )


def _item_lines(items: list[PaymentsPurchaseItem]) -> list[purchase_emails.ItemLine]:
    return [purchase_emails.ItemLine(name=i.name, amount=Decimal(str(i.amount))) for i in items]


async def _send_created_emails(db_session: AsyncSession, request: Optional[Request],
                               purchase: PaymentsPurchase) -> None:
    """Payment instructions to the buyer and, if configured, a notice to the
    admin. Never raises."""
    code = purchase.code
    try:
        ctx = await _email_context(db_session, request, purchase)
        details = buyer_payment_details(ctx.settings, purchase.payment_details)
        buyer_name = display_name(ctx.buyer)
        number = details.get("whatsapp") or ""
        url = whatsapp_url(number, whatsapp_message(
            purchase.code, purchase.amount_ves, purchase.amount, [i.name for i in ctx.items], buyer_name,
        )) if number else None
        common = dict(
            items=_item_lines(ctx.items), amount=purchase.amount, amount_ves=purchase.amount_ves,
            rate=purchase.fx_rate, rate_source=purchase.fx_source, rate_date=purchase.fx_date,
            expires_at=purchase.expires_at,
        )
        sent = {}
        if ctx.buyer is not None and ctx.buyer.email:
            subject, document = purchase_emails.render_created(
                branding=ctx.branding,
                first_name=(ctx.buyer.first_name or ctx.buyer.username or "").strip(),
                code=purchase.code,
                payment=details,
                whatsapp_url=url,
                purchase_url=f"{ctx.platform}/store/purchases/{purchase.purchase_uuid}",
                **common,
            )
            if purchase_emails.schedule_email(ctx.buyer.email, subject, document, ctx.branding.sender_name,
                                              f"created:{purchase.code}"):
                sent["created"] = iso(utcnow())
        notify_email = ctx.settings.get("notify_email") or ""
        if notify_email:
            subject, document = purchase_emails.render_admin_notice(
                branding=ctx.branding,
                code=purchase.code,
                buyer_name=buyer_name,
                buyer_email=ctx.buyer.email if ctx.buyer else "",
                dash_url=f"{ctx.platform}/dash/orders?code={quote(purchase.code)}",
                **common,
            )
            if purchase_emails.schedule_email(notify_email, subject, document, ctx.branding.sender_name,
                                              f"admin_notice:{purchase.code}"):
                sent["admin_notice"] = iso(utcnow())
        if sent:
            purchase.raw = {**(purchase.raw or {}), "emails": {**((purchase.raw or {}).get("emails") or {}), **sent}}
            db_session.add(purchase)
            await db_session.commit()
    except Exception:
        # The purchase is already saved: log, undo this step only, carry on.
        logger.warning("Could not prepare the emails of purchase %s", code, exc_info=True)
        try:
            await db_session.rollback()
        except Exception:
            pass


async def _send_paid_email_once(db_session: AsyncSession, request: Optional[Request], purchase_id: int) -> None:
    """One "ya tienes acceso" email per purchase, with every course/ebook."""
    try:
        purchase = await _locked_purchase(db_session, purchase_id)
        emails = dict((purchase.raw or {}).get("emails") or {})
        if purchase.status != "paid" or emails.get("paid"):
            await db_session.commit()
            return
        ctx = await _email_context(db_session, request, purchase)
        if ctx.buyer is None or not ctx.buyer.email:
            await db_session.commit()
            return
        offers = [await db_session.get(PaymentsOffer, i.offer_id) for i in ctx.items]
        courses = await _courses_by_offer(db_session, purchase.org_id, [o for o in offers if o is not None])
        resources, seen = [], set()
        for offer in offers:
            for course in courses.get(offer.id, []) if offer is not None else []:
                if course.id in seen:
                    continue
                seen.add(course.id)
                resources.append((course.name, course_url(course, request), product_type_of(course)))
        cta = resources[0][1] if resources else f"{ctx.platform}/store/purchases/{purchase.purchase_uuid}"
        subject, document = purchase_emails.render_paid(
            branding=ctx.branding,
            first_name=(ctx.buyer.first_name or ctx.buyer.username or "").strip(),
            code=purchase.code,
            resources=resources,
            cta_url=cta,
        )
        if purchase_emails.schedule_email(ctx.buyer.email, subject, document, ctx.branding.sender_name,
                                          f"paid:{purchase.code}"):
            emails["paid"] = iso(utcnow())
            purchase.raw = {**(purchase.raw or {}), "emails": emails}
            db_session.add(purchase)
        await db_session.commit()
    except Exception:
        logger.warning("Could not prepare the access email of purchase %s", purchase_id, exc_info=True)
        try:
            await db_session.rollback()
        except Exception:
            pass


async def _send_rejected_email(db_session: AsyncSession, request: Optional[Request], purchase_id: int) -> None:
    try:
        purchase = await db_session.get(PaymentsPurchase, purchase_id)
        ctx = await _email_context(db_session, request, purchase)
        if ctx.buyer is None or not ctx.buyer.email:
            return
        number = ctx.settings.get("whatsapp") or (purchase.payment_details or {}).get("whatsapp") or None
        subject, document = purchase_emails.render_rejected(
            branding=ctx.branding,
            first_name=(ctx.buyer.first_name or ctx.buyer.username or "").strip(),
            code=purchase.code,
            reason=purchase.reject_reason or "",
            whatsapp_number=number,
        )
        purchase_emails.schedule_email(ctx.buyer.email, subject, document, ctx.branding.sender_name,
                                       f"rejected:{purchase.code}")
    except Exception:
        logger.warning("Could not prepare the rejection email of purchase %s", purchase_id, exc_info=True)
        try:
            await db_session.rollback()
        except Exception:
            pass

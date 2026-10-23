"""Sanar y Criar: checkout, capture, order status and provider webhooks."""

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Optional
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from uuid import uuid4

from fastapi import HTTPException, Request
from sqlalchemy import and_, or_
from sqlalchemy.exc import IntegrityError
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from config.config import get_learnhouse_config
from src.db.courses.courses import Course
from src.db.payments.payments import (
    PaymentsConfig,
    PaymentsEnrollment,
    PaymentsOffer,
    PaymentsOrder,
    PaymentsWebhookEvent,
)
from src.db.users import AnonymousUser, APITokenUser, SuperadminAPITokenUser
from src.services.payments.access import (
    ACCESS_STATUSES,
    get_course_access,
    normalize_course_uuid,
)
from src.services.payments.common import (
    as_utc,
    first_activity_uuids,
    get_offer_by_ref,
    get_org_or_404,
    resource_summary,
    utcnow,
)
from src.services.payments.configs import config_environment, get_active_config, is_test_mode
from src.services.payments.fulfillment import (
    PAID_STATUSES,
    apply_result,
    cancel_order,
    ensure_entitlements,
    fulfill_order,
    revoke_order,
)
from src.services.payments.offers import offer_courses
from src.services.payments.providers.base import (
    PaymentResult,
    ProviderError,
    ProviderEvent,
    WebhookVerificationError,
)
from src.services.payments.providers.registry import get_provider
from src.services.payments.settings import is_development_mode

logger = logging.getLogger(__name__)

METHODS = ("paypal", "card")
_MAX_REDIRECT_LENGTH = 2048
# A webhook still "in flight" this long is assumed dead and may be re-run.
_STALE_EVENT_AFTER = timedelta(minutes=5)
# An approved order this recent may still be captured by the return page, the
# webhook or reconciliation: a second checkout would risk a second charge.
_OPEN_APPROVAL_WINDOW = timedelta(minutes=30)

# Order status -> status reported to the frontend.
_PUBLIC_STATUS = {
    "paid": "paid",
    "accredited": "paid",
    "pending": "pending",
    "created": "pending",
    "approved": "pending",
    "failed": "failed",
    "expired": "failed",
    "cancelled": "cancelled",
    "refunded": "refunded",
}


# ------------------------------------------------------------ redirect_uri


def _origin_of(url: str) -> Optional[tuple[str, str, Optional[int]]]:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    return parsed.scheme, parsed.hostname.lower(), port


def _host_of_config(value: str) -> str:
    value = (value or "").strip().rstrip("/")
    if not value:
        return ""
    parsed = urlparse(value if "://" in value else f"//{value}")
    return (parsed.hostname or "").lower()


def is_allowed_redirect(url: str) -> bool:
    """Open-redirect guard for the PayPal return/cancel URLs.

    Allowed: the configured frontend/domain host (with or without ``www.``),
    an exact entry of ``allowed_origins``, and localhost in development mode.
    """
    if not url or len(url) > _MAX_REDIRECT_LENGTH:
        return False
    if any(ch in url for ch in ("\\", "\r", "\n", "\t", " ")):
        return False
    parsed = urlparse(url)
    if parsed.username or parsed.password:
        return False
    origin = _origin_of(url)
    if origin is None:
        return False
    scheme, host, port = origin

    config = get_learnhouse_config()
    origin_str = f"{scheme}://{parsed.netloc.lower()}"
    for allowed in config.hosting_config.allowed_origins or []:
        if isinstance(allowed, str) and origin_str == allowed.strip().rstrip("/").lower():
            return True

    bare = host.removeprefix("www.")
    for value in (config.hosting_config.frontend_domain, config.hosting_config.domain):
        configured = _host_of_config(value).removeprefix("www.")
        if configured and configured not in ("localhost", "127.0.0.1") and bare == configured:
            if config.hosting_config.ssl and scheme != "https":
                return False
            return True

    if is_development_mode() and host in ("localhost", "127.0.0.1"):
        return True
    return False


def build_return_url(redirect_uri: str, checkout: str, order_uuid: str) -> str:
    parsed = urlparse(redirect_uri)
    query = [(k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True)
             if k not in ("checkout", "order", "token", "PayerID")]
    query += [("checkout", checkout), ("order", order_uuid)]
    return urlunparse(parsed._replace(query=urlencode(query)))


# ----------------------------------------------------------------- helpers


def _require_user(user):
    if user is None or isinstance(user, (AnonymousUser, APITokenUser, SuperadminAPITokenUser)):
        raise HTTPException(status_code=401, detail="Authentication required")
    return user


async def _order_by_uuid(db_session: AsyncSession, org_id: int, order_uuid: str) -> PaymentsOrder:
    order = (await db_session.execute(
        select(PaymentsOrder).where(
            PaymentsOrder.order_uuid == order_uuid, PaymentsOrder.org_id == org_id
        )
    )).scalars().first()
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")
    return order


async def _config_for(db_session: AsyncSession, order_or_org_id, provider_id: str) -> Optional[PaymentsConfig]:
    org_id = order_or_org_id if isinstance(order_or_org_id, int) else order_or_org_id.org_id
    # Any config of the provider, even disabled: a payment already started
    # must still be confirmable after an admin toggles the provider off.
    return (await db_session.execute(
        select(PaymentsConfig).where(
            PaymentsConfig.org_id == org_id, PaymentsConfig.provider == provider_id
        )
    )).scalars().first()


async def order_response(db_session: AsyncSession, request: Optional[Request], order: PaymentsOrder,
                         status: Optional[str] = None, **extra) -> dict:
    from src.db.organizations import Organization

    offer = await db_session.get(PaymentsOffer, order.offer_id)
    org = await db_session.get(Organization, order.org_id)
    resources = []
    if offer is not None and org is not None:
        courses = await offer_courses(db_session, offer, published_only=True)
        first = await first_activity_uuids(db_session, [c.id for c in courses])
        for course in courses:
            summary = resource_summary(course, org.org_uuid, request)
            summary["first_activity_uuid"] = first.get(course.id)
            resources.append(summary)
    body = {
        "status": status or _PUBLIC_STATUS.get(order.status, order.status),
        "order_uuid": order.order_uuid,
        "offer_uuid": offer.offer_uuid if offer else None,
        "offer_name": offer.name if offer else None,
        "amount": float(order.amount) if order.amount is not None else None,
        "currency": order.currency,
        "provider": order.provider,
        "resources": resources,
    }
    body.update(extra)
    return body


async def _user_owns_offer(db_session: AsyncSession, user, offer: PaymentsOffer,
                           *, enrollments_only: bool = False) -> bool:
    enrollment = (await db_session.execute(
        select(PaymentsEnrollment.id).where(
            PaymentsEnrollment.user_id == user.id,
            PaymentsEnrollment.offer_id == offer.id,
            PaymentsEnrollment.status.in_(ACCESS_STATUSES),  # type: ignore[attr-defined]
        )
    )).first()
    if enrollment is not None:
        return True
    if enrollments_only:
        return False
    courses = await offer_courses(db_session, offer, published_only=True)
    if not courses:
        return False
    for course in courses:
        if not (await get_course_access(db_session, user, course)).has_access:
            return False
    return True


def _open_payment_clause():
    """Orders whose money may still move: a capture under review at the
    provider, or a recent approval not captured yet."""
    return or_(
        PaymentsOrder.status == "pending",
        and_(
            PaymentsOrder.status == "approved",
            PaymentsOrder.update_date >= utcnow() - _OPEN_APPROVAL_WINDOW,
        ),
    )


async def open_payment_for(db_session: AsyncSession, user_id: int, offer_id: int) -> Optional[PaymentsOrder]:
    return (await db_session.execute(
        select(PaymentsOrder).where(
            PaymentsOrder.user_id == user_id,
            PaymentsOrder.offer_id == offer_id,
            _open_payment_clause(),
        ).order_by(PaymentsOrder.id.desc())  # type: ignore[union-attr]
    )).scalars().first()


# ------------------------------------------------------------------ access


async def course_access(db_session: AsyncSession, org_id: int, resource_uuid: str, user) -> dict:
    uuid = normalize_course_uuid(resource_uuid)
    if not uuid:
        raise HTTPException(status_code=400, detail="Falta resource_uuid")
    course = (await db_session.execute(
        select(Course).where(Course.course_uuid == uuid, Course.org_id == org_id)
    )).scalars().first()
    if course is None:
        raise HTTPException(status_code=404, detail="Course not found")
    access = (await get_course_access(db_session, user, course)).as_dict()
    # A payment under review: the paywall says so instead of offering to buy
    # again (a second checkout would charge twice).
    access["payment_pending"] = False
    if access["for_sale"] and not access["has_access"] and access["reason"] == "none":
        access["payment_pending"] = await _has_open_payment_for_course(db_session, user, course)
    return access


async def _has_open_payment_for_course(db_session: AsyncSession, user, course: Course) -> bool:
    from src.services.payments.access import covering_offer_ids_query

    if user is None or isinstance(user, (AnonymousUser, APITokenUser, SuperadminAPITokenUser)):
        return False
    user_id = int(getattr(user, "id", 0) or 0)
    if not user_id:
        return False
    offers = covering_offer_ids_query(course.course_uuid, org_id=course.org_id, include_archived=True)
    row = (await db_session.execute(
        select(PaymentsOrder.id).where(
            PaymentsOrder.user_id == user_id,
            PaymentsOrder.offer_id.in_(offers),  # type: ignore[attr-defined]
            _open_payment_clause(),
        ).limit(1)
    )).first()
    return row is not None


# ---------------------------------------------------------------- checkout


async def start_checkout(db_session: AsyncSession, request: Optional[Request], org_id: int, offer_ref: str,
                         user, *, redirect_uri: str, provider_id: Optional[str], method: Optional[str]) -> dict:
    _require_user(user)
    await get_org_or_404(db_session, org_id)
    offer = await get_offer_by_ref(db_session, org_id, offer_ref)
    if offer.offer_type != "one_time":
        raise HTTPException(status_code=400, detail="Esta oferta no se puede pagar con el proveedor actual")

    if not is_allowed_redirect(redirect_uri):
        raise HTTPException(status_code=400, detail="redirect_uri no permitido")

    method = (method or "paypal").strip().lower()
    if method not in METHODS:
        raise HTTPException(status_code=400, detail="Método de pago no válido")

    if provider_id:
        cfg = await get_active_config(db_session, org_id, provider_id.strip().lower())
    else:
        cfg = (await db_session.execute(
            select(PaymentsConfig).where(
                PaymentsConfig.org_id == org_id,
                PaymentsConfig.active == True,  # noqa: E712
                PaymentsConfig.enabled == True,  # noqa: E712
            ).order_by(PaymentsConfig.id)
        )).scalars().first()
    provider = get_provider(cfg.provider) if cfg else None
    if cfg is None or provider is None:
        raise HTTPException(status_code=400, detail="Los pagos no están configurados en este momento")
    if method not in provider.methods:
        raise HTTPException(status_code=400, detail="Método de pago no disponible")
    if offer.currency.upper() not in provider.supported_currencies:
        raise HTTPException(status_code=400, detail="La moneda de la oferta no es compatible con el proveedor")
    # A sandbox config on a production instance only takes test purchases from
    # the team: anyone else would get real access for fake money.
    test_mode = is_test_mode(cfg)
    if test_mode and not await _is_org_admin(db_session, user, org_id):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "STORE_TEST_MODE",
                "message": "La tienda está en modo de pruebas. Vuelve pronto para hacer tu compra.",
            },
        )

    courses = await offer_courses(db_session, offer, published_only=True)
    if not courses:
        raise HTTPException(status_code=400, detail="Esta oferta todavía no tiene contenido publicado")

    # In test mode the buyer is an admin, who sees every course anyway: only a
    # previous (test) purchase counts, so the payment flow can be tried out.
    if await _user_owns_offer(db_session, user, offer, enrollments_only=test_mode):
        raise HTTPException(status_code=409, detail={"code": "ALREADY_OWNED"})
    # A payment of this offer may still go through: send the buyer to it
    # instead of opening a second charge.
    open_order = await open_payment_for(db_session, user.id, offer.id)
    if open_order is not None:
        raise HTTPException(
            status_code=409, detail={"code": "PAYMENT_PENDING", "order_uuid": open_order.order_uuid}
        )

    # One enrollment row per (user, offer): reuse an abandoned/failed one.
    enrollment = (await db_session.execute(
        select(PaymentsEnrollment).where(
            PaymentsEnrollment.user_id == user.id, PaymentsEnrollment.offer_id == offer.id
        ).order_by(PaymentsEnrollment.id.desc())  # type: ignore[union-attr]
    )).scalars().first()
    if enrollment is None:
        enrollment = PaymentsEnrollment(
            enrollment_uuid=str(uuid4()),
            offer_id=offer.id,
            user_id=user.id,
            org_id=org_id,
            status="pending",
            provider_specific_data={},
        )
    elif enrollment.status not in ACCESS_STATUSES:
        enrollment.status = "pending"
        enrollment.update_date = utcnow()
    db_session.add(enrollment)
    await db_session.flush()

    order = PaymentsOrder(
        order_uuid=str(uuid4()),
        org_id=org_id,
        offer_id=offer.id,
        user_id=user.id,
        enrollment_id=enrollment.id,
        provider=provider.id,
        method=method,
        status="created",
        amount=offer.amount,  # always from the database
        currency=offer.currency.upper(),
        redirect_uri=redirect_uri,
        # Recorded so sandbox (test) sales can be told apart afterwards.
        raw={"environment": config_environment(cfg)},
    )
    db_session.add(order)
    await db_session.commit()
    await db_session.refresh(order)

    return_url = build_return_url(redirect_uri, "return", order.order_uuid)
    cancel_url = build_return_url(redirect_uri, "cancelled", order.order_uuid)
    try:
        result = await provider.create_checkout(
            cfg, order, offer, user, return_url=return_url, cancel_url=cancel_url, method=method
        )
    except ProviderError as exc:
        logger.error("Checkout creation failed for order %s: %s", order.order_uuid, exc)
        order.status = "failed"
        order.failure_reason = (exc.code or "CHECKOUT_CREATE_FAILED")[:255]
        order.update_date = utcnow()
        db_session.add(order)
        await db_session.commit()
        raise HTTPException(
            status_code=502,
            detail="No pudimos iniciar el pago. Intenta de nuevo en unos minutos.",
        )

    order.provider_order_id = result.provider_order_id
    order.raw = {**(order.raw or {}), "create": result.raw}
    order.update_date = utcnow()
    db_session.add(order)
    await db_session.commit()
    return {"checkout_url": result.checkout_url, "provider": provider.id, "order_uuid": order.order_uuid}


# ----------------------------------------------------------------- capture


def _redis():
    if os.getenv("TESTING", "false").lower() == "true":
        return None
    from src.core.redis import get_redis_client

    return get_redis_client()


_LOCAL_CAPTURE_LOCKS: dict[str, asyncio.Lock] = {}
_CAPTURE_LOCK_TTL_SECONDS = 45
_CAPTURE_LOCK_WAIT_SECONDS = 30


def capture_lock_id(order: PaymentsOrder) -> str:
    return f"{order.user_id}:{order.offer_id}"


@asynccontextmanager
async def _capture_lock(lock_id: str):
    """Serialize confirmations per (buyer, offer): the return page, webhook
    and reconciliation of one order, and also two orders of the same offer.

    Held across the ownership re-check and the capture, so a capture that
    finished just before is seen as fulfilled: two approved orders confirmed
    at the same time are never both charged. Capture is also idempotent at
    PayPal and fulfillment locks the order row.
    """
    local = _LOCAL_CAPTURE_LOCKS.setdefault(lock_id, asyncio.Lock())
    async with local:
        client = _redis()
        key = f"sc_pay:capture_lock:{lock_id}"
        token = str(uuid4())
        acquired = False
        if client is not None:
            deadline = time.monotonic() + _CAPTURE_LOCK_WAIT_SECONDS
            while True:
                try:
                    acquired = bool(client.set(key, token, nx=True, ex=_CAPTURE_LOCK_TTL_SECONDS))
                except Exception:
                    break  # Redis unavailable: rely on idempotency alone
                if acquired or time.monotonic() > deadline:
                    break
                await asyncio.sleep(0.25)
        try:
            yield
        finally:
            if acquired:
                try:
                    current = client.get(key)
                    if current is not None and (current.decode() if isinstance(current, bytes) else current) == token:
                        client.delete(key)
                except Exception:
                    pass
    if not local.locked():
        _LOCAL_CAPTURE_LOCKS.pop(lock_id, None)


async def _owned_through_other_order(db_session: AsyncSession, order: PaymentsOrder) -> bool:
    """True when another granting enrollment of the same buyer covers the
    order's offer (any enrollment row, not only the order's own)."""
    enrollments = (await db_session.execute(
        select(PaymentsEnrollment).where(
            PaymentsEnrollment.user_id == order.user_id,
            PaymentsEnrollment.offer_id == order.offer_id,
            PaymentsEnrollment.status.in_(ACCESS_STATUSES),  # type: ignore[attr-defined]
        ).execution_options(populate_existing=True)
    )).scalars().all()
    return any(
        (e.provider_specific_data or {}).get("order_uuid") != order.order_uuid for e in enrollments
    )


async def capture_and_fulfill(db_session: AsyncSession, order: PaymentsOrder,
                              request: Optional[Request] = None, params: Optional[dict] = None) -> tuple[str, dict]:
    """Confirm ``order`` with its provider and fulfill it when paid.

    Returns (public status, extra response fields). Shared by the return
    page, the CHECKOUT.ORDER.APPROVED webhook and reconciliation.
    """
    async with _capture_lock(capture_lock_id(order)):
        return await _capture_and_fulfill_locked(db_session, order, request, params)


async def _capture_and_fulfill_locked(db_session: AsyncSession, order: PaymentsOrder,
                                      request: Optional[Request], params: Optional[dict]) -> tuple[str, dict]:
    await db_session.refresh(order)
    if order.status in PAID_STATUSES:
        await ensure_entitlements(db_session, order, request)
        return "paid", {}
    if order.status in ("refunded", "cancelled", "expired"):
        return _PUBLIC_STATUS[order.status], {}
    if order.status == "failed":
        return ("retry" if order.failure_reason == "INSTRUMENT_DECLINED" else "failed"), {}

    # The buyer may already own the offer through another order (two tabs, or
    # a double-click that created two enrollment rows). Never capture a second
    # payment for it: an approved but uncaptured PayPal order moves no money.
    if await _owned_through_other_order(db_session, order):
        await cancel_order(db_session, order.id, reason="already_owned")
        return "paid", {"already_owned": True}

    cfg = await _config_for(db_session, order, order.provider)
    provider = get_provider(order.provider)
    if cfg is None or provider is None:
        raise HTTPException(status_code=503, detail="El proveedor de pago no está disponible")

    try:
        result = await provider.confirm(cfg, order, params or {})
    except ProviderError as exc:
        logger.warning("Capture of order %s failed: %s", order.order_uuid, exc)
        raise HTTPException(
            status_code=502,
            detail="No pudimos confirmar el pago con el proveedor. Intenta de nuevo en unos minutos.",
        )
    return await _record(db_session, order, result, request)


async def _record(db_session: AsyncSession, order: PaymentsOrder, result: PaymentResult,
                  request: Optional[Request]) -> tuple[str, dict]:
    if result.status == "paid":
        await fulfill_order(db_session, order.id, result, request=request)
        return "paid", {}
    await apply_result(db_session, order.id, result)
    await db_session.refresh(order)
    if result.status == "retry":
        return "retry", {}
    return _PUBLIC_STATUS.get(order.status, "pending"), {}


async def capture_order_endpoint(db_session: AsyncSession, request: Optional[Request], org_id: int,
                                 order_uuid: str, user, params: Optional[dict] = None) -> dict:
    order = await _order_by_uuid(db_session, org_id, order_uuid)
    if user is not None and not isinstance(user, AnonymousUser):
        # Token principals carry a token id, not a user id: never an owner.
        if isinstance(user, (APITokenUser, SuperadminAPITokenUser)) or user.id != order.user_id:
            # The uuid is the secret; a different signed-in user gets nothing.
            raise HTTPException(status_code=404, detail="Order not found")
    status, extra = await capture_and_fulfill(db_session, order, request, params)
    await db_session.refresh(order)
    return await order_response(db_session, request, order, status, **extra)


async def _is_org_admin(db_session: AsyncSession, user, org_id: int) -> bool:
    from src.security.org_auth import is_org_admin

    return await is_org_admin(user.id, org_id, db_session)


async def get_order_status(db_session: AsyncSession, request: Optional[Request], org_id: int,
                           order_uuid: str, user) -> dict:
    _require_user(user)
    order = await _order_by_uuid(db_session, org_id, order_uuid)
    is_owner = order.user_id == user.id
    if not is_owner and not await _is_org_admin(db_session, user, org_id):
        raise HTTPException(status_code=404, detail="Order not found")

    # Polling a payment under review: ask the provider at most every 10 s.
    if is_owner and order.status in ("pending", "approved") and order.provider_order_id:
        if _claim_refresh(order.order_uuid):
            try:
                await refresh_order(db_session, order, request)
            except Exception:
                logger.warning("Order refresh failed for %s", order.order_uuid, exc_info=True)
            await db_session.refresh(order)
    return await order_response(db_session, request, order)


def _claim_refresh(order_uuid: str) -> bool:
    client = _redis()
    if client is None:
        return True
    try:
        return bool(client.set(f"sc_pay:order_refresh:{order_uuid}", "1", nx=True, ex=10))
    except Exception:
        return True


async def cancel_order_endpoint(db_session: AsyncSession, request: Optional[Request], org_id: int,
                                order_uuid: str, user) -> dict:
    _require_user(user)
    order = await _order_by_uuid(db_session, org_id, order_uuid)
    if order.user_id != user.id:
        raise HTTPException(status_code=404, detail="Order not found")
    await cancel_order(db_session, order.id)
    await db_session.refresh(order)
    return await order_response(db_session, request, order)


async def refresh_order(db_session: AsyncSession, order: PaymentsOrder,
                        request: Optional[Request] = None) -> str:
    """Bring an open order in line with the provider (reconciliation)."""
    cfg = await _config_for(db_session, order, order.provider)
    provider = get_provider(order.provider)
    if cfg is None or provider is None:
        return order.status
    result = await provider.fetch_status(cfg, order)
    if result.status == "approved":
        status, _ = await capture_and_fulfill(db_session, order, request)
        return status
    if result.status == "created":
        return order.status
    status, _ = await _record(db_session, order, result, request)
    return status


# ---------------------------------------------------------------- webhooks


async def _claim_event(db_session: AsyncSession, provider_id: str, org_id: int, event: ProviderEvent) -> bool:
    """Record the event; False when it was (or is being) processed already."""
    try:
        async with db_session.begin_nested():
            db_session.add(PaymentsWebhookEvent(
                provider=provider_id,
                event_id=event.event_id,
                org_id=org_id,
                event_type=event.event_type[:128],
                status="in_flight",
            ))
        await db_session.commit()
        return True
    except IntegrityError:
        await db_session.rollback()
    existing = (await db_session.execute(
        select(PaymentsWebhookEvent)
        .where(PaymentsWebhookEvent.provider == provider_id, PaymentsWebhookEvent.event_id == event.event_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )).scalars().first()
    if existing is None:
        return False
    stale = (as_utc(existing.received_at) or utcnow()) < utcnow() - _STALE_EVENT_AFTER
    if existing.status == "done" or (existing.status == "in_flight" and not stale):
        await db_session.commit()
        return False
    existing.status = "in_flight"
    existing.attempts = (existing.attempts or 0) + 1
    existing.received_at = utcnow()
    db_session.add(existing)
    await db_session.commit()
    return True


async def _finish_event(db_session: AsyncSession, provider_id: str, event_id: str,
                        status: str, error: Optional[str] = None) -> None:
    row = (await db_session.execute(
        select(PaymentsWebhookEvent).where(
            PaymentsWebhookEvent.provider == provider_id, PaymentsWebhookEvent.event_id == event_id
        ).execution_options(populate_existing=True)
    )).scalars().first()
    if row is None:
        return
    row.status = status
    row.last_error = (error or None) and error[:2000]
    row.processed_at = utcnow()
    db_session.add(row)
    await db_session.commit()


async def _find_order(db_session: AsyncSession, org_id: int, provider_id: str,
                      event: ProviderEvent) -> Optional[PaymentsOrder]:
    base = select(PaymentsOrder).where(PaymentsOrder.org_id == org_id, PaymentsOrder.provider == provider_id)
    if event.custom_id:
        order = (await db_session.execute(base.where(PaymentsOrder.order_uuid == event.custom_id))).scalars().first()
        if order is not None:
            return order
    if event.provider_order_id:
        order = (await db_session.execute(
            base.where(PaymentsOrder.provider_order_id == event.provider_order_id)
        )).scalars().first()
        if order is not None:
            return order
    if event.provider_capture_id:
        return (await db_session.execute(
            base.where(PaymentsOrder.provider_capture_id == event.provider_capture_id)
        )).scalars().first()
    return None


async def _handle_event(db_session: AsyncSession, request: Optional[Request], org_id: int,
                        provider_id: str, cfg: PaymentsConfig, event: ProviderEvent) -> str:
    provider = get_provider(provider_id)
    if event.kind == "ignored":
        return "ignored"
    order = await _find_order(db_session, org_id, provider_id, event)
    if order is None:
        logger.warning("Webhook %s (%s): no matching order", event.event_id, event.event_type)
        return "unmatched"

    if event.kind == "order_approved":
        if order.status in ("created", "approved"):
            status, _ = await capture_and_fulfill(db_session, order, request)
            return status
        return "noop"

    if event.kind == "capture_completed":
        if order.status in PAID_STATUSES:
            await ensure_entitlements(db_session, order, request)
            return "paid"
        matches = (
            event.capture_status == "COMPLETED"
            and event.custom_id == order.order_uuid
            and event.currency == (order.currency or "").upper()
            and event.amount is not None
            and event.amount == order.amount
        )
        if matches:
            result = PaymentResult(
                status="paid",
                provider_capture_id=event.provider_capture_id,
                charged_amount=event.amount,
                charged_currency=event.currency,
                raw={"webhook_event": event.event_id},
            )
            await fulfill_order(db_session, order.id, result, request=request)
            return "paid"
        # The event does not carry everything we need: ask the provider.
        result = await provider.fetch_status(cfg, order)
        status, _ = await _record(db_session, order, result, request)
        return status

    if event.kind == "capture_pending":
        result = PaymentResult(status="pending", provider_capture_id=event.provider_capture_id,
                               reason="PENDING", raw={"webhook_event": event.event_id})
        await apply_result(db_session, order.id, result)
        return "pending"

    if event.kind == "capture_failed":
        result = PaymentResult(status="failed", provider_capture_id=event.provider_capture_id,
                               reason=event.capture_status or "DECLINED", raw={"webhook_event": event.event_id})
        await apply_result(db_session, order.id, result)
        return "failed"

    if event.kind == "capture_reversed":
        await revoke_order(db_session, order.id, reason="reversed")
        return "refunded"

    if event.kind == "capture_refunded":
        capture_id = event.provider_capture_id or order.provider_capture_id
        capture_status = None
        if capture_id:
            capture_status = await provider.get_capture_status(cfg, capture_id)
        if capture_status == "REFUNDED":
            await revoke_order(db_session, order.id, reason="refunded")
            return "refunded"
        # Partial refund: access stays; keep a note on the order.
        raw = dict(order.raw or {})
        notes = list(raw.get("partial_refunds") or [])
        notes.append({"event_id": event.event_id, "amount": str(event.amount) if event.amount else None})
        raw["partial_refunds"] = notes[-20:]
        order.raw = raw
        db_session.add(order)
        await db_session.commit()
        return "partial_refund"
    return "ignored"


async def handle_provider_webhook(db_session: AsyncSession, request: Request, org_id: int, provider_id: str) -> dict:
    provider_id = (provider_id or "").lower()
    provider = get_provider(provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="Unknown provider")
    cfg = await _config_for(db_session, org_id, provider_id)
    if cfg is None:
        raise HTTPException(status_code=404, detail="Payments are not configured")
    try:
        events = await provider.handle_webhook(cfg, request)
    except WebhookVerificationError as exc:
        logger.warning("Rejected %s webhook for org %s: %s", provider_id, org_id, exc)
        raise HTTPException(status_code=400, detail="Invalid webhook signature")
    except ProviderError as exc:
        logger.warning("Could not verify %s webhook for org %s: %s", provider_id, org_id, exc)
        if exc.retryable:
            raise HTTPException(status_code=503, detail="Verification unavailable, retry later")
        raise HTTPException(status_code=400, detail="Invalid webhook signature")

    results = []
    retry_later = False
    for event in events:
        if not await _claim_event(db_session, provider_id, org_id, event):
            results.append({"event_id": event.event_id, "result": "duplicate"})
            continue
        try:
            outcome = await _handle_event(db_session, request, org_id, provider_id, cfg, event)
            await _finish_event(db_session, provider_id, event.event_id, "done")
            results.append({"event_id": event.event_id, "result": outcome})
        except Exception as exc:
            # The signature was valid, so a definitive failure still answers
            # 2xx (a manual resend re-runs this event). A transient one (the
            # provider or the database briefly unavailable) answers 503 so the
            # provider redelivers: reconciliation never revisits refunds, nor
            # pending captures older than its 24 h window.
            logger.exception("Processing %s webhook %s failed", provider_id, event.event_id)
            try:
                await db_session.rollback()
            except Exception:
                pass
            detail = exc.detail if isinstance(exc, HTTPException) else str(exc)
            await _finish_event(db_session, provider_id, event.event_id, "failed", str(detail))
            results.append({"event_id": event.event_id, "result": "error"})
            retry_later = retry_later or _is_transient(exc)
    if retry_later:
        raise HTTPException(status_code=503, detail="Processing failed, retry later")
    return {"status": "success", "events": results}


def _is_transient(exc: Exception) -> bool:
    from sqlalchemy.exc import OperationalError

    if isinstance(exc, ProviderError):
        return bool(exc.retryable)
    if isinstance(exc, HTTPException):
        return exc.status_code >= 500
    return isinstance(exc, (OperationalError, ConnectionError, TimeoutError))

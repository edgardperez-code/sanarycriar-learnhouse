"""Sanar y Criar: admin customers / overview / transactions and the buyer's
own purchases, computed from our orders and enrollments (no Stripe)."""

from datetime import timedelta
from decimal import Decimal
from typing import Optional

from fastapi import HTTPException, Request
from sqlalchemy import func
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from src.db.payments.payments import PaymentsEnrollment, PaymentsOffer, PaymentsOrder
from src.db.payments.purchases import PaymentsPurchase, PaymentsPurchaseItem
from src.db.users import User
from src.services.payments.common import (
    courses_by_uuid,
    get_org_or_404,
    iso,
    money,
    offer_resource_map,
    resource_summary,
    utcnow,
)

# Enrollments worth showing: bought, refunded, or a payment under review.
# Abandoned checkouts (pending/cancelled/failed with nothing captured) stay out.
VISIBLE_ENROLLMENT_STATUSES = ("active", "completed", "refunded")
# Orders that are actual charges (money moved or was attempted at capture).
CHARGE_STATUSES = ("paid", "accredited", "pending", "refunded", "failed")


async def _purchase_codes(db_session: AsyncSession, order_ids) -> dict[int, str]:
    """Sanar y Criar: order id -> code of its Pago Móvil purchase (SYC-…)."""
    ids = [i for i in set(order_ids) if i]
    if not ids:
        return {}
    rows = (await db_session.execute(
        select(PaymentsPurchaseItem.order_id, PaymentsPurchase.code)
        .join(PaymentsPurchase, PaymentsPurchase.id == PaymentsPurchaseItem.purchase_id)  # type: ignore[arg-type]
        .where(PaymentsPurchaseItem.order_id.in_(ids))  # type: ignore[attr-defined]
    )).all()
    return {order_id: code for order_id, code in rows}


async def _pending_review_enrollment_ids(db_session: AsyncSession, org_id: int,
                                         user_id: Optional[int] = None) -> set[int]:
    stmt = select(PaymentsOrder.enrollment_id).where(
        PaymentsOrder.org_id == org_id, PaymentsOrder.status == "pending"
    )
    if user_id is not None:
        stmt = stmt.where(PaymentsOrder.user_id == user_id)
    return set((await db_session.execute(stmt)).scalars().all())


async def _latest_paid_orders(db_session: AsyncSession, enrollment_ids: list[int]) -> dict[int, PaymentsOrder]:
    if not enrollment_ids:
        return {}
    orders = (await db_session.execute(
        select(PaymentsOrder)
        .where(
            PaymentsOrder.enrollment_id.in_(enrollment_ids),  # type: ignore[attr-defined]
            PaymentsOrder.status.in_(("paid", "accredited", "refunded", "pending")),  # type: ignore[attr-defined]
        )
        .order_by(PaymentsOrder.id)
    )).scalars().all()
    latest: dict[int, PaymentsOrder] = {}
    for order in orders:
        latest[order.enrollment_id] = order
    return latest


async def list_customers(db_session: AsyncSession, org_id: int) -> list[dict]:
    pending_ids = await _pending_review_enrollment_ids(db_session, org_id)
    rows = (await db_session.execute(
        select(PaymentsEnrollment, User, PaymentsOffer)
        .join(User, User.id == PaymentsEnrollment.user_id)  # type: ignore[arg-type]
        .join(PaymentsOffer, PaymentsOffer.id == PaymentsEnrollment.offer_id)  # type: ignore[arg-type]
        .where(PaymentsEnrollment.org_id == org_id)
        .order_by(PaymentsEnrollment.creation_date.desc(), PaymentsEnrollment.id.desc())  # type: ignore[attr-defined]
    )).all()
    rows = [r for r in rows if r[0].status in VISIBLE_ENROLLMENT_STATUSES or r[0].id in pending_ids]
    orders = await _latest_paid_orders(db_session, [r[0].id for r in rows])
    codes = await _purchase_codes(db_session, [o.id for o in orders.values()])
    result = []
    for enrollment, user, offer in rows:
        order = orders.get(enrollment.id)
        result.append({
            "enrollment_id": enrollment.id,
            "enrollment_uuid": enrollment.enrollment_uuid,
            "status": enrollment.status,
            "creation_date": iso(enrollment.creation_date),
            "user": {
                "user_uuid": user.user_uuid,
                "avatar_image": user.avatar_image or "",
                "first_name": user.first_name,
                "last_name": user.last_name,
                "username": user.username,
                "email": user.email,
            },
            "offer": {
                "id": offer.id,
                "offer_uuid": offer.offer_uuid,
                "name": offer.name,
                "offer_type": offer.offer_type,
                "amount": money(offer.amount),
                "currency": offer.currency,
            },
            "payment": {
                "provider": order.provider,
                "provider_order_id": order.provider_order_id,
                "last_charge_date": iso(order.paid_at or order.update_date),
                "last_charge_amount": money(order.charged_amount if order.charged_amount is not None else order.amount),
                "currency": order.charged_currency or order.currency,
                "status": order.status,
                "method": order.method,
                **_order_flags(order),
                "purchase_code": codes.get(order.id),
            } if order else None,
            "stripe": None,
        })
    return result


def _order_flags(order: PaymentsOrder) -> dict:
    """Admin-facing flags: a second charge for something already bought
    (refund it), and sales made through a sandbox (test) configuration."""
    raw = order.raw or {}
    duplicate_of = raw.get("duplicate_of") if order.status in ("paid", "accredited") else None
    return {
        "duplicate_of": duplicate_of,
        "needs_refund": bool(duplicate_of),
        "environment": raw.get("environment"),
        "test_mode": raw.get("environment") == "sandbox",
    }


def _charge(order: PaymentsOrder, user: Optional[User], offer: Optional[PaymentsOffer],
            purchase_code: Optional[str] = None) -> dict:
    name = " ".join(p for p in [(user.first_name if user else ""), (user.last_name if user else "")] if p).strip()
    amount = order.charged_amount if order.charged_amount is not None else order.amount
    return {
        "id": order.order_uuid,
        "created": iso(order.paid_at or order.creation_date),
        "amount": money(amount),
        "currency": order.charged_currency or order.currency,
        "status": order.status,
        "paid": order.status in ("paid", "accredited", "refunded"),
        "amount_refunded": money(amount) if order.status == "refunded" else 0.0,
        "description": offer.name if offer else "",
        "receipt_url": None,
        "customer": {
            "id": user.user_uuid if user else None,
            "name": name or (user.username if user else None),
            "email": user.email if user else None,
        } if user else None,
        "card": None,
        "provider": order.provider,
        "provider_order_id": order.provider_order_id,
        "method": order.method,
        "failure_reason": order.failure_reason,
        **_order_flags(order),
        "purchase_code": purchase_code,
    }


async def _charges(db_session: AsyncSession, org_id: int, *, limit: int,
                   before_id: Optional[int] = None) -> list[dict]:
    stmt = (
        select(PaymentsOrder, User, PaymentsOffer)
        .outerjoin(User, User.id == PaymentsOrder.user_id)  # type: ignore[arg-type]
        .outerjoin(PaymentsOffer, PaymentsOffer.id == PaymentsOrder.offer_id)  # type: ignore[arg-type]
        .where(
            PaymentsOrder.org_id == org_id,
            PaymentsOrder.status.in_(CHARGE_STATUSES),  # type: ignore[attr-defined]
            # A "failed" order only counts once a capture was attempted.
            (PaymentsOrder.status != "failed") | (PaymentsOrder.provider_capture_id.is_not(None))  # type: ignore[union-attr]
            | (PaymentsOrder.failure_reason == "INSTRUMENT_DECLINED"),
        )
        .order_by(PaymentsOrder.id.desc())  # type: ignore[union-attr]
        .limit(limit)
    )
    if before_id is not None:
        stmt = stmt.where(PaymentsOrder.id < before_id)
    rows = (await db_session.execute(stmt)).all()
    codes = await _purchase_codes(db_session, [o.id for o, _, _ in rows])
    return [dict(_charge(o, u, f, codes.get(o.id)), _cursor=o.id) for o, u, f in rows]


async def overview(db_session: AsyncSession, org_id: int) -> dict:
    from src.services.payments.settings import is_development_mode

    await get_org_or_404(db_session, org_id)
    paid_filter = (
        PaymentsOrder.org_id == org_id,
        PaymentsOrder.status.in_(("paid", "accredited")),  # type: ignore[attr-defined]
    )
    flags = [_order_flags(o) for o in (await db_session.execute(
        select(PaymentsOrder).where(*paid_filter)
    )).scalars().all()]
    if not is_development_mode():
        # Sandbox sales on a production instance are tests: not revenue.
        environment = PaymentsOrder.raw["environment"].as_string()  # type: ignore[index]
        paid_filter = paid_filter + ((environment.is_(None)) | (environment != "sandbox"),)
    totals = (await db_session.execute(
        select(PaymentsOrder.currency, func.coalesce(func.sum(PaymentsOrder.amount), 0), func.count())
        .where(*paid_filter)
        .group_by(PaymentsOrder.currency)
    )).all()
    revenue_by_currency = {cur: money(Decimal(str(total))) for cur, total, _ in totals}
    paid_orders = sum(int(n) for _, _, n in totals)
    since = utcnow() - timedelta(days=30)
    recent_totals = (await db_session.execute(
        select(func.coalesce(func.sum(PaymentsOrder.amount), 0))
        .where(*paid_filter, PaymentsOrder.paid_at >= since)
    )).scalar()
    customers = (await db_session.execute(
        select(func.count(func.distinct(PaymentsEnrollment.user_id))).where(
            PaymentsEnrollment.org_id == org_id,
            PaymentsEnrollment.status.in_(("active", "completed")),  # type: ignore[attr-defined]
        )
    )).scalar()
    refunded = (await db_session.execute(
        select(func.count()).select_from(PaymentsOrder).where(
            PaymentsOrder.org_id == org_id, PaymentsOrder.status == "refunded"
        )
    )).scalar()
    charges = await _charges(db_session, org_id, limit=10)
    main_currency = "USD" if "USD" in revenue_by_currency or not revenue_by_currency else next(iter(revenue_by_currency))
    return {
        "mrr": 0,
        "arr": 0,
        "total_revenue": revenue_by_currency.get(main_currency, 0.0),
        "currency": main_currency,
        "revenue_by_currency": revenue_by_currency,
        "revenue_30d": money(Decimal(str(recent_totals or 0))),
        "paid_orders": paid_orders,
        "refunded_orders": int(refunded or 0),
        "duplicate_charges": sum(1 for f in flags if f["needs_refund"]),
        "test_orders": sum(1 for f in flags if f["test_mode"]),
        "active_subscribers": 0,
        "total_customers": int(customers or 0),
        "churn_30d": 0,
        "recent_charges": [{k: v for k, v in c.items() if k != "_cursor"} for c in charges],
    }


async def transactions(db_session: AsyncSession, org_id: int, limit: int = 25,
                       starting_after: Optional[str] = None) -> dict:
    await get_org_or_404(db_session, org_id)
    limit = max(1, min(int(limit or 25), 100))
    before_id = None
    if starting_after:
        if starting_after.isdigit():
            before_id = int(starting_after)
        else:
            row = (await db_session.execute(
                select(PaymentsOrder.id).where(
                    PaymentsOrder.order_uuid == starting_after, PaymentsOrder.org_id == org_id
                )
            )).first()
            if row is None:
                raise HTTPException(status_code=400, detail="Cursor no válido")
            before_id = row[0]
    charges = await _charges(db_session, org_id, limit=limit + 1, before_id=before_id)
    has_more = len(charges) > limit
    charges = charges[:limit]
    data = [{k: v for k, v in c.items() if k != "_cursor"} for c in charges]
    return {
        "data": data,
        "has_more": has_more,
        "next_cursor": data[-1]["id"] if has_more and data else None,
    }


async def my_enrollments(db_session: AsyncSession, request: Optional[Request], org_id: int, user) -> list[dict]:
    org = await get_org_or_404(db_session, org_id)
    pending_ids = await _pending_review_enrollment_ids(db_session, org_id, user.id)
    rows = (await db_session.execute(
        select(PaymentsEnrollment, PaymentsOffer)
        .join(PaymentsOffer, PaymentsOffer.id == PaymentsEnrollment.offer_id)  # type: ignore[arg-type]
        .where(PaymentsEnrollment.org_id == org_id, PaymentsEnrollment.user_id == user.id)
        .order_by(PaymentsEnrollment.creation_date.desc(), PaymentsEnrollment.id.desc())  # type: ignore[attr-defined]
    )).all()
    rows = [r for r in rows if r[0].status in VISIBLE_ENROLLMENT_STATUSES or r[0].id in pending_ids]
    offers = [offer for _, offer in rows]
    resource_map = await offer_resource_map(db_session, offers)
    all_uuids = {u for uuids in resource_map.values() for u in uuids}
    courses = await courses_by_uuid(db_session, all_uuids, org_id, published_only=True)
    orders = await _latest_paid_orders(db_session, [e.id for e, _ in rows])
    result = []
    for enrollment, offer in rows:
        resources = []
        for uuid in resource_map.get(offer.id, []):
            course = courses.get(uuid)
            if course is None:
                continue
            summary = resource_summary(course, org.org_uuid, request)
            resources.append({k: summary[k] for k in (
                "resource_uuid", "course_uuid", "name", "product_type", "thumbnail_url", "course_url"
            )})
        order = orders.get(enrollment.id)
        status = enrollment.status
        if status not in VISIBLE_ENROLLMENT_STATUSES and enrollment.id in pending_ids:
            status = "pending"
        result.append({
            "enrollment_id": enrollment.id,
            "enrollment_uuid": enrollment.enrollment_uuid,
            "offer_id": offer.id,
            "offer_uuid": offer.offer_uuid,
            "offer_name": offer.name,
            "offer_type": offer.offer_type,
            "billing_interval": offer.billing_interval,
            "amount": money(order.amount if order else offer.amount),
            "currency": order.currency if order else offer.currency,
            "status": status,
            "creation_date": iso(enrollment.creation_date),
            "paid_at": iso(order.paid_at) if order else None,
            "provider": order.provider if order else None,
            "resources": resources,
        })
    return result

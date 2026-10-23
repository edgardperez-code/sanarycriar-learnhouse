"""Sanar y Criar: idempotent fulfillment and revocation of paid orders.

``fulfill_order`` may be reached concurrently from the return page (capture),
the PayPal webhook and the reconciliation task. The order row is locked with
``SELECT ... FOR UPDATE`` and re-read from the database, so exactly one caller
performs the transition to ``paid``; everyone else sees it already done. The
side effects that follow (membership, trail, usergroups) are themselves
idempotent and re-checked on every call, so a crash half way is healed by the
next webhook or reconciliation pass.
"""

import asyncio
import html
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional
from uuid import uuid4

from fastapi import Request
from sqlalchemy.exc import IntegrityError
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from src.db.courses.courses import Course
from src.db.organization_config import OrganizationConfig
from src.db.organizations import Organization
from src.db.payments.payments import (
    PaymentsEnrollment,
    PaymentsGroupSync,
    PaymentsOffer,
    PaymentsOrder,
)
from src.db.trail_runs import TrailRun
from src.db.trails import Trail
from src.db.user_organizations import UserOrganization
from src.db.usergroup_user import UserGroupUser
from src.db.users import User
from src.services.payments.access import ACCESS_STATUSES, bump_access_version
from src.services.payments.common import course_url, utcnow
from src.services.payments.providers.base import PaymentResult

logger = logging.getLogger(__name__)

PAID_STATUSES = ("paid", "accredited")
OPEN_STATUSES = ("created", "approved", "pending")
USER_ROLE_ID = 4


@dataclass
class FulfillOutcome:
    newly_paid: bool = False
    new_course_ids: list[int] = field(default_factory=list)
    # order_uuid of the order that already granted this enrollment when this
    # one was a second charge for the same purchase (to be refunded).
    duplicate_of: Optional[str] = None


async def _locked_order(db_session: AsyncSession, order_id: int) -> Optional[PaymentsOrder]:
    return (await db_session.execute(
        select(PaymentsOrder)
        .where(PaymentsOrder.id == order_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )).scalars().first()


async def _locked_enrollment(db_session: AsyncSession, enrollment_id: int) -> Optional[PaymentsEnrollment]:
    return (await db_session.execute(
        select(PaymentsEnrollment)
        .where(PaymentsEnrollment.id == enrollment_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )).scalars().first()


def _merge_raw(order: PaymentsOrder, raw: dict, key: str) -> None:
    if not raw:
        return
    merged = dict(order.raw or {})
    merged[key] = raw
    order.raw = merged


async def ensure_membership(db_session: AsyncSession, user_id: int, org_id: int) -> bool:
    """Make the buyer an org member (user role). True when a row was added."""
    existing = (await db_session.execute(
        select(UserOrganization.id).where(
            UserOrganization.user_id == user_id, UserOrganization.org_id == org_id
        )
    )).first()
    if existing is not None:
        return False
    now = str(datetime.now())
    db_session.add(UserOrganization(
        user_id=user_id, org_id=org_id, role_id=USER_ROLE_ID, creation_date=now, update_date=now,
    ))
    return True


def _invalidate_user_session_cache(user_id: int) -> None:
    try:
        from src.routers.users import _invalidate_session_cache

        _invalidate_session_cache(user_id)
    except Exception:
        logger.debug("Session cache invalidation failed for user %s", user_id, exc_info=True)


async def _synced_usergroup_ids(db_session: AsyncSession, offer: PaymentsOffer) -> list[int]:
    if not offer.payments_group_id:
        return []
    rows = (await db_session.execute(
        select(PaymentsGroupSync.usergroup_id).where(
            PaymentsGroupSync.payments_group_id == offer.payments_group_id
        )
    )).scalars().all()
    return list(rows)


async def _ensure_trail(db_session: AsyncSession, org_id: int, user_id: int) -> Trail:
    """The buyer's Trail in the org, created without committing.

    Same row ``check_trail_presence`` would create, but inside our
    transaction (the order row lock serializes concurrent fulfillments, and
    a Trail has no unique constraint to catch a duplicate).
    """
    trail = (await db_session.execute(
        select(Trail).where(Trail.org_id == org_id, Trail.user_id == user_id).order_by(Trail.id)
    )).scalars().first()
    if trail is not None:
        return trail
    now = str(datetime.now())
    trail = Trail(
        org_id=org_id, user_id=user_id, trail_uuid=f"trail_{uuid4()}", creation_date=now, update_date=now,
    )
    db_session.add(trail)
    await db_session.flush()
    return trail


async def _apply_entitlements(db_session: AsyncSession, order: PaymentsOrder) -> tuple[bool, list[Course]]:
    """One transaction under the order row lock. Returns (membership added,
    courses whose TrailRun was created)."""
    from src.services.payments.offers import offer_courses

    locked = await _locked_order(db_session, order.id)
    if locked is None:
        await db_session.commit()
        return False, []
    added_membership = await ensure_membership(db_session, locked.user_id, locked.org_id)

    offer = await db_session.get(PaymentsOffer, locked.offer_id)
    if offer is None:
        await db_session.commit()
        return added_membership, []

    # Usergroups synced to the offer's payments group.
    now = str(datetime.now())
    for usergroup_id in await _synced_usergroup_ids(db_session, offer):
        exists = (await db_session.execute(
            select(UserGroupUser.id).where(
                UserGroupUser.usergroup_id == usergroup_id,
                UserGroupUser.user_id == locked.user_id,
            )
        )).first()
        if exists is None:
            db_session.add(UserGroupUser(
                usergroup_id=usergroup_id, user_id=locked.user_id, org_id=locked.org_id,
                creation_date=now, update_date=now,
            ))

    # Trail + one TrailRun per course, so "Mis cursos" lists the purchase.
    created: list[Course] = []
    courses = await offer_courses(db_session, offer, published_only=True)
    if courses:
        trail = await _ensure_trail(db_session, locked.org_id, locked.user_id)
        existing = set((await db_session.execute(
            select(TrailRun.course_id).where(
                TrailRun.user_id == locked.user_id,
                TrailRun.course_id.in_([c.id for c in courses]),  # type: ignore[attr-defined]
            )
        )).scalars().all())
        for course in courses:
            if course.id in existing:
                continue
            db_session.add(TrailRun(
                trail_id=trail.id,
                course_id=course.id,
                org_id=locked.org_id,
                user_id=locked.user_id,
                creation_date=now,
                update_date=now,
            ))
            created.append(course)
    await db_session.commit()
    return added_membership, created


async def ensure_entitlements(db_session: AsyncSession, order: PaymentsOrder,
                              request: Optional[Request] = None) -> list[Course]:
    """Membership, Trail, TrailRun per course and usergroup syncs.

    Idempotent and serialized per order (row lock). Returns the courses whose
    TrailRun was created by this call. Failures are logged, never raised:
    access itself comes from the enrollment, which is already committed.
    """
    for attempt in range(2):
        try:
            added_membership, created = await _apply_entitlements(db_session, order)
        except IntegrityError:
            # A concurrent "start course" created a TrailRun first: retry once.
            await db_session.rollback()
            if attempt == 0:
                continue
            logger.exception("Could not complete entitlements for order %s", order.order_uuid)
            return []
        except Exception:
            logger.exception("Could not complete entitlements for order %s", order.order_uuid)
            try:
                await db_session.rollback()
            except Exception:
                pass
            return []
        if added_membership:
            _invalidate_user_session_cache(order.user_id)
        return created
    return []


async def _notify_enrolled(org_id: int, user: User, courses: list[Course]) -> None:
    from src.services.analytics import events as analytics_events
    from src.services.webhooks.dispatch import dispatch_webhooks

    for course in courses:
        try:
            await dispatch_webhooks(
                event_name=analytics_events.COURSE_ENROLLED,
                org_id=org_id,
                data={
                    "user": {"user_uuid": user.user_uuid, "email": user.email, "username": user.username},
                    "course": {"course_uuid": course.course_uuid, "name": course.name},
                },
            )
        except Exception:
            logger.warning("course_enrolled webhook failed for %s", course.course_uuid, exc_info=True)


def _purchase_email_html(*, first_name: str, offer_name: str, courses: list[tuple[str, str, str]],
                         cta_url: str, branding) -> tuple[str, str]:
    from src.services.users.emails import (
        STYLES,
        _brand_logo_html,
        _button_style,
        _email_layout,
    )

    safe_name = html.escape(first_name or "")
    safe_offer = html.escape(offer_name)
    greeting = f"¡Gracias por tu compra, {safe_name}!" if safe_name else "¡Gracias por tu compra!"
    items = "".join(
        f'<li style="margin: 0 0 8px 0;"><a href="{html.escape(url)}" '
        f'style="color: inherit; font-weight: 700;">{html.escape(name)}</a>'
        f'{" (ebook)" if kind == "ebook" else ""}</li>'
        for name, url, kind in courses
    )
    body = f"""
        <h1 style="{STYLES['h1']}">{greeting}</h1>
        <p style="{STYLES['p']}">
            Tu pago de <strong>{safe_offer}</strong> se confirmó y ya tienes acceso.
            Puedes entrar cuando quieras, a tu ritmo.
        </p>
        <ul style="{STYLES['p']} text-align: left; padding-left: 20px;">{items}</ul>
        <a href="{html.escape(cta_url)}" style="{_button_style(branding.brand_color)}">
            Empezar ahora
        </a>
        <p style="{STYLES['link_text']}">{html.escape(cta_url)}</p>
    """
    subject = f"Ya tienes acceso a {offer_name}"
    document = _email_layout(
        title=greeting,
        body_content=body,
        footer_note="Recibes este correo porque realizaste una compra con esta cuenta.",
        logo_html=_brand_logo_html(branding.logo_url, branding.org_name or "Sanar y Criar"),
        preheader=f"Tu acceso a {offer_name} está listo.",
        powered_by=branding.powered_by,
        lang="es",
    )
    return subject, document


async def send_purchase_email(db_session: AsyncSession, order: PaymentsOrder,
                              request: Optional[Request] = None) -> None:
    """Spanish confirmation with links to what was bought. Best effort."""
    try:
        from src.services.email.branding import resolve_org_email_branding
        from src.services.email.utils import send_email
        from src.services.payments.offers import offer_courses

        user = await db_session.get(User, order.user_id)
        offer = await db_session.get(PaymentsOffer, order.offer_id)
        org = await db_session.get(Organization, order.org_id)
        if user is None or offer is None or org is None or not user.email:
            return
        org_config = (await db_session.execute(
            select(OrganizationConfig).where(OrganizationConfig.org_id == org.id)
        )).scalars().first()
        branding = resolve_org_email_branding(org, org_config, request)
        from src.services.payments.common import platform_base_url, product_type_of

        courses = await offer_courses(db_session, offer, published_only=True)
        links = [(c.name, course_url(c, request), product_type_of(c)) for c in courses]
        cta = links[0][1] if links else (platform_base_url(request) or "/")
        subject, document = _purchase_email_html(
            first_name=user.first_name or user.username,
            offer_name=offer.name,
            courses=links,
            cta_url=cta,
            branding=branding,
        )
        await asyncio.to_thread(
            send_email,
            to=user.email,
            subject=subject,
            body=document,
            sender_name=branding.sender_name or None,
        )
    except Exception:
        logger.warning("Purchase confirmation email failed for order %s", order.order_uuid, exc_info=True)


async def fulfill_order(db_session: AsyncSession, order_id: int, result: Optional[PaymentResult] = None,
                        *, request: Optional[Request] = None) -> FulfillOutcome:
    """Mark the order paid and grant access. Safe to call any number of times."""
    outcome = FulfillOutcome()
    order = await _locked_order(db_session, order_id)
    if order is None:
        return outcome
    if order.status == "refunded":
        # Never resurrect a refunded purchase from a late or replayed event.
        await db_session.commit()
        logger.warning("Ignoring fulfillment of refunded order %s", order.order_uuid)
        return outcome

    if order.status not in PAID_STATUSES:
        order.status = "paid"
        order.paid_at = utcnow()
        order.failure_reason = None
        if result is not None:
            order.provider_capture_id = result.provider_capture_id or order.provider_capture_id
            order.charged_amount = result.charged_amount if result.charged_amount is not None else order.amount
            order.charged_currency = result.charged_currency or order.currency
            _merge_raw(order, result.raw, "capture")
        order.update_date = utcnow()
        db_session.add(order)

        enrollment = await _locked_enrollment(db_session, order.enrollment_id)
        if enrollment is not None:
            granting = await _granting_paid_order(db_session, enrollment, order)
            if granting is not None:
                # The money moved, so the order is paid; but the purchase was
                # already granted by another paid order. Keep that one as the
                # granting order and flag this charge for a refund.
                raw = dict(order.raw or {})
                raw["duplicate_of"] = granting.order_uuid
                order.raw = raw
                outcome.duplicate_of = granting.order_uuid
                logger.error(
                    "Order %s is a duplicate charge of %s (enrollment %s): refund it",
                    order.order_uuid, granting.order_uuid, enrollment.id,
                )
            else:
                _grant(enrollment, order)
                db_session.add(enrollment)
        outcome.newly_paid = True

    await ensure_membership(db_session, order.user_id, order.org_id)
    await db_session.commit()

    if outcome.newly_paid:
        bump_access_version()
        _invalidate_user_session_cache(order.user_id)
        logger.info("Order %s paid (%s %s)", order.order_uuid, order.amount, order.currency)

    created = await ensure_entitlements(db_session, order, request)
    outcome.new_course_ids = [c.id for c in created]

    if outcome.newly_paid and outcome.duplicate_of is None:
        user = await db_session.get(User, order.user_id)
        if user is not None and created:
            await _notify_enrolled(order.org_id, user, created)
        await send_purchase_email(db_session, order, request)
    return outcome


def _grant(enrollment: PaymentsEnrollment, order: PaymentsOrder) -> None:
    """Make ``order`` the order that grants ``enrollment``."""
    enrollment.status = "active"
    data = dict(enrollment.provider_specific_data or {})
    data.update({
        "order_uuid": order.order_uuid,
        "provider": order.provider,
        "provider_order_id": order.provider_order_id,
        "provider_capture_id": order.provider_capture_id,
        "paid_at": order.paid_at.isoformat() if order.paid_at else None,
        "environment": (order.raw or {}).get("environment"),
    })
    for key in ("refunded_at", "refund_reason"):
        data.pop(key, None)
    enrollment.provider_specific_data = data
    enrollment.update_date = utcnow()


async def _granting_paid_order(db_session: AsyncSession, enrollment: PaymentsEnrollment,
                               order: PaymentsOrder) -> Optional[PaymentsOrder]:
    """The other paid order that already grants ``enrollment``, if any."""
    if enrollment.status not in ACCESS_STATUSES:
        return None
    granting_uuid = (enrollment.provider_specific_data or {}).get("order_uuid")
    if not granting_uuid or granting_uuid == order.order_uuid:
        return None
    return (await db_session.execute(
        select(PaymentsOrder).where(
            PaymentsOrder.order_uuid == granting_uuid,
            PaymentsOrder.status.in_(PAID_STATUSES),  # type: ignore[attr-defined]
        )
    )).scalars().first()


async def _paid_sibling(db_session: AsyncSession, order: PaymentsOrder) -> Optional[PaymentsOrder]:
    """Another paid order on the same enrollment (latest payment first)."""
    return (await db_session.execute(
        select(PaymentsOrder).where(
            PaymentsOrder.enrollment_id == order.enrollment_id,
            PaymentsOrder.id != order.id,
            PaymentsOrder.status.in_(PAID_STATUSES),  # type: ignore[attr-defined]
        ).order_by(PaymentsOrder.paid_at.desc(), PaymentsOrder.id.desc())  # type: ignore[union-attr]
    )).scalars().first()


async def apply_result(db_session: AsyncSession, order_id: int, result: PaymentResult) -> Optional[PaymentsOrder]:
    """Record a non-paid provider outcome (pending, failed, retry, expired...)."""
    order = await _locked_order(db_session, order_id)
    if order is None:
        return None
    if order.status in PAID_STATUSES or order.status == "refunded":
        await db_session.commit()
        return order
    status = result.status
    if status == "pending":
        order.status = "pending"
        order.provider_capture_id = result.provider_capture_id or order.provider_capture_id
        order.failure_reason = result.reason
    elif status in ("failed", "retry"):
        order.status = "failed"
        order.failure_reason = (result.reason or ("INSTRUMENT_DECLINED" if status == "retry" else "FAILED"))[:255]
        order.provider_capture_id = result.provider_capture_id or order.provider_capture_id
    elif status == "expired":
        order.status = "expired"
        order.failure_reason = result.reason
    elif status == "approved" and order.status == "created":
        order.status = "approved"
    else:
        await db_session.commit()
        return order
    _merge_raw(order, result.raw, "last_status")
    order.update_date = utcnow()
    db_session.add(order)
    if order.status in ("failed", "expired"):
        enrollment = await _locked_enrollment(db_session, order.enrollment_id)
        if enrollment is not None and enrollment.status == "pending":
            enrollment.status = "failed" if order.status == "failed" else "cancelled"
            enrollment.update_date = utcnow()
            db_session.add(enrollment)
    await db_session.commit()
    return order


async def cancel_order(db_session: AsyncSession, order_id: int, reason: str = "cancelled_by_user") -> Optional[PaymentsOrder]:
    order = await _locked_order(db_session, order_id)
    if order is None:
        return None
    if order.status in ("created", "approved"):
        order.status = "cancelled"
        order.failure_reason = reason
        order.update_date = utcnow()
        db_session.add(order)
        enrollment = await _locked_enrollment(db_session, order.enrollment_id)
        if enrollment is not None and enrollment.status == "pending":
            enrollment.status = "cancelled"
            enrollment.update_date = utcnow()
            db_session.add(enrollment)
    await db_session.commit()
    return order


async def revoke_order(db_session: AsyncSession, order_id: int, reason: str = "refunded") -> bool:
    """Full refund or reversal: the purchase stops granting access.

    TrailRun and progress are kept (the paywall blocks the content), so a
    re-purchase picks up where the learner left off.
    """
    order = await _locked_order(db_session, order_id)
    if order is None or order.status == "refunded":
        await db_session.commit()
        return False
    order.status = "refunded"
    order.failure_reason = reason[:255]
    order.update_date = utcnow()
    db_session.add(order)

    enrollment = await _locked_enrollment(db_session, order.enrollment_id)
    if enrollment is not None:
        data = dict(enrollment.provider_specific_data or {})
        # Only the order that granted the enrollment can take it away, and
        # only when no other paid order (a duplicate charge) still covers it.
        if data.get("order_uuid") in (None, order.order_uuid) and enrollment.status in ACCESS_STATUSES:
            sibling = await _paid_sibling(db_session, order)
            if sibling is not None:
                _grant(enrollment, sibling)
                sibling_raw = dict(sibling.raw or {})
                # It is now the purchase itself, not a charge to refund.
                if sibling_raw.pop("duplicate_of", None) is not None:
                    sibling_raw["granting_after_refund_of"] = order.order_uuid
                    sibling.raw = sibling_raw
                    db_session.add(sibling)
                logger.warning(
                    "Order %s refunded; enrollment %s stays active through order %s",
                    order.order_uuid, enrollment.id, sibling.order_uuid,
                )
            else:
                enrollment.status = "refunded"
                data["refunded_at"] = utcnow().isoformat()
                data["refund_reason"] = reason
                enrollment.provider_specific_data = data
                enrollment.update_date = utcnow()
            db_session.add(enrollment)
    await db_session.commit()

    # Leave the synced usergroups unless another live purchase still maps there.
    offer = await db_session.get(PaymentsOffer, order.offer_id)
    if offer is not None:
        usergroup_ids = await _synced_usergroup_ids(db_session, offer)
        if usergroup_ids:
            still_granted = set((await db_session.execute(
                select(PaymentsGroupSync.usergroup_id)
                .join(PaymentsOffer, PaymentsOffer.payments_group_id == PaymentsGroupSync.payments_group_id)  # type: ignore[arg-type]
                .join(PaymentsEnrollment, PaymentsEnrollment.offer_id == PaymentsOffer.id)  # type: ignore[arg-type]
                .where(
                    PaymentsEnrollment.user_id == order.user_id,
                    PaymentsEnrollment.status.in_(ACCESS_STATUSES),  # type: ignore[attr-defined]
                )
            )).scalars().all())
            for usergroup_id in usergroup_ids:
                if usergroup_id in still_granted:
                    continue
                rows = (await db_session.execute(
                    select(UserGroupUser).where(
                        UserGroupUser.usergroup_id == usergroup_id,
                        UserGroupUser.user_id == order.user_id,
                    )
                )).scalars().all()
                for row in rows:
                    await db_session.delete(row)
            await db_session.commit()

    bump_access_version()
    logger.info("Order %s revoked (%s)", order.order_uuid, reason)
    return True

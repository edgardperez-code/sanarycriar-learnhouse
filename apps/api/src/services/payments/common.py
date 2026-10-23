"""Sanar y Criar: shared helpers for the payments services."""

from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Iterable, Optional

from fastapi import HTTPException, Request
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from src.db.courses.activities import Activity
from src.db.courses.chapter_activities import ChapterActivity
from src.db.courses.course_chapters import CourseChapter
from src.db.courses.courses import Course
from src.db.organizations import Organization
from src.db.payments.payments import (
    PaymentsGroupResource,
    PaymentsOffer,
    PaymentsOfferResource,
)

PRODUCT_TYPES = ("course", "ebook")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def as_utc(value: Optional[datetime]) -> Optional[datetime]:
    """SQLite hands back naive datetimes; treat them as UTC."""
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def iso(value: Optional[datetime]) -> Optional[str]:
    value = as_utc(value)
    return value.isoformat() if value else None


def money(value) -> Optional[float]:
    """Decimal amount as a JSON number (2 decimals)."""
    if value is None:
        return None
    return float(Decimal(str(value)).quantize(Decimal("0.01")))


def parse_amount(value) -> Decimal:
    """Validate a price: a number >= 1 with at most two decimals."""
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        raise HTTPException(status_code=400, detail="El monto no es válido")
    if not amount.is_finite():
        raise HTTPException(status_code=400, detail="El monto no es válido")
    if amount < 1:
        raise HTTPException(status_code=400, detail="El monto mínimo es 1")
    if amount != amount.quantize(Decimal("0.01")):
        raise HTTPException(status_code=400, detail="El monto admite como máximo dos decimales")
    if amount > Decimal("99999999.99"):
        raise HTTPException(status_code=400, detail="El monto es demasiado alto")
    return amount.quantize(Decimal("0.01"))


def strip_course_prefix(course_uuid: str) -> str:
    return (course_uuid or "").removeprefix("course_")


def product_type_of(course: Course) -> str:
    meta = course.extra_metadata if isinstance(course.extra_metadata, dict) else {}
    value = str(meta.get("product_type") or "course").lower()
    return value if value in PRODUCT_TYPES else "course"


async def get_org_or_404(db_session: AsyncSession, org_id: int) -> Organization:
    org = await db_session.get(Organization, org_id)
    if org is None:
        raise HTTPException(status_code=404, detail="Organization not found")
    return org


def media_base_url(request: Optional[Request]) -> str:
    from src.services.email.utils import get_media_base_url

    return get_media_base_url(request).rstrip("/")


def platform_base_url(request: Optional[Request]) -> str:
    from src.services.email.utils import get_platform_base_url

    return (get_platform_base_url(request) or "").rstrip("/")


def thumbnail_url(course: Course, org_uuid: str, request: Optional[Request]) -> Optional[str]:
    if not course.thumbnail_image:
        return None
    base = media_base_url(request)
    path = f"/content/orgs/{org_uuid}/courses/{course.course_uuid}/thumbnails/{course.thumbnail_image}"
    return f"{base}{path}" if base else path


def course_url(course: Course, request: Optional[Request]) -> str:
    base = platform_base_url(request)
    return f"{base}/course/{strip_course_prefix(course.course_uuid)}"


async def offer_resource_map(
    db_session: AsyncSession, offers: Iterable[PaymentsOffer]
) -> dict[int, list[str]]:
    """offer_id -> resource uuids (direct first, then via its group), deduped."""
    offers = list(offers)
    result: dict[int, list[str]] = {o.id: [] for o in offers if o.id is not None}
    if not result:
        return result
    direct_rows = (await db_session.execute(
        select(PaymentsOfferResource.offer_id, PaymentsOfferResource.resource_uuid)
        .where(PaymentsOfferResource.offer_id.in_(list(result.keys())))  # type: ignore[attr-defined]
        .order_by(PaymentsOfferResource.id)
    )).all()
    for offer_id, uuid in direct_rows:
        if uuid not in result[offer_id]:
            result[offer_id].append(uuid)

    group_ids = {o.payments_group_id for o in offers if o.payments_group_id}
    if group_ids:
        group_rows = (await db_session.execute(
            select(PaymentsGroupResource.payments_group_id, PaymentsGroupResource.resource_uuid)
            .where(PaymentsGroupResource.payments_group_id.in_(list(group_ids)))  # type: ignore[attr-defined]
            .order_by(PaymentsGroupResource.id)
        )).all()
        by_group: dict[int, list[str]] = {}
        for group_id, uuid in group_rows:
            by_group.setdefault(group_id, []).append(uuid)
        for offer in offers:
            for uuid in by_group.get(offer.payments_group_id or -1, []):
                if uuid not in result[offer.id]:
                    result[offer.id].append(uuid)
    return result


async def courses_by_uuid(
    db_session: AsyncSession, uuids: Iterable[str], org_id: int, *, published_only: bool = False
) -> dict[str, Course]:
    uuids = list({u for u in uuids if u})
    if not uuids:
        return {}
    stmt = select(Course).where(
        Course.course_uuid.in_(uuids),  # type: ignore[attr-defined]
        Course.org_id == org_id,
    )
    if published_only:
        stmt = stmt.where(Course.published == True)  # noqa: E712
    courses = (await db_session.execute(stmt)).scalars().all()
    return {c.course_uuid: c for c in courses}


async def first_activity_uuids(db_session: AsyncSession, course_ids: Iterable[int]) -> dict[int, str]:
    """course_id -> uuid of the first published activity (chapter order, then activity order)."""
    course_ids = [c for c in set(course_ids) if c]
    if not course_ids:
        return {}
    rows = (await db_session.execute(
        select(Activity.course_id, Activity.activity_uuid)
        .join(ChapterActivity, ChapterActivity.activity_id == Activity.id)  # type: ignore[arg-type]
        .join(
            CourseChapter,
            (CourseChapter.chapter_id == ChapterActivity.chapter_id)  # type: ignore[arg-type]
            & (CourseChapter.course_id == Activity.course_id),
        )
        .where(Activity.course_id.in_(course_ids), Activity.published == True)  # type: ignore[attr-defined]  # noqa: E712
        .order_by(Activity.course_id, CourseChapter.order, ChapterActivity.order, Activity.id)
    )).all()
    result: dict[int, str] = {}
    for course_id, activity_uuid in rows:
        result.setdefault(course_id, activity_uuid)
    return result


def resource_summary(course: Course, org_uuid: str, request: Optional[Request]) -> dict:
    return {
        "resource_uuid": course.course_uuid,
        "course_uuid": course.course_uuid,
        "name": course.name,
        "product_type": product_type_of(course),
        "thumbnail_url": thumbnail_url(course, org_uuid, request),
        "course_url": course_url(course, request),
    }


async def get_offer_by_ref(
    db_session: AsyncSession, org_id: int, ref: str, *, include_archived: bool = False
) -> PaymentsOffer:
    """Resolve an offer by numeric id or by ``offer_uuid`` (404 otherwise)."""
    ref = (ref or "").strip()
    stmt = select(PaymentsOffer).where(PaymentsOffer.org_id == org_id)
    if ref.isdigit():
        stmt = stmt.where(PaymentsOffer.id == int(ref))
    else:
        stmt = stmt.where(PaymentsOffer.offer_uuid == ref)
    offer = (await db_session.execute(stmt)).scalars().first()
    if offer is None or (offer.archived and not include_archived):
        raise HTTPException(status_code=404, detail="Offer not found")
    return offer

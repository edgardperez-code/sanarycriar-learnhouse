"""Sanar y Criar: who may consume a paid course.

A course is *for sale* when at least one non-archived offer covers it, either
directly (``sc_pay_offer_resource``) or through its payments group
(``sc_pay_group_resource``). A course with no offer is free. On a course for
sale, access is granted to org admins/maintainers, the course's active
authors, and users with an ``active``/``completed`` enrollment in ANY offer
covering it, archived offers included, so past buyers keep what they bought.

``check_activity_paid_access`` is what the core paywall hook
(``src.core.ee_hooks.check_ee_activity_paid_access``) calls on every activity
read, chapter tree, media stream and file request, so it is memoized on
``request.state`` and briefly cached in Redis.
"""

import logging
import os
from dataclasses import asdict, dataclass
from typing import Literal, Optional

from fastapi import HTTPException, Request
from sqlalchemy import func, or_
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from src.core.redis import get_redis_client
from src.db.courses.activities import Activity
from src.db.courses.courses import Course
from src.db.payments.payments import (
    PaymentsEnrollment,
    PaymentsGroupResource,
    PaymentsOffer,
    PaymentsOfferResource,
)
from src.db.resource_authors import (
    ResourceAuthor,
    ResourceAuthorshipEnum,
    ResourceAuthorshipStatusEnum,
)
from src.db.users import AnonymousUser, APITokenUser, SuperadminAPITokenUser

logger = logging.getLogger(__name__)

ACCESS_STATUSES = ("active", "completed")
AUTHOR_ROLES = (
    ResourceAuthorshipEnum.CREATOR,
    ResourceAuthorshipEnum.CONTRIBUTOR,
    ResourceAuthorshipEnum.MAINTAINER,
)

_CACHE_TTL_SECONDS = 60
_VERSION_KEY = "sc_pay:access_version"
_MEMO_ATTR = "_sc_pay_access_memo"

AccessReason = Literal["free", "purchased", "admin", "author", "anonymous", "none"]


@dataclass
class CourseAccess:
    for_sale: bool
    has_access: bool
    reason: AccessReason
    offers_count: int

    def as_dict(self) -> dict:
        return asdict(self)


def normalize_course_uuid(value: Optional[str]) -> str:
    """Accept a course uuid with or without its ``course_`` prefix."""
    value = (value or "").strip()
    if not value:
        return ""
    return value if value.startswith("course_") else f"course_{value}"


def covering_offer_ids_query(course_uuid: str, *, org_id: Optional[int] = None,
                             include_archived: bool = False):
    """SELECT of the offer ids covering ``course_uuid`` (direct or via group)."""
    direct = select(PaymentsOfferResource.offer_id).where(
        PaymentsOfferResource.resource_uuid == course_uuid
    )
    via_group = select(PaymentsGroupResource.payments_group_id).where(
        PaymentsGroupResource.resource_uuid == course_uuid
    )
    stmt = select(PaymentsOffer.id).where(
        or_(
            PaymentsOffer.id.in_(direct),  # type: ignore[union-attr]
            PaymentsOffer.payments_group_id.in_(via_group),  # type: ignore[union-attr]
        )
    )
    if org_id is not None:
        stmt = stmt.where(PaymentsOffer.org_id == org_id)
    if not include_archived:
        stmt = stmt.where(PaymentsOffer.archived == False)  # noqa: E712
    return stmt


async def count_active_offers(db_session: AsyncSession, course_uuid: str, org_id: int) -> int:
    sub = covering_offer_ids_query(course_uuid, org_id=org_id).subquery()
    count = (await db_session.execute(select(func.count()).select_from(sub))).scalar()
    return int(count or 0)


async def has_paid_enrollment(db_session: AsyncSession, user_id: int, course_uuid: str,
                              org_id: Optional[int] = None) -> bool:
    if not user_id:
        return False
    offers = covering_offer_ids_query(course_uuid, org_id=org_id, include_archived=True)
    row = (await db_session.execute(
        select(PaymentsEnrollment.id).where(
            PaymentsEnrollment.user_id == user_id,
            PaymentsEnrollment.status.in_(ACCESS_STATUSES),  # type: ignore[attr-defined]
            PaymentsEnrollment.offer_id.in_(offers),  # type: ignore[attr-defined]
        ).limit(1)
    )).first()
    return row is not None


async def is_active_course_author(db_session: AsyncSession, user_id: int, course_uuid: str) -> bool:
    if not user_id:
        return False
    row = (await db_session.execute(
        select(ResourceAuthor.id).where(
            ResourceAuthor.resource_uuid == course_uuid,
            ResourceAuthor.user_id == user_id,
            ResourceAuthor.authorship_status == ResourceAuthorshipStatusEnum.ACTIVE,
            ResourceAuthor.authorship.in_(AUTHOR_ROLES),  # type: ignore[attr-defined]
        ).limit(1)
    )).first()
    return row is not None


async def get_course_access(db_session: AsyncSession, user, course: Course) -> CourseAccess:
    """Full access decision for ``user`` on ``course`` (uncached)."""
    offers_count = await count_active_offers(db_session, course.course_uuid, course.org_id)
    if offers_count == 0:
        return CourseAccess(False, True, "free", 0)
    if user is None or isinstance(user, AnonymousUser):
        return CourseAccess(True, False, "anonymous", offers_count)
    if isinstance(user, APITokenUser):
        # Org API tokens are neither a buyer nor an admin session: they can be
        # minted with narrow rights by any member allowed to create tokens
        # (and handed to integrations), so they never unlock paid content.
        return CourseAccess(True, False, "none", offers_count)
    if isinstance(user, SuperadminAPITokenUser):
        return CourseAccess(True, True, "admin", offers_count)

    from src.security.org_auth import is_org_admin

    user_id = int(getattr(user, "id", 0) or 0)
    if user_id and await is_org_admin(user_id, course.org_id, db_session):
        return CourseAccess(True, True, "admin", offers_count)
    if await is_active_course_author(db_session, user_id, course.course_uuid):
        return CourseAccess(True, True, "author", offers_count)
    if await has_paid_enrollment(db_session, user_id, course.course_uuid, course.org_id):
        return CourseAccess(True, True, "purchased", offers_count)
    return CourseAccess(True, False, "none", offers_count)


# --------------------------------------------------------------------- cache


def _cache_client():
    # Never share an access cache with a test run: test databases reuse small
    # ids (course 1, user 2) that would collide with real rows.
    if os.getenv("TESTING", "false").lower() == "true":
        return None
    return get_redis_client()


def _access_version(client) -> str:
    try:
        value = client.get(_VERSION_KEY)
    except Exception:
        return "0"
    if value is None:
        return "0"
    return value.decode() if isinstance(value, bytes) else str(value)


def bump_access_version() -> None:
    """Invalidate every cached access decision (offer, group or purchase change)."""
    client = _cache_client()
    if client is None:
        return
    try:
        client.incr(_VERSION_KEY)
    except Exception:
        logger.debug("Could not bump payments access version", exc_info=True)


def _principal_key(user) -> str:
    if user is None or isinstance(user, AnonymousUser):
        return "anon"
    if isinstance(user, APITokenUser):
        return f"token-org-{user.org_id}"
    if isinstance(user, SuperadminAPITokenUser):
        return "satoken"
    return f"u{int(getattr(user, 'id', 0) or 0)}"


def _memo(request: Optional[Request]) -> Optional[dict]:
    if request is None:
        return None
    state = getattr(request, "state", None)
    if state is None:
        return None
    memo = getattr(state, _MEMO_ATTR, None)
    if memo is None:
        memo = {}
        try:
            setattr(state, _MEMO_ATTR, memo)
        except Exception:
            return None
    return memo


async def has_course_access(request: Optional[Request], db_session: AsyncSession, user,
                            course: Course) -> bool:
    memo = _memo(request)
    principal = _principal_key(user)
    memo_key = ("course", course.id, principal)
    if memo is not None and memo_key in memo:
        return memo[memo_key]

    client = _cache_client()
    redis_key = None
    if client is not None:
        try:
            redis_key = f"sc_pay:access:v{_access_version(client)}:{course.id}:{principal}"
            cached = client.get(redis_key)
            if cached is not None:
                value = (cached.decode() if isinstance(cached, bytes) else str(cached)) == "1"
                if memo is not None:
                    memo[memo_key] = value
                return value
        except Exception:
            redis_key = None
            logger.debug("Payments access cache read failed", exc_info=True)

    value = (await get_course_access(db_session, user, course)).has_access

    if memo is not None:
        memo[memo_key] = value
    if client is not None and redis_key is not None:
        try:
            client.setex(redis_key, _CACHE_TTL_SECONDS, "1" if value else "0")
        except Exception:
            logger.debug("Payments access cache write failed", exc_info=True)
    return value


async def check_activity_paid_access(request: Optional[Request], activity_id: int, user,
                                     db_session: AsyncSession) -> bool:
    """Paywall decision for one activity (resolved to its course)."""
    memo = _memo(request)
    course_key = ("activity", activity_id)
    course = memo.get(course_key) if memo is not None else None
    if course is None:
        course = (await db_session.execute(
            select(Course).join(Activity, Activity.course_id == Course.id)  # type: ignore[arg-type]
            .where(Activity.id == activity_id)
        )).scalars().first()
        if course is None:
            # No course: nothing is for sale; the callers already 404.
            return True
        if memo is not None:
            memo[course_key] = course
    return await has_course_access(request, db_session, user, course)


async def check_enrollment_access(element_uuid: str, user_id: int, db_session: AsyncSession) -> bool:
    """True when ``user_id`` bought something covering ``element_uuid``."""
    if not element_uuid or not element_uuid.startswith("course_"):
        return False
    return await has_paid_enrollment(db_session, user_id, element_uuid)


async def require_paid_access_for_course(request: Optional[Request], user, course: Course,
                                         db_session: AsyncSession) -> None:
    """402 ``{code: PAYMENT_REQUIRED}`` when the course is for sale and ``user``
    has no access (used to gate "start course")."""
    if not await has_course_access(request, db_session, user, course):
        raise HTTPException(status_code=402, detail={"code": "PAYMENT_REQUIRED"})

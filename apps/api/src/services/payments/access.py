"""Sanar y Criar: who may consume a paid course.

A course is *for sale* when at least one non-archived offer covers it, either
directly (``sc_pay_offer_resource``) or through its payments group
(``sc_pay_group_resource``). A course with no offer is free. On a course for
sale, access is granted to org admins/maintainers, the course's active
authors, and users with an ``active``/``completed`` enrollment in ANY offer
covering it, archived offers included, so past buyers keep what they bought.

A free course is free but not anonymous: it needs a signed-in account whose
email is verified (reason ``login_required`` / ``verify_email`` otherwise).
Admins and authors pass. ``SC_EMAIL_VERIFICATION=0`` opens it to everyone.

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
from src.db.users import AnonymousUser, APITokenUser, SuperadminAPITokenUser, User
from src.services.users.sc_verification import sc_email_verification_enabled

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

AccessReason = Literal[
    "free", "purchased", "admin", "author", "anonymous", "none",
    # Free course: sign in first / verify the account's email first.
    "login_required", "verify_email",
]

# Free-course denials and how an endpoint that serves content reports them.
FREE_GATE_ERRORS = {
    "login_required": (401, "LOGIN_REQUIRED", "Inicia sesión para acceder a este contenido gratuito"),
    "verify_email": (403, "EMAIL_NOT_VERIFIED", "Verifica tu correo para acceder a este contenido gratuito"),
}


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


async def _free_course_access(db_session: AsyncSession, user, course: Course) -> CourseAccess:
    """A course no live offer covers: a verified account reads it for free."""
    if not sc_email_verification_enabled():
        return CourseAccess(False, True, "free", 0)
    if user is None or isinstance(user, (AnonymousUser, APITokenUser)):
        return CourseAccess(False, False, "login_required", 0)
    if isinstance(user, SuperadminAPITokenUser):
        return CourseAccess(False, True, "admin", 0)

    from src.security.org_auth import is_org_admin

    user_id = int(getattr(user, "id", 0) or 0)
    if not user_id:
        return CourseAccess(False, False, "login_required", 0)
    if await is_org_admin(user_id, course.org_id, db_session):
        return CourseAccess(False, True, "admin", 0)
    if await is_active_course_author(db_session, user_id, course.course_uuid):
        return CourseAccess(False, True, "author", 0)
    # The session object may not carry ``email_verified`` (PublicUser) or carry
    # a stale one, so read the row. Callers cache the decision per request and
    # for 60 s in Redis (``course_access_decision``).
    verified = (await db_session.execute(
        select(User.email_verified).where(User.id == user_id)
    )).scalar()
    if not verified:
        # A course whose offers were all archived counts as free, but whoever
        # bought it keeps it, verified or not.
        if await has_paid_enrollment(db_session, user_id, course.course_uuid, course.org_id):
            return CourseAccess(False, True, "purchased", 0)
        return CourseAccess(False, False, "verify_email", 0)
    return CourseAccess(False, True, "free", 0)


async def get_course_access(db_session: AsyncSession, user, course: Course) -> CourseAccess:
    """Full access decision for ``user`` on ``course`` (uncached)."""
    offers_count = await count_active_offers(db_session, course.course_uuid, course.org_id)
    if offers_count == 0:
        return await _free_course_access(db_session, user, course)
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
    """Invalidate every cached access decision (offer, group, purchase or
    email verification change)."""
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


def _decode_decision(raw) -> tuple[bool, str]:
    """``"1|free"`` -> ``(True, "free")``; a bare ``"1"``/``"0"`` (entries
    written before reasons were cached) has an empty reason."""
    text = raw.decode() if isinstance(raw, bytes) else str(raw)
    flag, _, reason = text.partition("|")
    return flag == "1", reason


async def course_access_decision(request: Optional[Request], db_session: AsyncSession, user,
                                 course: Course) -> tuple[bool, str]:
    """``(has_access, reason)``, memoized per request and cached 60 s."""
    memo = _memo(request)
    principal = _principal_key(user)
    memo_key = ("course", course.id, principal)
    if memo is not None and memo_key in memo:
        return memo[memo_key]

    client = _cache_client()
    redis_key = None
    if client is not None:
        try:
            # "access2": entries cached before free courses needed a verified
            # account (bare "0"/"1", no reason) are never read again.
            redis_key = f"sc_pay:access2:v{_access_version(client)}:{course.id}:{principal}"
            cached = client.get(redis_key)
            if cached is not None:
                decision = _decode_decision(cached)
                if memo is not None:
                    memo[memo_key] = decision
                return decision
        except Exception:
            redis_key = None
            logger.debug("Payments access cache read failed", exc_info=True)

    access = await get_course_access(db_session, user, course)
    decision = (access.has_access, access.reason)

    if memo is not None:
        memo[memo_key] = decision
    if client is not None and redis_key is not None:
        try:
            flag = "1" if access.has_access else "0"
            client.setex(redis_key, _CACHE_TTL_SECONDS, f"{flag}|{access.reason}")
        except Exception:
            logger.debug("Payments access cache write failed", exc_info=True)
    return decision


async def has_course_access(request: Optional[Request], db_session: AsyncSession, user,
                            course: Course) -> bool:
    return (await course_access_decision(request, db_session, user, course))[0]


def free_gate_exception(reason: str) -> Optional[HTTPException]:
    """The 401/403 for a free course the caller may not read yet, else None."""
    spec = FREE_GATE_ERRORS.get(reason)
    if spec is None:
        return None
    status_code, code, message = spec
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


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
    has no access (used to gate "start course"). On a free course: 401
    ``LOGIN_REQUIRED`` or 403 ``EMAIL_NOT_VERIFIED`` (``FREE_GATE_ERRORS``)."""
    allowed, reason = await course_access_decision(request, db_session, user, course)
    if allowed:
        return
    gate = free_gate_exception(reason)
    if gate is not None:
        raise gate
    raise HTTPException(status_code=402, detail={"code": "PAYMENT_REQUIRED"})

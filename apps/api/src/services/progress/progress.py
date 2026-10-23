"""Sanar y Criar: per-activity playback/reading progress ("continue where
you left off").

Completion stays in ``TrailStep``; this module only stores positions. A video
watched past 90% (or any activity reported ``completed``) is marked complete
through ``add_activity_to_trail`` so certificates and webhooks keep working.
"""

import logging
import math
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import case, func, or_
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from src.db.activity_progress import ActivityProgress
from src.db.courses.activities import Activity, ActivityTypeEnum
from src.db.courses.chapter_activities import ChapterActivity
from src.db.courses.chapters import Chapter
from src.db.courses.courses import Course
from src.db.trail_steps import TrailStep
from src.db.users import AnonymousUser, APITokenUser
from src.security.rbac import AccessAction, check_resource_access
from src.services.courses.activities.access import verify_activity_reader_access
from src.services.progress.schema import ensure_progress_schema

logger = logging.getLogger(__name__)

AUTO_COMPLETE_RATIO = 0.9
# Players report the duration rounded; allow a little slack past the end.
_POSITION_SLACK_SECONDS = 2.0
_MAX_SECONDS = 60 * 60 * 24  # 24 h: nothing we host is longer
_RATE_LIMIT = 60
_RATE_WINDOW_SECONDS = 60
_MAX_CLIENT_TS = 10 ** 13  # epoch ms, year 2286
# client_ts only orders saves that arrive close together (a periodic save
# landing after the on-leave keepalive one). Clocks differ between devices, so
# a stamp older than the stored one is only stale while the stored save is
# this recent by the server clock; after that, last write wins again. Without
# it, a device whose clock runs ahead would freeze the position for every
# other device until real time caught up.
_CLIENT_TS_WINDOW = timedelta(minutes=10)


class ProgressBody(BaseModel):
    position_seconds: float = Field(ge=0, le=_MAX_SECONDS)
    duration_seconds: Optional[float] = Field(default=None, ge=0, le=_MAX_SECONDS)
    page: Optional[int] = Field(default=None, ge=0, le=100_000)
    completed: Optional[bool] = False
    # Client clock (epoch ms, e.g. ``Date.now()``) when the position was read.
    # A save older than the stored one (a periodic save landing after the
    # final on-leave save) leaves the position where it is. Optional: clients
    # that omit it keep last-write-wins.
    client_ts: Optional[int] = Field(default=None, ge=0, le=_MAX_CLIENT_TS)

    @field_validator("client_ts", mode="before")
    @classmethod
    def _whole_milliseconds(cls, value):
        # performance.timeOrigin + performance.now() has a fraction.
        if isinstance(value, float) and math.isfinite(value):
            return math.floor(value)
        return value


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def _require_user(user) -> None:
    if user is None or isinstance(user, (AnonymousUser, APITokenUser)):
        raise HTTPException(status_code=401, detail="Authentication required")


def _check_rate(user_id: int) -> None:
    """Soft limit (60 saves per minute per user); open when Redis is down."""
    if os.getenv("TESTING", "false").lower() == "true":
        return
    try:
        from src.services.security.rate_limiting import check_rate_limit

        allowed, _, retry_after = check_rate_limit(
            f"sc_progress:{user_id}", _RATE_LIMIT, _RATE_WINDOW_SECONDS
        )
    except Exception:
        return
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail="Too many progress updates",
            headers={"Retry-After": str(retry_after)},
        )


def serialize_progress(row: ActivityProgress, activity_uuid: str, course_uuid: Optional[str] = None) -> dict:
    return {
        "activity_uuid": activity_uuid,
        "course_uuid": course_uuid,
        "position_seconds": row.position_seconds,
        "duration_seconds": row.duration_seconds,
        "max_position_seconds": row.max_position_seconds,
        "page": row.page,
        "completed": bool(row.completed),
        "client_ts": row.client_ts,
        "creation_date": _iso(row.creation_date),
        "update_date": _iso(row.update_date),
    }


async def _activity_and_course(db_session: AsyncSession, activity_uuid: str) -> tuple[Activity, Course]:
    row = (await db_session.execute(
        select(Activity, Course)
        .join(Course, Course.id == Activity.course_id)  # type: ignore[arg-type]
        .where(Activity.activity_uuid == activity_uuid)
    )).first()
    if not row:
        raise HTTPException(status_code=404, detail="Activity not found")
    return row[0], row[1]


async def _get_row(db_session: AsyncSession, user_id: int, activity_id: int) -> Optional[ActivityProgress]:
    return (await db_session.execute(
        select(ActivityProgress)
        .where(ActivityProgress.user_id == user_id, ActivityProgress.activity_id == activity_id)
        .execution_options(populate_existing=True)
    )).scalars().first()


def _insert_for(db_session: AsyncSession):
    dialect = db_session.get_bind().dialect.name
    if dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    elif dialect == "sqlite":
        from sqlalchemy.dialects.sqlite import insert
    else:  # pragma: no cover - LearnHouse runs on Postgres (SQLite in tests)
        raise RuntimeError(f"Unsupported database dialect: {dialect}")
    return insert


async def _upsert(db_session: AsyncSession, *, org_id: int, user_id: int, course_id: int,
                  activity_id: int, body: ProgressBody) -> None:
    insert = _insert_for(db_session)
    now = _utcnow()
    position = float(body.position_seconds)
    if body.duration_seconds:
        position = min(position, float(body.duration_seconds) + _POSITION_SLACK_SECONDS)
    values = dict(
        org_id=org_id,
        user_id=user_id,
        course_id=course_id,
        activity_id=activity_id,
        position_seconds=position,
        duration_seconds=body.duration_seconds,
        max_position_seconds=position,
        page=body.page,
        completed=bool(body.completed),
        client_ts=body.client_ts,
        creation_date=now,
        update_date=now,
    )
    statement = insert(ActivityProgress).values(**values)
    excluded = statement.excluded
    table = ActivityProgress.__table__.c  # type: ignore[attr-defined]
    # Out-of-order saves: one stamped older than the stored row (saved within
    # _CLIENT_TS_WINDOW) is stale. It
    # never moves the position, page, client_ts or update_date back, but still
    # feeds the order-independent fields (furthest point, completion, a missing
    # duration): those facts are true whenever they were observed. Decided in
    # the statement itself, so two racing saves cannot both win.
    fresh = or_(
        excluded.client_ts.is_(None),
        table.client_ts.is_(None),
        excluded.client_ts >= table.client_ts,
        table.update_date < now - _CLIENT_TS_WINDOW,
    )
    statement = statement.on_conflict_do_update(
        index_elements=["user_id", "activity_id"],
        set_={
            "position_seconds": case((fresh, excluded.position_seconds), else_=table.position_seconds),
            "duration_seconds": case(
                (fresh, func.coalesce(excluded.duration_seconds, table.duration_seconds)),
                else_=func.coalesce(table.duration_seconds, excluded.duration_seconds),
            ),
            # Portable GREATEST(): SQLite has no such function.
            "max_position_seconds": case(
                (excluded.position_seconds > table.max_position_seconds, excluded.position_seconds),
                else_=table.max_position_seconds,
            ),
            "page": case(
                (fresh, func.coalesce(excluded.page, table.page)),
                else_=func.coalesce(table.page, excluded.page),
            ),
            # Completion is sticky (unmarking an activity deletes the row).
            "completed": case((excluded.completed == True, True), else_=table.completed),  # noqa: E712
            "update_date": case((fresh, excluded.update_date), else_=table.update_date),
            "client_ts": case(
                (fresh, func.coalesce(excluded.client_ts, table.client_ts)),
                else_=table.client_ts,
            ),
        },
    )
    await db_session.execute(statement)
    await db_session.commit()


async def _has_trail_step(db_session: AsyncSession, user_id: int, activity_id: int) -> bool:
    row = (await db_session.execute(
        select(TrailStep.id).where(TrailStep.user_id == user_id, TrailStep.activity_id == activity_id).limit(1)
    )).first()
    return row is not None


def _should_complete(activity: Activity, row: ActivityProgress, body: ProgressBody) -> bool:
    if activity.activity_type == ActivityTypeEnum.TYPE_ASSIGNMENT:
        return False
    if body.completed:
        return True
    if activity.activity_type != ActivityTypeEnum.TYPE_VIDEO:
        return False
    duration = row.duration_seconds or 0
    return duration > 0 and (row.max_position_seconds or 0) / duration >= AUTO_COMPLETE_RATIO


async def save_activity_progress(request: Request, db_session: AsyncSession, user, activity_uuid: str,
                                 body: ProgressBody) -> dict:
    _require_user(user)
    _check_rate(user.id)
    await ensure_progress_schema(db_session)
    activity, course = await _activity_and_course(db_session, activity_uuid)
    # Same gate as the media itself: 402 when the course is unpaid for.
    await verify_activity_reader_access(request, activity, course, user, db_session)

    await _upsert(
        db_session, org_id=course.org_id, user_id=user.id, course_id=course.id,
        activity_id=activity.id, body=body,
    )
    row = await _get_row(db_session, user.id, activity.id)
    if row is None:  # pragma: no cover - the upsert just wrote it
        raise HTTPException(status_code=500, detail="Progress was not saved")

    if _should_complete(activity, row, body) and not await _has_trail_step(db_session, user.id, activity.id):
        from src.services.trail.trail import add_activity_to_trail

        try:
            await add_activity_to_trail(request, user, activity_uuid, db_session)
        except HTTPException as exc:
            logger.info("Auto-complete of %s skipped: %s", activity_uuid, exc.detail)
        else:
            if not row.completed:
                row.completed = True
                db_session.add(row)
                await db_session.commit()
            row = await _get_row(db_session, user.id, activity.id) or row
    return serialize_progress(row, activity.activity_uuid, course.course_uuid)


async def get_activity_progress(request: Request, db_session: AsyncSession, user,
                                activity_uuid: str) -> Optional[dict]:
    _require_user(user)
    await ensure_progress_schema(db_session)
    activity, course = await _activity_and_course(db_session, activity_uuid)
    await check_resource_access(request, db_session, user, course.course_uuid, AccessAction.READ)
    row = await _get_row(db_session, user.id, activity.id)
    if row is None:
        return None
    return serialize_progress(row, activity.activity_uuid, course.course_uuid)


async def get_course_progress(request: Request, db_session: AsyncSession, user, course_uuid: str) -> dict:
    _require_user(user)
    await ensure_progress_schema(db_session)
    course = (await db_session.execute(
        select(Course).where(Course.course_uuid == course_uuid)
    )).scalars().first()
    if course is None:
        raise HTTPException(status_code=404, detail="Course not found")
    await check_resource_access(request, db_session, user, course.course_uuid, AccessAction.READ)

    rows = (await db_session.execute(
        select(ActivityProgress, Activity)
        .join(Activity, Activity.id == ActivityProgress.activity_id)  # type: ignore[arg-type]
        .where(ActivityProgress.user_id == user.id, ActivityProgress.course_id == course.id)
        .order_by(ActivityProgress.update_date.desc(), ActivityProgress.id.desc())  # type: ignore[attr-defined]
    )).all()

    items = [
        {
            "activity_uuid": activity.activity_uuid,
            "position_seconds": progress.position_seconds,
            "duration_seconds": progress.duration_seconds,
            "max_position_seconds": progress.max_position_seconds,
            "page": progress.page,
            "completed": bool(progress.completed),
        }
        for progress, activity in rows
    ]

    last = None
    if rows:
        progress, activity = rows[0]
        chapter_name = (await db_session.execute(
            select(Chapter.name)
            .join(ChapterActivity, ChapterActivity.chapter_id == Chapter.id)  # type: ignore[arg-type]
            .where(ChapterActivity.activity_id == activity.id)
            .limit(1)
        )).scalar()
        last = {
            "activity_uuid": activity.activity_uuid,
            "activity_type": activity.activity_type,
            "activity_name": activity.name,
            "chapter_name": chapter_name,
            "position_seconds": progress.position_seconds,
            "duration_seconds": progress.duration_seconds,
            "page": progress.page,
            "update_date": _iso(progress.update_date),
            "completed": bool(progress.completed),
        }
    return {"last": last, "items": items}

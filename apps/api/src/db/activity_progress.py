"""Sanar y Criar: per-activity playback/reading progress.

Completion stays in ``TrailStep`` (its existence means "done" across the
app); this table only remembers where a learner left a video or a PDF so the
player can resume, plus the furthest point reached.
"""

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    UniqueConstraint,
)
from sqlmodel import Field, SQLModel


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ActivityProgress(SQLModel, table=True):
    __tablename__ = "activityprogress"
    __table_args__ = (
        UniqueConstraint("user_id", "activity_id", name="uq_activityprogress_user_activity"),
        Index("ix_activityprogress_user_course_updated", "user_id", "course_id", "update_date"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    org_id: int = Field(
        sa_column=Column(
            Integer, ForeignKey("organization.id", ondelete="CASCADE"), nullable=False, index=True
        )
    )
    user_id: int = Field(
        sa_column=Column(Integer, ForeignKey("user.id", ondelete="CASCADE"), nullable=False)
    )
    course_id: int = Field(
        sa_column=Column(Integer, ForeignKey("course.id", ondelete="CASCADE"), nullable=False)
    )
    activity_id: int = Field(
        sa_column=Column(Integer, ForeignKey("activity.id", ondelete="CASCADE"), nullable=False)
    )
    position_seconds: float = Field(default=0.0, sa_column=Column(Float, nullable=False, default=0.0))
    duration_seconds: Optional[float] = Field(default=None, sa_column=Column(Float, nullable=True))
    max_position_seconds: float = Field(
        default=0.0, sa_column=Column(Float, nullable=False, default=0.0)
    )
    page: Optional[int] = Field(default=None, sa_column=Column(Integer, nullable=True))
    completed: bool = Field(default=False, sa_column=Column(Boolean, nullable=False, default=False))
    # Client clock (epoch ms) of the newest accepted save; older saves arriving
    # late do not move the position back. Nullable: older clients don't send
    # it. Existing tables get it from migration 7b5dee2850d6 or, on databases
    # built by create_all, from services/progress/schema.py.
    client_ts: Optional[int] = Field(default=None, sa_column=Column(BigInteger, nullable=True))
    creation_date: datetime = Field(
        default_factory=_utcnow, sa_column=Column(DateTime(timezone=True), nullable=False)
    )
    update_date: datetime = Field(
        default_factory=_utcnow, sa_column=Column(DateTime(timezone=True), nullable=False)
    )

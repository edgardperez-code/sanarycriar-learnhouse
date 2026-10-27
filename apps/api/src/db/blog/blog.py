"""Sanar y Criar: blog tables (articles of the marketing site, written in the dashboard).

Every table is prefixed ``sc_blog_`` so it never collides with upstream
tables. Enum-like fields are plain VARCHAR on purpose (same reason as the
payments and newsletter tables: ``create_all`` never alters a Postgres enum
type). Dates are timezone-aware. Lists use the generic ``JSON`` type (not
JSONB) so the in-memory SQLite of the tests stores them too; always assign a
new list instead of mutating one in place, or SQLAlchemy will not see the
change.

``content_md`` is the source the owner edits; ``content_html`` is ALWAYS
rendered and sanitized by the backend (``src/services/blog/render.py``) and
never accepted from a client.

The text of an AI prompt (topic, facts, revision instruction) is never
stored: it travels in memory to the background job only.
"""

from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlmodel import Field, SQLModel


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _new_post_uuid() -> str:
    return uuid4().hex


def _empty_list() -> list:
    return []


def _empty_dict() -> dict:
    return {}


def _created_column() -> Column:
    return Column(DateTime(timezone=True), nullable=False, default=utcnow)


def _updated_column() -> Column:
    return Column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)


def _org_column() -> Column:
    return Column(
        Integer, ForeignKey("organization.id", ondelete="CASCADE"), nullable=False, index=True
    )


def _created_by_column() -> Column:
    return Column(Integer, ForeignKey("user.id", ondelete="SET NULL"), nullable=True)


class BlogPost(SQLModel, table=True):
    """One article of an org's blog.

    ``kind``: ``informativo`` | ``novedad`` | ``taller``.
    ``status``: ``draft`` | ``published``.
    ``source``: ``manual`` | ``ai``.
    ``published_at`` is set the FIRST time the article is published and kept
    when it is unpublished; once set, the slug can no longer change.
    ``cover_image`` / ``og_image`` are file names under
    ``content/orgs/{org_uuid}/blog/{post_uuid}/``.
    """

    __tablename__ = "sc_blog_post"
    __table_args__ = (
        UniqueConstraint("org_id", "slug", name="uq_sc_blog_post_org_slug"),
        UniqueConstraint("post_uuid", name="uq_sc_blog_post_uuid"),
        Index("ix_sc_blog_post_org_status_published", "org_id", "status", "published_at"),
        Index("ix_sc_blog_post_org_updated", "org_id", "update_date"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    post_uuid: str = Field(
        default_factory=_new_post_uuid,
        sa_column=Column(String(36), nullable=False, default=_new_post_uuid),
    )
    org_id: int = Field(sa_column=_org_column())
    slug: str = Field(sa_column=Column(String(80), nullable=False))
    title: str = Field(sa_column=Column(String(120), nullable=False))
    kind: str = Field(
        default="informativo", sa_column=Column(String(16), nullable=False, default="informativo")
    )
    category: str = Field(
        default="crianza-y-familia",
        sa_column=Column(String(32), nullable=False, default="crianza-y-familia"),
    )
    status: str = Field(default="draft", sa_column=Column(String(16), nullable=False, default="draft"))
    excerpt: str = Field(default="", sa_column=Column(String(300), nullable=False, default=""))
    summary: str = Field(default="", sa_column=Column(Text, nullable=False, default=""))
    key_takeaways: list = Field(
        default_factory=_empty_list, sa_column=Column(JSON, nullable=False, default=_empty_list)
    )
    content_md: str = Field(default="", sa_column=Column(Text, nullable=False, default=""))
    content_html: str = Field(default="", sa_column=Column(Text, nullable=False, default=""))
    faq: list = Field(
        default_factory=_empty_list, sa_column=Column(JSON, nullable=False, default=_empty_list)
    )
    meta_title: str = Field(default="", sa_column=Column(String(120), nullable=False, default=""))
    meta_description: str = Field(
        default="", sa_column=Column(String(300), nullable=False, default="")
    )
    keywords: list = Field(
        default_factory=_empty_list, sa_column=Column(JSON, nullable=False, default=_empty_list)
    )
    cover_image: Optional[str] = Field(default=None, sa_column=Column(String(200), nullable=True))
    og_image: Optional[str] = Field(default=None, sa_column=Column(String(200), nullable=True))
    cover_alt: str = Field(default="", sa_column=Column(String(200), nullable=False, default=""))
    word_count: int = Field(default=0, sa_column=Column(Integer, nullable=False, default=0))
    source: str = Field(default="manual", sa_column=Column(String(16), nullable=False, default="manual"))
    ai_model: Optional[str] = Field(default=None, sa_column=Column(String(64), nullable=True))
    published_at: Optional[datetime] = Field(
        default=None, sa_column=Column(DateTime(timezone=True), nullable=True)
    )
    created_by_user_id: Optional[int] = Field(default=None, sa_column=_created_by_column())
    creation_date: datetime = Field(default_factory=utcnow, sa_column=_created_column())
    update_date: datetime = Field(default_factory=utcnow, sa_column=_updated_column())


class BlogAIJob(SQLModel, table=True):
    """One AI task of the dashboard (write a new draft, or revise an article).

    ``operation``: ``generate`` | ``revise``.
    ``status``: ``pending`` | ``running`` | ``done`` | ``error``.
    ``post_id``: the draft it created (generate) or the article it revised.
    ``result_json``: only for a revision that could not be applied because
    the article was published meanwhile (the proposed article).
    ``meta_json`` holds counters and flags only, never the owner's text.
    """

    __tablename__ = "sc_blog_ai_job"
    __table_args__ = (
        Index("ix_sc_blog_ai_job_org_status", "org_id", "status"),
        Index("ix_sc_blog_ai_job_org_created", "org_id", "creation_date"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    org_id: int = Field(sa_column=_org_column())
    post_id: Optional[int] = Field(
        default=None,
        sa_column=Column(Integer, ForeignKey("sc_blog_post.id", ondelete="SET NULL"), nullable=True),
    )
    operation: str = Field(sa_column=Column(String(16), nullable=False))
    status: str = Field(default="pending", sa_column=Column(String(16), nullable=False, default="pending"))
    error: Optional[str] = Field(default=None, sa_column=Column(String(300), nullable=True))
    applied: bool = Field(default=False, sa_column=Column(Boolean, nullable=False, default=False))
    result_json: Optional[dict] = Field(default=None, sa_column=Column(JSON, nullable=True))
    meta_json: dict = Field(
        default_factory=_empty_dict, sa_column=Column(JSON, nullable=False, default=_empty_dict)
    )
    usage_json: Optional[dict] = Field(default=None, sa_column=Column(JSON, nullable=True))
    model: Optional[str] = Field(default=None, sa_column=Column(String(64), nullable=True))
    created_by_user_id: Optional[int] = Field(default=None, sa_column=_created_by_column())
    started_at: Optional[datetime] = Field(
        default=None, sa_column=Column(DateTime(timezone=True), nullable=True)
    )
    finished_at: Optional[datetime] = Field(
        default=None, sa_column=Column(DateTime(timezone=True), nullable=True)
    )
    creation_date: datetime = Field(default_factory=utcnow, sa_column=_created_column())
    update_date: datetime = Field(default_factory=utcnow, sa_column=_updated_column())

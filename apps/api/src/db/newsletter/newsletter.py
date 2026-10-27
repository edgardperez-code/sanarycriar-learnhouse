"""Sanar y Criar: newsletter tables (sign-up pop-up on the marketing site).

Every table is prefixed ``sc_newsletter_`` so it never collides with upstream
tables. Enum-like fields are plain VARCHAR on purpose (same reason as the
payments tables: ``create_all`` never alters a Postgres enum type). Dates are
timezone-aware.

E-mails are stored already normalized (stripped, lowercase), which is what
makes the ``(org_id, email)`` unique constraint meaningful. No IP address or
user agent is stored.
"""

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import (
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


def _created_column() -> Column:
    return Column(DateTime(timezone=True), nullable=False, default=utcnow)


def _updated_column() -> Column:
    return Column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)


class NewsletterSettings(SQLModel, table=True):
    """Pop-up configuration, one row per org.

    An org without a row uses ``DEFAULT_SETTINGS``
    (``src/services/newsletter/settings.py``); the row is created on the first
    save from the dashboard.
    """

    __tablename__ = "sc_newsletter_settings"
    # The unique constraint already creates the index on org_id.
    __table_args__ = (UniqueConstraint("org_id", name="uq_sc_newsletter_settings_org"),)

    id: Optional[int] = Field(default=None, primary_key=True)
    org_id: int = Field(
        sa_column=Column(
            Integer, ForeignKey("organization.id", ondelete="CASCADE"), nullable=False
        )
    )
    enabled: bool = Field(default=False, sa_column=Column(Boolean, nullable=False, default=False))
    title: str = Field(sa_column=Column(String(120), nullable=False))
    body: str = Field(sa_column=Column(Text, nullable=False))
    button_label: str = Field(sa_column=Column(String(40), nullable=False))
    dismiss_label: str = Field(sa_column=Column(String(40), nullable=False))
    success_message: str = Field(sa_column=Column(String(300), nullable=False))
    privacy_note: str = Field(default="", sa_column=Column(String(300), nullable=False, default=""))
    delay_seconds: int = Field(default=0, sa_column=Column(Integer, nullable=False, default=0))
    dismiss_days: int = Field(default=30, sa_column=Column(Integer, nullable=False, default=30))
    creation_date: datetime = Field(default_factory=utcnow, sa_column=_created_column())
    update_date: datetime = Field(default_factory=utcnow, sa_column=_updated_column())


class NewsletterSubscriber(SQLModel, table=True):
    """One e-mail address subscribed to an org's newsletter.

    ``source``: ``popup`` | ``footer`` | ``other``.
    ``sync_status`` (copy to Resend contacts): ``pending`` | ``synced`` |
    ``error`` | ``skipped`` (no Resend configured when it was saved).
    """

    __tablename__ = "sc_newsletter_subscriber"
    __table_args__ = (
        UniqueConstraint("org_id", "email", name="uq_sc_newsletter_subscriber_org_email"),
        Index("ix_sc_newsletter_subscriber_org_created", "org_id", "creation_date"),
        Index("ix_sc_newsletter_subscriber_org_sync", "org_id", "sync_status"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    org_id: int = Field(
        sa_column=Column(
            Integer, ForeignKey("organization.id", ondelete="CASCADE"), nullable=False, index=True
        )
    )
    email: str = Field(sa_column=Column(String(254), nullable=False))
    source: str = Field(default="popup", sa_column=Column(String(16), nullable=False, default="popup"))
    page_path: Optional[str] = Field(default=None, sa_column=Column(String(200), nullable=True))
    resend_contact_id: Optional[str] = Field(default=None, sa_column=Column(String(64), nullable=True))
    sync_status: str = Field(
        default="pending", sa_column=Column(String(16), nullable=False, default="pending")
    )
    sync_error: Optional[str] = Field(default=None, sa_column=Column(String(300), nullable=True))
    synced_at: Optional[datetime] = Field(
        default=None, sa_column=Column(DateTime(timezone=True), nullable=True)
    )
    creation_date: datetime = Field(default_factory=utcnow, sa_column=_created_column())
    update_date: datetime = Field(default_factory=utcnow, sa_column=_updated_column())

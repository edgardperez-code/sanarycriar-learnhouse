"""Sanar y Criar: payments tables (our own OSS module, not the EE one).

Every table is prefixed ``sc_pay_`` so it never collides with the legacy or
Enterprise payment tables (``paymentsconfig``, ``paymentsoffer``...).
Enum-like fields are plain VARCHAR on purpose: ``create_all`` never alters a
Postgres enum type, so adding a provider or a status later would need DDL.
Dates are timezone-aware and amounts are ``Numeric(12, 2)``: money is always
compared as ``Decimal``, never as float.
"""

from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
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


class PaymentsConfig(SQLModel, table=True):
    """One provider configuration per org (PayPal today, SPIDI later).

    ``provider_config`` holds provider settings. Secrets are stored only
    encrypted (``*_enc`` keys) and are never serialized back to clients.
    """

    __tablename__ = "sc_pay_config"
    __table_args__ = (
        UniqueConstraint("org_id", "provider", name="uq_sc_pay_config_org_provider"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    org_id: int = Field(
        sa_column=Column(
            Integer, ForeignKey("organization.id", ondelete="CASCADE"), nullable=False, index=True
        )
    )
    provider: str = Field(sa_column=Column(String(32), nullable=False))
    enabled: bool = Field(default=True, sa_column=Column(Boolean, nullable=False, default=True))
    active: bool = Field(default=False, sa_column=Column(Boolean, nullable=False, default=False))
    provider_specific_id: Optional[str] = Field(
        default=None, sa_column=Column(String(255), nullable=True)
    )
    mode: str = Field(default="standard", sa_column=Column(String(32), nullable=False, default="standard"))
    provider_config: dict = Field(default_factory=dict, sa_column=Column(JSON, nullable=False))
    creation_date: datetime = Field(default_factory=utcnow, sa_column=_created_column())
    update_date: datetime = Field(default_factory=utcnow, sa_column=_updated_column())


class PaymentsGroup(SQLModel, table=True):
    __tablename__ = "sc_pay_group"

    id: Optional[int] = Field(default=None, primary_key=True)
    org_id: int = Field(
        sa_column=Column(
            Integer, ForeignKey("organization.id", ondelete="CASCADE"), nullable=False, index=True
        )
    )
    name: str = Field(sa_column=Column(String(255), nullable=False))
    description: str = Field(default="", sa_column=Column(Text, nullable=False, default=""))
    creation_date: datetime = Field(default_factory=utcnow, sa_column=_created_column())
    update_date: datetime = Field(default_factory=utcnow, sa_column=_updated_column())


class PaymentsGroupResource(SQLModel, table=True):
    __tablename__ = "sc_pay_group_resource"
    __table_args__ = (
        UniqueConstraint(
            "payments_group_id", "resource_uuid", name="uq_sc_pay_group_resource"
        ),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    payments_group_id: int = Field(
        sa_column=Column(
            Integer, ForeignKey("sc_pay_group.id", ondelete="CASCADE"), nullable=False, index=True
        )
    )
    resource_uuid: str = Field(sa_column=Column(String(255), nullable=False, index=True))
    org_id: int = Field(
        sa_column=Column(
            Integer, ForeignKey("organization.id", ondelete="CASCADE"), nullable=False, index=True
        )
    )
    creation_date: datetime = Field(default_factory=utcnow, sa_column=_created_column())
    update_date: datetime = Field(default_factory=utcnow, sa_column=_updated_column())


class PaymentsGroupSync(SQLModel, table=True):
    """Usergroups a buyer is added to when an offer of this group is paid."""

    __tablename__ = "sc_pay_group_sync"
    __table_args__ = (
        UniqueConstraint("payments_group_id", "usergroup_id", name="uq_sc_pay_group_sync"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    payments_group_id: int = Field(
        sa_column=Column(
            Integer, ForeignKey("sc_pay_group.id", ondelete="CASCADE"), nullable=False, index=True
        )
    )
    usergroup_id: int = Field(
        sa_column=Column(
            Integer, ForeignKey("usergroup.id", ondelete="CASCADE"), nullable=False, index=True
        )
    )
    org_id: int = Field(
        sa_column=Column(
            Integer, ForeignKey("organization.id", ondelete="CASCADE"), nullable=False, index=True
        )
    )
    creation_date: datetime = Field(default_factory=utcnow, sa_column=_created_column())
    update_date: datetime = Field(default_factory=utcnow, sa_column=_updated_column())


class PaymentsOffer(SQLModel, table=True):
    """Something a buyer can pay for once. Offers are archived, never deleted,
    so past buyers keep access through their enrollment."""

    __tablename__ = "sc_pay_offer"

    id: Optional[int] = Field(default=None, primary_key=True)
    offer_uuid: str = Field(sa_column=Column(String(64), nullable=False, unique=True, index=True))
    org_id: int = Field(
        sa_column=Column(
            Integer, ForeignKey("organization.id", ondelete="CASCADE"), nullable=False, index=True
        )
    )
    payments_config_id: Optional[int] = Field(
        default=None,
        sa_column=Column(
            Integer, ForeignKey("sc_pay_config.id", ondelete="SET NULL"), nullable=True
        ),
    )
    payments_group_id: Optional[int] = Field(
        default=None,
        sa_column=Column(
            Integer, ForeignKey("sc_pay_group.id", ondelete="SET NULL"), nullable=True, index=True
        ),
    )
    name: str = Field(sa_column=Column(String(255), nullable=False))
    description: str = Field(default="", sa_column=Column(Text, nullable=False, default=""))
    offer_type: str = Field(default="one_time", sa_column=Column(String(32), nullable=False, default="one_time"))
    price_type: str = Field(default="fixed_price", sa_column=Column(String(32), nullable=False, default="fixed_price"))
    billing_interval: str = Field(default="month", sa_column=Column(String(16), nullable=False, default="month"))
    benefits: str = Field(default="", sa_column=Column(Text, nullable=False, default=""))
    amount: Decimal = Field(sa_column=Column(Numeric(12, 2), nullable=False))
    currency: str = Field(default="USD", sa_column=Column(String(3), nullable=False, default="USD"))
    is_publicly_listed: bool = Field(default=True, sa_column=Column(Boolean, nullable=False, default=True))
    archived: bool = Field(default=False, sa_column=Column(Boolean, nullable=False, default=False, index=True))
    creation_date: datetime = Field(default_factory=utcnow, sa_column=_created_column())
    update_date: datetime = Field(default_factory=utcnow, sa_column=_updated_column())


class PaymentsOfferResource(SQLModel, table=True):
    __tablename__ = "sc_pay_offer_resource"
    __table_args__ = (
        UniqueConstraint("offer_id", "resource_uuid", name="uq_sc_pay_offer_resource"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    offer_id: int = Field(
        sa_column=Column(
            Integer, ForeignKey("sc_pay_offer.id", ondelete="CASCADE"), nullable=False, index=True
        )
    )
    resource_uuid: str = Field(sa_column=Column(String(255), nullable=False, index=True))
    org_id: int = Field(
        sa_column=Column(
            Integer, ForeignKey("organization.id", ondelete="CASCADE"), nullable=False, index=True
        )
    )
    creation_date: datetime = Field(default_factory=utcnow, sa_column=_created_column())
    update_date: datetime = Field(default_factory=utcnow, sa_column=_updated_column())


class PaymentsEnrollment(SQLModel, table=True):
    """A user's entitlement to an offer.

    Status: pending | active | completed | cancelled | failed | refunded.
    Access is granted by ``active`` and ``completed`` only.
    """

    __tablename__ = "sc_pay_enrollment"
    __table_args__ = (
        Index("ix_sc_pay_enrollment_user_org", "user_id", "org_id"),
        Index("ix_sc_pay_enrollment_offer_status", "offer_id", "status"),
        Index("ix_sc_pay_enrollment_user_offer", "user_id", "offer_id"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    enrollment_uuid: str = Field(sa_column=Column(String(64), nullable=False, unique=True))
    offer_id: int = Field(
        sa_column=Column(Integer, ForeignKey("sc_pay_offer.id", ondelete="CASCADE"), nullable=False)
    )
    user_id: int = Field(
        sa_column=Column(Integer, ForeignKey("user.id", ondelete="CASCADE"), nullable=False)
    )
    org_id: int = Field(
        sa_column=Column(Integer, ForeignKey("organization.id", ondelete="CASCADE"), nullable=False)
    )
    status: str = Field(default="pending", sa_column=Column(String(32), nullable=False, default="pending"))
    provider_specific_data: dict = Field(default_factory=dict, sa_column=Column(JSON, nullable=False))
    creation_date: datetime = Field(default_factory=utcnow, sa_column=_created_column())
    update_date: datetime = Field(default_factory=utcnow, sa_column=_updated_column())


class PaymentsOrder(SQLModel, table=True):
    """One checkout attempt, provider agnostic.

    Status: created -> approved -> paid -> (accredited); or failed, expired,
    cancelled, refunded, pending (payment under review). ``order_uuid`` is a
    random secret: knowing it is what lets the return page confirm a payment.
    """

    __tablename__ = "sc_pay_order"
    __table_args__ = (
        UniqueConstraint("provider", "provider_order_id", name="uq_sc_pay_order_provider_order"),
        Index("ix_sc_pay_order_status_created", "status", "creation_date"),
        Index("ix_sc_pay_order_org_created", "org_id", "creation_date"),
        Index("ix_sc_pay_order_user", "user_id", "org_id"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    order_uuid: str = Field(sa_column=Column(String(64), nullable=False, unique=True, index=True))
    org_id: int = Field(
        sa_column=Column(Integer, ForeignKey("organization.id", ondelete="CASCADE"), nullable=False)
    )
    offer_id: int = Field(
        sa_column=Column(Integer, ForeignKey("sc_pay_offer.id", ondelete="CASCADE"), nullable=False, index=True)
    )
    user_id: int = Field(
        sa_column=Column(Integer, ForeignKey("user.id", ondelete="CASCADE"), nullable=False)
    )
    enrollment_id: int = Field(
        sa_column=Column(
            Integer, ForeignKey("sc_pay_enrollment.id", ondelete="CASCADE"), nullable=False, index=True
        )
    )
    provider: str = Field(sa_column=Column(String(32), nullable=False))
    method: str = Field(default="paypal", sa_column=Column(String(32), nullable=False, default="paypal"))
    provider_order_id: Optional[str] = Field(default=None, sa_column=Column(String(128), nullable=True))
    provider_capture_id: Optional[str] = Field(
        default=None, sa_column=Column(String(128), nullable=True, index=True)
    )
    status: str = Field(default="created", sa_column=Column(String(32), nullable=False, default="created"))
    amount: Decimal = Field(sa_column=Column(Numeric(12, 2), nullable=False))
    currency: str = Field(sa_column=Column(String(3), nullable=False))
    charged_amount: Optional[Decimal] = Field(default=None, sa_column=Column(Numeric(12, 2), nullable=True))
    charged_currency: Optional[str] = Field(default=None, sa_column=Column(String(3), nullable=True))
    fx_rate: Optional[Decimal] = Field(default=None, sa_column=Column(Numeric(18, 6), nullable=True))
    redirect_uri: str = Field(default="", sa_column=Column(Text, nullable=False, default=""))
    failure_reason: Optional[str] = Field(default=None, sa_column=Column(String(255), nullable=True))
    raw: dict = Field(default_factory=dict, sa_column=Column(JSON, nullable=False))
    paid_at: Optional[datetime] = Field(default=None, sa_column=Column(DateTime(timezone=True), nullable=True))
    creation_date: datetime = Field(default_factory=utcnow, sa_column=_created_column())
    update_date: datetime = Field(default_factory=utcnow, sa_column=_updated_column())


class PaymentsWebhookEvent(SQLModel, table=True):
    """Idempotency ledger for provider webhooks, keyed on the provider event id."""

    __tablename__ = "sc_pay_webhook_event"
    __table_args__ = (
        UniqueConstraint("provider", "event_id", name="uq_sc_pay_webhook_event"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    provider: str = Field(sa_column=Column(String(32), nullable=False))
    event_id: str = Field(sa_column=Column(String(128), nullable=False))
    org_id: int = Field(
        sa_column=Column(Integer, ForeignKey("organization.id", ondelete="CASCADE"), nullable=False, index=True)
    )
    event_type: str = Field(default="", sa_column=Column(String(128), nullable=False, default=""))
    status: str = Field(default="in_flight", sa_column=Column(String(32), nullable=False, default="in_flight"))
    attempts: int = Field(default=1, sa_column=Column(Integer, nullable=False, default=1))
    last_error: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    received_at: datetime = Field(default_factory=utcnow, sa_column=_created_column())
    processed_at: Optional[datetime] = Field(
        default=None, sa_column=Column(DateTime(timezone=True), nullable=True)
    )

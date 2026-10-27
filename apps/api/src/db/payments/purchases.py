"""Sanar y Criar: cart purchases paid by Pago Móvil (manual confirmation).

A purchase (``sc_pay_purchase``, public code ``SYC-XXXXXX``) groups one child
order per offer (``sc_pay_order`` with ``provider="manual"``) through
``sc_pay_purchase_item``. Only an org admin turns a purchase ``paid``; the
child orders then go through the same fulfillment as PayPal ones, so the
paywall, "Mis compras", customers and transactions keep working unchanged.

``sc_pay_fx_rate`` keeps the last good BCV rate of each day, the fallback
when the rate source is down. Same conventions as ``payments.py``: VARCHAR
statuses, timezone-aware dates, ``Numeric`` money (always ``Decimal``).
"""

from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import (
    JSON,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
)
from sqlmodel import Field, SQLModel

from src.db.payments.payments import _created_column, _updated_column, utcnow


class PaymentsPurchase(SQLModel, table=True):
    """One cart checkout. Status: pending | paid | rejected | cancelled |
    expired | voided. ``amount`` is the USD total of its items and
    ``amount_ves`` that total at ``fx_rate`` (rounded half up to 0.01)."""

    __tablename__ = "sc_pay_purchase"
    __table_args__ = (
        Index("ix_sc_pay_purchase_org_status_created", "org_id", "status", "creation_date"),
        Index("ix_sc_pay_purchase_user", "user_id", "org_id"),
        # The expiry sweep (every 5 min). A table created before this index
        # gets it from services/payments/schema.py at startup.
        Index("ix_sc_pay_purchase_status_expires", "status", "expires_at"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    purchase_uuid: str = Field(sa_column=Column(String(64), nullable=False, unique=True, index=True))
    code: str = Field(sa_column=Column(String(16), nullable=False, unique=True))
    org_id: int = Field(
        sa_column=Column(
            Integer, ForeignKey("organization.id", ondelete="CASCADE"), nullable=False, index=True
        )
    )
    user_id: int = Field(
        sa_column=Column(Integer, ForeignKey("user.id", ondelete="CASCADE"), nullable=False, index=True)
    )
    provider: str = Field(default="manual", sa_column=Column(String(32), nullable=False, default="manual"))
    method: str = Field(default="pago_movil", sa_column=Column(String(32), nullable=False, default="pago_movil"))
    status: str = Field(default="pending", sa_column=Column(String(16), nullable=False, default="pending"))
    currency: str = Field(default="USD", sa_column=Column(String(3), nullable=False, default="USD"))
    amount: Decimal = Field(sa_column=Column(Numeric(12, 2), nullable=False))
    fx_rate: Decimal = Field(sa_column=Column(Numeric(18, 6), nullable=False))
    fx_source: str = Field(sa_column=Column(String(16), nullable=False))
    fx_date: Optional[date] = Field(default=None, sa_column=Column(Date, nullable=True))
    amount_ves: Decimal = Field(sa_column=Column(Numeric(16, 2), nullable=False))
    expires_at: datetime = Field(sa_column=Column(DateTime(timezone=True), nullable=False))
    bank_reference: Optional[str] = Field(default=None, sa_column=Column(String(32), nullable=True, index=True))
    note: Optional[str] = Field(default=None, sa_column=Column(String(500), nullable=True))
    reject_reason: Optional[str] = Field(default=None, sa_column=Column(String(300), nullable=True))
    confirmed_by_user_id: Optional[int] = Field(
        default=None,
        sa_column=Column(Integer, ForeignKey("user.id", ondelete="SET NULL"), nullable=True),
    )
    confirmed_at: Optional[datetime] = Field(
        default=None, sa_column=Column(DateTime(timezone=True), nullable=True)
    )
    closed_at: Optional[datetime] = Field(default=None, sa_column=Column(DateTime(timezone=True), nullable=True))
    # Pago Móvil details shown when the purchase was created (audit trail).
    payment_details: dict = Field(default_factory=dict, sa_column=Column(JSON, nullable=False))
    # Internal notes: emails scheduled, reference_reused, stale rate...
    raw: dict = Field(default_factory=dict, sa_column=Column(JSON, nullable=False))
    creation_date: datetime = Field(default_factory=utcnow, sa_column=_created_column())
    update_date: datetime = Field(default_factory=utcnow, sa_column=_updated_column())


class PaymentsPurchaseItem(SQLModel, table=True):
    """One offer of a purchase and its child order (one per offer)."""

    __tablename__ = "sc_pay_purchase_item"
    __table_args__ = (
        UniqueConstraint("purchase_id", "offer_id", name="uq_sc_pay_purchase_item_offer"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    purchase_id: int = Field(
        sa_column=Column(
            Integer, ForeignKey("sc_pay_purchase.id", ondelete="CASCADE"), nullable=False, index=True
        )
    )
    order_id: int = Field(
        sa_column=Column(
            Integer, ForeignKey("sc_pay_order.id", ondelete="CASCADE"), nullable=False, unique=True
        )
    )
    offer_id: int = Field(
        sa_column=Column(Integer, ForeignKey("sc_pay_offer.id", ondelete="CASCADE"), nullable=False)
    )
    org_id: int = Field(
        sa_column=Column(Integer, ForeignKey("organization.id", ondelete="CASCADE"), nullable=False)
    )
    # Snapshot of the offer when it was bought.
    name: str = Field(sa_column=Column(String(255), nullable=False))
    amount: Decimal = Field(sa_column=Column(Numeric(12, 2), nullable=False))
    creation_date: datetime = Field(default_factory=utcnow, sa_column=_created_column())


class PaymentsFxRate(SQLModel, table=True):
    """Last good rate of each day per source (``bcv``): Bs. per US$."""

    __tablename__ = "sc_pay_fx_rate"
    __table_args__ = (
        UniqueConstraint("source", "rate_date", name="uq_sc_pay_fx_rate_source_date"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    source: str = Field(sa_column=Column(String(16), nullable=False))
    rate: Decimal = Field(sa_column=Column(Numeric(18, 6), nullable=False))
    rate_date: date = Field(sa_column=Column(Date, nullable=False))
    fetched_at: datetime = Field(sa_column=Column(DateTime(timezone=True), nullable=False))

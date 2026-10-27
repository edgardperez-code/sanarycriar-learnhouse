"""Sanar y Criar: cart purchases paid by Pago Móvil (sc_pay_purchase,
sc_pay_purchase_item, sc_pay_fx_rate)

Revision ID: 4d7b1e9a2c6f
Revises: 8c4e2a6f1d3b
Create Date: 2026-10-27 00:00:00.000000

Idempotent: the app's startup ``create_all`` normally creates these tables
first, so every table (and each of its indexes) is created only when it does
not exist yet. Names match what ``create_all`` generates.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '4d7b1e9a2c6f'
down_revision: Union[str, None] = '8c4e2a6f1d3b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _ts(name: str, nullable: bool = False) -> sa.Column:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable)


def _org_fk() -> sa.Column:
    return sa.Column('org_id', sa.Integer(), sa.ForeignKey('organization.id', ondelete='CASCADE'), nullable=False)


def _create_index(inspector, name: str, table: str, columns: list[str], unique: bool = False,
                  where: Union[str, None] = None) -> None:
    existing = {ix.get('name') for ix in inspector.get_indexes(table)} if inspector.has_table(table) else set()
    if name not in existing:
        partial = {'postgresql_where': sa.text(where), 'sqlite_where': sa.text(where)} if where else {}
        op.create_index(name, table, columns, unique=unique, **partial)


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())

    if not inspector.has_table('sc_pay_purchase'):
        op.create_table(
            'sc_pay_purchase',
            sa.Column('id', sa.Integer(), primary_key=True),
            sa.Column('purchase_uuid', sa.String(64), nullable=False),
            sa.Column('code', sa.String(16), nullable=False, unique=True),
            _org_fk(),
            sa.Column('user_id', sa.Integer(), sa.ForeignKey('user.id', ondelete='CASCADE'), nullable=False),
            sa.Column('provider', sa.String(32), nullable=False),
            sa.Column('method', sa.String(32), nullable=False),
            sa.Column('status', sa.String(16), nullable=False),
            sa.Column('currency', sa.String(3), nullable=False),
            sa.Column('amount', sa.Numeric(12, 2), nullable=False),
            sa.Column('fx_rate', sa.Numeric(18, 6), nullable=False),
            sa.Column('fx_source', sa.String(16), nullable=False),
            sa.Column('fx_date', sa.Date(), nullable=True),
            sa.Column('amount_ves', sa.Numeric(16, 2), nullable=False),
            _ts('expires_at'),
            sa.Column('bank_reference', sa.String(32), nullable=True),
            sa.Column('note', sa.String(500), nullable=True),
            sa.Column('reject_reason', sa.String(300), nullable=True),
            sa.Column('confirmed_by_user_id', sa.Integer(), sa.ForeignKey('user.id', ondelete='SET NULL'),
                      nullable=True),
            _ts('confirmed_at', nullable=True),
            _ts('closed_at', nullable=True),
            sa.Column('payment_details', sa.JSON(), nullable=False),
            sa.Column('raw', sa.JSON(), nullable=False),
            _ts('creation_date'),
            _ts('update_date'),
        )
        inspector = sa.inspect(op.get_bind())
    _create_index(inspector, 'ix_sc_pay_purchase_purchase_uuid', 'sc_pay_purchase', ['purchase_uuid'], unique=True)
    _create_index(inspector, 'ix_sc_pay_purchase_org_id', 'sc_pay_purchase', ['org_id'])
    _create_index(inspector, 'ix_sc_pay_purchase_user_id', 'sc_pay_purchase', ['user_id'])
    _create_index(inspector, 'ix_sc_pay_purchase_bank_reference', 'sc_pay_purchase', ['bank_reference'])
    _create_index(inspector, 'ix_sc_pay_purchase_org_status_created', 'sc_pay_purchase',
                  ['org_id', 'status', 'creation_date'])
    _create_index(inspector, 'ix_sc_pay_purchase_user', 'sc_pay_purchase', ['user_id', 'org_id'])
    _create_index(inspector, 'ix_sc_pay_purchase_status_expires', 'sc_pay_purchase', ['status', 'expires_at'])

    if not inspector.has_table('sc_pay_purchase_item'):
        op.create_table(
            'sc_pay_purchase_item',
            sa.Column('id', sa.Integer(), primary_key=True),
            sa.Column('purchase_id', sa.Integer(), sa.ForeignKey('sc_pay_purchase.id', ondelete='CASCADE'),
                      nullable=False),
            sa.Column('order_id', sa.Integer(), sa.ForeignKey('sc_pay_order.id', ondelete='CASCADE'),
                      nullable=False, unique=True),
            sa.Column('offer_id', sa.Integer(), sa.ForeignKey('sc_pay_offer.id', ondelete='CASCADE'), nullable=False),
            _org_fk(),
            sa.Column('name', sa.String(255), nullable=False),
            sa.Column('amount', sa.Numeric(12, 2), nullable=False),
            _ts('creation_date'),
            sa.UniqueConstraint('purchase_id', 'offer_id', name='uq_sc_pay_purchase_item_offer'),
        )
        inspector = sa.inspect(op.get_bind())
    _create_index(inspector, 'ix_sc_pay_purchase_item_purchase_id', 'sc_pay_purchase_item', ['purchase_id'])

    if not inspector.has_table('sc_pay_fx_rate'):
        op.create_table(
            'sc_pay_fx_rate',
            sa.Column('id', sa.Integer(), primary_key=True),
            sa.Column('source', sa.String(16), nullable=False),
            sa.Column('rate', sa.Numeric(18, 6), nullable=False),
            sa.Column('rate_date', sa.Date(), nullable=False),
            _ts('fetched_at'),
            sa.UniqueConstraint('source', 'rate_date', name='uq_sc_pay_fx_rate_source_date'),
        )

    # At most one pending Pago Móvil order per (buyer, offer). The app also
    # creates it at startup (src/services/payments/schema.py): production
    # runs create_all, not Alembic.
    _create_index(
        inspector, 'uq_sc_pay_order_manual_pending', 'sc_pay_order', ['user_id', 'offer_id'], unique=True,
        where="provider = 'manual' AND status = 'pending'",
    )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table('sc_pay_order') and 'uq_sc_pay_order_manual_pending' in {
        ix.get('name') for ix in inspector.get_indexes('sc_pay_order')
    }:
        op.drop_index('uq_sc_pay_order_manual_pending', table_name='sc_pay_order')
    for table in ('sc_pay_purchase_item', 'sc_pay_purchase', 'sc_pay_fx_rate'):
        if inspector.has_table(table):
            op.drop_table(table)

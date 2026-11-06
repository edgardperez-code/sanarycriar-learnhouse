"""Sanar y Criar: Zelle, Binance and bank-transfer purchases (sc_pay_purchase)

Revision ID: b6e2d9f4a1c8
Revises: 4d7b1e9a2c6f
Create Date: 2026-11-05 00:00:00.000000

Zelle (US$) and Binance (USDT) purchases have no exchange rate, so
``fx_rate``, ``fx_source`` and ``amount_ves`` become nullable; a Binance
transaction hash (64-66 characters) needs a longer ``bank_reference``.
Idempotent, like the startup helper that makes the same changes in production
(``services/payments/schema.py::ensure_payments_columns``): each column is
changed only when it is not in shape yet.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'b6e2d9f4a1c8'
down_revision: Union[str, None] = '4d7b1e9a2c6f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = 'sc_pay_purchase'
NULLABLE = (
    ('fx_rate', sa.Numeric(18, 6)),
    ('fx_source', sa.String(16)),
    ('amount_ves', sa.Numeric(16, 2)),
)


def _columns() -> dict:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(TABLE):
        return {}
    return {column['name']: column for column in inspector.get_columns(TABLE)}


def upgrade() -> None:
    columns = _columns()
    if not columns:
        return  # the app's create_all builds the table whole
    with op.batch_alter_table(TABLE) as batch:
        for name, type_ in NULLABLE:
            if name in columns and not columns[name].get('nullable', True):
                batch.alter_column(name, existing_type=type_, nullable=True)
        reference = columns.get('bank_reference')
        length = getattr(reference['type'], 'length', None) if reference else None
        if length is not None and length < 100:
            batch.alter_column('bank_reference', existing_type=sa.String(length), type_=sa.String(100),
                               existing_nullable=True)


def downgrade() -> None:
    # Only safe while every purchase has a rate and a short reference (no
    # Zelle or Binance purchase yet): NOT NULL refuses the others.
    columns = _columns()
    if not columns:
        return
    with op.batch_alter_table(TABLE) as batch:
        for name, type_ in NULLABLE:
            if name in columns and columns[name].get('nullable', False):
                batch.alter_column(name, existing_type=type_, nullable=False)
        if 'bank_reference' in columns:
            batch.alter_column('bank_reference', existing_type=sa.String(100), type_=sa.String(32),
                               existing_nullable=True)

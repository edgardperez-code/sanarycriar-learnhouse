"""Sanar y Criar: sc_newsletter_subscriber.name (the subscriber's first name)

Revision ID: 9a3f6c2e8b1d
Revises: 4d7b1e9a2c6f
Create Date: 2026-11-05 00:00:00.000000

Idempotent: the column is added only when the table exists and lacks it (the
app also adds it at startup on databases built by ``create_all``, see
``src/services/newsletter/schema.py``).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '9a3f6c2e8b1d'
down_revision: Union[str, None] = '4d7b1e9a2c6f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = 'sc_newsletter_subscriber'
_COLUMN = 'name'


def _columns() -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(_TABLE):
        return set()
    return {column['name'] for column in inspector.get_columns(_TABLE)}


def upgrade() -> None:
    columns = _columns()
    if columns and _COLUMN not in columns:
        op.add_column(_TABLE, sa.Column(_COLUMN, sa.String(80), nullable=True))


def downgrade() -> None:
    if _COLUMN in _columns():
        op.drop_column(_TABLE, _COLUMN)

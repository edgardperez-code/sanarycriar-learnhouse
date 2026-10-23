"""Sanar y Criar: activityprogress.client_ts (out-of-order progress saves)

Revision ID: 7b5dee2850d6
Revises: a9c8b7d6e5f4
Create Date: 2026-10-22 00:00:00.000000

Idempotent: the column is added only when missing (the app also adds it on
databases built by ``create_all``, see ``src/services/progress/schema.py``).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '7b5dee2850d6'
down_revision: Union[str, None] = 'a9c8b7d6e5f4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = 'activityprogress'
_COLUMN = 'client_ts'


def _columns() -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(_TABLE):
        return set()
    return {column['name'] for column in inspector.get_columns(_TABLE)}


def upgrade() -> None:
    columns = _columns()
    if columns and _COLUMN not in columns:
        op.add_column(_TABLE, sa.Column(_COLUMN, sa.BigInteger(), nullable=True))


def downgrade() -> None:
    if _COLUMN in _columns():
        op.drop_column(_TABLE, _COLUMN)

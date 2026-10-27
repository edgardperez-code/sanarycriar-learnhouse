"""Sanar y Criar: newsletter tables (sc_newsletter_settings, sc_newsletter_subscriber)

Revision ID: 3f1a9c7e5b2d
Revises: 7b5dee2850d6
Create Date: 2026-10-26 00:00:00.000000

Idempotent: the app's startup ``create_all`` normally creates these tables
first, so every table is created only when it does not exist yet.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '3f1a9c7e5b2d'
down_revision: Union[str, None] = '7b5dee2850d6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _ts(name: str, nullable: bool = False) -> sa.Column:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable)


def _org_fk() -> sa.Column:
    return sa.Column(
        'org_id', sa.Integer(), sa.ForeignKey('organization.id', ondelete='CASCADE'), nullable=False
    )


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())

    if not inspector.has_table('sc_newsletter_settings'):
        op.create_table(
            'sc_newsletter_settings',
            sa.Column('id', sa.Integer(), primary_key=True),
            _org_fk(),
            sa.Column('enabled', sa.Boolean(), nullable=False),
            sa.Column('title', sa.String(120), nullable=False),
            sa.Column('body', sa.Text(), nullable=False),
            sa.Column('button_label', sa.String(40), nullable=False),
            sa.Column('dismiss_label', sa.String(40), nullable=False),
            sa.Column('success_message', sa.String(300), nullable=False),
            sa.Column('privacy_note', sa.String(300), nullable=False),
            sa.Column('delay_seconds', sa.Integer(), nullable=False),
            sa.Column('dismiss_days', sa.Integer(), nullable=False),
            _ts('creation_date'),
            _ts('update_date'),
            sa.UniqueConstraint('org_id', name='uq_sc_newsletter_settings_org'),
        )

    if not inspector.has_table('sc_newsletter_subscriber'):
        op.create_table(
            'sc_newsletter_subscriber',
            sa.Column('id', sa.Integer(), primary_key=True),
            _org_fk(),
            sa.Column('email', sa.String(254), nullable=False),
            sa.Column('source', sa.String(16), nullable=False),
            sa.Column('page_path', sa.String(200), nullable=True),
            sa.Column('resend_contact_id', sa.String(64), nullable=True),
            sa.Column('sync_status', sa.String(16), nullable=False),
            sa.Column('sync_error', sa.String(300), nullable=True),
            _ts('synced_at', nullable=True),
            _ts('creation_date'),
            _ts('update_date'),
            sa.UniqueConstraint('org_id', 'email', name='uq_sc_newsletter_subscriber_org_email'),
        )
        op.create_index('ix_sc_newsletter_subscriber_org_id', 'sc_newsletter_subscriber', ['org_id'])
        op.create_index(
            'ix_sc_newsletter_subscriber_org_created', 'sc_newsletter_subscriber', ['org_id', 'creation_date']
        )
        op.create_index(
            'ix_sc_newsletter_subscriber_org_sync', 'sc_newsletter_subscriber', ['org_id', 'sync_status']
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for table in ('sc_newsletter_subscriber', 'sc_newsletter_settings'):
        if inspector.has_table(table):
            op.drop_table(table)

"""Sanar y Criar: payments (sc_pay_*) and activity progress tables

Revision ID: a9c8b7d6e5f4
Revises: e8f9a0b1c2d3
Create Date: 2026-10-22 00:00:00.000000

Idempotent: the app's startup ``create_all`` normally creates these tables
first, so every table is created only when it does not exist yet.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'a9c8b7d6e5f4'
down_revision: Union[str, None] = 'e8f9a0b1c2d3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _ts(name: str, nullable: bool = False) -> sa.Column:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable)


def _org_fk() -> sa.Column:
    return sa.Column(
        'org_id', sa.Integer(), sa.ForeignKey('organization.id', ondelete='CASCADE'), nullable=False
    )


def _create_payments_tables(has_table) -> None:
    if not has_table('sc_pay_config'):
        op.create_table(
            'sc_pay_config',
            sa.Column('id', sa.Integer(), primary_key=True),
            _org_fk(),
            sa.Column('provider', sa.String(32), nullable=False),
            sa.Column('enabled', sa.Boolean(), nullable=False),
            sa.Column('active', sa.Boolean(), nullable=False),
            sa.Column('provider_specific_id', sa.String(255), nullable=True),
            sa.Column('mode', sa.String(32), nullable=False),
            sa.Column('provider_config', sa.JSON(), nullable=False),
            _ts('creation_date'),
            _ts('update_date'),
            sa.UniqueConstraint('org_id', 'provider', name='uq_sc_pay_config_org_provider'),
        )
        op.create_index('ix_sc_pay_config_org_id', 'sc_pay_config', ['org_id'])

    if not has_table('sc_pay_group'):
        op.create_table(
            'sc_pay_group',
            sa.Column('id', sa.Integer(), primary_key=True),
            _org_fk(),
            sa.Column('name', sa.String(255), nullable=False),
            sa.Column('description', sa.Text(), nullable=False),
            _ts('creation_date'),
            _ts('update_date'),
        )
        op.create_index('ix_sc_pay_group_org_id', 'sc_pay_group', ['org_id'])

    if not has_table('sc_pay_group_resource'):
        op.create_table(
            'sc_pay_group_resource',
            sa.Column('id', sa.Integer(), primary_key=True),
            sa.Column(
                'payments_group_id', sa.Integer(),
                sa.ForeignKey('sc_pay_group.id', ondelete='CASCADE'), nullable=False,
            ),
            sa.Column('resource_uuid', sa.String(255), nullable=False),
            _org_fk(),
            _ts('creation_date'),
            _ts('update_date'),
            sa.UniqueConstraint('payments_group_id', 'resource_uuid', name='uq_sc_pay_group_resource'),
        )
        op.create_index('ix_sc_pay_group_resource_payments_group_id', 'sc_pay_group_resource', ['payments_group_id'])
        op.create_index('ix_sc_pay_group_resource_resource_uuid', 'sc_pay_group_resource', ['resource_uuid'])
        op.create_index('ix_sc_pay_group_resource_org_id', 'sc_pay_group_resource', ['org_id'])

    if not has_table('sc_pay_group_sync'):
        op.create_table(
            'sc_pay_group_sync',
            sa.Column('id', sa.Integer(), primary_key=True),
            sa.Column(
                'payments_group_id', sa.Integer(),
                sa.ForeignKey('sc_pay_group.id', ondelete='CASCADE'), nullable=False,
            ),
            sa.Column(
                'usergroup_id', sa.Integer(),
                sa.ForeignKey('usergroup.id', ondelete='CASCADE'), nullable=False,
            ),
            _org_fk(),
            _ts('creation_date'),
            _ts('update_date'),
            sa.UniqueConstraint('payments_group_id', 'usergroup_id', name='uq_sc_pay_group_sync'),
        )
        op.create_index('ix_sc_pay_group_sync_payments_group_id', 'sc_pay_group_sync', ['payments_group_id'])
        op.create_index('ix_sc_pay_group_sync_usergroup_id', 'sc_pay_group_sync', ['usergroup_id'])
        op.create_index('ix_sc_pay_group_sync_org_id', 'sc_pay_group_sync', ['org_id'])

    if not has_table('sc_pay_offer'):
        op.create_table(
            'sc_pay_offer',
            sa.Column('id', sa.Integer(), primary_key=True),
            sa.Column('offer_uuid', sa.String(64), nullable=False),
            _org_fk(),
            sa.Column(
                'payments_config_id', sa.Integer(),
                sa.ForeignKey('sc_pay_config.id', ondelete='SET NULL'), nullable=True,
            ),
            sa.Column(
                'payments_group_id', sa.Integer(),
                sa.ForeignKey('sc_pay_group.id', ondelete='SET NULL'), nullable=True,
            ),
            sa.Column('name', sa.String(255), nullable=False),
            sa.Column('description', sa.Text(), nullable=False),
            sa.Column('offer_type', sa.String(32), nullable=False),
            sa.Column('price_type', sa.String(32), nullable=False),
            sa.Column('billing_interval', sa.String(16), nullable=False),
            sa.Column('benefits', sa.Text(), nullable=False),
            sa.Column('amount', sa.Numeric(12, 2), nullable=False),
            sa.Column('currency', sa.String(3), nullable=False),
            sa.Column('is_publicly_listed', sa.Boolean(), nullable=False),
            sa.Column('archived', sa.Boolean(), nullable=False),
            _ts('creation_date'),
            _ts('update_date'),
        )
        op.create_index('ix_sc_pay_offer_offer_uuid', 'sc_pay_offer', ['offer_uuid'], unique=True)
        op.create_index('ix_sc_pay_offer_org_id', 'sc_pay_offer', ['org_id'])
        op.create_index('ix_sc_pay_offer_payments_group_id', 'sc_pay_offer', ['payments_group_id'])
        op.create_index('ix_sc_pay_offer_archived', 'sc_pay_offer', ['archived'])

    if not has_table('sc_pay_offer_resource'):
        op.create_table(
            'sc_pay_offer_resource',
            sa.Column('id', sa.Integer(), primary_key=True),
            sa.Column(
                'offer_id', sa.Integer(),
                sa.ForeignKey('sc_pay_offer.id', ondelete='CASCADE'), nullable=False,
            ),
            sa.Column('resource_uuid', sa.String(255), nullable=False),
            _org_fk(),
            _ts('creation_date'),
            _ts('update_date'),
            sa.UniqueConstraint('offer_id', 'resource_uuid', name='uq_sc_pay_offer_resource'),
        )
        op.create_index('ix_sc_pay_offer_resource_offer_id', 'sc_pay_offer_resource', ['offer_id'])
        op.create_index('ix_sc_pay_offer_resource_resource_uuid', 'sc_pay_offer_resource', ['resource_uuid'])
        op.create_index('ix_sc_pay_offer_resource_org_id', 'sc_pay_offer_resource', ['org_id'])

    if not has_table('sc_pay_enrollment'):
        op.create_table(
            'sc_pay_enrollment',
            sa.Column('id', sa.Integer(), primary_key=True),
            sa.Column('enrollment_uuid', sa.String(64), nullable=False, unique=True),
            sa.Column(
                'offer_id', sa.Integer(),
                sa.ForeignKey('sc_pay_offer.id', ondelete='CASCADE'), nullable=False,
            ),
            sa.Column(
                'user_id', sa.Integer(), sa.ForeignKey('user.id', ondelete='CASCADE'), nullable=False
            ),
            _org_fk(),
            sa.Column('status', sa.String(32), nullable=False),
            sa.Column('provider_specific_data', sa.JSON(), nullable=False),
            _ts('creation_date'),
            _ts('update_date'),
        )
        op.create_index('ix_sc_pay_enrollment_user_org', 'sc_pay_enrollment', ['user_id', 'org_id'])
        op.create_index('ix_sc_pay_enrollment_offer_status', 'sc_pay_enrollment', ['offer_id', 'status'])
        op.create_index('ix_sc_pay_enrollment_user_offer', 'sc_pay_enrollment', ['user_id', 'offer_id'])

    if not has_table('sc_pay_order'):
        op.create_table(
            'sc_pay_order',
            sa.Column('id', sa.Integer(), primary_key=True),
            sa.Column('order_uuid', sa.String(64), nullable=False),
            _org_fk(),
            sa.Column(
                'offer_id', sa.Integer(),
                sa.ForeignKey('sc_pay_offer.id', ondelete='CASCADE'), nullable=False,
            ),
            sa.Column(
                'user_id', sa.Integer(), sa.ForeignKey('user.id', ondelete='CASCADE'), nullable=False
            ),
            sa.Column(
                'enrollment_id', sa.Integer(),
                sa.ForeignKey('sc_pay_enrollment.id', ondelete='CASCADE'), nullable=False,
            ),
            sa.Column('provider', sa.String(32), nullable=False),
            sa.Column('method', sa.String(32), nullable=False),
            sa.Column('provider_order_id', sa.String(128), nullable=True),
            sa.Column('provider_capture_id', sa.String(128), nullable=True),
            sa.Column('status', sa.String(32), nullable=False),
            sa.Column('amount', sa.Numeric(12, 2), nullable=False),
            sa.Column('currency', sa.String(3), nullable=False),
            sa.Column('charged_amount', sa.Numeric(12, 2), nullable=True),
            sa.Column('charged_currency', sa.String(3), nullable=True),
            sa.Column('fx_rate', sa.Numeric(18, 6), nullable=True),
            sa.Column('redirect_uri', sa.Text(), nullable=False),
            sa.Column('failure_reason', sa.String(255), nullable=True),
            sa.Column('raw', sa.JSON(), nullable=False),
            _ts('paid_at', nullable=True),
            _ts('creation_date'),
            _ts('update_date'),
            sa.UniqueConstraint('provider', 'provider_order_id', name='uq_sc_pay_order_provider_order'),
        )
        op.create_index('ix_sc_pay_order_order_uuid', 'sc_pay_order', ['order_uuid'], unique=True)
        op.create_index('ix_sc_pay_order_offer_id', 'sc_pay_order', ['offer_id'])
        op.create_index('ix_sc_pay_order_enrollment_id', 'sc_pay_order', ['enrollment_id'])
        op.create_index('ix_sc_pay_order_provider_capture_id', 'sc_pay_order', ['provider_capture_id'])
        op.create_index('ix_sc_pay_order_status_created', 'sc_pay_order', ['status', 'creation_date'])
        op.create_index('ix_sc_pay_order_org_created', 'sc_pay_order', ['org_id', 'creation_date'])
        op.create_index('ix_sc_pay_order_user', 'sc_pay_order', ['user_id', 'org_id'])

    if not has_table('sc_pay_webhook_event'):
        op.create_table(
            'sc_pay_webhook_event',
            sa.Column('id', sa.Integer(), primary_key=True),
            sa.Column('provider', sa.String(32), nullable=False),
            sa.Column('event_id', sa.String(128), nullable=False),
            _org_fk(),
            sa.Column('event_type', sa.String(128), nullable=False),
            sa.Column('status', sa.String(32), nullable=False),
            sa.Column('attempts', sa.Integer(), nullable=False),
            sa.Column('last_error', sa.Text(), nullable=True),
            _ts('received_at'),
            _ts('processed_at', nullable=True),
            sa.UniqueConstraint('provider', 'event_id', name='uq_sc_pay_webhook_event'),
        )
        op.create_index('ix_sc_pay_webhook_event_org_id', 'sc_pay_webhook_event', ['org_id'])


def _create_progress_table(has_table) -> None:
    if has_table('activityprogress'):
        return
    op.create_table(
        'activityprogress',
        sa.Column('id', sa.Integer(), primary_key=True),
        _org_fk(),
        sa.Column('user_id', sa.Integer(), sa.ForeignKey('user.id', ondelete='CASCADE'), nullable=False),
        sa.Column('course_id', sa.Integer(), sa.ForeignKey('course.id', ondelete='CASCADE'), nullable=False),
        sa.Column('activity_id', sa.Integer(), sa.ForeignKey('activity.id', ondelete='CASCADE'), nullable=False),
        sa.Column('position_seconds', sa.Float(), nullable=False),
        sa.Column('duration_seconds', sa.Float(), nullable=True),
        sa.Column('max_position_seconds', sa.Float(), nullable=False),
        sa.Column('page', sa.Integer(), nullable=True),
        sa.Column('completed', sa.Boolean(), nullable=False),
        _ts('creation_date'),
        _ts('update_date'),
        sa.UniqueConstraint('user_id', 'activity_id', name='uq_activityprogress_user_activity'),
    )
    op.create_index('ix_activityprogress_org_id', 'activityprogress', ['org_id'])
    op.create_index(
        'ix_activityprogress_user_course_updated', 'activityprogress', ['user_id', 'course_id', 'update_date']
    )


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())

    def has_table(name: str) -> bool:
        return inspector.has_table(name)

    _create_payments_tables(has_table)
    _create_progress_table(has_table)


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for table in (
        'activityprogress',
        'sc_pay_webhook_event',
        'sc_pay_order',
        'sc_pay_enrollment',
        'sc_pay_offer_resource',
        'sc_pay_offer',
        'sc_pay_group_sync',
        'sc_pay_group_resource',
        'sc_pay_group',
        'sc_pay_config',
    ):
        if inspector.has_table(table):
            op.drop_table(table)

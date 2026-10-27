"""Sanar y Criar: blog tables (sc_blog_post, sc_blog_ai_job)

Revision ID: 8c4e2a6f1d3b
Revises: 3f1a9c7e5b2d
Create Date: 2026-10-26 00:00:00.000000

Idempotent: the app's startup ``create_all`` normally creates these tables
first, so every table is created only when it does not exist yet.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '8c4e2a6f1d3b'
down_revision: Union[str, None] = '3f1a9c7e5b2d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _ts(name: str, nullable: bool = False) -> sa.Column:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable)


def _org_fk() -> sa.Column:
    return sa.Column('org_id', sa.Integer(), sa.ForeignKey('organization.id', ondelete='CASCADE'), nullable=False)


def _user_fk() -> sa.Column:
    return sa.Column('created_by_user_id', sa.Integer(), sa.ForeignKey('user.id', ondelete='SET NULL'), nullable=True)


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())

    if not inspector.has_table('sc_blog_post'):
        op.create_table(
            'sc_blog_post',
            sa.Column('id', sa.Integer(), primary_key=True),
            sa.Column('post_uuid', sa.String(36), nullable=False),
            _org_fk(),
            sa.Column('slug', sa.String(80), nullable=False),
            sa.Column('title', sa.String(120), nullable=False),
            sa.Column('kind', sa.String(16), nullable=False),
            sa.Column('category', sa.String(32), nullable=False),
            sa.Column('status', sa.String(16), nullable=False),
            sa.Column('excerpt', sa.String(300), nullable=False),
            sa.Column('summary', sa.Text(), nullable=False),
            sa.Column('key_takeaways', sa.JSON(), nullable=False),
            sa.Column('content_md', sa.Text(), nullable=False),
            sa.Column('content_html', sa.Text(), nullable=False),
            sa.Column('faq', sa.JSON(), nullable=False),
            sa.Column('meta_title', sa.String(120), nullable=False),
            sa.Column('meta_description', sa.String(300), nullable=False),
            sa.Column('keywords', sa.JSON(), nullable=False),
            sa.Column('cover_image', sa.String(200), nullable=True),
            sa.Column('og_image', sa.String(200), nullable=True),
            sa.Column('cover_alt', sa.String(200), nullable=False),
            sa.Column('word_count', sa.Integer(), nullable=False),
            sa.Column('source', sa.String(16), nullable=False),
            sa.Column('ai_model', sa.String(64), nullable=True),
            _ts('published_at', nullable=True),
            _user_fk(),
            _ts('creation_date'),
            _ts('update_date'),
            sa.UniqueConstraint('org_id', 'slug', name='uq_sc_blog_post_org_slug'),
            sa.UniqueConstraint('post_uuid', name='uq_sc_blog_post_uuid'),
        )
        op.create_index('ix_sc_blog_post_org_id', 'sc_blog_post', ['org_id'])
        op.create_index('ix_sc_blog_post_org_status_published', 'sc_blog_post', ['org_id', 'status', 'published_at'])
        op.create_index('ix_sc_blog_post_org_updated', 'sc_blog_post', ['org_id', 'update_date'])

    if not inspector.has_table('sc_blog_ai_job'):
        op.create_table(
            'sc_blog_ai_job',
            sa.Column('id', sa.Integer(), primary_key=True),
            _org_fk(),
            sa.Column('post_id', sa.Integer(), sa.ForeignKey('sc_blog_post.id', ondelete='SET NULL'), nullable=True),
            sa.Column('operation', sa.String(16), nullable=False),
            sa.Column('status', sa.String(16), nullable=False),
            sa.Column('error', sa.String(300), nullable=True),
            sa.Column('applied', sa.Boolean(), nullable=False),
            sa.Column('result_json', sa.JSON(), nullable=True),
            sa.Column('meta_json', sa.JSON(), nullable=False),
            sa.Column('usage_json', sa.JSON(), nullable=True),
            sa.Column('model', sa.String(64), nullable=True),
            _user_fk(),
            _ts('started_at', nullable=True),
            _ts('finished_at', nullable=True),
            _ts('creation_date'),
            _ts('update_date'),
        )
        op.create_index('ix_sc_blog_ai_job_org_id', 'sc_blog_ai_job', ['org_id'])
        op.create_index('ix_sc_blog_ai_job_org_status', 'sc_blog_ai_job', ['org_id', 'status'])
        op.create_index('ix_sc_blog_ai_job_org_created', 'sc_blog_ai_job', ['org_id', 'creation_date'])


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for table in ('sc_blog_ai_job', 'sc_blog_post'):
        if inspector.has_table(table):
            op.drop_table(table)

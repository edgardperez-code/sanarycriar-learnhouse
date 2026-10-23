"""Sanar y Criar: out-of-order progress saves (optional ``client_ts``) and the
schema guard that adds the column to tables built before it existed."""

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession as SAAsyncSession, create_async_engine
from sqlmodel import func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from src.db.activity_progress import ActivityProgress
from src.db.trail_steps import TrailStep
from src.services.progress import schema as progress_schema

BASE = "/api/v1/progress"


async def _row(db) -> ActivityProgress:
    return (await db.execute(
        select(ActivityProgress).execution_options(populate_existing=True)
    )).scalars().one()


class TestClientTimestamp:
    async def test_older_save_does_not_move_the_position_back(self, client, current, db, org_config, regular_user,
                                                              course, video_activity):
        current.set(regular_user)
        url = f"{BASE}/activity/{video_activity.activity_uuid}"
        final = await client.put(url, json={"position_seconds": 50, "duration_seconds": 300, "client_ts": 2_000})
        assert final.status_code == 200, final.text
        assert final.json()["client_ts"] == 2_000
        stored_update = (await _row(db)).update_date

        # The periodic save taken before the final one lands afterwards.
        late = await client.put(url, json={"position_seconds": 40, "duration_seconds": 300, "client_ts": 1_000})
        assert late.status_code == 200, late.text
        body = late.json()
        assert body["position_seconds"] == 50 and body["client_ts"] == 2_000
        row = await _row(db)
        assert row.position_seconds == 50 and row.client_ts == 2_000
        assert row.update_date == stored_update  # "last touched" is not bumped either

        # A newer save may go backwards (the learner rewound): it wins.
        rewind = await client.put(url, json={"position_seconds": 10, "client_ts": 3_000})
        assert rewind.json()["position_seconds"] == 10 and rewind.json()["client_ts"] == 3_000
        assert rewind.json()["max_position_seconds"] == 50

    async def test_older_stamp_wins_once_the_stored_save_is_not_recent(
        self, client, current, db, org_config, regular_user, course, video_activity
    ):
        # Another device whose clock runs ahead must not freeze the position
        # for good: past the window, last write wins again.
        from datetime import timedelta

        from src.services.progress.progress import _CLIENT_TS_WINDOW

        current.set(regular_user)
        url = f"{BASE}/activity/{video_activity.activity_uuid}"
        await client.put(url, json={"position_seconds": 50, "client_ts": 9_000_000})
        row = await _row(db)
        row.update_date = row.update_date - _CLIENT_TS_WINDOW - timedelta(seconds=5)
        db.add(row)
        await db.commit()

        later = await client.put(url, json={"position_seconds": 70, "client_ts": 1_000})
        assert later.status_code == 200, later.text
        assert later.json()["position_seconds"] == 70 and later.json()["client_ts"] == 1_000
        # ...and the new stamp orders the saves that follow it.
        late = await client.put(url, json={"position_seconds": 60, "client_ts": 900})
        assert late.json()["position_seconds"] == 70

    async def test_same_timestamp_is_accepted(self, client, current, org_config, regular_user, course,
                                              video_activity):
        current.set(regular_user)
        url = f"{BASE}/activity/{video_activity.activity_uuid}"
        await client.put(url, json={"position_seconds": 20, "client_ts": 5_000})
        again = await client.put(url, json={"position_seconds": 21, "client_ts": 5_000})
        assert again.json()["position_seconds"] == 21

    async def test_stale_save_still_counts_toward_furthest_point_and_completion(
        self, client, current, db, org_config, regular_user, course, video_activity
    ):
        current.set(regular_user)
        url = f"{BASE}/activity/{video_activity.activity_uuid}"
        await client.put(url, json={"position_seconds": 5, "client_ts": 9_000})  # rewound to the start
        late = await client.put(url, json={"position_seconds": 95, "duration_seconds": 100, "client_ts": 8_000})
        body = late.json()
        assert body["position_seconds"] == 5  # position untouched
        assert body["duration_seconds"] == 100  # was missing: filled in
        assert body["max_position_seconds"] == 95
        assert body["completed"] is True  # watched past 90% at some point
        steps = (await db.execute(
            select(func.count()).select_from(TrailStep).where(TrailStep.activity_id == video_activity.id)
        )).scalar()
        assert steps == 1

    async def test_stale_page_is_ignored(self, client, current, org_config, regular_user, course, activity):
        current.set(regular_user)
        url = f"{BASE}/activity/{activity.activity_uuid}"
        await client.put(url, json={"position_seconds": 0, "page": 7, "client_ts": 2_000})
        late = await client.put(url, json={"position_seconds": 0, "page": 3, "client_ts": 1_500})
        assert late.json()["page"] == 7

    async def test_clients_without_client_ts_keep_last_write_wins(self, client, current, db, org_config,
                                                                   regular_user, course, video_activity):
        current.set(regular_user)
        url = f"{BASE}/activity/{video_activity.activity_uuid}"
        first = await client.put(url, json={"position_seconds": 30})
        assert first.json()["client_ts"] is None
        assert (await client.put(url, json={"position_seconds": 12})).json()["position_seconds"] == 12

        # Mixed: a stamped save, then an unstamped one (applied, stamp kept),
        # then a stamped one older than the stamp (ignored).
        await client.put(url, json={"position_seconds": 40, "client_ts": 4_000})
        legacy = (await client.put(url, json={"position_seconds": 44})).json()
        assert legacy["position_seconds"] == 44 and legacy["client_ts"] == 4_000
        stale = (await client.put(url, json={"position_seconds": 1, "client_ts": 3_999})).json()
        assert stale["position_seconds"] == 44
        assert (await _row(db)).client_ts == 4_000

    async def test_first_save_may_be_stamped(self, client, current, db, org_config, regular_user, course,
                                             video_activity):
        current.set(regular_user)
        url = f"{BASE}/activity/{video_activity.activity_uuid}"
        # Date.now()-sized value; a fractional one (performance clock) is floored.
        response = await client.put(url, json={"position_seconds": 3, "client_ts": 1_792_000_000_123.9})
        assert response.status_code == 200, response.text
        assert response.json()["client_ts"] == 1_792_000_000_123
        assert (await _row(db)).client_ts == 1_792_000_000_123

    @pytest.mark.parametrize("bad", [-1, "soon", 10 ** 14])
    async def test_rejects_invalid_client_ts(self, client, current, org_config, regular_user, course,
                                             video_activity, bad):
        current.set(regular_user)
        response = await client.put(f"{BASE}/activity/{video_activity.activity_uuid}",
                                    json={"position_seconds": 3, "client_ts": bad})
        assert response.status_code == 422

    async def test_reads_expose_client_ts(self, client, current, org_config, regular_user, course,
                                          video_activity):
        current.set(regular_user)
        url = f"{BASE}/activity/{video_activity.activity_uuid}"
        await client.put(url, json={"position_seconds": 8, "client_ts": 7_000})
        assert (await client.get(url)).json()["client_ts"] == 7_000


class TestSchemaGuard:
    async def _columns(self, session) -> set[str]:
        rows = (await session.execute(text("PRAGMA table_info(activityprogress)"))).all()
        return {row[1] for row in rows}

    async def test_adds_the_column_to_an_old_table_once(self):
        engine = create_async_engine("sqlite+aiosqlite://")
        try:
            async with engine.begin() as conn:
                await conn.execute(text(
                    "CREATE TABLE activityprogress (id INTEGER PRIMARY KEY, position_seconds FLOAT NOT NULL)"
                ))
            progress_schema.reset_progress_schema_flag()
            async with AsyncSession(engine) as session:
                assert "client_ts" not in await self._columns(session)
                await progress_schema.ensure_progress_schema(session)
                assert "client_ts" in await self._columns(session)
                # Idempotent, also when the flag is cleared (another process).
                progress_schema.reset_progress_schema_flag()
                await progress_schema.ensure_progress_schema(session)
                assert progress_schema._ready is True
                await session.execute(text("INSERT INTO activityprogress (position_seconds, client_ts) VALUES (1, 5)"))
                await session.commit()
        finally:
            await engine.dispose()
            progress_schema.reset_progress_schema_flag()

    async def test_never_raises(self):
        class Broken(SAAsyncSession):
            async def connection(self, *args, **kwargs):
                raise RuntimeError("database is down")

        engine = create_async_engine("sqlite+aiosqlite://")
        try:
            progress_schema.reset_progress_schema_flag()
            async with Broken(engine) as session:
                await progress_schema.ensure_progress_schema(session)
            assert progress_schema._ready is False
        finally:
            await engine.dispose()
            progress_schema.reset_progress_schema_flag()

"""Sanar y Criar: playback/reading progress API."""

from datetime import datetime
from decimal import Decimal
from uuid import uuid4

from sqlmodel import func, select

from src.db.activity_progress import ActivityProgress
from src.db.payments.payments import PaymentsEnrollment, PaymentsOffer, PaymentsOfferResource
from src.db.trail_steps import TrailStep
from src.tests.payments.conftest import ORG_ID

BASE = "/api/v1/progress"


async def _steps(db, user_id, activity_id=None) -> int:
    stmt = select(func.count()).select_from(TrailStep).where(TrailStep.user_id == user_id)
    if activity_id is not None:
        stmt = stmt.where(TrailStep.activity_id == activity_id)
    return (await db.execute(stmt)).scalar()


async def _sell(db, course) -> PaymentsOffer:
    offer = PaymentsOffer(offer_uuid=str(uuid4()), org_id=ORG_ID, name="Oferta", amount=Decimal("9.00"), currency="USD")
    db.add(offer)
    await db.commit()
    await db.refresh(offer)
    db.add(PaymentsOfferResource(offer_id=offer.id, resource_uuid=course.course_uuid, org_id=ORG_ID))
    await db.commit()
    return offer


class TestProgress:
    async def test_upsert_keeps_furthest_point(self, client, current, db, org_config, regular_user, course, video_activity):
        current.set(regular_user)
        first = await client.put(f"{BASE}/activity/{video_activity.activity_uuid}",
                                 json={"position_seconds": 40, "duration_seconds": 200})
        assert first.status_code == 200, first.text
        assert first.json()["max_position_seconds"] == 40 and first.json()["completed"] is False

        back = await client.put(f"{BASE}/activity/{video_activity.activity_uuid}", json={"position_seconds": 12.5})
        body = back.json()
        assert body["position_seconds"] == 12.5
        assert body["max_position_seconds"] == 40
        assert body["duration_seconds"] == 200  # kept when not sent
        rows = (await db.execute(select(func.count()).select_from(ActivityProgress))).scalar()
        assert rows == 1

        # Position is clamped to the duration (+2 s of slack).
        over = await client.put(f"{BASE}/activity/{video_activity.activity_uuid}",
                                json={"position_seconds": 500, "duration_seconds": 100})
        assert over.json()["position_seconds"] == 102

    async def test_video_auto_completes_at_90_percent(self, client, current, db, org_config, regular_user, course, video_activity):
        current.set(regular_user)
        await client.put(f"{BASE}/activity/{video_activity.activity_uuid}", json={"position_seconds": 80, "duration_seconds": 100})
        assert await _steps(db, regular_user.id) == 0
        response = await client.put(f"{BASE}/activity/{video_activity.activity_uuid}",
                                    json={"position_seconds": 91, "duration_seconds": 100})
        assert response.json()["completed"] is True
        assert await _steps(db, regular_user.id, video_activity.id) == 1
        # Further saves do not create more steps.
        await client.put(f"{BASE}/activity/{video_activity.activity_uuid}", json={"position_seconds": 99, "duration_seconds": 100})
        assert await _steps(db, regular_user.id, video_activity.id) == 1

    async def test_explicit_completed_for_non_video(self, client, current, db, org_config, regular_user, course, activity):
        current.set(regular_user)
        response = await client.put(f"{BASE}/activity/{activity.activity_uuid}",
                                    json={"position_seconds": 0, "page": 7, "completed": True})
        assert response.status_code == 200
        assert response.json()["page"] == 7 and response.json()["completed"] is True
        assert await _steps(db, regular_user.id, activity.id) == 1

    async def test_402_when_unpaid_and_ok_after_purchase(self, client, current, db, org_config, regular_user, course, video_activity):
        offer = await _sell(db, course)
        current.set(regular_user)
        response = await client.put(f"{BASE}/activity/{video_activity.activity_uuid}", json={"position_seconds": 5})
        assert response.status_code == 402
        assert (await db.execute(select(func.count()).select_from(ActivityProgress))).scalar() == 0

        db.add(PaymentsEnrollment(enrollment_uuid=str(uuid4()), offer_id=offer.id, user_id=regular_user.id,
                                  org_id=ORG_ID, status="active", provider_specific_data={}))
        await db.commit()
        response = await client.put(f"{BASE}/activity/{video_activity.activity_uuid}", json={"position_seconds": 5})
        assert response.status_code == 200

    async def test_requires_session(self, client, current, org_config, course, video_activity):
        current.set(None)
        response = await client.put(f"{BASE}/activity/{video_activity.activity_uuid}", json={"position_seconds": 5})
        assert response.status_code == 401

    async def test_rejects_negative_position(self, client, current, org_config, regular_user, course, video_activity):
        current.set(regular_user)
        response = await client.put(f"{BASE}/activity/{video_activity.activity_uuid}", json={"position_seconds": -1})
        assert response.status_code == 422

    async def test_course_and_activity_reads(self, client, current, org_config, regular_user, course, activity, video_activity):
        current.set(regular_user)
        assert (await client.get(f"{BASE}/activity/{video_activity.activity_uuid}")).json() is None
        empty = (await client.get(f"{BASE}/course/{course.course_uuid}")).json()
        assert empty == {"last": None, "items": []}

        await client.put(f"{BASE}/activity/{activity.activity_uuid}", json={"position_seconds": 0, "page": 3})
        await client.put(f"{BASE}/activity/{video_activity.activity_uuid}",
                         json={"position_seconds": 65, "duration_seconds": 300})
        progress = (await client.get(f"{BASE}/course/{course.course_uuid}")).json()
        last = progress["last"]
        assert last["activity_uuid"] == video_activity.activity_uuid
        assert last["activity_type"] == "TYPE_VIDEO"
        assert last["activity_name"] == "Video Activity" and last["chapter_name"] == "Test Chapter"
        assert last["position_seconds"] == 65 and last["duration_seconds"] == 300
        assert {i["activity_uuid"] for i in progress["items"]} == {activity.activity_uuid, video_activity.activity_uuid}

        single = (await client.get(f"{BASE}/activity/{video_activity.activity_uuid}")).json()
        assert single["position_seconds"] == 65 and single["course_uuid"] == course.course_uuid


class TestProgressCleanup:
    async def test_unmarking_and_leaving_course_clear_progress(self, client, current, db, org_config, regular_user,
                                                               course, video_activity, mock_request):
        from src.services.trail.trail import remove_activity_from_trail, remove_course_from_trail

        current.set(regular_user)
        await client.put(f"{BASE}/activity/{video_activity.activity_uuid}",
                         json={"position_seconds": 95, "duration_seconds": 100})
        assert await _steps(db, regular_user.id, video_activity.id) == 1

        await remove_activity_from_trail(mock_request, regular_user, video_activity.activity_uuid, db)
        assert await _steps(db, regular_user.id, video_activity.id) == 0
        assert (await db.execute(select(func.count()).select_from(ActivityProgress))).scalar() == 0

        await client.put(f"{BASE}/activity/{video_activity.activity_uuid}",
                         json={"position_seconds": 30, "duration_seconds": 100})
        await remove_course_from_trail(mock_request, regular_user, course.course_uuid, db)
        assert (await db.execute(select(func.count()).select_from(ActivityProgress))).scalar() == 0

    async def test_admin_reset_clears_progress(self, db, org, course, video_activity, regular_user):
        from src.db.users import APITokenUser
        from src.services.admin.admin import reset_user_progress

        now = datetime.now()
        db.add(ActivityProgress(org_id=org.id, user_id=regular_user.id, course_id=course.id,
                                activity_id=video_activity.id, position_seconds=10, creation_date=now,
                                update_date=now))
        await db.commit()
        token = APITokenUser(
            id=1, user_uuid="apitoken_x", username="api_token", org_id=org.id, token_name="t",
            created_by_user_id=regular_user.id,
            rights={"courses": {"action_create": True, "action_read": True, "action_update": True,
                                "action_delete": True}},
        )
        result = await reset_user_progress(token, regular_user.id, course.course_uuid, db)
        assert result["steps_deleted"] == 0
        assert (await db.execute(select(func.count()).select_from(ActivityProgress))).scalar() == 0

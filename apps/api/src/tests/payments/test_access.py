"""Sanar y Criar: who may consume a course for sale (the paywall hook)."""

from datetime import datetime
from decimal import Decimal
from uuid import uuid4

import pytest
from fastapi import HTTPException

from src.core.ee_hooks import check_ee_activity_paid_access
from src.db.payments.payments import (
    PaymentsEnrollment,
    PaymentsGroup,
    PaymentsGroupResource,
    PaymentsOffer,
    PaymentsOfferResource,
)
from src.db.users import AnonymousUser
from src.services.courses.activities.access import (
    redact_activity_for_reader,
    verify_activity_reader_access,
)
from src.services.payments.access import (
    check_activity_paid_access,
    check_enrollment_access,
    get_course_access,
)
from src.tests.payments.conftest import ORG_ID


async def _offer(db, course_uuid=None, *, archived=False, group_id=None, name="Oferta") -> PaymentsOffer:
    offer = PaymentsOffer(
        offer_uuid=str(uuid4()), org_id=ORG_ID, name=name, amount=Decimal("10.00"), currency="USD",
        archived=archived, payments_group_id=group_id,
    )
    db.add(offer)
    await db.commit()
    await db.refresh(offer)
    if course_uuid:
        db.add(PaymentsOfferResource(offer_id=offer.id, resource_uuid=course_uuid, org_id=ORG_ID))
        await db.commit()
    return offer


async def _enroll(db, user_id, offer, status="active") -> PaymentsEnrollment:
    enrollment = PaymentsEnrollment(
        enrollment_uuid=str(uuid4()), offer_id=offer.id, user_id=user_id, org_id=ORG_ID, status=status,
        provider_specific_data={},
    )
    db.add(enrollment)
    await db.commit()
    return enrollment


class TestCourseAccess:
    async def test_free_course_without_offers(self, db, course, activity, regular_user):
        access = await get_course_access(db, AnonymousUser(), course)
        assert access.as_dict() == {"for_sale": False, "has_access": True, "reason": "free", "offers_count": 0}
        assert await check_activity_paid_access(None, activity.id, AnonymousUser(), db) is True
        assert await check_ee_activity_paid_access(None, activity.id, regular_user, db) is True

    async def test_paid_course_anonymous(self, db, course, activity):
        await _offer(db, course.course_uuid)
        access = await get_course_access(db, AnonymousUser(), course)
        assert access.as_dict() == {"for_sale": True, "has_access": False, "reason": "anonymous", "offers_count": 1}
        assert await check_ee_activity_paid_access(None, activity.id, AnonymousUser(), db) is False

    async def test_paid_course_without_purchase(self, db, course, activity, regular_user):
        await _offer(db, course.course_uuid)
        access = await get_course_access(db, regular_user, course)
        assert (access.for_sale, access.has_access, access.reason) == (True, False, "none")
        assert await check_ee_activity_paid_access(None, activity.id, regular_user, db) is False

    async def test_paid_course_purchased(self, db, course, activity, regular_user):
        offer = await _offer(db, course.course_uuid)
        await _enroll(db, regular_user.id, offer, "active")
        access = await get_course_access(db, regular_user, course)
        assert (access.has_access, access.reason) == (True, "purchased")
        assert await check_ee_activity_paid_access(None, activity.id, regular_user, db) is True
        assert await check_enrollment_access(course.course_uuid, regular_user.id, db) is True

    @pytest.mark.parametrize("status", ["pending", "refunded", "cancelled", "failed"])
    async def test_non_granting_enrollment_statuses(self, db, course, regular_user, status):
        offer = await _offer(db, course.course_uuid)
        await _enroll(db, regular_user.id, offer, status)
        assert (await get_course_access(db, regular_user, course)).has_access is False

    async def test_completed_enrollment_grants(self, db, course, regular_user):
        offer = await _offer(db, course.course_uuid)
        await _enroll(db, regular_user.id, offer, "completed")
        assert (await get_course_access(db, regular_user, course)).has_access is True

    async def test_admin_passes(self, db, course, activity, admin_user):
        await _offer(db, course.course_uuid)
        access = await get_course_access(db, admin_user, course)
        assert (access.has_access, access.reason) == (True, "admin")

    async def test_author_passes(self, db, course, activity, author_user):
        await _offer(db, course.course_uuid)
        access = await get_course_access(db, author_user, course)
        assert (access.has_access, access.reason) == (True, "author")

    async def test_archived_offer_still_grants_past_buyers(self, db, course, activity, regular_user, admin_user, user_role, org):
        old = await _offer(db, course.course_uuid, archived=False, name="Vieja")
        await _enroll(db, regular_user.id, old, "active")
        old.archived = True
        db.add(old)
        await db.commit()
        # Still for sale through a newer offer.
        await _offer(db, course.course_uuid, name="Nueva")
        access = await get_course_access(db, regular_user, course)
        assert (access.for_sale, access.has_access, access.reason) == (True, True, "purchased")
        assert access.offers_count == 1  # archived offers do not count as "for sale"

    async def test_only_archived_offers_means_free(self, db, course):
        await _offer(db, course.course_uuid, archived=True)
        access = await get_course_access(db, AnonymousUser(), course)
        assert (access.for_sale, access.reason) == (False, "free")

    async def test_course_covered_through_payments_group(self, db, course, regular_user):
        group = PaymentsGroup(org_id=ORG_ID, name="Paquete")
        db.add(group)
        await db.commit()
        await db.refresh(group)
        db.add(PaymentsGroupResource(payments_group_id=group.id, resource_uuid=course.course_uuid, org_id=ORG_ID))
        await db.commit()
        offer = await _offer(db, None, group_id=group.id)
        access = await get_course_access(db, regular_user, course)
        assert (access.for_sale, access.has_access) == (True, False)
        await _enroll(db, regular_user.id, offer, "active")
        assert (await get_course_access(db, regular_user, course)).has_access is True


class TestReaderGate:
    async def test_unpaid_reader_gets_402_and_redacted_content(self, db, org_config, course, activity, regular_user, mock_request):
        await _offer(db, course.course_uuid)
        with pytest.raises(HTTPException) as exc:
            await verify_activity_reader_access(mock_request, activity, course, regular_user, db)
        assert exc.value.status_code == 402
        from src.db.courses.activities import ActivityRead

        redacted = await redact_activity_for_reader(
            mock_request, ActivityRead.model_validate(activity), activity, course, regular_user, db
        )
        assert redacted.content == {"paid_access": False}

    async def test_buyer_passes_reader_gate(self, db, org_config, course, activity, regular_user, mock_request):
        offer = await _offer(db, course.course_uuid)
        await _enroll(db, regular_user.id, offer)
        await verify_activity_reader_access(mock_request, activity, course, regular_user, db)

    async def test_memoized_per_request(self, db, course, activity, regular_user, mock_request):
        await _offer(db, course.course_uuid)
        assert await check_activity_paid_access(mock_request, activity.id, regular_user, db) is False
        # A purchase recorded mid-request is not seen by the same request.
        offer = (await db.execute(__import__("sqlmodel").select(PaymentsOffer))).scalars().first()
        await _enroll(db, regular_user.id, offer)
        assert await check_activity_paid_access(mock_request, activity.id, regular_user, db) is False
        assert await check_activity_paid_access(None, activity.id, regular_user, db) is True


class TestStartCourseGate:
    async def _trail(self, db, user):
        from src.db.trails import Trail

        db.add(Trail(org_id=ORG_ID, user_id=user.id, trail_uuid="trail_x",
                     creation_date=str(datetime.now()), update_date=str(datetime.now())))
        await db.commit()

    async def test_add_course_to_trail_402_for_unpaid(self, db, org_config, course, activity, regular_user, mock_request):
        from src.services.trail.trail import add_course_to_trail

        await self._trail(db, regular_user)
        await _offer(db, course.course_uuid)
        with pytest.raises(HTTPException) as exc:
            await add_course_to_trail(mock_request, regular_user, course.course_uuid, db)
        assert exc.value.status_code == 402
        assert exc.value.detail == {"code": "PAYMENT_REQUIRED"}

    async def test_add_course_to_trail_ok_for_buyer_and_free_course(self, db, org_config, course, activity, regular_user, mock_request):
        from src.services.trail.trail import add_course_to_trail

        await self._trail(db, regular_user)
        trail = await add_course_to_trail(mock_request, regular_user, course.course_uuid, db)
        assert len(trail.runs) == 1  # free course: unchanged behaviour

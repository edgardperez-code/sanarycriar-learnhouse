"""Sanar y Criar: payment groups (bundles of courses shared by offers) and
their usergroup syncs."""

from fastapi import HTTPException
from pydantic import BaseModel
from sqlmodel import delete, select, update
from sqlmodel.ext.asyncio.session import AsyncSession

from src.db.payments.payments import (
    PaymentsEnrollment,
    PaymentsGroup,
    PaymentsGroupResource,
    PaymentsGroupSync,
    PaymentsOffer,
)
from src.db.usergroup_user import UserGroupUser
from src.db.usergroups import UserGroup
from src.services.payments.access import ACCESS_STATUSES, normalize_course_uuid
from src.services.payments.common import get_org_or_404, iso, utcnow
from src.services.payments.offers import pricing_changed, validate_course_resource


class GroupBody(BaseModel):
    name: str
    description: str = ""


def _serialize(group: PaymentsGroup) -> dict:
    return {
        "id": group.id,
        "org_id": group.org_id,
        "name": group.name,
        "description": group.description,
        "creation_date": iso(group.creation_date),
        "update_date": iso(group.update_date),
    }


async def _get_group(db_session: AsyncSession, org_id: int, group_id: int) -> PaymentsGroup:
    group = await db_session.get(PaymentsGroup, group_id)
    if group is None or group.org_id != org_id:
        raise HTTPException(status_code=404, detail="Payments group not found")
    return group


async def _group_resource_uuids(db_session: AsyncSession, group_id: int) -> list[str]:
    rows = (await db_session.execute(
        select(PaymentsGroupResource.resource_uuid)
        .where(PaymentsGroupResource.payments_group_id == group_id)
        .order_by(PaymentsGroupResource.id)
    )).scalars().all()
    return list(rows)


async def list_groups(db_session: AsyncSession, org_id: int) -> list[dict]:
    groups = (await db_session.execute(
        select(PaymentsGroup).where(PaymentsGroup.org_id == org_id).order_by(PaymentsGroup.id)
    )).scalars().all()
    return [_serialize(g) for g in groups]


async def create_group(db_session: AsyncSession, org_id: int, body: GroupBody) -> dict:
    await get_org_or_404(db_session, org_id)
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="El nombre es obligatorio")
    group = PaymentsGroup(org_id=org_id, name=name[:255], description=(body.description or "").strip())
    db_session.add(group)
    await db_session.commit()
    await db_session.refresh(group)
    return _serialize(group)


async def update_group(db_session: AsyncSession, org_id: int, group_id: int, body: GroupBody) -> dict:
    group = await _get_group(db_session, org_id, group_id)
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="El nombre es obligatorio")
    group.name = name[:255]
    group.description = (body.description or "").strip()
    group.update_date = utcnow()
    db_session.add(group)
    await db_session.commit()
    await db_session.refresh(group)
    return _serialize(group)


async def delete_group(db_session: AsyncSession, org_id: int, group_id: int) -> dict:
    group = await _get_group(db_session, org_id, group_id)
    affected = await _group_resource_uuids(db_session, group.id)
    # Offers linked to this group lose it (FKs are SET NULL; done explicitly
    # because SQLite does not enforce them).
    await db_session.execute(
        update(PaymentsOffer)
        .where(PaymentsOffer.payments_group_id == group.id)
        .values(payments_group_id=None, update_date=utcnow())
    )
    await db_session.execute(delete(PaymentsGroupResource).where(PaymentsGroupResource.payments_group_id == group.id))
    await db_session.execute(delete(PaymentsGroupSync).where(PaymentsGroupSync.payments_group_id == group.id))
    await db_session.delete(group)
    await db_session.commit()
    pricing_changed(affected)
    return {"detail": "Payments group deleted"}


async def list_group_resources(db_session: AsyncSession, org_id: int, group_id: int) -> list[str]:
    group = await _get_group(db_session, org_id, group_id)
    return await _group_resource_uuids(db_session, group.id)


async def add_group_resource(db_session: AsyncSession, org_id: int, group_id: int, resource_uuid: str) -> dict:
    group = await _get_group(db_session, org_id, group_id)
    uuid = await validate_course_resource(db_session, org_id, resource_uuid)
    existing = (await db_session.execute(
        select(PaymentsGroupResource).where(
            PaymentsGroupResource.payments_group_id == group.id,
            PaymentsGroupResource.resource_uuid == uuid,
        )
    )).scalars().first()
    if existing is None:
        db_session.add(PaymentsGroupResource(payments_group_id=group.id, resource_uuid=uuid, org_id=org_id))
        await db_session.commit()
        pricing_changed([uuid])
    return {"detail": "Resource added", "resource_uuid": uuid}


async def remove_group_resource(db_session: AsyncSession, org_id: int, group_id: int, resource_uuid: str) -> dict:
    group = await _get_group(db_session, org_id, group_id)
    uuid = normalize_course_uuid(resource_uuid)
    await db_session.execute(
        delete(PaymentsGroupResource).where(
            PaymentsGroupResource.payments_group_id == group.id,
            PaymentsGroupResource.resource_uuid == uuid,
        )
    )
    await db_session.commit()
    pricing_changed([uuid])
    return {"detail": "Resource removed", "resource_uuid": uuid}


async def list_group_syncs(db_session: AsyncSession, org_id: int, group_id: int) -> list[dict]:
    group = await _get_group(db_session, org_id, group_id)
    rows = (await db_session.execute(
        select(PaymentsGroupSync.usergroup_id, UserGroup.name)
        .outerjoin(UserGroup, UserGroup.id == PaymentsGroupSync.usergroup_id)  # type: ignore[arg-type]
        .where(PaymentsGroupSync.payments_group_id == group.id)
        .order_by(PaymentsGroupSync.id)
    )).all()
    return [{"usergroup_id": ug_id, "usergroup_name": name} for ug_id, name in rows]


async def add_group_sync(db_session: AsyncSession, org_id: int, group_id: int, usergroup_id: int) -> dict:
    group = await _get_group(db_session, org_id, group_id)
    usergroup = await db_session.get(UserGroup, usergroup_id)
    if usergroup is None or usergroup.org_id != org_id:
        raise HTTPException(status_code=400, detail="El grupo de usuarios no existe")
    existing = (await db_session.execute(
        select(PaymentsGroupSync).where(
            PaymentsGroupSync.payments_group_id == group.id,
            PaymentsGroupSync.usergroup_id == usergroup_id,
        )
    )).scalars().first()
    if existing is None:
        db_session.add(PaymentsGroupSync(payments_group_id=group.id, usergroup_id=usergroup_id, org_id=org_id))
        # Backfill: people who already bought an offer of this group join too.
        buyer_ids = set((await db_session.execute(
            select(PaymentsEnrollment.user_id)
            .join(PaymentsOffer, PaymentsOffer.id == PaymentsEnrollment.offer_id)  # type: ignore[arg-type]
            .where(
                PaymentsOffer.payments_group_id == group.id,
                PaymentsEnrollment.status.in_(ACCESS_STATUSES),  # type: ignore[attr-defined]
            )
        )).scalars().all())
        if buyer_ids:
            members = set((await db_session.execute(
                select(UserGroupUser.user_id).where(
                    UserGroupUser.usergroup_id == usergroup_id,
                    UserGroupUser.user_id.in_(list(buyer_ids)),  # type: ignore[attr-defined]
                )
            )).scalars().all())
            now = str(utcnow())
            for user_id in buyer_ids - members:
                db_session.add(UserGroupUser(
                    usergroup_id=usergroup_id, user_id=user_id, org_id=org_id,
                    creation_date=now, update_date=now,
                ))
        await db_session.commit()
    return {"detail": "Sync added", "usergroup_id": usergroup_id}


async def remove_group_sync(db_session: AsyncSession, org_id: int, group_id: int, usergroup_id: int) -> dict:
    group = await _get_group(db_session, org_id, group_id)
    await db_session.execute(
        delete(PaymentsGroupSync).where(
            PaymentsGroupSync.payments_group_id == group.id,
            PaymentsGroupSync.usergroup_id == usergroup_id,
        )
    )
    await db_session.commit()
    return {"detail": "Sync removed", "usergroup_id": usergroup_id}

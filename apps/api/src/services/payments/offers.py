"""Sanar y Criar: offers (admin CRUD, resources, public storefront reads)."""

import logging
from typing import Iterable, Optional
from uuid import uuid4

from fastapi import HTTPException, Request
from pydantic import BaseModel
from sqlmodel import delete, select
from sqlmodel.ext.asyncio.session import AsyncSession

from src.db.courses.courses import Course
from src.db.payments.payments import (
    PaymentsConfig,
    PaymentsGroup,
    PaymentsOffer,
    PaymentsOfferResource,
)
from src.services.payments.access import (
    bump_access_version,
    covering_offer_ids_query,
    normalize_course_uuid,
)
from src.services.payments.common import (
    courses_by_uuid,
    get_org_or_404,
    iso,
    money,
    offer_resource_map,
    parse_amount,
    resource_summary,
    utcnow,
)
from src.services.payments.providers.registry import get_provider

logger = logging.getLogger(__name__)

OFFER_TYPES = ("one_time", "subscription")
PRICE_TYPES = ("fixed_price", "customer_choice")
BILLING_INTERVALS = ("month", "year")


class OfferCreate(BaseModel):
    name: str
    description: str = ""
    offer_type: str = "one_time"
    price_type: str = "fixed_price"
    billing_interval: Optional[str] = "month"
    benefits: Optional[str] = ""
    amount: float | str
    currency: str = "USD"
    payments_group_id: Optional[int] = None
    resource_uuids: list[str] = []
    is_publicly_listed: bool = True


class OfferUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    offer_type: Optional[str] = None
    price_type: Optional[str] = None
    billing_interval: Optional[str] = None
    benefits: Optional[str] = None
    amount: Optional[float | str] = None
    currency: Optional[str] = None
    payments_group_id: Optional[int] = None
    is_publicly_listed: Optional[bool] = None


# ------------------------------------------------------------------ helpers


async def supported_currencies(db_session: AsyncSession, org_id: int) -> set[str]:
    """Currencies some active provider of the org can charge. USD by default."""
    configs = (await db_session.execute(
        select(PaymentsConfig).where(
            PaymentsConfig.org_id == org_id,
            PaymentsConfig.active == True,  # noqa: E712
            PaymentsConfig.enabled == True,  # noqa: E712
        )
    )).scalars().all()
    currencies: set[str] = set()
    for cfg in configs:
        provider = get_provider(cfg.provider)
        if provider is not None:
            currencies |= set(provider.supported_currencies)
    return currencies or {"USD"}


def _validate_offer_type(value: str) -> str:
    value = (value or "").strip()
    if value == "subscription":
        raise HTTPException(
            status_code=400,
            detail="Las suscripciones aún no están disponibles: el proveedor de pago solo admite pagos únicos.",
        )
    if value not in OFFER_TYPES:
        raise HTTPException(status_code=400, detail="Tipo de oferta no válido")
    return value


def _validate_price_type(value: str) -> str:
    value = (value or "fixed_price").strip()
    if value not in PRICE_TYPES:
        raise HTTPException(status_code=400, detail="Tipo de precio no válido")
    return value


def _validate_interval(value: Optional[str]) -> str:
    value = (value or "month").strip()
    if value not in BILLING_INTERVALS:
        raise HTTPException(status_code=400, detail="Intervalo de cobro no válido")
    return value


async def _validate_currency(db_session: AsyncSession, org_id: int, value: str) -> str:
    currency = (value or "").strip().upper()
    if len(currency) != 3 or not currency.isalpha():
        raise HTTPException(status_code=400, detail="Moneda no válida")
    if currency not in await supported_currencies(db_session, org_id):
        raise HTTPException(
            status_code=400,
            detail=f"La moneda {currency} no es compatible con el proveedor de pago configurado",
        )
    return currency


async def _validate_group(db_session: AsyncSession, org_id: int, group_id: Optional[int]) -> Optional[int]:
    if group_id is None:
        return None
    group = await db_session.get(PaymentsGroup, group_id)
    if group is None or group.org_id != org_id:
        raise HTTPException(status_code=400, detail="El grupo de pago no existe")
    return group_id


async def validate_course_resource(db_session: AsyncSession, org_id: int, resource_uuid: str) -> str:
    uuid = normalize_course_uuid(resource_uuid)
    if not uuid:
        raise HTTPException(status_code=400, detail="Falta resource_uuid")
    course = (await db_session.execute(
        select(Course.id).where(Course.course_uuid == uuid, Course.org_id == org_id)
    )).first()
    if course is None:
        raise HTTPException(status_code=400, detail="El curso no existe en esta organización")
    return uuid


async def courses_of_offers(db_session: AsyncSession, offers: Iterable[PaymentsOffer]) -> set[str]:
    resource_map = await offer_resource_map(db_session, offers)
    return {uuid for uuids in resource_map.values() for uuid in uuids}


def pricing_changed(course_uuids: Iterable[str]) -> None:
    """A course may have become free or paid: drop cached access decisions and
    the anonymous ``/meta`` view (which could hold unscrubbed content)."""
    from src.services.courses.cache import invalidate_course_meta_cache

    bump_access_version()
    for uuid in set(course_uuids):
        if uuid:
            try:
                invalidate_course_meta_cache(uuid)
            except Exception:
                logger.debug("Course meta cache invalidation failed for %s", uuid, exc_info=True)


def serialize_admin_offer(offer: PaymentsOffer, resource_uuids: Optional[list[str]] = None) -> dict:
    return {
        "id": offer.id,
        "offer_uuid": offer.offer_uuid,
        "org_id": offer.org_id,
        "name": offer.name,
        "description": offer.description,
        "offer_type": offer.offer_type,
        "price_type": offer.price_type,
        "billing_interval": offer.billing_interval,
        "benefits": offer.benefits,
        "amount": money(offer.amount),
        "currency": offer.currency,
        "payments_group_id": offer.payments_group_id,
        "is_publicly_listed": offer.is_publicly_listed,
        "archived": offer.archived,
        "resource_uuids": resource_uuids if resource_uuids is not None else [],
        "creation_date": iso(offer.creation_date),
        "update_date": iso(offer.update_date),
    }


# --------------------------------------------------------------- admin CRUD


async def list_offers(db_session: AsyncSession, org_id: int, include_archived: bool = False) -> list[dict]:
    stmt = select(PaymentsOffer).where(PaymentsOffer.org_id == org_id)
    if not include_archived:
        stmt = stmt.where(PaymentsOffer.archived == False)  # noqa: E712
    offers = (await db_session.execute(stmt.order_by(PaymentsOffer.id))).scalars().all()
    resources = await offer_resource_map(db_session, offers)
    return [serialize_admin_offer(o, resources.get(o.id, [])) for o in offers]


async def get_offer(db_session: AsyncSession, org_id: int, offer_id: int) -> dict:
    offer = await _get_offer(db_session, org_id, offer_id, include_archived=True)
    resources = await offer_resource_map(db_session, [offer])
    return serialize_admin_offer(offer, resources.get(offer.id, []))


async def _get_offer(db_session: AsyncSession, org_id: int, offer_id: int,
                     *, include_archived: bool = False) -> PaymentsOffer:
    offer = await db_session.get(PaymentsOffer, offer_id)
    if offer is None or offer.org_id != org_id or (offer.archived and not include_archived):
        raise HTTPException(status_code=404, detail="Offer not found")
    return offer


async def create_offer(db_session: AsyncSession, org_id: int, body: OfferCreate) -> dict:
    await get_org_or_404(db_session, org_id)
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="El nombre es obligatorio")
    offer = PaymentsOffer(
        offer_uuid=str(uuid4()),
        org_id=org_id,
        name=name[:255],
        description=(body.description or "").strip(),
        offer_type=_validate_offer_type(body.offer_type),
        price_type=_validate_price_type(body.price_type),
        billing_interval=_validate_interval(body.billing_interval),
        benefits=(body.benefits or "").strip(),
        amount=parse_amount(body.amount),
        currency=await _validate_currency(db_session, org_id, body.currency),
        payments_group_id=await _validate_group(db_session, org_id, body.payments_group_id),
        is_publicly_listed=bool(body.is_publicly_listed),
    )
    uuids: list[str] = []
    for raw in body.resource_uuids or []:
        uuid = await validate_course_resource(db_session, org_id, raw)
        if uuid not in uuids:
            uuids.append(uuid)
    db_session.add(offer)
    await db_session.flush()
    for uuid in uuids:
        db_session.add(PaymentsOfferResource(offer_id=offer.id, resource_uuid=uuid, org_id=org_id))
    await db_session.commit()
    await db_session.refresh(offer)
    resources = await offer_resource_map(db_session, [offer])
    pricing_changed(resources.get(offer.id, []))
    return serialize_admin_offer(offer, resources.get(offer.id, []))


async def update_offer(db_session: AsyncSession, org_id: int, offer_id: int, body: OfferUpdate) -> dict:
    offer = await _get_offer(db_session, org_id, offer_id)
    before = await courses_of_offers(db_session, [offer])
    fields = body.model_dump(exclude_unset=True)
    if "name" in fields and fields["name"] is not None:
        name = fields["name"].strip()
        if not name:
            raise HTTPException(status_code=400, detail="El nombre es obligatorio")
        offer.name = name[:255]
    if fields.get("description") is not None:
        offer.description = fields["description"].strip()
    if fields.get("offer_type") is not None:
        offer.offer_type = _validate_offer_type(fields["offer_type"])
    if fields.get("price_type") is not None:
        offer.price_type = _validate_price_type(fields["price_type"])
    if fields.get("billing_interval") is not None:
        offer.billing_interval = _validate_interval(fields["billing_interval"])
    if fields.get("benefits") is not None:
        offer.benefits = fields["benefits"].strip()
    if fields.get("amount") is not None:
        offer.amount = parse_amount(fields["amount"])
    if fields.get("currency") is not None:
        offer.currency = await _validate_currency(db_session, org_id, fields["currency"])
    if "payments_group_id" in fields:
        offer.payments_group_id = await _validate_group(db_session, org_id, fields["payments_group_id"])
    if fields.get("is_publicly_listed") is not None:
        offer.is_publicly_listed = bool(fields["is_publicly_listed"])
    offer.update_date = utcnow()
    db_session.add(offer)
    await db_session.commit()
    await db_session.refresh(offer)
    after = await courses_of_offers(db_session, [offer])
    if before != after or "payments_group_id" in fields:
        pricing_changed(before | after)
    resources = await offer_resource_map(db_session, [offer])
    return serialize_admin_offer(offer, resources.get(offer.id, []))


async def archive_offer(db_session: AsyncSession, org_id: int, offer_id: int) -> dict:
    offer = await _get_offer(db_session, org_id, offer_id, include_archived=True)
    affected = await courses_of_offers(db_session, [offer])
    if not offer.archived:
        offer.archived = True
        offer.is_publicly_listed = False
        offer.update_date = utcnow()
        db_session.add(offer)
        await db_session.commit()
        pricing_changed(affected)
    return {"detail": "Offer archived"}


async def list_offer_resources(db_session: AsyncSession, org_id: int, offer_id: int) -> list[str]:
    offer = await _get_offer(db_session, org_id, offer_id, include_archived=True)
    rows = (await db_session.execute(
        select(PaymentsOfferResource.resource_uuid)
        .where(PaymentsOfferResource.offer_id == offer.id)
        .order_by(PaymentsOfferResource.id)
    )).scalars().all()
    return list(rows)


async def add_offer_resource(db_session: AsyncSession, org_id: int, offer_id: int, resource_uuid: str) -> dict:
    offer = await _get_offer(db_session, org_id, offer_id)
    uuid = await validate_course_resource(db_session, org_id, resource_uuid)
    existing = (await db_session.execute(
        select(PaymentsOfferResource).where(
            PaymentsOfferResource.offer_id == offer.id,
            PaymentsOfferResource.resource_uuid == uuid,
        )
    )).scalars().first()
    if existing is None:
        db_session.add(PaymentsOfferResource(offer_id=offer.id, resource_uuid=uuid, org_id=org_id))
        await db_session.commit()
        pricing_changed([uuid])
    return {"detail": "Resource added", "resource_uuid": uuid}


async def remove_offer_resource(db_session: AsyncSession, org_id: int, offer_id: int, resource_uuid: str) -> dict:
    offer = await _get_offer(db_session, org_id, offer_id, include_archived=True)
    uuid = normalize_course_uuid(resource_uuid)
    await db_session.execute(
        delete(PaymentsOfferResource).where(
            PaymentsOfferResource.offer_id == offer.id,
            PaymentsOfferResource.resource_uuid == uuid,
        )
    )
    await db_session.commit()
    pricing_changed([uuid])
    return {"detail": "Resource removed", "resource_uuid": uuid}


# ------------------------------------------------------------- public reads


def _public_offer(offer: PaymentsOffer, resources: list[dict]) -> dict:
    return {
        "id": offer.id,
        "offer_uuid": offer.offer_uuid,
        "name": offer.name,
        "description": offer.description,
        "offer_type": offer.offer_type,
        "billing_interval": offer.billing_interval,
        "price_type": offer.price_type,
        "amount": money(offer.amount),
        "currency": offer.currency,
        "benefits": offer.benefits,
        "payments_group_id": offer.payments_group_id,
        "included_resources": resources,
    }


async def _public_payloads(db_session: AsyncSession, request: Optional[Request], org_id: int,
                           offers: list[PaymentsOffer]) -> list[tuple[PaymentsOffer, list[dict]]]:
    org = await get_org_or_404(db_session, org_id)
    resource_map = await offer_resource_map(db_session, offers)
    all_uuids = {u for uuids in resource_map.values() for u in uuids}
    courses = await courses_by_uuid(db_session, all_uuids, org_id, published_only=True)
    payloads = []
    for offer in offers:
        resources = []
        for uuid in resource_map.get(offer.id, []):
            course = courses.get(uuid)
            if course is None:
                continue
            summary = resource_summary(course, org.org_uuid, request)
            resources.append({
                "resource_uuid": course.course_uuid,
                "resource_type": "course",
                "name": course.name,
                "description": course.description or "",
                "thumbnail_image": course.thumbnail_image or "",
                "org_uuid": org.org_uuid,
                "product_type": summary["product_type"],
                "course_uuid": course.course_uuid,
                "thumbnail_url": summary["thumbnail_url"],
                "course_url": summary["course_url"],
            })
        payloads.append((offer, resources))
    return payloads


async def public_listing(db_session: AsyncSession, request: Optional[Request], org_id: int) -> list[dict]:
    offers = (await db_session.execute(
        select(PaymentsOffer).where(
            PaymentsOffer.org_id == org_id,
            PaymentsOffer.archived == False,  # noqa: E712
            PaymentsOffer.is_publicly_listed == True,  # noqa: E712
        ).order_by(PaymentsOffer.id)
    )).scalars().all()
    payloads = await _public_payloads(db_session, request, org_id, list(offers))
    # An offer with nothing published in it has nothing to sell yet.
    return [_public_offer(o, r) for o, r in payloads if r]


async def free_listing(db_session: AsyncSession, request: Optional[Request], org_id: int) -> list[dict]:
    """Sanar y Criar: published public courses that no live offer covers.

    The paywall treats them as free (see access.py), so the marketing site
    lists them next to the offers with a "read for free" link to the course.
    """
    from src.db.courses.courses import Course

    org = await get_org_or_404(db_session, org_id)
    offers = (await db_session.execute(
        select(PaymentsOffer).where(
            PaymentsOffer.org_id == org_id,
            PaymentsOffer.archived == False,  # noqa: E712
        )
    )).scalars().all()
    covered = {u for uuids in (await offer_resource_map(db_session, offers)).values() for u in uuids}
    courses = (await db_session.execute(
        select(Course).where(
            Course.org_id == org_id,
            Course.published == True,  # noqa: E712
            Course.public == True,  # noqa: E712
        ).order_by(Course.id)
    )).scalars().all()
    items = []
    for course in courses:
        if course.course_uuid in covered:
            continue
        summary = resource_summary(course, org.org_uuid, request)
        items.append({**summary, "description": course.description or ""})
    return items


async def public_offer(db_session: AsyncSession, request: Optional[Request], org_id: int, ref: str) -> dict:
    from src.services.payments.common import get_offer_by_ref

    offer = await get_offer_by_ref(db_session, org_id, ref)
    if not offer.is_publicly_listed:
        raise HTTPException(status_code=404, detail="Offer not found")
    (payload,) = await _public_payloads(db_session, request, org_id, [offer])
    return _public_offer(*payload)


async def offers_by_resource(db_session: AsyncSession, org_id: int, resource_uuid: str) -> list[dict]:
    uuid = normalize_course_uuid(resource_uuid)
    if not uuid:
        return []
    ids = covering_offer_ids_query(uuid, org_id=org_id)
    offers = (await db_session.execute(
        select(PaymentsOffer).where(
            PaymentsOffer.id.in_(ids),  # type: ignore[union-attr]
            PaymentsOffer.is_publicly_listed == True,  # noqa: E712
        ).order_by(PaymentsOffer.amount, PaymentsOffer.id)
    )).scalars().all()
    return [
        {
            "offer_id": o.id,
            "offer_uuid": o.offer_uuid,
            "offer_name": o.name,
            "description": o.description,
            "offer_type": o.offer_type,
            "price_type": o.price_type,
            "billing_interval": o.billing_interval,
            "amount": money(o.amount),
            "currency": o.currency,
            "benefits": o.benefits,
        }
        for o in offers
    ]


async def offer_courses(db_session: AsyncSession, offer: PaymentsOffer,
                        *, published_only: bool = True) -> list[Course]:
    """Courses an offer grants, in resource order."""
    resource_map = await offer_resource_map(db_session, [offer])
    uuids = resource_map.get(offer.id, [])
    courses = await courses_by_uuid(db_session, uuids, offer.org_id, published_only=published_only)
    return [courses[u] for u in uuids if u in courses]


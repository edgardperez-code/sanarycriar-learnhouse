"""Sanar y Criar: newsletter sign-up (public) and subscriber management (admin).

The sign-up never reveals whether an address was already on the list: a new
address, a repeated one and a honeypot hit all get the same 200 body, and
none of them waits for Resend (the copy runs after the response), so the
answer takes the same time too.
Resend is always reached through the ``resend_sync`` module (never a
``from ... import`` of its functions) so tests can monkeypatch it.
"""

import csv
import hashlib
import io
import time
from typing import Optional

from fastapi import HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from src.db.newsletter.newsletter import NewsletterSubscriber
from src.services.newsletter import resend_sync
from src.services.newsletter.common import (
    EMAIL_MAX_RAW_LENGTH,
    VE_TZ,
    check_rate,
    client_rate_key,
    csv_safe,
    normalize_email,
    sanitize_page_path,
)
from src.services.payments.common import as_utc, get_org_or_404, iso, utcnow

SOURCES = ("popup", "footer")
SYNC_RETRY_STATUSES = ("pending", "error", "skipped")
SYNC_BATCH_SIZE = 50
# Sanar y Criar: no new row is started once the batch has run this long, so a
# slow Resend cannot keep the dashboard's request open for minutes (each row
# takes at most a few RESEND_TIMEOUT_SECONDS); the rest is left in
# ``remaining`` for the next click.
SYNC_TIME_BUDGET_SECONDS = 15.0
SEARCH_MAX_LENGTH = 100

INVALID_EMAIL_DETAIL = "Escribe un correo electrónico válido."
OK_RESPONSE = {"ok": True}

CSV_HEADER = ("email", "fecha_alta", "origen", "pagina", "estado_resend")
_CSV_SOURCE = {"popup": "ventana", "footer": "pie", "other": "otro"}
_CSV_STATUS = {"synced": "sincronizado", "pending": "pendiente", "error": "error", "skipped": "sin_resend"}


class SubscribeBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    email: str = ""
    website: str = ""        # honeypot: must stay empty
    source: str = "popup"
    page: Optional[str] = None


def _normalize_source(value: Optional[str]) -> str:
    return value if value in SOURCES else "other"


async def _find(db_session: AsyncSession, org_id: int, email: str) -> Optional[NewsletterSubscriber]:
    return (await db_session.execute(
        select(NewsletterSubscriber).where(
            NewsletterSubscriber.org_id == org_id,
            NewsletterSubscriber.email == email,
        )
    )).scalars().first()


async def subscribe(
    db_session: AsyncSession, request: Request, org_id: int, body: SubscribeBody
) -> dict:
    """Anonymous sign-up. Works whether or not the pop-up is enabled."""
    from src.services.security.rate_limiting import get_client_ip

    await get_org_or_404(db_session, org_id)
    check_rate(f"sc_nl_sub_ip:{client_rate_key(get_client_ip(request))}", 10, 600)

    # Honeypot: bots fill every field. Pretend it worked, store nothing.
    if (body.website or "").strip():
        return dict(OK_RESPONSE)

    raw_email = body.email or ""
    if len(raw_email) > EMAIL_MAX_RAW_LENGTH:
        raise HTTPException(status_code=400, detail=INVALID_EMAIL_DETAIL)
    email = normalize_email(raw_email)
    if email is None:
        raise HTTPException(status_code=400, detail=INVALID_EMAIL_DETAIL)

    # Sanar y Criar: the org-wide cap is counted only for well-formed sign-ups,
    # so honeypot hits and junk addresses cannot use up every visitor's quota.
    # It still counts new and known addresses alike: counting only new rows
    # would make a 429 tell which addresses are already on the list.
    check_rate(f"sc_nl_sub_org:{org_id}", 300, 3600)

    # Keyed by a hash: the address never appears in clear in Redis.
    digest = hashlib.sha256(email.encode("utf-8")).hexdigest()[:24]
    check_rate(f"sc_nl_sub_email:{org_id}:{digest}", 5, 3600)

    settings = resend_sync.resend_settings()
    row = await _find(db_session, org_id, email)
    if row is None:
        row = NewsletterSubscriber(
            org_id=org_id,
            email=email,
            source=_normalize_source(body.source),
            page_path=sanitize_page_path(body.page),
            sync_status="pending" if settings is not None else "skipped",
        )
        db_session.add(row)
        try:
            await db_session.commit()
        except IntegrityError:
            # Same address signing up twice at once: the other request won.
            await db_session.rollback()
            row = await _find(db_session, org_id, email)
            if row is None:
                return dict(OK_RESPONSE)

    # Never awaited here: a slow Resend must neither delay the answer (which
    # would tell new addresses from synced ones) nor turn a saved sign-up into
    # a timeout on the site. A row Resend misses stays pending/error for the
    # dashboard's "Sincronizar con Resend".
    if settings is not None and row.sync_status != "synced":
        resend_sync.schedule_sync(row.id, settings)
    return dict(OK_RESPONSE)


def _subscriber_item(row: NewsletterSubscriber) -> dict:
    return {
        "id": row.id,
        "email": row.email,
        "source": row.source,
        "page_path": row.page_path,
        "sync_status": row.sync_status,
        "sync_error": row.sync_error,
        "created_at": iso(row.creation_date),
        "synced_at": iso(row.synced_at),
    }


async def _count(db_session: AsyncSession, *conditions) -> int:
    return int((await db_session.execute(
        select(func.count()).select_from(NewsletterSubscriber).where(*conditions)
    )).scalar_one())


async def _unsynced_count(db_session: AsyncSession, org_id: int) -> int:
    return await _count(
        db_session,
        NewsletterSubscriber.org_id == org_id,
        NewsletterSubscriber.sync_status != "synced",
    )


async def list_subscribers(
    db_session: AsyncSession, org_id: int, page: int = 1, limit: int = 25, q: Optional[str] = None
) -> dict:
    """``SubscriberPage``: newest first, optionally filtered by part of the address."""
    await get_org_or_404(db_session, org_id)
    search = (q or "").strip().lower()[:SEARCH_MAX_LENGTH]

    conditions = [NewsletterSubscriber.org_id == org_id]
    if search:
        conditions.append(NewsletterSubscriber.email.contains(search, autoescape=True))  # type: ignore[union-attr]

    rows = (await db_session.execute(
        select(NewsletterSubscriber)
        .where(*conditions)
        .order_by(NewsletterSubscriber.creation_date.desc(), NewsletterSubscriber.id.desc())  # type: ignore[union-attr]
        .offset((page - 1) * limit)
        .limit(limit)
    )).scalars().all()

    return {
        "items": [_subscriber_item(row) for row in rows],
        "total": await _count(db_session, *conditions),
        "page": page,
        "limit": limit,
        "summary": {
            "all": await _count(db_session, NewsletterSubscriber.org_id == org_id),
            "unsynced": await _unsynced_count(db_session, org_id),
        },
    }


async def export_csv(db_session: AsyncSession, org_id: int) -> Response:
    """Every subscriber of the org, oldest first, as a spreadsheet-safe CSV."""
    await get_org_or_404(db_session, org_id)
    rows = (await db_session.execute(
        select(NewsletterSubscriber)
        .where(NewsletterSubscriber.org_id == org_id)
        .order_by(NewsletterSubscriber.creation_date.asc(), NewsletterSubscriber.id.asc())  # type: ignore[union-attr]
    )).scalars().all()

    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(CSV_HEADER)
    for row in rows:
        created = as_utc(row.creation_date)
        writer.writerow([csv_safe(cell) for cell in (
            row.email,
            created.astimezone(VE_TZ).strftime("%Y-%m-%d %H:%M") if created else "",
            _CSV_SOURCE.get(row.source, "otro"),
            row.page_path or "",
            _CSV_STATUS.get(row.sync_status, row.sync_status),
        )])

    filename = f"suscriptores-boletin-{utcnow().astimezone(VE_TZ).strftime('%Y%m%d')}.csv"
    return Response(
        content=buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


async def delete_subscriber(db_session: AsyncSession, org_id: int, subscriber_id: int) -> dict:
    """Delete one address (and its Resend contact, if Resend has one).

    ``resend_removed`` is None when Resend holds no contact for it (or is not
    used), True once the contact is removed and False when it may still be in
    Resend: the dashboard then tells the owner to delete it there by hand.
    """
    await get_org_or_404(db_session, org_id)
    row = (await db_session.execute(
        select(NewsletterSubscriber).where(
            NewsletterSubscriber.id == subscriber_id,
            NewsletterSubscriber.org_id == org_id,
        )
    )).scalars().first()
    if row is None:
        raise HTTPException(status_code=404, detail="Suscriptor no encontrado.")

    settings = resend_sync.resend_settings()
    resend_removed: Optional[bool] = None
    if settings is not None and row.resend_contact_id:
        resend_removed = await resend_sync.remove_contact(settings, row.resend_contact_id)
    elif settings is not None:
        # Sanar y Criar: no contact id does not mean no contact: a create that
        # timed out may still have made one. Look it up by address.
        resend_removed = await resend_sync.remove_contact_by_email(settings, row.email, row.id)
    elif row.resend_contact_id:
        # Synced once, but Resend is no longer configured here: the contact is
        # still there and nobody can remove it from this side.
        resend_removed = False

    await db_session.delete(row)
    await db_session.commit()
    return {"deleted": True, "resend_removed": resend_removed}


async def sync_pending(db_session: AsyncSession, org_id: int) -> dict:
    """``SyncResult``: retry up to 50 unsynced rows of the org (oldest first)."""
    await get_org_or_404(db_session, org_id)
    settings = resend_sync.resend_settings()
    if settings is None:
        return {
            "resend_enabled": False,
            "synced": 0,
            "failed": 0,
            "remaining": await _unsynced_count(db_session, org_id),
        }

    rows = (await db_session.execute(
        select(NewsletterSubscriber)
        .where(
            NewsletterSubscriber.org_id == org_id,
            NewsletterSubscriber.sync_status.in_(SYNC_RETRY_STATUSES),  # type: ignore[union-attr]
        )
        .order_by(NewsletterSubscriber.id.asc())  # type: ignore[union-attr]
        .limit(SYNC_BATCH_SIZE)
    )).scalars().all()

    synced = failed = 0
    deadline = time.monotonic() + SYNC_TIME_BUDGET_SECONDS
    for row in rows:
        if time.monotonic() >= deadline:
            break
        if await resend_sync.sync_subscriber(db_session, row, settings):
            synced += 1
        else:
            failed += 1
    return {
        "resend_enabled": True,
        "synced": synced,
        "failed": failed,
        "remaining": await _unsynced_count(db_session, org_id),
    }

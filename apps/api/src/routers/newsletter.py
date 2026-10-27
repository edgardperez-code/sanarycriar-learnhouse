"""Sanar y Criar: newsletter API (sign-up pop-up of the marketing site, mounted at /newsletter).

Auth levels used below:
- admin: org admin/maintainer (superadmin included) with a real session.
  Unlike payments there is no feature toggle to check.
- public: anonymous. Never reads the session (no ``get_current_user``), so
  the static site can call it without credentials.

Literal routes (``subscribers/export.csv``, ``subscribers/sync``) are declared
before the parametric ``subscribers/{subscriber_id}``.
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlmodel.ext.asyncio.session import AsyncSession

from src.core.events.database import get_db_session
from src.db.users import AnonymousUser, APITokenUser, SuperadminAPITokenUser
from src.security.auth import get_current_user
from src.services.newsletter import settings as settings_service
from src.services.newsletter import subscribers as subscribers_service
from src.services.newsletter.common import install_access_log_redaction
from src.services.newsletter.settings import SettingsBody
from src.services.newsletter.subscribers import SubscribeBody

router = APIRouter()

# Sanar y Criar: ``GET /subscribers?q=`` carries part of an e-mail address;
# keep it out of uvicorn's access log.
install_access_log_redaction()


# ------------------------------------------------------------ dependencies


async def require_newsletter_admin(
    org_id: int,
    current_user=Depends(get_current_user),
    db_session: AsyncSession = Depends(get_db_session),
):
    if current_user is None or isinstance(current_user, AnonymousUser):
        raise HTTPException(status_code=401, detail="Authentication required")
    if isinstance(current_user, (APITokenUser, SuperadminAPITokenUser)):
        raise HTTPException(status_code=403, detail="API tokens cannot manage the newsletter")
    from src.security.org_auth import require_org_admin
    from src.services.payments.common import get_org_or_404

    await get_org_or_404(db_session, org_id)
    await require_org_admin(current_user.id, org_id, db_session)
    return current_user


# ------------------------------------------------------------------ public


@router.get("/{org_id}/public-config", summary="Newsletter pop-up configuration (public)")
async def api_public_config(
    org_id: int,
    response: Response,
    db_session: AsyncSession = Depends(get_db_session),
):
    # The dashboard promises "changes are live on the site": never cache.
    response.headers["Cache-Control"] = "no-store"
    return await settings_service.get_public_config(db_session, org_id)


@router.post("/{org_id}/subscribe", summary="Subscribe to the newsletter (public)")
async def api_subscribe(
    request: Request,
    org_id: int,
    body: SubscribeBody,
    db_session: AsyncSession = Depends(get_db_session),
):
    return await subscribers_service.subscribe(db_session, request, org_id, body)


# ---------------------------------------------------------------- settings


@router.get("/{org_id}/settings", summary="Newsletter pop-up settings (admin)")
async def api_get_settings(
    org_id: int,
    _admin=Depends(require_newsletter_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await settings_service.get_admin_settings(db_session, org_id)


@router.put("/{org_id}/settings", summary="Update the newsletter pop-up settings (admin)")
async def api_update_settings(
    org_id: int,
    body: SettingsBody,
    _admin=Depends(require_newsletter_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await settings_service.update_settings(db_session, org_id, body)


# ------------------------------------------------------------- subscribers


@router.get("/{org_id}/subscribers", summary="List newsletter subscribers (admin)")
async def api_list_subscribers(
    org_id: int,
    page: int = Query(1, ge=1),
    limit: int = Query(25, ge=1, le=100),
    q: Optional[str] = Query(default=None),
    _admin=Depends(require_newsletter_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await subscribers_service.list_subscribers(db_session, org_id, page, limit, q)


@router.get("/{org_id}/subscribers/export.csv", summary="Export newsletter subscribers as CSV (admin)")
async def api_export_subscribers(
    org_id: int,
    _admin=Depends(require_newsletter_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await subscribers_service.export_csv(db_session, org_id)


@router.post("/{org_id}/subscribers/sync", summary="Retry the Resend sync of unsynced subscribers (admin)")
async def api_sync_subscribers(
    org_id: int,
    _admin=Depends(require_newsletter_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await subscribers_service.sync_pending(db_session, org_id)


@router.delete("/{org_id}/subscribers/{subscriber_id}", summary="Delete a newsletter subscriber (admin)")
async def api_delete_subscriber(
    org_id: int,
    subscriber_id: int,
    _admin=Depends(require_newsletter_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await subscribers_service.delete_subscriber(db_session, org_id, subscriber_id)

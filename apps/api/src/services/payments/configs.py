"""Sanar y Criar: per-org payment provider configuration.

Secrets are encrypted at rest with ``src.services.webhooks.crypto`` and never
leave the API: reads expose ``has_secret`` only.
"""

import logging
from typing import Optional

from fastapi import HTTPException, Request
from pydantic import BaseModel
from sqlmodel import select, update
from sqlmodel.ext.asyncio.session import AsyncSession

from src.db.payments.payments import PaymentsConfig, PaymentsOffer
from src.services.payments.common import get_org_or_404, iso, media_base_url, utcnow
from src.services.payments.providers.registry import get_provider
from src.services.payments.settings import is_development_mode
from src.services.webhooks.crypto import encrypt_secret

logger = logging.getLogger(__name__)

ENVIRONMENTS = ("sandbox", "live")

_VALIDATION_MESSAGES = {
    "invalid_credentials": "PayPal rechazó las credenciales. Revisa el Client ID, el Secret y el entorno (sandbox o live).",
    "not_configured": "Faltan el Client ID o el Secret de PayPal.",
    "unreachable": "No pudimos comunicarnos con PayPal. Intenta de nuevo en unos minutos.",
    "rejected": "PayPal no aceptó la solicitud de validación.",
}


def config_environment(cfg: Optional[PaymentsConfig]) -> str:
    """'live' or 'sandbox' (anything else counts as sandbox, like the provider)."""
    settings = (cfg.provider_config or {}) if cfg is not None else {}
    return "live" if settings.get("environment") == "live" else "sandbox"


def is_test_mode(cfg: Optional[PaymentsConfig]) -> bool:
    """A production instance charging through a sandbox config (fake money)."""
    return config_environment(cfg) != "live" and not is_development_mode()


class PaymentConfigBody(BaseModel):
    provider: Optional[str] = None
    enabled: Optional[bool] = None
    client_id: Optional[str] = None
    client_secret: Optional[str] = None
    environment: Optional[str] = None
    webhook_id: Optional[str] = None
    brand_name: Optional[str] = None


def webhook_url(request: Optional[Request], provider: str, org_id: int) -> str:
    base = media_base_url(request)
    return f"{base}/api/v1/payments/webhooks/{provider}/{org_id}"


def serialize_config(cfg: PaymentsConfig, request: Optional[Request] = None) -> dict:
    provider = get_provider(cfg.provider)
    settings = provider.public_settings(cfg) if provider else {}
    settings["webhook_url"] = webhook_url(request, cfg.provider, cfg.org_id)
    return {
        "id": cfg.id,
        "org_id": cfg.org_id,
        "provider": cfg.provider,
        "enabled": cfg.enabled,
        "active": cfg.active,
        "provider_specific_id": cfg.provider_specific_id,
        "mode": cfg.mode,
        "creation_date": iso(cfg.creation_date),
        "update_date": iso(cfg.update_date),
        "settings": settings,
    }


async def list_configs(db_session: AsyncSession, request: Optional[Request], org_id: int) -> list[dict]:
    configs = (await db_session.execute(
        select(PaymentsConfig).where(PaymentsConfig.org_id == org_id).order_by(PaymentsConfig.id)
    )).scalars().all()
    return [serialize_config(c, request) for c in configs]


async def get_active_config(db_session: AsyncSession, org_id: int, provider_id: str) -> Optional[PaymentsConfig]:
    return (await db_session.execute(
        select(PaymentsConfig).where(
            PaymentsConfig.org_id == org_id,
            PaymentsConfig.provider == provider_id,
            PaymentsConfig.active == True,  # noqa: E712
            PaymentsConfig.enabled == True,  # noqa: E712
        )
    )).scalars().first()


def _apply_body(cfg: PaymentsConfig, body: PaymentConfigBody) -> bool:
    """Copy the body onto ``cfg``; True when credentials changed."""
    settings = dict(cfg.provider_config or {})
    credentials_changed = False
    if body.client_id is not None:
        client_id = body.client_id.strip()
        if client_id != settings.get("client_id"):
            credentials_changed = True
        settings["client_id"] = client_id
    if body.client_secret:
        settings["client_secret_enc"] = encrypt_secret(body.client_secret.strip())
        credentials_changed = True
    if body.environment is not None:
        environment = body.environment.strip().lower()
        if environment not in ENVIRONMENTS:
            raise HTTPException(status_code=400, detail="El entorno debe ser 'sandbox' o 'live'")
        if environment != settings.get("environment"):
            credentials_changed = True
        settings["environment"] = environment
    settings.setdefault("environment", "sandbox")
    if body.webhook_id is not None:
        settings["webhook_id"] = body.webhook_id.strip()[:64]
    if body.brand_name is not None:
        settings["brand_name"] = body.brand_name.strip()[:127]
    if body.enabled is not None:
        cfg.enabled = bool(body.enabled)
    cfg.provider_config = settings
    return credentials_changed


async def _validate(cfg: PaymentsConfig) -> None:
    """Ask the provider to accept the credentials; 400/502 when it does not."""
    provider = get_provider(cfg.provider)
    if provider is None:
        raise HTTPException(status_code=400, detail="Proveedor de pago no soportado")
    settings = cfg.provider_config or {}
    if not settings.get("client_id") or not settings.get("client_secret_enc"):
        cfg.active = False
        cfg.provider_specific_id = None
        return
    # Real money needs the webhook: refunds and chargebacks only take access
    # away through it (the daily refund check is a backstop, not a substitute).
    if settings.get("environment") == "live" and not (settings.get("webhook_id") or "").strip():
        raise HTTPException(
            status_code=400,
            detail="Falta el Webhook ID: sin él los reembolsos no retiran el acceso. Créalo en PayPal y pégalo aquí.",
        )
    ok, provider_specific_id, error = await provider.validate_config(cfg)
    if not ok:
        status = 502 if error == "unreachable" else 400
        raise HTTPException(status_code=status, detail=_VALIDATION_MESSAGES.get(error or "", "Credenciales no válidas"))
    cfg.active = True
    cfg.provider_specific_id = provider_specific_id


async def create_config(db_session: AsyncSession, request: Optional[Request], org_id: int,
                        provider_id: Optional[str], body: PaymentConfigBody) -> dict:
    await get_org_or_404(db_session, org_id)
    provider_id = (provider_id or body.provider or "").strip().lower()
    if get_provider(provider_id) is None:
        raise HTTPException(status_code=400, detail="Proveedor de pago no soportado")
    existing = (await db_session.execute(
        select(PaymentsConfig).where(PaymentsConfig.org_id == org_id, PaymentsConfig.provider == provider_id)
    )).scalars().first()
    if existing is not None:
        raise HTTPException(status_code=409, detail="Ya existe una configuración para este proveedor")
    cfg = PaymentsConfig(org_id=org_id, provider=provider_id, enabled=True, provider_config={})
    _apply_body(cfg, body)
    await _validate(cfg)
    db_session.add(cfg)
    await db_session.commit()
    await db_session.refresh(cfg)
    return serialize_config(cfg, request)


async def update_config(db_session: AsyncSession, request: Optional[Request], org_id: int,
                        config_id: int, body: PaymentConfigBody) -> dict:
    cfg = await db_session.get(PaymentsConfig, config_id)
    if cfg is None or cfg.org_id != org_id:
        raise HTTPException(status_code=404, detail="Payment configuration not found")
    # Validate a detached copy so a rejected update leaves the row untouched.
    candidate = PaymentsConfig(
        org_id=cfg.org_id,
        provider=cfg.provider,
        enabled=cfg.enabled,
        active=cfg.active,
        provider_specific_id=cfg.provider_specific_id,
        mode=cfg.mode,
        provider_config=dict(cfg.provider_config or {}),
    )
    _apply_body(candidate, body)
    await _validate(candidate)
    cfg.provider_config = candidate.provider_config
    cfg.enabled = candidate.enabled
    cfg.active = candidate.active
    cfg.provider_specific_id = candidate.provider_specific_id
    cfg.update_date = utcnow()
    db_session.add(cfg)
    await db_session.commit()
    await db_session.refresh(cfg)
    return serialize_config(cfg, request)


async def delete_config(db_session: AsyncSession, org_id: int, config_id: int) -> dict:
    cfg = await db_session.get(PaymentsConfig, config_id)
    if cfg is None or cfg.org_id != org_id:
        raise HTTPException(status_code=404, detail="Payment configuration not found")
    await db_session.execute(
        update(PaymentsOffer).where(PaymentsOffer.payments_config_id == cfg.id).values(payments_config_id=None)
    )
    await db_session.delete(cfg)
    await db_session.commit()
    return {"detail": "Payment configuration deleted"}


async def checkout_providers(db_session: AsyncSession, org_id: int) -> list[dict]:
    configs = (await db_session.execute(
        select(PaymentsConfig).where(
            PaymentsConfig.org_id == org_id,
            PaymentsConfig.active == True,  # noqa: E712
            PaymentsConfig.enabled == True,  # noqa: E712
        ).order_by(PaymentsConfig.id)
    )).scalars().all()
    result = []
    for cfg in configs:
        provider = get_provider(cfg.provider)
        if provider is None:
            continue
        settings = provider.public_settings(cfg)
        result.append({
            "provider": provider.id,
            "label": provider.label,
            "environment": settings.get("environment"),
            # Sandbox on a production instance: only the team can buy (tests).
            "test_mode": is_test_mode(cfg),
            "client_id": settings.get("client_id"),
            "methods": list(provider.methods),
            "currencies": sorted(provider.supported_currencies),
        })
    return result

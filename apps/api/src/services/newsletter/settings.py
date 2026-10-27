"""Sanar y Criar: newsletter pop-up settings (one row per org, upserted)."""

from typing import Optional

from fastapi import HTTPException
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from src.db.newsletter.newsletter import NewsletterSettings
from src.services.newsletter import resend_sync
from src.services.newsletter.common import clean_line, clean_multiline
from src.services.payments.common import get_org_or_404, iso, utcnow

# The only source of the suggested texts (the dashboard's "restore" button
# reads them from GET /settings -> "defaults").
DEFAULT_SETTINGS = {
    "enabled": False,
    "title": "Recibe ideas para criar desde la calma",
    "body": "Déjame tu correo y te escribiré de vez en cuando con consejos prácticos de crianza, novedades y avisos de mis cursos y talleres.",
    "button_label": "Quiero recibirlas",
    "dismiss_label": "Ahora no",
    "success_message": "¡Listo, gracias por sumarte! Muy pronto te llegará mi primer correo.",
    "privacy_note": "Sin spam. Puedes darte de baja cuando quieras con un clic.",
    "delay_seconds": 0,
    "dismiss_days": 30,
}

# (min, max), checked after cleaning. Texts count characters.
LIMITS = {
    "title": (1, 120),
    "body": (1, 500),
    "button_label": (1, 40),
    "dismiss_label": (1, 40),
    "success_message": (1, 300),
    "privacy_note": (0, 300),
    "delay_seconds": (0, 120),
    "dismiss_days": (1, 365),
}

SETTINGS_FIELDS = tuple(DEFAULT_SETTINGS.keys())

# field -> (cleaner, "required" detail, "too long" detail)
_TEXT_RULES = {
    "title": (clean_line, "El título es obligatorio.", "El título admite como máximo 120 caracteres."),
    "body": (clean_multiline, "El texto es obligatorio.", "El texto admite como máximo 500 caracteres."),
    "button_label": (
        clean_line,
        "El texto del botón es obligatorio.",
        "El texto del botón admite como máximo 40 caracteres.",
    ),
    "dismiss_label": (
        clean_line,
        "El texto para cerrar es obligatorio.",
        "El texto para cerrar admite como máximo 40 caracteres.",
    ),
    "success_message": (
        clean_multiline,
        "El mensaje de agradecimiento es obligatorio.",
        "El mensaje de agradecimiento admite como máximo 300 caracteres.",
    ),
    "privacy_note": (clean_line, None, "La nota de privacidad admite como máximo 300 caracteres."),
}

_INT_RULES = {
    "delay_seconds": "El retraso debe ser un número entero entre 0 y 120.",
    "dismiss_days": "Los días sin mostrarla deben ser un número entero entre 1 y 365.",
}


class SettingsBody(BaseModel):  # PUT /settings: the panel always sends every field
    enabled: bool
    title: str
    body: str
    button_label: str
    dismiss_label: str
    success_message: str
    privacy_note: str = ""
    delay_seconds: int
    dismiss_days: int


def _validated(body: SettingsBody) -> dict:
    """Cleaned values, or a 400 with the first problem found (field order)."""
    values: dict = {"enabled": bool(body.enabled)}
    for field, (cleaner, required_detail, too_long_detail) in _TEXT_RULES.items():
        text = cleaner(getattr(body, field))
        low, high = LIMITS[field]
        if len(text) < low:
            raise HTTPException(status_code=400, detail=required_detail)
        if len(text) > high:
            raise HTTPException(status_code=400, detail=too_long_detail)
        values[field] = text
    for field, detail in _INT_RULES.items():
        number = getattr(body, field)
        low, high = LIMITS[field]
        if isinstance(number, bool) or not isinstance(number, int) or not low <= number <= high:
            raise HTTPException(status_code=400, detail=detail)
        values[field] = number
    return values


def _settings_dict(row: Optional[NewsletterSettings]) -> dict:
    if row is None:
        return dict(DEFAULT_SETTINGS)
    return {field: getattr(row, field) for field in SETTINGS_FIELDS}


async def _get_row(db_session: AsyncSession, org_id: int) -> Optional[NewsletterSettings]:
    return (await db_session.execute(
        select(NewsletterSettings).where(NewsletterSettings.org_id == org_id)
    )).scalars().first()


def _admin_payload(row: Optional[NewsletterSettings]) -> dict:
    payload = _settings_dict(row)
    payload["updated_at"] = iso(row.update_date) if row is not None else None
    payload["resend_enabled"] = resend_sync.resend_settings() is not None
    payload["defaults"] = dict(DEFAULT_SETTINGS)
    return payload


async def get_public_config(db_session: AsyncSession, org_id: int) -> dict:
    """``PublicConfig``: what the marketing site's pop-up needs (defaults without a row)."""
    await get_org_or_404(db_session, org_id)
    return _settings_dict(await _get_row(db_session, org_id))


async def get_admin_settings(db_session: AsyncSession, org_id: int) -> dict:
    """``AdminSettings``: the 9 fields plus ``updated_at``, ``resend_enabled`` and ``defaults``."""
    await get_org_or_404(db_session, org_id)
    return _admin_payload(await _get_row(db_session, org_id))


async def update_settings(db_session: AsyncSession, org_id: int, body: SettingsBody) -> dict:
    """Validate and upsert the org's row; returns ``AdminSettings``."""
    await get_org_or_404(db_session, org_id)
    values = _validated(body)

    for attempt in range(2):
        row = await _get_row(db_session, org_id)
        if row is None:
            row = NewsletterSettings(org_id=org_id, **values)
        else:
            for field, value in values.items():
                setattr(row, field, value)
            row.update_date = utcnow()
        db_session.add(row)
        try:
            await db_session.commit()
        except IntegrityError:
            # Two first saves raced on the unique org_id: update the winner's row.
            await db_session.rollback()
            if attempt:
                raise
            continue
        await db_session.refresh(row)
        return _admin_payload(row)
    raise HTTPException(status_code=500, detail="No se pudo guardar la configuración.")  # pragma: no cover

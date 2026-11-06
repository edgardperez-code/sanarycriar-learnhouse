"""Sanar y Criar: newsletter sign-up (public and signed-in) and subscriber management (admin).

The sign-up never reveals whether an address was already on the list: a new
address, a repeated one and a honeypot hit all get the same 200 body, and
none of them waits for Resend (the copy runs after the response), so the
answer takes the same time too.
The signed-in sign-up (``subscribe_me``, the platform's gift page) takes the
address and the first name from the account, never from the request body.
Resend is always reached through the ``resend_sync`` module (never a
``from ... import`` of its functions) so tests can monkeypatch it.
"""

import csv
import hashlib
import io
import re
import time
import unicodedata
from typing import Optional

from fastapi import HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict
from sqlalchemy import String, func, or_, update
from sqlalchemy.exc import IntegrityError
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from src.db.newsletter.newsletter import NewsletterSubscriber
from src.db.users import User
from src.services.newsletter import resend_sync
from src.services.newsletter.common import (
    EMAIL_MAX_RAW_LENGTH,
    VE_TZ,
    check_rate,
    clean_line,
    client_rate_key,
    csv_safe,
    normalize_email,
    sanitize_page_path,
)
from src.services.payments.common import as_utc, get_org_or_404, iso, utcnow
from src.services.security.profile_validation import contains_url

# Every value fits the 16-character ``source`` column (the tests' SQLite does
# not enforce VARCHAR lengths, Postgres does).
SOURCES = ("popup", "footer", "cartas", "test", "guia-gratis", "ventana-web")
NAME_MAX_LENGTH = 80
# Only this many characters of a sign-up's name are looked at (four times what
# is stored): plenty for a real name with stray spaces, and a huge request body
# cannot make the character-by-character pass of _clean_name slow.
NAME_SCAN_LENGTH = 4 * NAME_MAX_LENGTH
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

CSV_HEADER = ("email", "nombre", "fecha_alta", "origen", "pagina", "estado_resend")
_CSV_SOURCE = {
    "popup": "ventana",
    "footer": "pie",
    "cartas": "cartas",
    "test": "test",
    "guia-gratis": "guia_gratis",
    "ventana-web": "ventana_bienvenida",
    "other": "otro",
}
_CSV_STATUS = {"synced": "sincronizado", "pending": "pendiente", "error": "error", "skipped": "sin_resend"}


class SubscribeBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    email: str = ""
    name: Optional[str] = None   # first name, optional (see _clean_name)
    website: str = ""        # honeypot: must stay empty
    source: str = "popup"
    page: Optional[str] = None


class SubscribeMeBody(BaseModel):
    """``POST /subscribe/me``: the address and the name come from the account."""

    model_config = ConfigDict(extra="ignore")
    source: Optional[str] = None
    page: Optional[str] = None


def _normalize_source(value: Optional[str]) -> str:
    return value if value in SOURCES else "other"


# Sanar y Criar: a sign-up's first name reaches Resend as the contact's
# first_name, which the mails sent from the brand's domain greet with ("Hola
# {first_name}"), so it must never carry a link: the newsletter would relay
# phishing. What follows is built for a first name, not for any text.
#
# Invisible characters are dropped before the name is cleaned. A lone surrogate
# (a JSON "\ud83d" without its pair, category Cs) is something Postgres cannot
# store. Control (Cc) and format characters (Cf: zero-width spaces and joiners,
# direction marks, the BOM, soft hyphens, tags) and the rest of Unicode's
# default-ignorable code points (variation selectors, the combining grapheme
# joiner, Hangul fillers, and the unassigned ones renderers must hide as well)
# show nothing, so they would hide a link: "pago-sanarycriar.\ufe0fcom/x" is
# read as "pago-sanarycriar.com/x".
_NAME_DROPPED_CATEGORIES = ("Cc", "Cf", "Cs")
# Default_Ignorable_Code_Point (DerivedCoreProperties.txt, Unicode 16.0).
_DEFAULT_IGNORABLE_RE = re.compile(
    "[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f"
    "\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufff8"
    "\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]"
)
# The two invisible characters emoji are built with: the joiner that makes
# woman + girl one emoji (U+1F469 U+200D U+1F467) and the selector that turns
# the text heart U+2764 into the red emoji (U+2764 U+FE0F). Kept between emoji,
# so those names stay as typed, and dropped anywhere else; the link check
# never sees them. Tags are not kept: a subdivision flag (England's) shows as
# the plain black flag it starts with, and tags cannot smuggle hidden text.
_ZWJ = "\u200d"
_VS16 = "\ufe0f"
_SKIN_TONES = ("\U0001f3fb", "\U0001f3ff")
# Characters a link takes, or a reader sees, as its dot: the ideographic full
# stops IDNA reads as one (U+3002, U+FF61; NFKD already makes the fullwidth
# U+FF0E, U+FE52 and U+2024 a "."), and look-alikes drawn as a plain dot
# (Arabic-Indic zeros, the Syriac, Vai and Kharoshthi full stops, the Lisu
# tone letter U+A4F8, the musical augmentation dot). Not the middle dot:
# Catalan names have one ("Gal·la").
_NAME_DOT_LIKE = str.maketrans(dict.fromkeys(
    "\u3002\uff61\uff0e\u0660\u06f0\u0701\u0702\ua4f8\ua60e\U00010a50\U0001d16d", "."
))
# What no first name needs and every link or address has: a path or a scheme
# ("x.lat/pago", "x\pago", "mailto:", "tel:"), an e-mail or a handle ("@"),
# HTML ("<a href=...>"), or an HTML character reference ("&#46" is a dot once
# the mail is read as HTML; "Ana & Luis" stays).
_NAME_LINK_CHARS_RE = re.compile(r"[/\\@:<>]|&[#\w]")
# A dot followed by two letters or more, whatever the TLD ("x.lat", "x.ve",
# "x .page", "x..com"), and a dot between digits (an IP address: "203.0.113.5",
# or "127.1", which browsers read as 127.0.0.1). Initials and abbreviations
# followed by a space stay: "J.R.R.", "J.R.R. Tolkien", "Dr. Strange",
# "Ma. José". A name without a space after its dot ("Ma.De Los Ángeles",
# "Ana...María") is dropped too, on purpose: a first name never needs it, and
# the sign-up still succeeds, only without the name.
_NAME_DOTTED_RE = re.compile(r"\.[^\W\d_]{2}|\d\.\d")


def _is_invisible(char: str) -> bool:
    return (
        unicodedata.category(char) in _NAME_DROPPED_CATEGORIES
        or _DEFAULT_IGNORABLE_RE.match(char) is not None
    )


def _is_emoji(char: str) -> bool:
    """Close enough for the emoji glue (unicodedata has no emoji property):
    a non-ASCII symbol or a skin tone."""
    return char > "\x7f" and (
        unicodedata.category(char) in ("So", "Sm") or _SKIN_TONES[0] <= char <= _SKIN_TONES[1]
    )


def _visible_characters(text: str) -> str:
    """``text`` without its invisible characters (emoji glue between emoji
    aside), every kind of space made a plain one: a hair space after a dot
    cannot pass for no space at all, it shows as "x. lat"."""
    kept: list[str] = []
    for index, char in enumerate(text):
        if char.isspace():
            kept.append(" ")
        elif not _is_invisible(char):
            kept.append(char)
        elif char == _VS16 and kept and _is_emoji(kept[-1]):
            kept.append(char)
        elif (
            char == _ZWJ
            and kept
            and (kept[-1] == _VS16 or _is_emoji(kept[-1]))
            and index + 1 < len(text)
            and _is_emoji(text[index + 1])
        ):
            kept.append(char)
    return "".join(kept)


def _link_view(name: str) -> str:
    """``name`` as a link (or a reader looking for one) reads it.

    NFKD unfolds the compatibility forms as NFKC does (the fullwidth "．",
    "／" or "＠" become ASCII) and also splits the accents off, so that every
    combining mark can go ("l" plus an enclosing circle reads "l"); look-alike
    dots become "." and the emoji glue goes too.
    """
    text = unicodedata.normalize("NFKD", name).translate(_NAME_DOT_LIKE)
    return "".join(
        c for c in text if not (unicodedata.category(c).startswith("M") or _is_invisible(c))
    )


def _looks_like_link(name: str) -> bool:
    """True when the name, as stored or as a link reads it, carries a link or an address."""
    return any(
        contains_url(form) or _NAME_LINK_CHARS_RE.search(form) or _NAME_DOTTED_RE.search(form)
        for form in (name, _link_view(name))
    )


def _clean_name(value: Optional[str]) -> Optional[str]:
    """First name as stored: one clean line of at most 80 characters, or None.

    Invisible characters are dropped (the emoji glue aside) and every space
    made a plain one before the line is cleaned; a name that still carries a
    link or an address is then dropped whole (``_looks_like_link``). Never a
    reason to refuse a sign-up, and never logged.
    """
    text = value[:NAME_SCAN_LENGTH] if isinstance(value, str) else ""
    # The cut can leave the joiner of an emoji whose second half fell off.
    name = clean_line(_visible_characters(text))[:NAME_MAX_LENGTH].rstrip().rstrip(_ZWJ)
    if not name or _looks_like_link(name):
        return None
    return name


async def _find(db_session: AsyncSession, org_id: int, email: str) -> Optional[NewsletterSubscriber]:
    return (await db_session.execute(
        select(NewsletterSubscriber).where(
            NewsletterSubscriber.org_id == org_id,
            NewsletterSubscriber.email == email,
        )
    )).scalars().first()


async def _save(
    db_session: AsyncSession,
    org_id: int,
    email: str,
    name: Optional[str],
    source: Optional[str],
    page: Optional[str],
) -> None:
    """Store a sign-up and start its copy to Resend.

    A known address keeps where and when it first signed up; it only gains
    the name it did not have yet, and a stored name is never overwritten.
    """
    settings = resend_sync.resend_settings()
    row = await _find(db_session, org_id, email)
    if row is None:
        row = NewsletterSubscriber(
            org_id=org_id,
            email=email,
            name=name,
            source=_normalize_source(source),
            page_path=sanitize_page_path(page),
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
                return

    if name and row.name is None:
        # Conditional, so a sign-up racing this one cannot have its name replaced.
        await db_session.execute(
            update(NewsletterSubscriber)
            .where(NewsletterSubscriber.id == row.id, NewsletterSubscriber.name.is_(None))  # type: ignore[union-attr]
            .values(name=name)
        )
        await db_session.commit()

    # Never awaited here: a slow Resend must neither delay the answer (which
    # would tell new addresses from synced ones) nor turn a saved sign-up into
    # a timeout on the site. A row Resend misses stays pending/error for the
    # dashboard's "Sincronizar con Resend".
    if settings is not None and row.sync_status != "synced":
        resend_sync.schedule_sync(row.id, settings)


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

    await _save(db_session, org_id, email, _clean_name(body.name), body.source, body.page)
    return dict(OK_RESPONSE)


async def subscribe_me(
    db_session: AsyncSession, org_id: int, user, body: SubscribeMeBody
) -> dict:
    """The signed-in user's own sign-up, with the account's address and first name.

    Only a verified address is subscribed, so nobody can put someone else's
    address on the list from a session. ``user`` is a real account (the
    router refuses anonymous callers and API tokens).
    """
    await get_org_or_404(db_session, org_id)
    check_rate(f"sc_nl_sub_user:{user.id}", 10, 3600)

    # The session object may carry a stale ``email_verified``: read the row.
    account = (await db_session.execute(select(User).where(User.id == user.id))).scalars().first()
    if account is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    if not account.email_verified:
        raise HTTPException(status_code=403, detail="verify_email")
    email = normalize_email(account.email)
    if email is None:
        raise HTTPException(status_code=400, detail=INVALID_EMAIL_DETAIL)

    # Its own org-wide cap: anonymous sign-ups that fill the public route's
    # ``sc_nl_sub_org`` must not keep verified accounts off the list.
    check_rate(f"sc_nl_sub_me_org:{org_id}", 300, 3600)
    await _save(db_session, org_id, email, _clean_name(account.first_name), body.source, body.page)
    return dict(OK_RESPONSE)


def _subscriber_item(row: NewsletterSubscriber) -> dict:
    return {
        "id": row.id,
        "email": row.email,
        "name": row.name,
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


# Sanar y Criar: the name search ignores case and the Spanish accents ("maria"
# finds "María José"). The column and the search term are folded with this
# same table, the column with nested replace() calls (SQLite, which the tests
# use, and Postgres both have it). SQLite's lower() only lowers ASCII, hence
# the capitals too.
_NAME_FOLDS = (
    ("á", "a"), ("é", "e"), ("í", "i"), ("ó", "o"), ("ú", "u"), ("ü", "u"), ("ñ", "n"),
    ("Á", "a"), ("É", "e"), ("Í", "i"), ("Ó", "o"), ("Ú", "u"), ("Ü", "u"), ("Ñ", "n"),
)
_NAME_FOLD_TABLE = str.maketrans(dict(_NAME_FOLDS))


def _folded_name():
    """``lower(name)`` without the Spanish accents, as a SQL expression."""
    folded = func.lower(NewsletterSubscriber.name, type_=String)
    for accented, plain in _NAME_FOLDS:
        folded = func.replace(folded, accented, plain, type_=String)
    return folded


def _fold_search(term: str) -> str:
    """The search term folded like ``_folded_name`` (composed first, so an
    accent typed as a separate combining mark folds too)."""
    return unicodedata.normalize("NFC", term).lower().translate(_NAME_FOLD_TABLE)


async def list_subscribers(
    db_session: AsyncSession, org_id: int, page: int = 1, limit: int = 25, q: Optional[str] = None
) -> dict:
    """``SubscriberPage``: newest first, optionally filtered by part of the address or the name."""
    await get_org_or_404(db_session, org_id)
    search = (q or "").strip().lower()[:SEARCH_MAX_LENGTH]

    conditions = [NewsletterSubscriber.org_id == org_id]
    if search:
        # Addresses are stored lowercase; names as typed, so they are matched
        # ignoring case and the Spanish accents.
        conditions.append(or_(
            NewsletterSubscriber.email.contains(search, autoescape=True),  # type: ignore[union-attr]
            _folded_name().contains(_fold_search(search), autoescape=True),
        ))

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
            row.name or "",
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

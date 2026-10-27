"""Sanar y Criar: Bs. per US$ exchange rate for Pago Móvil.

The official BCV rate comes from ve.dolarapi.com (the BCV site fails TLS
verification with certifi: a missing intermediate certificate; we never
disable verification). Each accepted rate is cached in Redis for 30 minutes
and kept in ``sc_pay_fx_rate`` (one ``bcv`` row per value date).

Sanity rule, because a wrong rate charges the wrong amount:

- The *reference* is the latest ``bcv`` row fetched in the last 96 h.
- A reading within ±20 % of the reference is accepted.
- A reading outside that band is not accepted yet: it is kept as a candidate
  (a ``bcv_candidate`` row) and accepted only when a reading at least 10 min
  later agrees with it within ±1 %. Meanwhile the reference is served
  (``stale``, with a ``warning`` for the admin).
- With no reference (a new install, or nothing in 96 h) the first valid
  reading is accepted.
- When the source fails, the reference is served (``stale``), never anything
  older than 96 h; without one, ``FxUnavailable``.

Downloads: one at a time per process (the others wait for its result), a
10 s overall deadline, and the body read as a stream capped at 64 KB.

An org admin may also fix the rate by hand (``fx_mode = "manual"``).
Tests never reach the network: ``fetch_bcv_payload`` refuses to run under
``TESTING`` and tests patch it.
"""

import asyncio
import json
import logging
import math
import os
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Optional
from urllib.parse import urlparse

import httpx
from sqlalchemy.exc import IntegrityError
from sqlmodel import delete, select
from sqlmodel.ext.asyncio.session import AsyncSession

from src.db.payments.purchases import PaymentsFxRate
from src.services.payments.common import as_utc, utcnow
from src.services.payments.settings import is_development_mode

logger = logging.getLogger(__name__)

BCV_URL = "https://ve.dolarapi.com/v1/dolares/oficial"
FX_URL_ENV_VAR = "SC_PAY_FX_URL"
SOURCE_BCV = "bcv"
SOURCE_CANDIDATE = "bcv_candidate"
SOURCE_MANUAL = "manual"
CACHE_KEY = "sc_pay:fx:bcv:v1"
CACHE_TTL_SECONDS = 1800
FAIL_KEY = "sc_pay:fx:bcv:fail"
FAIL_TTL_SECONDS = 60
# While a jump waits for confirmation, the reference is cached this long.
SUSPECT_TTL_SECONDS = 60
REFERENCE_MAX_AGE = timedelta(hours=96)
STALE_MAX_AGE = REFERENCE_MAX_AGE
BAND = Decimal("0.20")
CONFIRM_TOLERANCE = Decimal("0.01")
CONFIRM_AFTER = timedelta(minutes=10)
JUMP_WARNING = "La tasa del BCV cambió más de 20 %: la confirmamos en unos minutos."
MAX_PLAUSIBLE_RATE = 10_000_000
HTTP_TIMEOUT_SECONDS = 8
DOWNLOAD_DEADLINE_SECONDS = 10
MAX_BODY_BYTES = 64 * 1024
RATE_QUANTUM = Decimal("0.000001")
CARACAS_OFFSET = timezone(timedelta(hours=-4))  # Venezuela: UTC-4, no DST

try:  # pragma: no cover - tzdata is present in the image
    from zoneinfo import ZoneInfo

    CARACAS_TZ = ZoneInfo("America/Caracas")
except Exception:  # pragma: no cover
    CARACAS_TZ = CARACAS_OFFSET


@dataclass
class FxQuote:
    rate: Decimal
    source: str
    rate_date: Optional[date]
    fetched_at: datetime
    stale: bool
    warning: Optional[str] = None


class FxUnavailable(Exception):
    """No usable rate: the source failed and nothing recent is stored, or the
    manual rate is missing."""


def to_ves(amount_usd: Decimal, rate: Decimal) -> Decimal:
    return (Decimal(amount_usd) * Decimal(rate)).quantize(Decimal("0.01"), ROUND_HALF_UP)


def caracas_today() -> date:
    return datetime.now(CARACAS_TZ).date()


def within(value: Decimal, reference: Decimal, tolerance: Decimal) -> bool:
    """``value`` is at most ``tolerance`` (a fraction) away from ``reference``."""
    return reference > 0 and abs(value - reference) / reference <= tolerance


# --------------------------------------------------------------- download


def fx_url() -> str:
    """The rate source. ``SC_PAY_FX_URL`` replaces it in development mode only."""
    if is_development_mode():
        override = (os.environ.get(FX_URL_ENV_VAR) or "").strip()
        parsed = urlparse(override)
        if override and parsed.scheme in ("http", "https") and parsed.netloc:
            return override
    return BCV_URL


async def fetch_bcv_payload() -> Any:
    """GET the rate source and return its JSON. Raises on any failure.

    10 s overall (connect, headers and body), no redirects, and the body read
    as a stream: more than 64 KB is an error, whatever the headers claim.
    Tests patch this function (it refuses to touch the network under TESTING).
    """
    if os.getenv("TESTING", "false").lower() == "true":
        raise RuntimeError("The FX source is not reachable from tests: patch fetch_bcv_payload")
    body = bytearray()
    async with asyncio.timeout(DOWNLOAD_DEADLINE_SECONDS):
        async with httpx.AsyncClient(
            timeout=HTTP_TIMEOUT_SECONDS,
            follow_redirects=False,
            headers={"User-Agent": "SanaryCriar/1.0", "Accept": "application/json"},
        ) as client:
            async with client.stream("GET", fx_url()) as response:
                if response.status_code != 200:
                    raise ValueError(f"FX source answered HTTP {response.status_code}")
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > MAX_BODY_BYTES:
                        raise ValueError("FX source answer is too large")
    return json.loads(bytes(body))


def parse_bcv_payload(payload: Any) -> tuple[Decimal, date]:
    """Validate the dolarapi answer; return (rate, value date). Raises ValueError."""
    if not isinstance(payload, dict):
        raise ValueError("FX payload is not an object")
    if payload.get("moneda") != "USD" or payload.get("fuente") != "oficial":
        raise ValueError("FX payload is not the official USD rate")
    average = payload.get("promedio")
    if isinstance(average, bool) or not isinstance(average, (int, float)):
        raise ValueError("FX payload has no numeric average")
    if not math.isfinite(average) or not (0 < average < MAX_PLAUSIBLE_RATE):
        raise ValueError("FX average out of range")
    try:
        rate = Decimal(str(average)).quantize(RATE_QUANTUM)
    except (InvalidOperation, ValueError) as exc:
        raise ValueError("FX average is not a decimal") from exc
    if rate <= 0:
        raise ValueError("FX average rounds to zero")
    return rate, _value_date(payload.get("fechaActualizacion"))


def _value_date(value: Any) -> date:
    """Date of ``fechaActualizacion`` in Caracas ("fecha valor"); today if absent."""
    text = str(value or "").strip()
    if text:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            parsed = None
        if parsed is not None:
            if parsed.tzinfo is not None:
                parsed = parsed.astimezone(CARACAS_TZ)
            return parsed.date()
    logger.warning("FX payload has no usable fechaActualizacion; using today's date")
    return caracas_today()


# ------------------------------------------------------------------ cache


def _redis():
    if os.getenv("TESTING", "false").lower() == "true":
        return None
    try:
        from src.core.redis import get_redis_client

        return get_redis_client()
    except Exception:
        return None


def _cache_get(client, key: str) -> Optional[str]:
    if client is None:
        return None
    try:
        value = client.get(key)
    except Exception:
        return None
    if value is None:
        return None
    return value.decode() if isinstance(value, bytes) else str(value)


def _cache_set(client, key: str, value: str, ttl: int) -> None:
    if client is None:
        return
    try:
        client.set(key, value, ex=ttl)
    except Exception:
        logger.debug("FX cache write failed", exc_info=True)


def _encode(quote: FxQuote) -> str:
    return json.dumps({
        "rate": str(quote.rate),
        "rate_date": quote.rate_date.isoformat() if quote.rate_date else None,
        "fetched_at": quote.fetched_at.isoformat(),
        "stale": quote.stale,
        "warning": quote.warning,
    })


def _decode(text: Optional[str]) -> Optional[FxQuote]:
    if not text:
        return None
    try:
        data = json.loads(text)
        rate = Decimal(str(data["rate"]))
        if not rate.is_finite() or rate <= 0:
            return None
        quote = FxQuote(
            rate=rate,
            source=SOURCE_BCV,
            rate_date=date.fromisoformat(data["rate_date"]) if data.get("rate_date") else None,
            fetched_at=as_utc(datetime.fromisoformat(data["fetched_at"])) or utcnow(),
            stale=bool(data.get("stale")),
            warning=data.get("warning") or None,
        )
    except Exception:
        return None
    if quote.stale and quote.fetched_at < utcnow() - STALE_MAX_AGE:
        return None  # never serve anything older than 96 h
    return quote


# --------------------------------------------------------------- storage


def _quote_of(row: PaymentsFxRate, *, stale: bool, warning: Optional[str] = None) -> FxQuote:
    return FxQuote(
        rate=Decimal(str(row.rate)),
        source=SOURCE_BCV,
        rate_date=row.rate_date,
        fetched_at=as_utc(row.fetched_at) or utcnow(),
        stale=stale,
        warning=warning,
    )


async def _latest(db_session: AsyncSession, source: str, since: Optional[datetime]) -> Optional[PaymentsFxRate]:
    stmt = select(PaymentsFxRate).where(PaymentsFxRate.source == source)
    if since is not None:
        stmt = stmt.where(PaymentsFxRate.fetched_at >= since)
    return (await db_session.execute(
        stmt.order_by(PaymentsFxRate.rate_date.desc(), PaymentsFxRate.fetched_at.desc())  # type: ignore[union-attr]
        .limit(1)
        .execution_options(populate_existing=True)
    )).scalars().first()


async def reference_rate(db_session: AsyncSession) -> Optional[PaymentsFxRate]:
    """The latest ``bcv`` row fetched in the last 96 h (the sanity reference)."""
    return await _latest(db_session, SOURCE_BCV, utcnow() - REFERENCE_MAX_AGE)


async def recent_bcv_rate(db_session: AsyncSession, max_age: timedelta) -> Optional[Decimal]:
    """The latest stored BCV rate fetched within ``max_age`` (no download)."""
    row = await _latest(db_session, SOURCE_BCV, utcnow() - max_age)
    return Decimal(str(row.rate)) if row is not None else None


async def _write(db_session: AsyncSession, apply) -> None:
    """Run ``apply`` in a SAVEPOINT and commit. A failure (another worker
    writing the same day at the same moment) only undoes this write, never
    the caller's transaction, so a request's loaded ORM objects stay usable."""
    try:
        async with db_session.begin_nested():
            await apply()
    except IntegrityError:
        logger.info("FX rate row written by another worker meanwhile")
        return
    await db_session.commit()


async def _store_accepted(db_session: AsyncSession, rate: Decimal, rate_date: date, fetched_at: datetime) -> None:
    """Upsert the (bcv, rate_date) row and drop any candidate."""
    async def apply():
        row = (await db_session.execute(
            select(PaymentsFxRate).where(
                PaymentsFxRate.source == SOURCE_BCV, PaymentsFxRate.rate_date == rate_date
            ).execution_options(populate_existing=True)
        )).scalars().first()
        if row is None:
            db_session.add(PaymentsFxRate(source=SOURCE_BCV, rate=rate, rate_date=rate_date, fetched_at=fetched_at))
        else:
            row.rate = rate
            row.fetched_at = fetched_at
            db_session.add(row)
        await db_session.execute(delete(PaymentsFxRate).where(PaymentsFxRate.source == SOURCE_CANDIDATE))

    await _write(db_session, apply)


async def _store_candidate(db_session: AsyncSession, rate: Decimal, rate_date: date, seen_at: datetime) -> None:
    """Keep one candidate: this reading, first seen ``seen_at``."""
    async def apply():
        await db_session.execute(delete(PaymentsFxRate).where(PaymentsFxRate.source == SOURCE_CANDIDATE))
        db_session.add(PaymentsFxRate(source=SOURCE_CANDIDATE, rate=rate, rate_date=rate_date, fetched_at=seen_at))

    await _write(db_session, apply)


# ------------------------------------------------------------------ rates


async def _accept(db_session: AsyncSession, client, rate: Decimal, rate_date: date, now: datetime) -> FxQuote:
    await _store_accepted(db_session, rate, rate_date, now)
    quote = FxQuote(rate=rate, source=SOURCE_BCV, rate_date=rate_date, fetched_at=now, stale=False)
    _cache_set(client, CACHE_KEY, _encode(quote), CACHE_TTL_SECONDS)
    return quote


async def _refresh(db_session: AsyncSession, client) -> FxQuote:
    """Ask the source and apply the sanity rule (see the module docstring)."""
    now = utcnow()
    reference = await reference_rate(db_session)
    reading = None
    if _cache_get(client, FAIL_KEY) is None:
        try:
            reading = parse_bcv_payload(await fetch_bcv_payload())
        except Exception as exc:
            logger.warning("BCV rate unavailable from %s: %s", fx_url(), exc)
            _cache_set(client, FAIL_KEY, "1", FAIL_TTL_SECONDS)
    if reading is None:
        if reference is None:
            raise FxUnavailable("No BCV rate available")
        return _quote_of(reference, stale=True)

    rate, rate_date = reading
    if reference is None:
        logger.info("BCV rate %s (%s) accepted: no reference in the last 96 h", rate, rate_date)
        return await _accept(db_session, client, rate, rate_date, now)
    previous = Decimal(str(reference.rate))
    if within(rate, previous, BAND):
        return await _accept(db_session, client, rate, rate_date, now)

    candidate = await _latest(db_session, SOURCE_CANDIDATE, None)
    if candidate is not None and within(rate, Decimal(str(candidate.rate)), CONFIRM_TOLERANCE):
        if now - (as_utc(candidate.fetched_at) or now) >= CONFIRM_AFTER:
            logger.warning("BCV rate %s (%s) confirmed after a jump from %s (%s)",
                           rate, rate_date, previous, reference.rate_date)
            return await _accept(db_session, client, rate, rate_date, now)
        # The same jump again, too soon: keep waiting (its first-seen time stays).
    else:
        logger.error(
            "BCV rate %s (%s) is more than 20%% away from %s (%s): kept as a candidate until a reading "
            "10 min later confirms it", rate, rate_date, previous, reference.rate_date,
        )
        await _store_candidate(db_session, rate, rate_date, now)
    quote = _quote_of(reference, stale=True, warning=JUMP_WARNING)
    _cache_set(client, CACHE_KEY, _encode(quote), SUSPECT_TTL_SECONDS)
    return quote


# One refresh at a time per process: whoever waited for it shares its answer.
_flight_lock: Optional[asyncio.Lock] = None
_flight_loop: Optional[asyncio.AbstractEventLoop] = None
_flight_generation = 0
_flight_answer: Optional[FxQuote] = None  # None after an FxUnavailable


def _single_flight_lock() -> asyncio.Lock:
    global _flight_lock, _flight_loop
    loop = asyncio.get_running_loop()
    if _flight_lock is None or _flight_loop is not loop:
        _flight_lock, _flight_loop = asyncio.Lock(), loop
    return _flight_lock


async def bcv_rate(db_session: AsyncSession) -> FxQuote:
    """Today's official rate (see the module docstring). Raises FxUnavailable."""
    global _flight_generation, _flight_answer
    client = _redis()
    cached = _decode(_cache_get(client, CACHE_KEY))
    if cached is not None:
        return cached
    seen = _flight_generation
    async with _single_flight_lock():
        if _flight_generation != seen:
            # Another request asked the source while this one waited.
            if _flight_answer is None:
                raise FxUnavailable("No BCV rate available")
            return _flight_answer
        cached = _decode(_cache_get(client, CACHE_KEY))  # another worker, meanwhile
        if cached is not None:
            return cached
        try:
            quote = await _refresh(db_session, client)
        except FxUnavailable:
            _flight_answer, _flight_generation = None, _flight_generation + 1
            raise
        _flight_answer, _flight_generation = quote, _flight_generation + 1
        return quote


def manual_rate_of(settings: dict) -> Optional[Decimal]:
    """The admin's fixed rate (stored as decimal text), or None."""
    value = (settings or {}).get("fx_manual_rate")
    if value in (None, ""):
        return None
    try:
        rate = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    if not rate.is_finite() or rate <= 0:
        return None
    return rate.quantize(RATE_QUANTUM)


async def current_rate(db_session: AsyncSession, cfg) -> FxQuote:
    """The rate a purchase would use right now for ``cfg`` (the org's manual
    Pago Móvil config, or None for defaults). Raises FxUnavailable."""
    settings = dict(getattr(cfg, "provider_config", None) or {})
    if settings.get("fx_mode") == "manual":
        rate = manual_rate_of(settings)
        if rate is None:
            raise FxUnavailable("The manual rate is missing")
        return FxQuote(
            rate=rate,
            source=SOURCE_MANUAL,
            rate_date=None,
            fetched_at=as_utc(getattr(cfg, "update_date", None)) or utcnow(),
            stale=False,
        )
    return await bcv_rate(db_session)

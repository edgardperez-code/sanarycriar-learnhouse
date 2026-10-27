"""Sanar y Criar: shared helpers for the newsletter services.

Every text the newsletter stores is plain text: nothing here (or in the site
that renders it) interprets HTML or Markdown.
"""

import ipaddress
import logging
import os
import re
from datetime import timedelta, timezone
from typing import Any, Optional

from fastapi import HTTPException

# Venezuela has no DST (UTC-4 all year). A fixed offset avoids depending on
# tzdata, which the container image may not ship.
VE_TZ = timezone(timedelta(hours=-4))

# Sanar y Criar: the static site validates with the very same expression
# (web/src/lib/newsletter.ts), so both sides agree on what is a valid address.
EMAIL_RE = re.compile(r"^(?=.{3,254}$)(?=[^@]{1,64}@)[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$")

EMAIL_MAX_RAW_LENGTH = 320
PAGE_PATH_MAX_LENGTH = 200

_PAGE_PATH_RE = re.compile(r"^/[A-Za-z0-9/_.\-]*$")
# Sanar y Criar: whitespace-like controls (tab, line breaks, vertical tab, form
# feed) become a space, so "Sin spam.<Enter>Puedes..." does not glue the
# words together; every other control character is dropped.
_SPACE_CONTROL_RE = re.compile(r"[\t\n\v\f\r]")
_INLINE_SPACE_CONTROL_RE = re.compile(r"[\t\v\f]")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_CONTROL_EXCEPT_NEWLINE_RE = re.compile(r"[\x00-\x09\x0b-\x1f\x7f]")
_SPACES_RE = re.compile(r" {2,}")
_NEWLINES_RE = re.compile(r"\n{3,}")
# Cells starting with these are read as formulas by spreadsheet apps.
_CSV_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def normalize_email(raw: Any) -> Optional[str]:
    """Stripped, lowercase address, or ``None`` when it is not valid."""
    if not isinstance(raw, str):
        return None
    email = raw.strip().lower()
    return email if EMAIL_RE.fullmatch(email) else None


def clean_line(value: Any) -> str:
    """Single-line text: no control characters, single spaces, trimmed."""
    text = value if isinstance(value, str) else ""
    text = _SPACE_CONTROL_RE.sub(" ", text)
    text = _CONTROL_RE.sub("", text)
    return _SPACES_RE.sub(" ", text).strip()


def clean_multiline(value: Any) -> str:
    """Multi-line text: ``\\n`` line breaks only, at most one blank line, trimmed."""
    text = value if isinstance(value, str) else ""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _INLINE_SPACE_CONTROL_RE.sub(" ", text)
    text = _CONTROL_EXCEPT_NEWLINE_RE.sub("", text)
    return _NEWLINES_RE.sub("\n\n", text).strip()


def sanitize_page_path(value: Any) -> Optional[str]:
    """Site path the sign-up came from (no query or fragment), or ``None``."""
    if not isinstance(value, str):
        return None
    path = re.split(r"[?#]", value, maxsplit=1)[0]
    if len(path) > PAGE_PATH_MAX_LENGTH or not _PAGE_PATH_RE.fullmatch(path):
        return None
    return path


def client_rate_key(ip: str) -> str:
    """Rate-limit key for a client address.

    Sanar y Criar: an IPv6 client usually owns a whole /64, so keying by the
    full address lets one machine rotate past the per-IP limit. IPv6 is keyed
    by its /64 (IPv4-mapped addresses by their IPv4); anything that does not
    parse is used as is.
    """
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return ip
    if isinstance(addr, ipaddress.IPv6Address):
        if addr.ipv4_mapped is not None:
            return str(addr.ipv4_mapped)
        return str(ipaddress.ip_network(f"{addr}/64", strict=False))
    return str(addr)


def csv_safe(value: Any) -> str:
    """CSV cell that a spreadsheet will not evaluate as a formula."""
    text = "" if value is None else str(value)
    if text.startswith(_CSV_FORMULA_PREFIXES):
        return "'" + text
    return text


def check_rate(key: str, limit: int, window: int) -> None:
    """Soft rate limit; never fails closed when Redis is unavailable.

    Same behaviour as the payments router's ``_check_rate``. ``TESTING`` is
    read on every call and ``check_rate_limit`` is imported here so tests can
    patch both.
    """
    if os.getenv("TESTING", "false").lower() == "true":
        return
    try:
        from src.services.security.rate_limiting import check_rate_limit

        allowed, _, retry_after = check_rate_limit(key, limit, window)
    except Exception:
        return
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail="Demasiados intentos. Espera un momento e inténtalo de nuevo.",
            headers={"Retry-After": str(retry_after)},
        )


# Sanar y Criar: the dashboard's subscriber search sends part of an address as
# ``?q=`` and uvicorn's access log prints the full query string, which would
# keep searched addresses in the platform logs after the row is deleted. The
# filter masks ``q`` on newsletter paths only; every other log line is left
# untouched.
ACCESS_LOGGER_NAME = "uvicorn.access"
_SEARCH_PARAM_RE = re.compile(r"([?&]q=)[^&\s\"]*")


def redact_newsletter_search(text: str) -> str:
    """``text`` with the ``q`` parameter of newsletter URLs masked."""
    if "/newsletter/" not in text or "q=" not in text:
        return text
    return _SEARCH_PARAM_RE.sub(r"\1[redacted]", text)


class NewsletterSearchRedactionFilter(logging.Filter):
    """Masks the subscriber search in access-log records (args and message)."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            if isinstance(record.args, tuple):
                record.args = tuple(
                    redact_newsletter_search(arg) if isinstance(arg, str) else arg
                    for arg in record.args
                )
            if isinstance(record.msg, str):
                record.msg = redact_newsletter_search(record.msg)
        except Exception:
            pass
        return True


def install_access_log_redaction() -> None:
    """Attach the filter to uvicorn's access logger once (idempotent)."""
    access_logger = logging.getLogger(ACCESS_LOGGER_NAME)
    if not any(isinstance(f, NewsletterSearchRedactionFilter) for f in access_logger.filters):
        access_logger.addFilter(NewsletterSearchRedactionFilter())

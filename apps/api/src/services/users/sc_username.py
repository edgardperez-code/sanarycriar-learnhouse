"""Sanar y Criar: a username for sign-ups that do not ask for one.

The sign-up form asks a mother for her email, password and name only. The
account still needs a unique handle (profile URLs, admin lists, webhooks), so
a blank ``UserCreate.username`` gets one here, server-side, before the
signup's conflict check. A username that was sent (admin tools, Google
sign-in, tests) is kept exactly as before.

The rule:

- base: ``first_name + last_name`` folded to ASCII (NFKD, combining marks
  dropped), lower-cased, keeping only ``[a-z0-9]``;
- shorter than 3 characters: the e-mail's local part, folded the same way;
- still shorter than 3: ``"mama"``;
- the base is cut to 20 characters and a random 6-digit number is appended,
  so every generated username matches ``^[a-z0-9]{3,20}[0-9]{6}$``;
- a username already taken (compared case-insensitively) draws a new number,
  up to 5 more times.

Only letters and digits, never a dot: a generated "maria.co" would read as a
link to ``contains_url`` and the signup would be refused.
"""

import logging
import re
import secrets
import unicodedata

from fastapi import HTTPException
from sqlmodel import func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from src.db.users import User

logger = logging.getLogger(__name__)

USERNAME_BASE_MIN = 3
USERNAME_BASE_MAX = 20
USERNAME_FALLBACK_BASE = "mama"
USERNAME_SUFFIX_DIGITS = 6
# A taken username draws a new number this many times after the first draw.
USERNAME_RETRIES = 5
GENERATED_USERNAME_RE = re.compile(r"^[a-z0-9]{3,20}[0-9]{6}$")

_NOT_ALNUM = re.compile(r"[^a-z0-9]+")


def fold(value: str | None) -> str:
    """``value`` without accents, lower-cased, ASCII letters and digits only."""
    decomposed = unicodedata.normalize("NFKD", value or "")
    unmarked = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return _NOT_ALNUM.sub("", unmarked.lower())


def username_base(first_name: str | None, last_name: str | None, email: str | None) -> str:
    """The part of a generated username before its number."""
    base = fold(f"{first_name or ''}{last_name or ''}")
    if len(base) < USERNAME_BASE_MIN:
        base = fold(str(email or "").rsplit("@", 1)[0])
    if len(base) < USERNAME_BASE_MIN:
        base = USERNAME_FALLBACK_BASE
    return base[:USERNAME_BASE_MAX]


def needs_generated_username(username: str | None) -> bool:
    """True when the signup sent no username (missing, empty or blank)."""
    return not (username or "").strip()


def _random_suffix() -> str:
    """A random number of exactly ``USERNAME_SUFFIX_DIGITS`` digits (no leading zero)."""
    low = 10 ** (USERNAME_SUFFIX_DIGITS - 1)
    return str(low + secrets.randbelow(9 * low))


async def username_taken(db_session: AsyncSession, username: str) -> bool:
    """Whether any account already has ``username``, ignoring case."""
    found = (await db_session.execute(
        select(User.id).where(func.lower(User.username) == username.lower()).limit(1)
    )).first()
    return found is not None


async def generate_username(
    db_session: AsyncSession,
    first_name: str | None,
    last_name: str | None,
    email: str | None,
) -> str:
    """A username no account has yet, built from the name or the e-mail."""
    base = username_base(first_name, last_name, email)
    for _ in range(1 + USERNAME_RETRIES):
        candidate = f"{base}{_random_suffix()}"
        if not await username_taken(db_session, candidate):
            return candidate

    # A million numbers per base: reaching this means something else is wrong.
    # The name is personal data, so it stays out of the log.
    logger.warning(
        "No free generated username after %s draws; signup refused", 1 + USERNAME_RETRIES
    )
    raise HTTPException(
        status_code=503,
        detail="Could not create the account right now. Please try again.",
    )

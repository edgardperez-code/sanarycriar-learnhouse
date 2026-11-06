"""Sanar y Criar: the page a verification link sends a new account back to.

The gift page (``/regalo?resultado=…&origen=…``) asks the visitor to sign up
first. The verification e-mail is often opened in another browser (Instagram,
then Gmail, then Chrome), where the web's own memory of that page is gone. So
the signup, and the "resend" button, may name the page: it is kept in Redis
next to the verification token, for as long as the newest link lives, and the
link carries it as ``&redirect=``, which the web's verify page follows.

Only ``/regalo`` (with or without a query) in a narrow character set gets
through, so a link can never lead anywhere else. Anything else is dropped
silently: a return path never fails a signup or a resend, and it is never
stored on the user.
"""

import logging
import re
from typing import Any, Optional

logger = logging.getLogger(__name__)

RETURN_PATH_MAX_LENGTH = 512
RETURN_PATH_KEY = "email_verification_return:{user_uuid}"

# The character set already leaves out "\", "#", spaces, quotes and control
# characters; ``fullmatch`` also refuses a trailing newline, which ``$`` lets by.
_RETURN_PATH_RE = re.compile(r"/regalo(?:\?[A-Za-z0-9/?&=_.%-]*)?")
# Percent-encoded "/", "\" and ".", any case.
_ENCODED_SEPARATOR_RE = re.compile(r"%(?:2f|5c|2e)", re.IGNORECASE)


def safe_return_path(value: Any) -> Optional[str]:
    """``value`` when it is a ``/regalo`` path safe to put in a link, else None."""
    if not isinstance(value, str) or len(value) > RETURN_PATH_MAX_LENGTH:
        return None
    if not _RETURN_PATH_RE.fullmatch(value):
        return None
    if "//" in value or ".." in value or _ENCODED_SEPARATOR_RE.search(value):
        return None
    return value


def keep_return_path(r, user_uuid: str, new_path: Any, ttl_seconds: int) -> Optional[str]:
    """The return path for the verification link about to be sent, or None.

    A safe ``new_path`` replaces the stored one; otherwise the stored one is
    used again. Either way it is (re)stored for ``ttl_seconds``, the life of
    the new link. ``r`` is the verification tokens' Redis client. Never
    raises: if Redis fails, the link carries ``new_path`` (when safe) and
    nothing is remembered.
    """
    key = RETURN_PATH_KEY.format(user_uuid=user_uuid)
    path = safe_return_path(new_path)
    try:
        if path is None:
            stored = r.get(key)
            if isinstance(stored, bytes):
                stored = stored.decode("utf-8", "replace")
            path = safe_return_path(stored)
        if path is not None:
            r.setex(key, ttl_seconds, path)
    except Exception:
        logger.warning("Could not keep the verification return path of %s", user_uuid, exc_info=True)
    return path

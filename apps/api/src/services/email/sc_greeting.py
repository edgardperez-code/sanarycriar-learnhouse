"""Sanar y Criar: mail greets the account holder by first name, never by username.

Sign-up no longer asks for a username: the API makes one up
("mariapena583735", services/users/sc_username.py), a handle that means
nothing to the reader, so no mail greets by it. ``email_first_name`` is the
name a mail may greet by; ``named_copy`` renders a copy key with it, or the
key's ``_noname`` variant when there is none (``NAMELESS_COPY`` in
translations.py).
"""

import html
from typing import Optional

from src.services.email.translations import t


def email_first_name(value: Optional[str]) -> str:
    """The first name to greet by, or "" when there is none to use.

    The newsletter's rule for a first name the brand's mail greets with
    (``_clean_name`` in services/newsletter/subscribers.py): one clean line,
    invisible characters dropped, and a name that carries a link or an
    address dropped whole, so a mail sent to any address cannot relay one.
    A name with no letter or digit left is no name either. Plain text: the
    caller escapes it for HTML.
    """
    # Imported here: that module pulls in the database models.
    from src.services.newsletter.subscribers import _clean_name

    name = _clean_name(value) or ""
    return name if any(ch.isalnum() for ch in name) else ""


def named_copy(lang: str, key: str, first_name: Optional[str], *, escape: bool = True, **fmt) -> str:
    """The copy at ``key``, addressed to the account holder.

    The upstream copy keeps its ``{username}`` placeholder, which gets the
    first name (``email_first_name``), HTML-escaped. ``escape=False`` is for
    a plain-text subject, where escaping would show "D&#x27;Angelo" in the
    inbox (``send_email`` drops line breaks from it). Without a first name the
    ``<key>_noname`` copy says the same with no name. ``fmt`` fills the other
    placeholders and must already be safe.
    """
    name = email_first_name(first_name)
    if not name:
        return t(lang, f"{key}_noname", **fmt)
    return t(lang, key, username=html.escape(name) if escape else name, **fmt)

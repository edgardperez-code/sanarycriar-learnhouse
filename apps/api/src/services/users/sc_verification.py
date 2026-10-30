"""Sanar y Criar: email verification for password signups.

Upstream LearnHouse only verifies emails in SaaS mode; OSS accounts are
created verified. Our free content (the free ebook) requires a signed-in
account with a verified email, so password signups verify their address
first. ``SC_EMAIL_VERIFICATION=0`` restores the upstream behaviour: accounts
are created verified and free courses are open to everyone.
"""

import os

_OFF_VALUES = {"0", "false", "no", "off"}


def sc_email_verification_enabled() -> bool:
    """Read on every call so the switch needs no restart."""
    return os.getenv("SC_EMAIL_VERIFICATION", "1").strip().lower() not in _OFF_VALUES


def password_signup_needs_verification(password: str | None, is_oauth: bool) -> bool:
    """True when a new account must verify its email before using free content."""
    return not is_oauth and bool(password) and sc_email_verification_enabled()

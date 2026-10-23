"""Sanar y Criar: environment-derived settings for the payments module.

Read live from the environment on every call (like ``get_learnhouse_config``)
so tests can monkeypatch them.
"""

import os
from typing import Optional
from urllib.parse import urlparse

from config.config import get_learnhouse_config

PAYPAL_API_BASES = {
    "sandbox": "https://api-m.sandbox.paypal.com",
    "live": "https://api-m.paypal.com",
}

PAYPAL_DASHBOARD_URLS = {
    "sandbox": "https://www.sandbox.paypal.com/activity",
    "live": "https://www.paypal.com/activity",
}


def is_development_mode() -> bool:
    return bool(get_learnhouse_config().general_config.development_mode)


def _clean_base(value: Optional[str]) -> Optional[str]:
    value = (value or "").strip().rstrip("/")
    if not value:
        return None
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    return value


def paypal_api_base(environment: str) -> str:
    """REST base URL for ``environment``.

    ``LEARNHOUSE_PAYPAL_API_BASE`` (the local PayPal mock) is honoured only in
    development mode, so a stray variable can never redirect production
    credentials to another host.
    """
    if is_development_mode():
        override = _clean_base(os.environ.get("LEARNHOUSE_PAYPAL_API_BASE"))
        if override:
            return override
    return PAYPAL_API_BASES.get(environment, PAYPAL_API_BASES["sandbox"])


def paypal_web_base_override() -> Optional[str]:
    """Origin to rewrite PayPal approval links to (development only)."""
    if not is_development_mode():
        return None
    return _clean_base(os.environ.get("LEARNHOUSE_PAYPAL_WEB_BASE"))


def reconcile_enabled() -> bool:
    if os.getenv("TESTING", "false").lower() == "true":
        return False
    return os.environ.get("LEARNHOUSE_PAYMENTS_RECONCILE", "1").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )

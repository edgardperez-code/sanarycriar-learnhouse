"""Sanar y Criar: payment provider registry.

One instance per provider id for the whole process (the PayPal provider keeps
its OAuth token cache). Tests swap providers with ``register_provider``.
"""

from typing import Optional

from src.services.payments.providers.base import PaymentProvider

_PROVIDERS: dict[str, PaymentProvider] = {}


def _ensure_defaults() -> None:
    if "paypal" not in _PROVIDERS:
        from src.services.payments.providers.paypal import PayPalProvider

        _PROVIDERS["paypal"] = PayPalProvider()


def register_provider(provider: PaymentProvider) -> None:
    _PROVIDERS[provider.id] = provider


def get_provider(provider_id: str) -> Optional[PaymentProvider]:
    _ensure_defaults()
    return _PROVIDERS.get((provider_id or "").lower())


def list_providers() -> list[PaymentProvider]:
    _ensure_defaults()
    return list(_PROVIDERS.values())


def reset_providers() -> None:
    """Drop every registered provider (tests)."""
    _PROVIDERS.clear()

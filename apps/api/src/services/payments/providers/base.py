"""Sanar y Criar: provider-agnostic payment interface.

PayPal implements it today; SPIDI (Pago Movil in VES) will be another
implementation. Services only talk to providers through this interface.
"""

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Literal, Optional, Protocol, runtime_checkable

PaymentStatus = Literal["paid", "pending", "failed", "retry", "approved", "created", "expired"]

EventKind = Literal[
    "order_approved",
    "capture_completed",
    "capture_pending",
    "capture_failed",
    "capture_refunded",
    "capture_reversed",
    "ignored",
]


class ProviderError(Exception):
    """A provider call failed.

    ``retryable`` tells the caller whether the same request may succeed later
    (network error, 5xx), as opposed to a definitive rejection.
    """

    def __init__(self, message: str, *, code: Optional[str] = None, status: Optional[int] = None,
                 retryable: bool = False, body: Any = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.retryable = retryable
        self.body = body


class InvalidCredentialsError(ProviderError):
    pass


class WebhookVerificationError(Exception):
    """The webhook could not be proven to come from the provider."""


@dataclass
class CheckoutResult:
    checkout_url: str
    provider_order_id: str
    raw: dict = field(default_factory=dict)


@dataclass
class PaymentResult:
    """Normalized outcome of a capture or a status lookup.

    ``status`` is ``paid`` only when the provider says the money was captured
    AND the amount, currency and our order reference all match.
    """

    status: PaymentStatus
    provider_capture_id: Optional[str] = None
    charged_amount: Optional[Decimal] = None
    charged_currency: Optional[str] = None
    reason: Optional[str] = None
    raw: dict = field(default_factory=dict)


@dataclass
class ProviderEvent:
    event_id: str
    event_type: str
    kind: EventKind
    provider_order_id: Optional[str] = None
    provider_capture_id: Optional[str] = None
    custom_id: Optional[str] = None
    amount: Optional[Decimal] = None
    currency: Optional[str] = None
    capture_status: Optional[str] = None
    raw: dict = field(default_factory=dict)


@runtime_checkable
class PaymentProvider(Protocol):
    id: str
    label: str
    supports_subscriptions: bool
    supported_currencies: set[str]
    methods: list[str]

    async def validate_config(self, cfg) -> tuple[bool, Optional[str], Optional[str]]:
        """Return (ok, provider_specific_id, error)."""
        ...

    async def create_checkout(self, cfg, order, offer, user, *, return_url: str,
                              cancel_url: str, method: str) -> CheckoutResult:
        ...

    async def confirm(self, cfg, order, params: dict) -> PaymentResult:
        """Capture (or otherwise confirm) an approved order. Idempotent."""
        ...

    async def fetch_status(self, cfg, order) -> PaymentResult:
        """Look the order up at the provider, for reconciliation."""
        ...

    async def handle_webhook(self, cfg, request) -> list[ProviderEvent]:
        """Verify the delivery (from the raw request) and normalize it.
        Raises WebhookVerificationError."""
        ...

    async def get_capture_status(self, cfg, capture_id: str) -> Optional[str]:
        """Current status of a capture (e.g. COMPLETED, REFUNDED, PARTIALLY_REFUNDED)."""
        ...

    def public_settings(self, cfg) -> dict:
        """Settings safe to return to admins (never secrets)."""
        ...

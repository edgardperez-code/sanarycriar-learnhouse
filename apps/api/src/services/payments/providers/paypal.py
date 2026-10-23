"""Sanar y Criar: PayPal Orders v2 provider over raw httpx.

Only six REST calls are needed (token, create, get, capture, get capture,
verify webhook), so no SDK. Money is always compared as ``Decimal``.
"""

import asyncio
import hashlib
import json
import logging
import time
import uuid
from decimal import Decimal, InvalidOperation
from typing import Any, Optional
from urllib.parse import urlparse, urlunparse

import httpx

from src.services.payments.providers.base import (
    CheckoutResult,
    InvalidCredentialsError,
    PaymentResult,
    ProviderError,
    ProviderEvent,
    WebhookVerificationError,
)
from src.services.payments.settings import (
    PAYPAL_API_BASES,
    PAYPAL_DASHBOARD_URLS,
    paypal_api_base,
    paypal_web_base_override,
)

logger = logging.getLogger(__name__)

# Fixed namespace so PayPal-Request-Id is deterministic per logical operation:
# every retry of "capture order X" sends the same key and PayPal answers with
# the result of the first attempt instead of charging twice.
_IDEMPOTENCY_NS = uuid.UUID("5c1d2b8e-7a43-4f0e-9b6a-0d2f3e4a5b6c")

# Refresh the OAuth token this long before PayPal says it expires.
_TOKEN_REFRESH_MARGIN_SECONDS = 300

_REQUIRED_WEBHOOK_HEADERS = (
    "paypal-auth-algo",
    "paypal-cert-url",
    "paypal-transmission-id",
    "paypal-transmission-sig",
    "paypal-transmission-time",
)

# Sanar y Criar: no "payer" (PayPal email, name, payer id): nothing reads it
# and it would sit in every order row and every backup.
_MAX_RAW_KEYS = ("id", "status", "intent", "purchase_units", "links", "create_time", "update_time")
_UNIT_KEYS = ("reference_id", "custom_id", "amount")
_CAPTURE_KEYS = ("id", "status", "status_details", "amount", "seller_receivable_breakdown",
                 "custom_id", "create_time", "update_time")

# Cheap checks before the remote signature verification, so a flood of forged
# notifications never turns into a flood of calls to PayPal.
_WEBHOOK_AUTH_ALGO = "SHA256withRSA"
_WEBHOOK_CERT_HOSTS = {
    "live": ("api.paypal.com", "api-m.paypal.com"),
    "sandbox": ("api.sandbox.paypal.com", "api-m.sandbox.paypal.com"),
}
# Each PayPal (re)delivery is a new transmission with its own time.
_WEBHOOK_MAX_SKEW_SECONDS = 30 * 60


def idempotency_key(kind: str, ref: str) -> str:
    return str(uuid.uuid5(_IDEMPOTENCY_NS, f"{kind}:{ref}"))


def format_amount(value: Decimal) -> str:
    return str(Decimal(value).quantize(Decimal("0.01")))


def _to_decimal(value: Any) -> Optional[Decimal]:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None


def _safe_json(response: httpx.Response) -> Any:
    try:
        return response.json()
    except Exception:
        return {"text": response.text[:500]}


def _issue_of(body: Any) -> Optional[str]:
    if isinstance(body, dict):
        details = body.get("details")
        if isinstance(details, list) and details and isinstance(details[0], dict):
            issue = details[0].get("issue")
            if issue:
                return str(issue)
        name = body.get("name") or body.get("error")
        if name:
            return str(name)
    return None


def _trim_unit(unit: Any) -> Any:
    if not isinstance(unit, dict):
        return unit
    kept = {k: unit[k] for k in _UNIT_KEYS if k in unit}
    captures = ((unit.get("payments") or {}).get("captures")) if isinstance(unit.get("payments"), dict) else None
    if isinstance(captures, list):
        kept["payments"] = {"captures": [
            {k: c[k] for k in _CAPTURE_KEYS if k in c} if isinstance(c, dict) else c for c in captures
        ]}
    return kept


def _trim(data: Any) -> dict:
    """Keep a provider payload small enough to store on the order row, and
    without the buyer's PayPal identity (payer, payee, shipping)."""
    if not isinstance(data, dict):
        return {}
    trimmed = {k: data[k] for k in _MAX_RAW_KEYS if k in data}
    if isinstance(trimmed.get("purchase_units"), list):
        trimmed["purchase_units"] = [_trim_unit(u) for u in trimmed["purchase_units"]]
    return trimmed


def _parse_paypal_time(value: str) -> Optional[float]:
    from datetime import datetime

    text = (value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.timestamp()


def precheck_webhook_headers(headers: dict, environment: str, *, allow_any_cert_host: bool = False,
                             now: Optional[float] = None) -> None:
    """Reject obviously forged notifications without calling PayPal.

    These headers can be forged, so this only filters floods; the signature
    is still verified by PayPal afterwards.
    """
    if headers.get("paypal-auth-algo") != _WEBHOOK_AUTH_ALGO:
        raise WebhookVerificationError("Unexpected PayPal auth algorithm")
    cert = urlparse(headers.get("paypal-cert-url") or "")
    if not allow_any_cert_host:
        allowed = _WEBHOOK_CERT_HOSTS.get(environment, _WEBHOOK_CERT_HOSTS["sandbox"])
        if cert.scheme != "https" or (cert.hostname or "").lower() not in allowed:
            raise WebhookVerificationError("PayPal cert URL is not a PayPal host")
    sent_at = _parse_paypal_time(headers.get("paypal-transmission-time") or "")
    current = time.time() if now is None else now
    if sent_at is None or abs(current - sent_at) > _WEBHOOK_MAX_SKEW_SECONDS:
        raise WebhookVerificationError("PayPal transmission time out of range")


class _Credentials:
    def __init__(self, client_id: str, secret: str, environment: str):
        self.client_id = client_id
        self.secret = secret
        self.environment = environment if environment in ("sandbox", "live") else "sandbox"
        self.base = paypal_api_base(self.environment)

    @property
    def cache_key(self) -> tuple:
        digest = hashlib.sha256(self.secret.encode()).hexdigest()[:16]
        return (self.base, self.client_id, digest)


class PayPalProvider:
    id = "paypal"
    label = "PayPal"
    supports_subscriptions = False
    supported_currencies = {"USD"}
    methods = ["paypal", "card"]

    def __init__(self, transport: Optional[httpx.AsyncBaseTransport] = None):
        # ``transport`` lets tests plug an httpx.MockTransport (no network).
        self.transport = transport
        self._tokens: dict[tuple, tuple[str, float, Optional[str]]] = {}
        self._locks: dict[tuple, asyncio.Lock] = {}

    # ------------------------------------------------------------------ setup

    @staticmethod
    def credentials_from_config(cfg) -> _Credentials:
        from src.services.webhooks.crypto import decrypt_secret

        settings = dict(getattr(cfg, "provider_config", None) or {})
        client_id = (settings.get("client_id") or "").strip()
        secret_enc = settings.get("client_secret_enc") or ""
        if not client_id or not secret_enc:
            raise InvalidCredentialsError("PayPal credentials are not configured", code="NOT_CONFIGURED")
        try:
            secret = decrypt_secret(secret_enc)
        except Exception as exc:
            raise InvalidCredentialsError(
                "Stored PayPal secret cannot be decrypted", code="SECRET_UNREADABLE"
            ) from exc
        return _Credentials(client_id, secret, settings.get("environment") or "sandbox")

    def _client(self, base: str) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=base,
            timeout=httpx.Timeout(20.0, connect=5.0),
            transport=self.transport,
        )

    def invalidate_token(self, creds: _Credentials) -> None:
        self._tokens.pop(creds.cache_key, None)

    # ------------------------------------------------------------------ OAuth

    async def _fetch_token(self, creds: _Credentials) -> tuple[str, float, Optional[str]]:
        try:
            async with self._client(creds.base) as client:
                response = await client.post(
                    "/v1/oauth2/token",
                    data={"grant_type": "client_credentials"},
                    auth=(creds.client_id, creds.secret),
                    headers={"Accept": "application/json"},
                )
        except httpx.HTTPError as exc:
            raise ProviderError(f"PayPal unreachable: {exc}", retryable=True) from exc
        if response.status_code in (400, 401, 403):
            raise InvalidCredentialsError(
                "PayPal rejected the credentials",
                code=_issue_of(_safe_json(response)) or "invalid_client",
                status=response.status_code,
            )
        if response.status_code >= 400:
            raise ProviderError(
                f"PayPal token request failed ({response.status_code})",
                status=response.status_code,
                retryable=response.status_code >= 500,
                body=_safe_json(response),
            )
        payload = response.json()
        token = payload.get("access_token")
        if not token:
            raise ProviderError("PayPal returned no access token")
        expires_in = int(payload.get("expires_in") or 0)
        return token, time.monotonic() + expires_in, payload.get("app_id")

    async def _token(self, creds: _Credentials) -> str:
        key = creds.cache_key
        cached = self._tokens.get(key)
        if cached and time.monotonic() < cached[1] - _TOKEN_REFRESH_MARGIN_SECONDS:
            return cached[0]
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            cached = self._tokens.get(key)
            if cached and time.monotonic() < cached[1] - _TOKEN_REFRESH_MARGIN_SECONDS:
                return cached[0]
            fetched = await self._fetch_token(creds)
            self._tokens[key] = fetched
            return fetched[0]

    async def _call(
        self,
        creds: _Credentials,
        method: str,
        path: str,
        *,
        body: Any = None,
        raw: Optional[bytes] = None,
        request_id: Optional[str] = None,
        prefer: Optional[str] = "return=representation",
        retries: int = 2,
    ) -> dict:
        refreshed = False
        attempt = 0
        while True:
            token = await self._token(creds)
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            }
            if request_id:
                headers["PayPal-Request-Id"] = request_id
            if prefer:
                headers["Prefer"] = prefer
            content = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
            try:
                async with self._client(creds.base) as client:
                    response = await client.request(method, path, headers=headers, content=content)
            except httpx.HTTPError as exc:
                if attempt < retries:
                    attempt += 1
                    await asyncio.sleep(0.3 * attempt)
                    continue
                raise ProviderError(f"PayPal unreachable: {exc}", retryable=True) from exc

            if response.status_code == 401 and not refreshed:
                # Token revoked or expired early: drop it and retry once.
                self.invalidate_token(creds)
                refreshed = True
                continue
            if response.status_code >= 500 and attempt < retries:
                attempt += 1
                await asyncio.sleep(0.3 * attempt)
                continue
            if response.status_code >= 400:
                payload = _safe_json(response)
                raise ProviderError(
                    f"PayPal {method} {path} failed ({response.status_code})",
                    code=_issue_of(payload),
                    status=response.status_code,
                    retryable=response.status_code >= 500 or response.status_code == 429,
                    body=payload,
                )
            if not response.content:
                return {}
            return response.json()

    # ------------------------------------------------------- PaymentProvider

    async def validate_config(self, cfg) -> tuple[bool, Optional[str], Optional[str]]:
        try:
            creds = self.credentials_from_config(cfg)
            self.invalidate_token(creds)
            token, expires_at, app_id = await self._fetch_token(creds)
            self._tokens[creds.cache_key] = (token, expires_at, app_id)
        except InvalidCredentialsError as exc:
            return False, None, "invalid_credentials" if exc.code != "NOT_CONFIGURED" else "not_configured"
        except ProviderError as exc:
            logger.warning("PayPal credential check failed: %s", exc)
            return False, None, "unreachable" if exc.retryable else "rejected"
        return True, app_id or creds.client_id[:12], None

    async def create_checkout(self, cfg, order, offer, user, *, return_url: str,
                              cancel_url: str, method: str) -> CheckoutResult:
        creds = self.credentials_from_config(cfg)
        settings = dict(getattr(cfg, "provider_config", None) or {})
        currency = (order.currency or "USD").upper()
        value = format_amount(order.amount)
        name = (offer.name or "Sanar y Criar")[:127]
        experience_context = {
            "brand_name": (settings.get("brand_name") or "Sanar y Criar")[:127],
            "locale": "es-VE",
            "shipping_preference": "NO_SHIPPING",
            "user_action": "PAY_NOW",
            # Refuse eCheck-style funding so a capture never comes back PENDING
            # for days: delivery is meant to be immediate.
            "payment_method_preference": "IMMEDIATE_PAYMENT_REQUIRED",
            "return_url": return_url,
            "cancel_url": cancel_url,
            # GUEST_CHECKOUT opens the card form directly (no PayPal account).
            "landing_page": "GUEST_CHECKOUT" if method == "card" else "NO_PREFERENCE",
        }
        money = {"currency_code": currency, "value": value}
        body = {
            "intent": "CAPTURE",
            "purchase_units": [
                {
                    "reference_id": order.order_uuid,
                    "custom_id": order.order_uuid,
                    "invoice_id": f"SYC-{order.order_uuid}",
                    "description": name,
                    "soft_descriptor": "SANARYCRIAR",
                    "amount": {**money, "breakdown": {"item_total": dict(money)}},
                    "items": [
                        {
                            "name": name,
                            "sku": (offer.offer_uuid or "")[:127],
                            "quantity": "1",
                            "unit_amount": dict(money),
                            "category": "DIGITAL_GOODS",
                        }
                    ],
                }
            ],
            "payment_source": {"paypal": {"experience_context": experience_context}},
        }
        data = await self._call(
            creds,
            "POST",
            "/v2/checkout/orders",
            body=body,
            request_id=idempotency_key("create", order.order_uuid),
        )
        provider_order_id = data.get("id")
        link = next(
            (l.get("href") for l in data.get("links") or [] if l.get("rel") == "payer-action"),
            None,
        ) or next(
            (l.get("href") for l in data.get("links") or [] if l.get("rel") == "approve"),
            None,
        )
        if not provider_order_id or not link:
            raise ProviderError("PayPal order has no approval link", body=_trim(data))
        return CheckoutResult(
            checkout_url=self._rewrite_web_link(link),
            provider_order_id=provider_order_id,
            raw=_trim(data),
        )

    @staticmethod
    def _rewrite_web_link(link: str) -> str:
        override = paypal_web_base_override()
        if not override:
            return link
        target = urlparse(override)
        parsed = urlparse(link)
        return urlunparse(parsed._replace(scheme=target.scheme, netloc=target.netloc))

    async def confirm(self, cfg, order, params: dict) -> PaymentResult:
        if not order.provider_order_id:
            return PaymentResult(status="failed", reason="NO_PROVIDER_ORDER")
        creds = self.credentials_from_config(cfg)
        path = f"/v2/checkout/orders/{order.provider_order_id}/capture"
        try:
            data = await self._call(
                creds,
                "POST",
                path,
                raw=b"{}",
                request_id=idempotency_key("capture", order.provider_order_id),
            )
        except ProviderError as exc:
            if exc.code == "ORDER_ALREADY_CAPTURED":
                data = await self._call(
                    creds, "GET", f"/v2/checkout/orders/{order.provider_order_id}", prefer=None
                )
            elif exc.code == "INSTRUMENT_DECLINED":
                return PaymentResult(status="retry", reason="INSTRUMENT_DECLINED", raw=_trim(exc.body))
            elif exc.code in ("ORDER_NOT_APPROVED", "PAYER_ACTION_REQUIRED"):
                return PaymentResult(status="created", reason=exc.code, raw=_trim(exc.body))
            elif exc.retryable:
                raise
            else:
                return PaymentResult(
                    status="failed", reason=(exc.code or "CAPTURE_FAILED")[:255], raw=_trim(exc.body)
                )
        return self.evaluate_order(order, data)

    async def fetch_status(self, cfg, order) -> PaymentResult:
        if not order.provider_order_id:
            return PaymentResult(status="created", reason="NO_PROVIDER_ORDER")
        creds = self.credentials_from_config(cfg)
        try:
            data = await self._call(
                creds, "GET", f"/v2/checkout/orders/{order.provider_order_id}", prefer=None
            )
        except ProviderError as exc:
            if exc.status == 404:
                return PaymentResult(status="expired", reason=exc.code or "RESOURCE_NOT_FOUND")
            raise
        return self.evaluate_order(order, data)

    @staticmethod
    def evaluate_order(order, data: dict) -> PaymentResult:
        """Decide paid / pending / failed from a PayPal order representation.

        Access is only ever granted for a COMPLETED capture whose amount,
        currency and custom_id match our own order row.
        """
        raw = _trim(data)
        if data.get("id") and data.get("id") != order.provider_order_id:
            logger.error(
                "PayPal order id mismatch for order %s: %s != %s",
                order.order_uuid, data.get("id"), order.provider_order_id,
            )
            return PaymentResult(status="failed", reason="ORDER_ID_MISMATCH", raw=raw)

        order_status = (data.get("status") or "").upper()
        units = data.get("purchase_units") or [{}]
        unit = units[0] if units and isinstance(units[0], dict) else {}
        captures = ((unit.get("payments") or {}).get("captures")) or []

        if not captures:
            if order_status == "APPROVED":
                return PaymentResult(status="approved", raw=raw)
            if order_status in ("CREATED", "SAVED", "PAYER_ACTION_REQUIRED"):
                return PaymentResult(status="created", raw=raw)
            if order_status == "VOIDED":
                return PaymentResult(status="failed", reason="VOIDED", raw=raw)
            return PaymentResult(status="failed", reason=f"NO_CAPTURE_{order_status or 'UNKNOWN'}"[:255], raw=raw)

        capture = captures[-1]
        amount = capture.get("amount") or {}
        charged = _to_decimal(amount.get("value"))
        currency = (amount.get("currency_code") or "").upper()
        custom_id = capture.get("custom_id") or unit.get("custom_id")
        capture_status = (capture.get("status") or "").upper()
        result_kwargs = dict(
            provider_capture_id=capture.get("id"),
            charged_amount=charged,
            charged_currency=currency or None,
            raw=raw,
        )

        expected = Decimal(str(order.amount))
        if (
            charged is None
            or charged != expected
            or currency != (order.currency or "").upper()
            or custom_id != order.order_uuid
        ):
            logger.error(
                "PayPal capture mismatch for order %s: amount=%s %s custom_id=%s (expected %s %s)",
                order.order_uuid, charged, currency, custom_id, expected, order.currency,
            )
            return PaymentResult(status="failed", reason="MISMATCH", **result_kwargs)

        if capture_status in ("COMPLETED", "PARTIALLY_REFUNDED") and order_status == "COMPLETED":
            return PaymentResult(status="paid", **result_kwargs)
        if capture_status == "PENDING":
            reason = (capture.get("status_details") or {}).get("reason") or "PENDING"
            return PaymentResult(status="pending", reason=str(reason)[:255], **result_kwargs)
        if capture_status == "REFUNDED":
            return PaymentResult(status="failed", reason="REFUNDED", **result_kwargs)
        return PaymentResult(
            status="failed", reason=(capture_status or "CAPTURE_NOT_COMPLETED")[:255], **result_kwargs
        )

    async def get_capture_status(self, cfg, capture_id: str) -> Optional[str]:
        creds = self.credentials_from_config(cfg)
        data = await self._call(creds, "GET", f"/v2/payments/captures/{capture_id}", prefer=None)
        status = data.get("status")
        return str(status).upper() if status else None

    async def handle_webhook(self, cfg, request) -> list[ProviderEvent]:
        settings = dict(getattr(cfg, "provider_config", None) or {})
        webhook_id = (settings.get("webhook_id") or "").strip()
        if not webhook_id:
            raise WebhookVerificationError("PayPal webhook_id is not configured")
        headers = {k.lower(): v for k, v in request.headers.items()}
        if any(not headers.get(h) for h in _REQUIRED_WEBHOOK_HEADERS):
            raise WebhookVerificationError("Missing PayPal transmission headers")
        environment = settings.get("environment") if settings.get("environment") in ("sandbox", "live") else "sandbox"
        # The local PayPal mock (development only) signs with its own cert URL.
        mocked = paypal_api_base(environment) != PAYPAL_API_BASES.get(environment)
        precheck_webhook_headers(headers, environment, allow_any_cert_host=mocked)
        raw_body: bytes = await request.body()
        try:
            event = json.loads(raw_body)
        except ValueError as exc:
            raise WebhookVerificationError("Webhook body is not JSON") from exc
        if not isinstance(event, dict) or not event.get("id"):
            raise WebhookVerificationError("Webhook body is not a PayPal event")

        meta = {
            "auth_algo": headers["paypal-auth-algo"],
            "cert_url": headers["paypal-cert-url"],
            "transmission_id": headers["paypal-transmission-id"],
            "transmission_sig": headers["paypal-transmission-sig"],
            "transmission_time": headers["paypal-transmission-time"],
            "webhook_id": webhook_id,
        }
        # PayPal requires the event "exactly as it was received": splice the
        # raw bytes in instead of re-serializing the parsed JSON.
        payload = json.dumps(meta)[:-1].encode() + b',"webhook_event":' + raw_body.strip() + b"}"
        creds = self.credentials_from_config(cfg)
        result = await self._call(
            creds, "POST", "/v1/notifications/verify-webhook-signature", raw=payload, prefer=None
        )
        if (result.get("verification_status") or "").upper() != "SUCCESS":
            raise WebhookVerificationError("PayPal signature verification failed")
        return [self.normalize_event(event)]

    @staticmethod
    def normalize_event(event: dict) -> ProviderEvent:
        event_type = str(event.get("event_type") or "")
        resource = event.get("resource") or {}
        base = dict(event_id=str(event.get("id")), event_type=event_type, raw={
            "id": event.get("id"),
            "event_type": event_type,
            "resource_type": event.get("resource_type"),
            "create_time": event.get("create_time"),
        })

        def _amount() -> tuple[Optional[Decimal], Optional[str]]:
            amount = resource.get("amount") or {}
            return _to_decimal(amount.get("value")), (amount.get("currency_code") or "").upper() or None

        def _up_capture_id() -> Optional[str]:
            for link in resource.get("links") or []:
                if link.get("rel") == "up" and link.get("href"):
                    return link["href"].rstrip("/").rsplit("/", 1)[-1]
            return None

        related_order_id = (
            ((resource.get("supplementary_data") or {}).get("related_ids") or {}).get("order_id")
        )

        if event_type == "CHECKOUT.ORDER.APPROVED":
            units = resource.get("purchase_units") or [{}]
            unit = units[0] if units and isinstance(units[0], dict) else {}
            return ProviderEvent(
                **base,
                kind="order_approved",
                provider_order_id=resource.get("id"),
                custom_id=unit.get("custom_id"),
            )
        if event_type in (
            "PAYMENT.CAPTURE.COMPLETED",
            "PAYMENT.CAPTURE.PENDING",
            "PAYMENT.CAPTURE.DECLINED",
            "PAYMENT.CAPTURE.DENIED",
        ):
            kind = {
                "PAYMENT.CAPTURE.COMPLETED": "capture_completed",
                "PAYMENT.CAPTURE.PENDING": "capture_pending",
            }.get(event_type, "capture_failed")
            amount, currency = _amount()
            return ProviderEvent(
                **base,
                kind=kind,
                provider_order_id=related_order_id,
                provider_capture_id=resource.get("id"),
                custom_id=resource.get("custom_id"),
                amount=amount,
                currency=currency,
                capture_status=(resource.get("status") or "").upper() or None,
            )
        if event_type in ("PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED"):
            amount, currency = _amount()
            capture_id = _up_capture_id()
            if capture_id is None and event_type == "PAYMENT.CAPTURE.REVERSED":
                capture_id = resource.get("id")
            return ProviderEvent(
                **base,
                kind="capture_refunded" if event_type.endswith("REFUNDED") else "capture_reversed",
                provider_order_id=related_order_id,
                provider_capture_id=capture_id,
                custom_id=resource.get("custom_id"),
                amount=amount,
                currency=currency,
                capture_status=(resource.get("status") or "").upper() or None,
            )
        return ProviderEvent(**base, kind="ignored")

    def public_settings(self, cfg) -> dict:
        settings = dict(getattr(cfg, "provider_config", None) or {})
        environment = settings.get("environment") or "sandbox"
        return {
            "environment": environment,
            "client_id": settings.get("client_id") or "",
            "has_secret": bool(settings.get("client_secret_enc")),
            "webhook_id": settings.get("webhook_id") or "",
            "dashboard_url": PAYPAL_DASHBOARD_URLS.get(environment, PAYPAL_DASHBOARD_URLS["sandbox"]),
        }

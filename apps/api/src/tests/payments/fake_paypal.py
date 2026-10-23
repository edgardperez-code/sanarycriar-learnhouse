"""In-memory PayPal REST double for tests, served through httpx.MockTransport
(no network). Mirrors the calls our PayPal provider makes."""

import base64
import json
from decimal import Decimal
from typing import Callable, Optional

import httpx


class FakePayPal:
    def __init__(self):
        self.tokens: set[str] = set()
        self.orders: dict[str, dict] = {}
        self.create_keys: dict[str, str] = {}
        self.capture_keys: dict[str, dict] = {}
        self.captures: dict[str, dict] = {}
        self.calls: list[tuple[str, str]] = []
        self.token_requests = 0
        self.reject_credentials = False
        self.verify_status = "SUCCESS"
        self.verify_payloads: list[bytes] = []
        # Hook to tamper with the capture before it is returned.
        self.capture_hook: Optional[Callable[[dict, dict], None]] = None
        self.capture_error: Optional[str] = None
        self.expire_next_token = False
        self._seq = 0

    # ----------------------------------------------------------- helpers

    def _next(self, prefix: str) -> str:
        self._seq += 1
        return f"{prefix}{self._seq:010d}"

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    def approve(self, order_id: str) -> None:
        self.orders[order_id]["status"] = "APPROVED"

    def order_for_custom_id(self, custom_id: str) -> dict:
        for order in self.orders.values():
            if order["purchase_units"][0].get("custom_id") == custom_id:
                return order
        raise KeyError(custom_id)

    def _json(self, status: int, body) -> httpx.Response:
        return httpx.Response(status, json=body)

    def _error(self, status: int, issue: str) -> httpx.Response:
        return self._json(status, {"name": "UNPROCESSABLE_ENTITY", "details": [{"issue": issue}]})

    def _authorized(self, request: httpx.Request) -> bool:
        header = request.headers.get("authorization", "")
        return header.startswith("Bearer ") and header[7:] in self.tokens

    def _view(self, order: dict) -> dict:
        view = {
            "id": order["id"],
            "status": order["status"],
            "intent": "CAPTURE",
            "purchase_units": order["purchase_units"],
            "links": [],
        }
        if order["status"] == "PAYER_ACTION_REQUIRED":
            view["links"].append({
                "href": f"https://www.sandbox.paypal.com/checkoutnow?token={order['id']}",
                "rel": "payer-action",
                "method": "GET",
            })
        return view

    # ----------------------------------------------------------- handler

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.calls.append((request.method, path))

        if path == "/v1/oauth2/token":
            self.token_requests += 1
            auth = request.headers.get("authorization", "")
            client_id, _, secret = base64.b64decode(auth[6:]).decode().partition(":")
            if self.reject_credentials or not secret:
                return self._json(401, {"error": "invalid_client"})
            token = f"tok-{self.token_requests}"
            self.tokens.add(token)
            return self._json(200, {
                "access_token": token, "token_type": "Bearer", "expires_in": 32400,
                "app_id": f"APP-{client_id.upper()}",
            })

        if not self._authorized(request):
            return self._json(401, {"error": "invalid_token"})
        if self.expire_next_token:
            self.expire_next_token = False
            self.tokens.discard(request.headers["authorization"][7:])
            return self._json(401, {"error": "invalid_token"})

        if path == "/v2/checkout/orders" and request.method == "POST":
            key = request.headers.get("paypal-request-id")
            if key and key in self.create_keys:
                return self._json(200, self._view(self.orders[self.create_keys[key]]))
            body = json.loads(request.content)
            order_id = self._next("ORDER")
            self.orders[order_id] = {
                "id": order_id,
                "status": "PAYER_ACTION_REQUIRED",
                "purchase_units": [dict(body["purchase_units"][0])],
                "body": body,
            }
            if key:
                self.create_keys[key] = order_id
            return self._json(201, self._view(self.orders[order_id]))

        if path.startswith("/v2/checkout/orders/") and path.endswith("/capture"):
            order_id = path.split("/")[4]
            order = self.orders.get(order_id)
            if order is None:
                return self._json(404, {"name": "RESOURCE_NOT_FOUND"})
            key = request.headers.get("paypal-request-id")
            if key and key in self.capture_keys:
                return self._json(200, self.capture_keys[key])
            if self.capture_error:
                return self._error(422, self.capture_error)
            if order["status"] == "COMPLETED":
                return self._error(422, "ORDER_ALREADY_CAPTURED")
            if order["status"] != "APPROVED":
                return self._error(422, "ORDER_NOT_APPROVED")
            unit = order["purchase_units"][0]
            capture = {
                "id": self._next("CAP"),
                "status": "COMPLETED",
                "amount": {"currency_code": unit["amount"]["currency_code"], "value": unit["amount"]["value"]},
                "custom_id": unit.get("custom_id"),
            }
            if self.capture_hook:
                self.capture_hook(order, capture)
            order["status"] = "COMPLETED"
            unit["payments"] = {"captures": [capture]}
            self.captures[capture["id"]] = capture
            view = self._view(order)
            if key:
                self.capture_keys[key] = view
            return self._json(201, view)

        if path.startswith("/v2/checkout/orders/") and request.method == "GET":
            order = self.orders.get(path.split("/")[4])
            if order is None:
                return self._json(404, {"name": "RESOURCE_NOT_FOUND"})
            return self._json(200, self._view(order))

        if path.startswith("/v2/payments/captures/") and request.method == "GET":
            capture = self.captures.get(path.split("/")[4])
            if capture is None:
                return self._json(404, {"name": "RESOURCE_NOT_FOUND"})
            return self._json(200, capture)

        if path == "/v1/notifications/verify-webhook-signature":
            self.verify_payloads.append(request.content)
            json.loads(request.content)  # must be valid JSON after splicing
            return self._json(200, {"verification_status": self.verify_status})

        return self._json(404, {"name": "NOT_MOCKED", "path": path})


def capture_completed_event(event_id: str, capture: dict, order_id: str) -> dict:
    return {
        "id": event_id,
        "event_type": "PAYMENT.CAPTURE.COMPLETED",
        "resource_type": "capture",
        "resource": {
            **capture,
            "supplementary_data": {"related_ids": {"order_id": order_id}},
        },
    }


def order_approved_event(event_id: str, order: dict) -> dict:
    return {
        "id": event_id,
        "event_type": "CHECKOUT.ORDER.APPROVED",
        "resource_type": "checkout-order",
        "resource": {"id": order["id"], "status": "APPROVED", "purchase_units": order["purchase_units"]},
    }


def refund_event(event_id: str, capture_id: str, value: str, custom_id: Optional[str] = None) -> dict:
    return {
        "id": event_id,
        "event_type": "PAYMENT.CAPTURE.REFUNDED",
        "resource_type": "refund",
        "resource": {
            "id": f"REF-{event_id}",
            "status": "COMPLETED",
            "amount": {"currency_code": "USD", "value": value},
            "custom_id": custom_id,
            "links": [{"rel": "up", "href": f"https://api-m.sandbox.paypal.com/v2/payments/captures/{capture_id}"}],
        },
    }


def webhook_headers(**overrides) -> dict:
    """PayPal transmission headers for a live config, sent "now" (the API
    rejects transmissions far from the current time before verifying)."""
    from datetime import datetime, timezone

    headers = {
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-cert-url": "https://api.paypal.com/v1/notifications/certs/CERT-1",
        "paypal-transmission-id": "tx-1",
        "paypal-transmission-sig": "sig",
        "paypal-transmission-time": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "content-type": "application/json",
    }
    headers.update(overrides)
    return headers


def money(value: str) -> Decimal:
    return Decimal(value)

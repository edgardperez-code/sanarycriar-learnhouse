"""Sanar y Criar: credential-less CORS for extra read-only origins.

``LEARNHOUSE_EXTRA_CORS_ORIGINS`` (comma separated exact origins, e.g.
``https://www.sanarycriarve.com,https://sanarycriarve.com``) lets a separate
static site read the public catalog from the browser. Those origins get
``GET``/``HEAD`` only and never ``Access-Control-Allow-Credentials``, so a
browser will not attach cookies for them nor expose a credentialed response.
Origins already admitted by the main (credentialed) CORS policy are left to
it untouched.
"""

import os
import re
from typing import Iterable, Optional
from urllib.parse import urlparse

from starlette.datastructures import Headers, MutableHeaders
from starlette.responses import PlainTextResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

ENV_VAR = "LEARNHOUSE_EXTRA_CORS_ORIGINS"

_ALLOWED_METHODS = ("GET", "HEAD", "OPTIONS")
# CORS-safelisted request headers (plus the ones fetch adds by itself).
_ALLOWED_HEADERS = frozenset({"accept", "accept-language", "content-language", "content-type"})
_MAX_AGE = "600"


def parse_extra_origins(raw: Optional[str] = None) -> list[str]:
    """Normalize the env value to ``scheme://host[:port]`` entries."""
    raw = os.environ.get(ENV_VAR, "") if raw is None else raw
    origins: list[str] = []
    for item in (raw or "").split(","):
        item = item.strip().rstrip("/")
        if not item:
            continue
        parsed = urlparse(item)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            continue
        if parsed.path or parsed.query or parsed.fragment or parsed.username:
            continue
        origin = f"{parsed.scheme}://{parsed.netloc}".lower()
        if origin not in origins:
            origins.append(origin)
    return origins


class ExtraOriginsCORSMiddleware:
    """Must wrap the main ``CORSMiddleware`` (be added after it)."""

    def __init__(self, app: ASGIApp, origins: Iterable[str], main_origin_regex: Optional[str] = None):
        self.app = app
        self.origins = frozenset(o.lower() for o in origins)
        self.main_regex = re.compile(main_origin_regex) if main_origin_regex else None

    def _handles(self, origin: Optional[str]) -> bool:
        if not origin:
            return False
        origin = origin.lower()
        if origin not in self.origins:
            return False
        # Already allowed (with credentials) by the main policy: not ours.
        return not (self.main_regex and self.main_regex.fullmatch(origin))

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        origin = headers.get("origin")
        if not self._handles(origin):
            await self.app(scope, receive, send)
            return

        method = scope["method"].upper()
        if method == "OPTIONS" and "access-control-request-method" in headers:
            await self._preflight(origin, headers)(scope, receive, send)
            return

        if method not in ("GET", "HEAD"):
            # No CORS headers: the browser will not expose the response.
            await self.app(scope, receive, send)
            return

        async def send_with_cors(message: Message) -> None:
            if message["type"] == "http.response.start":
                response_headers = MutableHeaders(scope=message)
                response_headers["Access-Control-Allow-Origin"] = origin
                if "access-control-allow-credentials" in response_headers:
                    del response_headers["access-control-allow-credentials"]
                response_headers.add_vary_header("Origin")
            await send(message)

        await self.app(scope, receive, send_with_cors)

    @staticmethod
    def _preflight(origin: str, headers: Headers) -> PlainTextResponse:
        requested_method = headers.get("access-control-request-method", "").upper()
        requested_headers = [
            h.strip().lower()
            for h in headers.get("access-control-request-headers", "").split(",")
            if h.strip()
        ]
        response_headers = {"Vary": "Origin"}
        if requested_method not in _ALLOWED_METHODS or any(
            h not in _ALLOWED_HEADERS for h in requested_headers
        ):
            return PlainTextResponse("Disallowed CORS request", status_code=400, headers=response_headers)
        response_headers.update({
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": ", ".join(_ALLOWED_METHODS),
            "Access-Control-Max-Age": _MAX_AGE,
        })
        if requested_headers:
            response_headers["Access-Control-Allow-Headers"] = ", ".join(requested_headers)
        return PlainTextResponse("OK", status_code=200, headers=response_headers)

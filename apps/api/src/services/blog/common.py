"""Sanar y Criar: shared constants and helpers of the blog services.

The vocabularies and limits below are a contract with the dashboard
(``apps/web/components/Dashboard/Pages/Blog/blogForm.ts``) and the marketing
site (``web/src/lib/blog.ts``): change them on every side at once.
"""

import os
import re
import unicodedata
from typing import Any, Optional

from fastapi import HTTPException, Request

from src.services.payments.common import media_base_url

KINDS = {"informativo": "Informativo", "novedad": "Novedad", "taller": "Taller"}
CATEGORIES = {
    "emociones": "Emociones",
    "limites-y-conducta": "Límites y conducta",
    "sueno-y-rutinas": "Sueño y rutinas",
    "crianza-y-familia": "Crianza y familia",
    "talleres-y-novedades": "Talleres y novedades",
}
NEWS_CATEGORY = "talleres-y-novedades"
DEFAULT_KIND = "informativo"
DEFAULT_CATEGORY = "crianza-y-familia"
STATUSES = ("draft", "published")
AUDIENCES = {"familias": "madres, padres y cuidadores", "docentes": "docentes y equipos escolares", "ambos": "familias y docentes"}
LENGTHS = {"corto": (700, 900), "medio": (1000, 1300), "largo": (1500, 1900)}
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
LIMITS = {
    "title": 120, "slug_min": 3, "slug": 80, "excerpt": 300, "summary": 800,
    "key_takeaways_items": 8, "key_takeaway": 200, "content_md": 60000, "content_publish_min": 200,
    "faq_items": 8, "faq_question": 200, "faq_answer": 1200, "meta_title": 120, "meta_description": 300,
    "keywords_items": 12, "keyword": 60, "cover_alt": 200, "search": 100,
    "prompt_min": 10, "prompt": 4000, "ai_keyword": 80, "facts": 2000, "instruction_min": 5, "instruction": 2000,
}
SEO_TARGETS = {
    "title": 65, "meta_title": 60, "meta_description": [140, 155], "excerpt": 200,
    "summary_words": [40, 70], "key_takeaways": [3, 5], "faq": [3, 5], "faq_answer_words": [40, 80], "keywords": [4, 8],
}
AI_HOURLY_LIMIT = 15

POST_NOT_FOUND = "Artículo no encontrado."

_NON_SLUG_RE = re.compile(r"[^a-z0-9]+")
# Markdown source: every control character except line feed and tab.
_MD_CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def slugify(value: Any) -> str:
    """URL slug of a text; the dashboard runs the very same steps (contract §0.3).

    NFKD without combining marks (á→a, ñ→n), lowercase, every run outside
    ``[a-z0-9]`` becomes ``-``, no leading/trailing ``-``, at most 80 chars.
    """
    text = value if isinstance(value, str) else ""
    text = "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))
    text = _NON_SLUG_RE.sub("-", text.lower()).strip("-")
    if len(text) > LIMITS["slug"]:
        text = text[: LIMITS["slug"]].rstrip("-")
    return text


def is_valid_slug(slug: str) -> bool:
    return LIMITS["slug_min"] <= len(slug) <= LIMITS["slug"] and SLUG_RE.fullmatch(slug) is not None


def clean_markdown(value: Any) -> str:
    """Markdown source: ``\\n`` line breaks, no control characters but tab, no trailing blanks."""
    text = value if isinstance(value, str) else ""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return _MD_CONTROL_RE.sub("", text).rstrip()


def truncate_text(text: str, limit: int) -> str:
    """``text`` cut to ``limit`` characters at the last space before it (never mid-word if avoidable)."""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    space = cut.rfind(" ")
    if space > 0:
        cut = cut[:space]
    return cut.rstrip()


def reading_minutes(word_count: int) -> int:
    return max(1, round((word_count or 0) / 200))


def _post_file_url(org_uuid: str, post, filename: Optional[str], request: Optional[Request]) -> Optional[str]:
    if not filename:
        return None
    path = f"/content/orgs/{org_uuid}/blog/{post.post_uuid}/{filename}"
    base = media_base_url(request)
    return f"{base}{path}" if base else path


def cover_url(org_uuid: str, post, request: Optional[Request]) -> Optional[str]:
    """Public URL of the WebP cover (absolute when the media host is known), or ``None``."""
    return _post_file_url(org_uuid, post, post.cover_image, request)


def og_image_url(org_uuid: str, post, request: Optional[Request]) -> Optional[str]:
    """Public URL of the 1200×630 JPEG for social cards, or ``None``."""
    return _post_file_url(org_uuid, post, post.og_image, request)


def check_rate(key: str, limit: int, window: int, detail: str) -> None:
    """Soft rate limit; never fails closed when Redis is unavailable.

    Same behaviour as the newsletter's ``check_rate`` with the message as a
    parameter. ``TESTING`` is read on every call and ``check_rate_limit`` is
    imported here so tests can patch both.
    """
    if os.getenv("TESTING", "false").lower() == "true":
        return
    try:
        from src.services.security.rate_limiting import check_rate_limit

        allowed, _, retry_after = check_rate_limit(key, limit, window)
    except Exception:
        return
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=detail,
            headers={"Retry-After": str(retry_after)},
        )

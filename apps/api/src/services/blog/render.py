"""Sanar y Criar: Markdown → sanitized HTML for the blog (the only source of ``content_html``).

Two layers, on purpose:
1. markdown-it-py with raw HTML off (``<script>`` and friends come out as
   escaped text), images off and its own link validation (no
   ``javascript:``/``data:`` links). Headings are normalized to h2–h4 and get
   stable ``id`` anchors; external links open in a new tab with
   ``rel="noopener noreferrer"``; tables are wrapped for horizontal scroll.
2. nh3 (ammonia) with an allow-list of tags, attributes and exact attribute
   values, so nothing the renderer could ever emit by mistake reaches the
   site, which prints this HTML as is (``set:html``).
"""

import html as html_lib
import re
from dataclasses import dataclass

import nh3
from markdown_it import MarkdownIt

from src.services.blog.common import LIMITS, slugify

ALLOWED_TAGS = {
    "h2", "h3", "h4", "p", "a", "ul", "ol", "li", "strong", "em", "blockquote", "code", "pre",
    "hr", "br", "table", "thead", "tbody", "tr", "th", "td", "div", "s", "del",
}
ALLOWED_ATTRIBUTES = {"a": {"href", "title"}, "h2": {"id"}, "h3": {"id"}, "h4": {"id"}}
_ALIGN_STYLES = {"text-align:left", "text-align:center", "text-align:right"}
TAG_ATTRIBUTE_VALUES = {
    "a": {"target": {"_blank"}, "rel": {"noopener noreferrer"}},
    "th": {"style": _ALIGN_STYLES},
    "td": {"style": _ALIGN_STYLES},
}
ALLOWED_CLASSES = {"div": {"table-wrap"}}
URL_SCHEMES = {"http", "https", "mailto"}

_HEADING_MAP = {"h1": "h2", "h2": "h2", "h3": "h3", "h4": "h4", "h5": "h4", "h6": "h4"}
_ANCHORED = ("h2", "h3", "h4")
_WORD_RE = re.compile(r"\w+")


@dataclass(frozen=True)
class Rendered:
    html: str
    word_count: int


def _render_link_open(self, tokens, idx, options, env):
    token = tokens[idx]
    href = token.attrGet("href") or ""
    if href.startswith("//"):
        href = "https:" + href
        token.attrSet("href", href)
    if href.lower().startswith(("http://", "https://")):
        token.attrSet("target", "_blank")
        token.attrSet("rel", "noopener noreferrer")
    return self.renderToken(tokens, idx, options, env)


def _render_table_open(self, tokens, idx, options, env):
    return '<div class="table-wrap"><table>\n'


def _render_table_close(self, tokens, idx, options, env):
    return "</table></div>\n"


def build_parser() -> MarkdownIt:
    """The site's Markdown parser (also used to check the links of AI articles)."""
    md = (
        MarkdownIt("commonmark", {"html": False, "linkify": False, "typographer": False})
        .enable(["table", "strikethrough"])
        .disable(["image"])
    )
    md.add_render_rule("link_open", _render_link_open)
    md.add_render_rule("table_open", _render_table_open)
    md.add_render_rule("table_close", _render_table_close)
    return md


_MD = build_parser()


def _inline_text(token) -> str:
    """Plain text of an inline token (what a reader sees in the heading)."""
    if not token.children:
        return token.content or ""
    return "".join(child.content for child in token.children if child.type in ("text", "code_inline"))


def _anchor(text: str, used: set[str]) -> str:
    base = slugify(text) or "seccion"
    anchor = base
    n = 2
    while anchor in used:
        suffix = f"-{n}"
        anchor = base[: LIMITS["slug"] - len(suffix)].rstrip("-") + suffix
        n += 1
    used.add(anchor)
    return anchor


def _normalize_headings(tokens) -> None:
    """h1 → h2 and h5/h6 → h4 (open and close tags), plus unique ``id`` anchors on h2–h4."""
    used: set[str] = set()
    for i, token in enumerate(tokens):
        if token.type not in ("heading_open", "heading_close"):
            continue
        token.tag = _HEADING_MAP.get(token.tag, token.tag)
        if token.type == "heading_open" and token.tag in _ANCHORED:
            inline = tokens[i + 1] if i + 1 < len(tokens) else None
            text = _inline_text(inline) if inline is not None and inline.type == "inline" else ""
            token.attrSet("id", _anchor(text, used))


def sanitize_html(html: str) -> str:
    return nh3.clean(
        html,
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRIBUTES,
        tag_attribute_values=TAG_ATTRIBUTE_VALUES,
        allowed_classes=ALLOWED_CLASSES,
        url_schemes=URL_SCHEMES,
        link_rel=None,
        strip_comments=True,
        clean_content_tags={"script", "style"},
    )


def count_words(html: str) -> int:
    """Words a reader sees in sanitized HTML (tags dropped, entities decoded)."""
    text = html_lib.unescape(nh3.clean(html, tags=set()))
    return len(_WORD_RE.findall(text))


def render_markdown(content_md: str) -> Rendered:
    """Sanitized HTML of an article's Markdown and its word count."""
    env: dict = {}
    tokens = _MD.parse(content_md or "", env)
    _normalize_headings(tokens)
    html = sanitize_html(_MD.renderer.render(tokens, _MD.options, env))
    return Rendered(html=html, word_count=count_words(html))

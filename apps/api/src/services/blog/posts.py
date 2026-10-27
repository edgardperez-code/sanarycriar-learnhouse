"""Sanar y Criar: blog articles (admin CRUD, publishing, public listing, serializers).

Validation messages are Spanish and checked in the contract's order (first
problem → 400). ``content_html`` is always rendered here from
``content_md``: HTML sent by a client is ignored.
"""

from typing import Optional

from fastapi import HTTPException, Request
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from src.db.blog.blog import BlogPost
from src.db.organizations import Organization
from src.services.blog import render
from src.services.blog.common import (
    CATEGORIES,
    DEFAULT_CATEGORY,
    DEFAULT_KIND,
    KINDS,
    LIMITS,
    POST_NOT_FOUND,
    STATUSES,
    check_rate,
    clean_markdown,
    cover_url,
    is_valid_slug,
    og_image_url,
    reading_minutes,
    slugify,
)
from src.services.newsletter.common import clean_line, clean_multiline
from src.services.payments.common import get_org_or_404, iso, utcnow

FALLBACK_SLUG = "articulo"
SITEMAP_MAX_ITEMS = 5000

SLUG_INVALID = "La dirección (slug) debe tener entre 3 y 80 caracteres: letras sin acentos, números y guiones."
SLUG_LOCKED = "La dirección de un artículo que ya se publicó no se puede cambiar."
SLUG_TAKEN = "Ya existe otro artículo con esa dirección. Cambia el slug."
PUBLISH_NEEDS_EXCERPT = "Escribe un extracto antes de publicar."
PUBLISH_NEEDS_CONTENT = "El contenido es demasiado corto para publicar (mínimo 200 caracteres)."
CONTENT_TOO_LONG = "El contenido admite como máximo 60000 caracteres."


class FaqItemBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    question: str = ""
    answer: str = ""


class PostBody(BaseModel):
    """POST/PUT body. ``content_html``, ``status``, ``published_at``, ``source`` ... are ignored."""

    model_config = ConfigDict(extra="ignore")
    title: str = ""
    slug: str = ""
    kind: str = DEFAULT_KIND
    category: str = DEFAULT_CATEGORY
    excerpt: str = ""
    summary: str = ""
    key_takeaways: list[str] = []
    content_md: str = ""
    faq: list[FaqItemBody] = []
    meta_title: str = ""
    meta_description: str = ""
    keywords: list[str] = []
    cover_alt: str = ""


class PreviewBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    content_md: str = ""


# --------------------------------------------------------------- validation


def _bad(detail: str) -> HTTPException:
    return HTTPException(status_code=400, detail=detail)


def _check_max(text: str, limit_key: str, detail: str) -> str:
    if len(text) > LIMITS[limit_key]:
        raise _bad(detail)
    return text


def _clean_items(values: list[str]) -> list[str]:
    return [item for item in (clean_line(value) for value in values or []) if item]


def _validated(body: PostBody, *, require_slug: bool) -> tuple[dict, str]:
    """Cleaned field values and the slug ("" = derive it from the title), or a 400."""
    title = clean_line(body.title)
    if not title:
        raise _bad("El título es obligatorio.")
    _check_max(title, "title", "El título admite como máximo 120 caracteres.")

    slug_input = clean_line(body.slug)
    slug = slugify(slug_input) if slug_input else ""
    if (slug_input or require_slug) and not is_valid_slug(slug):
        raise _bad(SLUG_INVALID)

    if body.kind not in KINDS:
        raise _bad("Elige un tipo de artículo válido.")
    if body.category not in CATEGORIES:
        raise _bad("Elige una categoría válida.")

    excerpt = _check_max(clean_line(body.excerpt), "excerpt", "El extracto admite como máximo 300 caracteres.")
    summary = _check_max(clean_multiline(body.summary), "summary", "El resumen admite como máximo 800 caracteres.")

    takeaways = _clean_items(body.key_takeaways)
    if len(takeaways) > LIMITS["key_takeaways_items"]:
        raise _bad("Puedes agregar como máximo 8 ideas clave.")
    if any(len(item) > LIMITS["key_takeaway"] for item in takeaways):
        raise _bad("Cada idea clave admite como máximo 200 caracteres.")

    content_md = _check_max(clean_markdown(body.content_md), "content_md", CONTENT_TOO_LONG)

    faq = [
        {"question": question, "answer": answer}
        for question, answer in ((clean_line(item.question), clean_line(item.answer)) for item in body.faq or [])
        if question or answer
    ]
    if len(faq) > LIMITS["faq_items"]:
        raise _bad("Puedes agregar como máximo 8 preguntas frecuentes.")
    if any(not item["question"] or not item["answer"] for item in faq):
        raise _bad("Cada pregunta frecuente necesita pregunta y respuesta.")
    if any(len(item["question"]) > LIMITS["faq_question"] for item in faq):
        raise _bad("Cada pregunta admite como máximo 200 caracteres.")
    if any(len(item["answer"]) > LIMITS["faq_answer"] for item in faq):
        raise _bad("Cada respuesta admite como máximo 1200 caracteres.")

    meta_title = _check_max(clean_line(body.meta_title), "meta_title", "El meta título admite como máximo 120 caracteres.")
    meta_description = _check_max(
        clean_line(body.meta_description), "meta_description", "La meta descripción admite como máximo 300 caracteres."
    )

    keywords: list[str] = []
    seen: set[str] = set()
    for keyword in _clean_items(body.keywords):
        if keyword.lower() not in seen:
            seen.add(keyword.lower())
            keywords.append(keyword)
    if len(keywords) > LIMITS["keywords_items"]:
        raise _bad("Puedes agregar como máximo 12 palabras clave.")
    if any(len(item) > LIMITS["keyword"] for item in keywords):
        raise _bad("Cada palabra clave admite como máximo 60 caracteres.")

    cover_alt = _check_max(clean_line(body.cover_alt), "cover_alt", "El texto alternativo admite como máximo 200 caracteres.")

    values = {
        "title": title,
        "kind": body.kind,
        "category": body.category,
        "excerpt": excerpt,
        "summary": summary,
        "key_takeaways": takeaways,
        "content_md": content_md,
        "faq": faq,
        "meta_title": meta_title,
        "meta_description": meta_description,
        "keywords": keywords,
        "cover_alt": cover_alt,
    }
    return values, slug


def check_publishable(excerpt: str, content_md: str) -> None:
    if not (excerpt or "").strip():
        raise _bad(PUBLISH_NEEDS_EXCERPT)
    if len(content_md or "") < LIMITS["content_publish_min"]:
        raise _bad(PUBLISH_NEEDS_CONTENT)


def set_content(post: BlogPost, content_md: str) -> None:
    """Store the Markdown and its freshly rendered, sanitized HTML and word count."""
    rendered = render.render_markdown(content_md)
    post.content_md = content_md
    post.content_html = rendered.html
    post.word_count = rendered.word_count


# -------------------------------------------------------------------- slugs


async def slug_taken(db_session: AsyncSession, org_id: int, slug: str, exclude_id: Optional[int] = None) -> bool:
    conditions = [BlogPost.org_id == org_id, BlogPost.slug == slug]
    if exclude_id is not None:
        conditions.append(BlogPost.id != exclude_id)
    return (await db_session.execute(select(BlogPost.id).where(*conditions).limit(1))).first() is not None


def _with_suffix(base: str, n: int) -> str:
    suffix = f"-{n}"
    return base[: LIMITS["slug"] - len(suffix)].rstrip("-") + suffix


async def unique_slug(db_session: AsyncSession, org_id: int, base: str) -> str:
    """``base`` (or ``articulo``) made unique in the org with ``-2``, ``-3``..."""
    base = slugify(base)
    if not is_valid_slug(base):
        base = FALLBACK_SLUG
    candidate = base
    n = 2
    while await slug_taken(db_session, org_id, candidate):
        candidate = _with_suffix(base, n)
        n += 1
    return candidate


# ------------------------------------------------------------- serializers


def _faq_list(value) -> list[dict]:
    return [
        {"question": str(item.get("question", "")), "answer": str(item.get("answer", ""))}
        for item in (value or [])
        if isinstance(item, dict)
    ]


def _str_list(value) -> list[str]:
    return [str(item) for item in (value or [])]


def public_card(org: Organization, post: BlogPost, request: Optional[Request]) -> dict:
    """``PublicPostCard``."""
    return {
        "slug": post.slug,
        "title": post.title,
        "excerpt": post.excerpt,
        "kind": post.kind,
        "category": post.category,
        "category_label": CATEGORIES.get(post.category, post.category),
        "cover_url": cover_url(org.org_uuid, post, request),
        "cover_alt": post.cover_alt,
        "published_at": iso(post.published_at),
        "updated_at": iso(post.update_date),
        "reading_minutes": reading_minutes(post.word_count),
    }


def public_post(org: Organization, post: BlogPost, request: Optional[Request]) -> dict:
    """``PublicPost``: the card plus the article (SEO fields with their fallbacks applied)."""
    payload = public_card(org, post, request)
    payload.update({
        "summary": post.summary,
        "key_takeaways": _str_list(post.key_takeaways),
        "content_html": post.content_html,
        "faq": _faq_list(post.faq),
        "meta_title": post.meta_title or post.title,
        "meta_description": post.meta_description or post.excerpt,
        "keywords": _str_list(post.keywords),
        "word_count": post.word_count,
        "og_image_url": og_image_url(org.org_uuid, post, request),
    })
    return payload


def admin_summary(org: Organization, post: BlogPost, request: Optional[Request]) -> dict:
    """``AdminPostSummary`` (one row of the dashboard list)."""
    return {
        "id": post.id,
        "slug": post.slug,
        "title": post.title,
        "status": post.status,
        "kind": post.kind,
        "category": post.category,
        "source": post.source,
        "cover_url": cover_url(org.org_uuid, post, request),
        "word_count": post.word_count,
        "published_at": iso(post.published_at),
        "created_at": iso(post.creation_date),
        "updated_at": iso(post.update_date),
    }


def admin_post(org: Organization, post: BlogPost, request: Optional[Request]) -> dict:
    """``AdminPost`` (raw meta fields, without the public fallbacks)."""
    return {
        "id": post.id,
        "post_uuid": post.post_uuid,
        "slug": post.slug,
        "slug_locked": post.published_at is not None,
        "status": post.status,
        "kind": post.kind,
        "category": post.category,
        "title": post.title,
        "excerpt": post.excerpt,
        "summary": post.summary,
        "key_takeaways": _str_list(post.key_takeaways),
        "content_md": post.content_md,
        "content_html": post.content_html,
        "faq": _faq_list(post.faq),
        "meta_title": post.meta_title,
        "meta_description": post.meta_description,
        "keywords": _str_list(post.keywords),
        "cover_url": cover_url(org.org_uuid, post, request),
        "og_image_url": og_image_url(org.org_uuid, post, request),
        "cover_alt": post.cover_alt,
        "word_count": post.word_count,
        "reading_minutes": reading_minutes(post.word_count),
        "source": post.source,
        "ai_model": post.ai_model,
        "public_path": f"/blog/{post.slug}",
        "published_at": iso(post.published_at),
        "created_at": iso(post.creation_date),
        "updated_at": iso(post.update_date),
    }


# ------------------------------------------------------------------- admin


async def get_post_or_404(db_session: AsyncSession, org_id: int, post_id: int) -> BlogPost:
    post = (await db_session.execute(
        select(BlogPost).where(BlogPost.id == post_id, BlogPost.org_id == org_id)
    )).scalars().first()
    if post is None:
        raise HTTPException(status_code=404, detail=POST_NOT_FOUND)
    return post


async def _commit_or_409(db_session: AsyncSession, post: BlogPost) -> None:
    try:
        await db_session.commit()
    except IntegrityError:
        # Another save took the same slug between our check and the commit.
        await db_session.rollback()
        raise HTTPException(status_code=409, detail=SLUG_TAKEN)
    await db_session.refresh(post)


async def _count(db_session: AsyncSession, *conditions) -> int:
    return int((await db_session.execute(
        select(func.count()).select_from(BlogPost).where(*conditions)
    )).scalar_one())


async def list_posts(
    db_session: AsyncSession,
    request: Request,
    org_id: int,
    page: int = 1,
    limit: int = 20,
    q: Optional[str] = None,
    status: Optional[str] = None,
) -> dict:
    """``AdminPostPage``: last updated first; ``counts`` ignore ``q`` and ``status``."""
    org = await get_org_or_404(db_session, org_id)
    # clean_line: a NUL or other control character would make PostgreSQL fail (500).
    search = clean_line(q)[: LIMITS["search"]].strip()
    conditions = [BlogPost.org_id == org_id]
    if search:
        conditions.append(func.lower(BlogPost.title).contains(search.lower(), autoescape=True))
    if status in STATUSES:
        conditions.append(BlogPost.status == status)

    rows = (await db_session.execute(
        select(BlogPost)
        .where(*conditions)
        .order_by(BlogPost.update_date.desc(), BlogPost.id.desc())  # type: ignore[union-attr]
        .offset((page - 1) * limit)
        .limit(limit)
    )).scalars().all()

    return {
        "items": [admin_summary(org, row, request) for row in rows],
        "total": await _count(db_session, *conditions),
        "page": page,
        "limit": limit,
        "counts": {
            "all": await _count(db_session, BlogPost.org_id == org_id),
            "draft": await _count(db_session, BlogPost.org_id == org_id, BlogPost.status == "draft"),
            "published": await _count(db_session, BlogPost.org_id == org_id, BlogPost.status == "published"),
        },
    }


async def get_post(db_session: AsyncSession, request: Request, org_id: int, post_id: int) -> dict:
    org = await get_org_or_404(db_session, org_id)
    return admin_post(org, await get_post_or_404(db_session, org_id, post_id), request)


async def create_post(
    db_session: AsyncSession, request: Request, org_id: int, user_id: Optional[int], body: PostBody
) -> dict:
    """New draft written by hand. An empty slug is derived from the title (made unique)."""
    org = await get_org_or_404(db_session, org_id)
    values, slug = _validated(body, require_slug=False)
    if slug:
        if await slug_taken(db_session, org_id, slug):
            raise HTTPException(status_code=409, detail=SLUG_TAKEN)
    else:
        slug = await unique_slug(db_session, org_id, values["title"])

    content_md = values.pop("content_md")
    post = BlogPost(
        org_id=org_id,
        slug=slug,
        status="draft",
        source="manual",
        created_by_user_id=user_id,
        **values,
    )
    set_content(post, content_md)
    db_session.add(post)
    await _commit_or_409(db_session, post)
    return admin_post(org, post, request)


async def update_post(
    db_session: AsyncSession, request: Request, org_id: int, post_id: int, body: PostBody
) -> dict:
    org = await get_org_or_404(db_session, org_id)
    post = await get_post_or_404(db_session, org_id, post_id)
    values, slug = _validated(body, require_slug=True)
    if slug != post.slug:
        if post.published_at is not None:
            raise _bad(SLUG_LOCKED)
        if await slug_taken(db_session, org_id, slug, exclude_id=post.id):
            raise HTTPException(status_code=409, detail=SLUG_TAKEN)
    if post.status == "published":
        check_publishable(values["excerpt"], values["content_md"])

    content_md = values.pop("content_md")
    for field, value in values.items():
        setattr(post, field, value)
    post.slug = slug
    set_content(post, content_md)
    post.update_date = utcnow()
    db_session.add(post)
    await _commit_or_409(db_session, post)
    return admin_post(org, post, request)


async def delete_post(db_session: AsyncSession, org_id: int, post_id: int) -> dict:
    """Delete an article and, best effort, its cover files. Refused while an AI revision runs on it."""
    from src.services.blog import covers, jobs

    org = await get_org_or_404(db_session, org_id)
    post = await get_post_or_404(db_session, org_id, post_id)
    if await jobs.has_active_revision(db_session, org_id, post.id):
        raise HTTPException(status_code=409, detail="Espera a que termine la mejora con IA de este artículo.")
    post_uuid = post.post_uuid
    await db_session.delete(post)
    await db_session.commit()
    await covers.remove_post_files(org.org_uuid, post_uuid)
    return {"deleted": True}


async def publish_post(db_session: AsyncSession, request: Request, org_id: int, post_id: int) -> dict:
    """Publish (idempotent). ``published_at`` is set only the first time."""
    org = await get_org_or_404(db_session, org_id)
    post = await get_post_or_404(db_session, org_id, post_id)
    check_publishable(post.excerpt, post.content_md)
    if post.status != "published" or post.published_at is None:
        post.status = "published"
        if post.published_at is None:
            post.published_at = utcnow()
        post.update_date = utcnow()
        db_session.add(post)
        await db_session.commit()
        await db_session.refresh(post)
    return admin_post(org, post, request)


async def unpublish_post(db_session: AsyncSession, request: Request, org_id: int, post_id: int) -> dict:
    """Back to draft. ``published_at`` is kept, so the slug stays locked."""
    org = await get_org_or_404(db_session, org_id)
    post = await get_post_or_404(db_session, org_id, post_id)
    if post.status != "draft":
        post.status = "draft"
        post.update_date = utcnow()
        db_session.add(post)
        await db_session.commit()
        await db_session.refresh(post)
    return admin_post(org, post, request)


def preview(user_id: Optional[int], body: PreviewBody) -> dict:
    """``PreviewResult``: what the site would show for this Markdown (nothing is stored)."""
    check_rate(
        f"sc_blog_preview:{user_id}", 120, 600, "Demasiadas vistas previas seguidas. Espera un momento."
    )
    content_md = clean_markdown(body.content_md)
    if len(content_md) > LIMITS["content_md"]:
        raise _bad(CONTENT_TOO_LONG)
    rendered = render.render_markdown(content_md)
    return {"content_html": rendered.html, "word_count": rendered.word_count}


# ------------------------------------------------------------------ public


def _published(org_id: int) -> list:
    return [BlogPost.org_id == org_id, BlogPost.status == "published"]


def _public_order():
    return (BlogPost.published_at.desc(), BlogPost.id.desc())  # type: ignore[union-attr]


async def list_public(db_session: AsyncSession, request: Request, org_id: int, page: int = 1, limit: int = 12) -> dict:
    """``PublicPostPage``: published articles, newest first."""
    org = await get_org_or_404(db_session, org_id)
    rows = (await db_session.execute(
        select(BlogPost)
        .where(*_published(org_id))
        .order_by(*_public_order())
        .offset((page - 1) * limit)
        .limit(limit)
    )).scalars().all()
    return {
        "items": [public_card(org, row, request) for row in rows],
        "total": await _count(db_session, *_published(org_id)),
        "page": page,
        "limit": limit,
    }


async def get_public(db_session: AsyncSession, request: Request, org_id: int, slug: str) -> dict:
    """``PublicPost``; drafts, unknown or malformed slugs are all the same 404."""
    org = await get_org_or_404(db_session, org_id)
    if not is_valid_slug(slug or ""):
        raise HTTPException(status_code=404, detail=POST_NOT_FOUND)
    post = (await db_session.execute(
        select(BlogPost).where(*_published(org_id), BlogPost.slug == slug)
    )).scalars().first()
    if post is None:
        raise HTTPException(status_code=404, detail=POST_NOT_FOUND)
    return public_post(org, post, request)


async def public_sitemap(db_session: AsyncSession, org_id: int) -> dict:
    """``PublicSitemap``: every published article (at most 5000), newest first."""
    await get_org_or_404(db_session, org_id)
    rows = (await db_session.execute(
        select(BlogPost.slug, BlogPost.published_at, BlogPost.update_date)
        .where(*_published(org_id))
        .order_by(*_public_order())
        .limit(SITEMAP_MAX_ITEMS)
    )).all()
    return {
        "items": [
            {"slug": slug, "published_at": iso(published_at), "updated_at": iso(updated_at)}
            for slug, published_at, updated_at in rows
        ]
    }


# ------------------------------------------------------------- AI results


def apply_generated(post: BlogPost, fields: dict) -> None:
    """Copy a normalized AI article onto a draft (``slug`` and ``kind`` are kept)."""
    post.category = fields["category"]
    post.title = fields["title"]
    post.meta_title = fields["meta_title"]
    post.meta_description = fields["meta_description"]
    post.excerpt = fields["excerpt"]
    post.summary = fields["summary"]
    post.key_takeaways = list(fields["key_takeaways"])
    post.faq = [dict(item) for item in fields["faq"]]
    post.keywords = list(fields["keywords"])
    set_content(post, fields["content_md"])
    post.update_date = utcnow()

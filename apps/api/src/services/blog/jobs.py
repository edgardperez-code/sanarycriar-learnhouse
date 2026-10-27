"""Sanar y Criar: AI jobs of the blog (write a draft, revise an article) run in the background.

A request only validates, records a ``pending`` job and answers 202; the
Claude call (1–3 minutes) runs afterwards in a task with a database session
of its own, and the dashboard polls the job. At most one active job per org
(an in-memory lock per event loop: production runs a single uvicorn
process). A job left ``pending``/``running`` by a restart is marked as
interrupted once it is 10 minutes old, on the next look at the org's jobs.

The owner's texts (topic, facts, instruction) only travel in memory to the
task: ``meta_json`` keeps flags and lengths, never the text. The AI module is
always reached as ``ai.<name>`` so tests can patch it.
"""

import asyncio
import logging
import traceback
import weakref
from datetime import timedelta
from typing import Optional

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy.exc import IntegrityError
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from src.db.blog.blog import BlogAIJob, BlogPost
from src.services.blog import ai, posts
from src.services.blog.common import (
    AI_HOURLY_LIMIT,
    AUDIENCES,
    CATEGORIES,
    DEFAULT_CATEGORY,
    DEFAULT_KIND,
    KINDS,
    LENGTHS,
    LIMITS,
    SEO_TARGETS,
    check_rate,
    is_valid_slug,
    slugify,
)
from src.services.newsletter.common import clean_line, clean_multiline
from src.services.payments.common import as_utc, get_org_or_404, iso, utcnow

log = logging.getLogger(__name__)

STALE_AFTER = timedelta(minutes=10)
STALE_ERROR = "La tarea se interrumpió. Intenta de nuevo."
UNEXPECTED_ERROR = "Ocurrió un error inesperado con la IA. Intenta de nuevo."
POST_GONE_ERROR = "El artículo ya no existe."
ACTIVE_STATUSES = ("pending", "running")
POLL_AFTER_MS = 3000

# Strong references to the running jobs (the loop only keeps weak ones).
_background: set = set()
# One dict of org locks per event loop (see ``_org_lock``).
_locks = weakref.WeakKeyDictionary()
_locks_fallback: dict = {}


class GenerateBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    prompt: str = ""
    kind: str = DEFAULT_KIND
    audience: str = "familias"
    length: str = "medio"
    keyword: str = ""
    facts: str = ""


class ReviseBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    instruction: str = ""


# ------------------------------------------------------------- serializers


def job_dict(job: BlogAIJob) -> dict:
    """``Job``. ``result`` only for a revision kept aside because the article is published."""
    result = None
    if job.operation == "revise" and job.status == "done" and not job.applied and isinstance(job.result_json, dict):
        result = {field: job.result_json.get(field) for field in ai.ARTICLE_FIELDS}
    start = as_utc(job.started_at) or as_utc(job.creation_date)
    end = as_utc(job.finished_at) or utcnow()
    elapsed = max(0, int((end - start).total_seconds())) if start else 0
    return {
        "id": job.id,
        "operation": job.operation,
        "status": job.status,
        "post_id": job.post_id,
        "applied": bool(job.applied),
        "result": result,
        "error": job.error,
        "model": job.model,
        "created_at": iso(job.creation_date),
        "started_at": iso(job.started_at),
        "finished_at": iso(job.finished_at),
        "elapsed_seconds": elapsed,
        "poll_after_ms": POLL_AFTER_MS,
    }


def blog_config() -> dict:
    """``BlogConfig`` for the dashboard."""
    enabled = ai.ai_configured()
    mock = ai.mock_enabled()
    return {
        "ai_enabled": enabled,
        "ai_mock": mock,
        "ai_model": ("mock" if mock else ai.model_id()) if enabled else None,
        "ai_hourly_limit": AI_HOURLY_LIMIT,
        "limits": dict(LIMITS),
        "seo": dict(SEO_TARGETS),
    }


# ------------------------------------------------------------------ queries


async def _active_jobs(db_session: AsyncSession, org_id: int) -> list[BlogAIJob]:
    return list((await db_session.execute(
        select(BlogAIJob)
        .where(BlogAIJob.org_id == org_id, BlogAIJob.status.in_(ACTIVE_STATUSES))  # type: ignore[union-attr]
        .order_by(BlogAIJob.creation_date.desc(), BlogAIJob.id.desc())  # type: ignore[union-attr]
    )).scalars().all())


async def expire_stale_jobs(db_session: AsyncSession, org_id: int) -> None:
    """Mark as interrupted the org's active jobs created more than 10 minutes ago."""
    cutoff = utcnow() - STALE_AFTER
    now = utcnow()
    expired = False
    for job in await _active_jobs(db_session, org_id):
        created = as_utc(job.creation_date)
        if created is not None and created < cutoff:
            job.status = "error"
            job.error = STALE_ERROR
            job.finished_at = now
            db_session.add(job)
            expired = True
            log.warning("[blog-ia] job %s marked as interrupted (stale)", job.id)
    if expired:
        await db_session.commit()


async def get_active_job(db_session: AsyncSession, org_id: int) -> Optional[BlogAIJob]:
    jobs = await _active_jobs(db_session, org_id)
    return jobs[0] if jobs else None


async def has_active_revision(db_session: AsyncSession, org_id: int, post_id: int) -> bool:
    await expire_stale_jobs(db_session, org_id)
    return any(
        job.operation == "revise" and job.post_id == post_id for job in await _active_jobs(db_session, org_id)
    )


async def get_job(db_session: AsyncSession, org_id: int, job_id: int) -> dict:
    await get_org_or_404(db_session, org_id)
    await expire_stale_jobs(db_session, org_id)
    job = (await db_session.execute(
        select(BlogAIJob).where(BlogAIJob.id == job_id, BlogAIJob.org_id == org_id)
    )).scalars().first()
    if job is None:
        raise HTTPException(status_code=404, detail="Tarea no encontrada.")
    return job_dict(job)


async def get_active(db_session: AsyncSession, org_id: int) -> dict:
    await get_org_or_404(db_session, org_id)
    await expire_stale_jobs(db_session, org_id)
    job = await get_active_job(db_session, org_id)
    return {"job": job_dict(job) if job is not None else None}


# ----------------------------------------------------------------- starting


def _org_lock(org_id: int) -> asyncio.Lock:
    """One lock per (running event loop, org): a Lock is bound to the loop that first awaits it."""
    loop = asyncio.get_running_loop()
    try:
        per_loop = _locks.setdefault(loop, {})
    except TypeError:  # a loop type that cannot be weakly referenced
        per_loop = _locks_fallback.setdefault(id(loop), {})
    lock = per_loop.get(org_id)
    if lock is None:
        lock = per_loop[org_id] = asyncio.Lock()
    return lock



def schedule(coro) -> None:
    """Run a job after the response is sent. Never raises.

    If it cannot be scheduled (or the process stops first) the job stays
    ``pending`` and is marked as interrupted after 10 minutes.
    """
    try:
        task = asyncio.get_running_loop().create_task(coro)
    except Exception:
        coro.close()
        log.exception("[blog-ia] could not schedule a job")
        return
    _background.add(task)
    task.add_done_callback(_background.discard)


async def wait_for_background() -> None:
    """Wait until every job scheduled on this loop has finished (tests use it)."""
    loop = asyncio.get_running_loop()
    while True:
        pending = [task for task in _background if task.get_loop() is loop and not task.done()]
        if not pending:
            return
        await asyncio.gather(*pending, return_exceptions=True)


def _require_ai() -> None:
    if not ai.ai_configured():
        raise HTTPException(status_code=503, detail="La IA no está configurada en el servidor.")


async def _create_job(db_session: AsyncSession, org_id: int, job: BlogAIJob) -> BlogAIJob:
    """Record the job unless another one is active; the 409 comes before the hourly quota."""
    async with _org_lock(org_id):
        await expire_stale_jobs(db_session, org_id)
        if await get_active_job(db_session, org_id) is not None:
            raise HTTPException(status_code=409, detail="Ya hay una tarea de IA en curso. Espera a que termine.")
        check_rate(
            f"sc_blog_ai_org:{org_id}",
            AI_HOURLY_LIMIT,
            3600,
            "Llegaste al límite de 15 usos de la IA por hora. Intenta de nuevo más tarde.",
        )
        db_session.add(job)
        await db_session.commit()
        await db_session.refresh(job)
    return job


async def start_generate(db_session: AsyncSession, org_id: int, user_id: Optional[int], body: GenerateBody) -> dict:
    """Validate and queue a new AI draft; returns the ``pending`` job (202)."""
    _require_ai()
    prompt = clean_multiline(body.prompt)
    if not LIMITS["prompt_min"] <= len(prompt) <= LIMITS["prompt"]:
        raise HTTPException(status_code=400, detail="Escribe el tema o la indicación (entre 10 y 4000 caracteres).")
    if body.kind not in KINDS:
        raise HTTPException(status_code=400, detail="Elige un tipo de artículo válido.")
    if body.audience not in AUDIENCES:
        raise HTTPException(status_code=400, detail="Elige un público válido.")
    if body.length not in LENGTHS:
        raise HTTPException(status_code=400, detail="Elige una extensión válida.")
    keyword = clean_line(body.keyword)
    if len(keyword) > LIMITS["ai_keyword"]:
        raise HTTPException(status_code=400, detail="La palabra clave admite como máximo 80 caracteres.")
    facts = clean_multiline(body.facts)
    if len(facts) > LIMITS["facts"]:
        raise HTTPException(status_code=400, detail="Los datos admiten como máximo 2000 caracteres.")
    await get_org_or_404(db_session, org_id)

    job = await _create_job(db_session, org_id, BlogAIJob(
        org_id=org_id,
        operation="generate",
        status="pending",
        created_by_user_id=user_id,
        meta_json={
            "kind": body.kind,
            "audience": body.audience,
            "length": body.length,
            "has_keyword": bool(keyword),
            "has_facts": bool(facts),
            "prompt_chars": len(prompt),
        },
    ))
    payload = job_dict(job)
    log.info("[blog-ia] job %s queued (generate, org %s, prompt_chars=%s)", job.id, org_id, len(prompt))
    schedule(_run_generate(job.id, ai.GenerateParams(
        prompt=prompt, kind=body.kind, audience=body.audience, length=body.length, keyword=keyword, facts=facts,
    )))
    return payload


async def start_revise(
    db_session: AsyncSession, org_id: int, user_id: Optional[int], post_id: int, body: ReviseBody
) -> dict:
    """Validate and queue an AI revision of an article; returns the ``pending`` job (202)."""
    _require_ai()
    instruction = clean_multiline(body.instruction)
    if not LIMITS["instruction_min"] <= len(instruction) <= LIMITS["instruction"]:
        raise HTTPException(status_code=400, detail="Escribe qué quieres mejorar (entre 5 y 2000 caracteres).")
    await get_org_or_404(db_session, org_id)
    post = await posts.get_post_or_404(db_session, org_id, post_id)

    job = await _create_job(db_session, org_id, BlogAIJob(
        org_id=org_id,
        post_id=post.id,
        operation="revise",
        status="pending",
        created_by_user_id=user_id,
        meta_json={"instruction_chars": len(instruction)},
    ))
    payload = job_dict(job)
    log.info("[blog-ia] job %s queued (revise post %s, org %s)", job.id, post.id, org_id)
    schedule(_run_revise(job.id, instruction))
    return payload


# ------------------------------------------------------------------ running


def _session_scope():
    """A database session of the job's own: the request's one closes with it.

    Tests patch this to hand over their in-memory session.
    """
    from src.core.events.database import _async_session_factory

    return _async_session_factory()


async def _load_job(db_session: AsyncSession, job_id: int) -> Optional[BlogAIJob]:
    return await db_session.get(BlogAIJob, job_id, populate_existing=True)


async def _mark_running(db_session: AsyncSession, job_id: int) -> Optional[BlogAIJob]:
    job = await _load_job(db_session, job_id)
    if job is None or job.status != "pending":
        return None
    job.status = "running"
    job.started_at = utcnow()
    db_session.add(job)
    await db_session.commit()
    return job


async def _still_running(db_session: AsyncSession, job_id: int) -> Optional[BlogAIJob]:
    """The job, re-read after the AI call; ``None`` when it was expired meanwhile (result dropped)."""
    job = await _load_job(db_session, job_id)
    if job is None or job.status != "running":
        log.warning("[blog-ia] job %s is no longer running; result discarded", job_id)
        return None
    return job


async def _fail(db_session: AsyncSession, job_id: int, message: str) -> None:
    job = await _load_job(db_session, job_id)
    if job is None or job.status not in ACTIVE_STATUSES:
        return
    job.status = "error"
    job.error = message[:300]
    job.finished_at = utcnow()
    db_session.add(job)
    await db_session.commit()


async def _fail_unexpectedly(db_session: AsyncSession, job_id: int, exc: BaseException) -> None:
    # Class and stack frames only: the message of a database error can quote
    # the article it was saving.
    log.error(
        "[blog-ia] job %s failed unexpectedly (%s)\n%s",
        job_id, type(exc).__name__, "".join(traceback.format_tb(exc.__traceback__)),
    )
    try:
        await db_session.rollback()
        await _fail(db_session, job_id, UNEXPECTED_ERROR)
    except Exception as inner:
        log.error("[blog-ia] job %s: could not record the failure (%s)", job_id, type(inner).__name__)


def _finish(job: BlogAIJob, result: "ai.AIResult") -> None:
    job.status = "done"
    job.error = None
    job.model = (result.model or "")[:64] or None
    job.usage_json = dict(result.usage) if result.usage else None
    job.finished_at = utcnow()


def _draft_slug_base(fields: dict) -> str:
    return fields["slug"] if is_valid_slug(fields["slug"]) else slugify(fields["title"])


async def _generate(db_session: AsyncSession, job_id: int, params: "ai.GenerateParams") -> None:
    job = await _mark_running(db_session, job_id)
    if job is None:
        return
    try:
        result = await ai.generate_article(params)
        fields = ai.normalize_generated(
            result.article, kind=params.kind, allowed_external=ai.allowed_urls(params.facts, params.prompt)
        )
    except ai.BlogAIError as exc:
        await _fail(db_session, job_id, str(exc))
        log.info("[blog-ia] job %s failed: %s", job_id, exc)
        return

    for attempt in range(2):
        job = await _still_running(db_session, job_id)
        if job is None:
            return
        post = BlogPost(
            org_id=job.org_id,
            slug=await posts.unique_slug(db_session, job.org_id, _draft_slug_base(fields)),
            title=fields["title"],
            kind=params.kind,
            category=fields["category"],
            status="draft",
            excerpt=fields["excerpt"],
            summary=fields["summary"],
            key_takeaways=list(fields["key_takeaways"]),
            faq=[dict(item) for item in fields["faq"]],
            meta_title=fields["meta_title"],
            meta_description=fields["meta_description"],
            keywords=list(fields["keywords"]),
            source="ai",
            ai_model=(result.model or "")[:64] or None,
            created_by_user_id=job.created_by_user_id,
        )
        posts.set_content(post, fields["content_md"])
        db_session.add(post)
        try:
            await db_session.flush()
            job.post_id = post.id
            job.applied = True
            _finish(job, result)
            db_session.add(job)
            await db_session.commit()
        except IntegrityError:
            # Another save took the slug meanwhile: pick the next free one.
            await db_session.rollback()
            if attempt:
                raise
            continue
        log.info("[blog-ia] job %s done: draft %s (%s words)", job_id, post.id, post.word_count)
        return


def _article_from_post(post: BlogPost) -> "ai.GeneratedArticle":
    return ai.GeneratedArticle.model_validate({
        "category": post.category if post.category in CATEGORIES else DEFAULT_CATEGORY,
        "title": post.title,
        "slug": post.slug,
        "meta_title": post.meta_title,
        "meta_description": post.meta_description,
        "excerpt": post.excerpt,
        "summary": post.summary,
        "key_takeaways": list(post.key_takeaways or []),
        "content_md": post.content_md,
        "faq": [item for item in (post.faq or []) if isinstance(item, dict)],
        "keywords": list(post.keywords or []),
    })


async def _revise(db_session: AsyncSession, job_id: int, instruction: str) -> None:
    job = await _mark_running(db_session, job_id)
    if job is None:
        return
    post = await db_session.get(BlogPost, job.post_id) if job.post_id is not None else None
    if post is None or post.org_id != job.org_id:
        await _fail(db_session, job_id, POST_GONE_ERROR)
        return
    post_id = post.id
    kind = post.kind
    # Any save meanwhile (another tab) changes it: then the result is not applied.
    saved_at = as_utc(post.update_date)
    # External links the revision may keep: the ones in her instruction and the
    # ones the article already links to (hers, or let through from her data);
    # not a URL that is only plain text in it.
    allowed_external = ai.allowed_urls(instruction) | ai.linked_urls(post.content_md)
    try:
        result = await ai.revise_article(_article_from_post(post), kind, instruction)
        fields = ai.normalize_generated(result.article, kind=kind, allowed_external=allowed_external)
    except ai.BlogAIError as exc:
        await _fail(db_session, job_id, str(exc))
        log.info("[blog-ia] job %s failed: %s", job_id, exc)
        return

    job = await _still_running(db_session, job_id)
    if job is None:
        return
    post = await db_session.get(BlogPost, post_id, populate_existing=True)
    if post is None:
        await _fail(db_session, job_id, POST_GONE_ERROR)
        return
    if post.status == "draft" and as_utc(post.update_date) == saved_at:
        posts.apply_generated(post, fields)
        db_session.add(post)
        job.applied = True
        job.result_json = None
    else:
        # A published article is never changed behind the owner's back, nor a
        # draft saved while the AI worked (her newer edits would be lost): the
        # proposal waits in the job for her to load into the editor.
        job.applied = False
        job.result_json = {**fields, "slug": post.slug}
    _finish(job, result)
    db_session.add(job)
    await db_session.commit()
    log.info("[blog-ia] job %s done: post %s (applied=%s)", job_id, post_id, job.applied)


async def _run_generate(job_id: int, params: "ai.GenerateParams") -> None:
    """Background task of a ``generate`` job. Never raises."""
    try:
        async with _session_scope() as db_session:
            try:
                await _generate(db_session, job_id, params)
            except Exception as exc:
                await _fail_unexpectedly(db_session, job_id, exc)
    except Exception as exc:
        log.error("[blog-ia] job %s: no database session (%s)", job_id, type(exc).__name__)


async def _run_revise(job_id: int, instruction: str) -> None:
    """Background task of a ``revise`` job. Never raises."""
    try:
        async with _session_scope() as db_session:
            try:
                await _revise(db_session, job_id, instruction)
            except Exception as exc:
                await _fail_unexpectedly(db_session, job_id, exc)
    except Exception as exc:
        log.error("[blog-ia] job %s: no database session (%s)", job_id, type(exc).__name__)

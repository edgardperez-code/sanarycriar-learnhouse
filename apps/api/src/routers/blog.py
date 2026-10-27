"""Sanar y Criar: blog API (articles of the marketing site, mounted at /blog).

Auth levels used below:
- admin: org admin/maintainer (superadmin included) with a real session.
- public: anonymous. Never reads the session (no ``get_current_user``) and
  is not rate limited: the site's server calls it on every visit, always
  from the same address.

Literal routes are declared before the parametric ones (``ai/jobs/active``
before ``ai/jobs/{job_id}``, ``posts`` before ``posts/{post_id}``).
"""

from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, Response, UploadFile
from sqlmodel.ext.asyncio.session import AsyncSession

from src.core.events.database import get_db_session
from src.db.users import AnonymousUser, APITokenUser, SuperadminAPITokenUser
from src.security.auth import get_current_user
from src.services.blog import covers as covers_service
from src.services.blog import jobs as jobs_service
from src.services.blog import posts as posts_service
from src.services.blog.jobs import GenerateBody, ReviseBody
from src.services.blog.posts import PostBody, PreviewBody

router = APIRouter()


# ------------------------------------------------------------ dependencies


async def require_blog_admin(
    org_id: int,
    current_user=Depends(get_current_user),
    db_session: AsyncSession = Depends(get_db_session),
):
    if current_user is None or isinstance(current_user, AnonymousUser):
        raise HTTPException(status_code=401, detail="Authentication required")
    if isinstance(current_user, (APITokenUser, SuperadminAPITokenUser)):
        raise HTTPException(status_code=403, detail="API tokens cannot manage the blog")
    from src.security.org_auth import require_org_admin
    from src.services.payments.common import get_org_or_404

    await get_org_or_404(db_session, org_id)
    await require_org_admin(current_user.id, org_id, db_session)
    return current_user


def _no_store(response: Response) -> None:
    # The dashboard promises "what you publish is live at once": never cache.
    response.headers["Cache-Control"] = "no-store"


# ------------------------------------------------------------------ public


@router.get("/{org_id}/public/posts", summary="Published blog articles (public)")
async def api_public_posts(
    request: Request,
    org_id: int,
    response: Response,
    # Capped: a huge page overflows the database's 64-bit OFFSET (500).
    page: int = Query(1, ge=1, le=100000),
    limit: int = Query(12, ge=1, le=50),
    db_session: AsyncSession = Depends(get_db_session),
):
    _no_store(response)
    return await posts_service.list_public(db_session, request, org_id, page, limit)


@router.get("/{org_id}/public/posts/{slug}", summary="One published blog article (public)")
async def api_public_post(
    request: Request,
    org_id: int,
    slug: str,
    response: Response,
    db_session: AsyncSession = Depends(get_db_session),
):
    _no_store(response)
    return await posts_service.get_public(db_session, request, org_id, slug)


@router.get("/{org_id}/public/sitemap", summary="Slugs and dates of the published articles (public)")
async def api_public_sitemap(
    org_id: int,
    response: Response,
    db_session: AsyncSession = Depends(get_db_session),
):
    _no_store(response)
    return await posts_service.public_sitemap(db_session, org_id)


# ------------------------------------------------------------ admin: tools


@router.get("/{org_id}/config", summary="Blog limits and AI availability (admin)")
async def api_config(
    org_id: int,
    _admin=Depends(require_blog_admin),
):
    return jobs_service.blog_config()


@router.post("/{org_id}/preview", summary="Render Markdown as the site would show it (admin)")
async def api_preview(
    org_id: int,
    body: PreviewBody,
    admin=Depends(require_blog_admin),
):
    return posts_service.preview(getattr(admin, "id", None), body)


@router.post("/{org_id}/ai/generate", status_code=202, summary="Write a new draft with AI (admin)")
async def api_ai_generate(
    org_id: int,
    body: GenerateBody,
    admin=Depends(require_blog_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await jobs_service.start_generate(db_session, org_id, getattr(admin, "id", None), body)


@router.get("/{org_id}/ai/jobs/active", summary="The org's AI job in progress, if any (admin)")
async def api_ai_active_job(
    org_id: int,
    _admin=Depends(require_blog_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await jobs_service.get_active(db_session, org_id)


@router.get("/{org_id}/ai/jobs/{job_id}", summary="State of an AI job (admin)")
async def api_ai_job(
    org_id: int,
    job_id: int,
    _admin=Depends(require_blog_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await jobs_service.get_job(db_session, org_id, job_id)


# ------------------------------------------------------------ admin: posts


@router.get("/{org_id}/posts", summary="List blog articles (admin)")
async def api_list_posts(
    request: Request,
    org_id: int,
    page: int = Query(1, ge=1, le=100000),
    limit: int = Query(20, ge=1, le=100),
    q: Optional[str] = Query(default=None),
    status: Optional[str] = Query(default=None),
    _admin=Depends(require_blog_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await posts_service.list_posts(db_session, request, org_id, page, limit, q, status)


@router.post("/{org_id}/posts", status_code=201, summary="Create a blog article (admin)")
async def api_create_post(
    request: Request,
    org_id: int,
    body: PostBody,
    admin=Depends(require_blog_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await posts_service.create_post(db_session, request, org_id, getattr(admin, "id", None), body)


@router.get("/{org_id}/posts/{post_id}", summary="One blog article (admin)")
async def api_get_post(
    request: Request,
    org_id: int,
    post_id: int,
    _admin=Depends(require_blog_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await posts_service.get_post(db_session, request, org_id, post_id)


@router.put("/{org_id}/posts/{post_id}", summary="Update a blog article (admin)")
async def api_update_post(
    request: Request,
    org_id: int,
    post_id: int,
    body: PostBody,
    _admin=Depends(require_blog_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await posts_service.update_post(db_session, request, org_id, post_id, body)


@router.delete("/{org_id}/posts/{post_id}", summary="Delete a blog article (admin)")
async def api_delete_post(
    org_id: int,
    post_id: int,
    _admin=Depends(require_blog_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await posts_service.delete_post(db_session, org_id, post_id)


@router.post("/{org_id}/posts/{post_id}/publish", summary="Publish a blog article (admin)")
async def api_publish_post(
    request: Request,
    org_id: int,
    post_id: int,
    _admin=Depends(require_blog_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await posts_service.publish_post(db_session, request, org_id, post_id)


@router.post("/{org_id}/posts/{post_id}/unpublish", summary="Unpublish a blog article (admin)")
async def api_unpublish_post(
    request: Request,
    org_id: int,
    post_id: int,
    _admin=Depends(require_blog_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await posts_service.unpublish_post(db_session, request, org_id, post_id)


@router.put("/{org_id}/posts/{post_id}/cover", summary="Upload the cover of a blog article (admin)")
async def api_set_cover(
    request: Request,
    org_id: int,
    post_id: int,
    file: Optional[UploadFile] = File(None),
    _admin=Depends(require_blog_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await covers_service.set_cover(db_session, request, org_id, post_id, file)


@router.delete("/{org_id}/posts/{post_id}/cover", summary="Remove the cover of a blog article (admin)")
async def api_remove_cover(
    request: Request,
    org_id: int,
    post_id: int,
    _admin=Depends(require_blog_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await covers_service.remove_cover(db_session, request, org_id, post_id)


@router.post("/{org_id}/posts/{post_id}/ai/revise", status_code=202, summary="Improve an article with AI (admin)")
async def api_ai_revise(
    org_id: int,
    post_id: int,
    body: ReviseBody,
    admin=Depends(require_blog_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await jobs_service.start_revise(db_session, org_id, getattr(admin, "id", None), post_id, body)

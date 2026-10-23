"""Sanar y Criar: playback/reading progress endpoints (mounted at /progress,
authenticated sessions only)."""

from typing import Optional

from fastapi import APIRouter, Depends, Request
from sqlmodel.ext.asyncio.session import AsyncSession

from src.core.events.database import get_db_session
from src.security.api_token_utils import get_authenticated_non_api_token_user
from src.security.features_utils.dependencies import require_courses_feature
from src.services.progress.progress import (
    ProgressBody,
    get_activity_progress,
    get_course_progress,
    save_activity_progress,
)

router = APIRouter(dependencies=[Depends(require_courses_feature)])


@router.put(
    "/activity/{activity_uuid}",
    summary="Save the playback/reading position of an activity",
    responses={402: {"description": "The course is for sale and not purchased"}},
)
async def api_save_activity_progress(
    request: Request,
    activity_uuid: str,
    body: ProgressBody,
    user=Depends(get_authenticated_non_api_token_user),
    db_session: AsyncSession = Depends(get_db_session),
) -> dict:
    return await save_activity_progress(request, db_session, user, activity_uuid, body)


@router.get("/activity/{activity_uuid}", summary="Saved position of one activity (or null)")
async def api_get_activity_progress(
    request: Request,
    activity_uuid: str,
    user=Depends(get_authenticated_non_api_token_user),
    db_session: AsyncSession = Depends(get_db_session),
) -> Optional[dict]:
    return await get_activity_progress(request, db_session, user, activity_uuid)


@router.get("/course/{course_uuid}", summary="Last position and per-activity progress in a course")
async def api_get_course_progress(
    request: Request,
    course_uuid: str,
    user=Depends(get_authenticated_non_api_token_user),
    db_session: AsyncSession = Depends(get_db_session),
) -> dict:
    return await get_course_progress(request, db_session, user, course_uuid)

"""Sanar y Criar: forget saved playback/reading positions.

Kept free of service imports so upstream modules (trail, admin) can import it
at module level without import cycles.
"""

from typing import Optional

from sqlmodel import delete
from sqlmodel.ext.asyncio.session import AsyncSession

from src.db.activity_progress import ActivityProgress


async def clear_progress(
    db_session: AsyncSession,
    user_id: int,
    *,
    course_id: Optional[int] = None,
    activity_id: Optional[int] = None,
    commit: bool = False,
) -> None:
    """Delete a learner's progress rows for a course and/or one activity.

    Without ``commit`` the delete joins the caller's transaction, so it lands
    (or rolls back) together with the TrailStep changes it accompanies.
    """
    if not user_id or (course_id is None and activity_id is None):
        return
    statement = delete(ActivityProgress).where(ActivityProgress.user_id == user_id)
    if course_id is not None:
        statement = statement.where(ActivityProgress.course_id == course_id)
    if activity_id is not None:
        statement = statement.where(ActivityProgress.activity_id == activity_id)
    await db_session.execute(statement)
    if commit:
        await db_session.commit()

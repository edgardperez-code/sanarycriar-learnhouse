"""Sanar y Criar: copy newsletter subscribers to Resend contacts.

The owner sends the newsletter from Resend Broadcasts, which adds the
unsubscribe link itself (``{{{RESEND_UNSUBSCRIBE_URL}}}``). Contacts are
global (``POST /contacts``, no audience); audiences are deprecated and are now
called "segments". ``LEARNHOUSE_NEWSLETTER_RESEND_SEGMENT_ID`` (optional) adds
each new contact to one segment.

Without Resend (SMTP provider or no API key, e.g. locally) nothing is synced:
rows stay ``skipped`` and the sign-up still succeeds. Nothing here ever raises
into a request, and logs carry the subscriber id only: never the e-mail
address nor the API key.

The public sign-up never waits for Resend: it answers once the row is saved
and ``schedule_sync`` copies it afterwards, with a database session of its own.
Every address therefore gets its answer just as fast (new, repeated or
already synced), and a slow Resend can neither make a saved sign-up look like
a failure on the site nor hold the request open.

The blocking SDK calls are thin module-level wrappers so tests can
monkeypatch them by name; callers must reach them through this module.
"""

import asyncio
import concurrent.futures
import logging
import os
from dataclasses import dataclass, field
from typing import Optional

import resend

from config.config import get_learnhouse_config
from src.services.payments.common import utcnow

logger = logging.getLogger(__name__)

# Per SDK call. The SDK's own HTTP timeout is 30 s and asyncio cannot stop a
# thread, so a hung call keeps its thread after ``wait_for`` gives up: the
# calls run on a small pool of their own instead of the default executor
# that the rest of the API (streaming, uploads, payments) shares.
RESEND_TIMEOUT_SECONDS = 5.0
RESEND_MAX_WORKERS = 4
SEGMENT_ENV_VAR = "LEARNHOUSE_NEWSLETTER_RESEND_SEGMENT_ID"

_executor = concurrent.futures.ThreadPoolExecutor(
    max_workers=RESEND_MAX_WORKERS, thread_name_prefix="sc-newsletter-resend"
)
# Strong references to the scheduled syncs (the loop only keeps weak ones).
_background: set = set()


@dataclass(frozen=True)
class ResendSettings:
    api_key: str = field(repr=False)
    segment_id: Optional[str]


def resend_settings() -> Optional[ResendSettings]:
    """Resend credentials when the platform sends mail through Resend, else ``None``."""
    try:
        mailing = get_learnhouse_config().mailing_config
    except Exception:
        logger.exception("Newsletter: could not read the mailing configuration")
        return None
    if getattr(mailing, "email_provider", None) != "resend":
        return None
    api_key = (getattr(mailing, "resend_api_key", None) or "").strip()
    if not api_key:
        return None
    segment_id = os.getenv(SEGMENT_ENV_VAR, "").strip() or None
    return ResendSettings(api_key=api_key, segment_id=segment_id)


def _contact_id_of(result) -> str:
    contact_id = result.get("id") if isinstance(result, dict) else getattr(result, "id", None)
    if not isinstance(contact_id, str) or not contact_id or len(contact_id) > 64:
        raise ValueError("Resend did not return a usable contact id")
    return contact_id


def _is_not_found(exc: BaseException) -> bool:
    return str(getattr(exc, "code", "")) == "404"


# ------------------------------------------------- blocking SDK wrappers


def _create_contact(api_key: str, email: str, segment_id: Optional[str]) -> str:
    resend.api_key = api_key
    # Sanar y Criar: no ``unsubscribed`` field. A new contact is subscribed
    # anyway, and should Resend treat the create of an existing address as an
    # upsert, sending ``unsubscribed: False`` would undo an earlier opt-out.
    params: dict = {"email": email}
    if segment_id:
        params["segments"] = [{"id": segment_id}]
    return _contact_id_of(resend.Contacts.create(params))


def _get_contact_id(api_key: str, email: str) -> Optional[str]:
    resend.api_key = api_key
    try:
        contact = resend.Contacts.get(email=email)
    except resend.exceptions.ResendError as exc:
        if _is_not_found(exc):
            return None
        raise
    return _contact_id_of(contact)


def _add_to_segment(api_key: str, email: str, segment_id: str) -> None:
    resend.api_key = api_key
    resend.Contacts.Segments.add({"segment_id": segment_id, "email": email})


def _remove_contact(api_key: str, contact_id: str) -> None:
    resend.api_key = api_key
    resend.Contacts.remove(id=contact_id)


async def _call(fn, *args):
    loop = asyncio.get_running_loop()
    return await asyncio.wait_for(loop.run_in_executor(_executor, fn, *args), RESEND_TIMEOUT_SECONDS)


# ------------------------------------------------------------ operations


async def sync_subscriber(db_session, subscriber, settings: ResendSettings) -> bool:
    """Create (or find) the subscriber's Resend contact and record the outcome.

    A contact that already existed in Resend is left as it is: in particular
    its ``unsubscribed`` flag is never reset, so an earlier opt-out made from
    a Resend e-mail is respected. Returns True when the row ends ``synced``.
    Never raises.
    """
    subscriber_id = getattr(subscriber, "id", None)
    try:
        email = subscriber.email
        contact_id: Optional[str] = None
        create_error: Optional[BaseException] = None
        try:
            contact_id = await _call(_create_contact, settings.api_key, email, settings.segment_id)
        except Exception as exc:
            create_error = exc
            # A create that timed out may still land in Resend, and a slow
            # Resend would keep the lookup waiting just as long: the row is
            # left in ``error`` and the next sync (create, then lookup) finds it.
            if not isinstance(exc, TimeoutError):
                try:
                    contact_id = await _call(_get_contact_id, settings.api_key, email)
                except Exception:
                    contact_id = None
            if contact_id and settings.segment_id:
                try:
                    await _call(_add_to_segment, settings.api_key, email, settings.segment_id)
                except Exception as segment_exc:
                    logger.warning(
                        "Newsletter: subscriber %s found in Resend but not added to the segment (%s)",
                        subscriber_id, type(segment_exc).__name__,
                    )

        if contact_id:
            subscriber.resend_contact_id = contact_id
            subscriber.sync_status = "synced"
            subscriber.sync_error = None
            subscriber.synced_at = utcnow()
        else:
            subscriber.sync_status = "error"
            subscriber.sync_error = f"{type(create_error).__name__}: {create_error}"[:300]
            logger.warning(
                "Newsletter: subscriber %s not synced to Resend (%s)",
                subscriber_id, type(create_error).__name__,
            )
        db_session.add(subscriber)
        try:
            await db_session.commit()
        except Exception:
            await db_session.rollback()
            logger.exception("Newsletter: could not save the Resend sync state of subscriber %s", subscriber_id)
            return False
        return bool(contact_id)
    except Exception:
        logger.exception("Newsletter: unexpected error syncing subscriber %s", subscriber_id)
        return False


async def remove_contact(settings: ResendSettings, contact_id: str) -> bool:
    """Delete a Resend contact. A contact that is already gone counts as removed.

    Never raises.
    """
    try:
        await _call(_remove_contact, settings.api_key, contact_id)
        return True
    except Exception as exc:
        if _is_not_found(exc):
            return True
        logger.warning("Newsletter: could not remove Resend contact %s (%s)", contact_id, type(exc).__name__)
        return False


async def remove_contact_by_email(settings: ResendSettings, email: str, subscriber_id=None) -> Optional[bool]:
    """Delete the Resend contact of an address whose contact id we never got.

    Sanar y Criar: a create that timed out may still have made the contact.
    Returns ``None`` when Resend has no such contact, True once it is removed
    and False when Resend could not be asked or refused. Never raises.
    """
    try:
        contact_id = await _call(_get_contact_id, settings.api_key, email)
    except Exception as exc:
        logger.warning(
            "Newsletter: could not look up the Resend contact of subscriber %s (%s)",
            subscriber_id, type(exc).__name__,
        )
        return False
    if not contact_id:
        return None
    return await remove_contact(settings, contact_id)


# ------------------------------------------------------- background sync


def _session_scope():
    """A database session of the sync's own: the request's one closes with it.

    Tests patch this to hand over their in-memory session.
    """
    from src.core.events.database import _async_session_factory

    return _async_session_factory()


async def _sync_in_background(subscriber_id: int, settings: ResendSettings) -> None:
    from src.db.newsletter.newsletter import NewsletterSubscriber

    try:
        async with _session_scope() as db_session:
            row = await db_session.get(NewsletterSubscriber, subscriber_id)
            # Deleted meanwhile, or already copied by another sync.
            if row is None or row.sync_status == "synced":
                return
            await sync_subscriber(db_session, row, settings)
    except Exception:
        logger.exception("Newsletter: background Resend sync of subscriber %s failed", subscriber_id)


def schedule_sync(subscriber_id: int, settings: ResendSettings) -> None:
    """Copy one subscriber to Resend after the response is sent. Never raises.

    If the process stops first, the row simply stays ``pending`` and the
    dashboard's "Sincronizar con Resend" picks it up.
    """
    try:
        task = asyncio.get_running_loop().create_task(_sync_in_background(subscriber_id, settings))
    except Exception:
        logger.exception("Newsletter: could not schedule the Resend sync of subscriber %s", subscriber_id)
        return
    _background.add(task)
    task.add_done_callback(_background.discard)


async def wait_for_background() -> None:
    """Wait until every sync scheduled on this loop has finished (tests use it)."""
    loop = asyncio.get_running_loop()
    while True:
        pending = [task for task in _background if task.get_loop() is loop and not task.done()]
        if not pending:
            return
        await asyncio.gather(*pending, return_exceptions=True)

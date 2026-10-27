"""Sanar y Criar: blog cover images.

Every upload is decoded and re-encoded with Pillow, which drops EXIF (GPS
included), XMP and colour profiles and anything that is not a picture. Two
files are kept per article, with new random names on every upload (the
public content route caches for a day):
- ``cover-{h}.webp``: at most 1600 px wide, for the article and its card;
- ``og-{h}.jpg``: 1200×630 centred crop for social cards (``og:image``).

They live in ``content/orgs/{org_uuid}/blog/{post_uuid}/``, which the content
route serves publicly (the names are unguessable, so a draft's cover is only
reachable by whoever knows its URL).

Storage goes through ``_store`` / ``_remove_file`` only; tests patch both by
name, so this module always calls them through its own globals.
"""

import asyncio
import io
import logging
import math
import os
import shutil
import threading
from typing import Optional
from uuid import uuid4

from fastapi import HTTPException, Request, UploadFile
from PIL import ExifTags, Image, ImageOps, UnidentifiedImageError
from sqlmodel.ext.asyncio.session import AsyncSession

from src.services.blog import posts
from src.services.blog.common import check_rate
from src.services.payments.common import get_org_or_404, utcnow

log = logging.getLogger(__name__)

MAX_COVER_BYTES = 5 * 1024 * 1024
# A few MB of PNG can hold a huge, flat picture: 25 MP is at most ~100 MB once
# decoded (RGBA), and one cover is processed at a time (``_PROCESSING``).
MAX_PIXELS = 25_000_000
COVER_MAX_WIDTH = 1600
OG_SIZE = (1200, 630)
ALLOWED_FORMATS = {"JPEG", "PNG", "WEBP"}

NO_IMAGE = "No se recibió ninguna imagen."
TOO_HEAVY = "La imagen pesa más de 5 MB."
WRONG_FORMAT = "La portada debe ser una imagen JPG, PNG o WebP."
TOO_LARGE = "La imagen es demasiado grande (máximo 25 megapíxeles)."
UNREADABLE = "No se pudo leer la imagen."

# Concurrent uploads wait for their turn (in their worker thread) instead of
# decoding several large images at once.
_PROCESSING = threading.Lock()


def _unsupported(detail: str) -> HTTPException:
    return HTTPException(status_code=415, detail=detail)


def _has_alpha(img: Image.Image) -> bool:
    return img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info)


def _working_size(img: Image.Image) -> Optional[tuple[int, int]]:
    """The smallest size (in the file's own orientation) both outputs can be made from; ``None`` = as is.

    The cover needs at most 1600 px of width and the social card a 1200×630
    crop, so nothing above the larger of the two scales is ever used.
    """
    width, height = img.size
    try:
        turned = img.getexif().get(ExifTags.Base.Orientation) in (5, 6, 7, 8)
    except Exception:
        turned = False
    upright_width, upright_height = (height, width) if turned else (width, height)
    scale = max(
        min(1.0, COVER_MAX_WIDTH / upright_width),
        min(1.0, max(OG_SIZE[0] / upright_width, OG_SIZE[1] / upright_height)),
    )
    if scale >= 1.0:
        return None
    return max(1, math.ceil(width * scale)), max(1, math.ceil(height * scale))


def process_cover(data: bytes) -> tuple[bytes, bytes]:
    """``(webp_cover, og_jpeg)`` re-encoded from the uploaded bytes, without metadata.

    Blocking: callers run it with ``asyncio.to_thread``; one image is
    processed at a time. Raises a 415 ``HTTPException`` for anything that is
    not a usable JPG/PNG/WebP.
    """
    with _PROCESSING:
        return _process_cover(data)


def _process_cover(data: bytes) -> tuple[bytes, bytes]:
    try:
        # Only these decoders are tried: anything else is not even parsed.
        img = Image.open(io.BytesIO(data), formats=sorted(ALLOWED_FORMATS))
    except Image.DecompressionBombError:
        raise _unsupported(TOO_LARGE)
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError):
        raise _unsupported(WRONG_FORMAT)

    with img:
        if img.format not in ALLOWED_FORMATS:
            raise _unsupported(WRONG_FORMAT)
        width, height = img.size
        if width <= 0 or height <= 0 or width * height > MAX_PIXELS:
            raise _unsupported(TOO_LARGE)
        try:
            img.seek(0)  # first frame of an animated PNG/WebP
            working = img
            if img.mode not in ("RGB", "RGBA", "L", "LA", "CMYK"):
                # Palette, 1-bit and 16-bit pictures do not resize smoothly: RGB(A) first.
                working = img.convert("RGBA" if _has_alpha(img) else "RGB")
            size = _working_size(img)
            if size is not None:
                # Shrink first, in place: a JPEG is decoded straight at 1/2, 1/4
                # or 1/8 of its size (draft) and the full-size pixels are dropped.
                working.thumbnail(size, Image.Resampling.LANCZOS)
            working.load()
            upright = ImageOps.exif_transpose(working)
        except Image.DecompressionBombError:
            raise _unsupported(TOO_LARGE)
        except Exception:
            raise _unsupported(UNREADABLE)

    alpha = _has_alpha(upright)
    try:
        cover = upright.convert("RGBA" if alpha else "RGB")
        if cover.width > COVER_MAX_WIDTH:
            new_height = max(1, round(cover.height * COVER_MAX_WIDTH / cover.width))
            cover = cover.resize((COVER_MAX_WIDTH, new_height), Image.Resampling.LANCZOS)
        cover.info = {}

        if alpha:
            rgba = upright.convert("RGBA")
            flat = Image.new("RGB", rgba.size, (255, 255, 255))
            flat.paste(rgba, mask=rgba.getchannel("A"))
        else:
            flat = upright.convert("RGB")
        og = ImageOps.fit(flat, OG_SIZE, method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
        og.info = {}

        cover_buffer = io.BytesIO()
        cover.save(cover_buffer, format="WEBP", quality=82, method=6)
        og_buffer = io.BytesIO()
        og.save(og_buffer, format="JPEG", quality=85, optimize=True, progressive=True)
    except HTTPException:
        raise
    except Exception:
        raise _unsupported(UNREADABLE)
    return cover_buffer.getvalue(), og_buffer.getvalue()


# ------------------------------------------------------------------ storage


def _content_type() -> str:
    from config.config import get_learnhouse_config

    return get_learnhouse_config().hosting_config.content_delivery.type


async def _store(org_uuid: str, post_uuid: str, filename: str, data: bytes) -> None:
    from src.services.utils.upload_content import upload_content

    await upload_content(
        directory=f"blog/{post_uuid}",
        type_of_dir="orgs",
        uuid=org_uuid,
        file_binary=data,
        file_and_format=filename,
    )


def _remove_file_sync(org_uuid: str, post_uuid: str, filename: str) -> None:
    if _content_type() == "s3api":
        from src.services.courses.transfer.storage_utils import delete_storage_file

        delete_storage_file(f"content/orgs/{org_uuid}/blog/{post_uuid}/{filename}")
        return
    from src.services.utils.upload_content import _safe_content_path

    path = _safe_content_path("orgs", org_uuid, f"blog/{post_uuid}", filename)
    if os.path.isfile(path):
        os.remove(path)


async def _remove_file(org_uuid: str, post_uuid: str, filename: str) -> None:
    """Delete one stored file. Best effort: never raises."""
    try:
        await asyncio.to_thread(_remove_file_sync, org_uuid, post_uuid, filename)
    except Exception as exc:
        log.warning("[blog] could not delete cover file of post %s (%s)", post_uuid, type(exc).__name__)


def _remove_post_dir_sync(org_uuid: str, post_uuid: str) -> None:
    if _content_type() != "filesystem":
        log.info("[blog] post %s deleted; its cover files stay in object storage", post_uuid)
        return
    from src.services.utils.upload_content import _safe_content_path

    path = _safe_content_path("orgs", org_uuid, "blog", post_uuid)
    if os.path.isdir(path):
        shutil.rmtree(path, ignore_errors=True)


async def remove_post_files(org_uuid: str, post_uuid: str) -> None:
    """Delete the article's folder (local filesystem only). Best effort: never raises."""
    try:
        await asyncio.to_thread(_remove_post_dir_sync, org_uuid, post_uuid)
    except Exception as exc:
        log.warning("[blog] could not delete the files of post %s (%s)", post_uuid, type(exc).__name__)


# --------------------------------------------------------------- endpoints


async def set_cover(
    db_session: AsyncSession, request: Request, org_id: int, post_id: int, file: Optional[UploadFile]
) -> dict:
    """Replace the article's cover; returns ``AdminPost``."""
    check_rate(
        f"sc_blog_cover:{org_id}", 30, 3600, "Subiste demasiadas imágenes. Espera un momento e inténtalo de nuevo."
    )
    org = await get_org_or_404(db_session, org_id)
    post = await posts.get_post_or_404(db_session, org_id, post_id)
    if file is None:
        raise HTTPException(status_code=400, detail=NO_IMAGE)
    data = await file.read(MAX_COVER_BYTES + 1)
    if not data:
        raise HTTPException(status_code=400, detail=NO_IMAGE)
    if len(data) > MAX_COVER_BYTES:
        raise HTTPException(status_code=413, detail=TOO_HEAVY)

    cover_bytes, og_bytes = await asyncio.to_thread(process_cover, data)
    token = uuid4().hex[:12]
    cover_name = f"cover-{token}.webp"
    og_name = f"og-{token}.jpg"
    await _store(org.org_uuid, post.post_uuid, cover_name, cover_bytes)
    try:
        await _store(org.org_uuid, post.post_uuid, og_name, og_bytes)
    except Exception:
        await _remove_file(org.org_uuid, post.post_uuid, cover_name)
        raise

    previous = [name for name in (post.cover_image, post.og_image) if name]
    post.cover_image = cover_name
    post.og_image = og_name
    post.update_date = utcnow()
    db_session.add(post)
    await db_session.commit()
    await db_session.refresh(post)
    for name in previous:
        await _remove_file(org.org_uuid, post.post_uuid, name)
    return posts.admin_post(org, post, request)


async def remove_cover(db_session: AsyncSession, request: Request, org_id: int, post_id: int) -> dict:
    """Remove the article's cover; returns ``AdminPost``."""
    org = await get_org_or_404(db_session, org_id)
    post = await posts.get_post_or_404(db_session, org_id, post_id)
    previous = [name for name in (post.cover_image, post.og_image) if name]
    if previous:
        post.cover_image = None
        post.og_image = None
        post.update_date = utcnow()
        db_session.add(post)
        await db_session.commit()
        await db_session.refresh(post)
        for name in previous:
            await _remove_file(org.org_uuid, post.post_uuid, name)
    return posts.admin_post(org, post, request)

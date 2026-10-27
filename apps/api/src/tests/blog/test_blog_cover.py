"""Sanar y Criar: blog cover upload (re-encoding, metadata stripping, limits, replacement)."""

import io

import pytest
from PIL import Image

from src.services.blog import covers
from src.tests.blog.conftest import BASE, create_post


def _jpeg_with_exif(size=(2000, 1000), orientation=None) -> bytes:
    img = Image.new("RGB", size, (200, 120, 90))
    exif = Image.Exif()
    exif[0x010F] = "Camara de prueba"  # Make
    exif[0x0131] = "Software de prueba"  # Software
    if orientation is not None:
        exif[0x0112] = orientation
    gps = exif.get_ifd(0x8825)
    gps[1] = "N"
    gps[2] = (10.0, 12.0, 30.0)
    buffer = io.BytesIO()
    img.save(buffer, format="JPEG", exif=exif, quality=90)
    return buffer.getvalue()


def _image_bytes(fmt: str, size=(300, 200), mode="RGB", **save) -> bytes:
    img = Image.new(mode, size, (10, 20, 30, 0) if mode == "RGBA" else (10, 20, 30) if mode == "RGB" else 0)
    buffer = io.BytesIO()
    img.save(buffer, format=fmt, **save)
    return buffer.getvalue()


async def _upload(client, post_id, data, name="portada.jpg", content_type="image/jpeg"):
    return await client.put(f"{BASE}/posts/{post_id}/cover", files={"file": (name, data, content_type)})


def _open(storage, prefix) -> Image.Image:
    (key,) = [k for k in storage.files if k.rsplit("/", 1)[1].startswith(prefix)]
    return Image.open(io.BytesIO(storage.files[key]))


class TestCoverUpload:
    async def test_jpeg_with_exif_is_reencoded_without_metadata(self, admin_client, storage):
        created = await create_post(admin_client)
        source = _jpeg_with_exif()
        assert Image.open(io.BytesIO(source)).getexif()  # the source really has EXIF

        response = await _upload(admin_client, created["id"], source)
        assert response.status_code == 200, response.text
        post = response.json()

        names = storage.names()
        assert len(names) == 2
        cover_name = next(n for n in names if n.startswith("cover-"))
        og_name = next(n for n in names if n.startswith("og-"))
        assert cover_name.endswith(".webp") and len(cover_name) == len("cover-") + 12 + len(".webp")
        assert og_name == cover_name.replace("cover-", "og-").replace(".webp", ".jpg")
        assert all(k.startswith(f"org_test/{created['post_uuid']}/") for k in storage.files)

        cover = _open(storage, "cover-")
        assert cover.format == "WEBP"
        assert cover.size == (1600, 800)
        assert "exif" not in cover.info and not cover.getexif()
        og = _open(storage, "og-")
        assert og.format == "JPEG"
        assert og.size == (1200, 630)
        assert "exif" not in og.info and not og.getexif()

        assert post["cover_url"].startswith("http")
        assert post["cover_url"].endswith(f"/content/orgs/org_test/blog/{created['post_uuid']}/{cover_name}")
        assert post["og_image_url"].endswith(f"/{og_name}")
        public_post = (await admin_client.get(f"{BASE}/posts/{created['id']}")).json()
        assert public_post["cover_url"] == post["cover_url"]

    async def test_exif_orientation_is_applied(self, admin_client, storage):
        created = await create_post(admin_client)
        # Orientation 6 = rotate 90°: a 400×200 photo is shown as 200×400.
        response = await _upload(admin_client, created["id"], _jpeg_with_exif(size=(400, 200), orientation=6))
        assert response.status_code == 200
        assert _open(storage, "cover-").size == (200, 400)

    async def test_png_with_alpha_keeps_it_in_webp_and_flattens_the_og(self, admin_client, storage):
        created = await create_post(admin_client)
        data = _image_bytes("PNG", mode="RGBA")
        response = await _upload(admin_client, created["id"], data, name="logo.png", content_type="image/png")
        assert response.status_code == 200
        cover = _open(storage, "cover-")
        assert cover.mode == "RGBA" and cover.size == (300, 200)
        og = _open(storage, "og-")
        assert og.mode == "RGB" and og.size == (1200, 630)
        assert og.getpixel((600, 315)) == (255, 255, 255)

    async def test_webp_is_accepted(self, admin_client, storage):
        created = await create_post(admin_client)
        response = await _upload(admin_client, created["id"], _image_bytes("WEBP"), "a.webp", "image/webp")
        assert response.status_code == 200

    async def test_replacing_deletes_the_previous_files(self, admin_client, storage):
        created = await create_post(admin_client)
        first = (await _upload(admin_client, created["id"], _jpeg_with_exif(size=(800, 600)))).json()
        first_names = storage.names()
        second = (await _upload(admin_client, created["id"], _jpeg_with_exif(size=(800, 600)))).json()
        assert second["cover_url"] != first["cover_url"]
        assert sorted(key.rsplit("/", 1)[1] for key in storage.removed) == first_names
        assert len(storage.files) == 2 and not set(storage.names()) & set(first_names)

    async def test_delete_cover(self, admin_client, storage):
        created = await create_post(admin_client)
        await _upload(admin_client, created["id"], _jpeg_with_exif(size=(800, 600)))
        names = storage.names()
        response = await admin_client.delete(f"{BASE}/posts/{created['id']}/cover")
        assert response.status_code == 200
        data = response.json()
        assert data["cover_url"] is None and data["og_image_url"] is None
        assert storage.files == {}
        assert sorted(key.rsplit("/", 1)[1] for key in storage.removed) == names
        # Deleting again is harmless.
        assert (await admin_client.delete(f"{BASE}/posts/{created['id']}/cover")).status_code == 200


class TestCoverMemory:
    @pytest.mark.parametrize("size,orientation,expected", [
        ((800, 600), None, None),  # small: kept as is
        ((3200, 2400), None, (1600, 1200)),  # the cover's 1600 px of width rule
        ((8000, 1000), None, (5040, 630)),  # panorama: the social card needs 630 px of height
        ((4000, 2000), 6, (3200, 1600)),  # shown turned: 2000 px wide once upright
    ])
    def test_working_size(self, size, orientation, expected):
        class Picture:  # only the size and the EXIF orientation matter here
            def __init__(self):
                self.size = size

            def getexif(self):
                return {0x0112: orientation} if orientation else {}

        assert covers._working_size(Picture()) == expected

    def test_a_large_jpeg_is_decoded_reduced(self, monkeypatch):
        from PIL import JpegImagePlugin

        drafts = []
        original = JpegImagePlugin.JpegImageFile.draft

        def spy(self, mode, size):
            result = original(self, mode, size)
            drafts.append(self.size)
            return result

        monkeypatch.setattr(JpegImagePlugin.JpegImageFile, "draft", spy)
        cover, og = covers.process_cover(_jpeg_with_exif(size=(6400, 3600)))
        assert drafts and drafts[-1] == (3200, 1800)  # decoded at half size, never at 6400×3600
        assert Image.open(io.BytesIO(cover)).size == (1600, 900)
        assert Image.open(io.BytesIO(og)).size == (1200, 630)

    def test_palette_png_is_resized_smoothly(self):
        data = _image_bytes("PNG", size=(3200, 1600), mode="P")
        cover, og = covers.process_cover(data)
        assert Image.open(io.BytesIO(cover)).size == (1600, 800)
        assert Image.open(io.BytesIO(og)).size == (1200, 630)

    def test_one_image_at_a_time(self, monkeypatch):
        import threading
        import time

        state = {"now": 0, "max": 0}
        guard = threading.Lock()

        def slow(data):
            with guard:
                state["now"] += 1
                state["max"] = max(state["max"], state["now"])
            time.sleep(0.05)
            with guard:
                state["now"] -= 1
            return b"c", b"o"

        monkeypatch.setattr(covers, "_process_cover", slow)
        threads = [threading.Thread(target=covers.process_cover, args=(b"x",)) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert state["max"] == 1


class TestCoverErrors:
    @pytest.mark.parametrize("data,name,content_type", [
        (_image_bytes("GIF", mode="P"), "anim.gif", "image/gif"),
        (b"<svg xmlns='http://www.w3.org/2000/svg'></svg>", "dibujo.svg", "image/svg+xml"),
        (b"esto es texto, no una imagen" * 10, "falsa.jpg", "image/jpeg"),
        (_image_bytes("BMP"), "viejo.bmp", "image/bmp"),
    ])
    async def test_not_jpg_png_webp_is_415(self, admin_client, storage, data, name, content_type):
        created = await create_post(admin_client)
        response = await _upload(admin_client, created["id"], data, name, content_type)
        assert response.status_code == 415
        assert response.json()["detail"] == "La portada debe ser una imagen JPG, PNG o WebP."
        assert storage.files == {}

    async def test_too_heavy_is_413(self, admin_client, storage):
        created = await create_post(admin_client)
        response = await _upload(admin_client, created["id"], b"\xff" * (5 * 1024 * 1024 + 1))
        assert response.status_code == 413
        assert response.json()["detail"] == "La imagen pesa más de 5 MB."

    @pytest.mark.parametrize("size", [(7000, 6000), (6000, 4200)])
    async def test_too_many_pixels_is_415(self, admin_client, storage, size):
        created = await create_post(admin_client)
        data = _image_bytes("PNG", size=size, mode="1")
        assert len(data) < covers.MAX_COVER_BYTES
        response = await _upload(admin_client, created["id"], data, "grande.png", "image/png")
        assert response.status_code == 415
        assert response.json()["detail"] == "La imagen es demasiado grande (máximo 25 megapíxeles)."

    async def test_truncated_image_is_unreadable(self, admin_client, storage):
        created = await create_post(admin_client)
        data = _jpeg_with_exif(size=(800, 600))
        response = await _upload(admin_client, created["id"], data[: len(data) // 2])
        assert response.status_code == 415
        assert response.json()["detail"] == "No se pudo leer la imagen."

    async def test_missing_or_empty_file_is_400(self, admin_client, storage):
        created = await create_post(admin_client)
        missing = await admin_client.put(f"{BASE}/posts/{created['id']}/cover")
        assert missing.status_code == 400
        assert missing.json()["detail"] == "No se recibió ninguna imagen."
        empty = await _upload(admin_client, created["id"], b"")
        assert empty.status_code == 400
        assert empty.json()["detail"] == "No se recibió ninguna imagen."

    async def test_unknown_post_is_404(self, admin_client, storage):
        response = await _upload(admin_client, 999, _jpeg_with_exif(size=(100, 100)))
        assert response.status_code == 404
        assert storage.files == {}

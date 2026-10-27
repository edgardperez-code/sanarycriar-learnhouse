"""Sanar y Criar: the blog's Claude client (request shape, answers, errors, cleanup), with a fake SDK."""

import logging
import re

import anthropic
import httpx2
import pytest

from src.services.blog import ai
from src.services.blog.ai import BlogAIError, GeneratedArticle, GenerateParams
from src.services.blog.render import render_markdown
from src.tests.blog.conftest import article_json

SECRET_PROMPT = "SECRETO-PROMPT-7731 sobre mi hija Ana"
SECRET_FACTS = "SECRETO-DATOS-5512 sábado 15 en Lechería https://inscripcion.example.com/taller."


def params(**overrides) -> GenerateParams:
    values = {
        "prompt": SECRET_PROMPT, "kind": "informativo", "audience": "familias", "length": "medio",
        "keyword": "", "facts": SECRET_FACTS,
    }
    values.update(overrides)
    return GenerateParams(**values)


def _request() -> httpx2.Request:
    return httpx2.Request("POST", "https://api.anthropic.com/v1/messages")


def _status_error(cls, status: int):
    response = httpx2.Response(status, request=_request(), headers={"request-id": "req_test_1"})
    return cls("error del proveedor", response=response, body=None)


class TestRequest:
    async def test_request_shape(self, fake_claude):
        result = await ai.generate_article(params())
        assert len(fake_claude.calls) == 1
        call = fake_claude.calls[0]
        assert call["model"] == "claude-opus-5-5"
        assert call["max_tokens"] == ai.MAX_TOKENS
        assert call["thinking"] == {"type": "adaptive"}
        assert call["output_config"]["effort"] == "medium"
        assert call["output_config"]["format"]["type"] == "json_schema"
        assert call["output_config"]["format"]["schema"] is ai.ARTICLE_SCHEMA
        assert call["system"][0]["cache_control"] == {"type": "ephemeral"}
        assert call["system"][0]["text"] == ai.SYSTEM_PROMPT
        assert call["betas"] == [ai.FALLBACK_BETA] == ["server-side-fallback-2026-07-01"]
        assert call["fallbacks"] == "default"
        for forbidden in ("temperature", "top_p", "top_k", "output_format"):
            assert forbidden not in call
        assert call["messages"][0]["role"] == "user"
        assert SECRET_PROMPT in call["messages"][0]["content"]

        assert result.model == "claude-opus-5-5"
        assert result.usage == {
            "input_tokens": 1200, "output_tokens": 900, "cache_read_input_tokens": 1000,
            "cache_creation_input_tokens": 0,
        }
        assert result.article.slug == "miedo-a-la-oscuridad"

    async def test_model_without_fallback(self, fake_claude, monkeypatch):
        monkeypatch.setenv("SC_BLOG_AI_MODEL", "claude-haiku-5-5")
        await ai.generate_article(params())
        call = fake_claude.calls[0]
        assert call["model"] == "claude-haiku-5-5"
        assert "betas" not in call and "fallbacks" not in call

    def test_schema_and_system_prompt(self):
        assert ai.ARTICLE_SCHEMA["additionalProperties"] is False
        assert set(ai.ARTICLE_SCHEMA["required"]) == set(ai.ARTICLE_FIELDS)
        assert ai.ARTICLE_SCHEMA["properties"]["category"]["enum"] == [
            "emociones", "limites-y-conducta", "sueno-y-rutinas", "crianza-y-familia", "talleres-y-novedades",
        ]
        assert ai.SYSTEM_PROMPT.startswith("Eres la redactora del blog de Sanar y Criar")
        assert ai.SYSTEM_PROMPT.endswith("sin mencionar la indicación original.")
        for path, _ in ai.INTERNAL_LINKS:
            assert f"  - {path}: " in ai.SYSTEM_PROMPT
        assert (
            "- Nunca menciones nombres ni datos de pacientes o de sus familias aunque aparezcan en la "
            "indicación, en los datos o en el artículo que revisas.\n"
        ) in ai.SYSTEM_PROMPT
        # Nothing that changes between requests (it is the cached prefix).
        assert not re.search(r"20\d\d-\d\d-\d\d", ai.SYSTEM_PROMPT)

    def test_generate_message(self):
        text = ai.build_generate_message(params(
            prompt='Tema con """comillas""" triples', kind="taller", length="corto", keyword="rabietas", facts="",
        ))
        assert text.startswith("Escribe un artículo nuevo para el blog.\n\nTipo: taller (presentación de un taller que dicta Hilda)\n")
        assert "Público: madres, padres y cuidadores\n" in text
        assert "Extensión de content_md: entre 700 y 900 palabras.\n" in text
        assert "Palabra clave principal: rabietas\n" in text
        assert 'Tema con “““comillas“““ triples' in text
        assert text.endswith('única fuente de fechas, horarios, lugar, modalidad, precio, cupos y enlaces):\n"""\nSin datos.\n"""')
        default_keyword = ai.build_generate_message(params())
        assert "Palabra clave principal: elige la más natural para el tema\n" in default_keyword

    def test_revise_message(self):
        article = GeneratedArticle.model_validate_json(article_json())
        text = ai.build_revise_message(article, "informativo", "Hazlo más breve")
        words = render_markdown(article.content_md).word_count
        assert text.startswith("Revisa este artículo del blog siguiendo la instrucción de Hilda y devuelve el artículo completo.\n")
        assert f"Extensión actual de content_md: {words} palabras" in text
        assert article.model_dump_json() in text
        assert text.endswith('Instrucción de Hilda:\n"""\nHazlo más breve\n"""')


class TestAnswers:
    async def test_refusal(self, fake_claude):
        fake_claude.stop_reason = "refusal"
        with pytest.raises(BlogAIError) as exc:
            await ai.generate_article(params())
        assert str(exc.value) == (
            "La IA no pudo escribir sobre este tema. Reformula la indicación "
            "(sin datos personales y dentro del enfoque del blog)."
        )

    async def test_max_tokens(self, fake_claude):
        fake_claude.stop_reason = "max_tokens"
        with pytest.raises(BlogAIError, match="El artículo quedó demasiado largo y se cortó. Pide una extensión menor."):
            await ai.generate_article(params())

    @pytest.mark.parametrize("text", ["{no es json", "", '{"title": "solo título"}', article_json(category="otra")])
    async def test_invalid_or_incomplete_json(self, fake_claude, text):
        fake_claude.text = text
        with pytest.raises(BlogAIError) as exc:
            await ai.generate_article(params())
        assert str(exc.value) == "La respuesta de la IA llegó incompleta. Intenta de nuevo."

    async def test_revise_uses_the_same_call(self, fake_claude):
        article = GeneratedArticle.model_validate_json(article_json())
        result = await ai.revise_article(article, "informativo", "Hazlo más breve")
        assert result.article.title == article.title
        assert "Instrucción de Hilda" in fake_claude.calls[0]["messages"][0]["content"]


class TestErrors:
    @pytest.mark.parametrize("error,message", [
        (lambda: anthropic.APITimeoutError(request=_request()),
         "La IA tardó demasiado en responder. Intenta de nuevo o pide una extensión menor."),
        (lambda: TimeoutError(),
         "La IA tardó demasiado en responder. Intenta de nuevo o pide una extensión menor."),
        (lambda: anthropic.APIConnectionError(request=_request()),
         "No se pudo conectar con la IA. Revisa la conexión del servidor e intenta de nuevo."),
        (lambda: _status_error(anthropic.AuthenticationError, 401),
         "La clave de la IA (ANTHROPIC_API_KEY) no es válida. Revísala en el servidor."),
        (lambda: _status_error(anthropic.PermissionDeniedError, 403),
         "La clave de la IA no tiene permiso para usar este modelo."),
        (lambda: _status_error(anthropic.NotFoundError, 404),
         "El modelo de IA configurado no existe o no está disponible."),
        (lambda: _status_error(anthropic.RateLimitError, 429),
         "La IA está ocupada en este momento. Intenta de nuevo en unos minutos."),
        (lambda: _status_error(anthropic.BadRequestError, 400),
         "La IA rechazó la solicitud. Intenta de nuevo; si se repite, avisa al equipo técnico."),
        (lambda: _status_error(anthropic.InternalServerError, 529),
         "La IA respondió con un error (529). Intenta de nuevo en unos minutos."),
    ])
    async def test_sdk_errors_become_spanish_messages(self, fake_claude, error, message):
        fake_claude.error = error()
        with pytest.raises(BlogAIError) as exc:
            await ai.generate_article(params())
        assert str(exc.value) == message

    async def test_logs_never_carry_the_owner_texts(self, fake_claude, caplog):
        caplog.set_level(logging.DEBUG)
        await ai.generate_article(params())
        fake_claude.error = _status_error(anthropic.BadRequestError, 400)
        with pytest.raises(BlogAIError):
            await ai.generate_article(params())
        fake_claude.error = None
        fake_claude.text = "{roto"
        with pytest.raises(BlogAIError):
            await ai.generate_article(params())
        assert "[blog-ia] model=claude-opus-5-5 stop=end_turn in=1200 out=900 cache_read=1000" in caplog.text
        assert "req_test_1" in caplog.text
        for secret in ("SECRETO-PROMPT-7731", "SECRETO-DATOS-5512", "mi hija", "Texto del artículo"):
            assert secret not in caplog.text


class TestPrivacy:
    @pytest.fixture
    def sdk_loggers(self):
        loggers = [logging.getLogger(name) for name in ("anthropic", "httpx2")]
        levels = [logger.level for logger in loggers]
        yield loggers
        for logger, level in zip(loggers, levels):
            logger.setLevel(level)

    def test_sdk_loggers_never_debug_with_a_debug_root(self, sdk_loggers, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_LOG", raising=False)
        # Already done at import time (LEARNHOUSE_LOG_LEVEL=DEBUG only lowers the root logger).
        assert all(logger.level == logging.INFO for logger in sdk_loggers)
        for logger in sdk_loggers:
            logger.setLevel(logging.NOTSET)
        ai.quiet_sdk_loggers()
        assert all(not logger.isEnabledFor(logging.DEBUG) for logger in sdk_loggers)
        # A stricter level chosen elsewhere is kept.
        sdk_loggers[0].setLevel(logging.WARNING)
        ai.quiet_sdk_loggers()
        assert sdk_loggers[0].level == logging.WARNING

    def test_anthropic_log_debug_is_respected(self, sdk_loggers, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_LOG", "debug")
        for logger in sdk_loggers:
            logger.setLevel(logging.DEBUG)
        ai.quiet_sdk_loggers()
        assert all(logger.level == logging.DEBUG for logger in sdk_loggers)

    @pytest.mark.parametrize("url,transaction", [
        ("http://api.test/api/v1/blog/1/ai/generate", "/api/v1/blog/{org_id}/ai/generate"),
        ("http://api.test/api/v1/blog/1/posts/7/ai/revise", "/api/v1/blog/{org_id}/posts/{post_id}/ai/revise"),
        ("", "/api/v1/blog/{org_id}/ai/generate"),
    ])
    def test_sentry_events_of_ai_routes_lose_body_and_variables(self, url, transaction):
        event = {
            "transaction": transaction,
            "request": {"url": url, "method": "POST", "data": {"prompt": SECRET_PROMPT}},
            "exception": {"values": [{"stacktrace": {"frames": [
                {"module": "src.routers.blog", "vars": {"body": SECRET_PROMPT}},
                {"module": "fastapi.routing", "vars": {"values": SECRET_FACTS}},
            ]}}]},
        }
        scrubbed = ai.scrub_sentry_event(event)
        assert scrubbed["request"]["data"] == "[Filtered]"
        assert scrubbed["request"]["method"] == "POST"
        assert all("vars" not in frame for frame in scrubbed["exception"]["values"][0]["stacktrace"]["frames"])
        assert "SECRETO" not in repr(scrubbed)

    def test_sentry_events_elsewhere_keep_their_data_but_not_ai_frames(self):
        event = {
            "transaction": "/api/v1/blog/{org_id}/posts",
            "request": {"url": "http://api.test/api/v1/blog/1/posts", "data": {"title": "Hola"}},
            "threads": {"values": [{"stacktrace": {"frames": [
                {"module": "src.services.blog.jobs", "vars": {"instruction": SECRET_PROMPT}},
                {"module": "src.services.blog.posts", "vars": {"page": 1}},
            ]}}]},
        }
        scrubbed = ai.scrub_sentry_event(event)
        assert scrubbed["request"]["data"] == {"title": "Hola"}
        frames = scrubbed["threads"]["values"][0]["stacktrace"]["frames"]
        assert "vars" not in frames[0] and frames[1]["vars"] == {"page": 1}
        # Odd shapes never break the event.
        assert ai.scrub_sentry_event({"request": "x", "exception": {"values": [None]}}) == {
            "request": "x", "exception": {"values": [None]},
        }


class TestConfiguration:
    def test_ai_configured(self, monkeypatch):
        assert ai.ai_configured() is False
        monkeypatch.setenv("ANTHROPIC_API_KEY", "   ")
        assert ai.ai_configured() is False
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
        assert ai.ai_configured() is True
        monkeypatch.delenv("ANTHROPIC_API_KEY")
        monkeypatch.setenv("SC_BLOG_AI_MOCK", "true")
        assert ai.ai_configured() is False and ai.mock_enabled() is False
        monkeypatch.setenv("SC_BLOG_AI_MOCK", "1")
        assert ai.ai_configured() is True and ai.mock_enabled() is True

    def test_model_id(self, monkeypatch):
        assert ai.model_id() == "claude-opus-5-5"
        monkeypatch.setenv("SC_BLOG_AI_MODEL", "  ")
        assert ai.model_id() == "claude-opus-5-5"
        monkeypatch.setenv("SC_BLOG_AI_MODEL", "claude-sonnet-5-5")
        assert ai.model_id() == "claude-sonnet-5-5"

    async def test_mock_never_calls_the_sdk(self, mock_ai):
        result = await ai.generate_article(params())
        assert result.model == "mock" and result.usage == {}
        revised = await ai.revise_article(result.article, "informativo", "Más breve")
        assert revised.article.summary.startswith("Resumen revisado en modo de prueba:")
        assert revised.article.slug == result.article.slug


class TestMockArticles:
    def test_informative_mock(self):
        article = ai.mock_article(params())
        assert article.title == "Rabietas en la primera infancia: cómo acompañarlas sin perder la calma"
        assert article.slug == "rabietas-primera-infancia-acompanar-con-calma"
        assert article.category == "emociones"
        assert render_markdown(article.content_md).word_count >= 350
        sections = re.findall(r"^## (.+)$", article.content_md, re.M)
        assert len(sections) == 4 and sections[-1] == "¿Cuándo consultar?"
        assert any(s.startswith("¿") for s in sections[:-1])
        assert "](/agenda)" in article.content_md and "](/test-de-crianza)" in article.content_md
        assert (len(article.key_takeaways), len(article.faq), len(article.keywords)) == (4, 3, 5)
        assert 140 <= len(article.meta_description) <= 155
        # It survives the same cleanup as a real answer.
        fields = ai.normalize_generated(article, kind="informativo", allowed_external=set())
        assert fields["content_md"] == article.content_md

    def test_workshop_mock_with_and_without_facts(self):
        with_facts = ai.mock_article(params(kind="taller", facts="Sábado 15/11, 9:00 a.m., Lechería."))
        assert with_facts.title == "Taller para familias: estrategias para el bienestar emocional de tus hijos"
        assert with_facts.slug == "taller-familias-bienestar-emocional"
        assert with_facts.content_md.endswith("## Cómo participar\n\nSábado 15/11, 9:00 a.m., Lechería.")
        without = ai.mock_article(params(kind="novedad", facts=""))
        assert "Cómo participar" not in without.content_md
        assert len(without.content_md) >= 200

    def test_revision_mock_summary(self):
        revised = ai.mock_revision(ai.mock_article(params()))
        assert revised.summary.startswith("Resumen revisado en modo de prueba:")
        assert 40 <= len(revised.summary.split()) <= 70


def _hrefs(md: str) -> list[str]:
    return re.findall(r'href="([^"]*)"', render_markdown(md).html)


class TestLinks:
    def test_enforce_links(self):
        md = (
            "[agenda](/agenda) [cursos](/cursos \"Cursos\") [otra](/otra-ruta) [agenda2](/agenda#x)\n"
            "[inscripción](https://inscripcion.example.com/taller) [falsa](https://evil.example)\n"
            "<https://inscripcion.example.com/taller> <https://evil.example/x> <correo@example.com>\n"
            "[wiki](https://es.wikipedia.org/wiki/Foo_(bar)) [js](javascript:alert(1)) `[código](https://evil.example)`\n"
        )
        allowed = ai.allowed_urls(SECRET_FACTS)
        assert allowed == {"https://inscripcion.example.com/taller"}
        out = ai.enforce_links(md, allowed)
        assert out == (
            "[agenda](/agenda) [cursos](/cursos \"Cursos\") otra agenda2\n"
            "[inscripción](https://inscripcion.example.com/taller) falsa\n"
            "<https://inscripcion.example.com/taller> https://evil.example/x correo@example.com\n"
            # Not links for the parser (bad scheme, code span): left as they are.
            "wiki [js](javascript:alert(1)) `[código](https://evil.example)`\n"
        )
        assert _hrefs(out) == [
            "/agenda", "/cursos", "https://inscripcion.example.com/taller", "https://inscripcion.example.com/taller",
        ]

    @pytest.mark.parametrize("md,text", [
        ("Lee la [Guía [PDF]](https://evil.example/a) hoy.", "Lee la Guía [PDF] hoy."),
        ("Mira [a\\]b](https://evil.example/b) ya.", "Mira a\\]b ya."),
        ("Ver [x](https://evil.example/((c))) fin.", "Ver x fin."),
        ("> [r]: https://evil.example/q\n\nMira [esto][r] y [r].", "\nMira esto y r."),
        ("- [r]: https://evil.example/l\n- otro\n\nVer [r] y [r][].", "- otro\n\nVer r y r."),
        ("[r]:\n  https://evil.example/n\n\nVer [r].", "\nVer r."),
        ("> Cita con [enlace](https://evil.example/c) y [agenda](/agenda).", "> Cita con enlace y [agenda](/agenda)."),
        ("1. Paso con <https://evil.example/d>", "1. Paso con https://evil.example/d"),
        ("| A | B |\n|---|---|\n| [x](https://evil.example/t) | ok |", "| A | B |\n|---|---|\n| x | ok |"),
    ])
    def test_tricky_forbidden_links_become_text(self, md, text):
        out = ai.enforce_links(md, ai.allowed_urls(SECRET_FACTS))
        assert out == text
        assert _hrefs(out) in ([], ["/agenda"])

    def test_reference_definitions_are_never_kept(self):
        md = "Ver [inscripción][ok] y [agenda][a].\n\n[ok]: https://inscripcion.example.com/taller\n[a]: /agenda"
        out = ai.enforce_links(md, ai.allowed_urls(SECRET_FACTS))
        assert out == "Ver inscripción y agenda.\n"
        assert _hrefs(out) == []

    def test_a_link_that_cannot_be_placed_is_escaped(self):
        # The link text spans two quoted lines: its syntax is escaped on them.
        md = "> Mira [esta\n> guía](https://evil.example/m) y [agenda](/agenda).\n\nOtro [párrafo](/blog)."
        out = ai.enforce_links(md, set())
        assert out == "> Mira \\[esta\n> guía](https://evil.example/m) y \\[agenda](/agenda).\n\nOtro [párrafo](/blog)."
        assert _hrefs(out) == ["/blog"]

    def test_allowed_external_urls_match_as_the_parser_stores_them(self):
        url = "https://inscripcion.example.com/taller?año=2026&x=1"
        md = f"[inscríbete]({url})"
        assert ai.enforce_links(md, {url}) == md
        assert ai.enforce_links(md, set()) == "inscríbete"

    def test_linked_urls_ignore_plain_text_addresses(self):
        md = "[a](https://uno.example/x) y <https://dos.example/y>; texto https://tres.example/z sin enlace."
        assert ai.linked_urls(md) == {"https://uno.example/x", "https://dos.example/y"}

    def test_allowed_urls_strip_trailing_punctuation(self):
        assert ai.allowed_urls("Mira https://a.example/x). y (https://b.example/y), fin", "") == {
            "https://a.example/x", "https://b.example/y",
        }


class TestNormalize:
    def _article(self, **overrides) -> GeneratedArticle:
        return GeneratedArticle.model_validate_json(article_json(**overrides))

    def test_h1_and_links_and_cleanup(self):
        article = self._article(
            title="  Título\ncon salto  ",
            slug="Slug Con Acentos Á",
            content_md="# Título principal\n\n" + "Texto largo de prueba. " * 12 + "\n\n[fuera](https://evil.example)\r\n",
            keywords=["Miedo", "miedo", " ", "noche"],
            key_takeaways=["  uno ", ""],
            faq=[{"question": "¿Sola?", "answer": " "}, {"question": "¿P?", "answer": "R."}],
        )
        fields = ai.normalize_generated(article, kind="informativo", allowed_external=set())
        assert set(fields) == set(ai.ARTICLE_FIELDS)
        assert fields["title"] == "Título con salto"
        assert fields["slug"] == "slug-con-acentos-a"
        assert fields["content_md"].startswith("## Título principal\n\n")
        assert fields["content_md"].endswith("fuera")
        assert fields["keywords"] == ["Miedo", "noche"]
        assert fields["key_takeaways"] == ["uno"]
        assert fields["faq"] == [{"question": "¿P?", "answer": "R."}]
        assert fields["category"] == "emociones"

    def test_hard_limits_are_applied(self):
        article = self._article(
            title="palabra " * 30,
            excerpt="x" * 400,
            meta_description="palabra " * 60,
            key_takeaways=[f"idea {i}" for i in range(12)],
            keywords=[f"clave {i}" for i in range(20)],
            faq=[{"question": f"¿P{i}?", "answer": "R."} for i in range(10)],
        )
        fields = ai.normalize_generated(article, kind="informativo", allowed_external=set())
        assert len(fields["title"]) <= 120 and fields["title"].endswith("palabra")
        assert len(fields["excerpt"]) == 300
        assert len(fields["meta_description"]) <= 300 and not fields["meta_description"].endswith(" ")
        assert len(fields["key_takeaways"]) == 8
        assert len(fields["keywords"]) == 12
        assert len(fields["faq"]) == 8

    @pytest.mark.parametrize("kind", ["taller", "novedad"])
    def test_news_kinds_force_the_category(self, kind):
        fields = ai.normalize_generated(self._article(category="emociones"), kind=kind, allowed_external=set())
        assert fields["category"] == "talleres-y-novedades"

    @pytest.mark.parametrize("overrides", [{"title": "  "}, {"content_md": "Muy corto."}])
    def test_incomplete_article_is_an_error(self, overrides):
        with pytest.raises(BlogAIError, match="La respuesta de la IA llegó incompleta. Intenta de nuevo."):
            ai.normalize_generated(self._article(**overrides), kind="informativo", allowed_external=set())

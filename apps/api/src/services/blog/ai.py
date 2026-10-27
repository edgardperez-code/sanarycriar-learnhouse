"""Sanar y Criar: Claude writes and revises blog drafts (or a fixed mock article in development).

Everything the model returns is a DRAFT for the owner to review: nothing here
publishes. The owner's texts (topic, facts, revision instruction) and the
article itself are never logged; log lines carry ids, lengths, the model,
``stop_reason``, token usage, duration, error class, HTTP status and the
API ``request-id`` only.

The SDK is reached only through ``_get_client()`` (tests patch it by name).
Environment (read on every call):
- ``ANTHROPIC_API_KEY``: read by the SDK. Without it (and without the mock)
  the blog's AI is off.
- ``SC_BLOG_AI_MODEL``: optional model id (default ``claude-opus-5-5``).
- ``SC_BLOG_AI_MOCK=1``: fixed article, no API call. Never in production.
- ``SC_BLOG_AI_MOCK_DELAY``: seconds the mock takes (default 3).
"""

import asyncio
import logging
import os
import re
import time
from dataclasses import dataclass
from typing import Literal, Optional

import anthropic
from anthropic import AsyncAnthropic, transform_schema
from markdown_it.rules_inline import autolink as _autolink_rule
from markdown_it.rules_inline import link as _link_rule
from pydantic import BaseModel, ValidationError

from src.services.blog import render
from src.services.blog.common import (
    AUDIENCES,
    CATEGORIES,
    DEFAULT_CATEGORY,
    LENGTHS,
    LIMITS,
    NEWS_CATEGORY,
    clean_markdown,
    slugify,
    truncate_text,
)
from src.services.newsletter.common import clean_line, clean_multiline

log = logging.getLogger(__name__)

# At DEBUG the SDK logs every request it sends, body included (the owner's
# topic, data and article), and LEARNHOUSE_LOG_LEVEL=DEBUG sets the root logger
# to DEBUG. ``ANTHROPIC_LOG=debug`` (the SDK's own switch) still turns it on.
_SDK_LOGGERS = ("anthropic", "httpx2")


def quiet_sdk_loggers() -> None:
    """Keep the SDK's loggers at INFO or above unless ``ANTHROPIC_LOG=debug`` asks for more."""
    if os.environ.get("ANTHROPIC_LOG") == "debug":
        return
    for name in _SDK_LOGGERS:
        logger = logging.getLogger(name)
        if logger.level < logging.INFO:  # NOTSET (follows the root logger) or DEBUG
            logger.setLevel(logging.INFO)


quiet_sdk_loggers()

# Routes whose requests carry the owner's AI texts (topic, data, instruction),
# as a URL or as a transaction name (``/api/v1/blog/{org_id}/ai/generate``).
_AI_ROUTE_RE = re.compile(r"/blog/[^/]+/(?:ai/|posts/[^/]+/ai/)")
# Modules whose stack frames hold those texts or the article in local variables.
_PRIVATE_MODULES = ("src.services.blog.ai", "src.services.blog.jobs")


def scrub_sentry_event(event: dict) -> dict:
    """A Sentry event without the owner's AI texts (``before_send`` / ``before_send_transaction``).

    Sentry sends request bodies and the local variables of each stack frame
    by default (``send_default_pii=False`` covers neither): the body of the AI
    routes is replaced and their frames lose their variables, as do the frames
    of this module and of the jobs module on any route.
    """
    try:
        request = event.get("request")
        request = request if isinstance(request, dict) else {}
        ai_route = bool(_AI_ROUTE_RE.search(f"{request.get('url') or ''} {event.get('transaction') or ''}"))
        if ai_route and "data" in request:
            request["data"] = "[Filtered]"
        for section in ("exception", "threads"):
            for value in (event.get(section) or {}).get("values") or []:
                for frame in ((value or {}).get("stacktrace") or {}).get("frames") or []:
                    if ai_route or str(frame.get("module") or "").startswith(_PRIVATE_MODULES):
                        frame.pop("vars", None)
    except Exception:  # never lose the event over this
        pass
    return event


DEFAULT_MODEL = "claude-opus-5-5"
# Models that accept the server-side refusal fallback in its "default" form.
FALLBACK_MODELS = frozenset({"claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"})
FALLBACK_BETA = "server-side-fallback-2026-07-01"
MAX_TOKENS = 32000
REQUEST_TIMEOUT_SECONDS = 300.0  # per attempt
# Around the whole call (retries included): always under the jobs' 10 min
# stale rule, so a finished call is never thrown away as "interrupted".
TOTAL_TIMEOUT_SECONDS = 540.0
DEFAULT_MOCK_DELAY_SECONDS = 3.0

CategoryValue = Literal["emociones", "limites-y-conducta", "sueno-y-rutinas", "crianza-y-familia", "talleres-y-novedades"]

KIND_DESCRIPTIONS = {
    "informativo": "artículo informativo sobre crianza, emociones o desarrollo",
    "novedad": "novedad: algo nuevo que Hilda ofrece o hace",
    "taller": "presentación de un taller que dicta Hilda",
}

INCOMPLETE_ERROR = "La respuesta de la IA llegó incompleta. Intenta de nuevo."


class FaqItem(BaseModel):
    question: str
    answer: str


class GeneratedArticle(BaseModel):
    # No Field(min/max): the SDK strips them from the schema; limits are applied afterwards.
    category: CategoryValue
    title: str
    slug: str
    meta_title: str
    meta_description: str
    excerpt: str
    summary: str
    key_takeaways: list[str]
    content_md: str
    faq: list[FaqItem]
    keywords: list[str]


ARTICLE_FIELDS = tuple(GeneratedArticle.model_fields.keys())
# Built once at import: stable bytes keep the prompt cache warm.
ARTICLE_SCHEMA = transform_schema(GeneratedArticle)

# Sanar y Criar: public in the AGPL fork, so nothing secret goes here. No
# dates or ids either: it is the cached prefix of every request.
SYSTEM_PROMPT = """Eres la redactora del blog de Sanar y Criar (www.sanarycriarve.com), el sitio de la psicóloga Hilda Hernández. Escribes artículos en español para que Hilda los revise, los edite y decida si los publica. Nada de lo que escribes se publica sin su revisión.

## Quién es Hilda (datos verificados: usa solo estos)
- Hilda Hernández, psicóloga clínica infanto-juvenil. Registro profesional FPV 8.914 (Federación de Psicólogos de Venezuela).
- Trabaja desde Lechería, estado Anzoátegui, Venezuela. Atiende consultas 100% online.
- Acompaña a niños, adolescentes y a sus familias, en especial a las mamás. Áreas: primera infancia de 1 a 5 años (rabietas, hábitos, sueño, autonomía); acompañamiento materno (embarazo, posparto y maternidad); crianza, hábitos y límites; ansiedad infantil y regulación emocional; TDAH, neurodiversidad e inclusión; orientación a familias de niños con autismo; salud mental del adolescente.
- Su enfoque: mirar primero hacia adentro ("antes de corregir a tu hijo, descubre qué se activa en ti"), sin culpa y sin juicios, con herramientas prácticas basadas en evidencia aplicadas con amor y empatía. Sanar la propia historia para criar distinto.
- Ofrece consultas psicológicas online, cursos en video y ebooks, una clase gratuita, un test de crianza en línea (no es un diagnóstico) y talleres presenciales o virtuales en vivo para instituciones educativas, empresas y familias, con cotización personalizada.
No le atribuyas títulos, estudios, años de experiencia, premios, publicaciones, cifras de pacientes ni ningún otro dato que no esté en esta lista.

## Voz
- Cálida, cercana y profesional. Tutea a quien lee; nunca uses usted ni vos.
- Español neutro con naturalidad venezolana: claro, sin modismos marcados ni anglicismos innecesarios.
- Puedes escribir en primera persona como Hilda ("te propongo", "me gusta recordar"), pero sin anécdotas ni casos.
- Párrafos cortos de 2 a 4 oraciones, ejemplos cotidianos de la vida en familia y validación emocional antes de las recomendaciones. Nada de culpa, alarma ni juicios hacia madres, padres, cuidadores o docentes.

## Límites éticos (obligatorios)
- No diagnostiques ni sugieras diagnósticos para un niño o una persona concreta. Habla de conductas y señales en general.
- No prometas resultados, curas ni plazos.
- No inventes estadísticas, porcentajes, estudios, investigaciones, autores, citas textuales, testimonios, casos ni ejemplos de pacientes. Si una afirmación necesitaría una fuente, no la incluyas: explica la idea en términos generales.
- No hables de medicamentos, dosis, suplementos ni tratamientos médicos, y no recomiendes a otros profesionales ni instituciones con nombre propio.
- Si el tema toca señales de riesgo (autolesiones, ideas suicidas, maltrato o abuso, violencia, consumo de sustancias, crisis), di con claridad que hay que buscar ayuda profesional de inmediato y, ante una emergencia, acudir a los servicios de emergencia locales. No escribas números de teléfono, líneas de ayuda ni direcciones.
- Nunca menciones nombres ni datos de pacientes o de sus familias aunque aparezcan en la indicación, en los datos o en el artículo que revisas.
- No escribas precios, fechas, horarios, lugares, modalidades ni enlaces que no estén en los datos que te dan.

## Novedades y talleres
Si el tipo es "novedad" o "taller", la única fuente de fechas, horarios, lugar, modalidad, precio, cupos y enlaces de inscripción es el bloque "Datos que debe usar". Copia esos datos tal como vienen. Si un dato no está, no lo menciones ni lo supongas; invita a escribir para pedir más información o a visitar la página de talleres. Si no hay datos, escribe sobre el tema y su utilidad sin ningún dato logístico. Si los datos traen un enlace de inscripción, puedes enlazarlo tal cual.

## Campos de la respuesta (todo en español)
- category: una de emociones, limites-y-conducta, sueno-y-rutinas, crianza-y-familia, talleres-y-novedades. Para novedades y talleres usa talleres-y-novedades; para artículos informativos elige la más cercana al tema.
- title: claro y atractivo, de 65 caracteres como máximo, con la palabra clave si queda natural. Sin punto final ni emojis.
- slug: solo minúsculas sin acentos, números y guiones; de 3 a 60 caracteres; sin palabras vacías innecesarias.
- meta_title: título para buscadores de 60 caracteres como máximo, sin el nombre del sitio (se añade solo).
- meta_description: entre 140 y 155 caracteres, con la palabra clave y una invitación a leer.
- excerpt: una o dos frases para la tarjeta del blog, de 200 caracteres como máximo.
- summary: de 40 a 70 palabras que respondan de forma directa a la pregunta principal del artículo.
- key_takeaways: de 3 a 5 ideas clave, cada una de una sola frase corta.
- content_md: el cuerpo del artículo en Markdown (ver formato).
- faq: de 3 a 5 preguntas que alguien buscaría en Google, distintas de los títulos de sección, con respuestas de 40 a 80 palabras en texto plano, sin Markdown.
- keywords: de 4 a 8 palabras clave en minúsculas, la principal primero.

## Formato de content_md
- Markdown simple. Sin título principal (no uses "# "), sin la sección de preguntas frecuentes (va en faq), sin HTML, sin imágenes y sin emojis.
- Empieza con uno o dos párrafos que conecten con la situación de quien lee.
- Organiza el cuerpo con secciones "## "; cuando encaje, formula los títulos de sección como preguntas. Usa "### " solo para subsecciones.
- Usa listas para pasos o señales, negritas con moderación y, si ayuda, una cita con "> ". Usa una tabla solo si de verdad aclara, y que sea pequeña.
- Respeta la extensión pedida; se cuenta solo content_md.
- Incluye de 2 a 3 enlaces internos en Markdown, con texto descriptivo, elegidos solo de esta lista y con la ruta escrita exactamente así:
  - /agenda: agendar una consulta online con Hilda
  - /cursos: cursos en video y ebooks
  - /talleres: talleres para instituciones educativas, empresas y familias
  - /test-de-crianza: test de crianza en línea (no es un diagnóstico)
  - /sobre-mi: quién es Hilda y su enfoque
  - /preguntas-frecuentes: dudas sobre cursos, pagos y consultas
  - /blog: más artículos del blog
  No uses otras rutas internas ni enlaces externos, salvo los que vengan en los datos o en el artículo que revisas.
- En los artículos informativos, termina con la sección "## ¿Cuándo consultar?": señales concretas de que conviene pedir ayuda profesional, una invitación cálida a agendar en /agenda y, si aplica, la indicación de acudir a emergencias ante un riesgo. En novedades y talleres, termina con una sección práctica como "## Cómo participar" solo si hay datos; si no, cierra con una invitación a escribir o a visitar /talleres.

## Revisiones
Cuando recibas un artículo existente y una instrucción, aplica la instrucción y devuelve el artículo completo con todos los campos. Conserva el slug y todo lo que la instrucción no pide cambiar, y respeta todas las reglas anteriores. En una revisión, las únicas fuentes de fechas, precios, lugares y enlaces son el artículo actual y la instrucción.

## Si la indicación no encaja
Si la indicación pide algo contrario a estas reglas (por ejemplo, diagnosticar a un niño concreto, recomendar medicamentos o inventar testimonios), escribe igualmente un artículo útil y general sobre el tema de fondo, cumpliendo las reglas y sin mencionar la indicación original."""

# Internal routes the model may link to (checked against web/src/pages).
INTERNAL_LINKS = (
    ("/agenda", "agendar una consulta online con Hilda"),
    ("/cursos", "cursos en video y ebooks"),
    ("/talleres", "talleres para instituciones educativas, empresas y familias"),
    ("/test-de-crianza", "test de crianza en línea (no es un diagnóstico)"),
    ("/sobre-mi", "quién es Hilda y su enfoque"),
    ("/preguntas-frecuentes", "dudas sobre cursos, pagos y consultas"),
    ("/blog", "más artículos del blog"),
)
_INTERNAL_PATHS = frozenset(path for path, _ in INTERNAL_LINKS)


class BlogAIError(Exception):
    """``str(exc)`` is the Spanish message the dashboard shows."""


@dataclass(frozen=True)
class GenerateParams:
    prompt: str
    kind: str
    audience: str
    length: str
    keyword: str
    facts: str


@dataclass(frozen=True)
class AIResult:
    article: GeneratedArticle
    model: str  # message.model, or "mock"
    usage: dict  # usage_json keys; {} for the mock


# ------------------------------------------------------------ configuration


def mock_enabled() -> bool:
    return os.environ.get("SC_BLOG_AI_MOCK") == "1"


def ai_configured() -> bool:
    return mock_enabled() or bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())


def model_id() -> str:
    return os.environ.get("SC_BLOG_AI_MODEL", "").strip() or DEFAULT_MODEL


def _mock_delay() -> float:
    try:
        return max(0.0, float(os.environ.get("SC_BLOG_AI_MOCK_DELAY", DEFAULT_MOCK_DELAY_SECONDS)))
    except ValueError:
        return DEFAULT_MOCK_DELAY_SECONDS


_client: Optional[AsyncAnthropic] = None


def _get_client() -> AsyncAnthropic:
    """The SDK client, created on first use (the key is read from the environment then)."""
    global _client
    if _client is None:
        _client = AsyncAnthropic(timeout=REQUEST_TIMEOUT_SECONDS, max_retries=1)
    return _client


# ------------------------------------------------------------------ prompts


def _quoted(text: str) -> str:
    """The owner's text between triple quotes cannot close the block early."""
    return (text or "").replace('"""', "“““")


def build_generate_message(params: GenerateParams) -> str:
    low, high = LENGTHS[params.length]
    keyword = params.keyword or "elige la más natural para el tema"
    facts = params.facts or "Sin datos."
    return (
        "Escribe un artículo nuevo para el blog.\n"
        "\n"
        f"Tipo: {params.kind} ({KIND_DESCRIPTIONS[params.kind]})\n"
        f"Público: {AUDIENCES[params.audience]}\n"
        f"Extensión de content_md: entre {low} y {high} palabras.\n"
        f"Palabra clave principal: {_quoted(keyword)}\n"
        "\n"
        "Tema o indicación de Hilda:\n"
        '"""\n'
        f"{_quoted(params.prompt)}\n"
        '"""\n'
        "\n"
        "Datos que debe usar (única fuente de fechas, horarios, lugar, modalidad, precio, cupos y enlaces):\n"
        '"""\n'
        f"{_quoted(facts)}\n"
        '"""'
    )


def build_revise_message(article: GeneratedArticle, kind: str, instruction: str) -> str:
    words = render.render_markdown(article.content_md).word_count
    return (
        "Revisa este artículo del blog siguiendo la instrucción de Hilda y devuelve el artículo completo.\n"
        "\n"
        f"Tipo: {kind} ({KIND_DESCRIPTIONS.get(kind, KIND_DESCRIPTIONS['informativo'])})\n"
        f"Extensión actual de content_md: {words} palabras (mantenla salvo que la instrucción pida otra cosa).\n"
        "\n"
        "Artículo actual (JSON):\n"
        '"""\n'
        f"{_quoted(article.model_dump_json())}\n"
        '"""\n'
        "\n"
        "Instrucción de Hilda:\n"
        '"""\n'
        f"{_quoted(instruction)}\n"
        '"""'
    )


# ---------------------------------------------------------------- the call


def _usage_dict(usage) -> dict:
    return {
        key: getattr(usage, key, None)
        for key in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
    }


def _request_id(exc: BaseException) -> Optional[str]:
    request_id = getattr(exc, "request_id", None)
    if request_id:
        return request_id
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    return headers.get("request-id") if headers is not None else None


async def _stream_final_message(model: str, user_message: str):
    extra = {"betas": [FALLBACK_BETA], "fallbacks": "default"} if model in FALLBACK_MODELS else {}
    async with _get_client().beta.messages.stream(
        model=model,
        max_tokens=MAX_TOKENS,
        thinking={"type": "adaptive"},
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": ARTICLE_SCHEMA}},
        system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": user_message}],
        **extra,
    ) as stream:
        return await stream.get_final_message()


async def _run_structured(user_message: str) -> AIResult:
    """One structured-output request; every failure becomes a ``BlogAIError``."""
    model = model_id()
    started = time.monotonic()
    try:
        message = await asyncio.wait_for(_stream_final_message(model, user_message), TOTAL_TIMEOUT_SECONDS)
    except anthropic.AuthenticationError as exc:
        log.warning("[blog-ia] authentication error status=%s request_id=%s", exc.status_code, _request_id(exc))
        raise BlogAIError("La clave de la IA (ANTHROPIC_API_KEY) no es válida. Revísala en el servidor.") from exc
    except anthropic.PermissionDeniedError as exc:
        log.warning("[blog-ia] permission denied status=%s request_id=%s", exc.status_code, _request_id(exc))
        raise BlogAIError("La clave de la IA no tiene permiso para usar este modelo.") from exc
    except anthropic.NotFoundError as exc:
        log.warning("[blog-ia] model not found model=%s request_id=%s", model, _request_id(exc))
        raise BlogAIError("El modelo de IA configurado no existe o no está disponible.") from exc
    except anthropic.RateLimitError as exc:
        log.warning("[blog-ia] rate limited status=%s request_id=%s", exc.status_code, _request_id(exc))
        raise BlogAIError("La IA está ocupada en este momento. Intenta de nuevo en unos minutos.") from exc
    except anthropic.BadRequestError as exc:
        log.error(
            "[blog-ia] bad request status=%s request_id=%s message=%s",
            exc.status_code, _request_id(exc), (getattr(exc, "message", "") or "")[:300],
        )
        raise BlogAIError("La IA rechazó la solicitud. Intenta de nuevo; si se repite, avisa al equipo técnico.") from exc
    except anthropic.APIStatusError as exc:
        log.error("[blog-ia] API error status=%s request_id=%s", exc.status_code, _request_id(exc))
        raise BlogAIError(f"La IA respondió con un error ({exc.status_code}). Intenta de nuevo en unos minutos.") from exc
    except (anthropic.APITimeoutError, asyncio.TimeoutError, TimeoutError) as exc:
        log.warning("[blog-ia] timeout after %.0fs (%s)", time.monotonic() - started, type(exc).__name__)
        raise BlogAIError("La IA tardó demasiado en responder. Intenta de nuevo o pide una extensión menor.") from exc
    except anthropic.APIConnectionError as exc:
        log.warning("[blog-ia] connection error (%s)", type(exc).__name__)
        raise BlogAIError("No se pudo conectar con la IA. Revisa la conexión del servidor e intenta de nuevo.") from exc

    usage = _usage_dict(getattr(message, "usage", None))
    log.info(
        "[blog-ia] model=%s stop=%s in=%s out=%s cache_read=%s secs=%.1f",
        getattr(message, "model", model), message.stop_reason, usage["input_tokens"],
        usage["output_tokens"], usage["cache_read_input_tokens"], time.monotonic() - started,
    )
    if message.stop_reason == "refusal":
        raise BlogAIError(
            "La IA no pudo escribir sobre este tema. Reformula la indicación "
            "(sin datos personales y dentro del enfoque del blog)."
        )
    if message.stop_reason == "max_tokens":
        raise BlogAIError("El artículo quedó demasiado largo y se cortó. Pide una extensión menor.")
    text = "".join(
        getattr(block, "text", "") or "" for block in (message.content or []) if getattr(block, "type", None) == "text"
    )
    if not text.strip():
        raise BlogAIError(INCOMPLETE_ERROR)
    try:
        article = GeneratedArticle.model_validate_json(text)
    except ValidationError as exc:
        log.warning("[blog-ia] invalid structured output (%s errors, %s chars)", exc.error_count(), len(text))
        raise BlogAIError(INCOMPLETE_ERROR) from exc
    return AIResult(article=article, model=getattr(message, "model", None) or model, usage=usage)


async def generate_article(params: GenerateParams) -> AIResult:
    if mock_enabled():
        await asyncio.sleep(_mock_delay())
        return AIResult(article=mock_article(params), model="mock", usage={})
    return await _run_structured(build_generate_message(params))


async def revise_article(article: GeneratedArticle, kind: str, instruction: str) -> AIResult:
    if mock_enabled():
        await asyncio.sleep(_mock_delay())
        return AIResult(article=mock_revision(article), model="mock", usage={})
    return await _run_structured(build_revise_message(article, kind, instruction))


# --------------------------------------------------------------- mock data

_MOCK_INFORMATIVE_CONTENT = """Si tu hijo o tu hija se tira al piso, grita o llora con todas sus fuerzas porque no quiere salir del parque, no estás haciendo nada mal. Las rabietas son una forma muy común de expresar emociones intensas en la primera infancia, cuando el cerebro todavía está aprendiendo a regularse.

Te propongo mirar estos momentos con otros ojos: no como un desafío a tu autoridad, sino como una señal de que tu peque necesita ayuda para atravesar algo que le desborda.

## ¿Por qué aparecen las rabietas entre el año y los cinco años?

En esta etapa los niños sienten mucho y todavía tienen pocas palabras para nombrar lo que les pasa. Quieren hacer las cosas solos, pero no siempre pueden, y esa distancia entre lo que desean y lo que logran produce frustración.

El cansancio, el hambre, los cambios de rutina y el exceso de estímulos también influyen. Por eso, muchas rabietas aparecen al final del día o en lugares con mucho ruido.

## Cómo acompañar una rabieta sin perder la calma

Antes de corregir a tu hijo, vale la pena mirar qué se activa en ti. Si respiras y bajas el tono, le prestas tu calma para que poco a poco recupere la suya.

- **Ponte a su altura** y usa pocas palabras, con voz tranquila.
- **Nombra la emoción**: "Estás muy molesto porque querías seguir jugando".
- **Mantén el límite** con cariño: puedes validar lo que siente sin cambiar la decisión.
- **Ofrece contacto** si lo acepta, o quédate cerca si necesita espacio.
- **Habla de lo ocurrido** cuando todo haya pasado, en pocas frases.

> Validar una emoción no significa darle la razón a una conducta.

## ¿Qué puedes hacer en casa para prevenirlas?

Las rutinas predecibles, los tiempos de descanso y las transiciones anunciadas con anticipación ayudan mucho. Avisar "en cinco minutos nos vamos" y ofrecer pequeñas elecciones le da a tu peque una sensación de control.

También ayuda jugar a nombrar emociones con cuentos o dibujos en momentos tranquilos. Si quieres conocer tu estilo de crianza, puedes hacer el [test de crianza en línea](/test-de-crianza), que te da una orientación general (no es un diagnóstico).

## ¿Cuándo consultar?

Conviene pedir ayuda profesional si las rabietas son muy frecuentes después de los cinco años, si tu hijo se lastima o lastima a otros, si duran mucho tiempo o si sientes que la situación te sobrepasa. Pedir ayuda también es una forma de cuidar a tu familia.

Si quieres acompañamiento, puedes [agendar una consulta online conmigo](/agenda) y vemos juntas qué necesita tu familia. Ante cualquier situación de riesgo, acude de inmediato a los servicios de emergencia de tu localidad."""

_MOCK_WORKSHOP_CONTENT = """Criar no es sencillo, y a veces sentimos que nos faltan herramientas para acompañar las emociones de nuestros hijos. Este taller nace para darte un espacio cálido donde aprender, preguntar y practicar sin culpa.

## ¿Qué vas a aprender en el taller?

Vamos a conversar sobre cómo se desarrollan las emociones en la infancia y por qué la calma de los adultos es el primer recurso de los niños.

- Cómo reconocer las señales de que tu hijo está desbordado.
- Estrategias prácticas para acompañar rabietas, miedos y frustraciones.
- Ideas para poner límites con cariño y firmeza.
- Recursos para cuidar también tu bienestar como mamá, papá o cuidador.

## ¿A quién está dirigido?

A madres, padres y cuidadores de niños pequeños y en edad escolar que quieran criar desde la calma y fortalecer el vínculo con sus hijos.

Si quieres conocer otras propuestas, visita la página de [talleres para instituciones educativas, empresas y familias](/talleres)."""

_MOCK_REVISED_SUMMARY = (
    "Resumen revisado en modo de prueba: este texto reemplaza el resumen original para comprobar que "
    "la mejora con IA funciona de punta a punta. Muestra cómo se aplica una revisión a un borrador y "
    "cómo se propone, sin tocar nada, cuando el artículo ya está publicado en el sitio web."
)


def mock_article(params: GenerateParams) -> GeneratedArticle:
    """A fixed, realistic article (development and tests only)."""
    if params.kind == "informativo":
        return GeneratedArticle(
            category="emociones",
            title="Rabietas en la primera infancia: cómo acompañarlas sin perder la calma",
            slug="rabietas-primera-infancia-acompanar-con-calma",
            meta_title="Rabietas en niños de 1 a 5 años: cómo acompañarlas",
            meta_description=(
                "Rabietas en la primera infancia: por qué aparecen entre el año y los cinco años y cómo "
                "acompañarlas con calma y límites claros. Descubre cómo."
            ),
            excerpt=(
                "Las rabietas son parte del desarrollo emocional. Te comparto por qué aparecen y cómo "
                "acompañarlas con calma, sin culpa y con límites claros."
            ),
            summary=(
                "Las rabietas aparecen entre el año y los cinco años porque los niños sienten emociones "
                "intensas y todavía están aprendiendo a regularlas. Acompañarlas con calma, nombrar la "
                "emoción y sostener el límite con cariño les ayuda a recuperarse. Las rutinas predecibles "
                "y las transiciones anunciadas reducen su frecuencia."
            ),
            key_takeaways=[
                "Las rabietas son una forma común de expresar emociones intensas en la primera infancia.",
                "Tu calma es el primer recurso para que tu peque recupere la suya.",
                "Puedes validar la emoción sin cambiar el límite.",
                "Las rutinas y los avisos anticipados ayudan a prevenirlas.",
            ],
            content_md=_MOCK_INFORMATIVE_CONTENT,
            faq=[
                FaqItem(
                    question="¿A qué edad son normales las rabietas?",
                    answer=(
                        "Son frecuentes entre el año y los cinco años, cuando los niños sienten emociones "
                        "intensas y todavía no tienen palabras ni recursos para regularlas. Suelen disminuir "
                        "a medida que crece su lenguaje y su capacidad de esperar. Si continúan con mucha "
                        "intensidad después de esa edad, conviene consultar con una profesional."
                    ),
                ),
                FaqItem(
                    question="¿Debo ignorar a mi hijo durante una rabieta?",
                    answer=(
                        "No hace falta ignorarlo. Puedes quedarte cerca, con voz tranquila y pocas palabras, "
                        "para que sienta que no está solo con lo que le pasa. Acompañar no significa ceder: "
                        "puedes sostener el límite con cariño mientras le ayudas a calmarse y, cuando todo "
                        "pase, conversar brevemente sobre lo ocurrido."
                    ),
                ),
                FaqItem(
                    question="¿Cómo puedo prevenir las rabietas en casa?",
                    answer=(
                        "Las rutinas predecibles, el descanso suficiente y las transiciones anunciadas con "
                        "tiempo ayudan mucho. Avisar antes de terminar una actividad y ofrecer pequeñas "
                        "elecciones le da a tu peque una sensación de control. También sirve jugar a nombrar "
                        "emociones en momentos tranquilos, con cuentos o dibujos."
                    ),
                ),
            ],
            keywords=["rabietas", "primera infancia", "regulación emocional", "crianza respetuosa", "límites con cariño"],
        )

    content = _MOCK_WORKSHOP_CONTENT
    if params.facts:
        content = f"{content}\n\n## Cómo participar\n\n{params.facts}"
    return GeneratedArticle(
        category="talleres-y-novedades",
        title="Taller para familias: estrategias para el bienestar emocional de tus hijos",
        slug="taller-familias-bienestar-emocional",
        meta_title="Taller para familias: bienestar emocional infantil",
        meta_description=(
            "Taller para familias con la psicóloga Hilda Hernández: herramientas prácticas para acompañar "
            "las emociones de tus hijos desde la calma. Conoce más aquí."
        ),
        excerpt="Un espacio para aprender herramientas prácticas y acompañar las emociones de tus hijos desde la calma.",
        summary=(
            "Este taller ofrece a madres, padres y cuidadores herramientas prácticas para acompañar las "
            "emociones de sus hijos: reconocer cuándo están desbordados, poner límites con cariño y cuidar "
            "también el propio bienestar, en un espacio cálido y sin culpa."
        ),
        key_takeaways=[
            "La calma de los adultos es el primer recurso de los niños.",
            "Poner límites con cariño fortalece el vínculo.",
            "Cuidar tu bienestar también es parte de la crianza.",
        ],
        content_md=content,
        faq=[
            FaqItem(
                question="¿Necesito experiencia previa para participar en el taller?",
                answer=(
                    "No. El taller está pensado para cualquier madre, padre o cuidador que quiera aprender "
                    "herramientas prácticas para acompañar las emociones de sus hijos. Vamos paso a paso, "
                    "con ejemplos de la vida diaria y espacio para tus preguntas, sin juicios y a tu ritmo."
                ),
            ),
            FaqItem(
                question="¿El taller sirve para niños de cualquier edad?",
                answer=(
                    "Está enfocado en niños pequeños y en edad escolar, aunque muchas de las ideas sirven "
                    "para cualquier etapa. Si tienes dudas sobre tu caso, puedes escribir antes de "
                    "inscribirte y conversamos sobre lo que necesita tu familia para aprovecharlo al máximo."
                ),
            ),
            FaqItem(
                question="¿Puedo llevar este taller a mi institución educativa?",
                answer=(
                    "Sí. Los talleres también se ofrecen a instituciones educativas, empresas y grupos de "
                    "familias, con una propuesta adaptada a cada grupo. Puedes visitar la página de talleres "
                    "o escribir para recibir una cotización personalizada según el número de participantes."
                ),
            ),
        ],
        keywords=["taller para familias", "bienestar emocional", "crianza", "emociones infantiles"],
    )


def mock_revision(article: GeneratedArticle) -> GeneratedArticle:
    """The same article with a fixed summary (development and tests only)."""
    return article.model_copy(update={"summary": _MOCK_REVISED_SUMMARY})


# ----------------------------------------------------------- normalization

_URL_RE = re.compile(r"https?://[^\s<>()\"]+")
_H1_RE = re.compile(r"^( {0,3})#(?=[ \t]|$)", re.MULTILINE)
# An unescaped "[" or "<" (after an even run of backslashes): where every link starts.
_LINK_OPENER_RE = re.compile(r"(?<!\\)((?:\\\\)*)([\[<])")
# Rewrite rounds before the last resort (one is enough for anything but contrived input).
_MAX_LINK_PASSES = 8


def _tracked(rule, *, labelled: bool):
    """An inline link rule that also records, on its ``link_open``, where the link sits in the inline source."""

    def wrapped(state, silent):
        start = state.pos
        label_end = -1
        if labelled and not silent and state.src[start:start + 1] == "[":
            label_end = state.md.helpers.parseLinkLabel(state, start, True)
        first = len(state.tokens)
        if not rule(state, silent):
            return False
        if not silent:
            end = state.pos
            if labelled:
                label = (start + 1, label_end)
                # [text](destination) as opposed to [text][label], [label][] or [label].
                inline = label_end + 1 < end and state.src[label_end + 1] == "(" and state.src[end - 1] == ")"
            else:
                label, inline = (start + 1, end - 1), True
            for token in state.tokens[first:]:
                if token.type == "link_open":
                    token.meta["sc_link"] = {"span": (start, end), "label": label, "inline": inline}
                    break
        return True

    return wrapped


def _build_link_parser():
    # The renderer's own parser and options, so links are found exactly as the site will render them.
    md = render.build_parser()
    md.inline.ruler.at("link", _tracked(_link_rule, labelled=True))
    md.inline.ruler.at("autolink", _tracked(_autolink_rule, labelled=False))
    return md


_LINK_MD = _build_link_parser()


def _links(tokens):
    """``(inline token, link_open token)`` for every link of a parsed document."""
    for token in tokens:
        if token.type == "inline" and token.children:
            for child in token.children:
                if child.type == "link_open":
                    yield token, child


def _allowed_hrefs(allowed_external: set[str]) -> set[str]:
    hrefs = set(_INTERNAL_PATHS)
    for url in allowed_external or ():
        hrefs.add(url)
        try:
            hrefs.add(_LINK_MD.normalizeLink(url))  # as the parser stores it (percent-encoded)
        except Exception:
            pass
    return hrefs


def _locate(content_line: str, source_line: str) -> Optional[int]:
    """Column of ``source_line`` where a line of an inline token's text starts (``None`` if ambiguous)."""
    for candidate in (content_line, content_line.lstrip(" ")):
        if not candidate:
            continue
        found = source_line.find(candidate)
        if found != -1 and source_line.find(candidate, found + 1) == -1:
            return found - (len(content_line) - len(candidate))
    return None


def _source_edit(inline, info: Optional[dict], lines: list[str]) -> Optional[tuple[int, int, int, str]]:
    """``(line, start, end, label)``: where a link is in the Markdown source and the text that replaces it."""
    if not info or not inline.map:
        return None
    start, end = info["span"]
    label_start, label_end = info["label"]
    content = inline.content
    if label_start > label_end or "\n" in content[start:end]:
        return None
    line_start = content.rfind("\n", 0, start) + 1
    line_end = content.find("\n", start)
    if line_end == -1:
        line_end = len(content)
    index = inline.map[0] + content.count("\n", 0, start)
    if index >= min(inline.map[1], len(lines)):
        return None
    base = _locate(content[line_start:line_end], lines[index])
    if base is None:
        return None
    col_start, col_end = base + start - line_start, base + end - line_start
    if col_start < 0 or lines[index][col_start:col_end] != content[start:end]:
        return None
    return index, col_start, col_end, content[label_start:label_end]


def _escape_link_openers(line: str) -> str:
    return _LINK_OPENER_RE.sub(r"\1\\\2", line)


def _fix_links_once(text: str, allowed: set[str]) -> Optional[str]:
    """One rewrite round, or ``None`` when no forbidden link or reference definition is left."""
    lines = text.split("\n")
    env: dict = {}
    tokens = _LINK_MD.parse(text, env)

    # Reference definitions are never accepted from the model (they hide the
    # address away from the link): their lines go, and links that use them
    # become text below.
    drop: set[int] = set()
    for ref in [*(env.get("references") or {}).values(), *(env.get("duplicate_refs") or [])]:
        span = ref.get("map") if isinstance(ref, dict) else None
        if span:
            drop.update(range(span[0], span[1]))

    edits: dict[int, list[tuple[int, int, str]]] = {}
    escape: set[int] = set()
    found = bool(env.get("references") or env.get("duplicate_refs"))
    for inline, link in _links(tokens):
        info = link.meta.get("sc_link")
        if info and info["inline"] and (link.attrGet("href") or "") in allowed:
            continue
        found = True
        edit = _source_edit(inline, info, lines)
        if edit is not None:
            index, col_start, col_end, label = edit
            edits.setdefault(index, []).append((col_start, col_end, label))
        elif inline.map:
            # Cannot be placed exactly (it spans lines, say): no link may start on those lines.
            escape.update(range(inline.map[0], min(inline.map[1], len(lines))))
        else:
            return "\n".join(_escape_link_openers(line) for line in lines)
    if not found:
        return None

    out: list[str] = []
    for index, line in enumerate(lines):
        if index in drop:
            continue
        if index in escape:
            line = _escape_link_openers(line)
        elif index in edits:
            limit = len(line)
            for col_start, col_end, label in sorted(edits[index], reverse=True):
                if col_end > limit:  # overlaps an edit already made; the next round sees it again
                    continue
                line = line[:col_start] + label + line[col_end:]
                limit = col_start
        out.append(line)
    return "\n".join(out)


def enforce_links(content_md: str, allowed_external: set[str]) -> str:
    """Keep only links to the allowed internal routes and to the external URLs the owner gave.

    Links are found with the site's own Markdown parser (nested brackets,
    escapes, parentheses, links inside quotes and lists...), not with patterns.
    A forbidden link becomes its text; a forbidden autolink becomes its bare
    address (not linked: linkify is off); reference definitions are removed
    and links that use them become their text. If a link cannot be placed in
    the source exactly, link syntax is escaped on its lines; as a last resort,
    in the whole text: nothing forbidden is ever left as a link.
    """
    text = (content_md or "").replace("\r\n", "\n").replace("\r", "\n")
    allowed = _allowed_hrefs(allowed_external)
    for _ in range(_MAX_LINK_PASSES):
        fixed = _fix_links_once(text, allowed)
        if fixed is None:
            return text
        text = fixed
    return "\n".join(_escape_link_openers(line) for line in text.split("\n"))


def linked_urls(content_md: str) -> set[str]:
    """Addresses the article already links to, as the site renders them.

    A revision may keep these (they were written by the owner or let through
    from her data before). A URL that only appears as plain text does not
    count: it may be the leftover of a link the model was not allowed to make.
    """
    tokens = _LINK_MD.parse(content_md or "", {})
    return {href for _, link in _links(tokens) if (href := link.attrGet("href"))}


def allowed_urls(*texts: str) -> set[str]:
    """http(s) URLs written in the owner's own texts (without trailing punctuation)."""
    urls: set[str] = set()
    for text in texts:
        for match in _URL_RE.finditer(text or ""):
            url = match.group(0).rstrip(".,;:!?)")
            if url:
                urls.add(url)
    return urls


def _clean_list(values, limit_items: int, limit_chars: int, *, dedupe: bool = False) -> list[str]:
    items: list[str] = []
    seen: set[str] = set()
    for value in values or []:
        item = truncate_text(clean_line(value), limit_chars)
        if not item:
            continue
        if dedupe:
            key = item.lower()
            if key in seen:
                continue
            seen.add(key)
        items.append(item)
    return items[:limit_items]


def normalize_generated(article: GeneratedArticle, *, kind: str, allowed_external: set[str]) -> dict:
    """The model's article cleaned and cut to the hard limits (keys of ``GeneratedArticle``).

    Raises ``BlogAIError`` when the title is empty or the body too short to be an article.
    """
    content = _H1_RE.sub(r"\1##", clean_markdown(article.content_md))
    content = truncate_text(enforce_links(content, allowed_external).rstrip(), LIMITS["content_md"])

    faq: list[dict] = []
    for item in article.faq or []:
        question = truncate_text(clean_line(item.question), LIMITS["faq_question"])
        answer = truncate_text(clean_line(item.answer), LIMITS["faq_answer"])
        if question and answer:
            faq.append({"question": question, "answer": answer})

    if kind in ("novedad", "taller"):
        category = NEWS_CATEGORY
    else:
        category = article.category if article.category in CATEGORIES else DEFAULT_CATEGORY

    result = {
        "category": category,
        "title": truncate_text(clean_line(article.title), LIMITS["title"]),
        "slug": slugify(clean_line(article.slug)),
        "meta_title": truncate_text(clean_line(article.meta_title), LIMITS["meta_title"]),
        "meta_description": truncate_text(clean_line(article.meta_description), LIMITS["meta_description"]),
        "excerpt": truncate_text(clean_line(article.excerpt), LIMITS["excerpt"]),
        "summary": truncate_text(clean_multiline(article.summary), LIMITS["summary"]),
        "key_takeaways": _clean_list(article.key_takeaways, LIMITS["key_takeaways_items"], LIMITS["key_takeaway"]),
        "content_md": content,
        "faq": faq[: LIMITS["faq_items"]],
        "keywords": _clean_list(article.keywords, LIMITS["keywords_items"], LIMITS["keyword"], dedupe=True),
    }
    if not result["title"] or len(result["content_md"]) < LIMITS["content_publish_min"]:
        raise BlogAIError(INCOMPLETE_ERROR)
    return result

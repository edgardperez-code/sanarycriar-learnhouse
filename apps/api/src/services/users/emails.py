import html
import logging
from typing import Optional
from urllib.parse import quote

from pydantic import EmailStr
from src.db.organizations import OrganizationRead
from src.db.users import UserRead
from src.services.email.safe_text import email_org_name, email_user_name
# Sanar y Criar: mail greets by first name, never by the generated username.
from src.services.email.sc_greeting import named_copy
# Sanar y Criar: DEFAULT_LANGUAGE ("es") is the default `lang` below (was "en").
from src.services.email.translations import DEFAULT_LANGUAGE, PLATFORM_NAME, t
from src.services.email.utils import send_email
from src.services.users.sc_return_path import safe_return_path

logger = logging.getLogger(__name__)


def _send_notification_email(**kwargs):
    """Send mail whose failure must not fail the caller's request.

    Welcome/lifecycle notifications are a side effect of an action that has
    already happened and been committed: the account exists, the org was
    created, the role changed. When the provider is rate-limited or times out,
    raising here turned "no welcome email" into "signup returned 503", which the
    user then retried. Delivery failures are logged and swallowed instead.

    Mail the user is actively waiting on (password reset, invitation, address
    verification) still calls ``send_email`` directly and still raises.
    """
    try:
        return send_email(**kwargs)
    except Exception as e:
        logger.warning("Non-critical email to %s not sent: %s", kwargs.get("to"), e)
        return False


# Sanar y Criar: our own site, the footer "learn more" target of the org-less
# welcome mail and the last-resort CTA fallback (was LearnHouse's public
# academy, https://university.learnhouse.io).
ACADEMY_URL = "https://www.sanarycriarve.com"


# Sanar y Criar (2026-11): every email wears the website's look (client
# request): warm cream page, the "Sanar y Criar · Hilda Hernández" logo,
# Playfair titles, Poppins text, violet pill buttons, and Hilda's signature.
# Colors are the site's tokens (web/src/styles/global.css). The images live on
# the website (web/public/correo/) as PNG/JPG, which every mail client shows.
SITE_URL = "https://www.sanarycriarve.com"
INSTAGRAM_URL = "https://www.instagram.com/sanarycriarve/"
EMAIL_LOGO_URL = f"{SITE_URL}/correo/logo-sanar-y-criar.png"
EMAIL_AVATAR_URL = f"{SITE_URL}/correo/hilda.jpg"

SANS = "'Poppins', 'Segoe UI', Helvetica, Arial, sans-serif"
SERIF = "'Playfair Display', Georgia, 'Times New Roman', serif"
VIOLETA = "#190933"
VIOLETA_600 = "#41375b"
VIOLETA_400 = "#6d6485"
NUBE = "#fdf5ee"
BLANCO_CALIDO = "#fffcf9"
BORDE = "#eae8f2"
LAVANDA_100 = "#eeedff"
LAVANDA_300 = "#bbbbff"
LAVANDA_500 = "#7d75e2"
LAVANDA_700 = "#4f43a4"
ROSA_300 = "#f0b4df"
ROSA_600 = "#ac4691"

# The header logo of every email (org-scoped ones too: Sanar y Criar is one
# brand). If the client blocks images, the alt text shows in the brand serif.
PLATFORM_LOGO_HTML = (
    f'<a href="{ACADEMY_URL}" style="text-decoration: none;">'
    f'<img src="{EMAIL_LOGO_URL}" alt="Sanar y Criar" width="230" '
    f'style="width: 230px; max-width: 80%; height: auto; display: inline-block; border: 0; '
    f'font-family: {SERIF}; font-size: 26px; font-weight: 600; color: {VIOLETA};" />'
    "</a>"
)
# Upstream name, kept so existing imports (services/auth/magic_login.py) work.
LOGO_SVG = PLATFORM_LOGO_HTML

# Shared email styles. The content block is centered (buttons and codes sit in
# the middle); titles and text are left-aligned, like the site's letters.
STYLES = {
    "body": f"margin: 0; padding: 0; background-color: {NUBE}; font-family: {SANS};",
    "wrapper": "padding: 24px 12px;",
    "container": (
        f"max-width: 560px; margin: 0 auto; background-color: {BLANCO_CALIDO}; border-radius: 24px; "
        f"overflow: hidden; border: 1px solid {BORDE};"
    ),
    "band": (
        f"height: 6px; line-height: 6px; font-size: 1px; background-color: {ROSA_300}; "
        f"background-image: linear-gradient(90deg, {ROSA_300}, {LAVANDA_300});"
    ),
    "header": "padding: 30px 28px 4px 28px; text-align: center;",
    "content": "padding: 22px 28px 30px 28px; text-align: center;",
    "eyebrow": (
        f"margin: 0 0 10px 0; font-size: 12px; font-weight: 600; letter-spacing: 0.18em; "
        f"text-transform: uppercase; color: {ROSA_600}; text-align: left;"
    ),
    "h1": (
        f"margin: 0 0 16px 0; font-family: {SERIF}; font-size: 28px; font-weight: 600; color: {VIOLETA}; "
        "letter-spacing: -0.01em; line-height: 1.25; text-align: left;"
    ),
    "p": (
        f"margin: 0 0 18px 0; font-size: 16px; color: {VIOLETA_600}; font-weight: 400; line-height: 1.7; "
        "text-align: left;"
    ),
    "button": (
        f"display: inline-block; margin: 8px 0 6px 0; padding: 16px 34px; background-color: {VIOLETA}; "
        f"color: {NUBE}; text-decoration: none; border-radius: 999px; font-size: 15px; font-weight: 600; "
        "line-height: 1.2;"
    ),
    "link_text": (
        f"margin: 20px 0 0 0; font-size: 12px; color: {VIOLETA_400}; word-break: break-all; font-weight: 400; "
        "line-height: 1.6; text-align: left;"
    ),
    "divider": f"margin: 0 0 20px 0; border: none; border-top: 1px solid {BORDE};",
    "footer": "padding: 0 28px 30px 28px; text-align: center;",
    "footer_text": f"margin: 0; font-size: 12px; color: {VIOLETA_400}; font-weight: 400; line-height: 1.6;",
    "footer_link": f"color: {VIOLETA_600}; text-decoration: none; font-weight: 600;",
    "code": (
        f"display: inline-block; padding: 14px 28px; background-color: {LAVANDA_100}; "
        f"border: 1px dashed {LAVANDA_300}; border-radius: 16px; font-size: 30px; font-weight: 700; "
        f"letter-spacing: 0.14em; color: {LAVANDA_700}; font-family: 'Courier New', monospace;"
    ),
}


def _brand_logo_html(logo_url: str | None, org_name: str) -> str:
    """Header mark for an org-branded email.

    Sanar y Criar: always the website's logo (one brand, client request
    2026-11). The org's uploaded square logo is the pink seal, which reads as
    an avatar rather than a header; ``logo_url``/``org_name`` are kept in the
    signature so the upstream call sites stay untouched.
    """
    return PLATFORM_LOGO_HTML


def _button_style(brand_color: str | None) -> str:
    """CTA button style: the site's violet pill.

    Sanar y Criar: the button keeps the website's colors whatever the org's
    accent says (the panel's color is the same violet), so every email matches
    the site. ``brand_color`` stays in the signature for the upstream callers.
    """
    return STYLES["button"]


def _powered_by_html(lang: str) -> str:
    """The brand line under the footer links ("Sanar y Criar · Hilda …")."""
    return (
        f'\n            <p style="{STYLES["footer_text"]} margin-top: 6px;">'
        f'{t(lang, "common.powered_by")}</p>'
    )


def _signature_html() -> str:
    """Hilda's sign-off, as in the website's letters: photo, "Con cariño", name."""
    return f"""
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
                       style="margin: 26px 0 0 0; border-collapse: collapse;">
                  <tr><td align="left" style="text-align: left;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse;">
                  <tr>
                    <td style="padding: 0 14px 0 0; vertical-align: middle;">
                      <img src="{EMAIL_AVATAR_URL}" alt="Hilda" width="56" height="56"
                           style="width: 56px; height: 56px; border-radius: 50%; display: block; border: 2px solid {ROSA_300};" />
                    </td>
                    <td style="vertical-align: middle; text-align: left;">
                      <div style="font-family: {SERIF}; font-style: italic; font-size: 17px; color: {LAVANDA_500}; line-height: 1.3;">Con cariño,</div>
                      <div style="font-family: {SERIF}; font-size: 18px; font-weight: 600; color: {VIOLETA}; line-height: 1.3;">Hilda Hernández</div>
                      <div style="font-size: 12px; color: {VIOLETA_400}; line-height: 1.5;">Psicóloga infanto-juvenil</div>
                    </td>
                  </tr>
                </table>
                  </td></tr>
                </table>"""


def _first_sentence(text: str, limit: int = 110) -> str:
    """Opening sentence of a body string, for use as preheader text.

    Handles the full stops of every locale we ship (the CJK ideographic
    period, the Arabic and Devanagari terminators), then falls back to a word
    boundary. Inbox previews are cut around 100 characters anyway.
    """
    if not text:
        return ""

    for terminator in ("。", "۔", "।", ". ", "! ", "? ", "؟ "):
        head, sep, _tail = text.partition(terminator)
        if sep and len(head) <= limit:
            return (head + sep).strip()

    if len(text) <= limit:
        return text.strip()
    return text[:limit].rsplit(" ", 1)[0].strip() + "…"


def _reply_to_address() -> str:
    """Where a reply to a lifecycle email should land, or "" if unconfigured."""
    try:
        from config.config import get_learnhouse_config

        return (get_learnhouse_config().contact_email or "").strip()
    except Exception:  # pragma: no cover - config is always present in practice
        return ""


def _stat_strip(stats: list[tuple[str, int]]) -> str:
    """A row of label/value pairs, e.g. "LESSONS 8   LEARNERS 0".

    Deliberately not prose. Writing "8 lessons" into copy means solving plural
    agreement in twenty languages (Russian has three forms, Arabic six), and
    without an ICU library the result is "1 lessons" in production. A label
    beside a bare figure needs no agreement in any of them, and it reads faster
    than a sentence anyway.
    """
    if not stats:
        return ""

    cells = []
    for label, value in stats:
        cells.append(
            '<td style="padding: 0 14px; text-align: center;">'
            f'<div style="font-family: {SERIF}; font-size: 24px; font-weight: 600; color: {VIOLETA}; '
            f'line-height: 1.2;">{value}</div>'
            '<div style="font-size: 10px; font-weight: 600; letter-spacing: 0.12em; '
            f'text-transform: uppercase; color: {VIOLETA_400}; margin-top: 2px;">'
            f"{html.escape(label)}</div>"
            "</td>"
        )

    return (
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
        'align="center" style="margin: 0 auto 24px auto; border-collapse: collapse;">'
        f"<tr>{''.join(cells)}</tr>"
        "</table>"
    )


def _preheader_block(text: str) -> str:
    """The grey line an inbox list shows after the subject.

    Without one, clients scrape the first visible text, which here is the
    heading, so the list entry reads as the subject said twice. Setting it
    explicitly buys a second line of information in the only place a reader
    looks before deciding to open.

    The zero-width padding after the text stops the client continuing into the
    body copy once the preheader runs out.
    """
    if not text:
        return ""
    padding = "&#847;&zwnj;&nbsp;" * 60
    hide = (
        "display:none;max-height:0;overflow:hidden;mso-hide:all;"
        "font-size:1px;line-height:1px;color:#ffffff;opacity:0;"
    )
    return (
        f'<div style="{hide}">{html.escape(text)}</div>'
        f'<div style="{hide}">{padding}</div>'
    )


def _email_layout(
    title: str,
    body_content: str,
    footer_note: str = "",
    logo_html: str = PLATFORM_LOGO_HTML,
    unsubscribe_url: str = "",
    unsubscribe_label: str = "Unsubscribe from these emails",
    preheader: str = "",
    powered_by: bool = False,
    lang: str = DEFAULT_LANGUAGE,
    eyebrow: str = "",
    signature: bool = False,
) -> str:
    """Wrap content in the standard email layout.

    Sanar y Criar (2026-11): the website's look. A cream page, a warm white
    card with a rosa-to-lavanda band on top, the site logo, then the body.
    ``eyebrow`` is the small rosa label over the title ("Tu cuenta", "Tu
    pedido"); ``signature`` adds Hilda's sign-off with her photo (mail to
    clients, not the admin notices). Every footer links the website and
    Instagram; ``powered_by`` adds the brand line under them ("Sanar y Criar ·
    Hilda Hernández, psicóloga infanto-juvenil").

    ``unsubscribe_url`` is set only by bulk lifecycle mail. Transactional email
    (password reset, invitation, verification) leaves it empty; you cannot
    unsubscribe from a password reset. The link is deliberately legible rather
    than hidden: someone who wants out and can't find the exit reports spam
    instead, which costs the sending domain far more than the opt-out does.
    """
    note_html = ""
    if footer_note:
        note_html = f'\n            <p style="{STYLES["footer_text"]} margin-bottom: 14px;">{footer_note}</p>'

    unsub_html = ""
    if unsubscribe_url:
        unsub_html = (
            f'\n            <p style="{STYLES["footer_text"]} margin-bottom: 14px;">'
            f'<a href="{html.escape(unsubscribe_url)}" '
            f'style="color: {VIOLETA_400}; text-decoration: underline;">'
            f'{html.escape(unsubscribe_label)}</a></p>'
        )

    links_html = (
        f'\n            <p style="{STYLES["footer_text"]}">'
        f'<a href="{SITE_URL}" style="{STYLES["footer_link"]}">sanarycriarve.com</a>'
        "&nbsp;&middot;&nbsp;"
        f'<a href="{INSTAGRAM_URL}" style="{STYLES["footer_link"]}">Instagram @sanarycriarve</a></p>'
    )
    powered_html = _powered_by_html(lang) if powered_by else ""

    eyebrow_html = f'<p style="{STYLES["eyebrow"]}">{html.escape(eyebrow)}</p>' if eyebrow else ""
    signature_html = _signature_html() if signature else ""

    block = _preheader_block(preheader)
    preheader_html = f"\n    {block}" if block else ""

    return f"""<!DOCTYPE html>
<html lang="{html.escape(lang or DEFAULT_LANGUAGE)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,600;1,500&amp;family=Poppins:wght@400;600&amp;display=swap" rel="stylesheet">
<title>{html.escape(html.unescape(title or ""))}</title>
<!--[if mso]><style>body, table, td, div, p, a, span {{ font-family: Arial, Helvetica, sans-serif !important; }} h1 {{ font-family: Georgia, serif !important; }}</style><![endif]-->
</head>
<body style="{STYLES['body']}">{preheader_html}
    <div style="{STYLES['wrapper']}">
        <!--[if mso]><table role="presentation" width="560" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
        <div style="{STYLES['container']}">
            <div style="{STYLES['band']}">&nbsp;</div>
            <div style="{STYLES['header']}">
                {logo_html}
            </div>
            <div style="{STYLES['content']}">
                {eyebrow_html}
                {body_content}
                {signature_html}
            </div>
            <div style="{STYLES['footer']}">
                <hr style="{STYLES['divider']}" />{note_html}{unsub_html}{links_html}{powered_html}
            </div>
        </div>
        <!--[if mso]></td></tr></table><![endif]-->
    </div>
</body>
</html>"""


def send_account_creation_email(
    user: UserRead,
    email: EmailStr,
    lang: str = DEFAULT_LANGUAGE,
    cta_url: str | None = None,
    org_name: str | None = None,
    logo_url: str | None = None,
    sender_name: str | None = None,
    brand_color: str | None = None,
    powered_by: bool = True,
):
    """Welcome email sent once an account exists.

    ``cta_url`` is where "Get Started" lands: the org-scoped URL when the
    account was created inside an org, or the platform org-picker for org-less
    signups. Falls back to the public academy when no URL is supplied.

    When ``org_name`` is set the email is WHITE-LABELED to that organization:
    the subject and body name the org (not LearnHouse), the org's ``logo_url``
    (or its name) replaces the LearnHouse mark, the button takes the org's
    ``brand_color``, and the footer is reduced to a "Powered by LearnHouse"
    line that ``powered_by=False`` removes. Org-less signups keep the
    LearnHouse-branded variant with the Academy footer link.

    Sanar y Criar: greets by ``user.first_name``, never by username (see
    ``named_copy``); the subject carries the name unescaped (plain text).
    """
    white_label = bool(org_name)
    safe_org = html.escape(email_org_name(org_name)) if org_name else ""

    heading = named_copy(lang, "account_creation.heading", user.first_name)
    cta = t(lang, "account_creation.cta")

    if white_label:
        subject = named_copy(
            lang, "account_creation.subject_org", user.first_name, escape=False, org_name=safe_org
        )
        body_text = t(lang, "account_creation.body_in_org", org_name=safe_org)
        footer_note = ""
        logo_html = _brand_logo_html(logo_url, org_name)
    else:
        subject = named_copy(lang, "account_creation.subject", user.first_name, escape=False)
        body_text = t(lang, "account_creation.body")
        academy_link = (
            f'<a href="{ACADEMY_URL}" '
            f'style="color: {VIOLETA_600}; text-decoration: underline;">'
            f'{t(lang, "academy_link_text")}</a>'
        )
        footer_note = t(lang, "account_creation.footer", academy_link=academy_link)
        logo_html = PLATFORM_LOGO_HTML

    body_content = f"""
        <h1 style="{STYLES['h1']}">{heading}</h1>
        <p style="{STYLES['p']}">
            {body_text}
        </p>
        <a href="{html.escape(cta_url or ACADEMY_URL)}" style="{_button_style(brand_color if white_label else None)}">
            {cta}
        </a>
    """

    return _send_notification_email(
        to=email,
        subject=subject,
        body=_email_layout(
            title=heading,
            body_content=body_content,
            footer_note=footer_note,
            logo_html=logo_html,
            powered_by=white_label and powered_by,
            lang=lang,
            eyebrow="Tu cuenta",
            signature=True,
        ),
        sender_name=sender_name,
    )


def send_org_created_email(
    email: EmailStr,
    org_name: str,
    dashboard_url: str,
    lang: str = DEFAULT_LANGUAGE,
):
    """Confirmation email when a user creates a new organization."""
    safe_name = html.escape(email_org_name(org_name))
    heading = t(lang, "org_created.heading", org_name=safe_name)
    body_text = t(lang, "org_created.body")
    cta = t(lang, "org_created.cta")

    body_content = f"""
        <h1 style="{STYLES['h1']}">{heading}</h1>
        <p style="{STYLES['p']}">{body_text}</p>
        <a href="{html.escape(dashboard_url)}" style="{STYLES['button']}">{cta}</a>
    """
    return _send_notification_email(
        to=email,
        subject=t(lang, "org_created.subject", org_name=safe_name),
        body=_email_layout(
            title=heading,
            body_content=body_content,
            footer_note=t(lang, "org_created.footer"),
        ),
    )


def send_org_deleted_email(
    email: EmailStr,
    org_name: str,
    lang: str = DEFAULT_LANGUAGE,
):
    """Confirmation email sent to org admins after an organization is deleted."""
    safe_name = html.escape(email_org_name(org_name))
    heading = t(lang, "org_deleted.heading", org_name=safe_name)
    body_text = t(lang, "org_deleted.body")

    body_content = f"""
        <h1 style="{STYLES['h1']}">{heading}</h1>
        <p style="{STYLES['p']}">{body_text}</p>
    """
    return _send_notification_email(
        to=email,
        subject=t(lang, "org_deleted.subject", org_name=safe_name),
        body=_email_layout(
            title=heading,
            body_content=body_content,
            footer_note=t(lang, "org_deleted.footer"),
        ),
    )


def send_account_deleted_email(
    email: EmailStr,
    username: str = "",
    lang: str = DEFAULT_LANGUAGE,
):
    """Confirmation ('goodbye') email sent after an account is deleted."""
    heading = t(lang, "account_deleted.heading")
    body_text = t(lang, "account_deleted.body")

    body_content = f"""
        <h1 style="{STYLES['h1']}">{heading}</h1>
        <p style="{STYLES['p']}">{body_text}</p>
    """
    return _send_notification_email(
        to=email,
        subject=t(lang, "account_deleted.subject"),
        body=_email_layout(
            title=heading,
            body_content=body_content,
            footer_note=t(lang, "account_deleted.footer"),
            eyebrow="Tu cuenta",
        ),
    )


def send_email_changed_notice(
    email: EmailStr,
    new_email: str,
    username: str = "",
    lang: str = DEFAULT_LANGUAGE,
    first_name: str = "",
):
    """Tell the previous address that the account's email was changed, so a
    hijacked session cannot quietly move the account to another inbox.

    Sanar y Criar: greets by ``first_name`` (``named_copy``); ``username``
    is no longer used and stays for upstream callers.
    """
    heading = t(lang, "email_changed.heading")
    body_text = named_copy(
        lang, "email_changed.body", first_name, new_email=html.escape(new_email)
    )

    body_content = f"""
        <h1 style="{STYLES['h1']}">{heading}</h1>
        <p style="{STYLES['p']}">{body_text}</p>
    """
    return _send_notification_email(
        to=email,
        subject=t(lang, "email_changed.subject"),
        body=_email_layout(
            title=heading,
            body_content=body_content,
            footer_note=t(lang, "email_changed.footer"),
            eyebrow="Tu cuenta",
        ),
    )


def send_password_reset_email(
    generated_reset_code: str,
    user: UserRead,
    organization: OrganizationRead,
    email: EmailStr,
    base_url: str,
    lang: str = DEFAULT_LANGUAGE,
    sender_name: str | None = None,
    logo_url: str | None = None,
    brand_color: str | None = None,
    powered_by: bool = True,
):
    """Password reset for an account inside an organization.

    Branded to the org: its logo (or name) in the header, its color on the
    button, its name as the From display name. Platform-level resets go
    through ``send_password_reset_email_platform`` instead.

    Sanar y Criar: greets by ``user.first_name``, never by username.
    """
    safe_code = html.escape(generated_reset_code)
    safe_email = quote(str(email), safe='')
    safe_code_param = quote(generated_reset_code, safe='')
    reset_url = html.escape(f"{base_url}/reset?email={safe_email}&resetCode={safe_code_param}")

    heading = t(lang, "password_reset.heading")
    body_text = named_copy(lang, "password_reset.body", user.first_name)
    cta = t(lang, "password_reset.cta")

    body_content = f"""
        <h1 style="{STYLES['h1']}">{heading}</h1>
        <p style="{STYLES['p']}">
            {body_text}
        </p>
        <div style="margin: 28px 0;">
            <span style="{STYLES['code']}">{safe_code}</span>
        </div>
        <a href="{reset_url}" style="{_button_style(brand_color)}">
            {cta}
        </a>
    """

    return send_email(
        to=email,
        subject=t(lang, "password_reset.subject"),
        body=_email_layout(
            title=heading,
            body_content=body_content,
            footer_note=t(lang, "password_reset.footer_org"),
            logo_html=_brand_logo_html(logo_url, organization.name),
            powered_by=powered_by,
            lang=lang,
            eyebrow="Tu cuenta",
        ),
        sender_name=sender_name,
    )


def send_password_reset_email_platform(
    generated_reset_code: str,
    user: UserRead,
    email: EmailStr,
    base_url: str,
    lang: str = DEFAULT_LANGUAGE,
):
    # Sanar y Criar: greets by first name, never by username (named_copy).
    safe_code = html.escape(generated_reset_code)
    safe_email = quote(str(email), safe='')
    safe_code_param = quote(generated_reset_code, safe='')
    reset_url = html.escape(f"{base_url}/reset?email={safe_email}&resetCode={safe_code_param}")

    heading = t(lang, "password_reset.heading")
    body_text = named_copy(lang, "password_reset.body", user.first_name)
    cta = t(lang, "password_reset.cta")

    body_content = f"""
        <h1 style="{STYLES['h1']}">{heading}</h1>
        <p style="{STYLES['p']}">
            {body_text}
        </p>
        <div style="margin: 28px 0;">
            <span style="{STYLES['code']}">{safe_code}</span>
        </div>
        <a href="{reset_url}" style="{STYLES['button']}">
            {cta}
        </a>
    """

    return send_email(
        to=email,
        subject=t(lang, "password_reset.subject"),
        body=_email_layout(
            title=heading,
            body_content=body_content,
            footer_note=t(lang, "password_reset.footer_platform"),
            eyebrow="Tu cuenta",
        ),
    )


def send_invitation_email(
    email: EmailStr,
    org_name: str,
    inviter_username: str,
    signup_url: str,
    invite_code: Optional[str] = None,
    lang: str = DEFAULT_LANGUAGE,
    sender_name: str | None = None,
    logo_url: str | None = None,
    brand_color: str | None = None,
    powered_by: bool = True,
):
    """Invitation into an organization, branded to that organization."""
    safe_org_name = html.escape(email_org_name(org_name))
    safe_inviter = html.escape(email_user_name(inviter_username))

    code_section = ""
    if invite_code:
        safe_code = html.escape(invite_code)
        code_hint = t(lang, "invitation.code_hint")
        code_section = f"""
        <div style="margin: 28px 0;">
            <span style="{STYLES['code']}">{safe_code}</span>
        </div>
        <p style="{STYLES['p']}">
            {code_hint}
        </p>"""
    else:
        code_section = f"""
        <p style="{STYLES['p']}">
            {t(lang, "invitation.no_code_hint")}
        </p>"""

    heading = t(lang, "invitation.heading")
    intro = t(lang, "invitation.intro", inviter=safe_inviter, org_name=safe_org_name)
    cta = t(lang, "invitation.cta", org_name=safe_org_name)

    body_content = f"""
        <h1 style="{STYLES['h1']}">{heading}</h1>
        <p style="{STYLES['p']}">
            {intro}
        </p>
        {code_section}
        <a href="{html.escape(signup_url)}" style="{_button_style(brand_color)}">
            {cta}
        </a>
    """

    return send_email(
        to=email,
        subject=t(lang, "invitation.subject", org_name=safe_org_name),
        body=_email_layout(
            title=heading,
            body_content=body_content,
            footer_note=t(lang, "invitation.footer", inviter=safe_inviter),
            logo_html=_brand_logo_html(logo_url, org_name),
            powered_by=powered_by,
            lang=lang,
            eyebrow="Invitación",
        ),
        sender_name=sender_name,
    )


def send_org_join_email(
    email: EmailStr,
    username: str,
    org_name: str,
    cta_url: str,
    lang: str = DEFAULT_LANGUAGE,
    logo_url: str | None = None,
    sender_name: str | None = None,
    brand_color: str | None = None,
    powered_by: bool = True,
    first_name: str = "",
):
    """Greeting sent when an EXISTING account becomes a member of an organization.

    Complements ``send_account_creation_email``, which only fires for brand new
    accounts: a user who already had an account and then joined a second org
    (invite code, open join, OAuth invite, admin provisioning) previously got no
    mail at all and had to find their way to the org on their own.

    Always white-labeled to the org (the user is being welcomed into that
    academy, not onto LearnHouse), with the org's logo (or name) up top.

    Sanar y Criar: greets by ``first_name`` (``named_copy``); ``username``
    is no longer used and stays for upstream callers.
    """
    safe_org_name = html.escape(email_org_name(org_name))

    heading = named_copy(lang, "org_join.heading", first_name)
    body_text = t(lang, "org_join.body", org_name=safe_org_name)
    cta = t(lang, "org_join.cta")

    body_content = f"""
        <h1 style="{STYLES['h1']}">{heading}</h1>
        <p style="{STYLES['p']}">
            {body_text}
        </p>
        <a href="{html.escape(cta_url)}" style="{_button_style(brand_color)}">
            {cta}
        </a>
        <p style="{STYLES['link_text']}">{html.escape(cta_url)}</p>
    """

    return _send_notification_email(
        to=email,
        subject=t(lang, "org_join.subject", org_name=safe_org_name),
        body=_email_layout(
            title=heading,
            body_content=body_content,
            footer_note=t(lang, "org_join.footer", org_name=safe_org_name),
            logo_html=_brand_logo_html(logo_url, org_name),
            powered_by=powered_by,
            lang=lang,
            eyebrow="Tu cuenta",
            signature=True,
        ),
        sender_name=sender_name,
    )


def send_role_changed_email(
    email: EmailStr,
    username: str,
    org_name: str,
    new_role_name: str,
    lang: str = DEFAULT_LANGUAGE,
    cta_url: str | None = None,
    sender_name: str | None = None,
    logo_url: str | None = None,
    brand_color: str | None = None,
    powered_by: bool = True,
    first_name: str = "",
):
    """
    Send an email notifying a user that their role has changed in an organization.

    ``cta_url`` is the org's own landing page, on the org's host (verified
    custom domain when it has one). Without it the mail told someone their
    permissions had changed and then gave them nowhere to go.

    Sanar y Criar: greets by ``first_name`` (``named_copy``); ``username``
    is no longer used and stays for upstream callers.
    """
    safe_org_name = html.escape(email_org_name(org_name))
    safe_role_name = html.escape(new_role_name)

    heading = t(lang, "role_changed.heading")
    body_1 = named_copy(
        lang, "role_changed.body_1", first_name,
        org_name=safe_org_name, role=safe_role_name,
    )
    body_2 = t(lang, "role_changed.body_2")

    cta_html = ""
    if cta_url:
        cta_html = (
            f'<a href="{html.escape(cta_url)}" style="{_button_style(brand_color)}">'
            f'{t(lang, "role_changed.cta", org_name=safe_org_name)}</a>'
        )

    body_content = f"""
        <h1 style="{STYLES['h1']}">{heading}</h1>
        <p style="{STYLES['p']}">
            {body_1}
        </p>
        <p style="{STYLES['p']}">
            {body_2}
        </p>
        {cta_html}
    """

    return _send_notification_email(
        to=email,
        subject=t(lang, "role_changed.subject", org_name=safe_org_name),
        body=_email_layout(
            title=heading,
            body_content=body_content,
            footer_note=t(lang, "role_changed.footer", org_name=safe_org_name),
            logo_html=_brand_logo_html(logo_url, org_name),
            powered_by=powered_by,
            lang=lang,
            eyebrow="Tu cuenta",
        ),
        sender_name=sender_name,
    )


def send_email_verification_email(
    token: str,
    user: UserRead,
    organization: OrganizationRead | None,
    email: EmailStr,
    base_url: str,
    lang: str = DEFAULT_LANGUAGE,
    sender_name: str | None = None,
    logo_url: str | None = None,
    brand_color: str | None = None,
    powered_by: bool = True,
    return_path: str | None = None,
):
    """
    Send email verification email with verification link.

    With an ``organization`` the mail is branded to it (its name in the copy,
    its logo or name in the header, its color on the button). Without one it
    is a platform email under the LearnHouse mark.

    Args:
        token: Verification token
        user: User receiving the email
        organization: Organization context (can be None for no-org signups)
        email: Email address to send to
        base_url: Base URL for constructing the verification link
        lang: ISO 639-1 language code for email content (defaults to 'es')
        return_path: Sanar y Criar: page to land on once verified, added to
            the link as ``redirect`` (only a safe ``/regalo`` path)

    Returns:
        Boolean indicating if email was sent successfully

    Sanar y Criar: greets by ``user.first_name``, never by the (generated)
    username; without a first name it says "Hola," (``named_copy``).
    """
    # Sanar y Criar: org-less mail names our platform, not LearnHouse.
    brand = html.escape(email_org_name(organization.name)) if organization else PLATFORM_NAME
    safe_token = quote(token, safe='')
    safe_user_uuid = quote(user.user_uuid, safe='')
    org_uuid = organization.org_uuid if organization else "none"
    safe_org_uuid = quote(org_uuid, safe='')
    verification_url = f"{base_url}/verify-email?token={safe_token}&user={safe_user_uuid}&org={safe_org_uuid}"
    # Sanar y Criar: the web's verify page follows ``redirect`` first, so the
    # link lands back on the gift page from any browser.
    redirect_path = safe_return_path(return_path)
    if redirect_path:
        verification_url += f"&redirect={quote(redirect_path, safe='')}"
    verification_url = html.escape(verification_url)

    heading = t(lang, "email_verification.heading")
    body_text = named_copy(lang, "email_verification.body", user.first_name, brand=brand)
    cta = t(lang, "email_verification.cta")
    copy_paste = t(lang, "email_verification.copy_paste")

    body_content = f"""
        <h1 style="{STYLES['h1']}">{heading}</h1>
        <p style="{STYLES['p']}">
            {body_text}
        </p>
        <a href="{verification_url}" style="{_button_style(brand_color if organization else None)}">
            {cta}
        </a>
        <p style="{STYLES['link_text']}">
            {copy_paste}<br />{verification_url}
        </p>
    """

    return send_email(
        to=email,
        subject=t(lang, "email_verification.subject"),
        body=_email_layout(
            title=heading,
            body_content=body_content,
            footer_note=t(lang, "email_verification.footer", brand=brand),
            logo_html=_brand_logo_html(logo_url, organization.name) if organization else PLATFORM_LOGO_HTML,
            powered_by=bool(organization) and powered_by,
            lang=lang,
            eyebrow="Tu cuenta",
            signature=True,
        ),
        sender_name=sender_name,
    )


def send_nudge_email(
    nudge_id: str,
    email: EmailStr,
    org_name: str,
    cta_url: str,
    unsubscribe_url: str,
    lang: str = DEFAULT_LANGUAGE,
    logo_url: str | None = None,
    has_cta: bool = True,
    track: str = "",
    stats: list[tuple[str, int]] | None = None,
    sender_name: str | None = None,
    brand_color: str | None = None,
    powered_by: bool = True,
    **copy_vars,
):
    """Send one lifecycle nudge.

    Generic over the catalog: the nudge id selects its copy from the
    ``nudge.<id>.*`` namespace, so adding a nudge never means adding a function
    here. ``copy_vars`` fills the placeholders that nudge's strings declare
    (course name, plan name, and so on); every value is escaped before it
    reaches the template.

    ``track`` selects the illustration. It is drawn as a table mosaic rather
    than an image because Gmail strips inline SVG and both Gmail and Outlook
    block ``data:`` URIs, so an embedded picture would render as a blank gap
    for a large share of readers.

    Unlike transactional mail this always carries an unsubscribe link and the
    matching ``List-Unsubscribe`` headers. Gmail and Outlook expect them on
    bulk mail, and without them a run at any real volume puts the sending
    domain at risk.

    Failures are swallowed via ``_send_notification_email``: a nudge nobody
    asked for must never be the reason a batch job dies.
    """
    safe_org_name = html.escape(email_org_name(org_name))
    raw_vars = {key: str(value) for key, value in copy_vars.items() if value is not None}
    raw_vars.setdefault("org_name", org_name)
    safe_vars = {key: html.escape(value) for key, value in raw_vars.items()}

    heading = t(lang, f"nudge.{nudge_id}.heading", **safe_vars)
    body_text = t(lang, f"nudge.{nudge_id}.body", **safe_vars)
    # The subject is plain text, not HTML: escaping it would deliver
    # "Maths &amp; Physics" to the inbox, and ampersands in course names are
    # common enough that this is not an edge case.
    subject = t(lang, f"nudge.{nudge_id}.subject", **raw_vars)

    from src.services.nudges.illustrations import render_illustration

    stat_html = _stat_strip(
        [(t(lang, f"nudge.stat.{key}"), value) for key, value in (stats or [])]
    )

    body_content = f"""
        {render_illustration(track)}
        <h1 style="{STYLES['h1']}">{heading}</h1>
        <p style="{STYLES['p']}">
            {body_text}
        </p>
        {stat_html}"""
    if has_cta and cta_url:
        cta = t(lang, f"nudge.{nudge_id}.cta", **safe_vars)
        body_content += f"""
        <a href="{html.escape(cta_url)}" style="{_button_style(brand_color)}">
            {cta}
        </a>
        <p style="{STYLES['link_text']}">{html.escape(cta_url)}</p>
    """

    # The preheader is the body's opening sentence rather than a thirty-first
    # set of translated strings. It is already localised, and it gives the
    # inbox list a second line of information instead of echoing the subject.
    preheader = _first_sentence(t(lang, f"nudge.{nudge_id}.body", **raw_vars))

    headers: dict[str, str] = {}
    if unsubscribe_url:
        headers["List-Unsubscribe"] = f"<{unsubscribe_url}>"
        headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"

    # Several nudges invite a reply. Without this they would arrive from the
    # no-reply sender and the invitation would be a lie.
    reply_to = _reply_to_address()
    if reply_to:
        headers["Reply-To"] = reply_to

    return _send_notification_email(
        to=email,
        subject=subject,
        body=_email_layout(
            title=heading,
            body_content=body_content,
            footer_note=t(lang, "nudge.common.footer", org_name=safe_org_name),
            logo_html=_brand_logo_html(logo_url, org_name),
            unsubscribe_url=unsubscribe_url,
            unsubscribe_label=t(lang, "nudge.common.unsubscribe"),
            preheader=preheader,
            powered_by=powered_by,
            lang=lang,
        ),
        headers=headers or None,
        sender_name=sender_name,
    )

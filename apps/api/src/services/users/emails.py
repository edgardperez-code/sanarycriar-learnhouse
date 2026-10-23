import html
import logging
from typing import Optional
from urllib.parse import quote

from pydantic import EmailStr
from src.db.organizations import OrganizationRead
from src.db.users import UserRead
from src.services.email.safe_text import email_org_name, email_user_name
# Sanar y Criar: DEFAULT_LANGUAGE ("es") is the default `lang` below (was "en").
from src.services.email.translations import DEFAULT_LANGUAGE, PLATFORM_NAME, t
from src.services.email.utils import send_email

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


# Sanar y Criar: the platform mark of org-less mail is the "Sanar y Criar" text
# wordmark (the brand manual uses no image logo; same lockup as ScWordmark.tsx
# on the web), linked to our site. Plain HTML with inline styles, so it renders
# in every mail client (Gmail strips inline SVG). Replaces the LearnHouse SVG.
PLATFORM_LOGO_HTML = (
    f'<a href="{ACADEMY_URL}" style="text-decoration: none;">'
    '<span style="display: inline-block; font-family: Georgia, \'Times New Roman\', serif; '
    'font-size: 26px; font-weight: 600; color: #190933; letter-spacing: -0.01em; line-height: 1.2;">'
    'Sanar <em style="font-style: italic; font-weight: 500; color: #7D75E2;">y</em> Criar'
    "</span></a>"
)
# Upstream name, kept so existing imports (services/auth/magic_login.py) work.
LOGO_SVG = PLATFORM_LOGO_HTML

# Shared email styles matching the platform's design system
STYLES = {
    "body": "margin: 0; padding: 0; background-color: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;",
    "wrapper": "padding: 48px 24px;",
    "container": "max-width: 480px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e5e5e5;",
    "header": "padding: 48px 48px 0 48px; text-align: center;",
    "content": "padding: 36px 48px 48px 48px; text-align: center;",
    "h1": "margin: 0 0 12px 0; font-size: 22px; font-weight: 900; color: #000000; letter-spacing: -0.02em; line-height: 1.3;",
    "p": "margin: 0 0 20px 0; font-size: 14px; color: rgba(0,0,0,0.45); font-weight: 500; line-height: 1.7;",
    "button": "display: inline-block; padding: 14px 32px; background-color: #000000; color: #ffffff; text-decoration: none; border-radius: 10px; font-size: 14px; font-weight: 700; line-height: 1;",
    "link_text": "margin: 24px 0 0 0; font-size: 11px; color: rgba(0,0,0,0.2); word-break: break-all; font-weight: 500; line-height: 1.6;",
    "divider": "margin: 28px 0; border: none; border-top: 1px solid #f0f0f0;",
    "footer": "padding: 0 48px 40px 48px; text-align: center;",
    "footer_text": "margin: 0; font-size: 12px; color: rgba(0,0,0,0.2); font-weight: 500; line-height: 1.6;",
    "code": "display: inline-block; padding: 14px 28px; background-color: #fafafa; border: 1px solid #e5e5e5; border-radius: 10px; font-size: 28px; font-weight: 900; letter-spacing: 0.12em; color: #000000; font-family: monospace;",
}


# Media directory of the square logo variant (see ``upload_org_square_logo``).
# The URL path is the one place the shape of an uploaded logo is knowable
# without a database round-trip, so the renderer keys off it.
SQUARE_LOGO_DIR = "/square_logos/"


def _org_logo_img(logo_url: str, alt: str) -> str:
    """<img> for a white-labeled org logo.

    A square logo (uploaded on the branding page, served from
    ``square_logos/``) sits in a 56px rounded box; a wide logo is letterboxed
    into the same footprint as the LearnHouse wordmark. Raster logos (PNG/JPG)
    render in every mail client; an SVG logo may be stripped by some (e.g.
    Gmail), in which case the ``alt`` (the org name) shows instead: still
    org-branded, never a broken LearnHouse mark.

    The ``height``/``width`` attributes are for desktop Outlook, whose
    Word-based renderer ignores ``max-width``/``max-height`` and would
    otherwise paint the upload at its native pixel size; every other client
    lets the inline style win.
    """
    src = html.escape(logo_url)
    safe_alt = html.escape(alt)
    if SQUARE_LOGO_DIR in logo_url:
        return (
            f'<img src="{src}" alt="{safe_alt}" width="56" height="56" '
            'style="width: 56px; height: 56px; object-fit: cover; border-radius: 12px; '
            'display: inline-block; border: 0;" />'
        )
    return (
        f'<img src="{src}" alt="{safe_alt}" height="40" '
        'style="max-height: 40px; max-width: 180px; height: auto; width: auto; '
        'display: inline-block; border: 0;" />'
    )


def _org_wordmark(org_name: str) -> str:
    """The org's name set as a wordmark, for orgs that have not uploaded a logo.

    An org-scoped email must never open with the LearnHouse mark. The
    recipient has a relationship with the academy, not the platform, and a
    foreign logo above "Reset your Acme Academy password" reads as phishing.
    """
    return (
        f'<span style="display: inline-block; font-size: 20px; font-weight: 900; '
        f'color: #000000; letter-spacing: -0.02em; line-height: 1.2;">'
        f"{html.escape(email_org_name(org_name))}</span>"
    )


def _brand_logo_html(logo_url: str | None, org_name: str) -> str:
    """Header mark for an org-branded email: its logo, else its name."""
    if logo_url:
        return _org_logo_img(logo_url, org_name)
    return _org_wordmark(org_name)


def _button_style(brand_color: str | None) -> str:
    """CTA button style, tinted with the org's brand color when it has one.

    ``brand_color`` must already be normalized (``#rrggbb``); see
    ``services.email.branding.normalize_brand_color``; anything else keeps the
    default black button rather than risk an unbalanced ``style`` attribute.
    """
    from src.services.email.branding import contrasting_text_color, normalize_brand_color

    color = normalize_brand_color(brand_color)
    if not color:
        return STYLES["button"]
    return (
        STYLES["button"]
        .replace("background-color: #000000;", f"background-color: {color};")
        .replace("color: #ffffff;", f"color: {contrasting_text_color(color)};")
    )


def _powered_by_html(lang: str) -> str:
    """The small "Powered by LearnHouse" line under an org-branded footer."""
    from src.services.email.branding import POWERED_BY_URL

    return (
        f'\n            <p style="{STYLES["footer_text"]} margin-top: 12px;">'
        f'<a href="{POWERED_BY_URL}" style="color: rgba(0,0,0,0.35); text-decoration: none;">'
        f'{t(lang, "common.powered_by")}</a></p>'
    )


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
            '<div style="font-size: 22px; font-weight: 900; color: #000000; '
            f'line-height: 1.2;">{value}</div>'
            '<div style="font-size: 10px; font-weight: 700; letter-spacing: 0.08em; '
            'text-transform: uppercase; color: rgba(0,0,0,0.35); margin-top: 2px;">'
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
) -> str:
    """Wrap content in the standard email layout.

    ``logo_html`` defaults to the platform mark (Sanar y Criar: our text
    wordmark, ``PLATFORM_LOGO_HTML``); white-labeled emails pass the org's
    logo <img> (or its name as a wordmark) instead.

    ``powered_by`` adds the "Powered by LearnHouse" line to the footer. Only
    org-branded mail sets it, and only when the org's watermark is on; a
    platform email already carries the LearnHouse mark up top.

    ``unsubscribe_url`` is set only by bulk lifecycle mail. Transactional email
    (password reset, invitation, verification) leaves it empty and renders
    byte-identically to before; you cannot unsubscribe from a password reset.
    The link is deliberately legible rather than hidden: someone who wants out
    and can't find the exit reports spam instead, which costs the sending domain
    far more than the opt-out does.
    """
    note_html = ""
    if footer_note:
        note_html = f'\n            <p style="{STYLES["footer_text"]}">{footer_note}</p>'

    unsub_html = ""
    if unsubscribe_url:
        unsub_html = (
            f'\n            <p style="{STYLES["footer_text"]} margin-top: 12px;">'
            f'<a href="{html.escape(unsubscribe_url)}" '
            'style="color: rgba(0,0,0,0.35); text-decoration: underline;">'
            f'{html.escape(unsubscribe_label)}</a></p>'
        )

    powered_html = _powered_by_html(lang) if powered_by else ""

    footer_html = ""
    if note_html or unsub_html or powered_html:
        footer_html = f"""
        <div style="{STYLES['footer']}">
            <hr style="{STYLES['divider']}" />{note_html}{unsub_html}{powered_html}
        </div>"""

    # Prefixed with its own newline so that an absent preheader leaves the
    # document byte-identical to before; the twelve transactional emails
    # share this layout and none of their output may shift.
    block = _preheader_block(preheader)
    preheader_html = f"\n    {block}" if block else ""

    return f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="{STYLES['body']}">{preheader_html}
    <div style="{STYLES['wrapper']}">
        <div style="{STYLES['container']}">
            <div style="{STYLES['header']}">
                {logo_html}
            </div>
            <div style="{STYLES['content']}">
                {body_content}
            </div>
            {footer_html}
        </div>
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
    """
    safe_username = html.escape(email_user_name(user.username))
    white_label = bool(org_name)
    safe_org = html.escape(email_org_name(org_name)) if org_name else ""

    heading = t(lang, "account_creation.heading", username=safe_username)
    cta = t(lang, "account_creation.cta")

    if white_label:
        subject = t(lang, "account_creation.subject_org", org_name=safe_org, username=safe_username)
        body_text = t(lang, "account_creation.body_in_org", org_name=safe_org)
        footer_note = ""
        logo_html = _brand_logo_html(logo_url, org_name)
    else:
        subject = t(lang, "account_creation.subject", username=safe_username)
        body_text = t(lang, "account_creation.body")
        academy_link = (
            f'<a href="{ACADEMY_URL}" '
            'style="color: rgba(0,0,0,0.35); text-decoration: underline;">'
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
        ),
    )


def send_email_changed_notice(
    email: EmailStr,
    new_email: str,
    username: str = "",
    lang: str = DEFAULT_LANGUAGE,
):
    """Tell the previous address that the account's email was changed, so a
    hijacked session cannot quietly move the account to another inbox."""
    safe_username = html.escape(email_user_name(username))
    heading = t(lang, "email_changed.heading")
    body_text = t(
        lang, "email_changed.body", username=safe_username, new_email=html.escape(new_email)
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
    """
    safe_username = html.escape(email_user_name(user.username))
    safe_code = html.escape(generated_reset_code)
    safe_email = quote(str(email), safe='')
    safe_code_param = quote(generated_reset_code, safe='')
    reset_url = html.escape(f"{base_url}/reset?email={safe_email}&resetCode={safe_code_param}")

    heading = t(lang, "password_reset.heading")
    body_text = t(lang, "password_reset.body", username=safe_username)
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
    safe_username = html.escape(email_user_name(user.username))
    safe_code = html.escape(generated_reset_code)
    safe_email = quote(str(email), safe='')
    safe_code_param = quote(generated_reset_code, safe='')
    reset_url = html.escape(f"{base_url}/reset?email={safe_email}&resetCode={safe_code_param}")

    heading = t(lang, "password_reset.heading")
    body_text = t(lang, "password_reset.body", username=safe_username)
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
):
    """Greeting sent when an EXISTING account becomes a member of an organization.

    Complements ``send_account_creation_email``, which only fires for brand new
    accounts: a user who already had an account and then joined a second org
    (invite code, open join, OAuth invite, admin provisioning) previously got no
    mail at all and had to find their way to the org on their own.

    Always white-labeled to the org (the user is being welcomed into that
    academy, not onto LearnHouse), with the org's logo (or name) up top.
    """
    safe_username = html.escape(email_user_name(username))
    safe_org_name = html.escape(email_org_name(org_name))

    heading = t(lang, "org_join.heading", username=safe_username)
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
):
    """
    Send an email notifying a user that their role has changed in an organization.

    ``cta_url`` is the org's own landing page, on the org's host (verified
    custom domain when it has one). Without it the mail told someone their
    permissions had changed and then gave them nowhere to go.
    """
    safe_username = html.escape(email_user_name(username))
    safe_org_name = html.escape(email_org_name(org_name))
    safe_role_name = html.escape(new_role_name)

    heading = t(lang, "role_changed.heading")
    body_1 = t(
        lang, "role_changed.body_1",
        username=safe_username, org_name=safe_org_name, role=safe_role_name,
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

    Returns:
        Boolean indicating if email was sent successfully
    """
    safe_username = html.escape(email_user_name(user.username))
    # Sanar y Criar: org-less mail names our platform, not LearnHouse.
    brand = html.escape(email_org_name(organization.name)) if organization else PLATFORM_NAME
    safe_token = quote(token, safe='')
    safe_user_uuid = quote(user.user_uuid, safe='')
    org_uuid = organization.org_uuid if organization else "none"
    safe_org_uuid = quote(org_uuid, safe='')
    verification_url = html.escape(
        f"{base_url}/verify-email?token={safe_token}&user={safe_user_uuid}&org={safe_org_uuid}"
    )

    heading = t(lang, "email_verification.heading")
    body_text = t(lang, "email_verification.body", username=safe_username, brand=brand)
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

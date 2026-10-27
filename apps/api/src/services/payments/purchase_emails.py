"""Sanar y Criar: the four emails of a Pago Móvil purchase.

1. Purchase created (buyer): how to pay, the WhatsApp button, the deadline.
2. New purchase (admin, ``notify_email``): who bought what, link to Pedidos.
3. Payment confirmed (buyer): every course/ebook of the purchase.
4. Payment rejected (buyer, optional): the reason and a WhatsApp link.

Same look as ``fulfillment._purchase_email_html`` (org branding, Spanish).
The request renders each email (URLs included) and only the delivery runs in
the background: ``asyncio.to_thread(send_email, ...)`` in a task kept in
``_background`` (the loop only holds weak references). Delivery never raises
into a request; tests await ``drain_background_tasks()``.
"""

import asyncio
import html
import logging
from dataclasses import dataclass
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Callable, Optional

from src.services.payments.common import as_utc
from src.services.payments.fx import CARACAS_TZ

logger = logging.getLogger(__name__)

# Strong references to the deliveries scheduled on the running loop.
_background: set = set()


# --------------------------------------------------------------- formatting


def format_bs(value) -> str:
    """Amount with the es-VE separators: ``35.492,08`` (also used for US$)."""
    amount = Decimal(str(value if value is not None else 0)).quantize(Decimal("0.01"), ROUND_HALF_UP)
    text = f"{amount:,.2f}"
    return text.replace(",", "\x00").replace(".", ",").replace("\x00", ".")


def format_rate(value) -> str:
    """A Bs./US$ rate with 2 decimals, as the web shows it: ``887,30``."""
    return format_bs(value)


def format_date(value: Optional[date]) -> str:
    return value.strftime("%d/%m/%Y") if value else ""


def format_caracas(value: Optional[datetime]) -> str:
    """``28/10/2026, 3:45 p. m.`` in America/Caracas."""
    value = as_utc(value)
    if value is None:
        return ""
    local = value.astimezone(CARACAS_TZ)
    hour = local.hour % 12 or 12
    suffix = "a. m." if local.hour < 12 else "p. m."
    return f"{local:%d/%m/%Y}, {hour}:{local.minute:02d} {suffix}"


def rate_line(rate, source: str, rate_date: Optional[date]) -> str:
    if source == "manual":
        return f"Tasa fijada por Sanar y Criar: {format_rate(rate)} Bs. por US$"
    when = f" del {format_date(rate_date)}" if rate_date else ""
    return f"Tasa BCV{when}: {format_rate(rate)} Bs. por US$"


# --------------------------------------------------------------- delivery


def schedule_email(to: Optional[str], subject: str, body: str, sender_name: Optional[str], label: str) -> bool:
    """Send one email after the response, never raising. True when scheduled."""
    if not to:
        return False
    try:
        # Resolved now, in the request: the task may outlive a test's patch.
        from src.services.email import utils as email_utils

        sender: Callable = email_utils.send_email
        task = asyncio.get_running_loop().create_task(_deliver(sender, to, subject, body, sender_name, label))
    except Exception:
        logger.warning("Could not schedule the Pago Móvil email %s", label, exc_info=True)
        return False
    _background.add(task)
    task.add_done_callback(_background.discard)
    return True


async def _deliver(sender: Callable, to: str, subject: str, body: str, sender_name: Optional[str],
                   label: str) -> None:
    try:
        await asyncio.to_thread(sender, to=to, subject=subject, body=body, sender_name=sender_name or None)
    except Exception:
        logger.warning("Pago Móvil email %s failed", label, exc_info=True)


async def drain_background_tasks() -> None:
    """Wait for every email scheduled on this loop (tests use it)."""
    loop = asyncio.get_running_loop()
    while True:
        pending = [task for task in _background if task.get_loop() is loop and not task.done()]
        if not pending:
            return
        await asyncio.gather(*pending, return_exceptions=True)


# ---------------------------------------------------------------- rendering


@dataclass
class ItemLine:
    name: str
    amount: Decimal


def _e(value) -> str:
    return html.escape(str(value or ""))


def _code(code: str) -> str:
    """The purchase code, never split across two lines (``SYC-`` has a dash)."""
    return f'<span style="white-space: nowrap;">{_e(code)}</span>'


def _layout(branding, *, title: str, body: str, preheader: str, footer: str) -> str:
    from src.services.users.emails import _brand_logo_html, _email_layout

    return _email_layout(
        title=title,
        body_content=body,
        footer_note=footer,
        logo_html=_brand_logo_html(branding.logo_url, branding.org_name or "Sanar y Criar"),
        preheader=preheader,
        powered_by=branding.powered_by,
        lang="es",
    )


def _styles() -> dict:
    from src.services.users.emails import STYLES

    return STYLES


def _button(branding, url: str, label: str) -> str:
    from src.services.users.emails import _button_style

    return f'<a href="{_e(url)}" style="{_button_style(branding.brand_color)}">{_e(label)}</a>'


def _items_table(items: list[ItemLine]) -> str:
    rows = "".join(
        '<tr>'
        f'<td style="padding: 6px 0; text-align: left; color: #000000; font-weight: 600;">{_e(item.name)}</td>'
        f'<td style="padding: 6px 0 6px 12px; text-align: right; white-space: nowrap;">US$ {format_bs(item.amount)}</td>'
        '</tr>'
        for item in items
    )
    return (
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
        'style="margin: 0 0 20px 0; border-collapse: collapse; font-size: 14px; color: rgba(0,0,0,0.6);">'
        f"{rows}</table>"
    )


def _details_table(rows: list[tuple[str, str]]) -> str:
    cells = "".join(
        '<tr>'
        f'<td style="padding: 8px 12px; text-align: left; color: rgba(0,0,0,0.45);">{_e(label)}</td>'
        f'<td style="padding: 8px 12px 8px 0; text-align: left; color: #000000; font-weight: 700;">{_e(value)}</td>'
        '</tr>'
        for label, value in rows if value
    )
    return (
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
        'style="margin: 0 0 20px 0; border-collapse: separate; font-size: 14px; background-color: #fafafa; '
        f'border: 1px solid #eeeeee; border-radius: 10px;">{cells}</table>'
    )


def _paragraphs(text: str) -> str:
    return "<br>".join(_e(line) for line in (text or "").split("\n"))


def render_created(*, branding, first_name: str, code: str, items: list[ItemLine], amount, amount_ves,
                   rate, rate_source: str, rate_date: Optional[date], expires_at: datetime,
                   payment: dict, whatsapp_url: Optional[str], purchase_url: str) -> tuple[str, str]:
    styles = _styles()
    greeting = f"Hola, {first_name}" if first_name else "Hola"
    bank = payment.get("bank_name") or ""
    if payment.get("bank_code"):
        bank = f"{bank} ({payment['bank_code']})" if bank else payment["bank_code"]
    details = _details_table([
        ("Banco", bank),
        ("Teléfono", payment.get("phone") or ""),
        ("Cédula o RIF", payment.get("id_document") or ""),
        ("Titular", payment.get("holder_name") or ""),
        ("Monto", f"Bs. {format_bs(amount_ves)}"),
    ])
    instructions = payment.get("instructions") or ""
    instructions_html = (
        f'<p style="{styles["p"]} text-align: left;">{_paragraphs(instructions)}</p>' if instructions else ""
    )
    whatsapp_html = _button(branding, whatsapp_url, "Enviar comprobante por WhatsApp") if whatsapp_url else ""
    body = f"""
        <h1 style="{styles['h1']}">{_e(greeting)}: tu pedido {_code(code)}</h1>
        <p style="{styles['p']}">
            Para recibir tu acceso, haz un Pago Móvil por <strong>Bs. {format_bs(amount_ves)}</strong>
            (US$ {format_bs(amount)}).<br>
            Plazo para pagar: <strong>{_e(format_caracas(expires_at))}</strong>
        </p>
        {_items_table(items)}
        {details}
        <p style="{styles['p']}">{_e(rate_line(rate, rate_source, rate_date))}</p>
        {instructions_html}
        <p style="{styles['p']}">
            Cuando hayas pagado, envíanos el comprobante por WhatsApp. Te damos acceso en cuanto
            confirmemos tu pago y te avisamos por correo.
        </p>
        {whatsapp_html}
        <p style="{styles['p']} margin-top: 24px;">
            <a href="{_e(purchase_url)}" style="color: inherit; font-weight: 700;">Ver mi pedido</a>
        </p>
    """
    subject = f"Tu pedido {code}: datos para pagar con Pago Móvil"
    document = _layout(
        branding,
        title=subject,
        body=body,
        preheader=f"Paga Bs. {format_bs(amount_ves)} con Pago Móvil y envíanos el comprobante.",
        footer="Recibes este correo porque hiciste un pedido con esta cuenta.",
    )
    return subject, document


def render_admin_notice(*, branding, code: str, buyer_name: str, buyer_email: str, items: list[ItemLine],
                        amount, amount_ves, rate, rate_source: str, rate_date: Optional[date],
                        expires_at: datetime, dash_url: str) -> tuple[str, str]:
    styles = _styles()
    body = f"""
        <h1 style="{styles['h1']}">Nuevo pedido {_code(code)}</h1>
        <p style="{styles['p']}">
            <strong>{_e(buyer_name)}</strong> ({_e(buyer_email)}) hizo un pedido con Pago Móvil por
            <strong>Bs. {format_bs(amount_ves)}</strong> (US$ {format_bs(amount)}).
        </p>
        {_items_table(items)}
        <p style="{styles['p']}">{_e(rate_line(rate, rate_source, rate_date))}.<br>
            Plazo para pagar: {_e(format_caracas(expires_at))}</p>
        <p style="{styles['p']}">Cuando veas el pago en tu banco, márcalo como pagado en Pedidos.</p>
        {_button(branding, dash_url, "Ver el pedido")}
        <p style="{styles['link_text']}">{_e(dash_url)}</p>
    """
    subject = f"Nuevo pedido {code} por confirmar"
    document = _layout(
        branding,
        title=subject,
        body=body,
        preheader=f"{buyer_name}: Bs. {format_bs(amount_ves)} por confirmar.",
        footer="Recibes este aviso porque tu correo está configurado para los pedidos de Pago Móvil.",
    )
    return subject, document


def render_paid(*, branding, first_name: str, code: str, resources: list[tuple[str, str, str]],
                cta_url: str) -> tuple[str, str]:
    styles = _styles()
    greeting = f"¡Gracias por tu compra, {first_name}!" if first_name else "¡Gracias por tu compra!"
    links = "".join(
        f'<li style="margin: 0 0 8px 0;"><a href="{_e(url)}" '
        f'style="color: inherit; font-weight: 700;">{_e(name)}</a>'
        f'{" (ebook)" if kind == "ebook" else ""}</li>'
        for name, url, kind in resources
    )
    body = f"""
        <h1 style="{styles['h1']}">{_e(greeting)}</h1>
        <p style="{styles['p']}">
            Confirmamos el pago de tu pedido <strong>{_code(code)}</strong> y ya tienes acceso.
            Puedes entrar cuando quieras, a tu ritmo.
        </p>
        <ul style="{styles['p']} text-align: left; padding-left: 20px;">{links}</ul>
        {_button(branding, cta_url, "Empezar ahora")}
        <p style="{styles['link_text']}">{_e(cta_url)}</p>
    """
    subject = f"Ya tienes acceso: pedido {code}"
    document = _layout(
        branding,
        title=greeting,
        body=body,
        preheader=f"Tu pedido {code} está confirmado.",
        footer="Recibes este correo porque realizaste una compra con esta cuenta.",
    )
    return subject, document


def render_rejected(*, branding, first_name: str, code: str, reason: str,
                    whatsapp_number: Optional[str]) -> tuple[str, str]:
    styles = _styles()
    greeting = f"Hola, {first_name}" if first_name else "Hola"
    contact = ""
    if whatsapp_number:
        url = f"https://wa.me/{whatsapp_number}"
        contact = f"""
        <p style="{styles['p']}">Si crees que es un error, escríbenos por WhatsApp.</p>
        {_button(branding, url, "Escribir por WhatsApp")}
        """
    body = f"""
        <h1 style="{styles['h1']}">{_e(greeting)}</h1>
        <p style="{styles['p']}">No pudimos confirmar el pago de tu pedido <strong>{_code(code)}</strong>.</p>
        <p style="{styles['p']}"><strong>Motivo:</strong> {_paragraphs(reason)}</p>
        {contact}
    """
    subject = f"No pudimos confirmar el pago del pedido {code}"
    document = _layout(
        branding,
        title=subject,
        body=body,
        preheader=f"Tu pedido {code} no se pudo confirmar.",
        footer="Recibes este correo porque hiciste un pedido con esta cuenta.",
    )
    return subject, document

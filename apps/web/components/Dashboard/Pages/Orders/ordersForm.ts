// Sanar y Criar: pure helpers for the "Pedidos" dashboard (orders paid by
// hand: Pago Móvil, bank transfer, Zelle, Binance) and the cards of "Pagos
// manuales" in Pagos › Configuración. No React and no path aliases, so
// tests/sc-orders.test.mjs can import this file directly (the one import is a
// type, erased at run time).
//
// Shapes and limits follow the cart contract (§0.2, §B.2, §B.3, §B.7) and the
// manual methods contract (§0, §A). The API is the source of truth: these
// checks only save a round trip, and every normalization here mirrors the
// API's, so a value that passes here is the value the API stores.
import type { PayCurrency } from '../../../Payments/commerce'

// ---------------------------------------------------------------------------
// Statuses, tabs and limits
// ---------------------------------------------------------------------------

export const ORDER_STATUSES = ['pending', 'paid', 'rejected', 'cancelled', 'expired', 'voided'] as const
/** Tabs of the list, in the order they are shown ("Por confirmar" first). */
export const ORDER_TABS = ['pending', 'paid', 'rejected', 'expired', 'cancelled', 'voided', 'all'] as const

export type OrderStatus = (typeof ORDER_STATUSES)[number]
export type OrderTab = (typeof ORDER_TABS)[number]

export const DEFAULT_TAB: OrderTab = 'pending'
export const ORDERS_PAGE_SIZE = 25

export const ORDER_LIMITS = {
  reference_min: 4,
  reference_max: 30,
  /** A Binance Pay order id or a USDT TxID (64 to 66 characters). */
  reference_max_binance: 100,
  reason_min: 3,
  reason_max: 300,
  note: 500,
  search: 100,
  instructions: 500,
  holder_name: 80,
  bank_name_min: 2,
  bank_name: 60,
  window_min: 1,
  window_max: 168,
  page_size_max: 100,
} as const

export const DEFAULT_WINDOW_HOURS = 24

/** Public code of an order: SYC- and 6 characters without 0/O/1/I/L. */
export const PURCHASE_CODE_RE = /^SYC-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value)
}

export function isOrderTab(value: unknown): value is OrderTab {
  return typeof value === 'string' && (ORDER_TABS as readonly string[]).includes(value)
}

/** "syc-7k4p9q " -> "SYC-7K4P9Q"; anything that is not a code -> null. */
export function parsePurchaseCode(raw: string | null | undefined): string | null {
  const code = String(raw ?? '').trim().toUpperCase()
  return PURCHASE_CODE_RE.test(code) ? code : null
}

// ---------------------------------------------------------------------------
// API shapes (contract §B.3, §B.7, §B.9)
// ---------------------------------------------------------------------------

export type PurchaseResource = {
  resource_uuid: string
  course_uuid: string
  name: string
  product_type: 'course' | 'ebook' | string
  thumbnail_url: string | null
  course_url: string | null
  first_activity_uuid: string | null
}

export type PurchaseItem = {
  offer_uuid: string
  order_uuid: string
  name: string
  amount: number
  resources: PurchaseResource[]
  /** Admin view: the buyer already had this product through another order (refund it). */
  duplicate_of?: { order_uuid: string; purchase_code: string | null } | null
}

/**
 * What the buyer is shown to pay, while the order is pending or expired. The
 * keys depend on the method (strings, "" when empty):
 * - pago_movil: bank_name, bank_code, phone, id_document, holder_name, instructions
 * - transferencia: bank_name, bank_code, account_number, account_type, holder_name, id_document, instructions
 * - zelle: email, phone, holder_name, instructions
 * - binance: pay_id, usdt_address, usdt_network, instructions
 */
export type PurchasePayment = Partial<
  Record<
    | 'bank_name'
    | 'bank_code'
    | 'phone'
    | 'id_document'
    | 'holder_name'
    | 'instructions'
    | 'account_number'
    | 'account_type'
    | 'email'
    | 'pay_id'
    | 'usdt_address'
    | 'usdt_network',
    string
  >
>

export type Purchase = {
  purchase_uuid: string
  code: string
  status: OrderStatus | string
  provider: string
  /** pago_movil, transferencia, zelle or binance (orders from before the others: pago_movil). */
  method: string
  currency: string
  /** The total in US$ (the prices). */
  amount: number
  /** What the buyer pays in: bolívares, dollars (Zelle) or USDT (Binance). */
  pay_currency: PayCurrency | string
  /** What the buyer pays, in pay_currency: amount_ves for VES, amount otherwise. */
  pay_amount: number | null
  /** The bolívares and the rate: null for Zelle and Binance. */
  amount_ves: number | null
  fx_rate: number | null
  fx_source: 'bcv' | 'manual' | string | null
  fx_date: string | null
  created_at: string
  expires_at: string
  closed_at: string | null
  confirmed_at: string | null
  items: PurchaseItem[]
  payment: PurchasePayment | null
  whatsapp_number: string | null
  whatsapp_url: string | null
  reject_reason: string | null
  can_cancel: boolean
}

export type PurchaseCustomer = {
  user_id: number
  user_uuid: string
  username: string
  first_name: string | null
  last_name: string | null
  email: string
}

export type PurchaseAdmin = Purchase & {
  customer: PurchaseCustomer | null
  bank_reference: string | null
  note: string | null
  confirmed_by: { user_id: number; username: string; name: string } | null
  reference_reused_in: string[]
  /** Paid, but some product still has no access (retry with the stored reference). */
  needs_fulfillment?: boolean
}

export type OrderCounts = Record<OrderTab, number>

export type PurchasesPage = {
  items: PurchaseAdmin[]
  total: number
  counts: OrderCounts
}

export const EMPTY_COUNTS: OrderCounts = {
  pending: 0,
  paid: 0,
  rejected: 0,
  cancelled: 0,
  expired: 0,
  voided: 0,
  all: 0,
}

export type FxMode = 'auto' | 'manual'

export type ManualSettingsValues = {
  bank_name: string
  bank_code: string
  phone: string
  id_document: string
  holder_name: string
  whatsapp: string
  instructions: string
  payment_window_hours: number
  fx_mode: FxMode | string
  fx_manual_rate: number | null
  notify_email: string
}

export type FxInfo = {
  rate: number | null
  rate_date: string | null
  source: 'bcv' | 'manual' | string | null
  fetched_at: string | null
  stale: boolean
  error: string | null
  /** A note from the API about the rate (e.g. a manual rate far from the BCV's). */
  warning?: string | null
}

/** GET/PUT /payments/{org_id}/manual/settings */
export type ManualSettings = {
  enabled: boolean
  active: boolean
  missing: string[]
  settings: ManualSettingsValues
  fx: FxInfo | null
}

/** PUT body: every field optional (omitted = unchanged, "" clears an optional one). */
export type ManualSettingsBody = Partial<{
  enabled: boolean
  bank_name: string
  bank_code: string
  phone: string
  id_document: string
  holder_name: string
  whatsapp: string
  instructions: string
  payment_window_hours: number
  fx_mode: FxMode
  fx_manual_rate: string
  notify_email: string
}>

export type ConfirmBody = { bank_reference: string; note?: string; allow_reused_reference?: boolean }
export type RejectBody = { reason: string; notify?: boolean }
export type VoidBody = { reason: string }

// ---------------------------------------------------------------------------
// Errors (detail = {code, message, ...extra})
// ---------------------------------------------------------------------------

/** The API's structured `detail` (also when it arrives as a JSON string). */
export function errorDetail(data: any): Record<string, any> | null {
  let detail = data?.detail ?? null
  if (typeof detail === 'string') {
    try {
      detail = JSON.parse(detail)
    } catch {
      return null
    }
  }
  return detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : null
}

/** A list field of the error detail: `purchases` of REFERENCE_USED, `missing` of INCOMPLETE. */
export function errorList(data: any, field: string): string[] {
  const value = errorDetail(data)?.[field]
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : []
}

// ---------------------------------------------------------------------------
// Reference, reason and note
// ---------------------------------------------------------------------------

/** Like the API: drop spaces, hyphens and dots, then upper case. */
export function normalizeReference(raw: string | null | undefined): string {
  return String(raw ?? '')
    .replace(/[\s.-]+/g, '')
    .toUpperCase()
}

/** Longest reference the API takes for the order's method: 30, or 100 for Binance (a TxID). */
export function referenceMaxLength(method?: string | null): number {
  return method === 'binance' ? ORDER_LIMITS.reference_max_binance : ORDER_LIMITS.reference_max
}

/** 4 to 30 letters or digits once normalized (4 to 100 for Binance). */
export function isValidReference(raw: string | null | undefined, method?: string | null): boolean {
  const reference = normalizeReference(raw)
  return (
    /^[A-Z0-9]+$/.test(reference) &&
    reference.length >= ORDER_LIMITS.reference_min &&
    reference.length <= referenceMaxLength(method)
  )
}

/** Length in characters (code points), like Python's len(). */
export function textLength(value: string | null | undefined): number {
  return Array.from(String(value ?? '')).length
}

/** Reject or void reason: 3 to 300 characters once trimmed. */
export function isValidReason(raw: string | null | undefined): boolean {
  const length = textLength(String(raw ?? '').trim())
  return length >= ORDER_LIMITS.reason_min && length <= ORDER_LIMITS.reason_max
}

export function isValidNote(raw: string | null | undefined): boolean {
  return textLength(String(raw ?? '').trim()) <= ORDER_LIMITS.note
}

// ---------------------------------------------------------------------------
// Money, rates and dates (es-VE, America/Caracas)
// ---------------------------------------------------------------------------

const AMOUNT = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const RATE_INPUT = new Intl.NumberFormat('es-VE', { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 4 })

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/** 35492.08 -> "35.492,08"; not a number -> "—". */
export function formatAmount(value: unknown): string {
  const n = finite(value)
  return n === null ? '—' : AMOUNT.format(n)
}

/** 35492.08 -> "Bs. 35.492,08". */
export function formatBs(value: unknown): string {
  const n = finite(value)
  return n === null ? '—' : `Bs. ${AMOUNT.format(n)}`
}

/** 40 -> "US$ 40,00". */
export function formatUsd(value: unknown): string {
  const n = finite(value)
  return n === null ? '—' : `US$ ${AMOUNT.format(n)}`
}

/**
 * What the buyer pays, in its currency, like the API's e-mails:
 * "Bs. 35.492,08", "US$ 40,00" (Zelle) or "40,00 USDT" (Binance). Another
 * currency: the amount and its code; not a number: "—".
 */
export function formatPayAmount(value: unknown, currency: string | null | undefined): string {
  const n = finite(value)
  if (n === null) return '—'
  switch (currency) {
    case 'VES':
      return `Bs. ${AMOUNT.format(n)}`
    case 'USD':
      return `US$ ${AMOUNT.format(n)}`
    case 'USDT':
      return `${AMOUNT.format(n)} USDT`
    default:
      return currency ? `${AMOUNT.format(n)} ${currency}` : AMOUNT.format(n)
  }
}

type PayFields = Partial<Pick<Purchase, 'pay_currency' | 'pay_amount' | 'amount' | 'amount_ves'>>

/**
 * What the buyer pays: `pay_currency` and `pay_amount`. An order without them
 * (an API from before Zelle and Binance) is a Pago Móvil one, in bolívares.
 */
export function purchasePay(p: PayFields | null | undefined): { currency: string; amount: number | null } {
  const currency = typeof p?.pay_currency === 'string' && p.pay_currency ? p.pay_currency : 'VES'
  const amount = p?.pay_amount ?? (currency === 'VES' ? p?.amount_ves : p?.amount)
  return { currency, amount: finite(amount) }
}

/** "Bs. 35.492,08", "US$ 40,00" or "40,00 USDT" for an order. */
export function formatPurchasePay(p: PayFields | null | undefined): string {
  const pay = purchasePay(p)
  return formatPayAmount(pay.amount, pay.currency)
}

/**
 * The US$ line under the amount, only when it adds something: the dollars of
 * a payment in bolívares ("US$ 40,00") or what the USDT are worth
 * ("= US$ 40,00"); nothing for a payment already in US$.
 */
export function usdLine(p: PayFields | null | undefined): string | null {
  const { currency } = purchasePay(p)
  if (currency === 'USD') return null
  const usd = formatUsd(p?.amount)
  return currency === 'USDT' ? `= ${usd}` : usd
}

/**
 * What to refund for one product of the order: its US$ price and its share of
 * the bolívares paid ("US$ 25,00 (Bs. 22.182,55)"); for Zelle its US$ price,
 * for Binance its USDT ("25,00 USDT").
 */
export function refundText(
  itemUsd: unknown,
  p: (PayFields & Partial<Pick<Purchase, 'fx_rate'>>) | null | undefined
): string {
  const { currency } = purchasePay(p)
  if (currency === 'USDT') return formatPayAmount(itemUsd, 'USDT')
  if (currency !== 'VES') return formatUsd(itemUsd)
  const ves = proportionalVes(itemUsd, p?.amount, p?.amount_ves, p?.fx_rate)
  return ves === null ? formatUsd(itemUsd) : `${formatUsd(itemUsd)} (${formatBs(ves)})`
}

/** Bs. per US$, as the BCV publishes it: 887.302 -> "887,30". */
export function formatRate(value: unknown): string {
  const n = finite(value)
  return n === null ? '—' : AMOUNT.format(n)
}

const RATE_PREVIEW = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 4 })

/**
 * A stored manual rate back into the form, without thousands separators:
 * 887.3 -> "887,30". Three decimals get a fourth (887.302 -> "887,3020") so
 * the text is never read as thousands (see parseManualRate).
 */
export function rateInputValue(value: unknown): string {
  const n = finite(value)
  if (n === null) return ''
  const text = RATE_INPUT.format(n)
  return /,\d{3}$/.test(text) ? `${text}0` : text
}

/** How a parsed rate will be saved: 1050.5 -> "1.050,50". */
export function formatRatePreview(value: number): string {
  return RATE_PREVIEW.format(value)
}

export const MAX_MANUAL_RATE = 100_000_000

export type ManualRateParse =
  | { ok: true; value: number }
  | { ok: false; code: 'empty' | 'invalid' | 'ambiguous' | 'decimals' | 'range' }

const count = (text: string, char: string) => text.split(char).length - 1

/** "1.050.000" -> "1050000" when every group after the first has 3 digits; else null. */
function joinThousands(text: string, separator: string): string | null {
  const groups = text.split(separator)
  if (!/^\d{1,3}$/.test(groups[0])) return null
  if (!groups.slice(1).every((group) => /^\d{3}$/.test(group))) return null
  return groups.join('')
}

/**
 * The Bs./US$ rate she types, read with the same rule as the API
 * (parse_rate_text in apps/api/src/services/payments/providers/manual.py;
 * keep them in step):
 * - spaces and no-break spaces are ignored; only digits, "." and "," count;
 * - "." and "," together: the last one is the decimal mark and the other one
 *   is dropped as a thousands separator ("1.050,5" and "1,050.5" are 1050.5);
 *   a second decimal mark is invalid;
 * - one mark repeated separates thousands, in groups of 3, with no decimals
 *   ("1.050.000" is 1050000);
 * - one mark once followed by exactly 3 digits is ambiguous ("1.050",
 *   "887,302"): she is asked for 2 decimals; any other count of digits after
 *   it makes it the decimal mark ("887,30", "887.3");
 * - digits on both sides of the decimal mark, more than 0 and up to
 *   100 000 000, with at most 4 decimals.
 */
export function parseManualRate(raw: string | null | undefined): ManualRateParse {
  const text = String(raw ?? '').replace(/[ \u00a0]/g, '')
  if (!text) return { ok: false, code: 'empty' }
  if (!/^[0-9.,]+$/.test(text)) return { ok: false, code: 'invalid' }

  const dots = count(text, '.')
  const commas = count(text, ',')
  let whole: string | null
  let decimals = ''
  if (dots > 0 && commas > 0) {
    const mark = text.lastIndexOf('.') > text.lastIndexOf(',') ? '.' : ','
    const stripped = text.split(mark === '.' ? ',' : '.').join('')
    if (count(stripped, mark) !== 1) return { ok: false, code: 'invalid' }
    const parts = stripped.split(mark)
    whole = parts[0] ?? ''
    decimals = parts[1] ?? ''
    if (!/^\d+$/.test(whole) || !/^\d+$/.test(decimals)) return { ok: false, code: 'invalid' }
  } else if (dots + commas > 1) {
    whole = joinThousands(text, dots ? '.' : ',')
    if (whole === null) return { ok: false, code: 'invalid' }
  } else if (dots + commas === 1) {
    const at = text.search(/[.,]/)
    const before = text.slice(0, at)
    const after = text.slice(at + 1)
    if (/^\d{3}$/.test(after)) return { ok: false, code: 'ambiguous' }
    if (!/^\d+$/.test(before) || !/^\d+$/.test(after)) return { ok: false, code: 'invalid' }
    whole = before
    decimals = after
  } else {
    whole = text
  }

  if (decimals.length > 4) return { ok: false, code: 'decimals' }
  const value = Number(decimals ? `${whole}.${decimals}` : whole)
  if (!Number.isFinite(value) || value <= 0 || value > MAX_MANUAL_RATE) return { ok: false, code: 'range' }
  return { ok: true, value }
}

/** True when a manual rate is more than 50 % away from the BCV's (the API refuses it too). */
export function rateFarFromBcv(rate: number, bcvRate: number | null | undefined): boolean {
  const bcv = finite(bcvRate)
  if (bcv === null || bcv <= 0 || !Number.isFinite(rate)) return false
  return Math.abs(rate - bcv) > bcv * 0.5
}

/**
 * What a refund of one product comes to: its US$ price and its share of the
 * bolívares actually paid (rounded to cents).
 */
export function proportionalVes(itemUsd: unknown, totalUsd: unknown, totalVes: unknown, fxRate?: unknown): number | null {
  const item = finite(itemUsd)
  if (item === null) return null
  const usd = finite(totalUsd)
  const ves = finite(totalVes)
  const raw = usd && usd > 0 && ves !== null ? (ves * item) / usd : (finite(fxRate) ?? NaN) * item
  return Number.isFinite(raw) ? Math.round((raw + Number.EPSILON) * 100) / 100 : null
}

export const TIME_ZONE = 'America/Caracas'

const DATE_TIME = new Intl.DateTimeFormat('es-VE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: TIME_ZONE,
})

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** "2026-10-28T19:45:00Z" -> "28/10/2026, 3:45 p. m." in Caracas time; invalid -> "—". */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  const date = toDate(value)
  return date ? DATE_TIME.format(date) : '—'
}

/** A calendar date ("2026-10-27", the BCV "fecha valor") -> "27/10/2026", with no time zone shift. */
export function formatIsoDate(value: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''))
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '—'
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

export type StatusTone = 'warning' | 'success' | 'danger' | 'neutral' | 'accent'

/** Chip colour of an order status (the page maps tones to classes). */
export function statusTone(status: string | null | undefined): StatusTone {
  switch (status) {
    case 'pending':
      return 'warning'
    case 'paid':
      return 'success'
    case 'rejected':
      return 'danger'
    case 'voided':
      return 'accent'
    default:
      return 'neutral'
  }
}

/** "Marcar como pagado" exists for these states (contract §C.4). */
export function canConfirm(status: string | null | undefined): boolean {
  return status === 'pending' || status === 'expired' || status === 'rejected' || status === 'cancelled'
}

/** Confirming a closed order asks for an extra warning first. */
export function needsLateWarning(status: string | null | undefined): boolean {
  return status === 'expired' || status === 'rejected' || status === 'cancelled'
}

export function canReject(status: string | null | undefined): boolean {
  return status === 'pending'
}

export function canVoid(status: string | null | undefined): boolean {
  return status === 'paid'
}

export type ExpiresLabel =
  | { expired: true; unit: 'expired'; count: 0 }
  | { expired: false; unit: 'minutes' | 'hours' | 'days'; count: number }

/**
 * Time left to pay, for "vence en 5 h" / "vencido". Under an hour in minutes
 * (rounded up), under two days in hours, then in days. null when there is no
 * valid date.
 */
export function expiresLabel(
  expiresAt: string | number | Date | null | undefined,
  now: number = Date.now()
): ExpiresLabel | null {
  const date = toDate(expiresAt)
  if (!date) return null
  const left = date.getTime() - now
  if (left <= 0) return { expired: true, unit: 'expired', count: 0 }
  const minutes = Math.ceil(left / 60_000)
  if (minutes < 60) return { expired: false, unit: 'minutes', count: Math.max(1, minutes) }
  const hours = left / 3_600_000
  if (hours < 47.5) return { expired: false, unit: 'hours', count: Math.max(1, Math.round(hours)) }
  return { expired: false, unit: 'days', count: Math.max(2, Math.round(hours / 24)) }
}

// ---------------------------------------------------------------------------
// People and products
// ---------------------------------------------------------------------------

/** "Ana Pérez", else the username, else the email. */
export function customerName(customer: Partial<PurchaseCustomer> | null | undefined): string {
  if (!customer) return ''
  const full = [customer.first_name, customer.last_name]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(' ')
  return full || String(customer.username ?? '').trim() || String(customer.email ?? '').trim()
}

/** The first `max` product names and how many more there are ("+2 más"). */
export function productSummary(
  items: Array<Pick<PurchaseItem, 'name'>> | null | undefined,
  max = 2
): { names: string[]; more: number } {
  const names = (items ?? []).map((item) => String(item?.name ?? '').trim()).filter(Boolean)
  return { names: names.slice(0, max), more: Math.max(0, names.length - max) }
}

// ---------------------------------------------------------------------------
// List query
// ---------------------------------------------------------------------------

/** Search text as the API reads it: trimmed, no NUL, at most 100 characters. */
export function cleanSearch(raw: string | null | undefined): string {
  return Array.from(String(raw ?? '').split(String.fromCharCode(0)).join('').trim())
    .slice(0, ORDER_LIMITS.search)
    .join('')
    .trim()
}

/**
 * Query string values for GET /purchases: a known status (else "pending"),
 * the cleaned search (left out when empty), a limit of 1–100 (25 by default)
 * and an offset of 0 or more.
 */
export function buildListParams(input: {
  status?: string | null
  q?: string | null
  offset?: number | null
  limit?: number | null
}): Record<string, string> {
  const status = isOrderTab(input.status) ? input.status : DEFAULT_TAB
  const rawLimit = Math.trunc(Number(input.limit))
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(rawLimit, ORDER_LIMITS.page_size_max) : ORDERS_PAGE_SIZE
  const rawOffset = Math.trunc(Number(input.offset))
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0
  const params: Record<string, string> = { status, limit: String(limit), offset: String(offset) }
  const q = cleanSearch(input.q)
  if (q) params.q = q
  return params
}

/** "1–25 de 60" numbers for the pager. */
export function pageRange(offset: number, shown: number, total: number): { from: number; to: number; total: number } {
  if (!(total > 0) || !(shown > 0)) return { from: 0, to: 0, total: Math.max(0, total || 0) }
  const from = Math.max(0, offset) + 1
  return { from, to: Math.min(total, from + shown - 1), total }
}

// ---------------------------------------------------------------------------
// /manual/settings: Pago Móvil's data and the settings every method shares
// (one form draft; each card sends its own part, see COMMON_FIELDS below)
// ---------------------------------------------------------------------------

/** Venezuelan banks that take Pago Móvil (code, name), contract §C.5. Also the bank-transfer picker. */
export const VE_BANKS: ReadonlyArray<{ code: string; name: string }> = [
  { code: '0102', name: 'Banco de Venezuela' },
  { code: '0104', name: 'Venezolano de Crédito' },
  { code: '0105', name: 'Mercantil' },
  { code: '0108', name: 'BBVA Provincial' },
  { code: '0114', name: 'Bancaribe' },
  { code: '0115', name: 'Banco Exterior' },
  { code: '0128', name: 'Banco Caroní' },
  { code: '0134', name: 'Banesco' },
  { code: '0137', name: 'Sofitasa' },
  { code: '0138', name: 'Banco Plaza' },
  { code: '0146', name: 'Bangente' },
  { code: '0151', name: 'BFC Banco Fondo Común' },
  { code: '0156', name: '100% Banco' },
  { code: '0157', name: 'DelSur' },
  { code: '0163', name: 'Banco del Tesoro' },
  { code: '0166', name: 'Banco Agrícola de Venezuela' },
  { code: '0168', name: 'Bancrecer' },
  { code: '0169', name: 'R4 Banco Microfinanciero' },
  { code: '0171', name: 'Banco Activo' },
  { code: '0172', name: 'Bancamiga' },
  { code: '0173', name: 'Banco Internacional de Desarrollo' },
  { code: '0174', name: 'Banplus' },
  { code: '0175', name: 'Banco Digital de los Trabajadores' },
  { code: '0177', name: 'Banfanb' },
  { code: '0178', name: 'N58 Banco Digital' },
  { code: '0191', name: 'BNC Banco Nacional de Crédito' },
]

export const OTHER_BANK = 'other'

export function bankByCode(code: string | null | undefined): { code: string; name: string } | null {
  const clean = String(code ?? '').trim()
  return VE_BANKS.find((bank) => bank.code === clean) ?? null
}

/** Value of the bank picker for saved data: a listed code, "other", or "" (nothing yet). */
export function bankChoiceFor(bankCode: string | null | undefined, bankName: string | null | undefined): string {
  if (bankByCode(bankCode)) return String(bankCode).trim()
  return String(bankCode ?? '').trim() || String(bankName ?? '').trim() ? OTHER_BANK : ''
}

/** Required to switch Pago Móvil on (plus fx_manual_rate with a manual rate). */
export const MANUAL_REQUIRED_FIELDS = ['bank_name', 'bank_code', 'phone', 'id_document', 'whatsapp'] as const

export const MANUAL_FIELDS = [
  'bank_name',
  'bank_code',
  'phone',
  'id_document',
  'holder_name',
  'whatsapp',
  'instructions',
  'payment_window_hours',
  'fx_mode',
  'fx_manual_rate',
  'notify_email',
] as const

export type ManualField = (typeof MANUAL_FIELDS)[number]

/** The settings form: every field as typed. */
export type ManualDraft = {
  bank_name: string
  bank_code: string
  phone: string
  id_document: string
  holder_name: string
  whatsapp: string
  instructions: string
  payment_window_hours: string
  fx_mode: FxMode
  fx_manual_rate: string
  notify_email: string
}

const str = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value))

export function draftFromManualSettings(data: Partial<ManualSettings> | null | undefined): ManualDraft {
  const s: Partial<ManualSettingsValues> = data?.settings ?? {}
  const hours = Number(s.payment_window_hours)
  return {
    bank_name: str(s.bank_name),
    bank_code: str(s.bank_code),
    phone: str(s.phone),
    id_document: str(s.id_document),
    holder_name: str(s.holder_name),
    whatsapp: str(s.whatsapp),
    instructions: str(s.instructions),
    payment_window_hours: String(Number.isInteger(hours) && hours > 0 ? hours : DEFAULT_WINDOW_HOURS),
    fx_mode: s.fx_mode === 'manual' ? 'manual' : 'auto',
    fx_manual_rate: rateInputValue(s.fx_manual_rate),
    notify_email: str(s.notify_email),
  }
}

/** Whole number of hours typed in the form, or null. */
export function parseWindowHours(raw: string | null | undefined): number | null {
  const text = String(raw ?? '').trim()
  if (!/^\d+$/.test(text)) return null
  const n = Number(text)
  return n >= ORDER_LIMITS.window_min && n <= ORDER_LIMITS.window_max ? n : null
}

export type WhatsappInfo = {
  /** Digits as the API stores them (a local 0424… becomes 58424…). */
  digits: string
  /** 11 to 15 digits, like the API asks. */
  valid: boolean
  /** 10 digits starting with 4: a Venezuelan number without the 58. */
  missingCountry: boolean
  /** "+58 424 882 4634" when valid. */
  preview: string | null
}

/** "584248824634" -> "+58 424 882 4634"; other countries: "+" and the digits. */
export function formatWhatsapp(digits: string | null | undefined): string {
  const d = String(digits ?? '').replace(/\D/g, '')
  if (/^58\d{10}$/.test(d)) return `+58 ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`
  return d ? `+${d}` : ''
}

/** The WhatsApp number as the API will read it (digits only, 0424… -> 58424…). */
export function whatsappInfo(raw: string | null | undefined): WhatsappInfo {
  let digits = String(raw ?? '').replace(/\D/g, '')
  if (digits.startsWith('0') && digits.length === 11) digits = `58${digits.slice(1)}`
  const valid = digits.length >= 11 && digits.length <= 15
  return {
    digits,
    valid,
    missingCountry: digits.length === 10 && digits.startsWith('4'),
    preview: valid ? formatWhatsapp(digits) : null,
  }
}

/**
 * PUT body for the form (without `enabled`, which the switch sends). The
 * manual rate goes only with the manual mode, as she typed it: the API reads
 * it with the same rule as parseManualRate.
 */
export function manualSettingsPayload(draft: ManualDraft): ManualSettingsBody {
  const hours = parseWindowHours(draft.payment_window_hours)
  const manual = draft.fx_mode === 'manual'
  return {
    bank_name: draft.bank_name.trim(),
    bank_code: draft.bank_code.trim(),
    phone: draft.phone.trim(),
    id_document: draft.id_document.trim(),
    holder_name: draft.holder_name.trim(),
    whatsapp: draft.whatsapp.trim(),
    instructions: draft.instructions.trim(),
    ...(hours !== null ? { payment_window_hours: hours } : {}),
    fx_mode: manual ? 'manual' : 'auto',
    ...(manual ? { fx_manual_rate: draft.fx_manual_rate.trim() } : {}),
    notify_email: draft.notify_email.trim(),
  }
}

export type ManualFieldErrorCode =
  | 'too_long'
  | 'window'
  | 'rate'
  | 'rate_ambiguous'
  | 'rate_far'
  | 'bank_name'
  | 'whatsapp'
  | 'whatsapp_country'

export type ManualFieldError = { field: ManualField; code: ManualFieldErrorCode }

/**
 * Checks the form can answer by itself. The other formats (phone, cédula,
 * e-mail, bank code) are left to the API, which normalizes them and names the
 * field when one is wrong. `bcvRate` (today's BCV rate, when known) stops a
 * manual rate more than 50 % away from it.
 */
export function validateManualDraft(draft: ManualDraft, options: { bcvRate?: number | null } = {}): ManualFieldError[] {
  const errors: ManualFieldError[] = []
  const bankName = draft.bank_name.trim()
  if (bankName && (textLength(bankName) < ORDER_LIMITS.bank_name_min || textLength(bankName) > ORDER_LIMITS.bank_name)) {
    errors.push({ field: 'bank_name', code: 'bank_name' })
  }
  if (textLength(draft.holder_name.trim()) > ORDER_LIMITS.holder_name) errors.push({ field: 'holder_name', code: 'too_long' })
  const whatsapp = draft.whatsapp.trim()
  if (whatsapp) {
    const info = whatsappInfo(whatsapp)
    if (!info.valid) errors.push({ field: 'whatsapp', code: info.missingCountry ? 'whatsapp_country' : 'whatsapp' })
  }
  if (textLength(draft.instructions.trim()) > ORDER_LIMITS.instructions) errors.push({ field: 'instructions', code: 'too_long' })
  if (parseWindowHours(draft.payment_window_hours) === null) errors.push({ field: 'payment_window_hours', code: 'window' })
  if (draft.fx_mode === 'manual') {
    const rate = parseManualRate(draft.fx_manual_rate)
    if (!rate.ok) errors.push({ field: 'fx_manual_rate', code: rate.code === 'ambiguous' ? 'rate_ambiguous' : 'rate' })
    else if (rateFarFromBcv(rate.value, options.bcvRate)) errors.push({ field: 'fx_manual_rate', code: 'rate_far' })
  }
  return errors
}

export function isManualDraftDirty(a: ManualDraft, b: ManualDraft): boolean {
  return JSON.stringify(manualSettingsPayload(a)) !== JSON.stringify(manualSettingsPayload(b))
}

// ---------------------------------------------------------------------------
// The two cards of /manual/settings: the settings every manual method shares
// ("Ajustes de los pagos manuales") and Pago Móvil's own data
// ---------------------------------------------------------------------------

/** Shared by every manual method: the receipts WhatsApp, the time to pay, the rate and the notice e-mail. */
export const COMMON_FIELDS = ['whatsapp', 'payment_window_hours', 'fx_mode', 'fx_manual_rate', 'notify_email'] as const
/** Pago Móvil's own data (its card sends only these, plus the switch). */
export const PAGO_MOVIL_FIELDS = ['bank_name', 'bank_code', 'phone', 'id_document', 'holder_name', 'instructions'] as const

type FieldList = readonly string[]

function pickFields(body: ManualSettingsBody, fields: FieldList): ManualSettingsBody {
  const picked: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) if (fields.includes(key)) picked[key] = value
  return picked as ManualSettingsBody
}

/** PUT body of the common card: only the shared settings (the manual rate only with the manual mode). */
export function commonSettingsPayload(draft: ManualDraft): ManualSettingsBody {
  return pickFields(manualSettingsPayload(draft), COMMON_FIELDS)
}

/** PUT body of the Pago Móvil card: only its own data (the switch sends `enabled`). */
export function pagoMovilPayload(draft: ManualDraft): ManualSettingsBody {
  return pickFields(manualSettingsPayload(draft), PAGO_MOVIL_FIELDS)
}

export function validateCommonDraft(draft: ManualDraft, options: { bcvRate?: number | null } = {}): ManualFieldError[] {
  return validateManualDraft(draft, options).filter((e) => (COMMON_FIELDS as FieldList).includes(e.field))
}

export function validatePagoMovilDraft(draft: ManualDraft): ManualFieldError[] {
  return validateManualDraft(draft).filter((e) => (PAGO_MOVIL_FIELDS as FieldList).includes(e.field))
}

export function isCommonDraftDirty(a: ManualDraft, b: ManualDraft): boolean {
  return JSON.stringify(commonSettingsPayload(a)) !== JSON.stringify(commonSettingsPayload(b))
}

export function isPagoMovilDraftDirty(a: ManualDraft, b: ManualDraft): boolean {
  return JSON.stringify(pagoMovilPayload(a)) !== JSON.stringify(pagoMovilPayload(b))
}

/** A shared setting no method can do without is missing: the WhatsApp, or the manual rate in manual mode. */
export function commonSettingsIncomplete(settings: Partial<ManualSettingsValues> | null | undefined): boolean {
  if (!String(settings?.whatsapp ?? '').trim()) return true
  return settings?.fx_mode === 'manual' && finite(settings?.fx_manual_rate) === null
}

/** "Banesco (0134)"; "" without a bank. */
export function bankText(name: string | null | undefined, code: string | null | undefined): string {
  const cleanCode = String(code ?? '').trim()
  return [String(name ?? '').trim(), cleanCode ? `(${cleanCode})` : ''].filter(Boolean).join(' ')
}

// ---------------------------------------------------------------------------
// Bank transfer, Zelle and Binance (manual methods contract §A.2, §A.3)
// ---------------------------------------------------------------------------

/** The methods /manual/methods configures, in display order (Pago Móvil keeps /manual/settings). */
export const EXTRA_METHODS = ['transferencia', 'zelle', 'binance'] as const
export type ExtraMethod = (typeof EXTRA_METHODS)[number]

export function isExtraMethod(value: unknown): value is ExtraMethod {
  return typeof value === 'string' && (EXTRA_METHODS as readonly string[]).includes(value)
}

/** Each method's fields, in form order (the API's manual_methods.FIELDS). */
export const METHOD_FIELDS = {
  transferencia: ['bank_name', 'bank_code', 'account_number', 'account_type', 'holder_name', 'id_document', 'instructions'],
  zelle: ['email', 'phone', 'holder_name', 'instructions'],
  binance: ['pay_id', 'usdt_address', 'usdt_network', 'instructions'],
} as const satisfies Record<ExtraMethod, readonly string[]>

export type MethodField = (typeof METHOD_FIELDS)[ExtraMethod][number]

/** One method in GET /manual/methods, and the answer of its PUT. */
export type ManualMethodState = {
  method: ExtraMethod | string
  /** Its switch. */
  enabled: boolean
  /** Its data is complete (`missing` is empty). The cart offers it when both are true. */
  active: boolean
  /** Its own missing data in form order, then the shared one (whatsapp, fx_manual_rate). */
  missing: string[]
  settings: Partial<Record<MethodField, string>>
}

/** GET /payments/{org_id}/manual/methods */
export type ManualMethods = Partial<Record<ExtraMethod, ManualMethodState>>

/** PUT /manual/methods/{method}: any of its fields (omitted = unchanged, "" clears) and the switch. */
export type ManualMethodBody = Partial<Record<MethodField, string>> & { enabled?: boolean }

/** The form of one method: every field as typed (the other methods' fields stay ""). */
export type MethodDraft = Record<MethodField, string>

const EMPTY_METHOD_DRAFT: MethodDraft = {
  bank_name: '',
  bank_code: '',
  account_number: '',
  account_type: '',
  holder_name: '',
  id_document: '',
  instructions: '',
  email: '',
  phone: '',
  pay_id: '',
  usdt_address: '',
  usdt_network: '',
}

export const ACCOUNT_TYPES = ['corriente', 'ahorro'] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]

export const USDT_NETWORKS = ['TRC20', 'BEP20', 'ERC20', 'SOL', 'POLYGON', 'ARBITRUM'] as const
export type UsdtNetwork = (typeof USDT_NETWORKS)[number]

/** Proper names: the same in every language. */
export const NETWORK_LABELS: Record<UsdtNetwork, string> = {
  TRC20: 'TRC20 (Tron)',
  BEP20: 'BEP20 (BNB Smart Chain)',
  ERC20: 'ERC20 (Ethereum)',
  SOL: 'Solana',
  POLYGON: 'Polygon',
  ARBITRUM: 'Arbitrum One',
}

/** "TRC20" -> "TRC20 (Tron)"; an unknown code as it came. */
export function networkLabel(code: string | null | undefined): string {
  const clean = String(code ?? '').trim()
  return (NETWORK_LABELS as Record<string, string>)[clean] ?? clean
}

export function methodDraftFromState(method: ExtraMethod, state: Partial<ManualMethodState> | null | undefined): MethodDraft {
  const settings: Partial<Record<MethodField, unknown>> = state?.settings ?? {}
  const draft = { ...EMPTY_METHOD_DRAFT }
  for (const field of METHOD_FIELDS[method]) draft[field] = str(settings[field])
  return draft
}

/** Whether the method has any data saved: a card she never filled starts closed. */
export function methodHasData(state: Partial<ManualMethodState> | null | undefined): boolean {
  return Object.values(state?.settings ?? {}).some((value) => typeof value === 'string' && value.trim() !== '')
}

export const ACCOUNT_DIGITS = 20

/** Like the API: spaces, dots and dashes removed. */
export function normalizeAccountNumber(raw: string | null | undefined): string {
  return String(raw ?? '').replace(/[\s.-]/g, '')
}

/**
 * "01340000000000000000" -> "0134 0000 00 0000000000" (bank, office, check
 * digits, account); anything that is not 20 digits as it came.
 */
export function formatAccountNumber(raw: string | null | undefined): string {
  const digits = normalizeAccountNumber(raw)
  if (!/^\d{20}$/.test(digits)) return String(raw ?? '').trim()
  return `${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8, 10)} ${digits.slice(10)}`
}

export type AccountInfo = {
  /** Without spaces, dots and dashes. */
  digits: string
  /** Only digits so far. */
  numeric: boolean
  /** The 20 digits. */
  valid: boolean
  /** "0134 0000 00 0000000000" once valid. */
  grouped: string | null
  /** Valid, but it does not start with the bank's code (the API refuses it). */
  bankMismatch: boolean
}

/** The live line under the account number. */
export function accountInfo(raw: string | null | undefined, bankCode: string | null | undefined): AccountInfo {
  const digits = normalizeAccountNumber(raw)
  const valid = /^\d{20}$/.test(digits)
  const code = String(bankCode ?? '').trim()
  return {
    digits,
    numeric: /^\d*$/.test(digits),
    valid,
    grouped: valid ? formatAccountNumber(digits) : null,
    bankMismatch: valid && /^\d{4}$/.test(code) && !digits.startsWith(code),
  }
}

/** Like the API: a US number, 10 digits or 11 starting with 1 -> "+1 305-555-1234"; null when it is not one. */
export function formatZellePhone(raw: string | null | undefined): string | null {
  let digits = String(raw ?? '').replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1)
  // Neither the area code nor the exchange starts with 0 or 1.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return null
  return `+1 ${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
}

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/

/** Whether a USDT address has the shape of that network's addresses (the API's address_matches_network). */
export function addressMatchesNetwork(address: string | null | undefined, network: string | null | undefined): boolean {
  const text = String(address ?? '').replace(/\s/g, '')
  switch (network) {
    case 'TRC20':
      return text.length === 34 && text.startsWith('T') && BASE58_RE.test(text)
    case 'BEP20':
    case 'ERC20':
    case 'POLYGON':
    case 'ARBITRUM':
      return /^0x[0-9a-fA-F]{40}$/.test(text)
    case 'SOL':
      return text.length >= 32 && text.length <= 44 && BASE58_RE.test(text)
    default:
      return true
  }
}

/**
 * PUT body of one method's form: its own fields only, trimmed; the account
 * number without spaces, dots and dashes and the Pay ID and address without
 * spaces, as the API stores them. Without `enabled`, which the switch sends.
 */
export function methodPayload(method: ExtraMethod, draft: MethodDraft): ManualMethodBody {
  const body: ManualMethodBody = {}
  for (const field of METHOD_FIELDS[method]) {
    const value = String(draft[field] ?? '')
    if (field === 'account_number') body[field] = normalizeAccountNumber(value)
    else if (field === 'pay_id' || field === 'usdt_address') body[field] = value.replace(/\s/g, '')
    else body[field] = value.trim()
  }
  return body
}

export function isMethodDraftDirty(method: ExtraMethod, a: MethodDraft, b: MethodDraft): boolean {
  return JSON.stringify(methodPayload(method, a)) !== JSON.stringify(methodPayload(method, b))
}

export type MethodErrorCode =
  | 'bank_name'
  | 'bank_code'
  | 'account_number'
  | 'account_bank'
  | 'id_document'
  | 'email'
  | 'zelle_phone'
  | 'pay_id'
  | 'usdt_address'
  | 'address_network'
  | 'network_required'
  | 'too_long'

export type MethodFieldError = {
  field: MethodField
  code: MethodErrorCode
  /** too_long: the limit. */
  max?: number
  /** account_bank: the bank's code. */
  bankCode?: string
  /** address_network: the network's code. */
  network?: string
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/**
 * What the form of a method checks by itself, with the API's rules (it
 * refuses the same values with INVALID_FIELD): every error at once, in form
 * order. Empty fields are fine here; switching on asks for the required ones.
 */
export function validateMethodDraft(method: ExtraMethod, draft: MethodDraft): MethodFieldError[] {
  const errors: MethodFieldError[] = []
  const text = (field: MethodField) => String(draft[field] ?? '').trim()
  const tooLong = (field: MethodField, max: number) => {
    if (textLength(text(field)) > max) errors.push({ field, code: 'too_long', max })
  }

  if (method === 'transferencia') {
    const bankName = text('bank_name')
    if (bankName && (textLength(bankName) < ORDER_LIMITS.bank_name_min || textLength(bankName) > ORDER_LIMITS.bank_name)) {
      errors.push({ field: 'bank_name', code: 'bank_name' })
    }
    const bankCode = text('bank_code')
    if (bankCode && !/^\d{4}$/.test(bankCode)) errors.push({ field: 'bank_code', code: 'bank_code' })
    const account = accountInfo(draft.account_number, bankCode)
    if (account.digits && !account.valid) errors.push({ field: 'account_number', code: 'account_number' })
    else if (account.bankMismatch) errors.push({ field: 'account_number', code: 'account_bank', bankCode })
    tooLong('holder_name', ORDER_LIMITS.holder_name)
    const idDocument = text('id_document').replace(/[\s.-]/g, '').toUpperCase()
    if (idDocument && !/^[VEJGP]\d{5,10}$/.test(idDocument)) errors.push({ field: 'id_document', code: 'id_document' })
  } else if (method === 'zelle') {
    const email = text('email').toLowerCase()
    if (email && (email.length > 254 || !EMAIL_RE.test(email))) errors.push({ field: 'email', code: 'email' })
    if (text('phone') && formatZellePhone(text('phone')) === null) errors.push({ field: 'phone', code: 'zelle_phone' })
    tooLong('holder_name', ORDER_LIMITS.holder_name)
  } else {
    const payId = String(draft.pay_id ?? '').replace(/\s/g, '')
    if (payId && !/^\d{5,20}$/.test(payId)) errors.push({ field: 'pay_id', code: 'pay_id' })
    const address = String(draft.usdt_address ?? '').replace(/\s/g, '')
    const network = text('usdt_network')
    if (address && (address.length > 100 || !/^[A-Za-z0-9]+$/.test(address))) {
      errors.push({ field: 'usdt_address', code: 'usdt_address' })
    } else if (address && network && !addressMatchesNetwork(address, network)) {
      errors.push({ field: 'usdt_address', code: 'address_network', network })
    }
    if (address && !network) errors.push({ field: 'usdt_network', code: 'network_required' })
  }
  tooLong('instructions', ORDER_LIMITS.instructions)
  return errors
}

// ---------------------------------------------------------------------------
// Missing data ("Falta: …") of the four methods
// ---------------------------------------------------------------------------

/**
 * Every token `missing` can hold: field names, plus email_or_phone (Zelle:
 * neither), pay_id_or_address (Binance: neither) and the shared settings
 * whatsapp and fx_manual_rate.
 */
export const MISSING_TOKENS = [
  'bank_name',
  'bank_code',
  'phone',
  'id_document',
  'account_number',
  'account_type',
  'holder_name',
  'email_or_phone',
  'pay_id_or_address',
  'usdt_network',
  'whatsapp',
  'fx_manual_rate',
] as const

/** Set in "Ajustes de los pagos manuales", not in the method's own card. */
export const COMMON_MISSING = ['whatsapp', 'fx_manual_rate'] as const

export function isCommonMissing(token: string): boolean {
  return (COMMON_MISSING as readonly string[]).includes(token)
}

/** The method's own missing data, then the shared one, each in the API's order. */
export function splitMissing(missing: readonly string[] | null | undefined): { own: string[]; common: string[] } {
  const list = (missing ?? []).filter((token): token is string => typeof token === 'string' && token.length > 0)
  return { own: list.filter((token) => !isCommonMissing(token)), common: list.filter(isCommonMissing) }
}

/** The fields of a card a missing token points at ("email_or_phone" -> email and phone; a shared one -> none). */
export function fieldsOfMissing(token: string): string[] {
  if (token === 'email_or_phone') return ['email', 'phone']
  if (token === 'pay_id_or_address') return ['pay_id', 'usdt_address']
  return isCommonMissing(token) ? [] : [token]
}

/** The token of `missing` that asks for `field`, or null. */
export function missingTokenFor(field: string, missing: readonly string[] | null | undefined): string | null {
  return (missing ?? []).find((token) => fieldsOfMissing(token).includes(field)) ?? null
}

/** The cart offers at least one manual method: on and complete (Pago Móvil from /manual/settings, the rest from /manual/methods). */
export function anyManualMethodReady(
  pagoMovil: Partial<Pick<ManualSettings, 'enabled' | 'active'>> | null | undefined,
  methods: ManualMethods | null | undefined
): boolean {
  if (pagoMovil?.enabled && pagoMovil?.active) return true
  return EXTRA_METHODS.some((method) => !!(methods?.[method]?.enabled && methods?.[method]?.active))
}

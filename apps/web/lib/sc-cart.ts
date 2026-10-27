// Sanar y Criar: the shopping cart (kept in the browser, one per organization)
// and the money/date formatting of the cart and order pages.
//
// Pure TypeScript on purpose: no React, no Next imports, because
// tests/sc-cart.test.mjs imports this file directly.
// Contract: carrito-contrato.md §0.2, §0.1 and §D.1 (docs/spec-tecnica.md §7).

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

export const CART_VERSION = 1
/** Same limit as the API (CART_MAX_ITEMS). */
export const CART_MAX_ITEMS = 20
/** Fired on `window` after every change made in this tab. */
export const CART_EVENT = 'sc-cart-change'

const KEY_PREFIX = 'sanarycriar:carrito:v1:'
// offer_uuid values are uuid4 with hyphens.
const OFFER_UUID_RE = /^[0-9a-fA-F-]{8,64}$/

export interface CartItem {
  offer_uuid: string
  added_at: number
}

export interface CartState {
  v: 1
  items: CartItem[]
}

export type AddResult = 'added' | 'exists' | 'full' | 'invalid'

type OrgId = number | string | null | undefined

export function cartStorageKey(orgId: number | string): string {
  return `${KEY_PREFIX}${orgId}`
}

export function isValidOfferUuid(value: unknown): value is string {
  return typeof value === 'string' && OFFER_UUID_RE.test(value)
}

function keyFor(orgId: OrgId): string | null {
  if (orgId === null || orgId === undefined) return null
  const id = String(orgId).trim()
  return /^[0-9A-Za-z_-]{1,64}$/.test(id) ? cartStorageKey(id) : null
}

const emptyCart = (): CartState => ({ v: CART_VERSION, items: [] })

// When the browser refuses to store (private mode, blocked site data, full
// quota) the cart lives here for the rest of the visit. A key leaves this map
// as soon as localStorage accepts a write again.
const memory = new Map<string, string>()

function storage(): Storage | null {
  try {
    const s = (globalThis as any).localStorage as Storage | undefined
    return s && typeof s.getItem === 'function' ? s : null
  } catch {
    // Some browsers throw on the mere property access when storage is blocked.
    return null
  }
}

function readRaw(key: string): string | null {
  if (memory.has(key)) return memory.get(key) ?? null
  try {
    return storage()?.getItem(key) ?? null
  } catch {
    return null
  }
}

function writeRaw(key: string, value: string): void {
  try {
    const s = storage()
    if (!s) throw new Error('no storage')
    s.setItem(key, value)
    memory.delete(key)
  } catch {
    memory.set(key, value)
  }
}

function parseCart(raw: string | null): CartState {
  if (!raw) return emptyCart()
  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    return emptyCart()
  }
  if (!data || typeof data !== 'object' || data.v !== CART_VERSION || !Array.isArray(data.items)) return emptyCart()
  const seen = new Set<string>()
  const items: CartItem[] = []
  for (const entry of data.items) {
    const uuid = typeof entry?.offer_uuid === 'string' ? entry.offer_uuid.trim().toLowerCase() : ''
    if (!isValidOfferUuid(uuid) || seen.has(uuid)) continue
    seen.add(uuid)
    const addedAt = Number(entry?.added_at)
    items.push({ offer_uuid: uuid, added_at: Number.isFinite(addedAt) && addedAt > 0 ? addedAt : 0 })
    if (items.length >= CART_MAX_ITEMS) break
  }
  return { v: CART_VERSION, items }
}

function notify(orgId: OrgId): void {
  try {
    const w = (globalThis as any).window
    if (!w || typeof w.dispatchEvent !== 'function') return
    const event =
      typeof CustomEvent === 'function'
        ? new CustomEvent(CART_EVENT, { detail: { orgId } })
        : new Event(CART_EVENT)
    w.dispatchEvent(event)
  } catch {
    /* listeners are a convenience; the cart itself is saved */
  }
}

function save(orgId: OrgId, key: string, items: CartItem[]): void {
  writeRaw(key, JSON.stringify({ v: CART_VERSION, items }))
  notify(orgId)
}

/** The cart of an organization (empty when there is none or it is unreadable). */
export function readCart(orgId: OrgId): CartState {
  const key = keyFor(orgId)
  return key ? parseCart(readRaw(key)) : emptyCart()
}

export function cartCount(orgId: OrgId): number {
  return readCart(orgId).items.length
}

export function addToCart(orgId: OrgId, offerUuid: string, now: number = Date.now()): AddResult {
  const key = keyFor(orgId)
  const uuid = typeof offerUuid === 'string' ? offerUuid.trim().toLowerCase() : ''
  if (!key || !isValidOfferUuid(uuid)) return 'invalid'
  const { items } = readCart(orgId)
  if (items.some((i) => i.offer_uuid === uuid)) return 'exists'
  if (items.length >= CART_MAX_ITEMS) return 'full'
  save(orgId, key, [...items, { offer_uuid: uuid, added_at: now }])
  return 'added'
}

/** Removes one product; true when it was in the cart. */
export function removeFromCart(orgId: OrgId, offerUuid: string): boolean {
  return removeManyFromCart(orgId, [offerUuid]) > 0
}

/** Removes several products at once (one write, one event); returns how many left. */
export function removeManyFromCart(orgId: OrgId, offerUuids: readonly string[]): number {
  const key = keyFor(orgId)
  if (!key) return 0
  const drop = new Set(
    (offerUuids || []).filter((u) => typeof u === 'string').map((u) => u.trim().toLowerCase())
  )
  const { items } = readCart(orgId)
  const kept = items.filter((i) => !drop.has(i.offer_uuid))
  if (kept.length === items.length) return 0
  save(orgId, key, kept)
  return items.length - kept.length
}

export function clearCart(orgId: OrgId): void {
  const key = keyFor(orgId)
  if (!key) return
  save(orgId, key, [])
}

/**
 * Calls `callback` after any cart change: in this tab (CART_EVENT) and in
 * other tabs (the `storage` event). Returns the unsubscribe function.
 */
export function subscribeCart(callback: () => void): () => void {
  const w = (globalThis as any).window
  if (!w || typeof w.addEventListener !== 'function') return () => {}
  const onChange = () => callback()
  const onStorage = (event: StorageEvent) => {
    // key === null: another tab cleared the whole storage.
    if (!event || event.key === null || (typeof event.key === 'string' && event.key.startsWith(KEY_PREFIX))) callback()
  }
  w.addEventListener(CART_EVENT, onChange)
  w.addEventListener('storage', onStorage)
  return () => {
    w.removeEventListener(CART_EVENT, onChange)
    w.removeEventListener('storage', onStorage)
  }
}

// ---------------------------------------------------------------------------
// Money (contract §0.8: es-VE, two decimals, "US$ 40,00" and "Bs. 35.492,08")
// ---------------------------------------------------------------------------

const AMOUNT_FORMAT = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const PLAIN_AMOUNT_FORMAT = new Intl.NumberFormat('es-VE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: false,
})

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/** 35492.08 -> "35.492,08" ("" when it is not a number). */
export function formatAmount(value: unknown): string {
  const n = toNumber(value)
  return n === null ? '' : AMOUNT_FORMAT.format(n)
}

/** 40 -> "US$ 40,00". */
export function formatUsd(value: unknown): string {
  const amount = formatAmount(value)
  return amount ? `US$ ${amount}` : ''
}

/** 35492.08 -> "Bs. 35.492,08". */
export function formatBs(value: unknown): string {
  const amount = formatAmount(value)
  return amount ? `Bs. ${amount}` : ''
}

/** Bolívares per dollar, as shown next to the total: 887.302 -> "887,30". */
export function formatRate(value: unknown): string {
  return formatAmount(value)
}

/** What "Copiar" puts on the clipboard for an amount: no thousands dots, "35492,08". */
export function amountForCopy(value: unknown): string {
  const n = toNumber(value)
  return n === null ? '' : PLAIN_AMOUNT_FORMAT.format(n)
}

export function digitsOnly(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).replace(/\D/g, '') : ''
}

/** "584248824634" -> "+58 424 882 4634" (other numbers: "+" and the digits). */
export function formatWhatsappNumber(value: unknown): string {
  const digits = digitsOnly(value)
  if (!digits) return ''
  if (digits.length === 12 && digits.startsWith('58')) {
    return `+58 ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`
  }
  return `+${digits}`
}

/** Plain chat link (no message): https://wa.me/584248824634, or null. */
export function whatsappChatUrl(value: unknown): string | null {
  const digits = digitsOnly(value)
  return digits.length >= 10 && digits.length <= 15 ? `https://wa.me/${digits}` : null
}

/** The API's prefilled link, only when it really points to WhatsApp. */
export function safeWhatsappUrl(url: unknown, fallbackNumber?: unknown): string | null {
  if (typeof url === 'string' && url) {
    try {
      const parsed = new URL(url)
      const host = parsed.hostname.toLowerCase()
      if (parsed.protocol === 'https:' && (host === 'wa.me' || host === 'api.whatsapp.com') && !parsed.username) {
        return parsed.toString()
      }
    } catch {
      /* fall back to the number */
    }
  }
  return fallbackNumber === undefined ? null : whatsappChatUrl(fallbackNumber)
}

// ---------------------------------------------------------------------------
// Dates (America/Caracas, "28/10/2026, 3:45 p. m.")
// ---------------------------------------------------------------------------

export const SC_TIME_ZONE = 'America/Caracas'

function caracasParts(value: unknown): Record<string, string> | null {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value as string | number)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SC_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const out: Record<string, string> = {}
  for (const p of parts) out[p.type] = p.value
  return out
}

/** "2026-10-28T19:45:00Z" -> "28/10/2026" (Caracas). */
export function formatCaracasDate(value: unknown): string {
  const p = caracasParts(value)
  return p ? `${p.day}/${p.month}/${p.year}` : ''
}

/**
 * "2026-10-28T19:45:00Z" -> "28/10/2026, 3:45 p. m." (Caracas). Built from
 * parts so every browser prints the same thing ("p. m." vs "p.m." varies).
 * English gets "3:45 PM".
 */
export function formatCaracasDateTime(value: unknown, lng: string = 'es'): string {
  const p = caracasParts(value)
  if (!p) return ''
  let hour = Number(p.hour)
  if (hour === 24) hour = 0
  const h12 = hour % 12 || 12
  const english = String(lng || '').toLowerCase().startsWith('en')
  const period = english ? (hour < 12 ? 'AM' : 'PM') : hour < 12 ? 'a. m.' : 'p. m.'
  return `${p.day}/${p.month}/${p.year}, ${h12}:${p.minute} ${period}`
}

/** A date-only value from the API ("2026-10-27") -> "27/10/2026", without time-zone shifts. */
export function formatIsoDate(value: unknown): string {
  if (typeof value !== 'string') return ''
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ''
}

// ---------------------------------------------------------------------------
// Orders (purchases)
// ---------------------------------------------------------------------------

export const PURCHASE_STATUSES = ['pending', 'paid', 'rejected', 'cancelled', 'expired', 'voided'] as const
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number]

export function purchaseStatus(value: unknown): PurchaseStatus | null {
  const s = typeof value === 'string' ? value.toLowerCase() : ''
  return (PURCHASE_STATUSES as readonly string[]).includes(s) ? (s as PurchaseStatus) : null
}

/** Pending orders first, then the API's order (most recent first). */
export function sortPurchasesPendingFirst<T extends { status?: unknown }>(purchases: readonly T[]): T[] {
  return purchases
    .map((p, index) => ({ p, index }))
    .sort((a, b) => {
      const pa = a.p.status === 'pending' ? 0 : 1
      const pb = b.p.status === 'pending' ? 0 : 1
      return pa - pb || a.index - b.index
    })
    .map(({ p }) => p)
}

/** A purchase_uuid as it can appear in a URL (uuid4().hex, or a hyphenated uuid). */
export function isPlausiblePurchaseUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F-]{8,64}$/.test(value)
}

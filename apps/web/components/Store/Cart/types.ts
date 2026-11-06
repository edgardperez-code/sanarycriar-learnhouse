// Sanar y Criar: shapes of the cart and order API (contract §B.5 and §B.7;
// the manual methods: contrato-pagos-manuales.md §A.4 to §A.6).
// Amounts arrive as JSON numbers; format them with lib/sc-cart.ts.
import type { ManualMethod, PayCurrency } from '@components/Payments/commerce'

export type QuoteItemStatus = 'available' | 'unavailable' | 'owned' | 'pending'

export interface PendingPurchaseRef {
  purchase_uuid: string
  code: string
}

export interface QuoteResource {
  course_uuid: string
  name: string
  product_type: 'course' | 'ebook' | string
  thumbnail_url: string | null
}

export interface QuoteItem {
  offer_uuid: string
  name: string | null
  description?: string | null
  amount: number | null
  currency?: string
  thumbnail_url?: string | null
  resources: QuoteResource[]
  status: QuoteItemStatus
  pending_purchase?: PendingPurchaseRef | null
}

/** One manual method of a quote: on, complete, and what this cart costs with it. */
export interface QuoteMethod {
  method: ManualMethod | string
  currency: PayCurrency | string
  /** null for a method in bolívares whose rate failed (error "FX_UNAVAILABLE"). */
  amount: number | null
  /** Bolívares per US$ (methods in VES only). */
  rate: number | null
  rate_date: string | null
  rate_source: 'bcv' | 'manual' | string | null
  error: 'FX_UNAVAILABLE' | string | null
}

export interface CartQuote {
  items: QuoteItem[]
  count: number
  total: number
  currency: string
  /** Kept by the API as before the other methods; read `methods` instead. */
  pago_movil: {
    enabled: boolean
    rate?: number | null
    rate_date?: string | null
    rate_source?: 'bcv' | 'manual' | string | null
    amount_ves?: number | null
    error?: string | null
  }
  /** The manual methods on and complete, in display order (may be empty). */
  methods?: QuoteMethod[]
  paypal: { enabled: boolean }
}

export interface PurchaseResource {
  resource_uuid: string
  course_uuid: string
  name: string
  product_type: 'course' | 'ebook' | string
  thumbnail_url: string | null
  course_url?: string | null
  first_activity_uuid?: string | null
}

export interface PurchaseItem {
  offer_uuid: string
  order_uuid: string
  name: string
  amount: number
  resources: PurchaseResource[]
}

/**
 * How to pay a pending (or expired) order. The keys depend on its method
 * ("" when empty):
 * - pago_movil: bank_name, bank_code, phone, id_document, holder_name, instructions
 * - transferencia: bank_name, bank_code, account_number, account_type, holder_name, id_document, instructions
 * - zelle: email, phone, holder_name, instructions
 * - binance: pay_id, usdt_address, usdt_network, instructions
 */
export interface PurchasePayment {
  bank_name?: string
  bank_code?: string
  /** Pago Móvil's phone, or Zelle's ("+1 305-555-1234"). */
  phone?: string
  id_document?: string
  holder_name?: string | null
  instructions?: string | null
  /** 20 digits. */
  account_number?: string
  account_type?: 'corriente' | 'ahorro' | '' | string
  email?: string
  pay_id?: string
  usdt_address?: string
  /** "TRC20" | "BEP20" | "ERC20" | "SOL" | "POLYGON" | "ARBITRUM" (lib/sc-cart usdtNetworkLabel). */
  usdt_network?: string
}

export interface Purchase {
  purchase_uuid: string
  code: string
  status: 'pending' | 'paid' | 'rejected' | 'cancelled' | 'expired' | 'voided' | string
  provider: string
  /** The manual method (every order before the other methods is "pago_movil"). */
  method: ManualMethod | string
  currency: string
  /** The total in US$. */
  amount: number
  /** What the buyer pays, in pay_currency (absent from an API older than the methods). */
  pay_currency?: PayCurrency | string
  pay_amount?: number | null
  /** Bolívares, rate and its source: null for Zelle and Binance. */
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

/** A failed call, with the HTTP status (404 = not this buyer's order). */
export class CartApiError extends Error {
  status: number
  data: any
  constructor(status: number, data?: any) {
    super(`cart api error (${status})`)
    this.status = status
    this.data = data
  }
}

function detailObject(data: any): Record<string, any> | null {
  let detail = data?.detail
  if (typeof detail === 'string' && detail.trim().startsWith('{')) {
    try {
      detail = JSON.parse(detail)
    } catch {
      return null
    }
  }
  return detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : null
}

/**
 * The API's own wording, only when it is safe to show: the `message` of a
 * structured `detail` ({code, message}, always Spanish), or the plain-string
 * detail of a 429 (the rate limiter, Spanish too). Anything else (FastAPI's
 * English "Not authenticated", proxy pages…) gives null, so the caller shows
 * its own Spanish text.
 */
export function apiMessage(data: any, status?: number): string | null {
  const detail = detailObject(data)
  if (detail) return typeof detail.message === 'string' && detail.message.trim() ? detail.message : null
  const text = typeof data?.detail === 'string' ? data.detail.trim() : ''
  return status === 429 && text ? text : null
}

/** A list of strings of a structured `detail`, e.g. the offer_uuids of OVERLAPPING_OFFERS. */
export function errorList(data: any, field: string): string[] {
  const value = detailObject(data)?.[field]
  return Array.isArray(value) ? value.filter((v: unknown): v is string => typeof v === 'string' && !!v) : []
}

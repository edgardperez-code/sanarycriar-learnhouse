// Sanar y Criar: the manual payment methods in the store pages (Pago Móvil,
// transferencia, Zelle, Binance): which ones a quote offers, how an order is
// paid, and the per-method texts of the cart pack (literal keys, so
// tests/sc-cart.test.mjs checks each one exists).
// Contract: contrato-pagos-manuales.md §0, §A.4 and §A.6.
import {
  MANUAL_METHODS,
  isManualMethod,
  methodCurrency,
  type ManualMethod,
  type PayCurrency,
} from '@components/Payments/commerce'
import { formatPayAmount, formatUsd, quoteMethods, type QuoteMethodEntry } from '@/lib/sc-cart'
import type { CartTranslate } from './useCartT'
import type { CartQuote, Purchase } from './types'

export interface CartMethod extends QuoteMethodEntry {
  method: ManualMethod
}

/** The methods a quote offers that this page knows, in display order. */
export function cartMethods(quote: CartQuote | null | undefined): CartMethod[] {
  return quoteMethods(quote, MANUAL_METHODS) as CartMethod[]
}

/** The known methods of a list of ids (the checkout providers' `methods`), in display order. */
export function knownMethods(ids: readonly unknown[] | null | undefined): ManualMethod[] {
  const set = new Set((ids ?? []).filter(isManualMethod))
  return MANUAL_METHODS.filter((m) => set.has(m))
}

export interface PurchasePay {
  method: ManualMethod
  currency: PayCurrency
  /** What the buyer pays, in `currency`. */
  amount: number | null
}

/**
 * How an order is paid: its method, the currency and the amount the buyer
 * pays (pay_currency / pay_amount; for an API older than the methods, the
 * bolívares of a Pago Móvil order).
 */
export function purchasePay(
  purchase: Pick<Purchase, 'method' | 'pay_currency' | 'pay_amount' | 'amount' | 'amount_ves'>
): PurchasePay {
  const method: ManualMethod = isManualMethod(purchase.method) ? purchase.method : 'pago_movil'
  const sent = purchase.pay_currency
  const currency: PayCurrency = sent === 'VES' || sent === 'USD' || sent === 'USDT' ? sent : methodCurrency(method)
  const fallback = currency === 'VES' ? purchase.amount_ves : purchase.amount
  const amount =
    typeof purchase.pay_amount === 'number' ? purchase.pay_amount : typeof fallback === 'number' ? fallback : null
  return { method, currency, amount }
}

/** The big amount of an order: what she pays, in its currency ("Bs. 35.492,08", "US$ 40,00", "40,00 USDT"). */
export function payAmountText(pay: PurchasePay, amountUsd: unknown): string {
  return formatPayAmount(pay.amount, pay.currency) || formatUsd(amountUsd)
}

/**
 * The line under that amount: the US$ total of an order paid in bolívares,
 * "= US$ 40,00" for USDT, nothing for dollars.
 */
export function payEquivalent(pay: PurchasePay, amountUsd: unknown, ct: CartTranslate): string {
  const usd = formatUsd(amountUsd)
  if (!usd || pay.currency === 'USD') return ''
  return pay.currency === 'USDT' ? ct('purchase.usdt_equivalent', { usd }) : usd
}

/** The line under a method's name in the cart. */
export function methodDescription(method: ManualMethod, ct: CartTranslate): string {
  switch (method) {
    case 'transferencia':
      return ct('method.transferencia_description')
    case 'zelle':
      return ct('method.zelle_description')
    case 'binance':
      return ct('method.binance_description')
    default:
      return ct('method.pago_movil_description')
  }
}

/** The method inside a sentence: "Pagas en el carrito con Pago Móvil, transferencia…". */
export function methodInSentence(method: ManualMethod, ct: CartTranslate): string {
  switch (method) {
    case 'transferencia':
      return ct('method.list_transferencia')
    case 'zelle':
      return ct('method.list_zelle')
    case 'binance':
      return ct('method.list_binance')
    default:
      return ct('method.list_pago_movil')
  }
}

/** The hint under "Confirmar pedido". */
export function confirmHint(method: ManualMethod | null, ct: CartTranslate): string {
  switch (method) {
    case 'pago_movil':
      return ct('confirm.hint_pago_movil')
    case 'transferencia':
      return ct('confirm.hint_transferencia')
    case 'zelle':
      return ct('confirm.hint_zelle')
    case 'binance':
      return ct('confirm.hint_binance')
    default:
      return ct('confirm.hint')
  }
}

/** Step 1 of a pending order, followed by the amount: "Haz un Pago Móvil por". */
export function payStepTitle(method: ManualMethod, ct: CartTranslate): string {
  switch (method) {
    case 'transferencia':
      return ct('purchase.step1_title_transferencia')
    case 'zelle':
      return ct('purchase.step1_title_zelle')
    case 'binance':
      return ct('purchase.step1_title_binance')
    default:
      return ct('purchase.step1_title')
  }
}

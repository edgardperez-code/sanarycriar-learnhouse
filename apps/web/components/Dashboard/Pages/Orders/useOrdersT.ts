'use client'
// Sanar y Criar: translation helper for the "Pedidos" dashboard and the cards
// of "Pagos manuales" in Pagos › Configuración.
//
// Strings live in locales-sc/orders.<lng>.json under the "sc_orders" prefix
// and get merged into locales/*.json by tools/i18n/apply.cjs. The bundled copy
// is also passed as i18next's defaultValue, so the UI never shows a raw key
// even before the merge.
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import ordersEs from '@/locales-sc/orders.es.json'
import ordersEn from '@/locales-sc/orders.en.json'
import { ACCOUNT_TYPES, MISSING_TOKENS, ORDER_STATUSES } from './ordersForm'

type Tree = Record<string, any>

const FALLBACKS: Record<string, Tree> = {
  es: (ordersEs as Tree).sc_orders ?? {},
  en: (ordersEn as Tree).sc_orders ?? {},
}

// Spanish is the platform's primary language, so it backs every other locale.
const DEFAULT_LNG = 'es'

function lookup(tree: Tree | undefined, key: string): string | undefined {
  const value = key.split('.').reduce<any>((node, part) => (node == null ? undefined : node[part]), tree)
  return typeof value === 'string' ? value : undefined
}

function fallbackFor(lng: string, key: string, count?: number): string {
  for (const tree of [FALLBACKS[lng], FALLBACKS[DEFAULT_LNG]]) {
    if (!tree) continue
    if (typeof count === 'number') {
      let suffix = 'other'
      try {
        suffix = new Intl.PluralRules(lng).select(count)
      } catch {
        /* unknown locale: keep "other" */
      }
      const plural = lookup(tree, `${key}_${suffix}`) ?? lookup(tree, `${key}_other`)
      if (plural) return plural
    }
    const plain = lookup(tree, key)
    if (plain) return plain
  }
  return key
}

export type OrdersTranslate = (_key: string, _options?: Record<string, any>) => string

/** Label groups whose keys are API values (states.pending, tabs.all, missing.whatsapp, …). */
export type OrdersLabelGroup =
  | 'states'
  | 'changed'
  | 'tabs'
  | 'empty'
  | 'late_warning'
  | 'expires'
  | 'missing'
  | 'account_types'

/**
 * Label for an API value, e.g. ordersLabel(ot, 'states', 'paid').
 * tests/sc-orders.test.mjs checks that every value of every group has its key.
 */
export function ordersLabel(ot: OrdersTranslate, group: OrdersLabelGroup, value: string, options?: Record<string, any>): string {
  return ot([group, value].join('.'), options)
}

/** Status label; an unknown status shows as the API sent it. */
export function stateLabel(ot: OrdersTranslate, status: string | null | undefined): string {
  const value = String(status ?? '')
  return (ORDER_STATUSES as readonly string[]).includes(value) ? ordersLabel(ot, 'states', value) : value
}

/** Name of a missing datum ("titular", "correo o teléfono de Zelle"); an unknown token as it came. */
export function missingLabel(ot: OrdersTranslate, token: string): string {
  return (MISSING_TOKENS as readonly string[]).includes(token) ? ordersLabel(ot, 'missing', token) : token
}

/** "Corriente" / "Ahorro"; anything else as it came. */
export function accountTypeLabel(ot: OrdersTranslate, value: string | null | undefined): string {
  const type = String(value ?? '')
  return (ACCOUNT_TYPES as readonly string[]).includes(type) ? ordersLabel(ot, 'account_types', type) : type
}

/** `ot('detail.title')` resolves `sc_orders.detail.title`. */
export function useOrdersT() {
  const { t, i18n } = useTranslation()
  const lng = (i18n?.language || DEFAULT_LNG).split('-')[0]

  const ot = useCallback<OrdersTranslate>(
    (key, options) =>
      String(
        t(`sc_orders.${key}`, {
          ...options,
          defaultValue: fallbackFor(lng, key, options?.count),
        })
      ),
    [t, lng]
  )

  return { ot, t, i18n, lng }
}

export default useOrdersT

'use client'
// Sanar y Criar: translation helper for the cart and Pago Móvil order pages.
//
// Strings live in locales-sc/cart.<lng>.json under the "sc_cart" prefix and
// get merged into locales/*.json by tools/i18n/apply.cjs. The bundled copy is
// also passed as i18next's defaultValue, so the UI never shows a raw key even
// before the merge.
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import cartEs from '@/locales-sc/cart.es.json'
import cartEn from '@/locales-sc/cart.en.json'

type Tree = Record<string, any>

const FALLBACKS: Record<string, Tree> = {
  es: (cartEs as Tree).sc_cart ?? {},
  en: (cartEn as Tree).sc_cart ?? {},
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

export type CartTranslate = (_key: string, _options?: Record<string, any>) => string

/** `ct('summary.total')` resolves `sc_cart.summary.total`. */
export function useCartT() {
  const { t, i18n } = useTranslation()
  const lng = (i18n?.language || DEFAULT_LNG).split('-')[0]

  const ct = useCallback<CartTranslate>(
    (key, options) =>
      String(
        t(`sc_cart.${key}`, {
          ...options,
          defaultValue: fallbackFor(lng, key, options?.count),
        })
      ),
    [t, lng]
  )

  return { ct, t, i18n, lng }
}

export default useCartT

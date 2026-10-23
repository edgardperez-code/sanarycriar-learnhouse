'use client'
// Sanar y Criar: translation helper for the commerce (payments) UI.
//
// New commerce strings live in locales-sc/commerce.<lng>.json under the
// "sc_commerce" namespace prefix, and get merged into locales/*.json later.
// Until that merge lands (and as a safety net afterwards), the bundled
// locales-sc copy is passed as i18next's defaultValue, so the UI never shows a
// raw key. Once merged, the regular locale files win.
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import commerceEs from '@/locales-sc/commerce.es.json'
import commerceEn from '@/locales-sc/commerce.en.json'

type Tree = Record<string, any>

const FALLBACKS: Record<string, Tree> = {
  es: (commerceEs as Tree).sc_commerce ?? {},
  en: (commerceEn as Tree).sc_commerce ?? {},
}

// Spanish is the platform's primary language, so it backs every other locale.
const DEFAULT_LNG = 'es'

function lookup(tree: Tree | undefined, key: string): string | undefined {
  const value = key.split('.').reduce<any>((node, part) => (node == null ? undefined : node[part]), tree)
  return typeof value === 'string' ? value : undefined
}

function fallbackFor(lng: string, key: string, count?: number): string {
  const trees = [FALLBACKS[lng], FALLBACKS[DEFAULT_LNG]]
  for (const tree of trees) {
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

export type ScTranslate = (_key: string, _options?: Record<string, any>) => string

/**
 * `sc('offer_page.pay_with_paypal')` resolves `sc_commerce.offer_page.pay_with_paypal`
 * through i18next, falling back to the bundled locales-sc copy.
 */
export function useScT() {
  const { t, i18n } = useTranslation()
  const lng = (i18n?.language || DEFAULT_LNG).split('-')[0]

  const sc = useCallback<ScTranslate>(
    (key, options) =>
      String(
        t(`sc_commerce.${key}`, {
          ...options,
          defaultValue: fallbackFor(lng, key, options?.count),
        })
      ),
    [t, lng]
  )

  return { sc, t, i18n, lng }
}

export default useScT

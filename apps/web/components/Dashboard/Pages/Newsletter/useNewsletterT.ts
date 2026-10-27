'use client'
// Sanar y Criar: translation helper for the newsletter dashboard.
//
// Strings live in locales-sc/newsletter.<lng>.json under the "sc_newsletter"
// prefix and get merged into locales/*.json by tools/i18n/apply.cjs. The
// bundled copy is also passed as i18next's defaultValue, so the UI never shows
// a raw key even before the merge.
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import newsletterEs from '@/locales-sc/newsletter.es.json'
import newsletterEn from '@/locales-sc/newsletter.en.json'

type Tree = Record<string, any>

const FALLBACKS: Record<string, Tree> = {
  es: (newsletterEs as Tree).sc_newsletter ?? {},
  en: (newsletterEn as Tree).sc_newsletter ?? {},
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

export type NewsletterTranslate = (_key: string, _options?: Record<string, any>) => string

/** `nl('popup.title_label')` resolves `sc_newsletter.popup.title_label`. */
export function useNewsletterT() {
  const { t, i18n } = useTranslation()
  const lng = (i18n?.language || DEFAULT_LNG).split('-')[0]

  const nl = useCallback<NewsletterTranslate>(
    (key, options) =>
      String(
        t(`sc_newsletter.${key}`, {
          ...options,
          defaultValue: fallbackFor(lng, key, options?.count),
        })
      ),
    [t, lng]
  )

  return { nl, t, i18n, lng }
}

export default useNewsletterT

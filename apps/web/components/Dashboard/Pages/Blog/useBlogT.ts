'use client'
// Sanar y Criar: translation helper for the blog dashboard.
//
// Strings live in locales-sc/blog.<lng>.json under the "sc_blog" prefix and
// get merged into locales/*.json by tools/i18n/apply.cjs. The bundled copy is
// also passed as i18next's defaultValue, so the UI never shows a raw key even
// before the merge.
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import blogEs from '@/locales-sc/blog.es.json'
import blogEn from '@/locales-sc/blog.en.json'

type Tree = Record<string, any>

const FALLBACKS: Record<string, Tree> = {
  es: (blogEs as Tree).sc_blog ?? {},
  en: (blogEn as Tree).sc_blog ?? {},
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

export type BlogTranslate = (_key: string, _options?: Record<string, any>) => string

/** Label groups whose keys are the API's own values (kind.taller, status.draft, …). */
export type BlogLabelGroup =
  | 'kind'
  | 'category'
  | 'status'
  | 'ai.audience'
  | 'ai.length'
  | 'editor.toolbar'
  | 'editor.errors'

/**
 * Label for an API value, e.g. blogLabel(bt, 'category', 'emociones').
 * tests/sc-blog.test.mjs checks that every value of every group has its key.
 */
export function blogLabel(bt: BlogTranslate, group: BlogLabelGroup, value: string, options?: Record<string, any>): string {
  return bt([group, value].join('.'), options)
}

/** `bt('editor.title_label')` resolves `sc_blog.editor.title_label`. */
export function useBlogT() {
  const { t, i18n } = useTranslation()
  const lng = (i18n?.language || DEFAULT_LNG).split('-')[0]

  const bt = useCallback<BlogTranslate>(
    (key, options) =>
      String(
        t(`sc_blog.${key}`, {
          ...options,
          defaultValue: fallbackFor(lng, key, options?.count),
        })
      ),
    [t, lng]
  )

  return { bt, t, i18n, lng }
}

export default useBlogT

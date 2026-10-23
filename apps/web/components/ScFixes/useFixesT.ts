'use client'
// Sanar y Criar: translation helper for the cross-cutting fixes (course
// actions "Continuar"/"Salir del curso", archive-offer warning).
//
// Strings live in locales-sc/fixes.<lng>.json under the "sc_fixes" prefix and
// get merged into locales/*.json later. Until then (and as a safety net after)
// the bundled copy is i18next's defaultValue, so no raw key is ever shown.
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import fixesEs from '@/locales-sc/fixes.es.json'
import fixesEn from '@/locales-sc/fixes.en.json'

type Tree = Record<string, any>

const FALLBACKS: Record<string, Tree> = {
  es: (fixesEs as Tree).sc_fixes ?? {},
  en: (fixesEn as Tree).sc_fixes ?? {},
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

export type FixesTranslate = (_key: string, _options?: Record<string, any>) => string

/** `fx('course_actions.leave')` resolves `sc_fixes.course_actions.leave`. */
export function useFixesT() {
  const { t, i18n } = useTranslation()
  const lng = (i18n?.language || DEFAULT_LNG).split('-')[0]

  const fx = useCallback<FixesTranslate>(
    (key, options) =>
      String(
        t(`sc_fixes.${key}`, {
          ...options,
          defaultValue: fallbackFor(lng, key, options?.count),
        })
      ),
    [t, lng]
  )

  return { fx, t, lng }
}

export default useFixesT

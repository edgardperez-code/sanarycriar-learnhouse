'use client'
// Sanar y Criar: translation helper for the learning UI (sc_learning), with
// the bundled locales-sc copy as i18next's defaultValue so no raw key shows
// before the merge into locales/*.json (same pattern as useFixesT / useScT).
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import learningEs from '@/locales-sc/learning.es.json'
import learningEn from '@/locales-sc/learning.en.json'

type Tree = Record<string, any>

const FALLBACKS: Record<string, Tree> = {
  es: (learningEs as Tree).sc_learning ?? {},
  en: (learningEn as Tree).sc_learning ?? {},
}

// Spanish is the platform's primary language, so it backs every other locale.
const DEFAULT_LNG = 'es'

function lookup(tree: Tree | undefined, key: string): string | undefined {
  const value = key.split('.').reduce<any>((node, part) => (node == null ? undefined : node[part]), tree)
  return typeof value === 'string' ? value : undefined
}

function fallbackFor(lng: string, key: string): string {
  return lookup(FALLBACKS[lng], key) ?? lookup(FALLBACKS[DEFAULT_LNG], key) ?? key
}

export type LearningTranslate = (_key: string, _options?: Record<string, any>) => string

/** `lt('free_gate.signup')` resolves `sc_learning.free_gate.signup`. */
export function useLearningT() {
  const { t, i18n } = useTranslation()
  const lng = (i18n?.language || DEFAULT_LNG).split('-')[0]
  const lt = useCallback<LearningTranslate>(
    (key, options) => String(t(`sc_learning.${key}`, { ...options, defaultValue: fallbackFor(lng, key) })),
    [t, lng]
  )
  return { lt, t, i18n, lng }
}

export default useLearningT

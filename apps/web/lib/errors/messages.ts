// Sanar y Criar: localized copy for the error surfaces.
//
// The catalog (./catalog.ts) decides WHICH category an error belongs to; what
// the user reads comes from locales-sc/errors.<lng>.json (`sc_errors`), keyed
// by the category's `kind`. The same bundle is merged into locales/*.json, so
// components inside the providers go through react-i18next and use these
// strings only as the defaultValue.
//
// Deliberately free of i18next and React: app/global-error.tsx renders outside
// every provider and still needs Spanish copy, and so do plain helpers such as
// meaningfulMessage() that run in toast callbacks.
import errorsEs from '../../locales-sc/errors.es.json'
import errorsEn from '../../locales-sc/errors.en.json'

type Tree = Record<string, any>

/** The platform language: every language without its own bundle falls back here. */
export const ERRORS_DEFAULT_LANGUAGE = 'es'

const BUNDLES: Record<string, Tree> = {
  es: (errorsEs as Tree).sc_errors ?? {},
  en: (errorsEn as Tree).sc_errors ?? {},
}

/** `en-GB` -> `en`; anything without a bundle -> Spanish. */
export function errorsLanguage(lng?: string | null): 'es' | 'en' {
  const code = String(lng || '').split('-')[0].toLowerCase()
  return code === 'en' ? 'en' : 'es'
}

function lookup(tree: Tree | undefined, key: string): string | undefined {
  const value = key.split('.').reduce<any>((node, part) => (node == null ? undefined : node[part]), tree)
  return typeof value === 'string' ? value : undefined
}

/** `errorText('actions.retry', 'en')` -> "Retry". Falls back to Spanish, then to the key. */
export function errorText(key: string, lng?: string | null): string {
  return lookup(BUNDLES[errorsLanguage(lng)], key) ?? lookup(BUNDLES[ERRORS_DEFAULT_LANGUAGE], key) ?? key
}

/**
 * The UI language without i18next: <html lang>, which public/dir-init.js sets
 * before paint and I18nProvider keeps in sync. Spanish on the server.
 */
export function documentLanguage(): string {
  if (typeof document === 'undefined') return ERRORS_DEFAULT_LANGUAGE
  return document.documentElement?.getAttribute('lang') || ERRORS_DEFAULT_LANGUAGE
}

export type CategoryField = 'title' | 'description' | 'label'

/** Localized title / description / short label of a catalog category. */
export function categoryText(kind: string, field: CategoryField, lng?: string | null): string {
  return errorText(`categories.${kind}.${field}`, lng)
}

/** Labels for Sentry's report dialog (its own defaults are English). */
export function reportDialogLabels(lng?: string | null) {
  const tr = (key: string) => errorText(`report_dialog.${key}`, lng)
  return {
    lang: errorsLanguage(lng),
    title: tr('title'),
    subtitle: tr('subtitle'),
    subtitle2: '',
    labelName: tr('name'),
    labelEmail: tr('email'),
    labelComments: tr('comments'),
    labelClose: tr('close'),
    labelSubmit: tr('submit'),
    successMessage: tr('success'),
  }
}

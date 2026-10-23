import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

import { ERROR_CATALOG, UNKNOWN_CATEGORY } from '../lib/errors/catalog.ts'
import { meaningfulMessage } from '../lib/errors/classify.ts'
import { categoryText, errorText, errorsLanguage, reportDialogLabels } from '../lib/errors/messages.ts'
import { detectClientLanguage } from '../lib/direction.ts'

/**
 * Sanar y Criar: guards for the Spanish-first copy that lives outside the
 * upstream locale keys (sc_errors, sc_brand, sc_ui) and for the language
 * detection used by the last-resort error screen.
 */

const webRoot = path.resolve(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(webRoot, p), 'utf8')
const readJson = (p) => JSON.parse(read(p))

const flatten = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v) ? flatten(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]
  )

const locales = {
  es: Object.fromEntries(flatten(readJson('locales/es.json'))),
  en: Object.fromEntries(flatten(readJson('locales/en.json'))),
}

describe('error copy (sc_errors)', () => {
  const kinds = [...ERROR_CATALOG.map((c) => c.kind), UNKNOWN_CATEGORY.kind]

  test('every catalog category has a label, title and description in es and en', () => {
    const missing = []
    for (const lng of ['es', 'en']) {
      const bundle = Object.fromEntries(flatten(readJson(`locales-sc/errors.${lng}.json`)))
      for (const kind of kinds) {
        for (const field of ['label', 'title', 'description']) {
          const key = `sc_errors.categories.${kind}.${field}`
          if (!bundle[key]) missing.push(`${lng}:${key}`)
          // The merged locale copy is what react-i18next reads.
          else if (locales[lng][key] !== bundle[key]) missing.push(`${lng}:${key} (locales/${lng}.json out of date)`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  test('Spanish is the default and the fallback', () => {
    expect(errorsLanguage(undefined)).toBe('es')
    expect(errorsLanguage('fr')).toBe('es')
    expect(errorsLanguage('en-GB')).toBe('en')
    expect(categoryText('not_found', 'title')).toBe('No encontramos lo que buscas')
    expect(categoryText('not_found', 'title', 'en')).toBe("We couldn't find that")
    expect(errorText('details.show')).toBe('Mostrar detalles técnicos')
    expect(errorText('no.such.key', 'en')).toBe('no.such.key')
  })

  test('meaningfulMessage is localized (Spanish without a document)', () => {
    expect(meaningfulMessage({ status: 404 })).toBe('No encontramos lo que buscas')
    expect(meaningfulMessage({ status: 404 }, 'en')).toBe("We couldn't find that")
  })

  test('the Sentry report dialog gets translated labels', () => {
    const labels = reportDialogLabels('es')
    expect(labels.lang).toBe('es')
    expect(labels.title).toBe('Cuéntanos qué pasó')
    expect(labels.labelSubmit).toBe('Enviar reporte')
  })

  test('every sc_errors key the error surfaces ask for exists in es and en', () => {
    // [file, helper call, key prefix inside sc_errors]
    const uses = [
      ['app/global-error.tsx', /\btr\('([a-z_.]+)'\)/g, ''],
      ['components/Objects/StyledElements/Error/Error.tsx', /\btr\('([a-z_.]+)'\)/g, ''],
      ['components/Objects/StyledElements/Error/ErrorActions.tsx', /\blabel\('([a-z_]+)'\)/g, 'actions.'],
      ['components/Objects/StyledElements/Error/OrgNotFound.tsx', /\btr\('([a-z_]+)'\)/g, 'org_not_found.'],
      ['components/Objects/StyledElements/Error/NotFoundContent.tsx', /\btr\('([a-z_]+)'\)/g, 'not_found_page.'],
    ]
    const missing = []
    let checked = 0
    for (const [file, re, prefix] of uses) {
      for (const [, key] of read(file).matchAll(re)) {
        checked++
        for (const lng of ['es', 'en']) {
          if (!locales[lng][`sc_errors.${prefix}${key}`]) missing.push(`${lng}:sc_errors.${prefix}${key} (${file})`)
        }
      }
    }
    expect(checked).toBeGreaterThan(20)
    expect(missing).toEqual([])
  })

  test('error surfaces carry no hard-coded English', () => {
    for (const file of [
      'app/global-error.tsx',
      'components/Objects/StyledElements/Error/Error.tsx',
      'components/Objects/StyledElements/Error/ErrorActions.tsx',
      'components/Objects/StyledElements/Error/OrgNotFound.tsx',
      'lib/errors/report.ts',
    ]) {
      // Code only: comments may still describe the upstream behavior in English.
      const src = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      for (const english of [
        'technical details',
        'Try again',
        'Report this problem',
        'Signing out',
        'Tell us what happened',
        'Enter Your Organization',
        'support@learnhouse.io',
      ]) {
        expect({ file, has: src.includes(english) }).toEqual({ file, has: false })
      }
    }
  })
})

describe('global 404 page', () => {
  test('is branded and Spanish', () => {
    const page = read('app/not-found.tsx')
    expect(page).not.toContain('black_logo')
    expect(page).not.toContain('Go back to homepage')
    expect(page).toContain('Página no encontrada | Sanar y Criar')
    expect(read('components/Objects/StyledElements/Error/NotFoundContent.tsx')).toContain('sc_errors.not_found_page.')
  })
})

describe('detectClientLanguage follows dir-init.js', () => {
  const realWindow = globalThis.window

  function fakeWindow({ stored, picked, search = '' }) {
    const store = new Map()
    if (stored) store.set('i18nextLng', stored)
    if (picked) store.set('i18nextLng_userPicked', '1')
    globalThis.window = {
      localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null) },
      location: { search },
    }
  }

  afterEach(() => {
    if (realWindow === undefined) delete globalThis.window
    else globalThis.window = realWindow
  })

  test('server side is Spanish', () => {
    delete globalThis.window
    expect(detectClientLanguage()).toBe('es')
  })

  test('no pick and no ?lng: Spanish, whatever the browser says', () => {
    fakeWindow({})
    expect(detectClientLanguage()).toBe('es')
  })

  test('a stored language without the pick flag is ignored', () => {
    fakeWindow({ stored: 'en' })
    expect(detectClientLanguage()).toBe('es')
  })

  test('an explicit pick wins, then ?lng', () => {
    fakeWindow({ stored: 'en', picked: true, search: '?lng=fr' })
    expect(detectClientLanguage()).toBe('en')
    fakeWindow({ search: '?lng=fr' })
    expect(detectClientLanguage()).toBe('fr')
  })
})

describe('brand and dashboard copy', () => {
  test('every sc_brand / sc_ui key used in code exists in es and en', () => {
    const files = [
      'components/Footers/LegalFooters.tsx',
      'components/Footers/ScOrgFooter.tsx',
      'components/Landings/LandingClassic.tsx',
      'components/Objects/Menus/OrgMenu.tsx',
      'components/Objects/Thumbnails/CourseThumbnail.tsx',
      'components/Objects/AI/AIImageButton.tsx',
      'components/Objects/Activities/Video/CaptionsSettings.tsx',
      'components/Dashboard/Pages/Users/OrgUsers/OrgUsers.tsx',
      'components/Dashboard/Pages/Org/OrgEditGeneral/OrgEditGeneral.tsx',
      'components/Dashboard/Pages/Org/OrgEditSEO/OrgEditSEO.tsx',
      'components/Dashboard/Pages/Users/UserAnalytics/UserAuditExport.tsx',
    ]
    const missing = []
    const has = (lng, key) => key in locales[lng] || `${key}_one` in locales[lng] || `${key}_other` in locales[lng]
    for (const file of files) {
      const src = read(file)
      const keys = [...src.matchAll(/['"`]((?:sc_brand|sc_ui)\.[a-z0-9_.]+)['"`]/g)].map((m) => m[1])
      // Helpers that prefix a namespace: ax('…') -> sc_ui.audit_export.…
      if (file.endsWith('UserAuditExport.tsx')) {
        keys.push(...[...src.matchAll(/\bax\(\s*'([a-z0-9_]+)'/g)].map((m) => `sc_ui.audit_export.${m[1]}`))
      }
      for (const key of keys) for (const lng of ['es', 'en']) if (!has(lng, key)) missing.push(`${lng}:${key} (${file})`)
    }
    // Dynamic lookups.
    const brand = read('components/Objects/Menus/scBrand.ts')
    for (const [, key] of brand.matchAll(/key: '([a-z]+)'/g)) {
      for (const lng of ['es', 'en']) if (!has(lng, `sc_brand.legal.${key}`)) missing.push(`${lng}:sc_brand.legal.${key}`)
    }
    const general = read('components/Dashboard/Pages/Org/OrgEditGeneral/OrgEditGeneral.tsx')
    for (const [, value] of general.matchAll(/\{ value: '([a-z_]+)', emoji:/g)) {
      for (const lng of ['es', 'en']) {
        if (!has(lng, `sc_ui.org_general.labels.${value}`)) missing.push(`${lng}:sc_ui.org_general.labels.${value}`)
      }
    }
    for (const [, key] of general.matchAll(/\bv\('([a-z_]+)'/g)) {
      for (const lng of ['es', 'en']) {
        if (!has(lng, `sc_ui.org_general.validation.${key}`)) missing.push(`${lng}:sc_ui.org_general.validation.${key}`)
      }
    }
    expect(missing).toEqual([])
  })

  test('the hub footer is Sanar y Criar, not LearnHouse', () => {
    const src = read('components/Footers/LegalFooters.tsx')
    expect(src).not.toContain('LearnHouse, Inc.')
    expect(src).not.toContain('learnhouse.io')
    expect(src).toContain("getScSiteUrl('/terminos')")
    expect(src).toContain("getScSiteUrl('/privacidad')")
  })

  test('page titles fall back to Sanar y Criar', () => {
    for (const page of ['login', 'signup', 'forgot', 'reset', 'verify-email']) {
      expect({ page, src: read(`app/auth/${page}/page.tsx`).includes('LearnHouse') }).toEqual({ page, src: false })
    }
    expect(read('app/home/page.tsx')).toContain("'Inicio | Sanar y Criar'")
  })
})

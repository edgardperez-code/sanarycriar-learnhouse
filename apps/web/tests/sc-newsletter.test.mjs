// Sanar y Criar: newsletter dashboard helpers (validation of the pop-up
// settings, dirty check, pagination and the CSV file name), plus the i18n
// bundle the dashboard falls back to. All fixtures are synthetic.

import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const {
  NEWSLETTER_LIMITS,
  validateNewsletterSettings,
  isSettingsDirty,
  totalPages,
  exportFileName,
  textLength,
  draftFromSettings,
  settingsPayload,
} = await import('../components/Dashboard/Pages/Newsletter/newsletterForm.ts')

// DEFAULT_SETTINGS from the contract (apps/api/src/services/newsletter/settings.py).
const DEFAULTS = Object.freeze({
  enabled: false,
  title: 'Recibe ideas para criar desde la calma',
  body: 'Déjame tu correo y te escribiré de vez en cuando con consejos prácticos de crianza, novedades y avisos de mis cursos y talleres.',
  button_label: 'Quiero recibirlas',
  dismiss_label: 'Ahora no',
  success_message: '¡Listo, gracias por sumarte! Muy pronto te llegará mi primer correo.',
  privacy_note: 'Sin spam. Puedes darte de baja cuando quieras con un clic.',
  delay_seconds: 0,
  dismiss_days: 30,
})

const draft = (patch = {}) => ({ ...DEFAULTS, ...patch })
const codes = (d) => validateNewsletterSettings(d).map((e) => `${e.field}:${e.code}`)

describe('validateNewsletterSettings', () => {
  test('the suggested defaults are valid', () => {
    expect(validateNewsletterSettings(draft())).toEqual([])
  })

  test('title: empty (or blank) is required, 121 characters is too long', () => {
    expect(codes(draft({ title: '' }))).toEqual(['title:required'])
    expect(codes(draft({ title: '   ' }))).toEqual(['title:required'])
    expect(codes(draft({ title: 'a'.repeat(120) }))).toEqual([])
    expect(codes(draft({ title: 'a'.repeat(121) }))).toEqual(['title:too_long'])
  })

  test('every text has its own limit, checked after trimming', () => {
    expect(codes(draft({ body: 'b'.repeat(501) }))).toEqual(['body:too_long'])
    expect(codes(draft({ body: `  ${'b'.repeat(500)}  ` }))).toEqual([])
    expect(codes(draft({ button_label: 'c'.repeat(41) }))).toEqual(['button_label:too_long'])
    expect(codes(draft({ dismiss_label: '' }))).toEqual(['dismiss_label:required'])
    expect(codes(draft({ success_message: 'd'.repeat(301) }))).toEqual(['success_message:too_long'])
    expect(codes(draft({ privacy_note: 'e'.repeat(301) }))).toEqual(['privacy_note:too_long'])
  })

  test('an emoji counts as one character, like the API', () => {
    expect(textLength('🌱')).toBe(1)
    expect(codes(draft({ button_label: '🌱'.repeat(40) }))).toEqual([])
  })

  test('an empty privacy note is valid', () => {
    expect(validateNewsletterSettings(draft({ privacy_note: '' }))).toEqual([])
  })

  test('delay must be a whole number from 0 to 120', () => {
    for (const bad of [-1, 121, 1.5, Number.NaN]) {
      expect(codes(draft({ delay_seconds: bad }))).toEqual(['delay_seconds:range'])
    }
    for (const ok of [0, 5, 120]) {
      expect(codes(draft({ delay_seconds: ok }))).toEqual([])
    }
  })

  test('days must be a whole number from 1 to 365', () => {
    for (const bad of [0, 366, 2.5]) {
      expect(codes(draft({ dismiss_days: bad }))).toEqual(['dismiss_days:range'])
    }
    for (const ok of [1, 30, 365]) {
      expect(codes(draft({ dismiss_days: ok }))).toEqual([])
    }
  })

  test('limits match the API', () => {
    expect(NEWSLETTER_LIMITS).toEqual({
      title: 120,
      body: 500,
      button_label: 40,
      dismiss_label: 40,
      success_message: 300,
      privacy_note: 300,
      delay_seconds: { min: 0, max: 120 },
      dismiss_days: { min: 1, max: 365 },
    })
  })
})

describe('isSettingsDirty', () => {
  test('equal drafts are clean; any change is dirty', () => {
    expect(isSettingsDirty(draft(), draft())).toBe(false)
    expect(isSettingsDirty(draft(), draft({ enabled: true }))).toBe(true)
    expect(isSettingsDirty(draft(), draft({ title: 'Otro título' }))).toBe(true)
    expect(isSettingsDirty(draft(), draft({ dismiss_days: 31 }))).toBe(true)
  })

  test('an emptied number field (NaN) is dirty against a number, clean against itself', () => {
    expect(isSettingsDirty(draft(), draft({ delay_seconds: Number.NaN }))).toBe(true)
    expect(isSettingsDirty(draft({ delay_seconds: Number.NaN }), draft({ delay_seconds: Number.NaN }))).toBe(false)
  })

  test('the admin payload extras (updated_at, defaults, …) are ignored', () => {
    const fromApi = { ...draft(), updated_at: null, resend_enabled: false, defaults: draft() }
    expect(isSettingsDirty(draftFromSettings(fromApi), draft())).toBe(false)
    expect(Object.keys(draftFromSettings(fromApi)).sort()).toEqual(Object.keys(DEFAULTS).sort())
  })
})

describe('settingsPayload', () => {
  test('trims every text and keeps the rest', () => {
    const payload = settingsPayload(draft({ title: '  Hola  ', privacy_note: '  ', enabled: true }))
    expect(payload.title).toBe('Hola')
    expect(payload.privacy_note).toBe('')
    expect(payload.enabled).toBe(true)
    expect(payload.dismiss_days).toBe(30)
  })
})

describe('totalPages', () => {
  test('at least one page, rounding up', () => {
    expect(totalPages(0, 25)).toBe(1)
    expect(totalPages(25, 25)).toBe(1)
    expect(totalPages(26, 25)).toBe(2)
    expect(totalPages(100, 25)).toBe(4)
  })
})

describe('exportFileName', () => {
  test('uses the local date, zero-padded', () => {
    expect(exportFileName(new Date(2026, 9, 26))).toBe('suscriptores-boletin-20261026.csv')
    expect(exportFileName(new Date(2027, 0, 5, 23, 59))).toBe('suscriptores-boletin-20270105.csv')
    expect(exportFileName()).toMatch(/^suscriptores-boletin-\d{8}\.csv$/)
  })
})

describe('sc_newsletter strings', () => {
  const webRoot = path.resolve(import.meta.dirname, '..')
  const readJson = (p) => JSON.parse(fs.readFileSync(path.join(webRoot, p), 'utf8'))
  const flatten = (obj, prefix = '') =>
    Object.entries(obj).flatMap(([k, v]) =>
      v && typeof v === 'object' && !Array.isArray(v) ? flatten(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]
    )

  test('es and en bundles have the same keys and placeholders, and match the merged locales', () => {
    const problems = []
    const es = Object.fromEntries(flatten(readJson('locales-sc/newsletter.es.json')))
    const en = Object.fromEntries(flatten(readJson('locales-sc/newsletter.en.json')))
    const tokens = (s) => (s.match(/\{\{[^}]+\}\}/g) || []).sort().join(',')
    for (const key of new Set([...Object.keys(es), ...Object.keys(en)])) {
      if (typeof es[key] !== 'string' || typeof en[key] !== 'string') problems.push(`missing ${key}`)
      else if (tokens(es[key]) !== tokens(en[key])) problems.push(`placeholders differ in ${key}`)
    }
    for (const [lng, bundle] of [['es', es], ['en', en], ['ar', en]]) {
      const merged = Object.fromEntries(flatten(readJson(`locales/${lng}.json`)))
      for (const [key, value] of Object.entries(bundle)) {
        if (merged[key] !== value) problems.push(`locales/${lng}.json ${key} out of date (run tools/i18n/apply.cjs)`)
      }
    }
    expect(problems).toEqual([])
    expect(es['sc_newsletter.menu_label']).toBe('Boletín')
  })
})

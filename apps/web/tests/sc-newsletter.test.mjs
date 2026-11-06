// Sanar y Criar: newsletter dashboard helpers (validation of the pop-up
// settings, dirty check, pagination and the CSV file name), the i18n bundle
// the dashboard falls back to, and the pop-up preview (rendered to markup:
// the website's welcome pop-up, with no email field and no thank-you view).
// All fixtures are synthetic.

import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'

// No resources: every string falls back to the bundled Spanish copy, as before the merge.
await i18next.use(initReactI18next).init({ lng: 'es', resources: {}, interpolation: { escapeValue: false } })

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

  // The form no longer shows it, but the API still requires it on every save.
  test('keeps the saved success_message', () => {
    expect(settingsPayload(draft({ success_message: '  Gracias  ' })).success_message).toBe('Gracias')
    expect(settingsPayload(draft()).success_message).toBe(DEFAULTS.success_message)
  })
})

// The welcome pop-up of the website (web/src/components/islands/NewsletterPopup.tsx,
// 2026-11): it offers the free guide and its button goes to the sign-up.
const { default: NewsletterPopupPreview, GIFT_TITLE } = await import(
  '../components/Dashboard/Pages/Newsletter/NewsletterPopupPreview.tsx'
)

describe('pop-up preview', () => {
  const POPUP = draft({
    enabled: true,
    title: 'Necesito acompañarte en tu *maternidad*.',
    body: 'Soy Hilda, psicóloga infanto-juvenil y mamá.',
    button_label: 'Sí, quiero mi guía gratis',
    dismiss_label: 'Ahora no, quiero ver la web',
    success_message: 'Mensaje que la ventana ya no muestra',
    privacy_note: 'Después te seguiré escribiendo, como una amiga.',
    delay_seconds: 5,
    dismiss_days: 7,
  })
  const render = (device, patch = {}) =>
    renderToStaticMarkup(React.createElement(NewsletterPopupPreview, { draft: { ...POPUP, ...patch }, device }))

  test('computer: the drawn gift beside the texts, the title accent in italics', () => {
    const html = render('desktop')
    expect(html).toContain('Necesito acompañarte en tu <em class="sc-title-accent">maternidad</em>.')
    expect(html).not.toContain('*')
    for (const text of [
      // The drawing: chip and cover.
      '>Tu regalo<',
      '>MALA<',
      '>MAMÁ?<',
      // The texts column.
      'Te tengo un regalo, mamá',
      POPUP.body,
      '>Gratis<',
      `Crea tu cuenta gratis y te regalo mi guía <strong class="font-semibold text-violeta">«${GIFT_TITLE}»</strong>`,
      POPUP.button_label,
      POPUP.dismiss_label,
      POPUP.privacy_note,
      'Política de privacidad',
    ]) {
      expect(html).toContain(text)
    }
    expect(GIFT_TITLE).toBe('¿Será que soy una mala mamá?')
    expect(html).toContain('grid-cols-[0.85fr_1.15fr]')
  })

  test('phone: a bottom sheet without the drawing, the body or the privacy note', () => {
    const html = render('mobile')
    for (const text of ['<em class="sc-title-accent">maternidad</em>', 'Te tengo un regalo, mamá', '>Gratis<', POPUP.button_label, POPUP.dismiss_label]) {
      expect(html).toContain(text)
    }
    for (const text of ['>Tu regalo<', '>MALA<', POPUP.body, POPUP.privacy_note, 'Política de privacidad']) {
      expect(html).not.toContain(text)
    }
    expect(html).toContain('rounded-t-[24px]')
  })

  test('no email field, no thank-you view, nothing focusable', () => {
    for (const device of ['desktop', 'mobile']) {
      const html = render(device)
      expect(html).not.toContain(POPUP.success_message)
      expect(html).not.toMatch(/<(input|label|button|a|textarea|select)\b/)
      expect(html).not.toContain('tabindex')
      expect(html).not.toContain('tu@correo.com')
      // The whole mock screen is inert and hidden from screen readers.
      expect(html).toMatch(/<div[^>]*\binert=""[^>]*\baria-hidden="true"[^>]*\bdir="ltr"/)
    }
  })

  test('a title without asterisks has no accent; an empty note leaves just the link', () => {
    const html = render('desktop', { title: 'Hola, mamá', privacy_note: '  ' })
    expect(html).not.toContain('<em')
    expect(html).toContain('Hola, mamá')
    expect(html).toContain('Política de privacidad')
  })

  test('a switched-off pop-up says so above the mock', () => {
    expect(render('desktop', { enabled: false })).toContain('La ventana está desactivada: no aparece en el sitio web.')
    expect(render('desktop')).not.toContain('La ventana está desactivada')
  })

  test('the tab has no thank-you field and no form/thank-you switch', () => {
    const page = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'components/Dashboard/Pages/Newsletter/NewsletterPopupPage.tsx'), 'utf8')
    expect(page).not.toContain('field="success_message"')
    expect(page).not.toContain('preview.show_success')
    expect(page).toContain('<NewsletterPopupPreview draft={draft} device={device} />')
    // Restoring the suggested texts still restores it (it goes back in every save).
    expect(page).toMatch(/const TEXT_KEYS[^=]*=\s*\[[^\]]*'success_message'/)
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

  // Sanar y Criar: the subscriber's name and the new origins (contract "regalo" §B4).
  test('name column, origin labels and the title hint', () => {
    const es = Object.fromEntries(flatten(readJson('locales-sc/newsletter.es.json')))
    expect(es['sc_newsletter.subscribers.col_name']).toBe('Nombre')
    expect(es['sc_newsletter.subscribers.search_placeholder']).toBe('Buscar por correo o nombre')
    expect(es['sc_newsletter.source.popup']).toBe('Ventana (antes)')
    expect(es['sc_newsletter.source.ventana_web']).toBe('Ventana de bienvenida')
    expect(es['sc_newsletter.source.footer']).toBe('Pie de página')
    expect(es['sc_newsletter.source.cartas']).toBe('Cartas (inicio)')
    expect(es['sc_newsletter.source.test']).toBe('Test de crianza')
    expect(es['sc_newsletter.source.guia_gratis']).toBe('Guía gratis')
    expect(es['sc_newsletter.source.other']).toBe('Otro')
    expect(es['sc_newsletter.popup.title_hint']).toBe(
      'Encierra una palabra entre asteriscos para mostrarla en cursiva: Necesito acompañarte en tu *maternidad*.'
    )
  })

  // The welcome pop-up has no email field and no thank-you message (review F15).
  test('no help text describes the old pop-up', () => {
    const es = Object.fromEntries(flatten(readJson('locales-sc/newsletter.es.json')))
    const en = Object.fromEntries(flatten(readJson('locales-sc/newsletter.en.json')))
    const stale = [
      ...Object.entries(es).filter(([, v]) => /agradec|correo electrónico|tu@correo|alguien se suscribe|Si se suscribe,/i.test(v)),
      ...Object.entries(en).filter(([, v]) => /thank-you|thank you|you@email|someone subscribes|If they subscribe,/i.test(v)),
    ]
    expect(stale).toEqual([])
    for (const key of ['popup.success_label', 'popup.success_hint', 'preview.show_form', 'preview.show_success', 'preview.email_label', 'preview.email_placeholder']) {
      expect({ key, es: es[`sc_newsletter.${key}`], en: en[`sc_newsletter.${key}`] }).toEqual({ key, es: undefined, en: undefined })
    }
    expect(es['sc_newsletter.preview.eyebrow']).toBe('Te tengo un regalo, mamá')
    expect(es['sc_newsletter.preview.free_line']).toBe('Crea tu cuenta gratis y te regalo mi guía')
    expect(es['sc_newsletter.preview.gift_chip']).toBe('Tu regalo')
    expect(es['sc_newsletter.preview.free_badge']).toBe('Gratis')
  })

  test("every nl('…') key the pop-up tab and its preview read exists", () => {
    const es = Object.fromEntries(flatten(readJson('locales-sc/newsletter.es.json')))
    const missing = []
    let checked = 0
    for (const file of ['NewsletterPopupPage.tsx', 'NewsletterPopupPreview.tsx']) {
      const src = fs.readFileSync(path.join(webRoot, 'components/Dashboard/Pages/Newsletter', file), 'utf8')
      for (const [, key] of src.matchAll(/\bnl\(\s*'([a-z0-9_.]+)'/g)) {
        checked++
        if (typeof es[`sc_newsletter.${key}`] !== 'string') missing.push(`${file}: ${key}`)
      }
    }
    expect(checked).toBeGreaterThan(30)
    expect(missing).toEqual([])
  })
})

// Sanar y Criar: "Pedidos" dashboard helpers (bank reference, reasons, money
// in es-VE, time left to pay, list query, Pago Móvil settings form) and the
// sc_orders i18n bundle. All fixtures are synthetic.

import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const {
  ORDER_STATUSES,
  ORDER_TABS,
  ORDER_LIMITS,
  ORDERS_PAGE_SIZE,
  MANUAL_FIELDS,
  MANUAL_REQUIRED_FIELDS,
  VE_BANKS,
  OTHER_BANK,
  normalizeReference,
  isValidReference,
  isValidReason,
  isValidNote,
  formatAmount,
  formatBs,
  formatUsd,
  formatRate,
  formatDateTime,
  formatIsoDate,
  statusTone,
  expiresLabel,
  buildListParams,
  cleanSearch,
  pageRange,
  parsePurchaseCode,
  customerName,
  productSummary,
  canConfirm,
  canReject,
  canVoid,
  needsLateWarning,
  errorDetail,
  errorList,
  parseManualRate,
  formatRatePreview,
  rateFarFromBcv,
  proportionalVes,
  whatsappInfo,
  formatWhatsapp,
  rateInputValue,
  bankByCode,
  bankChoiceFor,
  draftFromManualSettings,
  manualSettingsPayload,
  validateManualDraft,
  isManualDraftDirty,
  parseWindowHours,
} = await import('../components/Dashboard/Pages/Orders/ordersForm.ts')

// Intl puts no-break spaces in "p. m."; compare with plain spaces.
const plain = (s) => s.replace(/\s/g, ' ')

describe('bank reference (contract §0.2)', () => {
  test('normalized like the API: no spaces, hyphens or dots, upper case', () => {
    expect(normalizeReference(' 0012-3456.78 ')).toBe('0012345678')
    expect(normalizeReference('ab c-1.2')).toBe('ABC12')
    expect(normalizeReference('0123\t4567\n8901')).toBe('012345678901')
    expect(normalizeReference(null)).toBe('')
  })

  test('valid: 4 to 30 letters or digits once normalized', () => {
    for (const ok of ['1234', 'abc123', '0123 4567 8901', '12.34-56', 'A'.repeat(30)]) {
      expect({ ok, valid: isValidReference(ok) }).toEqual({ ok, valid: true })
    }
    for (const bad of ['', '123', '1 2 3', 'A'.repeat(31), '12_34', '12/34', 'ÑANDÚ12', '12#4']) {
      expect({ bad, valid: isValidReference(bad) }).toEqual({ bad, valid: false })
    }
  })
})

describe('reasons and notes', () => {
  test('reject/void reason: 3 to 300 characters once trimmed', () => {
    expect(isValidReason('no')).toBe(false)
    expect(isValidReason('   no   ')).toBe(false)
    expect(isValidReason('sí.')).toBe(true)
    expect(isValidReason('x'.repeat(300))).toBe(true)
    expect(isValidReason('x'.repeat(301))).toBe(false)
    // Code points, like Python's len(): three emoji are three characters.
    expect(isValidReason('🙂🙂🙂')).toBe(true)
    expect(isValidReason(undefined)).toBe(false)
  })

  test('note: up to 500 characters', () => {
    expect(isValidNote('')).toBe(true)
    expect(isValidNote('x'.repeat(500))).toBe(true)
    expect(isValidNote('x'.repeat(501))).toBe(false)
  })
})

describe('money, rates and dates (es-VE, America/Caracas)', () => {
  test('amounts: 35.492,08 with Bs. and US$', () => {
    expect(formatAmount(35492.08)).toBe('35.492,08')
    expect(formatBs(35492.08)).toBe('Bs. 35.492,08')
    expect(formatUsd(40)).toBe('US$ 40,00')
    expect(formatUsd(25.5)).toBe('US$ 25,50')
    expect(formatBs(1234.5)).toBe('Bs. 1.234,50')
    expect(formatBs(1234567.891)).toBe('Bs. 1.234.567,89')
    expect(formatBs(null)).toBe('—')
    expect(formatBs('abc')).toBe('—')
    expect(formatUsd(undefined)).toBe('—')
  })

  test('rate: two decimals, like the BCV figure people quote', () => {
    expect(formatRate(887.302)).toBe('887,30')
    expect(formatRate('887.30')).toBe('887,30')
    expect(formatRate(null)).toBe('—')
  })

  test('dates', () => {
    expect(plain(formatDateTime('2026-10-28T19:45:00Z'))).toBe('28/10/2026, 3:45 p. m.')
    expect(plain(formatDateTime('2026-10-28T03:05:00Z'))).toBe('27/10/2026, 11:05 p. m.')
    expect(formatDateTime('not a date')).toBe('—')
    expect(formatIsoDate('2026-10-27')).toBe('27/10/2026')
    expect(formatIsoDate(null)).toBe('—')
  })
})

describe('time left to pay (expiresLabel)', () => {
  const now = Date.parse('2026-10-27T12:00:00Z')
  const at = (ms) => new Date(now + ms).toISOString()
  const MIN = 60_000
  const HOUR = 60 * MIN

  test('past or now: expired', () => {
    expect(expiresLabel(at(-1), now)).toEqual({ expired: true, unit: 'expired', count: 0 })
    expect(expiresLabel(at(0), now)).toEqual({ expired: true, unit: 'expired', count: 0 })
  })

  test('minutes under an hour, rounded up', () => {
    expect(expiresLabel(at(30 * MIN), now)).toEqual({ expired: false, unit: 'minutes', count: 30 })
    expect(expiresLabel(at(10 * 1000), now)).toEqual({ expired: false, unit: 'minutes', count: 1 })
    expect(expiresLabel(at(59 * MIN), now)).toEqual({ expired: false, unit: 'minutes', count: 59 })
    // 59.5 minutes reads "1 h", never "60 min".
    expect(expiresLabel(at(59.5 * MIN), now)).toEqual({ expired: false, unit: 'hours', count: 1 })
  })

  test('hours under two days, then days', () => {
    expect(expiresLabel(at(5 * HOUR + 10 * MIN), now)).toEqual({ expired: false, unit: 'hours', count: 5 })
    expect(expiresLabel(at(24 * HOUR - MIN), now)).toEqual({ expired: false, unit: 'hours', count: 24 })
    expect(expiresLabel(at(47 * HOUR), now)).toEqual({ expired: false, unit: 'hours', count: 47 })
    expect(expiresLabel(at(48 * HOUR), now)).toEqual({ expired: false, unit: 'days', count: 2 })
    expect(expiresLabel(at(168 * HOUR), now)).toEqual({ expired: false, unit: 'days', count: 7 })
  })

  test('no valid date: null', () => {
    expect(expiresLabel(null, now)).toBeNull()
    expect(expiresLabel('mañana', now)).toBeNull()
  })
})

describe('statuses and actions', () => {
  test('six statuses and seven tabs, "Por confirmar" first', () => {
    expect([...ORDER_STATUSES]).toEqual(['pending', 'paid', 'rejected', 'cancelled', 'expired', 'voided'])
    expect([...ORDER_TABS]).toEqual(['pending', 'paid', 'rejected', 'expired', 'cancelled', 'voided', 'all'])
  })

  test('chip tone of every status', () => {
    expect(ORDER_STATUSES.map((s) => statusTone(s))).toEqual(['warning', 'success', 'danger', 'neutral', 'neutral', 'accent'])
    expect(statusTone('whatever')).toBe('neutral')
  })

  test('actions by state (contract §C.4)', () => {
    const table = Object.fromEntries(
      ORDER_STATUSES.map((s) => [s, [canConfirm(s), canReject(s), canVoid(s), needsLateWarning(s)]])
    )
    expect(table).toEqual({
      pending: [true, true, false, false],
      paid: [false, false, true, false],
      rejected: [true, false, false, true],
      cancelled: [true, false, false, true],
      expired: [true, false, false, true],
      voided: [false, false, false, false],
    })
  })
})

describe('list query', () => {
  test('defaults: pending, 25 per page, from 0, no q', () => {
    expect(buildListParams({})).toEqual({ status: 'pending', limit: '25', offset: '0' })
    expect(ORDERS_PAGE_SIZE).toBe(25)
  })

  test('status, limit and offset are kept in range', () => {
    expect(buildListParams({ status: 'all', offset: 50 })).toEqual({ status: 'all', limit: '25', offset: '50' })
    expect(buildListParams({ status: 'DROP TABLE' }).status).toBe('pending')
    expect(buildListParams({ limit: 0 }).limit).toBe('25')
    expect(buildListParams({ limit: 500 }).limit).toBe('100')
    expect(buildListParams({ limit: 10 }).limit).toBe('10')
    expect(buildListParams({ offset: -5 }).offset).toBe('0')
    expect(buildListParams({ offset: Number.NaN }).offset).toBe('0')
  })

  test('q: trimmed, without NUL, at most 100 characters, left out when empty', () => {
    expect(buildListParams({ q: '  SYC-7K4P9Q  ' }).q).toBe('SYC-7K4P9Q')
    expect(buildListParams({ q: `ana${String.fromCharCode(0)}@example.com` }).q).toBe('ana@example.com')
    expect(buildListParams({ q: 'x'.repeat(150) }).q).toHaveLength(100)
    expect('q' in buildListParams({ q: '   ' })).toBe(false)
    expect(cleanSearch('  hola  ')).toBe('hola')
  })

  test('pager numbers', () => {
    expect(pageRange(0, 25, 60)).toEqual({ from: 1, to: 25, total: 60 })
    expect(pageRange(50, 10, 60)).toEqual({ from: 51, to: 60, total: 60 })
    expect(pageRange(0, 0, 0)).toEqual({ from: 0, to: 0, total: 0 })
  })

  test('order codes from ?code=', () => {
    expect(parsePurchaseCode(' syc-7k4p9q ')).toBe('SYC-7K4P9Q')
    expect(parsePurchaseCode('SYC-0O1IL2')).toBeNull()
    expect(parsePurchaseCode('SYC-7K4P9')).toBeNull()
    expect(parsePurchaseCode(null)).toBeNull()
  })

  test('buyer name and product summary', () => {
    expect(customerName({ first_name: 'Ana', last_name: 'Pérez (borrar)', username: 'ana' })).toBe('Ana Pérez (borrar)')
    expect(customerName({ first_name: '', last_name: null, username: 'ana', email: 'ana@example.com' })).toBe('ana')
    expect(customerName({ email: 'ana@example.com' })).toBe('ana@example.com')
    expect(customerName(null)).toBe('')
    const items = ['Límites con amor', 'Rabietas', 'Sueño', 'Pantallas'].map((name) => ({ name }))
    expect(productSummary(items)).toEqual({ names: ['Límites con amor', 'Rabietas'], more: 2 })
    expect(productSummary(items.slice(0, 1))).toEqual({ names: ['Límites con amor'], more: 0 })
    expect(productSummary(undefined)).toEqual({ names: [], more: 0 })
  })
})

describe('API errors', () => {
  test('structured detail, also as a JSON string', () => {
    const used = { detail: { code: 'REFERENCE_USED', message: 'Esa referencia ya se usó en otro pedido pagado.', purchases: ['SYC-AAAAAA', 7] } }
    expect(errorDetail(used)?.code).toBe('REFERENCE_USED')
    expect(errorList(used, 'purchases')).toEqual(['SYC-AAAAAA'])
    expect(errorList({ detail: JSON.stringify({ code: 'INCOMPLETE', missing: ['phone', 'whatsapp'] }) }, 'missing')).toEqual(['phone', 'whatsapp'])
    expect(errorList({ detail: 'Not Found' }, 'missing')).toEqual([])
    expect(errorDetail(null)).toBeNull()
  })
})

describe('Pago Móvil settings form', () => {
  test('banks of the contract: 26, unique 4-digit codes', () => {
    expect(VE_BANKS).toHaveLength(26)
    expect(new Set(VE_BANKS.map((b) => b.code)).size).toBe(26)
    expect(VE_BANKS.every((b) => /^\d{4}$/.test(b.code) && b.name.length >= 2)).toBe(true)
    expect(bankByCode('0134')).toEqual({ code: '0134', name: 'Banesco' })
    expect(bankByCode('0191')?.name).toBe('BNC Banco Nacional de Crédito')
    expect(bankByCode('9999')).toBeNull()
    expect(bankChoiceFor('0134', 'Banesco')).toBe('0134')
    expect(bankChoiceFor('0999', 'Mi banco')).toBe(OTHER_BANK)
    expect(bankChoiceFor('', '')).toBe('')
  })

  test('manual rate: the cases of the shared rule (same as the API)', () => {
    const ok = (text) => parseManualRate(text)
    expect(ok('887,30')).toEqual({ ok: true, value: 887.3 })
    expect(ok('887.30')).toEqual({ ok: true, value: 887.3 })
    expect(ok('1.050,5')).toEqual({ ok: true, value: 1050.5 })
    expect(ok('1,050.5')).toEqual({ ok: true, value: 1050.5 })
    expect(ok('1.050')).toEqual({ ok: false, code: 'ambiguous' })
    expect(ok('887,302')).toEqual({ ok: false, code: 'ambiguous' })
    expect(ok('1.050.000')).toEqual({ ok: true, value: 1050000 })
    expect(ok('abc')).toEqual({ ok: false, code: 'invalid' })
    expect(ok('0')).toEqual({ ok: false, code: 'range' })
  })

  test('manual rate: spaces, decimals, grouping and limits', () => {
    const value = (text) => {
      const parsed = parseManualRate(text)
      return parsed.ok ? parsed.value : parsed.code
    }
    // Spaces and no-break spaces are ignored; anything but digits . , is not.
    expect(value(' 887,30 ')).toBe(887.3)
    expect(value('1 050,50')).toBe(1050.5)
    expect(value(`1${String.fromCharCode(160)}050,50`)).toBe(1050.5)
    expect(value('887,\t30')).toBe('invalid')
    expect(value('887,30 Bs')).toBe('invalid')
    expect(value('-887,30')).toBe('invalid')
    expect(value('')).toBe('empty')
    expect(value('   ')).toBe('empty')
    // One mark once: the decimal mark unless exactly 3 digits follow.
    expect(value('887,3')).toBe(887.3)
    expect(value('887,3025')).toBe(887.3025)
    expect(value('887,30251')).toBe('decimals')
    expect(value('887')).toBe(887)
    expect(value('887,')).toBe('invalid')
    expect(value(',30')).toBe('invalid')
    // Both marks: the last one is the decimal mark, the other one is dropped
    // (like the API, no group-of-3 check here); a second decimal mark is invalid.
    expect(value('1.234.567,891')).toBe(1234567.891)
    expect(value('1,234,567.8912')).toBe(1234567.8912)
    expect(value('1.05,5')).toBe(105.5)
    expect(value('1.050,5,2')).toBe('invalid')
    expect(value('1.050,')).toBe('invalid')
    // One mark repeated: thousands only, groups of 3.
    expect(value('1,050,000')).toBe(1050000)
    expect(value('1.05.000')).toBe('invalid')
    expect(value('1000.000.000')).toBe('invalid')
    // More than 0 and up to 100 000 000.
    expect(value('100.000.000')).toBe(100000000)
    expect(value('100.000.001')).toBe('range')
    expect(value('0,00')).toBe('range')
  })

  test('manual rate: preview, input text and distance to the BCV rate', () => {
    expect(formatRatePreview(1050.5)).toBe('1.050,50')
    expect(formatRatePreview(887.3025)).toBe('887,3025')
    expect(formatRatePreview(1050000)).toBe('1.050.000,00')
    // A stored rate goes back into the field without being read as thousands.
    expect(rateInputValue(887.3)).toBe('887,30')
    expect(rateInputValue(1234.5678)).toBe('1234,5678')
    expect(rateInputValue(887.302)).toBe('887,3020')
    expect(parseManualRate(rateInputValue(887.302))).toEqual({ ok: true, value: 887.302 })
    expect(parseManualRate(rateInputValue(1050000))).toEqual({ ok: true, value: 1050000 })
    expect(rateInputValue(null)).toBe('')
    // More than 50 % away from the BCV rate.
    expect(rateFarFromBcv(887.3, 887.302)).toBe(false)
    expect(rateFarFromBcv(1300, 887.302)).toBe(false)
    expect(rateFarFromBcv(1340, 887.302)).toBe(true)
    expect(rateFarFromBcv(440, 887.302)).toBe(true)
    expect(rateFarFromBcv(887300, 887.302)).toBe(true)
    expect(rateFarFromBcv(887300, null)).toBe(false)
  })

  test('WhatsApp: digits like the API, 11 to 15 of them, with a preview', () => {
    expect(whatsappInfo('0424-882 4634')).toEqual({ digits: '584248824634', valid: true, missingCountry: false, preview: '+58 424 882 4634' })
    expect(whatsappInfo('+58 424 8824634').preview).toBe('+58 424 882 4634')
    expect(whatsappInfo('4248824634')).toEqual({ digits: '4248824634', valid: false, missingCountry: true, preview: null })
    expect(whatsappInfo('12345').valid).toBe(false)
    expect(whatsappInfo('1234567890123456').valid).toBe(false)
    expect(whatsappInfo('+1 305 555 1234').preview).toBe('+13055551234')
    expect(formatWhatsapp('584241234567')).toBe('+58 424 123 4567')
    expect(formatWhatsapp('')).toBe('')
  })

  test('refund of a product bought twice: its US$ and its share of the bolívares', () => {
    expect(proportionalVes(25, 34, 30168.27)).toBe(22182.55)
    expect(proportionalVes(9, 34, 30168.27)).toBe(7985.72)
    expect(proportionalVes(25, 25, 22182.55)).toBe(22182.55)
    // Without totals, the order's rate.
    expect(proportionalVes(10, 0, 0, 887.302)).toBe(8873.02)
    expect(proportionalVes(null, 34, 30168.27)).toBeNull()
  })

  test('time to pay: whole hours from 1 to 168', () => {
    expect(parseWindowHours('24')).toBe(24)
    expect(parseWindowHours('1')).toBe(1)
    expect(parseWindowHours('168')).toBe(168)
    for (const bad of ['0', '169', '2.5', '-3', '', 'abc']) expect(parseWindowHours(bad)).toBeNull()
  })

  const settings = {
    enabled: false,
    active: false,
    missing: ['bank_name', 'bank_code', 'phone', 'id_document', 'whatsapp'],
    settings: {
      bank_name: '', bank_code: '', phone: '', id_document: '', holder_name: '',
      whatsapp: '', instructions: '', payment_window_hours: 24,
      fx_mode: 'auto', fx_manual_rate: null, notify_email: '',
    },
    fx: { rate: 887.302, rate_date: '2026-10-27', source: 'bcv', fetched_at: '2026-10-27T13:05:00+00:00', stale: false, error: null },
  }

  test('draft from the API defaults and its payload', () => {
    const draft = draftFromManualSettings(settings)
    expect(draft.payment_window_hours).toBe('24')
    expect(draft.fx_mode).toBe('auto')
    expect(draft.fx_manual_rate).toBe('')
    expect(validateManualDraft(draft)).toEqual([])
    const payload = manualSettingsPayload({ ...draft, phone: ' 0424-1234567 ', fx_mode: 'manual', fx_manual_rate: ' 1.050,50 ' })
    expect(payload).toEqual({
      bank_name: '', bank_code: '', phone: '0424-1234567', id_document: '', holder_name: '',
      whatsapp: '', instructions: '', payment_window_hours: 24, fx_mode: 'manual',
      fx_manual_rate: '1.050,50', notify_email: '',
    })
    expect('enabled' in payload).toBe(false)
    // The manual rate only travels with the manual mode.
    const auto = manualSettingsPayload({ ...draft, fx_mode: 'auto', fx_manual_rate: '887,30' })
    expect(auto.fx_mode).toBe('auto')
    expect('fx_manual_rate' in auto).toBe(false)
    expect(isManualDraftDirty(draft, draftFromManualSettings(settings))).toBe(false)
    expect(isManualDraftDirty({ ...draft, whatsapp: '584248824634' }, draft)).toBe(true)
  })

  test('what the form checks by itself', () => {
    const draft = draftFromManualSettings(settings)
    const codes = (d) => validateManualDraft(d).map((e) => `${e.field}:${e.code}`)
    expect(codes({ ...draft, payment_window_hours: '0' })).toEqual(['payment_window_hours:window'])
    expect(codes({ ...draft, fx_mode: 'manual', fx_manual_rate: '' })).toEqual(['fx_manual_rate:rate'])
    expect(codes({ ...draft, fx_mode: 'manual', fx_manual_rate: '0' })).toEqual(['fx_manual_rate:rate'])
    expect(codes({ ...draft, fx_mode: 'manual', fx_manual_rate: '887,30' })).toEqual([])
    expect(codes({ ...draft, fx_mode: 'manual', fx_manual_rate: '1.050' })).toEqual(['fx_manual_rate:rate_ambiguous'])
    expect(codes({ ...draft, fx_mode: 'auto', fx_manual_rate: '1.050' })).toEqual([])
    const far = (d) => validateManualDraft(d, { bcvRate: 887.302 }).map((e) => `${e.field}:${e.code}`)
    expect(far({ ...draft, fx_mode: 'manual', fx_manual_rate: '887.302,00' })).toEqual(['fx_manual_rate:rate_far'])
    expect(far({ ...draft, fx_mode: 'manual', fx_manual_rate: '900,00' })).toEqual([])
    expect(codes({ ...draft, whatsapp: '424 882 4634' })).toEqual(['whatsapp:whatsapp_country'])
    expect(codes({ ...draft, whatsapp: '12345' })).toEqual(['whatsapp:whatsapp'])
    expect(codes({ ...draft, whatsapp: '0424 882 4634' })).toEqual([])
    expect(codes({ ...draft, instructions: 'x'.repeat(501) })).toEqual(['instructions:too_long'])
    expect(codes({ ...draft, holder_name: 'x'.repeat(81) })).toEqual(['holder_name:too_long'])
    expect(codes({ ...draft, bank_name: 'B' })).toEqual(['bank_name:bank_name'])
  })

  test('limits and fields match the contract', () => {
    expect(ORDER_LIMITS).toMatchObject({
      reference_min: 4, reference_max: 30, reason_min: 3, reason_max: 300, note: 500,
      search: 100, instructions: 500, window_min: 1, window_max: 168,
    })
    expect([...MANUAL_REQUIRED_FIELDS]).toEqual(['bank_name', 'bank_code', 'phone', 'id_document', 'whatsapp'])
  })
})

describe('sc_orders strings', () => {
  const webRoot = path.resolve(import.meta.dirname, '..')
  const read = (p) => fs.readFileSync(path.join(webRoot, p), 'utf8')
  const readJson = (p) => JSON.parse(read(p))
  const flatten = (obj, prefix = '') =>
    Object.entries(obj).flatMap(([k, v]) =>
      v && typeof v === 'object' && !Array.isArray(v) ? flatten(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]
    )
  const es = Object.fromEntries(flatten(readJson('locales-sc/orders.es.json')))
  const en = Object.fromEntries(flatten(readJson('locales-sc/orders.en.json')))

  test('es and en bundles have the same keys and placeholders, and match the merged locales', () => {
    const problems = []
    const tokens = (s) => (s.match(/\{\{[^}]+\}\}/g) || []).sort().join(',')
    const bold = (s) => (s.match(/\*\*/g) || []).length
    for (const key of new Set([...Object.keys(es), ...Object.keys(en)])) {
      if (typeof es[key] !== 'string' || typeof en[key] !== 'string') problems.push(`missing ${key}`)
      else if (tokens(es[key]) !== tokens(en[key])) problems.push(`placeholders differ in ${key}`)
      else if (bold(es[key]) !== bold(en[key])) problems.push(`bold marks differ in ${key}`)
      else if (!es[key].trim() || !en[key].trim()) problems.push(`empty ${key}`)
    }
    for (const [lng, bundle] of [['es', es], ['en', en], ['ar', en]]) {
      const merged = Object.fromEntries(flatten(readJson(`locales/${lng}.json`)))
      for (const [key, value] of Object.entries(bundle)) {
        if (merged[key] !== value) problems.push(`locales/${lng}.json ${key} out of date (run tools/i18n/apply.cjs)`)
      }
    }
    expect(problems).toEqual([])
  })

  test('menu label and command-palette entry', () => {
    expect(es['sc_orders.menu_label']).toBe('Pedidos')
    expect(en['sc_orders.menu_label']).toBe('Orders')
    for (const key of ['title', 'description', 'keywords']) expect(typeof es[`sc_orders.search.${key}`]).toBe('string')
  })

  test('every value has its label (keys built at run time by ordersLabel)', () => {
    const groups = [
      ['states', ORDER_STATUSES],
      ['changed', ORDER_STATUSES],
      ['tabs', ORDER_TABS],
      ['empty', ORDER_TABS],
      ['late_warning', ['expired', 'rejected', 'cancelled']],
      ['expires', ['minutes', 'hours', 'days', 'expired']],
      ['fields', MANUAL_FIELDS],
    ]
    const missing = []
    for (const [group, values] of groups) {
      for (const value of values) {
        for (const [lng, bundle] of [['es', es], ['en', en]]) {
          if (typeof bundle[`sc_orders.${group}.${value}`] !== 'string') missing.push(`${lng}: sc_orders.${group}.${value}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  test("every ot('…') key used by the panel exists", () => {
    const files = [
      ...fs.readdirSync(path.join(webRoot, 'components/Dashboard/Pages/Orders'))
        .filter((f) => f.endsWith('.tsx'))
        .map((f) => `components/Dashboard/Pages/Orders/${f}`),
      'components/Dashboard/Pages/Payments/PagoMovilCard.tsx',
      'components/Dashboard/Pages/Payments/PaymentsCustomersPage.tsx',
    ]
    const missing = []
    let checked = 0
    for (const file of files) {
      for (const [, key] of read(file).matchAll(/\bot\(\s*'([^']+)'/g)) {
        checked++
        for (const [lng, bundle] of [['es', es], ['en', en]]) {
          // Plural keys resolve through _one / _other.
          const found = [key, `${key}_other`].some((k) => typeof bundle[`sc_orders.${k}`] === 'string')
          if (!found) missing.push(`${lng}: sc_orders.${key} (${file})`)
        }
      }
    }
    expect(checked).toBeGreaterThan(100)
    expect(missing).toEqual([])
  })

  test('plural forms: 1 hora, 24 horas', () => {
    expect(es['sc_orders.pago_movil.summary_window_one']).toBe('{{count}} hora')
    expect(es['sc_orders.pago_movil.summary_window_other']).toBe('{{count}} horas')
    expect(en['sc_orders.pago_movil.summary_window_one']).toBe('{{count}} hour')
    expect(es['sc_orders.pago_movil.window_unit_one']).toBe('hora')
    expect(en['sc_orders.pago_movil.window_unit_other']).toBe('hours')
    // Never a bare "horas" key that would read "1 horas".
    expect(es['sc_orders.pago_movil.summary_window']).toBeUndefined()
    expect(es['sc_orders.pago_movil.window_unit']).toBeUndefined()
  })

  test('no value-like placeholders in the forms: the examples live in the hints', () => {
    const files = [
      'components/Dashboard/Pages/Orders/OrderActions.tsx',
      'components/Dashboard/Pages/Payments/PagoMovilCard.tsx',
    ]
    for (const file of files) expect({ file, placeholder: /\bplaceholder=/.test(read(file)) }).toEqual({ file, placeholder: false })
  })

  test('the contract texts are kept word for word', () => {
    expect(es['sc_orders.disabled_notice']).toBe('Pago Móvil está desactivado: quien compra no puede elegirlo.')
    expect(es['sc_orders.empty.pending']).toBe('No hay pedidos por confirmar.')
    expect(es['sc_orders.confirm_form.check_bank']).toBe('Antes de confirmar, revisa en tu banco que recibiste **Bs. {{amount}}**.')
    expect(es['sc_orders.confirm_form.success']).toBe('Pago confirmado. {{name}} ya tiene acceso.')
    expect(es['sc_orders.confirm_form.force']).toBe('Confirmar de todos modos')
    expect(es['sc_orders.late_warning.expired']).toBe('Este pedido está vencido. Confírmalo solo si el dinero llegó.')
    expect(es['sc_orders.void_form.warning']).toBe('Quita el acceso a todo lo de este pedido.')
    expect(es['sc_orders.reject_form.notify_label']).toBe('Avisar por correo')
    expect(es['sc_orders.pago_movil.toggle_label']).toBe('Aceptar Pago Móvil')
    expect(es['sc_orders.pago_movil.saved']).toBe('Pago Móvil guardado.')
    expect(es['sc_orders.pago_movil.help']).toBe(
      'Quien compra verá estos datos, el monto en bolívares y un botón para enviarte el comprobante por WhatsApp. Tú confirmas cada pago en Pedidos.'
    )
    expect(es['sc_orders.pago_movil.fx_today_bcv']).toBe('Tasa de hoy: {{rate}} Bs. por US$ (BCV, {{date}})')
    expect(es['sc_orders.pago_movil.fx_stale']).toBe('(última disponible)')
    // Corrections round after the review.
    expect(es['sc_orders.pago_movil.rate_ambiguous']).toBe(
      'Escribe la tasa con 2 decimales (por ejemplo 887,30) para que no se confunda con miles.'
    )
    expect(es['sc_orders.pago_movil.rate_preview']).toBe('Se guardará como {{rate}} Bs. por US$')
    expect(es['sc_orders.pago_movil.whatsapp_country']).toBe('Falta el código de país (58 para Venezuela)')
    expect(es['sc_orders.changed.paid']).toBe('Este pedido cambió: ahora está pagado.')
    expect(es['sc_orders.detail.already_confirmed']).toBe('Este pedido ya estaba confirmado con la referencia {{reference}}.')
    expect(es['sc_orders.fulfillment.warning']).toBe('El pago está confirmado pero falta dar acceso a algún producto.')
    expect(es['sc_orders.fulfillment.retry']).toBe('Reintentar dar acceso')
    expect(es['sc_orders.detail.duplicate']).toBe('Esta persona ya tenía este producto (pedido {{code}}): devuélvele {{amount}}.')
  })
})

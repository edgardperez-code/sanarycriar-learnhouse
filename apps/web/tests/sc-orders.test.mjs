// Sanar y Criar: "Pedidos" dashboard helpers (bank reference, reasons, money
// in es-VE and in each method's currency, time left to pay, list query, the
// manual payment settings: shared ones, Pago Móvil, bank transfer, Zelle and
// Binance) and the sc_orders i18n bundle. All fixtures are synthetic.

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
  COMMON_FIELDS,
  PAGO_MOVIL_FIELDS,
  EXTRA_METHODS,
  METHOD_FIELDS,
  ACCOUNT_TYPES,
  USDT_NETWORKS,
  NETWORK_LABELS,
  MISSING_TOKENS,
  COMMON_MISSING,
  normalizeReference,
  isValidReference,
  referenceMaxLength,
  formatPayAmount,
  purchasePay,
  formatPurchasePay,
  usdLine,
  refundText,
  commonSettingsPayload,
  pagoMovilPayload,
  validateCommonDraft,
  validatePagoMovilDraft,
  isCommonDraftDirty,
  isPagoMovilDraftDirty,
  commonSettingsIncomplete,
  bankText,
  isExtraMethod,
  networkLabel,
  methodDraftFromState,
  methodHasData,
  normalizeAccountNumber,
  formatAccountNumber,
  accountInfo,
  formatZellePhone,
  addressMatchesNetwork,
  methodPayload,
  isMethodDraftDirty,
  validateMethodDraft,
  isCommonMissing,
  splitMissing,
  fieldsOfMissing,
  missingTokenFor,
  anyManualMethodReady,
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

  test('Binance takes up to 100 (a Binance Pay order id or a TxID); the other methods 30', () => {
    const txid = 'a1'.repeat(32) // 64 hex characters
    expect(referenceMaxLength('binance')).toBe(100)
    for (const method of ['pago_movil', 'transferencia', 'zelle', undefined, null, 'otro']) expect(referenceMaxLength(method)).toBe(30)
    expect(isValidReference(txid, 'binance')).toBe(true)
    expect(isValidReference(`0x${txid}`, 'binance')).toBe(true)
    expect(isValidReference('A'.repeat(100), 'binance')).toBe(true)
    expect(isValidReference('A'.repeat(101), 'binance')).toBe(false)
    expect(isValidReference('123', 'binance')).toBe(false)
    expect(isValidReference(txid, 'zelle')).toBe(false)
    expect(isValidReference(txid, 'transferencia')).toBe(false)
    expect(isValidReference('BAC0A1B2C3D', 'zelle')).toBe(true)
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

describe('what the buyer pays, in the method currency (manual methods §0, §A.6)', () => {
  const pagoMovil = { method: 'pago_movil', amount: 40, pay_currency: 'VES', pay_amount: 35492.08, amount_ves: 35492.08, fx_rate: 887.302 }
  const transferencia = { ...pagoMovil, method: 'transferencia' }
  const zelle = { method: 'zelle', amount: 40, pay_currency: 'USD', pay_amount: 40, amount_ves: null, fx_rate: null }
  const binance = { method: 'binance', amount: 40, pay_currency: 'USDT', pay_amount: 40, amount_ves: null, fx_rate: null }

  test('formats of the contract: Bs. 35.492,08, US$ 40,00, 40,00 USDT', () => {
    expect(formatPayAmount(35492.08, 'VES')).toBe('Bs. 35.492,08')
    expect(formatPayAmount(40, 'USD')).toBe('US$ 40,00')
    expect(formatPayAmount(40, 'USDT')).toBe('40,00 USDT')
    expect(formatPayAmount(1234.5, 'USDT')).toBe('1.234,50 USDT')
    expect(formatPayAmount(10, 'EUR')).toBe('10,00 EUR')
    expect(formatPayAmount(10, '')).toBe('10,00')
    expect(formatPayAmount(null, 'VES')).toBe('—')
    expect(formatPayAmount('abc', 'USD')).toBe('—')
  })

  test('the big amount of an order: pay_amount in pay_currency', () => {
    expect(formatPurchasePay(pagoMovil)).toBe('Bs. 35.492,08')
    expect(formatPurchasePay(transferencia)).toBe('Bs. 35.492,08')
    expect(formatPurchasePay(zelle)).toBe('US$ 40,00')
    expect(formatPurchasePay(binance)).toBe('40,00 USDT')
    // Without the new fields (an older API): a Pago Móvil order, in bolívares.
    expect(purchasePay({ amount: 40, amount_ves: 35492.08 })).toEqual({ currency: 'VES', amount: 35492.08 })
    expect(purchasePay({ pay_currency: 'USD', amount: 40 })).toEqual({ currency: 'USD', amount: 40 })
    expect(purchasePay(null)).toEqual({ currency: 'VES', amount: null })
  })

  test('the US$ line only when it adds something', () => {
    expect(usdLine(pagoMovil)).toBe('US$ 40,00')
    expect(usdLine(transferencia)).toBe('US$ 40,00')
    expect(usdLine(binance)).toBe('= US$ 40,00')
    expect(usdLine(zelle)).toBeNull()
  })

  test('refund of a product bought twice, in what was paid', () => {
    const order = { ...pagoMovil, amount: 34, amount_ves: 30168.27, pay_amount: 30168.27 }
    expect(refundText(25, order)).toBe('US$ 25,00 (Bs. 22.182,55)')
    expect(refundText(25, { ...order, amount_ves: null, amount: 0, fx_rate: null })).toBe('US$ 25,00')
    expect(refundText(25, zelle)).toBe('US$ 25,00')
    expect(refundText(25, binance)).toBe('25,00 USDT')
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
      reference_min: 4, reference_max: 30, reference_max_binance: 100, reason_min: 3, reason_max: 300, note: 500,
      search: 100, instructions: 500, window_min: 1, window_max: 168,
    })
    expect([...MANUAL_REQUIRED_FIELDS]).toEqual(['bank_name', 'bank_code', 'phone', 'id_document', 'whatsapp'])
  })
})

describe('the two cards of /manual/settings: shared settings and Pago Móvil (§A.1)', () => {
  const data = {
    enabled: true,
    active: true,
    missing: [],
    settings: {
      bank_name: 'Banesco', bank_code: '0134', phone: '0424-1234567', id_document: 'V-12345678', holder_name: 'Hilda',
      whatsapp: '584248824634', instructions: '', payment_window_hours: 24,
      fx_mode: 'auto', fx_manual_rate: 887.3, notify_email: 'hilda@example.com',
    },
    fx: null,
  }

  test('every /manual/settings field belongs to exactly one card', () => {
    expect([...COMMON_FIELDS, ...PAGO_MOVIL_FIELDS].sort()).toEqual([...MANUAL_FIELDS].sort())
    expect(COMMON_FIELDS.filter((f) => PAGO_MOVIL_FIELDS.includes(f))).toEqual([])
  })

  test('each card sends only its own fields (and never the switch)', () => {
    const draft = draftFromManualSettings(data)
    expect(commonSettingsPayload(draft)).toEqual({
      whatsapp: '584248824634', payment_window_hours: 24, fx_mode: 'auto', notify_email: 'hilda@example.com',
    })
    expect(commonSettingsPayload({ ...draft, fx_mode: 'manual', fx_manual_rate: ' 900,50 ' })).toMatchObject({
      fx_mode: 'manual', fx_manual_rate: '900,50',
    })
    expect(pagoMovilPayload({ ...draft, phone: ' 0414-7654321 ' })).toEqual({
      bank_name: 'Banesco', bank_code: '0134', phone: '0414-7654321', id_document: 'V-12345678', holder_name: 'Hilda', instructions: '',
    })
    expect('enabled' in pagoMovilPayload(draft)).toBe(false)
  })

  test('dirty and checks per card: a change in one card is not the other one’s', () => {
    const draft = draftFromManualSettings(data)
    const whatsappChanged = { ...draft, whatsapp: '584141234567' }
    expect(isCommonDraftDirty(whatsappChanged, draft)).toBe(true)
    expect(isPagoMovilDraftDirty(whatsappChanged, draft)).toBe(false)
    const phoneChanged = { ...draft, phone: '0414-7654321' }
    expect(isPagoMovilDraftDirty(phoneChanged, draft)).toBe(true)
    expect(isCommonDraftDirty(phoneChanged, draft)).toBe(false)
    const broken = { ...draft, whatsapp: '12345', payment_window_hours: '0', holder_name: 'x'.repeat(81), bank_name: 'B' }
    expect(validateCommonDraft(broken).map((e) => e.field).sort()).toEqual(['payment_window_hours', 'whatsapp'])
    expect(validatePagoMovilDraft(broken).map((e) => e.field).sort()).toEqual(['bank_name', 'holder_name'])
    expect(validateCommonDraft({ ...draft, fx_mode: 'manual', fx_manual_rate: '1.050' }).map((e) => e.code)).toEqual(['rate_ambiguous'])
    expect(validateCommonDraft({ ...draft, fx_mode: 'manual', fx_manual_rate: '887.302,00' }, { bcvRate: 887.302 }).map((e) => e.code)).toEqual(['rate_far'])
  })

  test('shared settings no method can do without', () => {
    expect(commonSettingsIncomplete(data.settings)).toBe(false)
    expect(commonSettingsIncomplete({ ...data.settings, whatsapp: '' })).toBe(true)
    expect(commonSettingsIncomplete({ ...data.settings, whatsapp: '  ' })).toBe(true)
    expect(commonSettingsIncomplete({ ...data.settings, fx_mode: 'manual', fx_manual_rate: null })).toBe(true)
    expect(commonSettingsIncomplete({ ...data.settings, fx_mode: 'manual' })).toBe(false)
    expect(commonSettingsIncomplete(null)).toBe(true)
  })

  test('bank text', () => {
    expect(bankText('Banesco', '0134')).toBe('Banesco (0134)')
    expect(bankText('Mi banco', '')).toBe('Mi banco')
    expect(bankText('', '0134')).toBe('(0134)')
    expect(bankText(undefined, null)).toBe('')
  })
})

describe('bank transfer, Zelle and Binance settings (§A.2, §A.3)', () => {
  const methods = {
    transferencia: {
      method: 'transferencia', enabled: false, active: false,
      missing: ['bank_name', 'account_number', 'account_type', 'holder_name', 'id_document', 'whatsapp'],
      settings: { bank_name: '', bank_code: '', account_number: '', account_type: '', holder_name: '', id_document: '', instructions: '' },
    },
    zelle: {
      method: 'zelle', enabled: true, active: true, missing: [],
      settings: { email: 'pagos@example.com', phone: '+1 305-555-1234', holder_name: 'Hilda Pérez', instructions: '' },
    },
    binance: {
      method: 'binance', enabled: false, active: false, missing: ['pay_id_or_address', 'whatsapp'],
      settings: { pay_id: '', usdt_address: '', usdt_network: '', instructions: '' },
    },
  }
  const codes = (method, draft) => validateMethodDraft(method, draft).map((e) => `${e.field}:${e.code}`)

  test('methods and fields of the contract, in display and form order', () => {
    expect([...EXTRA_METHODS]).toEqual(['transferencia', 'zelle', 'binance'])
    expect(METHOD_FIELDS).toEqual({
      transferencia: ['bank_name', 'bank_code', 'account_number', 'account_type', 'holder_name', 'id_document', 'instructions'],
      zelle: ['email', 'phone', 'holder_name', 'instructions'],
      binance: ['pay_id', 'usdt_address', 'usdt_network', 'instructions'],
    })
    expect(isExtraMethod('zelle')).toBe(true)
    expect(isExtraMethod('pago_movil')).toBe(false)
    expect([...ACCOUNT_TYPES]).toEqual(['corriente', 'ahorro'])
    expect([...USDT_NETWORKS]).toEqual(['TRC20', 'BEP20', 'ERC20', 'SOL', 'POLYGON', 'ARBITRUM'])
    expect(USDT_NETWORKS.map((n) => NETWORK_LABELS[n])).toEqual([
      'TRC20 (Tron)', 'BEP20 (BNB Smart Chain)', 'ERC20 (Ethereum)', 'Solana', 'Polygon', 'Arbitrum One',
    ])
    expect(networkLabel('SOL')).toBe('Solana')
    expect(networkLabel('XYZ')).toBe('XYZ')
    expect(networkLabel(null)).toBe('')
  })

  test('draft from the API, untouched cards, payload with only that method', () => {
    const zelle = methodDraftFromState('zelle', methods.zelle)
    expect(zelle).toMatchObject({ email: 'pagos@example.com', phone: '+1 305-555-1234', holder_name: 'Hilda Pérez', instructions: '' })
    // The other methods' fields stay empty and never travel.
    expect(zelle.account_number).toBe('')
    expect(methodPayload('zelle', { ...zelle, account_number: '123', email: ' pagos@example.com ' })).toEqual({
      email: 'pagos@example.com', phone: '+1 305-555-1234', holder_name: 'Hilda Pérez', instructions: '',
    })
    expect(methodHasData(methods.zelle)).toBe(true)
    expect(methodHasData(methods.transferencia)).toBe(false)
    expect(methodHasData({ settings: { instructions: '   ' } })).toBe(false)
    expect(methodHasData(null)).toBe(false)
    expect(methodDraftFromState('binance', null).pay_id).toBe('')
  })

  test('payload: the account, Pay ID and address as the API stores them', () => {
    const draft = {
      ...methodDraftFromState('transferencia', methods.transferencia),
      bank_name: ' Banesco ', bank_code: '0134', account_number: '0134-0000.00 0000000000', account_type: 'ahorro',
    }
    expect(methodPayload('transferencia', draft)).toEqual({
      bank_name: 'Banesco', bank_code: '0134', account_number: '01340000000000000000', account_type: 'ahorro',
      holder_name: '', id_document: '', instructions: '',
    })
    const binance = { ...methodDraftFromState('binance', methods.binance), pay_id: ' 123 456 789 ', usdt_address: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb ' }
    expect(methodPayload('binance', binance)).toMatchObject({ pay_id: '123456789', usdt_address: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb' })
    // Typing the same account with spaces is not a change.
    const saved = { ...draft, account_number: '01340000000000000000' }
    expect(isMethodDraftDirty('transferencia', draft, saved)).toBe(false)
    expect(isMethodDraftDirty('transferencia', { ...draft, account_type: 'corriente' }, saved)).toBe(true)
  })

  test('account number: 20 digits, grouped, and it starts with the bank code', () => {
    expect(normalizeAccountNumber(' 0134-0000.00 0000000001 ')).toBe('01340000000000000001')
    expect(formatAccountNumber('01340000000000000001')).toBe('0134 0000 00 0000000001')
    expect(formatAccountNumber('0134 0000 00 0000000001')).toBe('0134 0000 00 0000000001')
    expect(formatAccountNumber('12345')).toBe('12345')
    expect(formatAccountNumber(null)).toBe('')
    expect(accountInfo('0134 0000', '0134')).toEqual({ digits: '01340000', numeric: true, valid: false, grouped: null, bankMismatch: false })
    expect(accountInfo('01340000000000000001', '0134')).toMatchObject({ valid: true, grouped: '0134 0000 00 0000000001', bankMismatch: false })
    expect(accountInfo('01050000000000000001', '0134')).toMatchObject({ valid: true, bankMismatch: true })
    // Without a bank code the API takes it from the account.
    expect(accountInfo('01050000000000000001', '')).toMatchObject({ valid: true, bankMismatch: false })
    expect(accountInfo('0134abc', '0134').numeric).toBe(false)
  })

  test('Zelle phone: a US number, like the API stores it', () => {
    expect(formatZellePhone('+1 305 555 1234')).toBe('+1 305-555-1234')
    expect(formatZellePhone('(305) 555-1234')).toBe('+1 305-555-1234')
    expect(formatZellePhone('13055551234')).toBe('+1 305-555-1234')
    expect(formatZellePhone('305 555 123')).toBeNull()
    expect(formatZellePhone('105 555 1234')).toBeNull()
    expect(formatZellePhone('305 155 1234')).toBeNull()
    expect(formatZellePhone('0424 123 4567')).toBeNull()
    expect(formatZellePhone('')).toBeNull()
  })

  test('USDT address against its network', () => {
    const tron = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'
    const evm = `0x${'a1B2'.repeat(10)}`
    const sol = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV'
    expect(addressMatchesNetwork(tron, 'TRC20')).toBe(true)
    expect(addressMatchesNetwork(` ${tron} `, 'TRC20')).toBe(true)
    expect(addressMatchesNetwork(evm, 'TRC20')).toBe(false)
    expect(addressMatchesNetwork(tron.replace('9', '0'), 'TRC20')).toBe(false) // 0 is not base58
    for (const network of ['BEP20', 'ERC20', 'POLYGON', 'ARBITRUM']) {
      expect(addressMatchesNetwork(evm, network)).toBe(true)
      expect(addressMatchesNetwork(tron, network)).toBe(false)
      expect(addressMatchesNetwork(`${evm}0`, network)).toBe(false)
    }
    expect(addressMatchesNetwork(sol, 'SOL')).toBe(true)
    expect(addressMatchesNetwork(evm, 'SOL')).toBe(false)
    expect(addressMatchesNetwork('abc', '')).toBe(true)
  })

  test('what the bank transfer form checks by itself (the API rules)', () => {
    const empty = methodDraftFromState('transferencia', methods.transferencia)
    expect(codes('transferencia', empty)).toEqual([])
    const good = {
      ...empty, bank_name: 'Banesco', bank_code: '0134', account_number: '0134 0000 00 0000000001', account_type: 'corriente',
      holder_name: 'Hilda Pérez', id_document: 'v-12.345.678',
    }
    expect(codes('transferencia', good)).toEqual([])
    expect(codes('transferencia', { ...good, bank_name: 'B' })).toEqual(['bank_name:bank_name'])
    expect(codes('transferencia', { ...good, bank_code: '013' })).toEqual(['bank_code:bank_code'])
    expect(codes('transferencia', { ...good, account_number: '0134 0000' })).toEqual(['account_number:account_number'])
    expect(codes('transferencia', { ...good, account_number: '0134abc' })).toEqual(['account_number:account_number'])
    const mismatch = validateMethodDraft('transferencia', { ...good, account_number: '01050000000000000001' })
    expect(mismatch).toEqual([{ field: 'account_number', code: 'account_bank', bankCode: '0134' }])
    expect(codes('transferencia', { ...good, bank_code: '', account_number: '01050000000000000001' })).toEqual([])
    expect(codes('transferencia', { ...good, id_document: '12345678' })).toEqual(['id_document:id_document'])
    expect(codes('transferencia', { ...good, id_document: 'J-412345678' })).toEqual([])
    expect(codes('transferencia', { ...good, holder_name: 'x'.repeat(81) })).toEqual(['holder_name:too_long'])
    expect(validateMethodDraft('transferencia', { ...good, instructions: 'x'.repeat(501) })).toEqual([
      { field: 'instructions', code: 'too_long', max: 500 },
    ])
  })

  test('what the Zelle form checks by itself', () => {
    const zelle = methodDraftFromState('zelle', methods.zelle)
    expect(codes('zelle', zelle)).toEqual([])
    expect(codes('zelle', { ...zelle, email: 'pagos@example' })).toEqual(['email:email'])
    expect(codes('zelle', { ...zelle, email: 'Pagos@Example.com' })).toEqual([])
    expect(codes('zelle', { ...zelle, email: '' })).toEqual([])
    expect(codes('zelle', { ...zelle, phone: '0424-1234567' })).toEqual(['phone:zelle_phone'])
    expect(codes('zelle', { ...zelle, holder_name: 'x'.repeat(81) })).toEqual(['holder_name:too_long'])
  })

  test('what the Binance form checks by itself', () => {
    const empty = methodDraftFromState('binance', methods.binance)
    const tron = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'
    expect(codes('binance', empty)).toEqual([])
    expect(codes('binance', { ...empty, pay_id: '123 456 789' })).toEqual([])
    expect(codes('binance', { ...empty, pay_id: '1234' })).toEqual(['pay_id:pay_id'])
    // Binance Pay also sends to the account's email (2026-11).
    expect(codes('binance', { ...empty, pay_id: 'Pagos@Ejemplo.com' })).toEqual([])
    expect(codes('binance', { ...empty, pay_id: 'pagos@ejemplo' })).toEqual(['pay_id:pay_id'])
    expect(codes('binance', { ...empty, pay_id: '12345a' })).toEqual(['pay_id:pay_id'])
    expect(codes('binance', { ...empty, usdt_address: tron, usdt_network: 'TRC20' })).toEqual([])
    // An address needs its network.
    expect(codes('binance', { ...empty, usdt_address: tron })).toEqual(['usdt_network:network_required'])
    expect(validateMethodDraft('binance', { ...empty, usdt_address: tron, usdt_network: 'BEP20' })).toEqual([
      { field: 'usdt_address', code: 'address_network', network: 'BEP20' },
    ])
    expect(codes('binance', { ...empty, usdt_address: 'T9y-D14', usdt_network: 'TRC20' })).toEqual(['usdt_address:usdt_address'])
    expect(codes('binance', { ...empty, usdt_address: 'A'.repeat(101), usdt_network: 'TRC20' })).toEqual(['usdt_address:usdt_address'])
  })

  test('the cart offers some manual method (the "none on" notice in Pedidos)', () => {
    const off = { enabled: false, active: true }
    expect(anyManualMethodReady(off, methods)).toBe(true) // Zelle is on and complete
    expect(anyManualMethodReady({ enabled: true, active: true }, {})).toBe(true)
    expect(anyManualMethodReady(off, { ...methods, zelle: { ...methods.zelle, enabled: false } })).toBe(false)
    expect(anyManualMethodReady(off, { zelle: { ...methods.zelle, active: false } })).toBe(false)
    expect(anyManualMethodReady({ enabled: true, active: false }, undefined)).toBe(false)
    expect(anyManualMethodReady(null, null)).toBe(false)
  })
})

describe('missing data ("Falta: …")', () => {
  test('the tokens of the contract; the shared ones are set in the common card', () => {
    expect([...COMMON_MISSING]).toEqual(['whatsapp', 'fx_manual_rate'])
    expect(MISSING_TOKENS.filter(isCommonMissing)).toEqual(['whatsapp', 'fx_manual_rate'])
    expect(splitMissing(['bank_name', 'whatsapp', 'account_type', 'fx_manual_rate'])).toEqual({
      own: ['bank_name', 'account_type'], common: ['whatsapp', 'fx_manual_rate'],
    })
    expect(splitMissing(null)).toEqual({ own: [], common: [] })
  })

  test('which fields a token marks', () => {
    expect(fieldsOfMissing('email_or_phone')).toEqual(['email', 'phone'])
    expect(fieldsOfMissing('pay_id_or_address')).toEqual(['pay_id', 'usdt_address'])
    expect(fieldsOfMissing('usdt_network')).toEqual(['usdt_network'])
    expect(fieldsOfMissing('whatsapp')).toEqual([])
    expect(missingTokenFor('phone', ['email_or_phone', 'holder_name', 'whatsapp'])).toBe('email_or_phone')
    expect(missingTokenFor('holder_name', ['email_or_phone', 'holder_name'])).toBe('holder_name')
    expect(missingTokenFor('instructions', ['email_or_phone'])).toBeNull()
    expect(missingTokenFor('whatsapp', ['whatsapp'])).toBeNull()
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
      ['missing', MISSING_TOKENS],
      ['account_types', ACCOUNT_TYPES],
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
      // Every card of "Pagos manuales" and the pages that read sc_orders.
      ...fs.readdirSync(path.join(webRoot, 'components/Dashboard/Pages/Payments'))
        .filter((f) => f.endsWith('.tsx') && /useOrdersT|OrdersTranslate/.test(read(`components/Dashboard/Pages/Payments/${f}`)))
        .map((f) => `components/Dashboard/Pages/Payments/${f}`),
    ]
    for (const file of [
      'components/Dashboard/Pages/Payments/ManualSettingsCard.tsx',
      'components/Dashboard/Pages/Payments/PagoMovilCard.tsx',
      'components/Dashboard/Pages/Payments/ManualMethodCard.tsx',
      'components/Dashboard/Pages/Payments/ManualCardParts.tsx',
      'components/Dashboard/Pages/Payments/PaymentsConfigurationPage.tsx',
      'components/Dashboard/Pages/Payments/PaymentsCustomersPage.tsx',
    ]) {
      expect(files).toContain(file)
    }
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
    expect(es['sc_orders.manual_settings.summary_window_one']).toBe('{{count}} hora')
    expect(es['sc_orders.manual_settings.summary_window_other']).toBe('{{count}} horas')
    expect(en['sc_orders.manual_settings.summary_window_one']).toBe('{{count}} hour')
    expect(es['sc_orders.manual_settings.window_unit_one']).toBe('hora')
    expect(en['sc_orders.manual_settings.window_unit_other']).toBe('hours')
    // Never a bare "horas" key that would read "1 horas".
    expect(es['sc_orders.manual_settings.summary_window']).toBeUndefined()
    expect(es['sc_orders.manual_settings.window_unit']).toBeUndefined()
  })

  test('no value-like placeholders in the forms: the examples live in the hints', () => {
    const files = [
      'components/Dashboard/Pages/Orders/OrderActions.tsx',
      'components/Dashboard/Pages/Payments/ManualCardParts.tsx',
      'components/Dashboard/Pages/Payments/ManualSettingsCard.tsx',
      'components/Dashboard/Pages/Payments/PagoMovilCard.tsx',
      'components/Dashboard/Pages/Payments/ManualMethodCard.tsx',
    ]
    for (const file of files) expect({ file, placeholder: /\bplaceholder=/.test(read(file)) }).toEqual({ file, placeholder: false })
  })

  test('copy rules: no em dashes, and the method names are the shared ones', () => {
    const dashes = Object.entries({ ...es, ...Object.fromEntries(Object.entries(en).map(([k, v]) => [`en:${k}`, v])) })
      .filter(([, value]) => typeof value === 'string' && value.includes('—'))
      .map(([key]) => key)
    expect(dashes).toEqual([])
    // Card titles come from sc_commerce.methods (methodLabel), not from here.
    for (const method of ['pago_movil', 'transferencia', 'zelle', 'binance']) {
      expect(es[`sc_orders.${method}.title`]).toBeUndefined()
    }
  })

  test('the contract texts are kept word for word', () => {
    // Shown only when no manual method at all is on (manual methods contract).
    expect(es['sc_orders.disabled_notice']).toBe(
      'No tienes ningún pago manual activo: quien compra no puede pagar por Pago Móvil, transferencia, Zelle ni Binance.'
    )
    expect(es['sc_orders.empty.pending']).toBe('No hay pedidos por confirmar.')
    expect(es['sc_orders.confirm_form.check_bank']).toBe('Antes de confirmar, revisa en tu banco que recibiste **Bs. {{amount}}**.')
    expect(es['sc_orders.confirm_form.check_zelle']).toBe('Antes de confirmar, revisa en tu Zelle que recibiste **US$ {{amount}}**.')
    expect(es['sc_orders.confirm_form.check_binance']).toBe('Antes de confirmar, revisa en Binance que recibiste **{{amount}} USDT**.')
    expect(es['sc_orders.confirm_form.reference_label_zelle']).toBe('Número de confirmación de Zelle')
    expect(es['sc_orders.confirm_form.reference_label_binance']).toBe('ID de la orden de Binance Pay o TxID')
    expect(es['sc_orders.confirm_form.success']).toBe('Pago confirmado. {{name}} ya tiene acceso.')
    expect(es['sc_orders.confirm_form.force']).toBe('Confirmar de todos modos')
    expect(es['sc_orders.late_warning.expired']).toBe('Este pedido está vencido. Confírmalo solo si el dinero llegó.')
    expect(es['sc_orders.void_form.warning']).toBe('Quita el acceso a todo lo de este pedido.')
    expect(es['sc_orders.reject_form.notify_label']).toBe('Avisar por correo')
    expect(es['sc_orders.pago_movil.toggle_label']).toBe('Aceptar Pago Móvil')
    expect(es['sc_orders.pago_movil.saved']).toBe('Pago Móvil guardado.')
    expect(es['sc_orders.manual_settings.title']).toBe('Ajustes de los pagos manuales')
    expect(es['sc_orders.manual_card.missing_common']).toBe('{{fields}} (en Ajustes de los pagos manuales)')
    expect(es['sc_orders.manual_settings.fx_today_bcv']).toBe('Tasa de hoy: {{rate}} Bs. por US$ (BCV, {{date}})')
    expect(es['sc_orders.manual_settings.fx_stale']).toBe('(última disponible)')
    // Corrections round after the review.
    expect(es['sc_orders.manual_settings.rate_ambiguous']).toBe(
      'Escribe la tasa con 2 decimales (por ejemplo 887,30) para que no se confunda con miles.'
    )
    expect(es['sc_orders.manual_settings.rate_preview']).toBe('Se guardará como {{rate}} Bs. por US$')
    expect(es['sc_orders.manual_settings.whatsapp_country']).toBe('Falta el código de país (58 para Venezuela)')
    expect(es['sc_orders.changed.paid']).toBe('Este pedido cambió: ahora está pagado.')
    expect(es['sc_orders.detail.already_confirmed']).toBe('Este pedido ya estaba confirmado con la referencia {{reference}}.')
    expect(es['sc_orders.fulfillment.warning']).toBe('El pago está confirmado pero falta dar acceso a algún producto.')
    expect(es['sc_orders.fulfillment.retry']).toBe('Reintentar dar acceso')
    expect(es['sc_orders.detail.duplicate']).toBe('Esta persona ya tenía este producto (pedido {{code}}): devuélvele {{amount}}.')
  })
})

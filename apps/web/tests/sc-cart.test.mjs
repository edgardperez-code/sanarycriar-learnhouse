// Sanar y Criar: the cart kept in the browser (lib/sc-cart.ts), the money and
// date formatting of the cart and order pages, and the sc_cart strings.
// Contract: carrito-contrato.md §D.1, §D.8. All fixtures are synthetic.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const {
  CART_MAX_ITEMS,
  CART_EVENT,
  PURCHASE_STATUSES,
  cartStorageKey,
  isValidOfferUuid,
  readCart,
  addToCart,
  removeFromCart,
  removeManyFromCart,
  clearCart,
  cartCount,
  subscribeCart,
  formatAmount,
  formatUsd,
  formatBs,
  formatRate,
  amountForCopy,
  digitsOnly,
  formatWhatsappNumber,
  whatsappChatUrl,
  safeWhatsappUrl,
  formatCaracasDate,
  formatCaracasDateTime,
  formatIsoDate,
  purchaseStatus,
  sortPurchasesPendingFirst,
  isPlausiblePurchaseUuid,
} = await import('../lib/sc-cart.ts')
const { apiMessage, errorList, CartApiError } = await import('../components/Store/Cart/types.ts')

class FakeStorage {
  constructor() {
    this.map = new Map()
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null
  }
  setItem(key, value) {
    this.map.set(key, String(value))
  }
  removeItem(key) {
    this.map.delete(key)
  }
}

// Private mode / blocked site data: every call throws.
class BrokenStorage {
  getItem() {
    throw new Error('SecurityError')
  }
  setItem() {
    throw new Error('QuotaExceededError')
  }
  removeItem() {
    throw new Error('SecurityError')
  }
}

const setGlobal = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })

const uuid = (n) => `0f1e2d3c-4b5a-4c6d-8e7f-${String(n).padStart(12, '0')}`
// The memory fallback lives for the whole module, so every test uses its own org.
let nextOrg = 100
const freshOrg = () => nextOrg++

let storage
beforeEach(() => {
  storage = new FakeStorage()
  setGlobal('localStorage', storage)
})
afterEach(() => {
  delete globalThis.localStorage
  delete globalThis.window
})

describe('cart in localStorage', () => {
  test('add, duplicate, remove, clear; stored as {"v":1,"items":[…]} under its key', () => {
    const org = freshOrg()
    expect(addToCart(org, uuid(1), 1730000000000)).toBe('added')
    expect(addToCart(org, uuid(1))).toBe('exists')
    // Same uuid in capitals is the same product.
    expect(addToCart(org, uuid(1).toUpperCase())).toBe('exists')
    expect(addToCart(org, uuid(2), 1730000000001)).toBe('added')

    expect(cartStorageKey(org)).toBe(`sanarycriar:carrito:v1:${org}`)
    expect(JSON.parse(storage.getItem(`sanarycriar:carrito:v1:${org}`))).toEqual({
      v: 1,
      items: [
        { offer_uuid: uuid(1), added_at: 1730000000000 },
        { offer_uuid: uuid(2), added_at: 1730000000001 },
      ],
    })
    expect(cartCount(org)).toBe(2)

    expect(removeFromCart(org, uuid(1))).toBe(true)
    expect(removeFromCart(org, uuid(1))).toBe(false)
    expect(readCart(org).items.map((i) => i.offer_uuid)).toEqual([uuid(2)])

    clearCart(org)
    expect(readCart(org)).toEqual({ v: 1, items: [] })
    expect(cartCount(org)).toBe(0)
  })

  test('removeManyFromCart drops several at once and keeps the order of the rest', () => {
    const org = freshOrg()
    for (const n of [1, 2, 3, 4]) addToCart(org, uuid(n))
    expect(removeManyFromCart(org, [uuid(1), uuid(3), uuid(9)])).toBe(2)
    expect(readCart(org).items.map((i) => i.offer_uuid)).toEqual([uuid(2), uuid(4)])
    expect(removeManyFromCart(org, [])).toBe(0)
  })

  test('full at 20 products (CART_MAX_ITEMS)', () => {
    const org = freshOrg()
    expect(CART_MAX_ITEMS).toBe(20)
    for (let n = 1; n <= 20; n++) expect(addToCart(org, uuid(n))).toBe('added')
    expect(addToCart(org, uuid(21))).toBe('full')
    // An existing product is still "exists", not "full".
    expect(addToCart(org, uuid(5))).toBe('exists')
    expect(cartCount(org)).toBe(20)
    removeFromCart(org, uuid(1))
    expect(addToCart(org, uuid(21))).toBe('added')
  })

  test('invalid uuids and orgs are refused without touching the cart', () => {
    const org = freshOrg()
    for (const bad of ['', 'abc', 'not a uuid!', '<script>', '../../x', 'g'.repeat(10), 'a'.repeat(65), null, undefined, 42]) {
      expect(addToCart(org, bad)).toBe('invalid')
    }
    expect(addToCart(null, uuid(1))).toBe('invalid')
    expect(addToCart(undefined, uuid(1))).toBe('invalid')
    expect(cartCount(org)).toBe(0)
    expect(isValidOfferUuid(uuid(1))).toBe(true)
    expect(isValidOfferUuid('0F1E2D3C-4B5A-4C6D-8E7F-000000000001')).toBe(true)
    expect(isValidOfferUuid('abc')).toBe(false)
  })

  test('each organization has its own cart', () => {
    const a = freshOrg()
    const b = freshOrg()
    addToCart(a, uuid(1))
    expect(cartCount(a)).toBe(1)
    expect(cartCount(b)).toBe(0)
  })

  test('a damaged stored value is read as an empty or cleaned cart', () => {
    const org = freshOrg()
    const key = cartStorageKey(org)
    storage.setItem(key, 'not json')
    expect(readCart(org).items).toEqual([])
    storage.setItem(key, JSON.stringify({ v: 2, items: [{ offer_uuid: uuid(1), added_at: 1 }] }))
    expect(readCart(org).items).toEqual([])
    storage.setItem(
      key,
      JSON.stringify({
        v: 1,
        items: [
          { offer_uuid: uuid(1), added_at: 5 },
          { offer_uuid: uuid(1), added_at: 6 },
          { offer_uuid: '<img src=x>', added_at: 7 },
          { offer_uuid: uuid(2).toUpperCase(), added_at: 'x' },
          null,
          ...Array.from({ length: 30 }, (_, i) => ({ offer_uuid: uuid(100 + i), added_at: 8 })),
        ],
      })
    )
    const items = readCart(org).items
    expect(items.length).toBe(20)
    expect(items[0]).toEqual({ offer_uuid: uuid(1), added_at: 5 })
    expect(items[1]).toEqual({ offer_uuid: uuid(2), added_at: 0 })
  })

  test('broken storage: the cart keeps working in memory', () => {
    const org = freshOrg()
    setGlobal('localStorage', new BrokenStorage())
    expect(addToCart(org, uuid(1))).toBe('added')
    expect(addToCart(org, uuid(1))).toBe('exists')
    expect(addToCart(org, uuid(2))).toBe('added')
    expect(cartCount(org)).toBe(2)
    expect(removeFromCart(org, uuid(1))).toBe(true)
    expect(readCart(org).items.map((i) => i.offer_uuid)).toEqual([uuid(2)])
    clearCart(org)
    expect(cartCount(org)).toBe(0)
  })

  test('no localStorage at all (old browser, server): memory as well', () => {
    const org = freshOrg()
    delete globalThis.localStorage
    expect(addToCart(org, uuid(1))).toBe('added')
    expect(cartCount(org)).toBe(1)
  })

  test('once storage works again, a write moves the cart back to it', () => {
    const org = freshOrg()
    setGlobal('localStorage', new BrokenStorage())
    addToCart(org, uuid(1))
    const healthy = new FakeStorage()
    setGlobal('localStorage', healthy)
    expect(addToCart(org, uuid(2))).toBe('added')
    expect(JSON.parse(healthy.getItem(cartStorageKey(org))).items.map((i) => i.offer_uuid)).toEqual([uuid(1), uuid(2)])
  })

  test('subscribeCart: changes in this tab and in other tabs, until unsubscribed', () => {
    const org = freshOrg()
    const win = new EventTarget()
    setGlobal('window', win)
    let calls = 0
    const unsubscribe = subscribeCart(() => calls++)

    let fired = 0
    win.addEventListener(CART_EVENT, () => fired++)
    addToCart(org, uuid(1))
    expect(fired).toBe(1)
    expect(calls).toBe(1)

    // Another tab changed this cart / another key / cleared everything.
    win.dispatchEvent(Object.assign(new Event('storage'), { key: cartStorageKey(org) }))
    expect(calls).toBe(2)
    win.dispatchEvent(Object.assign(new Event('storage'), { key: 'copilot-bubble-mode' }))
    expect(calls).toBe(2)
    win.dispatchEvent(Object.assign(new Event('storage'), { key: null }))
    expect(calls).toBe(3)

    // Refused adds change nothing and fire nothing.
    addToCart(org, uuid(1))
    addToCart(org, 'bad')
    expect(calls).toBe(3)

    unsubscribe()
    addToCart(org, uuid(2))
    expect(calls).toBe(3)
  })

  test('without window, subscribing is a harmless no-op', () => {
    const unsubscribe = subscribeCart(() => {})
    expect(typeof unsubscribe).toBe('function')
    unsubscribe()
  })
})

describe('money (es-VE, contract §0.8)', () => {
  test('amounts with dots for thousands and comma for cents', () => {
    expect(formatAmount(35492.08)).toBe('35.492,08')
    expect(formatAmount(1234.5)).toBe('1.234,50')
    expect(formatAmount(0)).toBe('0,00')
    expect(formatAmount('887.302')).toBe('887,30')
    expect(formatAmount(null)).toBe('')
    expect(formatAmount('abc')).toBe('')
  })

  test('US$ and Bs. labels', () => {
    expect(formatUsd(40)).toBe('US$ 40,00')
    expect(formatUsd(25.5)).toBe('US$ 25,50')
    expect(formatBs(35492.08)).toBe('Bs. 35.492,08')
    expect(formatBs(undefined)).toBe('')
  })

  test('the rate shows two decimals', () => {
    expect(formatRate(887.302)).toBe('887,30')
    expect(formatRate(1004.567891)).toBe('1.004,57')
  })

  test('"Copiar" puts the amount without thousands dots', () => {
    expect(amountForCopy(35492.08)).toBe('35492,08')
    expect(amountForCopy(1234567.5)).toBe('1234567,50')
    expect(amountForCopy(40)).toBe('40,00')
    expect(amountForCopy(null)).toBe('')
  })

  test('phone and ID are copied as digits only', () => {
    expect(digitsOnly('0424-1234567')).toBe('04241234567')
    expect(digitsOnly('V-12.345.678')).toBe('12345678')
    expect(digitsOnly(null)).toBe('')
  })
})

describe('WhatsApp', () => {
  test('number shown as +58 424 882 4634', () => {
    expect(formatWhatsappNumber('584248824634')).toBe('+58 424 882 4634')
    expect(formatWhatsappNumber('+58 (424) 882-4634')).toBe('+58 424 882 4634')
    expect(formatWhatsappNumber('15551234567')).toBe('+15551234567')
    expect(formatWhatsappNumber('')).toBe('')
  })

  test('chat link without message', () => {
    expect(whatsappChatUrl('584248824634')).toBe('https://wa.me/584248824634')
    expect(whatsappChatUrl('123')).toBe(null)
    expect(whatsappChatUrl(null)).toBe(null)
  })

  test('only https links to WhatsApp are followed, else the plain chat link', () => {
    const url = 'https://wa.me/584248824634?text=Hola%2C%20hice%20un%20Pago%20M%C3%B3vil'
    expect(safeWhatsappUrl(url, '584248824634')).toBe(url)
    expect(safeWhatsappUrl('https://api.whatsapp.com/send?phone=584248824634')).toBe('https://api.whatsapp.com/send?phone=584248824634')
    expect(safeWhatsappUrl('javascript:alert(1)', '584248824634')).toBe('https://wa.me/584248824634')
    expect(safeWhatsappUrl('https://evil.example/wa.me/584248824634', '584248824634')).toBe('https://wa.me/584248824634')
    expect(safeWhatsappUrl('http://wa.me/584248824634')).toBe(null)
    expect(safeWhatsappUrl(null)).toBe(null)
  })
})

describe('dates in America/Caracas', () => {
  const plain = (s) => s.replace(/\s/g, ' ')

  test('date and time as 28/10/2026, 3:45 p. m.', () => {
    expect(plain(formatCaracasDateTime('2026-10-28T19:45:00Z'))).toBe('28/10/2026, 3:45 p. m.')
    expect(plain(formatCaracasDateTime('2026-10-28T13:05:00Z'))).toBe('28/10/2026, 9:05 a. m.')
    expect(plain(formatCaracasDateTime('2026-10-28T04:00:00Z'))).toBe('28/10/2026, 12:00 a. m.')
    expect(plain(formatCaracasDateTime('2026-10-28T16:00:00+00:00'))).toBe('28/10/2026, 12:00 p. m.')
    expect(plain(formatCaracasDateTime('2026-10-28T19:45:00Z', 'en'))).toBe('28/10/2026, 3:45 PM')
    expect(formatCaracasDateTime('nope')).toBe('')
    expect(formatCaracasDateTime(null)).toBe('')
  })

  test('the day follows Caracas, not UTC', () => {
    expect(formatCaracasDate('2026-10-28T02:00:00Z')).toBe('27/10/2026')
    expect(formatCaracasDate('2026-10-28T12:00:00Z')).toBe('28/10/2026')
  })

  test('a date-only value (fx_date) never shifts a day', () => {
    expect(formatIsoDate('2026-10-27')).toBe('27/10/2026')
    expect(formatIsoDate('2026-01-01')).toBe('01/01/2026')
    expect(formatIsoDate(null)).toBe('')
    expect(formatIsoDate('27/10/2026')).toBe('')
  })
})

describe('orders', () => {
  test('known statuses only', () => {
    expect(PURCHASE_STATUSES).toEqual(['pending', 'paid', 'rejected', 'cancelled', 'expired', 'voided'])
    expect(purchaseStatus('PAID')).toBe('paid')
    expect(purchaseStatus('refunded')).toBe(null)
    expect(purchaseStatus(undefined)).toBe(null)
  })

  test('pending orders first, the rest in the API order', () => {
    const list = [
      { code: 'A', status: 'paid' },
      { code: 'B', status: 'pending' },
      { code: 'C', status: 'expired' },
      { code: 'D', status: 'pending' },
    ]
    expect(sortPurchasesPendingFirst(list).map((p) => p.code)).toEqual(['B', 'D', 'A', 'C'])
    expect(list.map((p) => p.code)).toEqual(['A', 'B', 'C', 'D'])
  })

  test('purchase ids in URLs', () => {
    expect(isPlausiblePurchaseUuid('3f2a9c4e8b1d4e0fa2c3b4d5e6f70812')).toBe(true)
    expect(isPlausiblePurchaseUuid('../login')).toBe(false)
    expect(isPlausiblePurchaseUuid('abc?x=1')).toBe(false)
  })
})

describe('API errors shown to the buyer', () => {
  test('the structured message (Spanish by contract) is shown', () => {
    const overlapping = {
      detail: { code: 'OVERLAPPING_OFFERS', message: 'Dos productos incluyen el mismo curso.', offer_uuids: [uuid(1), uuid(2)] },
    }
    expect(apiMessage(overlapping, 400)).toBe('Dos productos incluyen el mismo curso.')
    // Also when FastAPI hands the detail over as a JSON string.
    expect(apiMessage({ detail: JSON.stringify(overlapping.detail) }, 400)).toBe('Dos productos incluyen el mismo curso.')
    expect(errorList(overlapping, 'offer_uuids')).toEqual([uuid(1), uuid(2)])
    expect(errorList({ detail: { offer_uuids: [uuid(1), 7, null, ''] } }, 'offer_uuids')).toEqual([uuid(1)])
    expect(errorList({ detail: 'texto' }, 'offer_uuids')).toEqual([])
  })

  test("a plain-string detail only for 429 (the rate limiter); never FastAPI's English", () => {
    expect(apiMessage({ detail: 'Demasiados intentos. Espera un momento e inténtalo de nuevo.' }, 429)).toBe(
      'Demasiados intentos. Espera un momento e inténtalo de nuevo.'
    )
    expect(apiMessage({ detail: 'Not authenticated' }, 401)).toBe(null)
    expect(apiMessage({ detail: 'Could not validate credentials' })).toBe(null)
    expect(apiMessage({ detail: [{ msg: 'field required' }] }, 422)).toBe(null)
    expect(apiMessage(null, 500)).toBe(null)
  })

  test('failed calls keep their HTTP status', () => {
    const error = new CartApiError(429, { detail: 'x' })
    expect(error).toBeInstanceOf(Error)
    expect(error.status).toBe(429)
  })
})

describe('sc_cart strings', () => {
  const webRoot = path.resolve(import.meta.dirname, '..')
  const read = (p) => fs.readFileSync(path.join(webRoot, p), 'utf8')
  const readJson = (p) => JSON.parse(read(p))
  const flatten = (obj, prefix = '') =>
    Object.entries(obj).flatMap(([k, v]) =>
      v && typeof v === 'object' && !Array.isArray(v) ? flatten(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]
    )
  const es = Object.fromEntries(flatten(readJson('locales-sc/cart.es.json')))
  const en = Object.fromEntries(flatten(readJson('locales-sc/cart.en.json')))

  test('es and en bundles have the same keys and placeholders, and match the merged locales', () => {
    const problems = []
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
  })

  test('every order status has a label, with the contract wording', () => {
    for (const status of PURCHASE_STATUSES) {
      expect(typeof es[`sc_cart.status.${status}`]).toBe('string')
      expect(typeof en[`sc_cart.status.${status}`]).toBe('string')
    }
    expect(es['sc_cart.status.pending']).toBe('Por confirmar')
    expect(es['sc_cart.status.voided']).toBe('Anulado')
    expect(es['sc_cart.add.add_to_cart']).toBe('Agregar al carrito')
    expect(es['sc_cart.add.in_cart']).toBe('En el carrito ✓ · Ver carrito')
    expect(es['sc_cart.purchase.whatsapp_button']).toBe('Enviar comprobante por WhatsApp')
    expect(es['sc_cart.add.added_live']).toBe('Agregado al carrito')
  })

  test('the rate: concrete source when known, "tasa del día" otherwise (it may be set by hand)', () => {
    expect(es['sc_cart.summary.rate_bcv']).toBe('Tasa BCV del {{date}}: {{rate}} Bs. por US$')
    expect(es['sc_cart.summary.rate_manual']).toBe('Tasa del día: {{rate}} Bs. por US$')
    expect(es['sc_cart.add.pago_movil_hint']).toContain('a la tasa del día')
    for (const [key, value] of Object.entries(es)) {
      expect({ key, official: /oficial/i.test(value), fixedBy: /fijada por/i.test(value) }).toEqual({
        key,
        official: false,
        fixedBy: false,
      })
    }
  })

  test("every ct('…') key used by the store code exists", () => {
    const files = [
      ...fs
        .readdirSync(path.join(webRoot, 'components/Store/Cart'))
        .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
        .map((f) => `components/Store/Cart/${f}`),
      'app/orgs/[orgslug]/(withmenu)/store/offers/[offerid]/offer-detail.tsx',
    ]
    const has = (key) => key in es || `${key}_one` in es || `${key}_other` in es
    const missing = []
    let checked = 0
    for (const file of files) {
      for (const [, key] of read(file).matchAll(/\bct\(\s*'([a-z0-9_.]+)'/g)) {
        checked++
        if (!has(`sc_cart.${key}`)) missing.push(`${file}: ${key}`)
      }
    }
    expect(checked).toBeGreaterThan(60)
    expect(missing).toEqual([])
  })

  test('Pago Móvil wording in sc_commerce', () => {
    const commerceEs = Object.fromEntries(flatten(readJson('locales-sc/commerce.es.json')))
    expect(commerceEs['sc_commerce.providers.pago_movil']).toBe('Pago Móvil')
    expect(commerceEs['sc_commerce.course_actions.payment_pending_description']).toBe(
      'Estamos revisando tu pago. Te avisaremos por correo en cuanto tengas acceso.'
    )
  })
})

// Sanar y Criar: /regalo, where the parenting test result and the free ebook
// land after signing up (contract "regalo" §B).
//  - the query parameters and the canonical path ("esta ruta");
//  - which of the four states the page shows;
//  - the sign-up mark (sessionStorage, 2 h, only for the same path) and the
//    "already subscribed" key (localStorage);
//  - the links: sign-up/login with an encoded ?redirect, cart or offer page,
//    the WhatsApp booking link;
//  - telling a /regalo ?redirect apart (not /regalos);
//  - the copy in locales-sc/learning (es + en) and resendVerificationEmail's
//    return_path.
// All fixtures are synthetic.
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const {
  REGALO_PATH,
  DEFAULT_ORIGEN,
  SIGNUP_MARK_KEY,
  SIGNUP_MARK_TTL_MS,
  SUBSCRIBED_KEY_PREFIX,
  CITA_WHATSAPP_MESSAGE,
  parseRegaloParams,
  regaloPath,
  regaloPathFrom,
  regaloResultadoOf,
  regaloView,
  showsResult,
  saveSignupMark,
  readSignupMark,
  subscribedKey,
  wasSubscribed,
  rememberSubscribed,
  regaloAuthHref,
  guiaHref,
  offerHref,
  buyHref,
  citaWhatsappUrl,
  accentParts,
} = await import('../components/SanarYCriar/regalo.ts')
const { redirectFromSearch } = await import('../components/Payments/commerce.ts')

const GUIA = '2999a0ad-d98b-471c-b7df-abcf4dae2462'
const OFERTA = '90785380-5e6a-4f71-8ef3-4abafe46cafa'
// What the marketing site's giftPath('test', 'limites') builds.
const FROM_WWW = `/regalo?resultado=limites&origen=test&guia=${GUIA}&oferta=${OFERTA}`

function memoryStorage() {
  const map = new Map()
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
}

const throwing = {
  getItem: () => {
    throw new Error('blocked')
  },
  setItem: () => {
    throw new Error('blocked')
  },
  removeItem: () => {
    throw new Error('blocked')
  },
}

describe('parameters', () => {
  test('valid values, from a query string, URLSearchParams or Next searchParams', () => {
    const want = { resultado: 'limites', origen: 'test', guia: GUIA, oferta: OFERTA }
    expect(parseRegaloParams(FROM_WWW.slice(FROM_WWW.indexOf('?')))).toEqual(want)
    expect(parseRegaloParams(new URLSearchParams(FROM_WWW.split('?')[1]))).toEqual(want)
    expect(parseRegaloParams({ resultado: 'limites', origen: 'test', guia: GUIA, oferta: OFERTA })).toEqual(want)
  })

  test('missing or invalid values fall back as in the contract table', () => {
    expect(parseRegaloParams('')).toEqual({ resultado: null, origen: DEFAULT_ORIGEN, guia: null, oferta: null })
    expect(parseRegaloParams(null)).toEqual({ resultado: null, origen: 'guia-gratis', guia: null, oferta: null })
    const bad = parseRegaloParams({ resultado: 'diagnostico', origen: 'instagram', guia: 'abc', oferta: `${OFERTA}x` })
    expect(bad).toEqual({ resultado: null, origen: 'guia-gratis', guia: null, oferta: null })
    expect(parseRegaloParams({ guia: `../${GUIA}` }).guia).toBeNull()
    expect(parseRegaloParams({ oferta: OFERTA.replace(/-/g, '') }).oferta).toBeNull()
  })

  test('every result and origin of the contract', () => {
    for (const r of ['guia', 'limites', 'cita']) expect(parseRegaloParams({ resultado: r }).resultado).toBe(r)
    for (const o of ['test', 'guia-gratis', 'ventana-web']) expect(parseRegaloParams({ origen: o }).origen).toBe(o)
  })

  test('uuids: lowercased first, "course_" optional on guia only', () => {
    expect(parseRegaloParams({ guia: `course_${GUIA}` }).guia).toBe(GUIA)
    expect(parseRegaloParams({ guia: GUIA.toUpperCase() }).guia).toBe(GUIA)
    expect(parseRegaloParams({ guia: `COURSE_${GUIA.toUpperCase()}` }).guia).toBe(GUIA)
    expect(parseRegaloParams({ oferta: ` ${OFERTA.toUpperCase()} ` }).oferta).toBe(OFERTA)
    expect(parseRegaloParams({ oferta: `course_${OFERTA}` }).oferta).toBeNull()
  })

  test('a repeated parameter uses its first value', () => {
    expect(parseRegaloParams({ resultado: ['cita', 'guia'] }).resultado).toBe('cita')
    expect(parseRegaloParams('?origen=test&origen=ventana-web').origen).toBe('test')
  })
})

describe('canonical path', () => {
  test('a link from the marketing site comes out unchanged', () => {
    expect(regaloPath(parseRegaloParams(FROM_WWW.split('?')[1]))).toBe(FROM_WWW)
    const free = `/regalo?origen=ventana-web&guia=${GUIA}&oferta=${OFERTA}`
    expect(regaloPath(parseRegaloParams(free.split('?')[1]))).toBe(free)
  })

  test('only valid values, always with an origin, in a fixed order', () => {
    expect(regaloPath(parseRegaloParams(''))).toBe('/regalo?origen=guia-gratis')
    expect(regaloPath(parseRegaloParams(`?oferta=${OFERTA}&x=1&resultado=cita&guia=nope`))).toBe(
      `/regalo?resultado=cita&origen=guia-gratis&oferta=${OFERTA}`
    )
  })

  test('only characters the API return_path guard accepts', () => {
    for (const r of [null, 'guia', 'limites', 'cita']) {
      const p = regaloPath({ resultado: r, origen: 'ventana-web', guia: GUIA, oferta: OFERTA })
      expect(p).toMatch(/^\/regalo\?[A-Za-z0-9/?&=_.%-]+$/)
      expect(p).not.toContain('//')
      expect(p).not.toContain('..')
      expect(p.length).toBeLessThanOrEqual(512)
    }
  })
})

describe('telling a /regalo redirect apart', () => {
  test('pathname exactly /regalo, with or without a query', () => {
    expect(regaloPathFrom(FROM_WWW)).toBe(FROM_WWW)
    expect(regaloPathFrom('/regalo')).toBe('/regalo?origen=guia-gratis')
    expect(regaloPathFrom(`/regalo?resultado=guia&origen=test#tu-regalo`)).toBe('/regalo?resultado=guia&origen=test')
  })

  test('not /regalos, /regalo/x, other pages, other hosts or unsafe values', () => {
    for (const p of [
      '/regalos',
      '/regalos?resultado=guia',
      '/regalox',
      '/regalo/',
      '/regalo/extra',
      '/Regalo',
      '/regalo/../admin',
      '/store/regalo',
      '/course/abc',
      'https://evil.example/regalo',
      '//evil.example/regalo',
      '/\\evil.example/regalo',
      '/regalo?x=1\n',
      'regalo',
      '',
      null,
      undefined,
    ]) {
      expect(regaloPathFrom(p)).toBeNull()
    }
  })

  test('the result a /regalo path carries', () => {
    expect(regaloResultadoOf(FROM_WWW)).toBe('limites')
    expect(regaloResultadoOf('/regalo?origen=guia-gratis')).toBeNull()
    expect(regaloResultadoOf('/regalos?resultado=guia')).toBeNull()
    expect(regaloResultadoOf(null)).toBeNull()
  })
})

describe('which state to show', () => {
  const v = (status, user, hasMark = false) => regaloView({ status, user, hasMark })

  test('the four states', () => {
    expect(v('authenticated', { email_verified: true })).toBe('verified')
    expect(v('authenticated', { email_verified: false })).toBe('unverified')
    expect(v('unauthenticated', null, true)).toBe('pending')
    expect(v('unauthenticated', null, false)).toBe('gate')
  })

  test('a session wins over the mark; only an explicit false is unverified', () => {
    expect(v('authenticated', { email_verified: true }, true)).toBe('verified')
    expect(v('authenticated', { email_verified: false }, true)).toBe('unverified')
    expect(v('authenticated', {})).toBe('verified')
    expect(v('authenticated', null)).toBe('gate')
    expect(v('loading', null, true)).toBe('loading')
  })

  test('the result shows only with an account (or one just created)', () => {
    expect(showsResult('verified')).toBe(true)
    expect(showsResult('unverified')).toBe(true)
    expect(showsResult('pending')).toBe(true)
    expect(showsResult('gate')).toBe(false)
    expect(showsResult('loading')).toBe(false)
  })
})

describe('sign-up mark', () => {
  const now = 1_700_000_000_000

  test('saved by the sign-up page and read back for the same path', () => {
    const s = memoryStorage()
    expect(saveSignupMark({ path: FROM_WWW, email: 'ana@example.com' }, now, s)).toBe(true)
    expect(JSON.parse(s.map.get(SIGNUP_MARK_KEY))).toEqual({ path: FROM_WWW, email: 'ana@example.com', at: now })
    expect(readSignupMark(FROM_WWW, now + 1_000, s)).toEqual({ path: FROM_WWW, email: 'ana@example.com', at: now, verified: false })
    // Reading does not consume it: a reload still shows "we sent you an email".
    expect(readSignupMark(FROM_WWW, now + 2_000, s)).not.toBeNull()
  })

  test('the same path written another way still counts', () => {
    const s = memoryStorage()
    saveSignupMark({ path: `/regalo?oferta=${OFERTA}&guia=COURSE_${GUIA.toUpperCase()}&origen=test&resultado=limites`, email: 'ana@example.com' }, now, s)
    expect(readSignupMark(FROM_WWW, now, s)?.email).toBe('ana@example.com')
  })

  test('another path does not count', () => {
    const s = memoryStorage()
    saveSignupMark({ path: FROM_WWW, email: 'ana@example.com' }, now, s)
    expect(readSignupMark(FROM_WWW.replace('limites', 'cita'), now, s)).toBeNull()
    expect(readSignupMark(FROM_WWW.replace('origen=test', 'origen=ventana-web'), now, s)).toBeNull()
    expect(readSignupMark(`/regalo?origen=test&guia=${GUIA}&oferta=${OFERTA}`, now, s)).toBeNull()
    expect(readSignupMark('/regalos', now, s)).toBeNull()
    // Still there for its own path.
    expect(readSignupMark(FROM_WWW, now, s)).not.toBeNull()
  })

  test('expires after 2 h (and is removed); a date in the future is refused', () => {
    const s = memoryStorage()
    saveSignupMark({ path: FROM_WWW, email: 'ana@example.com' }, now, s)
    expect(readSignupMark(FROM_WWW, now + SIGNUP_MARK_TTL_MS, s)).not.toBeNull()
    expect(readSignupMark(FROM_WWW, now + SIGNUP_MARK_TTL_MS + 1, s)).toBeNull()
    expect(s.map.size).toBe(0)
    saveSignupMark({ path: FROM_WWW, email: 'ana@example.com' }, now + 10 * 60_000, s)
    expect(readSignupMark(FROM_WWW, now, s)).toBeNull()
  })

  test('verified flag: the account only needs a login', () => {
    const s = memoryStorage()
    saveSignupMark({ path: FROM_WWW, email: 'ana@example.com', verified: true }, now, s)
    expect(readSignupMark(FROM_WWW, now, s)?.verified).toBe(true)
  })

  test('nothing is saved for other pages or without a usable email', () => {
    const s = memoryStorage()
    expect(saveSignupMark({ path: '/store/cart', email: 'ana@example.com' }, now, s)).toBe(false)
    expect(saveSignupMark({ path: '/regalos', email: 'ana@example.com' }, now, s)).toBe(false)
    expect(saveSignupMark({ path: FROM_WWW, email: '' }, now, s)).toBe(false)
    expect(saveSignupMark({ path: FROM_WWW, email: 'not an email' }, now, s)).toBe(false)
    expect(s.map.size).toBe(0)
  })

  test('broken values and blocked storage are harmless', () => {
    const s = memoryStorage()
    s.setItem(SIGNUP_MARK_KEY, 'not json')
    expect(readSignupMark(FROM_WWW, now, s)).toBeNull()
    s.setItem(SIGNUP_MARK_KEY, JSON.stringify({ path: FROM_WWW, email: 'ana@example.com', at: 'soon' }))
    expect(readSignupMark(FROM_WWW, now, s)).toBeNull()
    s.setItem(SIGNUP_MARK_KEY, JSON.stringify({ path: 'https://evil.example/regalo', email: 'ana@example.com', at: now }))
    expect(readSignupMark('/regalo', now, s)).toBeNull()
    expect(saveSignupMark({ path: FROM_WWW, email: 'ana@example.com' }, now, null)).toBe(false)
    expect(readSignupMark(FROM_WWW, now, null)).toBeNull()
    expect(saveSignupMark({ path: FROM_WWW, email: 'ana@example.com' }, now, throwing)).toBe(false)
    expect(readSignupMark(FROM_WWW, now, throwing)).toBeNull()
  })
})

describe('"already subscribed" key', () => {
  test('one key per org, reader and origin', () => {
    expect(subscribedKey(1, 'user_abc', 'test')).toBe(`${SUBSCRIBED_KEY_PREFIX}:1:user_abc:test`)
    expect(subscribedKey(1, 'user_abc', 'guia-gratis')).not.toBe(subscribedKey(1, 'user_abc', 'test'))
    expect(subscribedKey(1, 'user_xyz', 'test')).not.toBe(subscribedKey(1, 'user_abc', 'test'))
    expect(subscribedKey(2, 'user_abc', 'test')).not.toBe(subscribedKey(1, 'user_abc', 'test'))
    expect(subscribedKey(1, 15, 'test')).toBe(`${SUBSCRIBED_KEY_PREFIX}:1:15:test`)
  })

  test('no key without an org or a reader', () => {
    expect(subscribedKey(1, null, 'test')).toBeNull()
    expect(subscribedKey(1, '', 'test')).toBeNull()
    expect(subscribedKey(null, 'user_abc', 'test')).toBeNull()
  })

  test('remembered once it worked, and storage problems are harmless', () => {
    const s = memoryStorage()
    const key = subscribedKey(1, 'user_abc', 'test')
    expect(wasSubscribed(key, s)).toBe(false)
    rememberSubscribed(key, 123, s)
    expect(wasSubscribed(key, s)).toBe(true)
    expect(wasSubscribed(subscribedKey(1, 'user_abc', 'ventana-web'), s)).toBe(false)
    expect(wasSubscribed(null, s)).toBe(false)
    expect(() => rememberSubscribed(key, 123, throwing)).not.toThrow()
    expect(wasSubscribed(key, throwing)).toBe(false)
    expect(wasSubscribed(key, null)).toBe(false)
  })
})

describe('links', () => {
  test('sign-up and login carry the whole path, encoded', () => {
    const signup = regaloAuthHref('signup', FROM_WWW)
    expect(signup).toBe(`/signup?redirect=${encodeURIComponent(FROM_WWW)}`)
    expect(signup).not.toContain('&origen=')
    expect(regaloAuthHref('login', FROM_WWW)).toBe(`/login?redirect=${encodeURIComponent(FROM_WWW)}`)
    // What the sign-up page reads back is the same path, every parameter included.
    const back = redirectFromSearch(signup.slice(signup.indexOf('?')))
    expect(back).toBe(FROM_WWW)
    expect(regaloPathFrom(back)).toBe(FROM_WWW)
  })

  test('free ebook and offer pages', () => {
    expect(guiaHref(GUIA)).toBe(`/course/${GUIA}`)
    expect(guiaHref(null)).toBeNull()
    expect(offerHref(OFERTA)).toBe(`/store/offers/${OFERTA}`)
    expect(offerHref(null)).toBeNull()
  })

  test('«Lo quiero»: the cart with Pago Móvil, else the offer page', () => {
    expect(buyHref(OFERTA, true, 'one_time')).toBe(`/store/cart?add=${OFERTA}`)
    expect(buyHref(OFERTA, true, null)).toBe(`/store/cart?add=${OFERTA}`)
    expect(buyHref(OFERTA, false, 'one_time')).toBe(`/store/offers/${OFERTA}`)
    expect(buyHref(OFERTA, true, 'subscription')).toBe(`/store/offers/${OFERTA}`)
    expect(buyHref(null, true, 'one_time')).toBeNull()
  })

  test('«Agenda tu cita online» opens WhatsApp with the message', () => {
    const url = citaWhatsappUrl()
    expect(url).toBe(
      'https://wa.me/584248824634?text=Hola%2C%20Hilda.%20Hice%20el%20test%20de%20crianza%20y%20quisiera%20agendar%20una%20cita%20online.'
    )
    expect(new URL(url).searchParams.get('text')).toBe(CITA_WHATSAPP_MESSAGE)
    expect(CITA_WHATSAPP_MESSAGE).toBe('Hola, Hilda. Hice el test de crianza y quisiera agendar una cita online.')
  })
})

describe('accent word', () => {
  test('the word between asterisks is the accent', () => {
    expect(accentParts('Empieza por *ti*, sin culpa.')).toEqual([
      { text: 'Empieza por ', accent: false },
      { text: 'ti', accent: true },
      { text: ', sin culpa.', accent: false },
    ])
    expect(accentParts('*Límites* al inicio')).toEqual([
      { text: 'Límites', accent: true },
      { text: ' al inicio', accent: false },
    ])
    expect(accentParts('Escribí *Límites sin culpa* para ti · $9')[1]).toEqual({ text: 'Límites sin culpa', accent: true })
  })

  test('without a pair of asterisks the text stays as it is', () => {
    expect(accentParts('Sin acento')).toEqual([{ text: 'Sin acento', accent: false }])
    expect(accentParts('Un * suelto')).toEqual([{ text: 'Un * suelto', accent: false }])
    expect(accentParts('')).toEqual([])
  })
})

describe('copy (locales-sc/learning)', () => {
  const webRoot = path.resolve(import.meta.dirname, '..')
  const bundle = (lng) => JSON.parse(fs.readFileSync(path.join(webRoot, 'locales-sc', `learning.${lng}.json`), 'utf8')).sc_learning
  const get = (tree, key) => key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), tree)
  const tokens = (s) => (s.match(/\{\{[^}]+\}\}/g) || []).sort()

  // Every key RegaloPage.tsx and RegaloAuthBanner.tsx read (the result ones are built per result).
  const KEYS = [
    'regalo.eyebrow',
    'regalo.free_title',
    ...['guia', 'limites', 'cita'].flatMap((r) => ['badge', 'title', 'text', 'cta'].map((f) => `regalo.result.${r}.${f}`)),
    'regalo.result.guia.more',
    'regalo.result.limites.cta_price',
    'regalo.result.limites.details',
    'regalo.result.limites.free_first',
    'regalo.result.cita.free_meanwhile',
    'regalo.result.disclaimer',
    'regalo.result.retake',
    'regalo.result.new_tab',
    ...['ready_title', 'ready_title_free', 'ready_text', 'ready_text_generic', 'read', 'subscribed', 'verify_title', 'verify_text',
      'verify_text_no_email', 'pending_title', 'pending_text', 'pending_activated', 'login', 'created_title', 'created_text'].map(
      (k) => `regalo.gift.${k}`
    ),
    ...['result_title', 'result_text', 'free_title', 'free_text', 'signup', 'login'].map((k) => `regalo.gate.${k}`),
    ...['title', 'text', 'text_price', 'cta'].map((k) => `regalo.sale.${k}`),
    ...['signup_result', 'signup', 'login_result', 'login'].map((k) => `regalo.banner.${k}`),
    ...['resend', 'resending', 'resent', 'resend_error', 'resend_rate_limited', 'verified', 'checking', 'still_unverified'].map(
      (k) => `free_gate.${k}`
    ),
  ]

  test('every key the page reads exists in es and en, with the same placeholders', () => {
    const es = bundle('es')
    const en = bundle('en')
    const problems = []
    for (const key of KEYS) {
      const a = get(es, key)
      const b = get(en, key)
      if (typeof a !== 'string' || !a.trim()) problems.push(`es ${key}`)
      else if (typeof b !== 'string' || !b.trim()) problems.push(`en ${key}`)
      else if (JSON.stringify(tokens(a)) !== JSON.stringify(tokens(b))) problems.push(`placeholders ${key}`)
    }
    expect(problems).toEqual([])
    expect(get(es, 'regalo.result.limites.cta_price')).toContain('{{price}}')
    expect(get(es, 'regalo.sale.text_price')).toContain('{{price}}')
    expect(get(es, 'regalo.gift.pending_text')).toContain('{{email}}')
    expect(get(es, 'regalo.gift.verify_text')).toContain('{{email}}')
  })

  test("the client's exact copy for the results", () => {
    const es = bundle('es')
    expect(get(es, 'regalo.result.guia.badge')).toBe('Tu resultado · Guía gratis')
    expect(get(es, 'regalo.result.guia.title')).toBe('Empieza por *ti*, sin culpa.')
    expect(get(es, 'regalo.result.guia.text')).toBe(
      'Por lo que me cuentas, lo que más te pesa es lo que sientes después de reaccionar. Quiero que sepas algo: no eres una mala mamá. Eres una mamá que se está dando cuenta, y ese ya es el primer paso. Te regalo mi guía para empezar.'
    )
    expect(get(es, 'regalo.result.guia.cta')).toBe('Quiero mi guía gratis')
    expect(get(es, 'regalo.result.guia.more')).toBe('Cuando quieras ir más allá: Límites sin culpa')
    expect(get(es, 'regalo.result.limites.badge')).toBe('Tu resultado · Límites sin culpa')
    expect(get(es, 'regalo.result.limites.title')).toBe('Lo tuyo son los *límites*, y se aprenden.')
    expect(get(es, 'regalo.result.limites.text')).toBe(
      'Quieres darle a tu hijo lo que tú no tuviste, y en el camino te cuesta sostener un «no» sin ceder o terminar gritando. Eso no te hace una mala mamá: te hace una mamá que necesita herramientas. Escribí Límites sin culpa justo para este momento.'
    )
    expect(get(es, 'regalo.result.limites.cta_price')).toBe('Lo quiero · {{price}}')
    expect(get(es, 'regalo.result.limites.cta')).toBe('Lo quiero')
    expect(get(es, 'regalo.result.cita.badge')).toBe('Tu resultado · Acompañamiento')
    expect(get(es, 'regalo.result.cita.title')).toBe('Mereces un acompañamiento *más cercano*.')
    expect(get(es, 'regalo.result.cita.text')).toBe(
      'Por lo que me cuentas, lo que están viviendo en casa pide algo más que una guía: que lo miremos juntas, con calma y sin juicios. Me encantaría acompañarte en una cita online, desde donde estés.'
    )
    expect(get(es, 'regalo.result.cita.cta')).toBe('Agenda tu cita online')
    expect(get(es, 'regalo.result.disclaimer')).toBe(
      'Este test no es un diagnóstico. Es una forma de mirarte con cariño y elegir por dónde empezar.'
    )
    expect(get(es, 'regalo.gate.result_title') + ' ' + get(es, 'regalo.gate.result_text')).toBe(
      'Tu resultado está listo. Crea tu cuenta gratis para verlo y recibir tu ebook de regalo.'
    )
    expect(get(es, 'regalo.gate.free_title') + ' ' + get(es, 'regalo.gate.free_text')).toBe(
      'Tu ebook gratis te espera. Crea tu cuenta gratis para leerlo.'
    )
    expect(get(es, 'regalo.banner.signup_result')).toBe('Crea tu cuenta gratis para ver tu resultado y leer tu ebook de regalo.')
    expect(get(es, 'regalo.banner.signup')).toBe('Crea tu cuenta gratis para leer tu ebook de regalo.')
  })

  // The ready card (review F20 and the end-to-end notes): the announcement,
  // the card heading when the page heading already names the guide, and the
  // line once she is on the letters list.
  test('ready card copy', () => {
    const es = bundle('es')
    expect(get(es, 'regalo.gift.ready_title')).toBe('Tu guía gratis está lista')
    expect(get(es, 'regalo.gift.ready_title_free')).toBe('Ya es tuya')
    expect(get(es, 'regalo.gift.ready_text')).toBe('Léela cuando quieras, desde tu teléfono o tu computadora.')
    expect(get(es, 'regalo.gift.subscribed')).toBe('También te sumé a mis cartas; te das de baja cuando quieras.')
    for (const lng of ['es', 'en']) {
      const b = bundle(lng)
      // Under «Tu guía gratis te espera» the card says something else, and its text does not repeat the heading.
      expect(get(b, 'regalo.gift.ready_title_free')).not.toBe(get(b, 'regalo.free_title'))
      expect(get(b, 'regalo.gift.ready_text').toLowerCase()).not.toContain(get(b, 'regalo.gift.ready_title_free').toLowerCase())
    }
  })

  test('the result titles have their one accent word', () => {
    for (const lng of ['es', 'en']) {
      for (const r of ['guia', 'limites', 'cita']) {
        const parts = accentParts(get(bundle(lng), `regalo.result.${r}.title`))
        expect(parts.filter((p) => p.accent)).toHaveLength(1)
      }
    }
  })
})

describe('resendVerificationEmail', () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ message: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  afterAll(() => {
    globalThis.fetch = realFetch
  })

  test('sends the return path as return_path, and nothing extra without one', async () => {
    const { resendVerificationEmail } = await import('../services/auth/auth.ts')
    expect((await resendVerificationEmail('ana@example.com', 1, FROM_WWW)).success).toBe(true)
    expect(calls[0].url).toEndWith('auth/resend-verification')
    expect(calls[0].body).toEqual({ email: 'ana@example.com', org_id: 1, return_path: FROM_WWW })
    await resendVerificationEmail('ana@example.com', 1)
    expect(calls[1].body).toEqual({ email: 'ana@example.com', org_id: 1 })
    await resendVerificationEmail('ana@example.com')
    expect(calls[2].body).toEqual({ email: 'ana@example.com' })
  })
})

test('REGALO_PATH is the page path', () => {
  expect(REGALO_PATH).toBe('/regalo')
})

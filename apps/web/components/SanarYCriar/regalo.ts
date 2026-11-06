// Sanar y Criar: /regalo, where the parenting test result and the free ebook
// land after signing up on the platform (contract "regalo" §B1, §B2). Pure
// logic only (no React, no Next) so tests/sc-regalo.test.mjs can import it:
// the query parameters, which of the four states to show, the storage keys
// and the links.
//
// Only ids and fixed values travel in the URL, never the test answers, the
// name or the email. The email the sign-up page hands over stays in the
// tab's sessionStorage (the "sign-up mark").
import { safeRedirectPath, withRedirect } from '@components/Payments/commerce'
import { SC_WHATSAPP_NUMBER } from '@components/Objects/Menus/scBrand'

export const REGALO_PATH = '/regalo'

export type RegaloResultado = 'guia' | 'limites' | 'cita'
export type RegaloOrigen = 'test' | 'guia-gratis' | 'ventana-web'

export const REGALO_RESULTADOS: readonly RegaloResultado[] = ['guia', 'limites', 'cita']
export const REGALO_ORIGENES: readonly RegaloOrigen[] = ['test', 'guia-gratis', 'ventana-web']
/** A missing or unknown ?origen: the free ebook section of the marketing site. */
export const DEFAULT_ORIGEN: RegaloOrigen = 'guia-gratis'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type RegaloParams = {
  /** null: no test result, just the gift. */
  resultado: RegaloResultado | null
  origen: RegaloOrigen
  /** The free course's uuid, without "course_" (null: no «Leer mi guía» button). */
  guia: string | null
  /** The «Límites sin culpa» offer's uuid (null: no price and no purchase). */
  oferta: string | null
}

/** Price of the featured offer, from the public offer listing. */
export type RegaloOffer = {
  amount: number
  currency: string
  offer_type: string | null
}

type RawValue = string | string[] | null | undefined
type RawParams = URLSearchParams | Record<string, RawValue> | string | null | undefined

function clean(value: RawValue): string {
  const v = Array.isArray(value) ? value[0] : value
  return typeof v === 'string' ? v.trim().toLowerCase() : ''
}

function read(raw: RawParams, key: string): string {
  if (!raw) return ''
  if (typeof raw === 'string') return clean(new URLSearchParams(raw).get(key))
  if (raw instanceof URLSearchParams) return clean(raw.get(key))
  return clean(raw[key])
}

/**
 * The page's parameters (a query string, URLSearchParams or Next's
 * searchParams object). Anything missing or invalid falls back as in the
 * contract table: no result, origin "guia-gratis", no guide, no offer.
 */
export function parseRegaloParams(raw: RawParams): RegaloParams {
  const resultado = read(raw, 'resultado')
  const origen = read(raw, 'origen')
  const guia = read(raw, 'guia').replace(/^course_/, '')
  const oferta = read(raw, 'oferta')
  return {
    resultado: (REGALO_RESULTADOS as readonly string[]).includes(resultado) ? (resultado as RegaloResultado) : null,
    origen: (REGALO_ORIGENES as readonly string[]).includes(origen) ? (origen as RegaloOrigen) : DEFAULT_ORIGEN,
    guia: UUID_RE.test(guia) ? guia : null,
    oferta: UUID_RE.test(oferta) ? oferta : null,
  }
}

/**
 * "/regalo?resultado=…&origen=…&guia=…&oferta=…", only with valid values and
 * in the order of the marketing site's giftPath(), so a link from www comes
 * out unchanged. It is the "esta ruta" of the page: the ?redirect of its
 * sign-up/login links, the verification email's return path and the key of
 * the sign-up mark.
 */
export function regaloPath(params: RegaloParams): string {
  const query = new URLSearchParams()
  if (params.resultado) query.set('resultado', params.resultado)
  query.set('origen', params.origen)
  if (params.guia) query.set('guia', params.guia)
  if (params.oferta) query.set('oferta', params.oferta)
  return `${REGALO_PATH}?${query.toString()}`
}

/**
 * The canonical /regalo path when `path` (a ?redirect, a stored mark) is the
 * gift page: pathname exactly "/regalo" (not "/regalos"), external or unsafe
 * values rejected. Else null.
 */
export function regaloPathFrom(path: string | null | undefined): string | null {
  const safe = safeRedirectPath(path)
  if (!safe) return null
  try {
    const url = new URL(safe, 'https://relative.invalid')
    return url.pathname === REGALO_PATH ? regaloPath(parseRegaloParams(url.searchParams)) : null
  } catch {
    return null
  }
}

/** The test result a /regalo path carries (for the sign-up banner), else null. */
export function regaloResultadoOf(path: string | null | undefined): RegaloResultado | null {
  const canonical = regaloPathFrom(path)
  return canonical ? parseRegaloParams(canonical.slice(canonical.indexOf('?'))).resultado : null
}

// ---------------------------------------------------------------------------
// Which state the page shows
// ---------------------------------------------------------------------------

/**
 * - verified: signed in with a verified email (result, «Leer mi guía», newsletter);
 * - unverified: signed in, email not verified yet (login does not require it);
 * - pending: no session, but this tab just created the account (sign-up mark);
 * - gate: anyone else; the result stays hidden behind "create your account".
 */
export type RegaloView = 'verified' | 'unverified' | 'pending' | 'gate'

export function regaloView(input: {
  status: string | null | undefined
  user: { email_verified?: boolean | null } | null | undefined
  hasMark: boolean
}): RegaloView | 'loading' {
  if (input.status === 'loading') return 'loading'
  // Same check as signup.tsx: only an explicit false means "not verified".
  if (input.status === 'authenticated' && input.user) return input.user.email_verified === false ? 'unverified' : 'verified'
  return input.hasMark ? 'pending' : 'gate'
}

/** The test result is shown once there is an account (or one was just created). */
export function showsResult(view: RegaloView | 'loading'): boolean {
  return view === 'verified' || view === 'unverified' || view === 'pending'
}

// ---------------------------------------------------------------------------
// Storage: the sign-up mark (sessionStorage) and "already subscribed" (localStorage)
// ---------------------------------------------------------------------------

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function browserStorage(kind: 'sessionStorage' | 'localStorage'): KV | null {
  try {
    return typeof window !== 'undefined' ? window[kind] : null
  } catch {
    return null
  }
}

export const SIGNUP_MARK_KEY = 'sanarycriar:regalo-alta'
export const SIGNUP_MARK_TTL_MS = 2 * 60 * 60 * 1000

/**
 * Left by the sign-up page for /regalo: a password sign-up does not sign in
 * (the email must be verified first), so this is how the page knows the
 * visitor just created the account, and with which email.
 */
export type SignupMark = {
  path: string
  email: string
  at: number
  /** The account came out verified (verification switched off): it only needs a login. */
  verified: boolean
}

function cleanEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim()
  return email.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null
}

/** Saves the mark for a /regalo path; anything else (or no storage) does nothing. */
export function saveSignupMark(
  mark: { path: string | null | undefined; email: string | null | undefined; verified?: boolean },
  now = Date.now(),
  storage: KV | null = browserStorage('sessionStorage')
): boolean {
  const path = regaloPathFrom(mark.path)
  const email = cleanEmail(mark.email)
  if (!path || !email || !storage) return false
  try {
    storage.setItem(SIGNUP_MARK_KEY, JSON.stringify({ path, email, at: now, ...(mark.verified ? { verified: true } : {}) }))
    return true
  } catch {
    return false
  }
}

/** The mark when it is for this same /regalo path and younger than 2 h, else null. */
export function readSignupMark(
  path: string | null | undefined,
  now = Date.now(),
  storage: KV | null = browserStorage('sessionStorage')
): SignupMark | null {
  const wanted = regaloPathFrom(path)
  if (!wanted || !storage) return null
  let raw: string | null = null
  try {
    raw = storage.getItem(SIGNUP_MARK_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  let value: any = null
  try {
    value = JSON.parse(raw)
  } catch {
    value = null
  }
  const at = Number(value?.at)
  const email = cleanEmail(value?.email)
  if (!Number.isFinite(at) || at > now + 60_000 || now - at > SIGNUP_MARK_TTL_MS || !email) {
    // Expired or broken: nothing will ever read it again.
    try {
      storage.removeItem(SIGNUP_MARK_KEY)
    } catch {
      /* blocked storage: nothing to clean */
    }
    return null
  }
  // A mark for another /regalo path (another result or origin) does not count.
  if (regaloPathFrom(typeof value?.path === 'string' ? value.path : null) !== wanted) return null
  return { path: wanted, email, at, verified: value?.verified === true }
}

export const SUBSCRIBED_KEY_PREFIX = 'sanarycriar:regalo-suscrita:v1'

/**
 * localStorage key that remembers a reader already joined the newsletter from
 * /regalo with this origin, so reloading the page does not call the API again.
 */
export function subscribedKey(
  orgId: number | string | null | undefined,
  user: string | number | null | undefined,
  origen: RegaloOrigen
): string | null {
  const org = String(orgId ?? '').trim()
  const who = String(user ?? '').trim()
  return org && who ? `${SUBSCRIBED_KEY_PREFIX}:${org}:${who}:${origen}` : null
}

export function wasSubscribed(key: string | null, storage: KV | null = browserStorage('localStorage')): boolean {
  if (!key || !storage) return false
  try {
    return storage.getItem(key) !== null
  } catch {
    return false
  }
}

export function rememberSubscribed(key: string | null, now = Date.now(), storage: KV | null = browserStorage('localStorage')): void {
  if (!key || !storage) return
  try {
    storage.setItem(key, String(now))
  } catch {
    /* storage full or blocked: the next visit just asks the API again */
  }
}

// ---------------------------------------------------------------------------
// Links (relative to the org; the page wraps them with getUriWithOrg)
// ---------------------------------------------------------------------------

/** "/signup?redirect=%2Fregalo%3F…" or "/login?redirect=…". */
export function regaloAuthHref(kind: 'signup' | 'login', path: string): string {
  return withRedirect(kind === 'signup' ? '/signup' : '/login', path)
}

/** The free ebook's page, or null without a valid ?guia. */
export function guiaHref(guia: string | null): string | null {
  return guia ? `/course/${guia}` : null
}

/** The offer's page (what the guide includes, PayPal), or null without an offer. */
export function offerHref(oferta: string | null): string | null {
  return oferta ? `/store/offers/${oferta}` : null
}

/**
 * «Lo quiero»: the cart when Pago Móvil is on (one-time offers only, like the
 * store's cart button), else the offer page.
 */
export function buyHref(oferta: string | null, cartEnabled: boolean, offerType?: string | null): string | null {
  if (!oferta) return null
  return cartEnabled && (!offerType || offerType === 'one_time') ? `/store/cart?add=${encodeURIComponent(oferta)}` : offerHref(oferta)
}

export const CITA_WHATSAPP_MESSAGE = 'Hola, Hilda. Hice el test de crianza y quisiera agendar una cita online.'

/** «Agenda tu cita online»: a WhatsApp chat with Hilda with the message filled in. */
export function citaWhatsappUrl(message: string = CITA_WHATSAPP_MESSAGE, number: string = SC_WHATSAPP_NUMBER): string {
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export type AccentPart = { text: string; accent: boolean }

/**
 * "Empieza por *ti*, sin culpa." -> plain, accent, plain: the word between
 * asterisks is the title's italic accent (.sc-title-accent). A lone asterisk
 * stays as it is.
 */
export function accentParts(text: string): AccentPart[] {
  const parts: AccentPart[] = []
  const re = /\*([^*\n]+)\*/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), accent: false })
    parts.push({ text: m[1], accent: true })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last), accent: false })
  return parts
}

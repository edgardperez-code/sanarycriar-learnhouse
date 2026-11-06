// Sanar y Criar: /regalo rendered in a DOM (happy-dom) with a stand-in
// session (contract "regalo" §B1; review F20 and the end-to-end notes):
//  - «Ya lo verifiqué» that finds the email verified moves the focus to the
//    card heading and the live region says «Tu guía gratis está lista»; a
//    session refresh in the background leaves the focus where the reader is;
//  - without a test result the card does not repeat the page heading;
//  - once subscribe/me answers (or this browser remembers it did) the ready
//    card says she is on the letters list; a failed call says nothing.
// All fixtures are synthetic.
import { afterEach, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'

const domWindow = new Window({ url: 'http://localhost/regalo' })
for (const key of [
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Text',
  'DocumentFragment',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'CustomEvent',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'FocusEvent',
]) {
  if (domWindow[key] !== undefined && globalThis[key] === undefined) globalThis[key] = domWindow[key]
}
globalThis.window = domWindow
// The updates below run inside act().
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Every request is recorded; subscribe/me answers `subscribeStatus`, the rest 200.
const requests = []
let subscribeStatus = 200
globalThis.fetch = async (url, init = {}) => {
  const href = String(url)
  requests.push({ url: href, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null })
  const status = href.endsWith('/subscribe/me') ? subscribeStatus : 200
  return new Response(JSON.stringify(status === 200 ? { ok: true } : { detail: 'rate_limited' }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// No resources: every string is the bundled Spanish copy (as before the merge).
const { default: i18next } = await import('i18next')
const { initReactI18next } = await import('react-i18next')
await i18next.use(initReactI18next).init({ lng: 'es', resources: {}, interpolation: { escapeValue: false } })

const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { SessionContext } = await import('../components/Contexts/LHSessionContext.tsx')
const { default: RegaloPage } = await import('../components/SanarYCriar/RegaloPage.tsx')
const { subscribedKey } = await import('../components/SanarYCriar/regalo.ts')

const { act } = React
const GUIA = '2999a0ad-d98b-471c-b7df-abcf4dae2462'
const USER = 'user_ana'
const SUBSCRIBED = subscribedKey(1, USER, 'test')
const READY = 'Tu guía gratis está lista'
const JOINED = 'También te sumé a mis cartas; te das de baja cuando quieras.'

let mounted = null

/** Lets pending requests answer and React apply what they set. */
async function settle() {
  for (let i = 0; i < 2; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/**
 * /regalo for a signed-in reader (origin "test"). `checkVerifies`: what «Ya lo
 * verifiqué» finds, i.e. whether session.update(true) brings a verified email.
 */
async function mount({ resultado = null, verified = false, checkVerifies = true } = {}) {
  const params = { resultado, origen: 'test', guia: GUIA, oferta: null }
  const control = {}
  function Harness() {
    const [isVerified, setVerified] = React.useState(verified)
    control.setVerified = setVerified
    const session = {
      status: 'authenticated',
      data: {
        user: { id: 7, user_uuid: USER, email: 'ana@example.com', email_verified: isVerified },
        tokens: { access_token: 'token' },
      },
      update: async () => {
        if (checkVerifies) setVerified(true)
      },
    }
    return React.createElement(
      SessionContext.Provider,
      { value: session },
      React.createElement(RegaloPage, { orgslug: 'sanarycriar', orgId: 1, params, offer: null, storeEnabled: true })
    )
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const client = new QueryClient()
  await act(async () => {
    root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Harness)))
  })
  await settle()
  mounted = { root, container }
  return { container, control }
}

async function click(el) {
  expect(el).toBeTruthy()
  await act(async () => {
    el.click()
  })
  await settle()
}

const byText = (container, selector, text) => [...container.querySelectorAll(selector)].find((el) => el.textContent.trim() === text)
const giftHeading = (container) => container.querySelector('#regalo-gift-title')
const liveRegion = (container) => container.querySelector('#tu-regalo [aria-live="polite"]')
const announcement = (container) => liveRegion(container).querySelector('.sr-only')
const headings = (container) => [...container.querySelectorAll('h1, h2')].map((h) => h.textContent.trim())
const subscribeCalls = () => requests.filter((r) => r.url.endsWith('/newsletter/1/subscribe/me'))

afterEach(async () => {
  if (mounted) {
    const { root, container } = mounted
    await act(async () => root.unmount())
    container.remove()
    mounted = null
  }
  domWindow.localStorage.clear()
  domWindow.sessionStorage.clear()
  requests.length = 0
  subscribeStatus = 200
})

describe('«Ya lo verifiqué» finds the email verified (review F20)', () => {
  test('with a result: focus moves to the card heading and the live region says the guide is ready', async () => {
    const { container } = await mount({ resultado: 'guia' })
    expect(giftHeading(container).textContent).toBe('Activa tu cuenta para leer tu guía')
    const check = byText(container, 'button', 'Ya lo verifiqué')
    check.focus()
    expect(document.activeElement).toBe(check)

    await click(check)

    const heading = giftHeading(container)
    expect(heading.textContent).toBe(READY)
    expect(document.activeElement).toBe(heading)
    expect(heading.getAttribute('tabindex')).toBe('-1')
    expect(announcement(container)?.textContent).toBe(READY)
    expect(byText(container, 'a', 'Leer mi guía')?.getAttribute('href')).toEndWith(`/course/${GUIA}`)
  })

  test('without a result: the same announcement, focus on the card heading «Ya es tuya»', async () => {
    const { container } = await mount()
    await click(byText(container, 'button', 'Ya lo verifiqué'))
    expect(giftHeading(container).textContent).toBe('Ya es tuya')
    expect(document.activeElement).toBe(giftHeading(container))
    expect(announcement(container)?.textContent).toBe(READY)
  })

  test('a session refresh in the background announces it but leaves the focus where the reader is', async () => {
    const { container, control } = await mount({ resultado: 'guia' })
    const retake = byText(container, 'a', 'Repetir el test')
    retake.focus()
    await act(async () => control.setVerified(true))
    await settle()
    expect(giftHeading(container).textContent).toBe(READY)
    expect(document.activeElement).toBe(retake)
    expect(announcement(container)?.textContent).toBe(READY)
  })

  test('still unverified: no announcement, the notice asks to open the link', async () => {
    const { container } = await mount({ resultado: 'guia', checkVerifies: false })
    await click(byText(container, 'button', 'Ya lo verifiqué'))
    expect(giftHeading(container).textContent).toBe('Activa tu cuenta para leer tu guía')
    expect(announcement(container)).toBeNull()
    expect(liveRegion(container).textContent).toContain('Tu correo todavía no aparece verificado')
  })

  test('a page that opens already verified announces nothing and takes no focus', async () => {
    const { container } = await mount({ resultado: 'guia', verified: true })
    expect(giftHeading(container).textContent).toBe(READY)
    expect(announcement(container)).toBeNull()
    expect(document.activeElement).not.toBe(giftHeading(container))
  })

  test('the resend notice does not stay on the ready card', async () => {
    const { container } = await mount({ resultado: 'guia' })
    await click(byText(container, 'button', 'Reenviar el correo'))
    expect(liveRegion(container).textContent).toContain('Listo, te lo reenviamos.')
    await click(byText(container, 'button', 'Ya lo verifiqué'))
    expect(giftHeading(container).textContent).toBe(READY)
    expect(liveRegion(container).textContent).not.toContain('Listo, te lo reenviamos.')
  })
})

describe('one heading per idea (end-to-end note a)', () => {
  test('verified without a result: «Tu guía gratis te espera», then the card «Ya es tuya»', async () => {
    const { container } = await mount({ verified: true })
    expect(headings(container)).toEqual(['Tu guía gratis te espera', 'Ya es tuya'])
    expect(container.textContent).not.toContain(READY)
    expect(byText(container, 'a', 'Leer mi guía')).toBeTruthy()
  })

  test('verified with a result: the card keeps «Tu guía gratis está lista», no heading repeats', async () => {
    const { container } = await mount({ resultado: 'limites', verified: true })
    const all = headings(container)
    expect(all).toEqual(['Lo tuyo son los límites, y se aprenden.', READY])
    expect(new Set(all).size).toBe(all.length)
  })

  test('the other states keep the page heading and their own card heading', async () => {
    const { container } = await mount()
    expect(headings(container)).toEqual(['Tu guía gratis te espera', 'Activa tu cuenta para leer tu guía'])
  })
})

describe('the letters line (end-to-end note b)', () => {
  test('subscribe/me answers 200: one request with the origin, remembered, and the line shows', async () => {
    const { container } = await mount({ verified: true })
    expect(subscribeCalls()).toHaveLength(1)
    expect(subscribeCalls()[0].method).toBe('POST')
    expect(subscribeCalls()[0].body).toEqual({ source: 'test', page: '/regalo' })
    expect(domWindow.localStorage.getItem(SUBSCRIBED)).not.toBeNull()
    expect(liveRegion(container).textContent).toContain(JOINED)
  })

  test('already remembered in this browser: no request, the line is there from the start', async () => {
    domWindow.localStorage.setItem(SUBSCRIBED, '1')
    const { container } = await mount({ verified: true })
    expect(subscribeCalls()).toHaveLength(0)
    expect(liveRegion(container).textContent).toContain(JOINED)
  })

  test('a rate limit (or any error): no line and nothing remembered', async () => {
    subscribeStatus = 429
    const { container } = await mount({ verified: true })
    expect(subscribeCalls()).toHaveLength(1)
    expect(domWindow.localStorage.getItem(SUBSCRIBED)).toBeNull()
    expect(container.textContent).not.toContain(JOINED)
  })

  test('not verified yet: no request and no line', async () => {
    const { container } = await mount()
    expect(subscribeCalls()).toHaveLength(0)
    expect(container.textContent).not.toContain(JOINED)
  })

  test('after «Ya lo verifiqué» she joins once and the ready card says so', async () => {
    const { container } = await mount({ resultado: 'guia' })
    await click(byText(container, 'button', 'Ya lo verifiqué'))
    expect(subscribeCalls()).toHaveLength(1)
    expect(liveRegion(container).textContent).toContain(JOINED)
    expect(liveRegion(container).textContent).toContain(READY)
  })

  test('another origin is its own subscription', async () => {
    domWindow.localStorage.setItem(subscribedKey(1, USER, 'ventana-web'), '1')
    const { container } = await mount({ verified: true })
    expect(subscribeCalls()).toHaveLength(1)
    expect(liveRegion(container).textContent).toContain(JOINED)
  })
})

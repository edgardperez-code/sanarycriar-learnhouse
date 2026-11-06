// Sanar y Criar: the sign-up forms ask a mother for her email, name and
// password only (client request 2026-11-05): no «Nombre de usuario» and no
// «Biografía». The open and the invite form are mounted in a DOM (happy-dom),
// with the real Spanish copy, and submitted:
//  - their fields are email, first and last name, password and the org's own
//    signup fields; there is no username or bio input;
//  - the body posted to /api/signup carries no username or bio (the API
//    generates the username); a /regalo sign-up still sends its return_path
//    and goes back to /regalo;
//  - the "signup submitted" analytics event no longer carries has_bio;
//  - «Nombre» is required (the platform greets her by it): empty or only
//    spaces, nothing is sent and «Obligatorio» shows beside it; it is sent
//    trimmed. «Apellido» stays optional.
// All fixtures are synthetic.
import { afterEach, describe, expect, mock, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { Window } from 'happy-dom'

const webRoot = path.resolve(import.meta.dirname, '..')

const domWindow = new Window({ url: 'http://localhost/signup' })
for (const key of [
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLFormElement',
  'HTMLButtonElement',
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
  'InputEvent',
  'SubmitEvent',
  'KeyboardEvent',
  'MouseEvent',
  'FocusEvent',
]) {
  if (domWindow[key] !== undefined && globalThis[key] === undefined) globalThis[key] = domWindow[key]
}
globalThis.window = domWindow
// The updates below run inside act().
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// The App Router is not mounted here: record where the form navigates.
const replaced = []
mock.module('next/navigation', () => ({
  useRouter: () => ({
    replace: (href) => replaced.push(href),
    push: () => {},
    refresh: () => {},
    back: () => {},
    prefetch: () => {},
  }),
  usePathname: () => domWindow.location.pathname,
  useSearchParams: () => new URLSearchParams(domWindow.location.search),
}))

// Analytics without PostHog: record what the form tracks.
const { AnalyticsEvent } = await import('../services/analytics/events.ts')
const tracked = []
mock.module('@services/analytics', () => ({
  AnalyticsEvent,
  useLHAnalytics: () => ({ track: (event, props) => tracked.push({ event, props }) }),
  useTrackView: () => {},
  useStandardProps: () => ({}),
}))

// Every request is recorded; the sign-up gateway answers like the backend.
const requests = []
globalThis.fetch = async (url, init = {}) => {
  requests.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null })
  return new Response(JSON.stringify({ id: 9, username: 'mariapena123456', email_verified: false }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

// The real Spanish copy, so the labels are the ones the client reads.
const es = JSON.parse(fs.readFileSync(path.join(webRoot, 'locales/es.json'), 'utf8'))
const { default: i18next } = await import('i18next')
const { initReactI18next } = await import('react-i18next')
await i18next.use(initReactI18next).init({
  lng: 'es',
  resources: { es: { common: es } },
  ns: ['common'],
  defaultNS: 'common',
  interpolation: { escapeValue: false },
})

const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { default: OpenSignUp } = await import('../app/auth/signup/OpenSignup.tsx')
const { default: InviteOnlySignUp } = await import('../app/auth/signup/InviteOnlySignUp.tsx')
const { regaloPathFrom } = await import('../components/SanarYCriar/regalo.ts')

const { act } = React

// An org that takes password sign-ups and declares one required signup field.
const ORG = {
  id: 1,
  slug: 'sanarycriar',
  config: {
    config: {
      config_version: '2.0',
      admin_toggles: { security: { allowed_auth_methods: ['password'] } },
      customization: {
        signup_fields: {
          fields: [{ key: 'pais', label: 'País', type: 'text', required: true, enabled: true, order: 0 }],
        },
      },
    },
  },
}
const FIELDS = ['custom_fields.pais', 'email', 'first_name', 'last_name', 'password']
const GIFT = '/regalo?resultado=guia&origen=test'

let mounted = null

/** Lets pending work (formik's validation, the fetch) finish inside act(). */
async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function mount(element) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(element)
  })
  await settle()
  mounted = { root, container }
  return container
}

const fieldNames = (container) =>
  [...container.querySelectorAll('input, textarea, select')].map((el) => el.getAttribute('name')).sort()
const labels = (container) => [...container.querySelectorAll('label')].map((el) => el.textContent.trim())
const field = (container, name) => container.querySelector(`[name="${name}"]`)

/** Types into a React-controlled field the way a browser does. */
async function type(container, name, value) {
  const el = field(container, name)
  expect(el).toBeTruthy()
  const proto = el.tagName === 'TEXTAREA' ? domWindow.HTMLTextAreaElement.prototype : domWindow.HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    el.dispatchEvent(new domWindow.Event('input', { bubbles: true }))
  })
}

const FILLED = {
  email: 'maria@example.com',
  first_name: 'María',
  last_name: 'Peña',
  password: 'Password123!',
  'custom_fields.pais': 'Venezuela',
}

async function submit(container, submitText) {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === submitText)
  expect(button).toBeTruthy()
  expect(button.disabled).toBe(false)
  await act(async () => {
    button.click()
  })
  await settle()
}

/** Fills every field (`overrides` replaces some values) and submits. */
async function fillAndSubmit(container, submitText, overrides = {}) {
  for (const [name, value] of Object.entries({ ...FILLED, ...overrides })) await type(container, name, value)
  await submit(container, submitText)
}

/** Leaves a field the way a browser does (React's onBlur listens to focusout). */
async function blur(container, name) {
  await act(async () => {
    field(container, name).dispatchEvent(new domWindow.FocusEvent('focusout', { bubbles: true }))
  })
  await settle()
}

/** The error shown beside a field's label, or null. */
const errorBeside = (container, labelText) => {
  const label = [...container.querySelectorAll('label')].find((el) => el.textContent.trim() === labelText)
  expect(label).toBeTruthy()
  return label.parentElement.querySelector('.text-red-500')?.textContent.trim() ?? null
}

const signupRequests = () => requests.filter((r) => r.url === '/api/signup')

afterEach(async () => {
  if (mounted) {
    const { root, container } = mounted
    await act(async () => root.unmount())
    container.remove()
    mounted = null
  }
  domWindow.history.replaceState(null, '', '/signup')
  domWindow.sessionStorage.clear()
  domWindow.localStorage.clear()
  requests.length = 0
  tracked.length = 0
  replaced.length = 0
})

describe('open sign-up form', () => {
  test('email, name, password and the org fields; no username or bio', async () => {
    const container = await mount(React.createElement(OpenSignUp, { org: ORG }))
    expect(fieldNames(container)).toEqual(FIELDS)
    expect(container.querySelector('textarea')).toBeNull()
    const shown = labels(container)
    expect(shown).toEqual(expect.arrayContaining(['Correo electrónico', 'Nombre', 'Apellido', 'Contraseña', 'País']))
    expect(shown).not.toContain('Nombre de usuario')
    expect(shown.some((l) => l.startsWith('Biografía'))).toBe(false)
    expect(container.textContent).not.toContain(es.user.bio_placeholder)
  })

  test('the body it posts has no username or bio; a /regalo sign-up keeps its return path', async () => {
    domWindow.history.replaceState(null, '', `/signup?redirect=${encodeURIComponent(GIFT)}`)
    const container = await mount(React.createElement(OpenSignUp, { org: ORG }))
    // The gift banner still says what the account is for.
    expect(container.textContent).toContain('Crea tu cuenta gratis para ver tu resultado y leer tu ebook de regalo.')

    await fillAndSubmit(container, 'Crear una cuenta')

    const sent = signupRequests()
    expect(sent).toHaveLength(1)
    expect(sent[0].method).toBe('POST')
    expect(sent[0].body).toEqual({
      org_slug: 'sanarycriar',
      org_id: 1,
      email: 'maria@example.com',
      password: 'Password123!',
      first_name: 'María',
      last_name: 'Peña',
      custom_fields: { pais: 'Venezuela' },
      turnstileToken: null,
      return_path: regaloPathFrom(GIFT),
    })
    expect(tracked.find((t) => t.event === AnalyticsEvent.SignupSubmitted)?.props).toEqual({ invite_code_present: false })
    // Straight back to the gift page, as before.
    expect(replaced).toHaveLength(1)
    expect(replaced[0]).toEndWith(regaloPathFrom(GIFT))
  })
})

describe('invite sign-up form', () => {
  test('the same fields, without username or bio', async () => {
    const container = await mount(React.createElement(InviteOnlySignUp, { inviteCode: 'CODE', org: ORG }))
    expect(fieldNames(container)).toEqual(FIELDS)
    expect(container.querySelector('textarea')).toBeNull()
    const shown = labels(container)
    expect(shown).not.toContain('Nombre de usuario')
    expect(shown.some((l) => l.startsWith('Biografía'))).toBe(false)
  })

  test('the body it posts has the invite code and no username or bio', async () => {
    const container = await mount(React.createElement(InviteOnlySignUp, { inviteCode: 'CODE', org: ORG }))

    await fillAndSubmit(container, 'Crear cuenta y unirse')

    const sent = signupRequests()
    expect(sent).toHaveLength(1)
    expect(sent[0].body).toEqual({
      org_slug: 'sanarycriar',
      org_id: 1,
      email: 'maria@example.com',
      password: 'Password123!',
      first_name: 'María',
      last_name: 'Peña',
      custom_fields: { pais: 'Venezuela' },
      turnstileToken: null,
      inviteCode: 'CODE',
    })
    expect(tracked.find((t) => t.event === AnalyticsEvent.SignupSubmitted)?.props).toEqual({ invite_code_present: true })
  })
})

// Both forms, by the text of their submit button.
const FORMS = [
  ['open', () => React.createElement(OpenSignUp, { org: ORG }), 'Crear una cuenta'],
  ['invite', () => React.createElement(InviteOnlySignUp, { inviteCode: 'CODE', org: ORG }), 'Crear cuenta y unirse'],
]

describe('«Nombre» is required', () => {
  for (const [form, element, submitText] of FORMS) {
    test(`${form} form: «Nombre» is a required field, «Apellido» is not`, async () => {
      const container = await mount(element())
      expect(field(container, 'first_name').required).toBe(true)
      expect(field(container, 'last_name').required).toBe(false)
    })

    test(`${form} form: empty, nothing is sent and «Obligatorio» shows beside it`, async () => {
      const container = await mount(element())
      await fillAndSubmit(container, submitText, { first_name: '' })
      expect(signupRequests()).toHaveLength(0)
      await blur(container, 'first_name')
      expect(errorBeside(container, 'Nombre')).toBe(es.validation.required)
      expect(errorBeside(container, 'Apellido')).toBeNull()
    })

    test(`${form} form: only spaces is no name either`, async () => {
      const container = await mount(element())
      await fillAndSubmit(container, submitText, { first_name: '   ' })
      expect(signupRequests()).toHaveLength(0)
      expect(errorBeside(container, 'Nombre')).toBe('Obligatorio')
      expect(errorBeside(container, 'Apellido')).toBeNull()
    })

    test(`${form} form: the first name is sent trimmed, «Apellido» may stay empty`, async () => {
      const container = await mount(element())
      await fillAndSubmit(container, submitText, { first_name: '  María  ', last_name: '' })
      const sent = signupRequests()
      expect(sent).toHaveLength(1)
      expect(sent[0].body.first_name).toBe('María')
      expect(sent[0].body.last_name).toBe('')
      expect(errorBeside(container, 'Nombre')).toBeNull()
    })
  }
})

// Sanar y Criar: a signed-in user sees her first name, not the username
// sign-up made up for her ("mariapena583735", services/users/sc_username.py):
//  - ownDisplayName gives the first name, else the username, never spaces;
//  - the header menu (HeaderProfileBox), mounted in a DOM (happy-dom) with a
//    stand-in session and the real Spanish copy: its button and the label of
//    its menu say «María»; an account without a first name still shows its
//    username there, as before;
//  - the other spots that showed the username as her name (the dashboard
//    menus and greeting, the AI greetings) go through ownDisplayName.
// All fixtures are synthetic.
import { afterEach, describe, expect, mock, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { Window } from 'happy-dom'

const webRoot = path.resolve(import.meta.dirname, '..')

const domWindow = new Window({ url: 'http://localhost/' })
for (const key of [
  'document',
  'navigator',
  'HTMLElement',
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
  'KeyboardEvent',
  'MouseEvent',
  'FocusEvent',
]) {
  if (domWindow[key] !== undefined && globalThis[key] === undefined) globalThis[key] = domWindow[key]
}
globalThis.window = domWindow
// The updates below run inside act().
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Analytics without PostHog.
const { AnalyticsEvent } = await import('../services/analytics/events.ts')
mock.module('@services/analytics', () => ({
  AnalyticsEvent,
  useLHAnalytics: () => ({ track: () => {} }),
  useTrackView: () => {},
  useStandardProps: () => ({}),
}))

// The avatar fetches a picture; it shows no name.
mock.module('@components/Objects/UserAvatar', () => ({ default: () => null }))

// The Radix menu opens on a pointer gesture, in a portal: render it open, in place.
const Pass = ({ children }) => React.createElement(React.Fragment, null, children)
mock.module('@components/ui/dropdown-menu', () => ({
  DropdownMenu: Pass,
  DropdownMenuTrigger: Pass,
  DropdownMenuContent: ({ children }) => React.createElement('div', { 'data-menu': 'content' }, children),
  DropdownMenuItem: Pass,
  DropdownMenuLabel: ({ children }) => React.createElement('div', { 'data-menu': 'label' }, children),
  DropdownMenuSeparator: () => null,
  DropdownMenuSub: Pass,
  DropdownMenuSubTrigger: Pass,
  DropdownMenuSubContent: Pass,
  DropdownMenuPortal: Pass,
}))

// The real Spanish copy.
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

const { createRoot } = await import('react-dom/client')
const { SessionContext } = await import('../components/Contexts/LHSessionContext.tsx')
const { OrgContext } = await import('../components/Contexts/OrgContext.tsx')
const { HeaderProfileBox } = await import('../components/Security/HeaderProfileBox.tsx')
const { ownDisplayName } = await import('../components/SanarYCriar/ownName.ts')

const { act } = React
const GENERATED = 'mariapena583735'
const ORG = { id: 1, slug: 'sanarycriar', name: 'Sanar y Criar' }

let mounted = null

/** Lets pending work (next/link's own updates) finish inside act(). */
async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** The header box for a signed-in user with these name fields. */
async function mountHeader(names) {
  const session = {
    status: 'authenticated',
    data: {
      user: { id: 9, user_uuid: 'user_maria', email: 'maria@example.com', username: GENERATED, ...names },
      roles: [],
      tokens: { access_token: 'token' },
    },
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      React.createElement(
        SessionContext.Provider,
        { value: session },
        React.createElement(
          OrgContext.Provider,
          { value: { org: ORG, isUserPartOfTheOrg: true, orgslug: ORG.slug } },
          React.createElement(HeaderProfileBox)
        )
      )
    )
  })
  await settle()
  mounted = { root, container }
  return container
}

// The name in the header button, and in the label at the top of its menu.
const buttonName = (container) => container.querySelector('button p.text-sm')?.textContent
const menuName = (container) => container.querySelector('[data-menu="label"] p.text-sm')?.textContent

afterEach(async () => {
  if (mounted) {
    const { root, container } = mounted
    await act(async () => root.unmount())
    container.remove()
    mounted = null
  }
})

describe('ownDisplayName', () => {
  test('the first name, trimmed', () => {
    expect(ownDisplayName({ first_name: 'María', last_name: 'Peña', username: GENERATED })).toBe('María')
    expect(ownDisplayName({ first_name: '  María José ', username: GENERATED })).toBe('María José')
  })

  test('the username only when there is no first name', () => {
    expect(ownDisplayName({ first_name: '', last_name: 'Peña', username: GENERATED })).toBe(GENERATED)
    expect(ownDisplayName({ first_name: '   ', username: GENERATED })).toBe(GENERATED)
    expect(ownDisplayName({ first_name: null, username: GENERATED })).toBe(GENERATED)
    expect(ownDisplayName({ username: GENERATED })).toBe(GENERATED)
  })

  test('nothing to show', () => {
    expect(ownDisplayName(null)).toBe('')
    expect(ownDisplayName(undefined)).toBe('')
    expect(ownDisplayName({})).toBe('')
    expect(ownDisplayName({ first_name: ' ', username: ' ' })).toBe('')
  })
})

describe('header menu', () => {
  test('says her first name, never the generated username', async () => {
    const container = await mountHeader({ first_name: 'María', last_name: 'Peña' })
    expect(buttonName(container)).toBe('María')
    expect(menuName(container)).toBe('María')
    expect(container.textContent).toContain('maria@example.com')
    expect(container.textContent).not.toContain(GENERATED)
  })

  test('without a first name it still shows the username', async () => {
    const container = await mountHeader({ first_name: '', last_name: '' })
    expect(buttonName(container)).toBe(GENERATED)
    expect(menuName(container)).toBe(GENERATED)
  })
})

describe('the other spots that named her', () => {
  const SPOTS = [
    'components/Security/HeaderProfileBox.tsx',
    'components/Dashboard/Menus/DashLeftMenu.tsx',
    'components/Dashboard/Menus/DashMobileMenu.tsx',
    'components/Dashboard/Home/DashboardHome.tsx',
    'components/Objects/Activities/AI/AIActivityAsk.tsx',
    'components/Objects/Editor/AI/AIEditorSidePanel.tsx',
  ]

  test.each(SPOTS)('%s names her through ownDisplayName', (file) => {
    const source = fs.readFileSync(path.join(webRoot, file), 'utf8')
    expect(source).toContain('ownDisplayName(')
    // The username is only handed to the feedback form, never shown as her name.
    const reads = source.match(/[\w={]*session\??\.data\??\.user\??\.username/g) ?? []
    expect(reads.filter((read) => !read.startsWith('userName={'))).toEqual([])
  })
})

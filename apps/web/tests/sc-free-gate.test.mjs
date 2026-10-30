// Sanar y Criar: free content needs an account with a verified email.
//  - freeGateReason picks the two blocking access reasons.
//  - the "return after verifying" memory (localStorage, 24 h TTL, sanitized).
//  - pathAfterVerify: ?redirect, then the remembered page, then /home.
//  - locales-sc/learning has the same keys and placeholders in es and en.
// All fixtures are synthetic.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const {
  freeGateReason,
  rememberReturnPath,
  takeReturnPath,
  pathAfterVerify,
  courseUuidFromPath,
  verifyErrorKey,
  RETURN_AFTER_VERIFY_KEY,
  RETURN_AFTER_VERIFY_TTL_MS,
} = await import('../components/SanarYCriar/freeAccessGate.ts')

function memoryStorage() {
  const map = new Map()
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
}

describe('freeGateReason', () => {
  test('blocking reasons only when there is no access', () => {
    expect(freeGateReason({ has_access: false, reason: 'login_required' })).toBe('login_required')
    expect(freeGateReason({ has_access: false, reason: 'verify_email' })).toBe('verify_email')
    expect(freeGateReason({ has_access: true, reason: 'verify_email' })).toBeNull()
    expect(freeGateReason({ has_access: false, reason: 'none' })).toBeNull()
    expect(freeGateReason({ has_access: true, reason: 'free' })).toBeNull()
    expect(freeGateReason({ has_access: false, reason: 'anonymous' })).toBeNull()
    expect(freeGateReason(null)).toBeNull()
    expect(freeGateReason(undefined)).toBeNull()
  })
})

describe('return path after verifying', () => {
  test('remembers and takes a course path once', () => {
    const s = memoryStorage()
    rememberReturnPath('/course/abc', 1_000, s)
    expect(JSON.parse(s.map.get(RETURN_AFTER_VERIFY_KEY))).toEqual({ path: '/course/abc', at: 1_000 })
    expect(takeReturnPath(2_000, s)).toBe('/course/abc')
    expect(takeReturnPath(3_000, s)).toBeNull()
  })

  test('expires after 24 h', () => {
    const s = memoryStorage()
    rememberReturnPath('/course/abc', 0, s)
    expect(takeReturnPath(RETURN_AFTER_VERIFY_TTL_MS + 1, s)).toBeNull()
    expect(s.map.size).toBe(0)
  })

  test('rejects external or malformed values', () => {
    const s = memoryStorage()
    rememberReturnPath('https://evil.example/x', 0, s)
    rememberReturnPath('//evil.example', 0, s)
    expect(s.map.size).toBe(0)
    s.setItem(RETURN_AFTER_VERIFY_KEY, JSON.stringify({ path: '//evil.example', at: 0 }))
    expect(takeReturnPath(1, s)).toBeNull()
    s.setItem(RETURN_AFTER_VERIFY_KEY, 'not json')
    expect(takeReturnPath(1, s)).toBeNull()
    s.setItem(RETURN_AFTER_VERIFY_KEY, JSON.stringify({ path: '/course/x', at: 'soon' }))
    expect(takeReturnPath(1, s)).toBeNull()
  })

  test('no storage is harmless', () => {
    expect(() => rememberReturnPath('/course/x', 0, null)).not.toThrow()
    expect(takeReturnPath(0, null)).toBeNull()
    const throwing = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
      removeItem: () => { throw new Error('blocked') },
    }
    expect(() => rememberReturnPath('/course/x', 0, throwing)).not.toThrow()
    expect(takeReturnPath(0, throwing)).toBeNull()
  })

  test('pathAfterVerify order', () => {
    expect(pathAfterVerify('/course/a', '/course/b')).toBe('/course/a')
    expect(pathAfterVerify(null, '/course/b')).toBe('/course/b')
    expect(pathAfterVerify('https://evil.example', '/course/b')).toBe('/course/b')
    expect(pathAfterVerify(null, null)).toBe('/home')
    expect(pathAfterVerify('//evil', '//evil')).toBe('/home')
  })
})

describe('locales-sc/learning', () => {
  const webRoot = path.resolve(import.meta.dirname, '..')
  const read = (f) => JSON.parse(fs.readFileSync(path.join(webRoot, 'locales-sc', f), 'utf8'))
  const flatten = (o, p = '') =>
    Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flatten(v, p ? `${p}.${k}` : k) : [[p ? `${p}.${k}` : k, v]]))
  const es = Object.fromEntries(flatten(read('learning.es.json')))
  const en = Object.fromEntries(flatten(read('learning.en.json')))
  const tokens = (s) => (s.match(/\{\{[^}]+\}\}/g) || []).sort()

  test('same keys and placeholders', () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort())
    for (const k of Object.keys(es)) expect(tokens(es[k])).toEqual(tokens(en[k]))
  })

  test('the contract copy is there', () => {
    expect(es['sc_learning.free_gate.login_title']).toBe('Este ebook es gratis')
    expect(es['sc_learning.free_gate.verify_title']).toBe('Verifica tu correo para descargarlo')
    expect(es['sc_learning.free_gate.verify_text']).toContain('{{email}}')
    expect(es['sc_learning.free_gate.resent']).toBe('Listo, te lo reenviamos.')
    expect(es['sc_learning.verify.signup_sent']).toBe('Te enviamos un correo para verificar tu cuenta. Ábrelo y toca el enlace.')
  })
})

describe('courseUuidFromPath', () => {
  test('takes the uuid of a course path', () => {
    expect(courseUuidFromPath('/course/abc-123')).toBe('abc-123')
    expect(courseUuidFromPath('/course/abc-123/activity/x')).toBe('abc-123')
    expect(courseUuidFromPath('/course/abc?x=1')).toBe('abc')
  })
  test('null for anything else', () => {
    expect(courseUuidFromPath('/courses')).toBe(null)
    expect(courseUuidFromPath('')).toBe(null)
    expect(courseUuidFromPath(null)).toBe(null)
    expect(courseUuidFromPath(undefined)).toBe(null)
  })
})

describe('verifyErrorKey', () => {
  test('maps statuses to Spanish copy keys, never the raw API detail', () => {
    expect(verifyErrorKey(400)).toBe('verify.error_invalid_link')
    expect(verifyErrorKey(404)).toBe('verify.error_invalid_link')
    expect(verifyErrorKey(410)).toBe('verify.error_invalid_link')
    expect(verifyErrorKey(429)).toBe('verify.error_rate_limited')
    expect(verifyErrorKey(500)).toBe('verify.error_generic')
    expect(verifyErrorKey(0)).toBe('verify.error_network')
    expect(verifyErrorKey(undefined)).toBe('verify.error_network')
  })
  test('every key exists in es and en', () => {
    for (const lang of ['es', 'en']) {
      const d = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', 'locales-sc', `learning.${lang}.json`), 'utf8'))
      for (const status of [400, 429, 500, 0]) {
        const [group, key] = verifyErrorKey(status).split('.')
        expect(typeof d.sc_learning[group][key]).toBe('string')
      }
      for (const key of ['resend_rate_limited', 'check_error']) expect(typeof d.sc_learning.free_gate[key]).toBe('string')
      expect(typeof d.sc_learning.verify.success_message_home).toBe('string')
    }
  })
})

// Sanar y Criar: simple password rule (6+ characters, a letter, a number),
// shared by sign-up, invite sign-up, reset and the strength indicator.
//  - the rule itself, accents and ñ count as letters.
//  - every locale has the labels the indicator shows, and none still says 8.
//  - the login and account forms use the same minimum.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const { MIN_PASSWORD_LENGTH, PASSWORD_RULES, passwordErrors } = await import('../components/SanarYCriar/passwordRules.ts')

const root = path.join(import.meta.dir, '..')

describe('passwordErrors', () => {
  test('accepts letters and numbers from 6 characters', () => {
    for (const pwd of ['hilda1', 'abc123', '123abc', 'Mamá2025', 'niño12', 'Strong1!']) {
      expect(passwordErrors(pwd)).toEqual([])
    }
  })

  test('names each missing requirement', () => {
    expect(passwordErrors('!!!')).toEqual([
      'Password must be at least 6 characters',
      'Password must contain at least one letter',
      'Password must contain at least one number',
    ])
    expect(passwordErrors('ab12')).toEqual(['Password must be at least 6 characters'])
    expect(passwordErrors('123456')).toEqual(['Password must contain at least one letter'])
    expect(passwordErrors('abcdef')).toEqual(['Password must contain at least one number'])
    expect(passwordErrors(undefined)).toHaveLength(3)
  })

  test('minimum is 6', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(6)
  })
})

describe('locales', () => {
  const files = fs.readdirSync(path.join(root, 'locales')).filter((f) => f.endsWith('.json'))
  for (const file of files) {
    test(file, () => {
      const json = JSON.parse(fs.readFileSync(path.join(root, 'locales', file), 'utf8'))
      for (const rule of PASSWORD_RULES) {
        const [ns, key] = rule.labelKey.split('.')
        expect(typeof json[ns][key]).toBe('string')
        expect(json[ns][key].length).toBeGreaterThan(0)
      }
      expect(json.auth.password_req_min_length).not.toMatch(/8|৮|۸/)
      expect(json.validation.password_min_length).not.toMatch(/8|৮|۸/)
    })
  }
})

describe('forms use the shared minimum', () => {
  test('login and account security', () => {
    for (const rel of ['app/auth/login/login.tsx', 'components/Objects/Account/subpages/AccountSecurity.tsx']) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8')
      expect(src).toContain('MIN_PASSWORD_LENGTH')
      expect(src).not.toMatch(/length < 8|\.min\(8/)
    }
  })
})

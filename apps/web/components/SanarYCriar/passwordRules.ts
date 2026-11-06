// Sanar y Criar (2026-11): simple password rule, requested by the client so
// mothers can sign up from the phone without friction. At least 6 characters
// with at least one letter (any alphabet, accents and ñ included) and one
// number. Mirrors apps/api/src/services/security/password_validation.py; the
// API enforces it on sign-up, reset, change and admin-created users.

export const MIN_PASSWORD_LENGTH = 6

export type PasswordRuleId = 'minLength' | 'letter' | 'number'

export const PASSWORD_RULES: ReadonlyArray<{ id: PasswordRuleId; labelKey: string; test: (password: string) => boolean }> = [
  { id: 'minLength', labelKey: 'auth.password_req_min_length', test: (pwd) => pwd.length >= MIN_PASSWORD_LENGTH },
  { id: 'letter', labelKey: 'auth.password_req_letter', test: (pwd) => /\p{L}/u.test(pwd) },
  { id: 'number', labelKey: 'auth.password_req_number', test: (pwd) => /[0-9]/.test(pwd) },
]

const RULE_ERRORS: Record<PasswordRuleId, string> = {
  minLength: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
  letter: 'Password must contain at least one letter',
  number: 'Password must contain at least one number',
}

export function passwordErrors(password: string): string[] {
  const value = password ?? ''
  return PASSWORD_RULES.filter((rule) => !rule.test(value)).map((rule) => RULE_ERRORS[rule.id])
}

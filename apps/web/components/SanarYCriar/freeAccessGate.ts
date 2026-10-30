// Sanar y Criar: free content needs an account with a verified email
// (contract "gratis-verificado"). GET /payments/{org}/access answers
// reason "login_required" (anonymous) or "verify_email" (unverified account)
// for free courses/ebooks; the course page then shows a sign-up / verify card
// instead of the reading or start buttons.
//
// The verification email link carries no ?redirect, so the page that showed
// the card remembers itself here and /verify-email sends the reader back.
import { safeRedirectPath } from '@components/Payments/commerce'

export type FreeGateReason = 'login_required' | 'verify_email'

/** The access reasons that block free content until the visitor signs up or verifies. */
export function freeGateReason(access: { has_access?: boolean; reason?: string } | null | undefined): FreeGateReason | null {
  if (!access || access.has_access) return null
  return access.reason === 'login_required' || access.reason === 'verify_email' ? access.reason : null
}

export const RETURN_AFTER_VERIFY_KEY = 'sanarycriar:volver-tras-verificar'
export const RETURN_AFTER_VERIFY_TTL_MS = 24 * 60 * 60 * 1000

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function defaultStorage(): KV | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

/** Remembers `path` (same-origin only) as the place to return to after verifying. */
export function rememberReturnPath(path: string | null | undefined, now = Date.now(), storage: KV | null = defaultStorage()): void {
  const safe = safeRedirectPath(path)
  if (!safe || !storage) return
  try {
    storage.setItem(RETURN_AFTER_VERIFY_KEY, JSON.stringify({ path: safe, at: now }))
  } catch {
    /* storage full or blocked: the reader just lands on /home */
  }
}

/** The remembered path if still fresh (and sanitized), else null. Clears it either way. */
export function takeReturnPath(now = Date.now(), storage: KV | null = defaultStorage()): string | null {
  if (!storage) return null
  let raw: string | null = null
  try {
    raw = storage.getItem(RETURN_AFTER_VERIFY_KEY)
    storage.removeItem(RETURN_AFTER_VERIFY_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    const at = Number(value?.at)
    if (!Number.isFinite(at) || at > now + 60_000 || now - at > RETURN_AFTER_VERIFY_TTL_MS) return null
    return safeRedirectPath(typeof value?.path === 'string' ? value.path : null)
  } catch {
    return null
  }
}

/**
 * Where /verify-email goes once the email is verified: the page's own
 * ?redirect first, then the remembered path, else /home.
 */
export function pathAfterVerify(redirectParam: string | null | undefined, remembered: string | null | undefined): string {
  return safeRedirectPath(redirectParam) ?? safeRedirectPath(remembered) ?? '/home'
}

/** "/course/<uuid>" (FreeAccessCard's coursePath) -> "<uuid>", or null. */
export function courseUuidFromPath(coursePath: string | null | undefined): string | null {
  const m = /^\/course\/([^/?#]+)/.exec(coursePath ?? '')
  return m ? m[1] : null
}

export type VerifyErrorKey = 'verify.error_invalid_link' | 'verify.error_rate_limited' | 'verify.error_generic' | 'verify.error_network'

/**
 * Spanish copy for a failed POST /auth/verify-email instead of the API's raw
 * English detail: 400/404/410 = bad, used or expired link; 429 = too many
 * attempts; status 0 (no response) = network; anything else = generic.
 */
export function verifyErrorKey(status: number | undefined): VerifyErrorKey {
  if (!status) return 'verify.error_network'
  if (status === 429) return 'verify.error_rate_limited'
  if (status === 400 || status === 404 || status === 410) return 'verify.error_invalid_link'
  return 'verify.error_generic'
}

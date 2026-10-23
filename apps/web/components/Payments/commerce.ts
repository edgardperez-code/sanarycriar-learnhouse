// Sanar y Criar: small shared helpers for the commerce UI (no React).
import type { ScTranslate } from './useScT'
import { getCourseThumbnailMediaDirectory } from '@services/media/media'
import { safeImageSrc, safeInternalPath } from '@services/security/url'

// ---------------------------------------------------------------------------
// Resources and product types
// ---------------------------------------------------------------------------

export type ProductType = 'course' | 'ebook'

export function normalizeProductType(value: unknown): ProductType {
  return value === 'ebook' ? 'ebook' : 'course'
}

/** "course_abc" | "abc" -> "abc" (the form used in /course/<uuid> URLs). */
export function stripCoursePrefix(uuid: string | null | undefined): string {
  return (uuid ?? '').replace(/^course_/, '')
}

/** "abc" | "course_abc" -> "course_abc" (the form the payments API keys resources by). */
export function toCourseResourceUuid(uuid: string | null | undefined): string | null {
  const clean = stripCoursePrefix(uuid)
  return clean ? `course_${clean}` : null
}

export function productTypeOfCourse(course: any): ProductType {
  return normalizeProductType(course?.extra_metadata?.product_type)
}

/** Thumbnail of an offer's included resource: absolute thumbnail_url first. */
export function resourceThumbnail(
  r: { thumbnail_url?: string | null; thumbnail_image?: string; resource_type?: string; org_uuid?: string; resource_uuid: string },
  orgUuid?: string
): string | null {
  const src = r.thumbnail_url
    ? r.thumbnail_url
    : r.thumbnail_image && r.resource_type === 'course'
      ? getCourseThumbnailMediaDirectory(r.org_uuid || orgUuid || '', r.resource_uuid, r.thumbnail_image)
      : null
  // API-supplied URL: only http(s), blob and raster data URLs survive.
  return safeImageSrc(src) ?? null
}

/** CSS `url(...)` with the URL quoted, so a ")" or space in it cannot break out. */
export function cssUrl(src: string): string {
  return `url(${JSON.stringify(src)})`
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export function providerLabel(provider: string | null | undefined, sc: ScTranslate): string {
  switch ((provider ?? '').toLowerCase()) {
    case 'paypal':
      return sc('providers.paypal')
    case 'spidi':
      return sc('providers.spidi')
    case 'manual':
    case 'custom':
      return sc('providers.manual')
    case '':
      return ''
    default:
      return provider as string
  }
}

/** Link to the provider's merchant dashboard, or null when there is none. */
export function providerDashboardUrl(provider: string | null | undefined, environment?: string | null): string | null {
  if ((provider ?? '').toLowerCase() !== 'paypal') return null
  return environment === 'live'
    ? 'https://www.paypal.com/myaccount/activities/'
    : 'https://www.sandbox.paypal.com/myaccount/activities/'
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function errorDetailObject(data: any): Record<string, any> | null {
  let detail = data?.detail ?? data
  if (typeof detail === 'string') {
    try {
      detail = JSON.parse(detail)
    } catch {
      return null
    }
  }
  return detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : null
}

/** Extracts a machine code from a FastAPI `detail` (object or JSON string). */
export function errorCode(data: any): string | null {
  const detail = errorDetailObject(data)
  return detail && typeof detail.code === 'string' ? detail.code : null
}

/** A string field of a structured `detail`, e.g. the order_uuid of PAYMENT_PENDING. */
export function errorField(data: any, field: string): string | null {
  const value = errorDetailObject(data)?.[field]
  return typeof value === 'string' && value ? value : null
}

const KNOWN_CODES: Record<string, string> = {
  ALREADY_OWNED: 'errors.already_owned',
  PAYMENT_PENDING: 'errors.payment_pending',
  STORE_TEST_MODE: 'errors.store_test_mode',
  PAYMENT_REQUIRED: 'errors.payment_required',
  INSTRUMENT_DECLINED: 'errors.instrument_declined',
}

/**
 * Human message for a failed payments call. Prefers a translated message for
 * known codes, then the backend's own wording, then a generic fallback.
 */
export function describePaymentError(data: any, sc: ScTranslate, fallbackKey = 'errors.generic'): string {
  const code = errorCode(data)
  if (code && KNOWN_CODES[code]) return sc(KNOWN_CODES[code])

  const detail = data?.detail
  if (typeof detail === 'string' && detail.trim() && !detail.trim().startsWith('{')) return detail
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    if (typeof detail.message === 'string' && detail.message.trim()) return detail.message
    if (typeof detail.detail === 'string' && detail.detail.trim()) return detail.detail
  }
  if (Array.isArray(detail)) {
    const msgs = detail.map((e: any) => e?.msg).filter(Boolean)
    if (msgs.length) return msgs.join(', ')
  }
  return sc(fallbackKey)
}

// ---------------------------------------------------------------------------
// Auth redirects (signup/login that come back to where the buyer was)
// ---------------------------------------------------------------------------

/**
 * Only same-origin, root-relative paths survive. Uses the shared guard, which
 * also rejects tabs, newlines and other control characters: browsers strip
 * those while parsing, so "/<TAB>/evil.com" would otherwise become "//evil.com".
 */
export function safeRedirectPath(raw: string | null | undefined): string | null {
  if (!raw) return null
  const safe = safeInternalPath(raw, '')
  return safe && safe.startsWith('/') ? safe : null
}

/** "/signup" + "/store/offers/x" -> "/signup?redirect=%2Fstore%2Foffers%2Fx". */
export function withRedirect(path: string, redirect: string | null | undefined): string {
  const safe = safeRedirectPath(redirect)
  if (!safe) return path
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}redirect=${encodeURIComponent(safe)}`
}

/** Reads ?redirect / ?next from a query string, sanitized. */
export function redirectFromSearch(search: string | URLSearchParams | null | undefined): string | null {
  if (!search) return null
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  return safeRedirectPath(params.get('redirect') ?? params.get('next'))
}

// ---------------------------------------------------------------------------
// Checkout return URL
// ---------------------------------------------------------------------------

// Params we (or PayPal) add to the offer URL on the way back. They must not
// leak into the next checkout's redirect_uri.
export const CHECKOUT_RETURN_PARAMS = ['checkout', 'order', 'token', 'PayerID', 'paymentId', 'ba_token']

export function cleanCheckoutUrl(href: string): string {
  try {
    const url = new URL(href)
    CHECKOUT_RETURN_PARAMS.forEach((p) => url.searchParams.delete(p))
    url.hash = ''
    return url.toString()
  } catch {
    return href
  }
}

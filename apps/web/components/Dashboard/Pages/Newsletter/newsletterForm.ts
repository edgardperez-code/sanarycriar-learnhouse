// Sanar y Criar: pure helpers for the newsletter dashboard (no React, no path
// aliases) so tests/sc-newsletter.test.mjs can import them directly.
//
// The limits mirror LIMITS in apps/api/src/services/newsletter/settings.py.
// The API cleans the texts (control characters, repeated spaces) before it
// checks them, so a draft that passes here can only be shorter there.

export const NEWSLETTER_LIMITS = {
  title: 120,
  body: 500,
  button_label: 40,
  dismiss_label: 40,
  success_message: 300,
  privacy_note: 300,
  delay_seconds: { min: 0, max: 120 },
  dismiss_days: { min: 1, max: 365 },
} as const

export type NewsletterSettingsDraft = {
  enabled: boolean
  title: string
  body: string
  button_label: string
  dismiss_label: string
  success_message: string
  privacy_note: string
  delay_seconds: number
  dismiss_days: number
}

export type NewsletterFieldError = {
  field: keyof NewsletterSettingsDraft
  code: 'required' | 'too_long' | 'range'
}

/** GET/PUT /newsletter/{org_id}/settings */
export type NewsletterAdminSettings = NewsletterSettingsDraft & {
  updated_at: string | null
  resend_enabled: boolean
  defaults: NewsletterSettingsDraft
}

export type NewsletterSyncStatus = 'synced' | 'pending' | 'error' | 'skipped'
export type NewsletterSource = 'popup' | 'footer' | 'other'

export type NewsletterSubscriber = {
  id: number
  email: string
  source: NewsletterSource | string
  page_path: string | null
  sync_status: NewsletterSyncStatus | string
  sync_error: string | null
  created_at: string
  synced_at: string | null
}

/** GET /newsletter/{org_id}/subscribers */
export type NewsletterSubscriberPage = {
  items: NewsletterSubscriber[]
  total: number
  page: number
  limit: number
  summary: { all: number; unsynced: number }
}

/** POST /newsletter/{org_id}/subscribers/sync */
export type NewsletterSyncResult = {
  resend_enabled: boolean
  synced: number
  failed: number
  remaining: number
}

const TEXT_FIELDS = [
  'title',
  'body',
  'button_label',
  'dismiss_label',
  'success_message',
  'privacy_note',
] as const

export type NewsletterTextField = (typeof TEXT_FIELDS)[number]

const OPTIONAL_TEXT: ReadonlySet<string> = new Set(['privacy_note'])

const NUMBER_FIELDS = ['delay_seconds', 'dismiss_days'] as const

const DRAFT_KEYS: (keyof NewsletterSettingsDraft)[] = ['enabled', ...TEXT_FIELDS, ...NUMBER_FIELDS]

/**
 * Length in characters (code points), like Python's len() on the API side, so
 * an emoji counts once instead of twice.
 */
export function textLength(value: string): number {
  return Array.from(value ?? '').length
}

/**
 * Field errors for a draft, in form order. Texts are trimmed first;
 * privacy_note may be empty; the two numbers must be integers in range.
 */
export function validateNewsletterSettings(d: NewsletterSettingsDraft): NewsletterFieldError[] {
  const errors: NewsletterFieldError[] = []
  for (const field of TEXT_FIELDS) {
    const value = typeof d[field] === 'string' ? d[field].trim() : ''
    if (!value && !OPTIONAL_TEXT.has(field)) errors.push({ field, code: 'required' })
    else if (textLength(value) > NEWSLETTER_LIMITS[field]) errors.push({ field, code: 'too_long' })
  }
  for (const field of NUMBER_FIELDS) {
    const value = d[field]
    const { min, max } = NEWSLETTER_LIMITS[field]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      errors.push({ field, code: 'range' })
    }
  }
  return errors
}

/** True when any of the nine settings differs (NaN equals NaN). */
export function isSettingsDirty(a: NewsletterSettingsDraft, b: NewsletterSettingsDraft): boolean {
  return DRAFT_KEYS.some((key) => !Object.is(a[key], b[key]))
}

/** Picks the nine editable settings out of an API payload. */
export function draftFromSettings(s: NewsletterSettingsDraft): NewsletterSettingsDraft {
  return {
    enabled: s.enabled === true,
    title: s.title ?? '',
    body: s.body ?? '',
    button_label: s.button_label ?? '',
    dismiss_label: s.dismiss_label ?? '',
    success_message: s.success_message ?? '',
    privacy_note: s.privacy_note ?? '',
    delay_seconds: Number(s.delay_seconds),
    dismiss_days: Number(s.dismiss_days),
  }
}

/** What the PUT sends: the draft with every text trimmed. */
export function settingsPayload(d: NewsletterSettingsDraft): NewsletterSettingsDraft {
  return {
    ...d,
    title: d.title.trim(),
    body: d.body.trim(),
    button_label: d.button_label.trim(),
    dismiss_label: d.dismiss_label.trim(),
    success_message: d.success_message.trim(),
    privacy_note: d.privacy_note.trim(),
  }
}

export function totalPages(total: number, limit: number): number {
  if (!(limit > 0)) return 1
  return Math.max(1, Math.ceil(total / limit))
}

/** 'suscriptores-boletin-YYYYMMDD.csv', with the local date. */
export function exportFileName(date: Date = new Date()): string {
  const yyyy = String(date.getFullYear()).padStart(4, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `suscriptores-boletin-${yyyy}${mm}${dd}.csv`
}

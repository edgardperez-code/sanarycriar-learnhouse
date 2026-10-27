// Sanar y Criar: pure helpers for the blog dashboard (no React, no path
// aliases) so tests/sc-blog.test.mjs can import them directly.
//
// The limits mirror LIMITS / SEO_TARGETS in apps/api/src/services/blog/common.py
// (blog contract §0.2). The API cleans the texts (control characters, repeated
// spaces) before it checks them, so a draft that passes here can only be
// shorter there.

export const BLOG_LIMITS = {
  title: 120,
  slug_min: 3,
  slug: 80,
  excerpt: 300,
  summary: 800,
  key_takeaways_items: 8,
  key_takeaway: 200,
  content_md: 60000,
  content_publish_min: 200,
  faq_items: 8,
  faq_question: 200,
  faq_answer: 1200,
  meta_title: 120,
  meta_description: 300,
  keywords_items: 12,
  keyword: 60,
  cover_alt: 200,
  search: 100,
  prompt_min: 10,
  prompt: 4000,
  ai_keyword: 80,
  facts: 2000,
  instruction_min: 5,
  instruction: 2000,
} as const

/** SEO goals: only a warning in the editor (amber counters), never a block. */
export const SEO_TARGETS = {
  title: 65,
  meta_title: 60,
  meta_description: [140, 155],
  excerpt: 200,
  summary_words: [40, 70],
  key_takeaways: [3, 5],
  faq: [3, 5],
  faq_answer_words: [40, 80],
  keywords: [4, 8],
} as const

export const BLOG_KINDS = ['informativo', 'novedad', 'taller'] as const
export const BLOG_CATEGORIES = [
  'emociones',
  'limites-y-conducta',
  'sueno-y-rutinas',
  'crianza-y-familia',
  'talleres-y-novedades',
] as const
export const BLOG_STATUSES = ['draft', 'published'] as const
export const BLOG_AUDIENCES = ['familias', 'docentes', 'ambos'] as const
export const BLOG_LENGTHS = ['corto', 'medio', 'largo'] as const
export const FORMAT_ACTIONS = ['h2', 'h3', 'bold', 'italic', 'ul', 'ol', 'link', 'quote'] as const

export const DEFAULT_KIND = 'informativo'
export const DEFAULT_CATEGORY = 'crianza-y-familia'
/** News and workshops always live in this category (the AI forces it too). */
export const NEWS_CATEGORY = 'talleres-y-novedades'
export const DEFAULT_LENGTH = 'medio'
export const DEFAULT_AUDIENCE = 'familias'

/** Max cover size checked in the browser before uploading (the API says 413). */
export const MAX_COVER_BYTES = 5 * 1024 * 1024
export const COVER_ACCEPT = 'image/jpeg,image/png,image/webp'

/** The client stops polling a job that has looked active for this long. */
export const JOB_CLIENT_TIMEOUT_SECONDS = 11 * 60
export const DEFAULT_POLL_MS = 3000

export type BlogKind = (typeof BLOG_KINDS)[number]
export type BlogCategory = (typeof BLOG_CATEGORIES)[number]
export type BlogStatus = (typeof BLOG_STATUSES)[number]
export type BlogAudience = (typeof BLOG_AUDIENCES)[number]
export type BlogLength = (typeof BLOG_LENGTHS)[number]
export type FormatAction = (typeof FORMAT_ACTIONS)[number]

export type BlogFaqItem = { question: string; answer: string }

/** The editable fields: exactly what POST/PUT /posts send (PostBody). */
export type BlogPostDraft = {
  title: string
  slug: string
  kind: string
  category: string
  excerpt: string
  summary: string
  key_takeaways: string[]
  content_md: string
  faq: BlogFaqItem[]
  meta_title: string
  meta_description: string
  keywords: string[]
  cover_alt: string
}

/** GET /blog/{org_id}/config */
export type BlogConfig = {
  ai_enabled: boolean
  ai_mock: boolean
  ai_model: string | null
  ai_hourly_limit: number
  limits: Record<string, number>
  seo: Record<string, number | number[]>
}

/** Items of GET /blog/{org_id}/posts */
export type AdminPostSummary = {
  id: number
  slug: string
  title: string
  status: BlogStatus | string
  kind: BlogKind | string
  category: BlogCategory | string
  source: 'manual' | 'ai' | string
  cover_url: string | null
  word_count: number
  published_at: string | null
  created_at: string
  updated_at: string
}

export type AdminPostPage = {
  items: AdminPostSummary[]
  total: number
  page: number
  limit: number
  counts: { all: number; draft: number; published: number }
}

/** GET/POST/PUT /blog/{org_id}/posts/{id} and every action on a post. */
export type AdminPost = {
  id: number
  post_uuid: string
  slug: string
  slug_locked: boolean
  status: BlogStatus | string
  kind: BlogKind | string
  category: BlogCategory | string
  title: string
  excerpt: string
  summary: string
  key_takeaways: string[]
  content_md: string
  content_html: string
  faq: BlogFaqItem[]
  meta_title: string
  meta_description: string
  keywords: string[]
  cover_url: string | null
  og_image_url: string | null
  cover_alt: string
  word_count: number
  reading_minutes: number
  source: 'manual' | 'ai' | string
  ai_model: string | null
  public_path: string
  published_at: string | null
  created_at: string
  updated_at: string
}

/** The article the AI returns (a revision of a published post comes back in Job.result). */
export type GeneratedArticle = {
  category: string
  title: string
  slug: string
  meta_title: string
  meta_description: string
  excerpt: string
  summary: string
  key_takeaways: string[]
  content_md: string
  faq: BlogFaqItem[]
  keywords: string[]
}

export type BlogJobStatus = 'pending' | 'running' | 'done' | 'error'

export type BlogJob = {
  id: number
  operation: 'generate' | 'revise' | string
  status: BlogJobStatus | string
  post_id: number | null
  applied: boolean
  result: GeneratedArticle | null
  error: string | null
  model: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  elapsed_seconds: number
  poll_after_ms: number
}

/** POST /blog/{org_id}/ai/generate */
export type GenerateBody = {
  prompt: string
  kind: string
  audience: string
  length: string
  keyword: string
  facts: string
}

/** POST /blog/{org_id}/preview */
export type PreviewResult = { content_html: string; word_count: number }

export type DraftErrorCode =
  | 'required'
  | 'too_long'
  | 'slug_invalid'
  | 'too_many'
  | 'faq_incomplete'
  | 'publish_excerpt'
  | 'publish_content'

export type DraftError = {
  field: keyof BlogPostDraft
  code: DraftErrorCode
  max?: number
  min?: number
  /** Item of a list field (key_takeaways, keywords, faq) the error belongs to. */
  index?: number
  /** For faq items: which half is wrong. */
  part?: 'question' | 'answer'
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Contract §0.3, identical to slugify() in the API. */
export function slugify(text: string): string {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, BLOG_LIMITS.slug)
    .replace(/-+$/, '')
}

/**
 * What the slug input keeps while she types: like slugify() but a trailing
 * hyphen survives, so "mi-" can become "mi-articulo". slugify() runs on blur.
 */
export function slugInput(text: string): string {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, BLOG_LIMITS.slug)
}

export function isValidSlug(slug: string): boolean {
  const len = (slug ?? '').length
  return len >= BLOG_LIMITS.slug_min && len <= BLOG_LIMITS.slug && SLUG_RE.test(slug)
}

/** What the API uses when the title gives fewer than 3 valid characters. */
export const FALLBACK_SLUG = 'articulo'

/**
 * The slug the API derives from the title when a new post is saved with an
 * empty slug (shown only as a hint: the API adds -2, -3... if it is taken).
 */
export function suggestedSlug(title: string): string {
  const slug = slugify(title)
  return isValidSlug(slug) ? slug : FALLBACK_SLUG
}

/**
 * Length in characters (code points), like Python's len() on the API side, so
 * an emoji counts once instead of twice.
 */
export function textLength(value: string): number {
  return Array.from(value ?? '').length
}

/** Words like the API's word_count: runs of letters, digits and underscores. */
export function countWords(value: string): number {
  return (String(value ?? '').match(/[\p{L}\p{N}_]+/gu) || []).length
}

/** Rough word count of Markdown: link targets and syntax do not count. */
export function markdownWordCount(md: string): number {
  const text = String(md ?? '')
    .replace(/\]\([^)\s]*(?:\s+"[^"]*")?\)/g, ']')
    .replace(/<https?:\/\/[^>\s]+>/g, ' ')
  return countWords(text)
}

/**
 * The draft with one field changed. News and workshops move to their own
 * category (she can still change it). The slug never follows the title: a new
 * post saved with an empty slug gets a free one from the API (a repeated or
 * very short title is fine), and a typed slug is sent as she wrote it.
 */
export function editDraft<K extends keyof BlogPostDraft>(
  draft: BlogPostDraft,
  field: K,
  value: BlogPostDraft[K]
): BlogPostDraft {
  const next: BlogPostDraft = { ...draft, [field]: value }
  if (field === 'kind' && (value === 'novedad' || value === 'taller')) next.category = NEWS_CATEGORY
  return next
}

export function emptyDraft(): BlogPostDraft {
  return {
    title: '',
    slug: '',
    kind: DEFAULT_KIND,
    category: DEFAULT_CATEGORY,
    excerpt: '',
    summary: '',
    key_takeaways: [],
    content_md: '',
    faq: [],
    meta_title: '',
    meta_description: '',
    keywords: [],
    cover_alt: '',
  }
}

const strList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v : '')) : []

const faqList = (value: unknown): BlogFaqItem[] =>
  Array.isArray(value)
    ? value.map((item: any) => ({
        question: typeof item?.question === 'string' ? item.question : '',
        answer: typeof item?.answer === 'string' ? item.answer : '',
      }))
    : []

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Picks the editable fields out of an AdminPost. */
export function draftFromPost(post: Partial<AdminPost> | null | undefined): BlogPostDraft {
  const p: any = post ?? {}
  return {
    title: str(p.title),
    slug: str(p.slug),
    kind: str(p.kind) || DEFAULT_KIND,
    category: str(p.category) || DEFAULT_CATEGORY,
    excerpt: str(p.excerpt),
    summary: str(p.summary),
    key_takeaways: strList(p.key_takeaways),
    content_md: str(p.content_md),
    faq: faqList(p.faq),
    meta_title: str(p.meta_title),
    meta_description: str(p.meta_description),
    keywords: strList(p.keywords),
    cover_alt: str(p.cover_alt),
  }
}

// Single-line fields: line breaks become spaces and repeated spaces collapse,
// like clean_line() in the API.
const cleanLine = (value: string) =>
  String(value ?? '')
    .replace(/[\t\n\v\f\r]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()

const cleanMultiline = (value: string) =>
  String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

const cleanMarkdown = (value: string) =>
  String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+$/, '')

function cleanItems(items: string[], dedupe = false): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of items ?? []) {
    const item = cleanLine(raw)
    if (!item) continue
    if (dedupe) {
      const key = item.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
    }
    out.push(item)
  }
  return out
}

function cleanFaq(items: BlogFaqItem[]): BlogFaqItem[] {
  return (items ?? [])
    .map((item) => ({ question: cleanLine(item?.question ?? ''), answer: cleanLine(item?.answer ?? '') }))
    .filter((item) => item.question || item.answer)
}

/** What POST/PUT send: texts trimmed, empty list items and empty FAQ dropped. */
export function postPayload(d: BlogPostDraft): BlogPostDraft {
  return {
    title: cleanLine(d.title),
    slug: cleanLine(d.slug),
    kind: d.kind,
    category: d.category,
    excerpt: cleanLine(d.excerpt),
    summary: cleanMultiline(d.summary),
    key_takeaways: cleanItems(d.key_takeaways),
    content_md: cleanMarkdown(d.content_md),
    faq: cleanFaq(d.faq),
    meta_title: cleanLine(d.meta_title),
    meta_description: cleanLine(d.meta_description),
    keywords: cleanItems(d.keywords, true),
    cover_alt: cleanLine(d.cover_alt),
  }
}

export type ValidateOptions = {
  /** Publishing (or saving a published post) also needs an excerpt and 200 characters of content. */
  forPublish?: boolean
  /** POST with an empty slug is fine: the API derives it from the title. */
  allowEmptySlug?: boolean
}

/**
 * Field errors for a draft, in the API's order (contract §B.4), all of them
 * at once so the form can mark every field.
 */
export function validateDraft(d: BlogPostDraft, options: ValidateOptions = {}): DraftError[] {
  const L = BLOG_LIMITS
  const p = postPayload(d)
  const errors: DraftError[] = []
  const tooLong = (field: keyof BlogPostDraft, value: string, max: number) => {
    if (textLength(value) > max) errors.push({ field, code: 'too_long', max })
  }

  if (!p.title) errors.push({ field: 'title', code: 'required' })
  else tooLong('title', p.title, L.title)

  if (!(options.allowEmptySlug && !p.slug) && !isValidSlug(slugify(p.slug))) {
    errors.push({ field: 'slug', code: 'slug_invalid' })
  }
  if (!(BLOG_KINDS as readonly string[]).includes(p.kind)) errors.push({ field: 'kind', code: 'required' })
  if (!(BLOG_CATEGORIES as readonly string[]).includes(p.category)) {
    errors.push({ field: 'category', code: 'required' })
  }
  tooLong('excerpt', p.excerpt, L.excerpt)
  tooLong('summary', p.summary, L.summary)

  if (p.key_takeaways.length > L.key_takeaways_items) {
    errors.push({ field: 'key_takeaways', code: 'too_many', max: L.key_takeaways_items })
  }
  d.key_takeaways.forEach((raw, index) => {
    if (textLength(cleanLine(raw)) > L.key_takeaway) {
      errors.push({ field: 'key_takeaways', code: 'too_long', max: L.key_takeaway, index })
    }
  })

  tooLong('content_md', p.content_md, L.content_md)

  if (p.faq.length > L.faq_items) errors.push({ field: 'faq', code: 'too_many', max: L.faq_items })
  d.faq.forEach((raw, index) => {
    const question = cleanLine(raw?.question ?? '')
    const answer = cleanLine(raw?.answer ?? '')
    if (!question && !answer) return
    if (!question || !answer) {
      errors.push({ field: 'faq', code: 'faq_incomplete', index, part: question ? 'answer' : 'question' })
    }
    if (textLength(question) > L.faq_question) {
      errors.push({ field: 'faq', code: 'too_long', max: L.faq_question, index, part: 'question' })
    }
    if (textLength(answer) > L.faq_answer) {
      errors.push({ field: 'faq', code: 'too_long', max: L.faq_answer, index, part: 'answer' })
    }
  })

  tooLong('meta_title', p.meta_title, L.meta_title)
  tooLong('meta_description', p.meta_description, L.meta_description)

  if (p.keywords.length > L.keywords_items) {
    errors.push({ field: 'keywords', code: 'too_many', max: L.keywords_items })
  }
  d.keywords.forEach((raw, index) => {
    if (textLength(cleanLine(raw)) > L.keyword) {
      errors.push({ field: 'keywords', code: 'too_long', max: L.keyword, index })
    }
  })

  tooLong('cover_alt', p.cover_alt, L.cover_alt)

  if (options.forPublish) {
    if (!p.excerpt) errors.push({ field: 'excerpt', code: 'publish_excerpt' })
    if (textLength(p.content_md) < L.content_publish_min) {
      errors.push({ field: 'content_md', code: 'publish_content', min: L.content_publish_min })
    }
  }
  return errors
}

/** True when saving `a` would store something different from `b`. */
export function isDraftDirty(a: BlogPostDraft, b: BlogPostDraft): boolean {
  return JSON.stringify(postPayload(a)) !== JSON.stringify(postPayload(b))
}

export type FormatResult = { text: string; selStart: number; selEnd: number }

const LINE_PREFIX: Partial<Record<FormatAction, string>> = { h2: '## ', h3: '### ', ul: '- ', quote: '> ' }
const HEADING_RE = /^#{1,6}[ \t]+/
const LIST_RE = /^(?:[-*+]|\d+[.)])[ \t]+/
const QUOTE_RE = /^>[ \t]?/

function formatLines(text: string, selStart: number, selEnd: number, action: FormatAction): FormatResult {
  const lineStart = text.lastIndexOf('\n', selStart - 1) + 1
  // A selection that ends right after a line break does not include the next line.
  const endProbe = selEnd > selStart && text[selEnd - 1] === '\n' ? selEnd - 1 : selEnd
  let lineEnd = text.indexOf('\n', endProbe)
  if (lineEnd === -1) lineEnd = text.length
  if (lineEnd < lineStart) lineEnd = lineStart

  const lines = text.slice(lineStart, lineEnd).split('\n')
  const multi = lines.length > 1
  let number = 0
  const out = lines.map((line) => {
    // Blank lines inside a multi-line selection stay blank (paragraph breaks).
    if (multi && !line.trim()) return line
    let body = line.replace(HEADING_RE, '')
    if (action === 'ul' || action === 'ol') body = body.replace(LIST_RE, '')
    if (action === 'quote') body = body.replace(QUOTE_RE, '')
    if (action === 'ol') {
      number += 1
      return `${number}. ${body}`
    }
    return `${LINE_PREFIX[action]}${body}`
  })
  const block = out.join('\n')
  const next = text.slice(0, lineStart) + block + text.slice(lineEnd)
  if (selStart === selEnd || !multi) {
    // Caret at the end of the (single) formatted line, ready to keep typing.
    const end = lineStart + block.length
    return { text: next, selStart: end, selEnd: end }
  }
  return { text: next, selStart: lineStart, selEnd: lineStart + block.length }
}

function wrapInline(
  text: string,
  selStart: number,
  selEnd: number,
  marker: string,
  placeholder: string
): FormatResult {
  let start = selStart
  let end = selEnd
  // "**palabra **" is not bold in Markdown: keep edge spaces outside the markers.
  while (start < end && /\s/.test(text[start])) start += 1
  while (end > start && /\s/.test(text[end - 1])) end -= 1
  const inner = start < end ? text.slice(start, end) : placeholder
  const next = text.slice(0, start) + marker + inner + marker + text.slice(end)
  return { text: next, selStart: start + marker.length, selEnd: start + marker.length + inner.length }
}

/**
 * Applies a toolbar action to the Markdown text and returns the new text and
 * selection. Line actions (h2, h3, ul, ol, quote) prefix every selected line,
 * replacing a previous heading mark; bold/italic wrap the selection (or insert
 * a placeholder, selected); link wraps it as [text](https://) with "https://"
 * selected so she can paste the address.
 */
export function applyFormat(
  text: string,
  selStart: number,
  selEnd: number,
  action: FormatAction,
  placeholders: { text?: string; link?: string } = {}
): FormatResult {
  const value = String(text ?? '')
  const a = Math.max(0, Math.min(selStart, selEnd, value.length))
  const b = Math.max(0, Math.min(Math.max(selStart, selEnd), value.length))
  switch (action) {
    case 'bold':
      return wrapInline(value, a, b, '**', placeholders.text ?? 'texto')
    case 'italic':
      return wrapInline(value, a, b, '*', placeholders.text ?? 'texto')
    case 'link': {
      const label = a < b ? value.slice(a, b) : placeholders.link ?? 'texto del enlace'
      const url = 'https://'
      const inserted = `[${label}](${url})`
      const next = value.slice(0, a) + inserted + value.slice(b)
      const urlStart = a + label.length + 3
      return { text: next, selStart: urlStart, selEnd: urlStart + url.length }
    }
    default:
      return formatLines(value, a, b, action)
  }
}

/**
 * The single replaced range between two texts: `before.slice(start, end)`
 * became `insert`. Used to apply a toolbar change with the browser's
 * insertText command so Ctrl+Z still works.
 */
export function diffRange(before: string, after: string): { start: number; end: number; insert: string } {
  let start = 0
  const max = Math.min(before.length, after.length)
  while (start < max && before[start] === after[start]) start += 1
  let tail = 0
  while (
    tail < before.length - start &&
    tail < after.length - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1
  }
  return { start, end: before.length - tail, insert: after.slice(start, after.length - tail) }
}

export function jobIsActive(job: Pick<BlogJob, 'status'> | null | undefined): boolean {
  return !!job && (job.status === 'pending' || job.status === 'running')
}

/** Seconds a job has been running, counting the time since the last poll. */
export function jobElapsedSeconds(job: Pick<BlogJob, 'elapsed_seconds'> | null | undefined, updatedAt: number, now: number): number {
  const base = Number(job?.elapsed_seconds) || 0
  const since = updatedAt > 0 ? Math.max(0, (now - updatedAt) / 1000) : 0
  return Math.max(0, Math.floor(base + since))
}

/** "0:07", "2:35", "12:00". */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Copies an AI revision into the form; the slug (and kind, cover alt) stay. */
export function applyRevisionToDraft(draft: BlogPostDraft, result: GeneratedArticle): BlogPostDraft {
  const r: any = result ?? {}
  return {
    ...draft,
    category: (BLOG_CATEGORIES as readonly string[]).includes(r.category) ? r.category : draft.category,
    title: str(r.title) || draft.title,
    meta_title: str(r.meta_title),
    meta_description: str(r.meta_description),
    excerpt: str(r.excerpt),
    summary: str(r.summary),
    key_takeaways: strList(r.key_takeaways),
    content_md: str(r.content_md) || draft.content_md,
    faq: faqList(r.faq),
    keywords: strList(r.keywords),
  }
}

export function totalPages(total: number, limit: number): number {
  if (!(limit > 0)) return 1
  return Math.max(1, Math.ceil(total / limit))
}

export type SeoTone = 'ok' | 'warn' | 'error'

/** Counter colour: over the hard limit = error; outside the SEO goal = warn. */
export function counterTone(value: number, max: number, target?: number | readonly number[]): SeoTone {
  if (value > max) return 'error'
  if (target === undefined || value === 0) return 'ok'
  if (typeof target === 'number') return value > target ? 'warn' : 'ok'
  const [lo, hi] = target
  return value < lo || value > hi ? 'warn' : 'ok'
}

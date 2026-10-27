// Sanar y Criar: blog dashboard helpers (slug, validation, Markdown toolbar,
// dirty check, AI job helpers, pagination), plus the i18n bundles the
// dashboard falls back to. All fixtures are synthetic.

import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const {
  BLOG_LIMITS,
  SEO_TARGETS,
  BLOG_KINDS,
  BLOG_CATEGORIES,
  BLOG_STATUSES,
  BLOG_AUDIENCES,
  BLOG_LENGTHS,
  FORMAT_ACTIONS,
  slugify,
  slugInput,
  isValidSlug,
  suggestedSlug,
  editDraft,
  emptyDraft,
  draftFromPost,
  postPayload,
  validateDraft,
  isDraftDirty,
  textLength,
  countWords,
  markdownWordCount,
  applyFormat,
  diffRange,
  jobIsActive,
  jobElapsedSeconds,
  formatElapsed,
  applyRevisionToDraft,
  totalPages,
  counterTone,
} = await import('../components/Dashboard/Pages/Blog/blogForm.ts')

const LONG_CONTENT = 'Párrafo de prueba con suficiente texto. '.repeat(8)

const draft = (patch = {}) => ({
  ...emptyDraft(),
  title: 'Rabietas en la primera infancia (borrar)',
  slug: 'rabietas-primera-infancia-borrar',
  excerpt: 'Un extracto corto.',
  content_md: LONG_CONTENT,
  ...patch,
})
const codes = (d, options) => validateDraft(d, options).map((e) => `${e.field}:${e.code}${e.index !== undefined ? `#${e.index}` : ''}`)

describe('slugify (contract §0.3)', () => {
  test('the shared test cases', () => {
    expect(slugify('¿Qué hago con las rabietas?')).toBe('que-hago-con-las-rabietas')
    expect(slugify('  Niños, niñas y PANTALLAS  ')).toBe('ninos-ninas-y-pantallas')
    expect(slugify('Taller: 15/11 — Lechería')).toBe('taller-15-11-lecheria')
    expect(slugify('***')).toBe('')
    expect(isValidSlug(slugify('***'))).toBe(false)
  })

  test('cut to 80 characters without a trailing hyphen', () => {
    const slug = slugify(`${'a'.repeat(79)} bcd`)
    expect(slug).toBe('a'.repeat(79))
    expect(slugify('x'.repeat(100)).length).toBe(80)
  })

  test('validity: 3 to 80 characters of [a-z0-9] joined by single hyphens', () => {
    expect(isValidSlug('abc')).toBe(true)
    expect(isValidSlug('ab')).toBe(false)
    expect(isValidSlug('a--b')).toBe(false)
    expect(isValidSlug('-abc')).toBe(false)
    expect(isValidSlug('a'.repeat(81))).toBe(false)
  })

  test('slugInput keeps a trailing hyphen while typing', () => {
    expect(slugInput('Mi Artículo ')).toBe('mi-articulo-')
    expect(slugInput('--hola')).toBe('hola')
    expect(slugify(slugInput('Mi Artículo '))).toBe('mi-articulo')
  })
})

describe('creating: the slug comes from the API unless she types one', () => {
  const typed = (fields) => Object.entries(fields).reduce((d, [field, value]) => editDraft(d, field, value), emptyDraft())

  test('the title never fills the slug, so a short or repeated title can be saved', () => {
    for (const title of ['Yo', 'Rabietas en la primera infancia', '***']) {
      const d = typed({ title, excerpt: 'Extracto.', content_md: LONG_CONTENT })
      expect(d.slug).toBe('')
      expect(postPayload(d).slug).toBe('')
      expect(codes(d, { allowEmptySlug: true })).toEqual([])
      expect(codes(d, { allowEmptySlug: true, forPublish: true })).toEqual([])
    }
  })

  test('a typed slug is kept and still validated', () => {
    const d = typed({ title: 'Rabietas', slug: 'mi-propia-direccion' })
    expect(postPayload(d).slug).toBe('mi-propia-direccion')
    expect(codes(typed({ title: 'Rabietas', slug: 'ab' }), { allowEmptySlug: true })).toEqual(['slug:slug_invalid'])
  })

  test('suggestedSlug is the hint: what the API derives before adding -2, -3...', () => {
    expect(suggestedSlug('¿Qué hago con las rabietas?')).toBe('que-hago-con-las-rabietas')
    expect(suggestedSlug('Yo')).toBe('articulo')
    expect(suggestedSlug('***')).toBe('articulo')
  })

  test('news and workshops move to their category; other fields change alone', () => {
    const base = emptyDraft()
    expect(editDraft(base, 'kind', 'taller').category).toBe('talleres-y-novedades')
    expect(editDraft(base, 'kind', 'novedad').category).toBe('talleres-y-novedades')
    expect(editDraft(base, 'kind', 'informativo').category).toBe(base.category)
    const titled = editDraft(base, 'title', 'Hola')
    expect(titled).toEqual({ ...base, title: 'Hola' })
    expect(base.title).toBe('')
  })
})

describe('validateDraft', () => {
  test('a complete draft is valid, also for publishing', () => {
    expect(validateDraft(draft())).toEqual([])
    expect(validateDraft(draft(), { forPublish: true })).toEqual([])
  })

  test('title is required and has a hard limit of 120', () => {
    expect(codes(draft({ title: '   ' }))).toEqual(['title:required'])
    expect(codes(draft({ title: 'a'.repeat(120) }))).toEqual([])
    expect(codes(draft({ title: 'a'.repeat(121) }))).toEqual(['title:too_long'])
    // The SEO goal (65) is only a warning.
    expect(codes(draft({ title: 'a'.repeat(80) }))).toEqual([])
  })

  test('slug: invalid when it gives fewer than 3 characters; empty allowed only when creating', () => {
    expect(codes(draft({ slug: 'ab' }))).toEqual(['slug:slug_invalid'])
    expect(codes(draft({ slug: '***' }))).toEqual(['slug:slug_invalid'])
    expect(codes(draft({ slug: '' }))).toEqual(['slug:slug_invalid'])
    expect(codes(draft({ slug: '' }), { allowEmptySlug: true })).toEqual([])
    // The API slugifies what it receives, so "Mi Slug" is fine.
    expect(codes(draft({ slug: 'Mi Slug' }))).toEqual([])
  })

  test('kind and category must be known values', () => {
    expect(codes(draft({ kind: 'otro' }))).toEqual(['kind:required'])
    expect(codes(draft({ category: 'otra' }))).toEqual(['category:required'])
  })

  test('maximums of every text field', () => {
    expect(codes(draft({ excerpt: 'e'.repeat(301) }))).toEqual(['excerpt:too_long'])
    expect(codes(draft({ summary: 's'.repeat(801) }))).toEqual(['summary:too_long'])
    expect(codes(draft({ content_md: 'c'.repeat(60001) }))).toEqual(['content_md:too_long'])
    expect(codes(draft({ meta_title: 'm'.repeat(121) }))).toEqual(['meta_title:too_long'])
    expect(codes(draft({ meta_description: 'd'.repeat(301) }))).toEqual(['meta_description:too_long'])
    expect(codes(draft({ cover_alt: 'a'.repeat(201) }))).toEqual(['cover_alt:too_long'])
  })

  test('lists: item count and item length (empty items do not count)', () => {
    expect(codes(draft({ key_takeaways: Array(9).fill('idea') }))).toEqual(['key_takeaways:too_many'])
    expect(codes(draft({ key_takeaways: [...Array(8).fill('idea'), '', '  '] }))).toEqual([])
    expect(codes(draft({ key_takeaways: ['ok', 'x'.repeat(201)] }))).toEqual(['key_takeaways:too_long#1'])
    expect(codes(draft({ keywords: Array.from({ length: 13 }, (_, i) => `k${i}`) }))).toEqual(['keywords:too_many'])
    // Duplicates (ignoring case) are dropped like the API does, so they do not count.
    expect(codes(draft({ keywords: [...Array.from({ length: 12 }, (_, i) => `k${i}`), 'K0'] }))).toEqual([])
    expect(codes(draft({ keywords: ['x'.repeat(61)] }))).toEqual(['keywords:too_long#0'])
  })

  test('FAQ: incomplete pairs, lengths and count; fully empty pairs are ignored', () => {
    expect(codes(draft({ faq: [{ question: '¿Pregunta?', answer: '' }] }))).toEqual(['faq:faq_incomplete#0'])
    expect(codes(draft({ faq: [{ question: '', answer: 'Respuesta' }] }))).toEqual(['faq:faq_incomplete#0'])
    expect(codes(draft({ faq: [{ question: ' ', answer: ' ' }] }))).toEqual([])
    expect(codes(draft({ faq: [{ question: 'q'.repeat(201), answer: 'ok' }] }))).toEqual(['faq:too_long#0'])
    expect(codes(draft({ faq: [{ question: 'ok', answer: 'a'.repeat(1201) }] }))).toEqual(['faq:too_long#0'])
    expect(codes(draft({ faq: Array(9).fill({ question: 'q', answer: 'a' }) }))).toEqual(['faq:too_many'])
    const parts = validateDraft(draft({ faq: [{ question: 'ok', answer: 'a'.repeat(1201) }] })).map((e) => e.part)
    expect(parts).toEqual(['answer'])
  })

  test('publishing needs an excerpt and 200 characters of content', () => {
    expect(codes(draft({ excerpt: '' }), { forPublish: true })).toEqual(['excerpt:publish_excerpt'])
    expect(codes(draft({ content_md: 'corto' }), { forPublish: true })).toEqual(['content_md:publish_content'])
    expect(codes(draft({ content_md: 'x'.repeat(200) }), { forPublish: true })).toEqual([])
    expect(codes(draft({ excerpt: '', content_md: '' }))).toEqual([])
    const [err] = validateDraft(draft({ content_md: 'corto' }), { forPublish: true })
    expect(err.min).toBe(200)
  })

  test('errors keep the API order', () => {
    const all = codes(draft({ title: '', slug: 'a', excerpt: 'e'.repeat(301), meta_title: 'm'.repeat(121) }))
    expect(all).toEqual(['title:required', 'slug:slug_invalid', 'excerpt:too_long', 'meta_title:too_long'])
  })

  test('an emoji counts as one character, like the API', () => {
    expect(textLength('🌱')).toBe(1)
    expect(codes(draft({ title: '🌱'.repeat(120) }))).toEqual([])
  })
})

describe('postPayload / draftFromPost / isDraftDirty', () => {
  test('trims texts, drops empty items and empty FAQ pairs, dedupes keywords', () => {
    const p = postPayload(
      draft({
        title: '  Hola   mundo ',
        key_takeaways: [' uno ', '', '  '],
        keywords: ['Crianza', 'crianza', ' rabietas '],
        faq: [{ question: ' ¿Qué? ', answer: ' Esto. ' }, { question: '', answer: '' }],
        content_md: '## Hola\r\n\r\nTexto   \n\n',
        summary: 'Línea 1\r\n\r\n\r\n\r\nLínea 2  ',
      })
    )
    expect(p.title).toBe('Hola mundo')
    expect(p.key_takeaways).toEqual(['uno'])
    expect(p.keywords).toEqual(['Crianza', 'rabietas'])
    expect(p.faq).toEqual([{ question: '¿Qué?', answer: 'Esto.' }])
    expect(p.content_md).toBe('## Hola\n\nTexto')
    expect(p.summary).toBe('Línea 1\n\nLínea 2')
    expect(Object.keys(p).sort()).toEqual(Object.keys(emptyDraft()).sort())
  })

  test('draftFromPost picks the PostBody fields of an AdminPost', () => {
    const post = {
      id: 7,
      post_uuid: 'abc',
      slug: 'hola-mundo',
      slug_locked: false,
      status: 'draft',
      kind: 'taller',
      category: 'talleres-y-novedades',
      title: 'Hola',
      excerpt: 'e',
      summary: 's',
      key_takeaways: ['a'],
      content_md: '## x',
      content_html: '<h2>x</h2>',
      faq: [{ question: 'q', answer: 'a' }],
      meta_title: '',
      meta_description: '',
      keywords: ['k'],
      cover_url: null,
      cover_alt: 'alt',
      source: 'ai',
    }
    const d = draftFromPost(post)
    expect(Object.keys(d).sort()).toEqual(Object.keys(emptyDraft()).sort())
    expect(d.kind).toBe('taller')
    expect(d.cover_alt).toBe('alt')
    expect(isDraftDirty(d, draftFromPost(post))).toBe(false)
  })

  test('dirty only when saving would change something', () => {
    const base = draft()
    expect(isDraftDirty(base, draft())).toBe(false)
    expect(isDraftDirty(base, draft({ title: 'Otro título' }))).toBe(true)
    expect(isDraftDirty(base, draft({ faq: [{ question: 'q', answer: 'a' }] }))).toBe(true)
    // Trailing spaces and an empty new row are not a change.
    expect(isDraftDirty(base, draft({ title: `${base.title}  ` }))).toBe(false)
    expect(isDraftDirty(base, draft({ key_takeaways: [''] }))).toBe(false)
  })
})

describe('applyFormat (toolbar)', () => {
  const run = (text, start, end, action) => applyFormat(text, start, end, action)

  test('h2 / h3 prefix the line and replace a previous heading', () => {
    expect(run('Hola', 0, 0, 'h2')).toEqual({ text: '## Hola', selStart: 7, selEnd: 7 })
    expect(run('## Hola', 3, 3, 'h3').text).toBe('### Hola')
    expect(run('a\nTítulo\nb', 4, 4, 'h2').text).toBe('a\n## Título\nb')
    // Empty line: the prefix, with the caret after it.
    expect(run('', 0, 0, 'h3')).toEqual({ text: '### ', selStart: 4, selEnd: 4 })
  })

  test('bold / italic wrap the selection (edge spaces stay outside) or insert a placeholder', () => {
    expect(run('hola mundo', 5, 10, 'bold')).toEqual({ text: 'hola **mundo**', selStart: 7, selEnd: 12 })
    expect(run('hola mundo', 4, 10, 'bold').text).toBe('hola **mundo**')
    expect(run('hola', 4, 4, 'bold')).toEqual({ text: 'hola**texto**', selStart: 6, selEnd: 11 })
    expect(run('hola mundo', 0, 4, 'italic')).toEqual({ text: '*hola* mundo', selStart: 1, selEnd: 5 })
    expect(run('', 0, 0, 'italic')).toEqual({ text: '*texto*', selStart: 1, selEnd: 6 })
  })

  test('lists prefix every selected line, skipping blank ones; ol numbers them', () => {
    expect(run('uno\ndos', 0, 7, 'ul')).toEqual({ text: '- uno\n- dos', selStart: 0, selEnd: 11 })
    expect(run('uno\n\ndos', 0, 8, 'ul').text).toBe('- uno\n\n- dos')
    expect(run('uno\ndos\ntres', 0, 12, 'ol').text).toBe('1. uno\n2. dos\n3. tres')
    // Switching list type replaces the marker instead of stacking it.
    expect(run('- uno\n- dos', 0, 11, 'ol').text).toBe('1. uno\n2. dos')
    expect(run('## Título', 0, 0, 'ul').text).toBe('- Título')
    expect(run('', 0, 0, 'ol')).toEqual({ text: '1. ', selStart: 3, selEnd: 3 })
  })

  test('a selection ending at a line start does not take the next line', () => {
    expect(run('uno\ndos', 0, 4, 'quote').text).toBe('> uno\ndos')
  })

  test('quote prefixes the line once', () => {
    expect(run('cita', 2, 2, 'quote').text).toBe('> cita')
    expect(run('> cita', 2, 2, 'quote').text).toBe('> cita')
  })

  test('link wraps the selection and selects "https://"', () => {
    const r = run('mira esto', 5, 9, 'link')
    expect(r.text).toBe('mira [esto](https://)')
    expect(r.text.slice(r.selStart, r.selEnd)).toBe('https://')
    const empty = run('', 0, 0, 'link')
    expect(empty.text).toBe('[texto del enlace](https://)')
    expect(empty.text.slice(empty.selStart, empty.selEnd)).toBe('https://')
  })

  test('placeholders can be translated', () => {
    expect(applyFormat('', 0, 0, 'bold', { text: 'text' }).text).toBe('**text**')
    expect(applyFormat('', 0, 0, 'link', { link: 'link text' }).text).toBe('[link text](https://)')
  })

  test('every toolbar action is handled', () => {
    for (const action of FORMAT_ACTIONS) {
      const r = applyFormat('texto', 0, 5, action)
      expect(r.text).not.toBe('texto')
    }
  })

  test('diffRange finds the single replaced range', () => {
    expect(diffRange('hola mundo', 'hola **mundo**')).toEqual({ start: 5, end: 10, insert: '**mundo**' })
    expect(diffRange('abc', 'abc')).toEqual({ start: 3, end: 3, insert: '' })
    expect(diffRange('uno\ndos', '- uno\n- dos')).toEqual({ start: 0, end: 4, insert: '- uno\n- ' })
    const before = 'hola mundo'
    const after = applyFormat(before, 5, 10, 'bold').text
    const { start, end, insert } = diffRange(before, after)
    expect(before.slice(0, start) + insert + before.slice(end)).toBe(after)
  })
})

describe('words and counters', () => {
  test('countWords counts letters and digits like the API', () => {
    expect(countWords('¿Qué hago con las rabietas? 3 años')).toBe(7)
    expect(countWords('')).toBe(0)
  })

  test('markdownWordCount ignores link targets', () => {
    expect(markdownWordCount('Lee [la agenda](https://www.sanarycriarve.com/agenda) hoy')).toBe(4)
    expect(markdownWordCount('Ver <https://example.com/a/b>')).toBe(1)
  })

  test('counterTone: hard limit first, then the SEO goal', () => {
    expect(counterTone(121, 120, 65)).toBe('error')
    expect(counterTone(70, 120, 65)).toBe('warn')
    expect(counterTone(60, 120, 65)).toBe('ok')
    expect(counterTone(100, 300, [140, 155])).toBe('warn')
    expect(counterTone(150, 300, [140, 155])).toBe('ok')
    expect(counterTone(0, 300, [140, 155])).toBe('ok')
  })
})

describe('AI jobs', () => {
  test('jobIsActive', () => {
    expect(jobIsActive({ status: 'pending' })).toBe(true)
    expect(jobIsActive({ status: 'running' })).toBe(true)
    expect(jobIsActive({ status: 'done' })).toBe(false)
    expect(jobIsActive({ status: 'error' })).toBe(false)
    expect(jobIsActive(null)).toBe(false)
    expect(jobIsActive(undefined)).toBe(false)
  })

  test('elapsed time counts from the last poll', () => {
    expect(jobElapsedSeconds({ elapsed_seconds: 41 }, 1_000_000, 1_005_500)).toBe(46)
    expect(jobElapsedSeconds({ elapsed_seconds: 41 }, 0, 1_005_500)).toBe(41)
    expect(jobElapsedSeconds(null, 0, 0)).toBe(0)
    expect(formatElapsed(7)).toBe('0:07')
    expect(formatElapsed(155)).toBe('2:35')
    expect(formatElapsed(720)).toBe('12:00')
  })

  test('applyRevisionToDraft copies the article but keeps slug, kind and cover alt', () => {
    const before = draft({ kind: 'taller', category: 'talleres-y-novedades', cover_alt: 'Foto' })
    const result = {
      category: 'emociones',
      title: 'Título revisado',
      slug: 'otro-slug-distinto',
      meta_title: 'Meta',
      meta_description: 'Descripción',
      excerpt: 'Extracto nuevo',
      summary: 'Resumen revisado en modo de prueba: …',
      key_takeaways: ['Uno', 'Dos'],
      content_md: '## Nuevo\n\nTexto',
      faq: [{ question: '¿Q?', answer: 'R.' }],
      keywords: ['crianza'],
    }
    const after = applyRevisionToDraft(before, result)
    expect(after.slug).toBe(before.slug)
    expect(after.kind).toBe('taller')
    expect(after.cover_alt).toBe('Foto')
    expect(after.title).toBe('Título revisado')
    expect(after.summary).toBe(result.summary)
    expect(after.faq).toEqual(result.faq)
    expect(after.category).toBe('emociones')
    expect(isDraftDirty(before, after)).toBe(true)
  })
})

describe('totalPages', () => {
  test('at least one page, rounding up', () => {
    expect(totalPages(0, 20)).toBe(1)
    expect(totalPages(20, 20)).toBe(1)
    expect(totalPages(21, 20)).toBe(2)
    expect(totalPages(5, 0)).toBe(1)
  })
})

describe('limits match the contract', () => {
  test('BLOG_LIMITS and SEO_TARGETS', () => {
    expect(BLOG_LIMITS).toEqual({
      title: 120, slug_min: 3, slug: 80, excerpt: 300, summary: 800,
      key_takeaways_items: 8, key_takeaway: 200, content_md: 60000, content_publish_min: 200,
      faq_items: 8, faq_question: 200, faq_answer: 1200, meta_title: 120, meta_description: 300,
      keywords_items: 12, keyword: 60, cover_alt: 200, search: 100,
      prompt_min: 10, prompt: 4000, ai_keyword: 80, facts: 2000, instruction_min: 5, instruction: 2000,
    })
    expect(SEO_TARGETS).toEqual({
      title: 65, meta_title: 60, meta_description: [140, 155], excerpt: 200,
      summary_words: [40, 70], key_takeaways: [3, 5], faq: [3, 5], faq_answer_words: [40, 80], keywords: [4, 8],
    })
  })
})

describe('sc_blog strings', () => {
  const webRoot = path.resolve(import.meta.dirname, '..')
  const readJson = (p) => JSON.parse(fs.readFileSync(path.join(webRoot, p), 'utf8'))
  const flatten = (obj, prefix = '') =>
    Object.entries(obj).flatMap(([k, v]) =>
      v && typeof v === 'object' && !Array.isArray(v) ? flatten(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]
    )
  const es = Object.fromEntries(flatten(readJson('locales-sc/blog.es.json')))
  const en = Object.fromEntries(flatten(readJson('locales-sc/blog.en.json')))

  test('es and en bundles have the same keys and placeholders, and match the merged locales', () => {
    const problems = []
    const tokens = (s) => (s.match(/\{\{[^}]+\}\}/g) || []).sort().join(',')
    for (const key of new Set([...Object.keys(es), ...Object.keys(en)])) {
      if (typeof es[key] !== 'string' || typeof en[key] !== 'string') problems.push(`missing ${key}`)
      else if (tokens(es[key]) !== tokens(en[key])) problems.push(`placeholders differ in ${key}`)
      else if (!es[key].trim() || !en[key].trim()) problems.push(`empty ${key}`)
    }
    for (const [lng, bundle] of [['es', es], ['en', en], ['ar', en]]) {
      const merged = Object.fromEntries(flatten(readJson(`locales/${lng}.json`)))
      for (const [key, value] of Object.entries(bundle)) {
        if (merged[key] !== value) problems.push(`locales/${lng}.json ${key} out of date (run tools/i18n/apply.cjs)`)
      }
    }
    expect(problems).toEqual([])
    expect(es['sc_blog.menu_label']).toBe('Blog')
  })

  test('every API value has its label (keys built at run time by blogLabel)', () => {
    const groups = [
      ['kind', BLOG_KINDS],
      ['category', BLOG_CATEGORIES],
      ['status', BLOG_STATUSES],
      ['ai.audience', BLOG_AUDIENCES],
      ['ai.length', BLOG_LENGTHS],
      ['editor.toolbar', FORMAT_ACTIONS],
      ['editor.errors', ['required', 'too_long', 'slug_invalid', 'too_many', 'faq_incomplete', 'publish_excerpt', 'publish_content']],
    ]
    const missing = []
    for (const [group, values] of groups) {
      for (const value of values) {
        for (const [lng, bundle] of [['es', es], ['en', en]]) {
          if (typeof bundle[`sc_blog.${group}.${value}`] !== 'string') missing.push(`${lng}: sc_blog.${group}.${value}`)
        }
      }
    }
    // targetText() in BlogFields.tsx builds these from a variable too.
    for (const key of ['target_chars_max', 'target_chars_range', 'target_words_range', 'target_items_range']) {
      if (typeof es[`sc_blog.${key}`] !== 'string') missing.push(`es: sc_blog.${key}`)
    }
    expect(missing).toEqual([])
  })

  test('the contract texts are kept word for word', () => {
    expect(es['sc_blog.ai.privacy_warning']).toBe(
      'No incluyas nombres ni datos de pacientes: el texto se envía a Anthropic para generar el artículo.'
    )
    expect(es['sc_blog.list.ai_disabled']).toBe('La IA no está configurada en el servidor (falta ANTHROPIC_API_KEY).')
    expect(es['sc_blog.editor.errors.publish_content']).toContain('{{min}}')
  })
})

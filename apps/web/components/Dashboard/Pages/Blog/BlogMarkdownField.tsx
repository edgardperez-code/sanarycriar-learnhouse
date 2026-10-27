'use client'
// Sanar y Criar: the article body. A Markdown textarea with a small format
// toolbar (Ctrl+B / Ctrl+I / Ctrl+K too) and a "Vista previa" tab that shows
// the HTML the API makes from it (the saved content_html when nothing
// changed, else POST /preview), sanitised again with DOMPurify.
import React, { useEffect, useId, useRef, useState } from 'react'
import { Bold, Heading2, Heading3, Italic, Link2, List, ListOrdered, Loader2, Quote } from 'lucide-react'
import { Label } from '@components/ui/label'
import { previewBlogMarkdown } from '@services/blog/blog'
import {
  BLOG_LIMITS,
  FormatAction,
  applyFormat,
  diffRange,
  markdownWordCount,
  postPayload,
  textLength,
  emptyDraft,
} from './blogForm'
import { CharCounter, FieldError, WordCounter } from './BlogFields'
import BlogPreview from './BlogPreview'
import { apiDetail, useBlogAuth } from './useBlogApi'
import { blogLabel, useBlogT } from './useBlogT'

const PREVIEW_DEBOUNCE_MS = 400

const TOOLBAR: { action: FormatAction; icon: React.ReactNode; shortcut?: string }[] = [
  { action: 'h2', icon: <Heading2 size={16} aria-hidden /> },
  { action: 'h3', icon: <Heading3 size={16} aria-hidden /> },
  { action: 'bold', icon: <Bold size={16} aria-hidden />, shortcut: 'Ctrl+B' },
  { action: 'italic', icon: <Italic size={16} aria-hidden />, shortcut: 'Ctrl+I' },
  { action: 'ul', icon: <List size={16} aria-hidden /> },
  { action: 'ol', icon: <ListOrdered size={16} aria-hidden /> },
  { action: 'link', icon: <Link2 size={16} aria-hidden />, shortcut: 'Ctrl+K' },
  { action: 'quote', icon: <Quote size={16} aria-hidden /> },
]

const SHORTCUTS: Record<string, FormatAction> = { b: 'bold', i: 'italic', k: 'link' }

/** content_md as the API stores it (line breaks normalised, trailing space cut). */
const normalizeMd = (md: string) => postPayload({ ...emptyDraft(), content_md: md }).content_md

type Props = {
  value: string
  onChange: (_value: string) => void
  /** The saved post's content_md / content_html (null while creating). */
  savedMd: string | null
  savedHtml: string | null
  error?: string | null
  disabled?: boolean
}

export default function BlogMarkdownField({ value, onChange, savedMd, savedHtml, error, disabled }: Props) {
  const { bt } = useBlogT()
  const { orgId, accessToken } = useBlogAuth()
  const baseId = useId()
  const textareaId = `${baseId}-content`
  const ref = useRef<HTMLTextAreaElement>(null)
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const [preview, setPreview] = useState<{ md: string; html: string } | null>(null)
  const [previewError, setPreviewError] = useState<{ md: string; message: string } | null>(null)
  const requestRef = useRef(0)

  const md = normalizeMd(value)
  const hasText = md.trim().length > 0
  const useSaved = savedHtml !== null && savedMd !== null && md === normalizeMd(savedMd)
  const html = !hasText ? '' : useSaved ? savedHtml : preview?.md === md ? preview.html : null
  const failed = previewError?.md === md ? previewError.message : null

  // Ask the API for the HTML of the current text (debounced; the last result
  // is reused while the text is the same).
  useEffect(() => {
    if (tab !== 'preview' || !hasText || useSaved || preview?.md === md || !orgId || !accessToken) return
    const ticket = ++requestRef.current
    const timer = window.setTimeout(async () => {
      try {
        const res = await previewBlogMarkdown(orgId, md, accessToken)
        if (ticket !== requestRef.current) return
        if (res.success) {
          setPreview({ md, html: String(res.data?.content_html ?? '') })
          setPreviewError(null)
        } else {
          setPreviewError({ md, message: apiDetail(res.data) ?? bt('editor.preview_error') })
        }
      } catch {
        if (ticket === requestRef.current) setPreviewError({ md, message: bt('editor.preview_error') })
      }
    }, PREVIEW_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [tab, md, hasText, useSaved, preview?.md, orgId, accessToken, bt])

  const runFormat = (action: FormatAction) => {
    const el = ref.current
    if (!el || disabled) return
    const before = el.value
    const result = applyFormat(before, el.selectionStart, el.selectionEnd, action, {
      text: bt('editor.format_text'),
      link: bt('editor.format_link'),
    })
    const { start, end, insert } = diffRange(before, result.text)
    el.focus()
    let applied = false
    if (start !== end || insert) {
      // insertText keeps the browser's undo history (Ctrl+Z) working; React's
      // onChange runs from the input event it fires.
      el.setSelectionRange(start, end)
      try {
        applied = document.execCommand('insertText', false, insert) && el.value === result.text
      } catch {
        applied = false
      }
      if (!applied) onChange(result.text)
    }
    const restore = () => {
      if (ref.current) ref.current.setSelectionRange(result.selStart, result.selEnd)
    }
    restore()
    window.requestAnimationFrame(restore)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
    const action = SHORTCUTS[e.key.toLowerCase()]
    if (!action) return
    e.preventDefault()
    runFormat(action)
  }

  const chars = textLength(md)
  const tabClass = (active: boolean) =>
    `rounded-full px-3 py-1 text-xs font-medium transition-colors ${
      active ? 'bg-[#190933] text-white' : 'text-[#584F72] hover:bg-[#EEEDFF]'
    }`

  return (
    <div className="space-y-2 min-w-0">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <Label htmlFor={textareaId} className="text-[#190933]">
          {bt('editor.content_label')}
        </Label>
        <div role="tablist" aria-label={bt('editor.content_label')} className="inline-flex rounded-full border border-[#EAE8F2] bg-[#FFFCF9] p-0.5">
          <button type="button" role="tab" aria-selected={tab === 'write'} onClick={() => setTab('write')} className={tabClass(tab === 'write')}>
            {bt('editor.tab_write')}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'preview'} onClick={() => setTab('preview')} className={tabClass(tab === 'preview')}>
            {bt('editor.tab_preview')}
          </button>
        </div>
      </div>
      <p id={`${textareaId}-hint`} className="text-xs text-gray-500">
        {bt('editor.content_hint')}
      </p>

      {/* The textarea stays mounted on the preview tab so its undo history survives. */}
      <div className={tab === 'write' ? 'space-y-0' : 'hidden'}>
        <div
          role="toolbar"
          aria-label={bt('editor.toolbar_label')}
          aria-controls={textareaId}
          className="flex flex-wrap items-center gap-0.5 rounded-t-lg border border-b-0 border-input bg-[#FFFCF9] px-1.5 py-1"
        >
          {TOOLBAR.map(({ action, icon, shortcut }) => {
            const label = blogLabel(bt, 'editor.toolbar', action)
            return (
              <button
                key={action}
                type="button"
                title={shortcut ? `${label} (${shortcut})` : label}
                aria-label={label}
                disabled={disabled}
                // Keep the textarea's selection: a mousedown on a button would blur it first.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => runFormat(action)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[#41375B] transition-colors hover:bg-[#EEEDFF] disabled:opacity-40 disabled:hover:bg-transparent"
              >
                {icon}
              </button>
            )
          })}
        </div>
        <textarea
          ref={ref}
          id={textareaId}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck
          placeholder={bt('editor.content_placeholder')}
          aria-invalid={error ? true : undefined}
          aria-describedby={[`${textareaId}-hint`, `${textareaId}-count`, error ? `${textareaId}-error` : null].filter(Boolean).join(' ')}
          className={`block min-h-[480px] w-full resize-y rounded-b-lg border border-input bg-card px-3 py-2.5 font-mono text-[13px] leading-relaxed shadow-xs placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 ${
            error ? 'border-red-400 focus-visible:ring-red-400' : ''
          }`}
        />
      </div>

      {tab === 'preview' && (
        <div role="tabpanel" className="min-h-[480px] rounded-lg border border-[#EAE8F2] bg-white px-4 py-4 sm:px-6">
          <p className="mb-4 text-xs text-gray-500">{bt('editor.preview_hint')}</p>
          {!hasText ? (
            <p className="py-10 text-center text-sm text-gray-500">{bt('editor.preview_empty')}</p>
          ) : html !== null ? (
            <BlogPreview html={html} />
          ) : failed ? (
            <p className="py-10 text-center text-sm text-red-600">{failed}</p>
          ) : (
            <p className="flex items-center justify-center gap-2 py-10 text-sm text-gray-500">
              <Loader2 size={15} className="animate-spin" aria-hidden />
              {bt('editor.preview_loading')}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <FieldError id={`${textareaId}-error`} message={error} />
        <span className="ms-auto flex items-baseline gap-3">
          <WordCounter count={markdownWordCount(md)} />
          <CharCounter id={`${textareaId}-count`} count={chars} max={BLOG_LIMITS.content_md} />
        </span>
      </div>
    </div>
  )
}

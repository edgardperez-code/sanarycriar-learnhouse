'use client'
// Sanar y Criar: the post's FAQ (question + plain-text answer pairs). The site
// shows them under the article and as FAQPage structured data.
import React, { useEffect, useId, useRef } from 'react'
import { Plus, X } from 'lucide-react'
import { BLOG_LIMITS, BlogFaqItem, DraftError, SEO_TARGETS } from './blogForm'
import { CharCounter, FieldError, TextField, targetText } from './BlogFields'
import { useBlogT } from './useBlogT'

type Props = {
  items: BlogFaqItem[]
  onChange: (_items: BlogFaqItem[]) => void
  errors: DraftError[]
  errorText: (_error: DraftError) => string
  disabled?: boolean
}

export default function BlogFaqField({ items, onChange, errors, errorText, disabled }: Props) {
  const { bt } = useBlogT()
  const baseId = useId()
  const pendingFocus = useRef<number | null>(null)
  const filled = items.filter((item) => item.question.trim() || item.answer.trim()).length
  const listError = errors.find((e) => e.index === undefined)

  useEffect(() => {
    if (pendingFocus.current === null) return
    document.getElementById(`${baseId}-${pendingFocus.current}-q`)?.focus()
    pendingFocus.current = null
  })

  const update = (index: number, patch: Partial<BlogFaqItem>) =>
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)))
  const remove = (index: number) => onChange(items.filter((_, i) => i !== index))
  const add = () => {
    if (items.length >= BLOG_LIMITS.faq_items) return
    pendingFocus.current = items.length
    onChange([...items, { question: '', answer: '' }])
  }

  const itemError = (index: number, part: 'question' | 'answer') => {
    const error = errors.find((e) => e.index === index && e.part === part)
    return error ? errorText(error) : null
  }

  return (
    <div className="space-y-3 min-w-0" role="group" aria-labelledby={`${baseId}-label`}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 id={`${baseId}-label`} className="text-sm font-medium text-[#190933]">
          {bt('editor.faq_label')}
        </h3>
        <CharCounter count={filled} max={BLOG_LIMITS.faq_items} target={SEO_TARGETS.faq} />
      </div>
      <p className="text-xs text-gray-500">
        {[bt('editor.faq_hint'), targetText(bt, SEO_TARGETS.faq, 'items')].filter(Boolean).join(' ')}
      </p>

      {items.length > 0 && (
        <ol className="space-y-3">
          {items.map((item, index) => {
            const number = index + 1
            const questionLabel = bt('editor.item_label', { label: bt('editor.faq_question'), number })
            return (
              <li key={index} className="rounded-lg border border-[#EAE8F2] bg-[#FFFCF9] px-3 py-3 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-[#6559CA]">{questionLabel}</span>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => remove(index)}
                    aria-label={`${bt('editor.remove_item')}: ${questionLabel}`}
                    title={bt('editor.remove_item')}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                  >
                    <X size={15} aria-hidden />
                  </button>
                </div>
                <TextField
                  id={`${baseId}-${index}-q`}
                  label={bt('editor.faq_question')}
                  value={item.question}
                  onChange={(question) => update(index, { question })}
                  max={BLOG_LIMITS.faq_question}
                  error={itemError(index, 'question')}
                  disabled={disabled}
                />
                <TextField
                  id={`${baseId}-${index}-a`}
                  label={bt('editor.faq_answer')}
                  value={item.answer}
                  onChange={(answer) => update(index, { answer })}
                  max={BLOG_LIMITS.faq_answer}
                  wordTarget={SEO_TARGETS.faq_answer_words}
                  error={itemError(index, 'answer')}
                  multiline
                  rows={3}
                  disabled={disabled}
                />
              </li>
            )
          })}
        </ol>
      )}

      <button
        type="button"
        onClick={add}
        disabled={disabled || items.length >= BLOG_LIMITS.faq_items}
        className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-[#BBBBFF] px-3 py-1 text-xs font-medium text-[#6559CA] transition-colors hover:bg-[#EEEDFF] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Plus size={13} aria-hidden />
        {bt('editor.faq_add')}
      </button>
      {listError && <FieldError message={errorText(listError)} />}
    </div>
  )
}

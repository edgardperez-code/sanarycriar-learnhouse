'use client'
// Sanar y Criar: small form pieces shared by the blog editor and the AI
// dialogs (card, labelled text field with counters, native select).
import React from 'react'
import { ChevronDown } from 'lucide-react'
import { Input } from '@components/ui/input'
import { Textarea } from '@components/ui/textarea'
import { Label } from '@components/ui/label'
import { SeoTone, countWords, counterTone, textLength } from './blogForm'
import { useBlogT } from './useBlogT'

export const TONE_CLASS: Record<SeoTone, string> = {
  ok: 'text-gray-400',
  warn: 'text-amber-600 font-medium',
  error: 'text-red-600 font-semibold',
}

export function Card({
  title,
  description,
  className = '',
  children,
}: {
  title?: React.ReactNode
  description?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={`rounded-xl bg-white nice-shadow px-4 py-4 sm:px-5 sm:py-5 space-y-4 ${className}`}>
      {(title || description) && (
        <div className="space-y-1">
          {title && <h2 className="font-semibold text-[#190933]">{title}</h2>}
          {description && <p className="text-xs text-gray-500">{description}</p>}
        </div>
      )}
      {children}
    </section>
  )
}

export function FieldError({ id, message }: { id?: string; message?: string | null }) {
  if (!message) return null
  return (
    <p id={id} className="text-xs font-medium text-red-600">
      {message}
    </p>
  )
}

/** "12/120", coloured by the hard limit and the optional SEO goal. */
export function CharCounter({
  id,
  count,
  max,
  target,
}: {
  id?: string
  count: number
  max: number
  target?: number | readonly number[]
}) {
  const { bt } = useBlogT()
  return (
    <span id={id} className={`text-xs tabular-nums whitespace-nowrap ${TONE_CLASS[counterTone(count, max, target)]}`}>
      {bt('char_count', { count, max })}
    </span>
  )
}

/** "45 palabras", amber outside the goal. */
export function WordCounter({ count, target }: { count: number; target?: readonly number[] }) {
  const { bt } = useBlogT()
  return (
    <span className={`text-xs tabular-nums whitespace-nowrap ${TONE_CLASS[counterTone(count, Number.POSITIVE_INFINITY, target)]}`}>
      {bt('word_count', { count })}
    </span>
  )
}

type TextFieldProps = {
  id: string
  label: string
  value: string
  onChange: (_value: string) => void
  max: number
  /** SEO goal in characters: a number (at most) or [min, max]. */
  target?: number | readonly number[]
  /** Goal in words, shown with a word counter (summary, FAQ answers). */
  wordTarget?: readonly number[]
  /** Text under the field ("Recomendado: …" is added when a target is set). */
  hint?: string
  error?: string | null
  multiline?: boolean
  rows?: number
  placeholder?: string
  disabled?: boolean
  prefix?: string
  onBlur?: () => void
  inputClassName?: string
  dir?: 'ltr' | 'rtl' | 'auto'
  autoFocus?: boolean
  srOnlyLabel?: boolean
}

export function targetText(
  bt: (_key: string, _options?: Record<string, any>) => string,
  target: number | readonly number[] | undefined,
  unit: 'chars' | 'words' | 'items'
): string | null {
  if (target === undefined) return null
  if (typeof target === 'number') return bt('char_target', { target: bt('target_chars_max', { max: target }) })
  const [min, max] = target
  const key = unit === 'words' ? 'target_words_range' : unit === 'items' ? 'target_items_range' : 'target_chars_range'
  return bt('char_target', { target: bt(key, { min, max }) })
}

export function TextField({
  id,
  label,
  value,
  onChange,
  max,
  target,
  wordTarget,
  hint,
  error,
  multiline,
  rows = 3,
  placeholder,
  disabled,
  prefix,
  onBlur,
  inputClassName = '',
  dir,
  autoFocus,
  srOnlyLabel,
}: TextFieldProps) {
  const { bt } = useBlogT()
  const length = textLength((value ?? '').trim())
  const goal = [targetText(bt, target, 'chars'), targetText(bt, wordTarget, 'words')].filter(Boolean).join(' · ')
  const describedBy = [hint || goal ? `${id}-hint` : null, error ? `${id}-error` : null, `${id}-count`]
    .filter(Boolean)
    .join(' ')
  const common = {
    id,
    value,
    placeholder,
    disabled,
    onBlur,
    dir,
    autoFocus,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy,
  }
  const errorRing = error ? 'border-red-400 focus-visible:ring-red-400' : ''
  return (
    <div className="space-y-1.5 min-w-0">
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={id} className={srOnlyLabel ? 'sr-only' : 'text-[#190933]'}>
          {label}
        </Label>
        <span className={`flex items-baseline gap-2 ${srOnlyLabel ? 'ms-auto' : ''}`}>
          {wordTarget && <WordCounter count={countWords(value)} target={wordTarget} />}
          <CharCounter id={`${id}-count`} count={length} max={max} target={target} />
        </span>
      </div>
      {multiline ? (
        <Textarea {...common} rows={rows} className={`${errorRing} ${inputClassName}`} onChange={(e) => onChange(e.target.value)} />
      ) : prefix ? (
        <div className={`flex items-stretch rounded-lg border border-input bg-card shadow-xs focus-within:ring-1 focus-within:ring-ring ${error ? 'border-red-400' : ''} ${disabled ? 'opacity-60' : ''}`}>
          <span dir="ltr" className="flex items-center ps-3 text-sm text-gray-400 select-none">
            {prefix}
          </span>
          <input
            {...common}
            type="text"
            className={`h-9 min-w-0 flex-1 bg-transparent pe-3 text-sm outline-hidden disabled:cursor-not-allowed ${inputClassName}`}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      ) : (
        <Input {...common} type="text" className={`${errorRing} ${inputClassName}`} onChange={(e) => onChange(e.target.value)} />
      )}
      {(hint || goal) && (
        <p id={`${id}-hint`} className="text-xs text-gray-500">
          {[hint, goal].filter(Boolean).join(' ')}
        </p>
      )}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  )
}

export function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  hint,
  error,
  disabled,
}: {
  id: string
  label: string
  value: string
  onChange: (_value: string) => void
  options: { value: string; label: string }[]
  hint?: string | null
  error?: string | null
  disabled?: boolean
}) {
  return (
    <div className="space-y-1.5 min-w-0">
      <Label htmlFor={id} className="text-[#190933]">
        {label}
      </Label>
      <div className="relative">
        <select
          id={id}
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={[hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined}
          onChange={(e) => onChange(e.target.value)}
          className={`h-9 w-full appearance-none rounded-lg border border-input bg-card ps-3 pe-8 text-sm shadow-xs focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer ${
            error ? 'border-red-400' : ''
          }`}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown size={14} className="pointer-events-none absolute end-2.5 top-1/2 -translate-y-1/2 text-gray-400" aria-hidden />
      </div>
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-gray-500">
          {hint}
        </p>
      )}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  )
}

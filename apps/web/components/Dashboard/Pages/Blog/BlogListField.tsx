'use client'
// Sanar y Criar: an editable list of short texts (key takeaways, keywords).
// Enter in a row adds the next one; empty rows are dropped when saving.
import React, { useEffect, useId, useRef } from 'react'
import { Plus, X } from 'lucide-react'
import { Input } from '@components/ui/input'
import { Label } from '@components/ui/label'
import { DraftError, textLength } from './blogForm'
import { CharCounter, FieldError, targetText } from './BlogFields'
import { useBlogT } from './useBlogT'

type Props = {
  label: string
  /** Name of one item, for the row labels ("Idea clave 2"). */
  itemLabel: string
  hint?: string
  items: string[]
  onChange: (_items: string[]) => void
  maxItems: number
  maxLength: number
  targetItems?: readonly number[]
  placeholder?: string
  errors: DraftError[]
  errorText: (_error: DraftError) => string
  disabled?: boolean
}

export default function BlogListField({
  label,
  itemLabel,
  hint,
  items,
  onChange,
  maxItems,
  maxLength,
  targetItems,
  placeholder,
  errors,
  errorText,
  disabled,
}: Props) {
  const { bt } = useBlogT()
  const baseId = useId()
  const inputs = useRef<(HTMLInputElement | null)[]>([])
  // Row to focus after the next render (added with Enter / "Agregar", or the
  // previous one after Backspace removed an empty row).
  const pendingFocus = useRef<number | null>(null)
  const filled = items.filter((item) => item.trim()).length
  const goal = targetText(bt, targetItems, 'items')
  const listError = errors.find((e) => e.index === undefined)

  useEffect(() => {
    if (pendingFocus.current === null) return
    inputs.current[pendingFocus.current]?.focus()
    pendingFocus.current = null
  })

  const update = (index: number, value: string) => onChange(items.map((item, i) => (i === index ? value : item)))
  const remove = (index: number) => onChange(items.filter((_, i) => i !== index))
  const add = (at: number = items.length) => {
    if (items.length >= maxItems) return
    const next = [...items.slice(0, at), '', ...items.slice(at)]
    pendingFocus.current = at
    onChange(next)
  }

  return (
    <div className="space-y-2 min-w-0" role="group" aria-labelledby={`${baseId}-label`}>
      <div className="flex items-baseline justify-between gap-3">
        <Label id={`${baseId}-label`} className="text-[#190933]">
          {label}
        </Label>
        <CharCounter count={filled} max={maxItems} target={targetItems} />
      </div>
      {(hint || goal) && <p className="text-xs text-gray-500">{[hint, goal].filter(Boolean).join(' ')}</p>}

      {items.length > 0 && (
        <ol className="space-y-2">
          {items.map((item, index) => {
            const id = `${baseId}-${index}`
            const rowLabel = bt('editor.item_label', { label: itemLabel, number: index + 1 })
            const error = errors.find((e) => e.index === index)
            const length = textLength(item.trim())
            return (
              <li key={index} className="space-y-1">
                <div className="flex items-center gap-2">
                  <span aria-hidden className="w-5 shrink-0 text-end text-xs tabular-nums text-gray-400">
                    {index + 1}.
                  </span>
                  <Input
                    id={id}
                    ref={(el) => {
                      inputs.current[index] = el
                    }}
                    type="text"
                    value={item}
                    disabled={disabled}
                    placeholder={placeholder}
                    aria-label={rowLabel}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? `${id}-error` : undefined}
                    className={error ? 'border-red-400 focus-visible:ring-red-400' : ''}
                    onChange={(e) => update(index, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        add(index + 1)
                      } else if (e.key === 'Backspace' && !item && items.length > 0) {
                        e.preventDefault()
                        pendingFocus.current = Math.max(0, index - 1)
                        remove(index)
                      }
                    }}
                  />
                  {length > maxLength * 0.8 && <CharCounter count={length} max={maxLength} />}
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => remove(index)}
                    aria-label={`${bt('editor.remove_item')}: ${rowLabel}`}
                    title={bt('editor.remove_item')}
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                  >
                    <X size={15} aria-hidden />
                  </button>
                </div>
                {error && (
                  <div className="ps-7">
                    <FieldError id={`${id}-error`} message={errorText(error)} />
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}

      <button
        type="button"
        onClick={() => add()}
        disabled={disabled || items.length >= maxItems}
        className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-[#BBBBFF] px-3 py-1 text-xs font-medium text-[#6559CA] transition-colors hover:bg-[#EEEDFF] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Plus size={13} aria-hidden />
        {bt('editor.add_item')}
      </button>
      {listError && <FieldError message={errorText(listError)} />}
    </div>
  )
}

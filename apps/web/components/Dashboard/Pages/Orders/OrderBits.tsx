'use client'
// Sanar y Criar: small pieces shared by the order list and the order detail
// (status chip, "vence en 5 h", a clock that ticks, **bold** in a sentence).
import React, { useEffect, useState } from 'react'
import { Clock } from 'lucide-react'
import { StatusTone, expiresLabel, statusTone } from './ordersForm'
import { OrdersTranslate, ordersLabel, stateLabel } from './useOrdersT'

const TONE_CLASSES: Record<StatusTone, { chip: string; dot: string }> = {
  warning: { chip: 'bg-amber-100 text-amber-800', dot: 'bg-amber-500' },
  success: { chip: 'bg-green-100 text-green-700', dot: 'bg-green-500' },
  danger: { chip: 'bg-red-100 text-red-700', dot: 'bg-red-500' },
  accent: { chip: 'bg-[#F9DDF0] text-[#AC4691]', dot: 'bg-[#AC4691]' },
  neutral: { chip: 'bg-gray-100 text-gray-600', dot: 'bg-gray-400' },
}

export function StatusChip({ status, ot, className = '' }: { status: string; ot: OrdersTranslate; className?: string }) {
  const tone = TONE_CLASSES[statusTone(status)]
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${tone.chip} ${className}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
      {stateLabel(ot, status)}
    </span>
  )
}

/** "vence en 5 h" (amber) or "vencido" (red) for a pending order. */
export function ExpiresBadge({ expiresAt, now, ot }: { expiresAt: string; now: number; ot: OrdersTranslate }) {
  const label = expiresLabel(expiresAt, now)
  if (!label) return null
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium ${
        label.expired ? 'text-red-600' : 'text-amber-700'
      }`}
    >
      <Clock size={12} aria-hidden className="shrink-0" />
      {ordersLabel(ot, 'expires', label.unit, { count: label.count })}
    </span>
  )
}

/** The current time, refreshed every `everyMs` (for countdowns). */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs)
    return () => window.clearInterval(timer)
  }, [everyMs])
  return now
}

/** A translated sentence where **text** is shown in bold (no HTML from strings). */
export function BoldText({ text }: { text: string }) {
  const parts = String(text ?? '').split('**')
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <strong key={i} className="font-semibold text-[#190933]">
            {part}
          </strong>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        )
      )}
    </>
  )
}

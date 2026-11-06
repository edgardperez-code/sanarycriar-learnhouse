'use client'
// Sanar y Criar: small pieces shared by the order list, the order detail and
// the cards of "Pagos manuales" (status chip, the method's icon and chip,
// "vence en 5 h", a clock that ticks, **bold** in a sentence).
import React, { useEffect, useState } from 'react'
import { Clock, Landmark, Smartphone } from 'lucide-react'
import { SiBinance, SiZelle } from '@icons-pack/react-simple-icons'
import { useScT } from '@components/Payments/useScT'
import { paymentLabel } from '@components/Payments/commerce'
import { StatusTone, expiresLabel, statusTone } from './ordersForm'
import { OrdersTranslate, ordersLabel, stateLabel } from './useOrdersT'

/**
 * The icon of a manual method (the same ones as the store): a phone for Pago
 * Móvil, a bank for the transfer, the Zelle and Binance marks. Decorative: the
 * method's name always goes next to it.
 */
export function MethodIcon({ method, size = 16, className = '' }: { method: string | null | undefined; size?: number; className?: string }) {
  // The brand marks are filled: a little smaller looks the same size as the outlined icons.
  const brandSize = Math.max(10, size - 2)
  switch (method) {
    case 'transferencia':
      return <Landmark size={size} className={className} aria-hidden="true" />
    case 'zelle':
      return <SiZelle size={brandSize} className={className} aria-hidden="true" title="" />
    case 'binance':
      return <SiBinance size={brandSize} className={className} aria-hidden="true" title="" />
    default:
      return <Smartphone size={size} className={className} aria-hidden="true" />
  }
}

/** "Pago Móvil", "Transferencia bancaria", "Zelle" or "Binance" with its icon (spans only: it sits inside buttons). */
export function MethodChip({
  method,
  provider,
  ot,
  className = '',
}: {
  method: string | null | undefined
  provider: string | null | undefined
  ot: OrdersTranslate
  className?: string
}) {
  const { sc } = useScT()
  const label = paymentLabel(provider, method, sc)
  if (!label) return null
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-[#EEEDFF] px-2 py-0.5 text-[11px] font-medium text-[#4F43A4] ${className}`}
    >
      <MethodIcon method={method} size={12} className="shrink-0" />
      <span className="sr-only">{ot('detail.method')}: </span>
      {label}
    </span>
  )
}

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

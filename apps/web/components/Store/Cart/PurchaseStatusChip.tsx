'use client'
// Sanar y Criar: status chip of a Pago Móvil order (Por confirmar, Pagado, …).
import React from 'react'
import { CheckCircle2, Clock, Ban, XCircle, CalendarX } from 'lucide-react'
import { purchaseStatus, type PurchaseStatus } from '@/lib/sc-cart'
import { useCartT } from './useCartT'

// Static keys (tests/sc-cart.test.mjs checks each one exists).
export const PURCHASE_STATUS_KEYS: Record<PurchaseStatus, string> = {
  pending: 'status.pending',
  paid: 'status.paid',
  rejected: 'status.rejected',
  cancelled: 'status.cancelled',
  expired: 'status.expired',
  voided: 'status.voided',
}

const TONES: Record<PurchaseStatus, string> = {
  pending: 'bg-amber-50 text-amber-800 border-amber-200',
  paid: 'bg-green-50 text-green-800 border-green-200',
  rejected: 'bg-red-50 text-red-700 border-red-200',
  cancelled: 'bg-[#F4F2F8] text-[#584F72] border-[#EAE8F2]',
  expired: 'bg-[#F4F2F8] text-[#584F72] border-[#EAE8F2]',
  voided: 'bg-[#F9DDF0] text-[#AC4691] border-[#F0B4DF]',
}

function StatusIcon({ status }: { status: PurchaseStatus }) {
  const props = { size: 12, 'aria-hidden': true } as const
  switch (status) {
    case 'pending':
      return <Clock {...props} />
    case 'paid':
      return <CheckCircle2 {...props} />
    case 'expired':
      return <CalendarX {...props} />
    case 'voided':
      return <Ban {...props} />
    default:
      return <XCircle {...props} />
  }
}

export function PurchaseStatusChip({ status, className = '' }: { status: unknown; className?: string }) {
  const { ct } = useCartT()
  const s = purchaseStatus(status)
  if (!s) return null
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TONES[s]} ${className}`}
    >
      <StatusIcon status={s} />
      {ct(PURCHASE_STATUS_KEYS[s])}
    </span>
  )
}

export default PurchaseStatusChip

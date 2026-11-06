'use client'
// Sanar y Criar: the cart orders in Mis compras (contract §D.6), each with
// what she pays in its method's currency and the method
// (contrato-pagos-manuales.md §A.6). Renders nothing when the buyer has no
// orders.
import React from 'react'
import Link from 'next/link'
import { ArrowRight, CalendarDays, Clock, ReceiptText } from 'lucide-react'
import { getUriWithOrg } from '@services/config/config'
import { methodLabel } from '@components/Payments/commerce'
import { useScT } from '@components/Payments/useScT'
import { formatCaracasDateTime, sortPurchasesPendingFirst } from '@/lib/sc-cart'
import { MethodIcon } from './MethodIcon'
import { PurchaseStatusChip } from './PurchaseStatusChip'
import { payAmountText, payEquivalent, purchasePay } from './payMethods'
import { useCartT } from './useCartT'
import type { Purchase } from './types'

const SHOWN_NAMES = 2

function PurchaseCard({ purchase, orgslug }: { purchase: Purchase; orgslug: string }) {
  const { ct, lng } = useCartT()
  const { sc } = useScT()
  const names = (purchase.items ?? []).map((i) => i.name).filter(Boolean)
  const extra = names.length - SHOWN_NAMES
  const pending = purchase.status === 'pending'
  const pay = purchasePay(purchase)
  const equivalent = payEquivalent(pay, purchase.amount, ct)

  return (
    <li className="bg-white rounded-[20px] nice-shadow overflow-hidden">
      <div className="p-4 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-mono text-sm font-semibold text-[#190933]">{purchase.code}</span>
          <PurchaseStatusChip status={purchase.status} />
        </div>

        <p className="text-sm font-semibold text-[#190933] leading-snug break-words">
          {names.slice(0, SHOWN_NAMES).join(', ')}
          {extra > 0 && <span className="font-normal text-[#6D6485]"> {ct('account.more_products', { count: extra })}</span>}
        </p>

        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-black text-lg text-[#190933] tabular-nums leading-tight">
            {payAmountText(pay, purchase.amount)}
          </span>
          {equivalent && <span className="text-xs text-[#6D6485] tabular-nums">{equivalent}</span>}
        </p>

        <div className="text-xs text-[#6D6485] space-y-1">
          <p className="flex items-center gap-1.5 font-semibold text-[#584F72]">
            <MethodIcon method={pay.method} size={12} className="shrink-0" />
            {methodLabel(pay.method, sc)}
          </p>
          {purchase.created_at && (
            <p className="flex items-center gap-1.5">
              <CalendarDays size={12} className="shrink-0" aria-hidden="true" />
              {formatCaracasDateTime(purchase.created_at, lng)}
            </p>
          )}
          {pending && purchase.expires_at && (
            <p className="flex items-center gap-1.5 font-semibold text-amber-800">
              <Clock size={12} className="shrink-0" aria-hidden="true" />
              {ct('account.pay_before', { date: formatCaracasDateTime(purchase.expires_at, lng) })}
            </p>
          )}
        </div>

        <Link
          href={getUriWithOrg(orgslug, `/store/purchases/${encodeURIComponent(purchase.purchase_uuid)}`)}
          className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-full px-4 text-xs font-semibold transition-colors ${
            pending ? 'bg-[#190933] text-white hover:bg-[#41375B]' : 'bg-[#EEEDFF] text-[#4F43A4] hover:bg-[#E2E0FF]'
          }`}
        >
          {ct('account.view_order')} <ArrowRight size={12} aria-hidden="true" />
        </Link>
      </div>
    </li>
  )
}

export function MyPurchasesSection({ purchases, orgslug }: { purchases: Purchase[]; orgslug: string }) {
  const { ct } = useCartT()
  if (!purchases.length) return null
  const sorted = sortPurchasesPendingFirst(purchases)

  return (
    <section aria-labelledby="sc-cart-orders" className="space-y-3">
      <div className="flex items-center gap-3 px-1">
        <div className="w-9 h-9 rounded-xl bg-[#EEEDFF] flex items-center justify-center shrink-0">
          <ReceiptText size={16} className="text-[#6559CA]" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h2 id="sc-cart-orders" className="font-bold text-[#190933]">{ct('account.title')}</h2>
          <p className="text-xs text-[#6D6485]">{ct('account.subtitle')}</p>
        </div>
      </div>
      <ul className="space-y-3">
        {sorted.map((p) => (
          <PurchaseCard key={p.purchase_uuid} purchase={p} orgslug={orgslug} />
        ))}
      </ul>
    </section>
  )
}

export default MyPurchasesSection

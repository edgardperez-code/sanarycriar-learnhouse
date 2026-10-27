'use client'
// Sanar y Criar: amber "payment under review" card of a course/ebook page
// (CoursesActions and CourseActionsMobile). When the open payment belongs to
// a Pago Móvil order, it names the order and links to it (contract §D.3);
// otherwise it is the generic card.
import React from 'react'
import Link from 'next/link'
import { ArrowRight, ClockIcon } from 'lucide-react'
import { getUriWithOrg } from '@services/config/config'
import { useScT } from '@components/Payments/useScT'
import type { ResourceAccess } from '@components/Hooks/useCourseAccess'
import { useCartT } from './useCartT'

export function PendingPaymentCard({ access, orgslug }: { access: ResourceAccess | null; orgslug: string }) {
  const { sc } = useScT()
  const { ct } = useCartT()
  const pending = access?.pending_purchase
  const orderUuid = pending?.purchase_uuid

  return (
    <div role="status" className="p-4 bg-amber-50 border border-amber-200 rounded-[20px] space-y-1">
      <div className="flex items-center gap-2">
        <ClockIcon className="w-4 h-4 text-amber-700 shrink-0" />
        <h3 className="text-[#190933] font-semibold text-sm">
          {orderUuid ? ct('course.pending_title', { code: pending?.code ?? '' }) : sc('course_actions.payment_pending_title')}
        </h3>
      </div>
      <p className="text-xs text-[#584F72] leading-relaxed">
        {orderUuid ? ct('course.pending_description') : sc('course_actions.payment_pending_description')}
      </p>
      {orderUuid && (
        <Link
          href={getUriWithOrg(orgslug, `/store/purchases/${encodeURIComponent(orderUuid)}`)}
          className="inline-flex min-h-[40px] items-center gap-1.5 pt-1 text-sm font-semibold text-[#4F43A4] underline underline-offset-2 hover:text-[#190933]"
        >
          {ct('course.view_order')} <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
        </Link>
      )}
    </div>
  )
}

export default PendingPaymentCard

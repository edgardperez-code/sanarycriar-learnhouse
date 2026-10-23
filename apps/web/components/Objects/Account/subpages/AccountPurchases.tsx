'use client'
// Sanar y Criar: purchases list with a direct link to each course/ebook the
// purchase unlocks. No billing portal: PayPal (and later Pago Móvil) have
// none; receipts come from the provider by email.
import React from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import { getUriWithOrg } from '@services/config/config'
import { getUserEnrollments } from '@services/payments/offers'
import {
  ShoppingBag, RefreshCcw, SquareCheck, ArrowRight,
  Loader2, CalendarDays, BadgeCheck, BookOpen, BookMarked,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatCurrency, formatDate } from '@/lib/format'
import { billingIntervalLabel } from '@/lib/payments/billingInterval'
import { useScT, ScTranslate } from '@components/Payments/useScT'
import { normalizeProductType, stripCoursePrefix } from '@components/Payments/commerce'
import { safeImageSrc } from '@services/security/url'

interface AccountPurchasesProps {
  orgId: number
  orgslug: string
}

// Enrollments in these states are real purchases; pending/failed/cancelled
// ones are abandoned or in-flight checkouts and only add noise here.
const VISIBLE_STATUSES = new Set(['active', 'completed', 'refunded'])

const STATUS_CLS: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  completed: 'bg-green-100 text-green-700',
  refunded: 'bg-purple-100 text-purple-700',
}

function ResourceLink({ resource, orgslug, sc }: { resource: any; orgslug: string; sc: ScTranslate }) {
  const courseUuid = stripCoursePrefix(resource.course_uuid ?? resource.resource_uuid)
  if (!courseUuid) return null
  const isEbook = normalizeProductType(resource.product_type) === 'ebook'
  const thumb = safeImageSrc(resource.thumbnail_url)
  return (
    <div className="flex items-center justify-between gap-3 bg-[#FFFCF9] border border-[#EAE8F2] rounded-xl px-3 py-2">
      <div className="flex items-center gap-2 min-w-0">
        {thumb ? (
          <img src={thumb} alt="" className="w-9 h-9 rounded-md object-cover shrink-0" />
        ) : (
          <div className="w-9 h-9 rounded-md bg-[#EEEDFF] flex items-center justify-center shrink-0">
            {isEbook ? <BookMarked size={14} className="text-[#AC4691]" /> : <BookOpen size={14} className="text-[#6559CA]" />}
          </div>
        )}
        <span className="text-sm font-medium text-[#190933] truncate">{resource.name}</span>
      </div>
      <Link
        href={getUriWithOrg(orgslug, `/course/${courseUuid}`)}
        className="shrink-0 inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-[#190933] hover:bg-[#41375B] transition-colors px-3 py-1.5 rounded-full"
      >
        {isEbook ? sc('purchases.read_ebook') : sc('purchases.go_to_course')} <ArrowRight size={11} />
      </Link>
    </div>
  )
}

function EnrollmentCard({ enrollment, orgslug }: {
  enrollment: any
  orgslug: string
}) {
  const { t } = useTranslation()
  const { sc, lng } = useScT()
  const isSubscription = enrollment.offer_type === 'subscription'
  const status = String(enrollment.status ?? '').toLowerCase()
  const isActive = status === 'active' || status === 'completed'
  const resources: any[] = Array.isArray(enrollment.resources) ? enrollment.resources : []

  const formattedPrice = enrollment.amount != null
    ? formatCurrency(Number(enrollment.amount), enrollment.currency ?? 'USD', lng)
    : null

  // Sanar y Criar: the purchase date is when it was paid (creation_date is
  // when the checkout started).
  const purchasedAt = enrollment.paid_at ?? enrollment.creation_date
  const formattedDate = purchasedAt
    ? formatDate(purchasedAt, lng, { dateStyle: undefined, year: 'numeric', month: 'short', day: 'numeric' })
    : null

  const offerKey = enrollment.offer_uuid ?? enrollment.offer_id

  return (
    <div className="bg-white rounded-[20px] nice-shadow overflow-hidden">
      {/* Type stripe */}
      <div className="px-4 py-2 flex items-center justify-between bg-[#EEEDFF]">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#4F43A4]">
          {isSubscription ? <RefreshCcw size={11} /> : <SquareCheck size={11} />}
          {isSubscription ? sc('offer_card.subscription') : sc('purchases.one_time_purchase')}
        </span>
        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded-full ${
          STATUS_CLS[status] ?? 'bg-gray-100 text-gray-500'
        }`}>
          <BadgeCheck size={11} />
          {isActive ? sc('purchases.status_active') : sc(`status.${status}`)}
        </span>
      </div>

      <div className="p-4 space-y-3">
        {/* Offer name + price */}
        <div className="flex items-start justify-between gap-3">
          <p className="font-bold text-[#190933] leading-snug">{enrollment.offer_name}</p>
          {formattedPrice && (
            <div className="shrink-0 text-end">
              <p className="font-black text-lg text-[#190933]">
                {formattedPrice}
              </p>
              {isSubscription && (
                <p className="text-xs text-[#6559CA] leading-none">{billingIntervalLabel(enrollment.billing_interval, t)}</p>
              )}
            </div>
          )}
        </div>

        {/* Purchase date */}
        {formattedDate && (
          <div className="flex items-center gap-1.5 text-xs text-gray-400">
            <CalendarDays size={12} />
            <span>{sc('purchases.purchased_on', { date: formattedDate })}</span>
          </div>
        )}

        {/* What this purchase unlocks */}
        {isActive && resources.length > 0 && (
          <div className="space-y-2">
            {resources.map((r: any) => (
              <ResourceLink key={r.resource_uuid ?? r.course_uuid} resource={r} orgslug={orgslug} sc={sc} />
            ))}
          </div>
        )}
        {status === 'refunded' && (
          <p className="text-xs text-gray-500">{sc('purchases.refunded_note')}</p>
        )}

        {offerKey != null && (
          <div className="flex items-center gap-2 pt-1">
            <Link
              href={getUriWithOrg(orgslug, `/store/offers/${offerKey}`)}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#4F43A4] hover:text-[#190933] transition-colors"
            >
              {sc('purchases.view_offer')} <ArrowRight size={11} />
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}

function AccountPurchases({ orgId, orgslug }: AccountPurchasesProps) {
  const session = useLHSession() as any
  const access_token = session?.data?.tokens?.access_token
  const { sc } = useScT()

  const { data: enrollmentsResult, isLoading, error } = useQuery({
    queryKey: ['payments', orgId, 'enrollments', 'mine'],
    queryFn: () => getUserEnrollments(orgId, access_token),
    enabled: !!orgId && !!access_token,
    staleTime: 60_000,
  })

  const enrollments: any[] = (Array.isArray(enrollmentsResult?.data) ? enrollmentsResult.data : [])
    .filter((e: any) => VISIBLE_STATUSES.has(String(e?.status ?? '').toLowerCase()))

  if (isLoading) {
    return (
      <div className="bg-white rounded-xl nice-shadow p-12 flex items-center justify-center">
        <Loader2 size={24} className="animate-spin text-gray-300" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-white rounded-xl nice-shadow p-8 text-center text-sm text-red-400">
        {sc('purchases.load_error')}
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="bg-white rounded-xl nice-shadow p-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#EEEDFF] flex items-center justify-center">
            <ShoppingBag size={18} className="text-[#6559CA]" />
          </div>
          <div>
            <h1 className="font-bold text-[#190933]">{sc('purchases.title')}</h1>
            <p className="text-sm text-gray-400 mt-0.5">
              {sc('purchases.subtitle')}
            </p>
          </div>
        </div>
      </div>

      {/* Enrollment list */}
      {enrollments.length === 0 ? (
        <div className="bg-white rounded-xl nice-shadow p-12 flex flex-col items-center justify-center text-center">
          <div className="w-14 h-14 rounded-2xl bg-[#EEEDFF] flex items-center justify-center mb-4">
            <ShoppingBag size={24} className="text-[#6559CA]" strokeWidth={1.5} />
          </div>
          <h2 className="font-bold text-[#190933] mb-1">{sc('purchases.empty_title')}</h2>
          <p className="text-sm text-gray-400 max-w-xs">
            {sc('purchases.empty_description')}
          </p>
          <Link
            href={getUriWithOrg(orgslug, '/store')}
            className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-white bg-[#190933] hover:bg-[#41375B] transition-colors px-4 py-2 rounded-full"
          >
            {sc('purchases.browse_store')} <ArrowRight size={14} />
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {enrollments.map((enrollment: any) => (
            <EnrollmentCard
              key={enrollment.enrollment_id}
              enrollment={enrollment}
              orgslug={orgslug}
            />
          ))}
          <p className="text-xs text-gray-400 px-1">{sc('purchases.receipts_note')}</p>
        </div>
      )}
    </div>
  )
}

export default AccountPurchases

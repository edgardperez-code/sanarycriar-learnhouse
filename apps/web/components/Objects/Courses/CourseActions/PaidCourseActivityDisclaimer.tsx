'use client'
import React from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { ShoppingBag, Loader2, LogIn } from 'lucide-react'
import { useOrg } from '@components/Contexts/OrgContext'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import { getOffersByResource } from '@services/payments/offers'
import { getUriWithOrg } from '@services/config/config'
import { OfferCard } from './OfferCard'
import { useTranslation } from 'react-i18next'
import { asArray } from '@services/utils/ts/requests'
// Sanar y Criar: same normalized resource uuid and query key as the course
// page (the raw course_uuid used to miss the cache), plus a sign-in link that
// comes back to this activity for buyers who are logged out.
import { useScT } from '@components/Payments/useScT'
import { toCourseResourceUuid, withRedirect } from '@components/Payments/commerce'
import { useCurrentPathname } from '@components/Payments/useAuthRedirect'
// Sanar y Criar: free content locked for anonymous / unverified readers gets
// the sign-up / verify card, never a purchase box.
import { useQueryClient } from '@tanstack/react-query'
import FreeAccessCard from '@components/SanarYCriar/FreeAccessCard'
import { freeGateReason } from '@components/SanarYCriar/freeAccessGate'
import { isEbookCourse } from '@components/SanarYCriar/progressLocal'

interface PaidCourseActivityProps {
  course: any
  /** Sanar y Criar: activity.content.reason from the API ("login_required" | "verify_email"). */
  reason?: string
}

function PaidCourseActivityDisclaimer({ course, reason }: PaidCourseActivityProps) {
  const { t } = useTranslation()
  const { sc } = useScT()
  const org = useOrg() as any
  const session = useLHSession() as any
  const resourceUuid = toCourseResourceUuid(course?.course_uuid)
  const freeGate = freeGateReason({ has_access: false, reason })
  const queryClient = useQueryClient()

  const { data: offersResult, isLoading } = useQuery({
    queryKey: ['offers', 'by-resource', org?.id, resourceUuid],
    queryFn: () => getOffersByResource(org.id, resourceUuid!),
    enabled: !!org?.id && !!resourceUuid && !freeGate,
    staleTime: 60_000,
  })

  const offers: any[] = asArray(offersResult)
  // Null during SSR/hydration so server and client render the same href first.
  const here = useCurrentPathname()

  if (freeGate && resourceUuid) {
    return (
      <div className="max-w-lg mx-auto">
        <FreeAccessCard
          reason={freeGate}
          orgslug={org?.slug}
          coursePath={`/course/${resourceUuid.replace('course_', '')}`}
          isEbook={isEbookCourse(course)}
          // The activity was fetched locked: fetch it again once access is confirmed.
          onAccessGranted={() => queryClient.invalidateQueries({ queryKey: ['activity'] })}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4 max-w-lg mx-auto">
      {/* Notice banner */}
      <div className="flex items-start gap-3 p-4 bg-[#EEEDFF] rounded-[20px]">
        <ShoppingBag className="w-5 h-5 text-[#6559CA] shrink-0 mt-0.5" />
        <div>
          <h3 className="text-[#190933] font-semibold text-sm">{t('payments.paid_content')}</h3>
          <p className="text-[#584F72] text-sm mt-0.5">{t('payments.paid_content_description')}</p>
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={18} className="animate-spin text-gray-300" />
        </div>
      )}

      {!isLoading && offers.length > 0 && (
        <>
          {offers.length > 1 && (
            <p className="text-xs text-gray-400 font-medium px-1">
              {sc('course_actions.options_available', { count: offers.length })}
            </p>
          )}
          <div className="space-y-3">
            {offers.map((offer: any) => (
              <OfferCard key={offer.offer_uuid ?? offer.offer_id} offer={offer} orgslug={org.slug} />
            ))}
          </div>
        </>
      )}

      {!session?.data?.user && (
        <p className="text-xs text-[#584F72] px-1 flex items-center gap-1.5">
          <LogIn className="w-3.5 h-3.5" />
          <span>{sc('course_actions.already_bought')}</span>{' '}
          <Link href={getUriWithOrg(org?.slug, withRedirect('/login', here))} className="font-semibold text-[#4F43A4] underline">
            {sc('course_actions.login')}
          </Link>
        </p>
      )}
    </div>
  )
}

export default PaidCourseActivityDisclaimer

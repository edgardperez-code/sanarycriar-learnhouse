'use client'
import React, { useState } from 'react'
import Link from 'next/link'
import { ArrowRight, RefreshCcw, SquareCheck, Sparkles, ChevronDown, ChevronUp } from 'lucide-react'
import { getUriWithOrg } from '@services/config/config'
import { useLHAnalytics, AnalyticsEvent } from '@services/analytics'
import { useTranslation } from 'react-i18next'
import { formatCurrency } from '@/lib/format'
import { billingIntervalLabel } from '@/lib/payments/billingInterval'
// Sanar y Criar: translated, on-brand card; links by offer_uuid.
import { useScT } from '@components/Payments/useScT'

interface OfferCardProps {
  offer: {
    offer_id: number
    offer_uuid: string
    offer_name: string
    description?: string
    offer_type: 'subscription' | 'one_time'
    price_type?: string
    billing_interval?: string
    amount: number
    currency: string
    benefits?: string
  }
  orgslug: string
}

export function OfferCard({ offer, orgslug }: OfferCardProps) {
  const { t } = useTranslation()
  const { sc, lng } = useScT()
  const { track } = useLHAnalytics('learner')
  const [expanded, setExpanded] = useState(false)
  const isSubscription = offer.offer_type === 'subscription'
  const benefits: string[] = offer.benefits
    ? offer.benefits.split(',').map((b) => b.trim()).filter(Boolean)
    : []

  const formattedPrice = formatCurrency(Number(offer.amount), offer.currency ?? 'USD', lng)
  const offerKey = offer.offer_uuid || String(offer.offer_id)

  return (
    <div className="bg-white rounded-[20px] nice-shadow overflow-hidden border border-[#EAE8F2]">
      {/* Type stripe */}
      <div className="px-4 py-2 flex items-center gap-2 bg-[#EEEDFF]">
        {isSubscription
          ? <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#4F43A4]"><RefreshCcw size={11} /> {sc('offer_card.subscription')}</span>
          : <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#4F43A4]"><SquareCheck size={11} /> {sc('offer_card.one_time')}</span>
        }
      </div>

      <div className="p-4">
        {/* Name + price */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="font-bold text-[#190933] text-base leading-snug">{offer.offer_name}</p>
            {offer.description && (
              <p className="text-sm text-[#584F72] mt-1 leading-relaxed line-clamp-2">{offer.description}</p>
            )}
          </div>
          <div className="shrink-0 text-end">
            <div className="text-xl font-black text-[#190933]">
              {formattedPrice}
            </div>
            {offer.price_type === 'customer_choice' && (
              <p className="text-xs text-gray-400 leading-none">{sc('offer_card.minimum')}</p>
            )}
            {isSubscription && (
              <p className="text-xs text-[#6559CA] leading-none font-medium">{billingIntervalLabel(offer.billing_interval, t)}</p>
            )}
          </div>
        </div>

        {/* Benefits */}
        {benefits.length > 0 && (
          <div className="mt-3">
            <div className={`space-y-1.5 overflow-hidden transition-all ${expanded ? '' : 'max-h-[3.5rem]'}`}>
              {benefits.map((b, i) => (
                <div key={i} className="flex items-start gap-2 text-xs text-[#584F72]">
                  <Sparkles size={10} className="text-[#7D75E2] mt-0.5 shrink-0" />
                  <span>{b}</span>
                </div>
              ))}
            </div>
            {benefits.length > 2 && (
              <button
                onClick={() => setExpanded(v => !v)}
                className="mt-1 flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 transition-colors"
              >
                {expanded
                  ? <><ChevronUp size={12} /> {sc('common.show_less')}</>
                  : <><ChevronDown size={12} /> {sc('offer_card.more_benefits', { count: benefits.length - 2 })}</>
                }
              </button>
            )}
          </div>
        )}

        {/* CTA */}
        <Link
          href={getUriWithOrg(orgslug, `/store/offers/${offerKey}`)}
          onClick={() => track(AnalyticsEvent.CourseOfferCtaClicked, {
            offer_uuid: offer.offer_uuid,
            offer_type: offer.offer_type,
            amount: offer.amount,
            currency: offer.currency,
          })}
        >
          <div className="mt-4 w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-full font-semibold text-sm transition-colors cursor-pointer bg-[#190933] hover:bg-[#41375B] text-white">
            {sc('offer_card.cta', { price: formattedPrice })}
            <ArrowRight size={13} />
          </div>
        </Link>
      </div>
    </div>
  )
}

'use client'
// Sanar y Criar: translated, on-brand storefront with course/ebook labels.
import React from 'react'
import { useTranslation } from 'react-i18next'
import { formatCurrency } from '@/lib/format'
import { billingIntervalLabel } from '@/lib/payments/billingInterval'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import GeneralWrapperStyled from '@components/Objects/StyledElements/Wrappers/GeneralWrapper'
import { getUriWithOrg } from '@services/config/config'
import { ShoppingBag, RefreshCcw, SquareCheck, ArrowRight, Sparkles, BookOpen, BookMarked, Mic, Puzzle } from 'lucide-react'
import { useOrg } from '@components/Contexts/OrgContext'
import { useLHAnalytics, useTrackView, AnalyticsEvent } from '@services/analytics'
import { useScT } from '@components/Payments/useScT'
import { cssUrl, normalizeProductType, resourceThumbnail } from '@components/Payments/commerce'

interface Resource {
  resource_uuid: string
  resource_type: string
  name: string
  description: string
  thumbnail_image: string
  org_uuid: string
  // Sanar y Criar additions to PublicOffer.included_resources
  product_type?: 'course' | 'ebook'
  course_uuid?: string
  thumbnail_url?: string | null
}

interface Offer {
  id: number
  offer_uuid: string
  name: string
  description: string
  offer_type: 'one_time' | 'subscription'
  billing_interval?: string
  price_type: 'fixed_price' | 'customer_choice'
  amount: number
  currency: string
  benefits: string
  payments_group_id: number | null
  included_resources: Resource[]
}

interface StoreProps {
  orgslug: string
  offers: Offer[]
}

function stripTypePrefix(uuid: string): string {
  return uuid.replace(/^[a-z]+_/, '')
}

function getResourceUrl(orgslug: string, resource: Resource): string | null {
  const id = stripTypePrefix(resource.resource_uuid)
  switch (resource.resource_type) {
    case 'course': return getUriWithOrg(orgslug, `/course/${id}`)
    case 'podcast': return getUriWithOrg(orgslug, `/podcast/${id}`)
    case 'playground': return getUriWithOrg(orgslug, `/playground/${id}`)
    default: return null
  }
}

function resourceIcon(resource: Resource) {
  switch (resource.resource_type) {
    case 'course':
      return normalizeProductType(resource.product_type) === 'ebook'
        ? <BookMarked size={12} className="text-[#AC4691]" />
        : <BookOpen size={12} className="text-[#6559CA]" />
    case 'podcast': return <Mic size={12} className="text-pink-400" />
    default: return <Puzzle size={12} className="text-gray-300" />
  }
}

function CourseBoxes({ resources, orgUuid }: { resources: Resource[]; orgUuid: string }) {
  const items = resources.slice(0, 3)
  if (items.length === 0) return null
  return (
    <div className="flex -space-x-8 items-center justify-center w-full">
      {items.map((r, index) => {
        const src = resourceThumbnail(r, orgUuid)
        return (
          <div
            key={r.resource_uuid}
            className="relative h-20 w-32 overflow-hidden rounded-lg border-2 border-white shadow-lg shrink-0 bg-[#EEEDFF]"
            style={{
              backgroundImage: src ? cssUrl(src) : undefined,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              zIndex: 3 - index,
            }}
          >
            {!src && (
              <div className="w-full h-full flex items-center justify-center">
                {resourceIcon(r)}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function OfferCard({ offer, orgslug, orgUuid, position }: { offer: Offer; orgslug: string; orgUuid: string; position: number }) {
  const { t } = useTranslation()
  const { sc, lng } = useScT()
  const isSubscription = offer.offer_type === 'subscription'
  const benefits = offer.benefits ? offer.benefits.split(',').map(b => b.trim()).filter(Boolean) : []
  const resources = offer.included_resources ?? []
  const { track } = useLHAnalytics('learner')
  const router = useRouter()
  const onlyEbooks = resources.length > 0 && resources.every((r) => normalizeProductType(r.product_type) === 'ebook')

  return (
    <Link
      href={getUriWithOrg(orgslug, `/store/offers/${offer.offer_uuid}`)}
      onClick={() => track(AnalyticsEvent.StoreOfferCardClicked, { offer_type: offer.offer_type, amount: offer.amount, position })}
    >
      <div className="group bg-white rounded-[20px] nice-shadow overflow-hidden flex flex-col h-full cursor-pointer transition-all duration-200 hover:scale-[1.01] border border-[#EAE8F2]">

        {/* Thumbnail area */}
        <div className="relative aspect-video overflow-hidden flex items-center justify-center bg-[#EEEDFF]">
          {resources.length > 0 ? (
            <div className="p-4 w-full">
              <CourseBoxes resources={resources} orgUuid={orgUuid} />
            </div>
          ) : (
            <ShoppingBag size={28} className="text-[#BBBBFF]" strokeWidth={1.5} />
          )}

          {/* Type badge */}
          <div className="absolute top-2.5 start-2.5">
            {isSubscription ? (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-white bg-[#190933]/90 backdrop-blur-sm rounded-full px-2.5 py-0.5">
                <RefreshCcw size={10} /> {sc('offer_card.subscription')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#190933] bg-white/90 backdrop-blur-sm rounded-full px-2.5 py-0.5">
                {onlyEbooks ? <BookMarked size={10} /> : <SquareCheck size={10} />}
                {onlyEbooks ? sc('product.ebook') : sc('store.one_time_badge')}
              </span>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="p-4 flex flex-col flex-1 gap-2">
          <h2 className="font-bold text-base text-[#190933] leading-snug group-hover:text-[#4F43A4] transition-colors">
            {offer.name}
          </h2>
          <p className="text-sm text-[#584F72] line-clamp-2 leading-relaxed">{offer.description}</p>

          {/* Included resources list */}
          {resources.length > 0 && (
            <div className="space-y-1 mt-0.5">
              {resources.slice(0, 2).map(r => {
                const url = getResourceUrl(orgslug, r)
                const inner = (
                  <>
                    {resourceIcon(r)}
                    <span className="truncate">{r.name}</span>
                  </>
                )
                // The whole card is already a link, and an <a> can't nest
                // inside another one, so resource links navigate by script.
                const openResource = (e: React.SyntheticEvent) => {
                  e.preventDefault()
                  e.stopPropagation()
                  router.push(url!)
                }
                return url ? (
                  <span
                    key={r.resource_uuid}
                    role="link"
                    tabIndex={0}
                    onClick={openResource}
                    onKeyDown={e => { if (e.key === 'Enter') openResource(e) }}
                    className="flex items-center gap-2 text-xs text-[#584F72] hover:text-[#4F43A4] transition-colors"
                  >
                    {inner}
                  </span>
                ) : (
                  <div key={r.resource_uuid} className="flex items-center gap-2 text-xs text-[#584F72]">
                    {inner}
                  </div>
                )
              })}
              {resources.length > 2 && (
                <p className="text-xs text-gray-400">{sc('store.more_included', { count: resources.length - 2 })}</p>
              )}
            </div>
          )}

          {benefits.length > 0 && (
            <div className="space-y-1">
              {benefits.slice(0, 2).map((b, i) => (
                <div key={i} className="flex items-start gap-1.5 text-xs text-gray-500">
                  <Sparkles size={10} className="text-[#7D75E2] mt-0.5 shrink-0" />
                  <span className="truncate">{b}</span>
                </div>
              ))}
            </div>
          )}

          {/* Price + CTA */}
          <div className="mt-auto pt-3 border-t border-[#EAE8F2] flex items-center justify-between">
            <div>
              <div className="text-xl font-black text-[#190933]">
                {formatCurrency(Number(offer.amount), offer.currency, lng)}
              </div>
              {offer.price_type === 'customer_choice' && (
                <p className="text-xs text-gray-400 leading-none">{sc('offer_card.minimum')}</p>
              )}
              {isSubscription && (
                <p className="text-xs text-[#6559CA] leading-none font-medium">{billingIntervalLabel(offer.billing_interval, t)}</p>
              )}
            </div>
            <div className="flex items-center gap-1.5 text-sm font-semibold px-4 py-2 rounded-full transition-colors bg-[#190933] text-white group-hover:bg-[#41375B]">
              {sc('store.see_details')}
              <ArrowRight size={13} />
            </div>
          </div>
        </div>
      </div>
    </Link>
  )
}

function Store({ orgslug, offers }: StoreProps) {
  const org = useOrg() as any
  const { sc } = useScT()

  useTrackView(AnalyticsEvent.StoreViewed, { offers_count: offers.length, is_empty: offers.length === 0 }, true, 'learner')

  return (
    <div className="w-full">
      <GeneralWrapperStyled>
        <div className="flex items-center gap-3 my-6">
          <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-[#EEEDFF]">
            <ShoppingBag size={18} className="text-[#190933]" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-[#190933] tracking-tight">{sc('store.title')}</h1>
            {org?.name && (
              <p className="text-sm text-[#584F72] mt-0.5">{sc('store.subtitle', { name: org.name })}</p>
            )}
          </div>
        </div>

        {offers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-2xl bg-[#EEEDFF] flex items-center justify-center mb-4">
              <ShoppingBag size={28} className="text-[#6559CA]" strokeWidth={1.5} />
            </div>
            <h2 className="text-xl font-bold text-[#190933] mb-2">{sc('store.empty_title')}</h2>
            <p className="text-[#584F72] text-sm max-w-sm">
              {sc('store.empty_description')}
            </p>
          </div>
        ) : (
          <>
            <p className="text-sm text-gray-400 mb-5">
              {sc('store.count', { count: offers.length })}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {offers.map((offer, index) => (
                <OfferCard key={offer.id ?? offer.offer_uuid} offer={offer} orgslug={orgslug} orgUuid={org?.org_uuid ?? ''} position={index} />
              ))}
            </div>
          </>
        )}
      </GeneralWrapperStyled>
    </div>
  )
}

export default Store

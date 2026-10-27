'use client'
// Sanar y Criar: offer page with a provider-agnostic redirect checkout.
//
// - One button per active provider/method ("Pagar con PayPal", "Pagar con
//   tarjeta (vía PayPal)"), no provider JS SDK: the backend returns the
//   provider's approval URL and the browser goes there.
// - Logged-out visitors get a signup/login card that comes back here.
// - The provider sends the buyer back to this same page with
//   ?checkout=return|cancelled&order=<order_uuid>; we capture the order
//   (idempotent), poll while it is pending, and show the result.
// Contract: docs/spec-tecnica.md sections 2.3 and 4.1.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatCurrency } from '@/lib/format'
import { queryKeys } from '@/lib/query/keys'
import GeneralWrapperStyled from '@components/Objects/StyledElements/Wrappers/GeneralWrapper'
import { getUriWithOrg } from '@services/config/config'
import { getUserEnrollments } from '@services/payments/offers'
import {
  captureOrder,
  cancelOrder,
  getOrderStatus,
  startOfferCheckout,
  CheckoutMethod,
} from '@services/payments/checkout'
import { revalidateTags } from '@services/utils/ts/requests'
import { safeExternalUrl } from '@services/security/url'
import {
  ArrowLeft, ArrowRight, SquareCheck, Sparkles, BookOpen, BookMarked,
  Mic, Puzzle, AlertCircle, Loader2, ShieldCheck, Zap, CheckCircle2,
  Clock, XCircle, CreditCard, UserPlus, LogIn, Smartphone,
} from 'lucide-react'
import { SiPaypal } from '@icons-pack/react-simple-icons'
import toast from 'react-hot-toast'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import { useLHAnalytics, useTrackView, AnalyticsEvent } from '@services/analytics'
import { useScT, ScTranslate } from '@components/Payments/useScT'
import { useCheckoutProviders, CheckoutProvider } from '@components/Payments/useCheckoutProviders'
import {
  CHECKOUT_RETURN_PARAMS,
  cleanCheckoutUrl,
  cssUrl,
  describePaymentError,
  errorCode,
  errorField,
  normalizeProductType,
  providerLabel,
  resourceThumbnail,
  stripCoursePrefix,
  withRedirect,
} from '@components/Payments/commerce'
// Sanar y Criar: Pago Móvil is paid from the cart (contract §D.3).
import { AddToCartButton } from '@components/Store/Cart/AddToCartButton'
import { useCart } from '@components/Store/Cart/useCart'
import { useCartT } from '@components/Store/Cart/useCartT'

interface Resource {
  resource_uuid: string
  resource_type: string
  name: string
  description?: string
  thumbnail_image?: string
  org_uuid?: string
  product_type?: 'course' | 'ebook'
  course_uuid?: string
  thumbnail_url?: string | null
  first_activity_uuid?: string | null
}

interface OfferDetailClientProps {
  orgslug: string
  orgId: number
  offerUuid: string
  offer: any
  access_token: string | null
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'confirming' }
  | { kind: 'success'; resources: Resource[] }
  | { kind: 'pending'; timedOut: boolean }
  | { kind: 'cancelled' }
  | { kind: 'failed' }
  | { kind: 'declined' }
  | { kind: 'error'; message: string }

const POLL_INTERVAL_MS = 5_000
const POLL_MAX_MS = 120_000
const OWNED_STATUSES = new Set(['active', 'completed'])

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function resourceIcon(resource: Resource, size = 14) {
  switch (resource.resource_type) {
    case 'course':
      return normalizeProductType(resource.product_type) === 'ebook'
        ? <BookMarked size={size} className="text-[#AC4691]" />
        : <BookOpen size={size} className="text-[#6559CA]" />
    case 'podcast': return <Mic size={size} className="text-pink-400" />
    default: return <Puzzle size={size} className="text-gray-400" />
  }
}

/** Course page of a purchased resource (the course/ebook page knows what to show next). */
function resourceHref(orgslug: string, resource: Resource): string | null {
  if (resource.resource_type && resource.resource_type !== 'course') return null
  const uuid = stripCoursePrefix(resource.course_uuid ?? resource.resource_uuid)
  return uuid ? getUriWithOrg(orgslug, `/course/${uuid}`) : null
}

function ResourceCard({ resource, orgslug, orgUuid, sc }: { resource: Resource; orgslug: string; orgUuid?: string; sc: ScTranslate }) {
  const src = resourceThumbnail(resource, orgUuid)
  const url = resourceHref(orgslug, resource)
  const isEbook = normalizeProductType(resource.product_type) === 'ebook'
  const card = (
    <div className={`bg-white rounded-[20px] nice-shadow overflow-hidden flex flex-col h-full border border-[#EAE8F2] ${url ? 'hover:scale-[1.01] transition-transform duration-150' : ''}`}>
      <div
        className="relative w-full aspect-video overflow-hidden bg-[#EEEDFF]"
        style={{
          backgroundImage: src ? cssUrl(src) : undefined,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}
      >
        {!src && (
          <div className="w-full h-full flex items-center justify-center">
            {resourceIcon(resource, 28)}
          </div>
        )}
        <span className="absolute top-2 start-2 inline-flex items-center gap-1 text-xs font-semibold text-[#190933] bg-white/90 rounded-full px-2.5 py-0.5">
          {resourceIcon(resource, 10)}
          {isEbook ? sc('product.ebook') : sc('product.course')}
        </span>
      </div>
      <div className="p-3 flex flex-col gap-1">
        <p className="font-semibold text-sm text-[#190933] leading-snug">{resource.name}</p>
        {resource.description && (
          <p className="text-xs text-[#584F72] leading-relaxed line-clamp-2">{resource.description}</p>
        )}
      </div>
    </div>
  )
  return url ? <Link href={url}>{card}</Link> : card
}

/** "Ir al curso" / "Leer ebook" buttons for resources the buyer now owns. */
function OwnedResourceLinks({ resources, orgslug, sc }: { resources: Resource[]; orgslug: string; sc: ScTranslate }) {
  const links = resources
    .map((r) => ({ r, href: resourceHref(orgslug, r) }))
    .filter((x): x is { r: Resource; href: string } => !!x.href)
  if (links.length === 0) return null
  return (
    <div className="space-y-2">
      {links.map(({ r, href }) => {
        const isEbook = normalizeProductType(r.product_type) === 'ebook'
        return (
          <Link
            key={r.resource_uuid ?? href}
            href={href}
            className="flex items-center justify-between gap-3 bg-white border border-[#EAE8F2] rounded-full ps-4 pe-1.5 py-1.5 hover:bg-[#FFFCF9] transition-colors"
          >
            <span className="flex items-center gap-2 min-w-0">
              {resourceIcon(r, 14)}
              <span className="text-sm font-medium text-[#190933] truncate">{r.name}</span>
            </span>
            <span className="shrink-0 inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-[#190933] rounded-full px-3 py-1.5">
              {isEbook ? sc('offer_page.read_ebook') : sc('offer_page.go_to_course')}
              <ArrowRight size={12} />
            </span>
          </Link>
        )
      })}
    </div>
  )
}

function StatusPanel({
  tone, icon, title, description, children,
}: {
  tone: 'info' | 'success' | 'warning' | 'error'
  icon: React.ReactNode
  title: string
  description?: string
  children?: React.ReactNode
}) {
  const toneCls = {
    info: 'bg-[#EEEDFF] border-[#BBBBFF]',
    success: 'bg-[#EEEDFF] border-[#BBBBFF]',
    warning: 'bg-amber-50 border-amber-200',
    error: 'bg-red-50 border-red-200',
  }[tone]
  return (
    <div role="status" aria-live="polite" className={`rounded-[20px] border p-5 mb-7 ${toneCls}`}>
      <div className="flex items-start gap-3">
        <div className="shrink-0 mt-0.5">{icon}</div>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h2 className="font-bold text-[#190933] text-lg leading-snug">{title}</h2>
            {description && <p className="text-sm text-[#41375B] mt-1 leading-relaxed">{description}</p>}
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}

function methodIcon(provider: string, method: string) {
  if (method === 'card') return <CreditCard size={16} />
  if (provider === 'paypal') return <SiPaypal size={15} />
  if (provider === 'spidi' || method === 'pago_movil') return <Smartphone size={16} />
  return <ShieldCheck size={16} />
}

function methodLabel(provider: CheckoutProvider, method: string, sc: ScTranslate): string {
  const id = provider.provider.toLowerCase()
  if (id === 'paypal' && method === 'paypal') return sc('offer_page.pay_with_paypal')
  if (id === 'paypal' && method === 'card') return sc('offer_page.pay_with_card')
  return sc('offer_page.pay_with_provider', { provider: provider.label || providerLabel(id, sc) })
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OfferDetailClient({ orgslug, orgId, offerUuid, offer, access_token }: OfferDetailClientProps) {
  const { sc, lng } = useScT()
  const session = useLHSession() as any
  const token: string | null = session?.data?.tokens?.access_token ?? access_token ?? null
  const router = useRouter()
  const queryClient = useQueryClient()
  const { track } = useLHAnalytics('learner')

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [orderUuid, setOrderUuid] = useState<string | null>(null)
  const [starting, setStarting] = useState<string | null>(null)
  const [checkoutError, setCheckoutError] = useState<string | null>(null)
  const [alreadyOwned, setAlreadyOwned] = useState(false)
  const handledReturnRef = useRef(false)

  const canonicalUuid: string = offer?.offer_uuid ?? offerUuid
  const offerPath = `/store/offers/${canonicalUuid}`

  useTrackView(
    AnalyticsEvent.OfferViewed,
    {
      offer_type: offer?.offer_type,
      included_resources_count: offer?.included_resources?.length ?? 0,
      is_authenticated: !!token,
    },
    !!offer,
    'learner',
  )

  // Providers able to charge this offer's currency.
  const { providers, isLoading: providersLoading } = useCheckoutProviders(orgId)
  const currency = String(offer?.currency || 'USD').toUpperCase()
  const chargesCurrency = useCallback(
    (p: CheckoutProvider) => p.currencies.length === 0 || p.currencies.map((c) => c.toUpperCase()).includes(currency),
    [currency]
  )
  // Sanar y Criar: "manual" (Pago Móvil) never gets a direct-checkout button:
  // it is paid from the cart, and the offer checkout answers 400 for it.
  const payButtons = useMemo(
    () =>
      providers
        .filter((p) => p.provider.toLowerCase() !== 'manual')
        .filter(chargesCurrency)
        .flatMap((p) => (p.methods.length ? p.methods : ['paypal']).map((method) => ({ provider: p, method }))),
    [providers, chargesCurrency]
  )
  const hasManual =
    offer?.offer_type !== 'subscription' &&
    providers.some((p) => p.provider.toLowerCase() === 'manual' && chargesCurrency(p))
  const { ct } = useCartT()
  const cart = useCart(orgId)
  const [pendingPurchase, setPendingPurchase] = useState<{ uuid: string; code: string } | null>(null)

  // Does the buyer already own this offer?
  const { data: enrollmentsResult } = useQuery({
    queryKey: ['payments', orgId, 'enrollments', 'mine'],
    queryFn: () => getUserEnrollments(orgId, token as string),
    enabled: !!orgId && !!token && !!offer,
    staleTime: 30_000,
    retry: false,
  })
  const offerId = offer?.id
  const ownsOffer = useMemo(() => {
    const list: any[] = Array.isArray(enrollmentsResult?.data) ? enrollmentsResult.data : []
    return list.some(
      (e) =>
        OWNED_STATUSES.has(String(e?.status ?? '').toLowerCase()) &&
        (e?.offer_uuid === canonicalUuid || (offerId != null && String(e?.offer_id) === String(offerId)))
    )
  }, [enrollmentsResult, canonicalUuid, offerId])

  // Everything that depends on "is it mine" (course actions, paywall, purchases).
  const refreshOwnership = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['payments', orgId] })
    queryClient.invalidateQueries({ queryKey: ['offers', 'by-resource'] })
    queryClient.invalidateQueries({ queryKey: queryKeys.trail.org(orgId) })
    revalidateTags(['courses'], orgslug).catch(() => {})
    router.refresh()
  }, [queryClient, orgId, orgslug, router])

  const dropReturnParams = useCallback(() => {
    try {
      const url = new URL(window.location.href)
      CHECKOUT_RETURN_PARAMS.forEach((p) => url.searchParams.delete(p))
      // A null state lets Next.js sync its router with the new URL; reusing
      // its own history state bypassed that, and the next server action put
      // the old ?checkout=…&order=… back in the address bar.
      window.history.replaceState(null, '', url.pathname + url.search + url.hash)
    } catch {
      /* cosmetic only */
    }
  }, [])

  const applyOrderResult = useCallback(
    (data: any): Phase['kind'] => {
      const status = String(data?.status ?? '').toLowerCase()
      switch (status) {
        case 'paid':
        case 'accredited': {
          const fromOrder: Resource[] = Array.isArray(data?.resources) ? data.resources : []
          setPhase({ kind: 'success', resources: fromOrder.length ? fromOrder : (offer?.included_resources ?? []) })
          dropReturnParams()
          refreshOwnership()
          return 'success'
        }
        case 'pending':
        case 'approved':
          setPhase({ kind: 'pending', timedOut: false })
          return 'pending'
        case 'retry':
          setPhase({ kind: 'declined' })
          dropReturnParams()
          return 'declined'
        case 'cancelled':
          setPhase({ kind: 'cancelled' })
          dropReturnParams()
          return 'cancelled'
        default:
          // failed, expired, refunded or anything unexpected
          setPhase({ kind: 'failed' })
          dropReturnParams()
          return 'failed'
      }
    },
    [offer, dropReturnParams, refreshOwnership]
  )

  // Coming back from the provider.
  useEffect(() => {
    // Not gated on `offer`: an order for an offer archived meanwhile must
    // still be captured.
    if (handledReturnRef.current) return
    const params = new URLSearchParams(window.location.search)
    const checkout = params.get('checkout')
    const order = params.get('order')
    if (!checkout || !order) return
    handledReturnRef.current = true
    setOrderUuid(order)

    if (checkout === 'cancelled') {
      setPhase({ kind: 'cancelled' })
      dropReturnParams()
      track(AnalyticsEvent.CheckoutReturned, { result: 'cancelled' })
      if (token) cancelOrder(orgId, order, token).catch(() => {})
      return
    }
    if (checkout !== 'return') return

    setPhase({ kind: 'confirming' })
    ;(async () => {
      try {
        const res = await captureOrder(orgId, order, token)
        if (res.success) {
          const kind = applyOrderResult(res.data)
          track(AnalyticsEvent.CheckoutReturned, { result: kind })
          return
        }
        if (res.status === 409 && errorCode(res.data) === 'ALREADY_OWNED') {
          setAlreadyOwned(true)
          setPhase({ kind: 'idle' })
          dropReturnParams()
          refreshOwnership()
          return
        }
        track(AnalyticsEvent.CheckoutReturned, { result: 'error', status: res.status })
        setPhase({
          kind: 'error',
          message: res.status === 404 ? sc('offer_page.order_not_found') : describePaymentError(res.data, sc, 'errors.generic'),
        })
      } catch {
        setPhase({ kind: 'error', message: sc('errors.generic') })
      }
    })()
    // Runs once per page load; the ref guards re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offer])

  // Pending: poll the order until it settles (or give up after two minutes).
  // Without a session the order cannot be read back: show the 'we will email you' state.
  const pendingTimedOut = phase.kind === 'pending' && (phase.timedOut || !token)
  const isPending = phase.kind === 'pending' && !pendingTimedOut
  useEffect(() => {
    if (!isPending || !orderUuid || !token) return
    const startedAt = Date.now()
    let cancelled = false
    const timer = window.setInterval(async () => {
      if (cancelled) return
      if (Date.now() - startedAt >= POLL_MAX_MS) {
        window.clearInterval(timer)
        setPhase({ kind: 'pending', timedOut: true })
        return
      }
      try {
        const res = await getOrderStatus(orgId, orderUuid, token)
        if (cancelled || !res.success) return
        const status = String(res.data?.status ?? '').toLowerCase()
        if (status !== 'pending' && status !== 'approved') {
          window.clearInterval(timer)
          applyOrderResult(res.data)
        }
      } catch {
        /* keep polling */
      }
    }, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [isPending, orderUuid, token, orgId, applyOrderResult])

  // Back button from the provider can restore this page from the bfcache with
  // the spinner still on.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setStarting(null)
    }
    window.addEventListener('pageshow', onShow)
    return () => window.removeEventListener('pageshow', onShow)
  }, [])

  const startCheckout = async (provider: CheckoutProvider, method: string) => {
    if (!token) {
      router.push(getUriWithOrg(orgslug, withRedirect('/login', offerPath)))
      return
    }
    const key = `${provider.provider}:${method}`
    setStarting(key)
    setCheckoutError(null)
    track(AnalyticsEvent.OfferCheckoutStarted, {
      offer_uuid: canonicalUuid,
      offer_type: offer.offer_type,
      amount: offer.amount,
      currency: offer.currency,
      provider: provider.provider,
      method,
    })
    try {
      const res = await startOfferCheckout(
        orgId,
        canonicalUuid,
        { redirect_uri: cleanCheckoutUrl(window.location.href), provider: provider.provider, method: method as CheckoutMethod },
        token
      )
      // Only an http(s) approval URL is followed (never javascript:, etc.).
      const url = res.success ? safeExternalUrl(res.data?.checkout_url) : null
      if (url) {
        track(AnalyticsEvent.CheckoutSessionCreated, { offer_type: offer.offer_type, amount: offer.amount, provider: provider.provider, method })
        window.location.assign(url)
        return // keep the spinner while the browser leaves
      }
      setStarting(null)
      if (res.status === 409 && errorCode(res.data) === 'ALREADY_OWNED') {
        setAlreadyOwned(true)
        refreshOwnership()
        return
      }
      // Sanar y Criar: the open payment belongs to a Pago Móvil order: point
      // to that order (it is confirmed by hand, polling it here is useless).
      const pendingPurchaseUuid = res.status === 409 && errorCode(res.data) === 'PAYMENT_PENDING'
        ? errorField(res.data, 'purchase_uuid')
        : null
      if (pendingPurchaseUuid) {
        setPendingPurchase({ uuid: pendingPurchaseUuid, code: errorField(res.data, 'purchase_code') ?? '' })
        return
      }
      // Sanar y Criar: a payment of this offer is still under review; show
      // (and poll) that order instead of opening a second charge.
      const pendingOrder = res.status === 409 && errorCode(res.data) === 'PAYMENT_PENDING'
        ? errorField(res.data, 'order_uuid')
        : null
      if (pendingOrder) {
        setOrderUuid(pendingOrder)
        setPhase({ kind: 'pending', timedOut: false })
        return
      }
      track(AnalyticsEvent.CheckoutSessionFailed, { failure_reason: res.success ? 'no_checkout_url' : `http_${res.status}` })
      setCheckoutError(res.status === 401 ? sc('offer_page.session_expired') : describePaymentError(res.data, sc, 'offer_page.start_error'))
    } catch {
      setStarting(null)
      track(AnalyticsEvent.CheckoutSessionFailed, { failure_reason: 'exception' })
      setCheckoutError(sc('offer_page.start_error'))
    }
  }

  // Sanar y Criar: "Comprar ahora" = add to the cart and open it (no session
  // needed yet: the cart asks for it when paying).
  const buyNow = () => {
    const result = cart.add(canonicalUuid)
    if (result === 'full') {
      toast.error(ct('add.full'))
      return
    }
    if (result === 'invalid') {
      toast.error(ct('add.invalid'))
      return
    }
    router.push(getUriWithOrg(orgslug, '/store/cart'))
  }

  const benefits: string[] = offer?.benefits
    ? String(offer.benefits).split(',').map((b: string) => b.trim()).filter(Boolean)
    : []
  const resources: Resource[] = Array.isArray(offer?.included_resources) ? offer.included_resources : []
  const formattedPrice = formatCurrency(Number(offer?.amount ?? 0), currency, lng)
  const owned = ownsOffer || alreadyOwned || phase.kind === 'success'
  const busy = phase.kind === 'confirming' || isPending
  const signupHref = getUriWithOrg(orgslug, withRedirect('/signup', offerPath))
  const loginHref = getUriWithOrg(orgslug, withRedirect('/login', offerPath))
  const purchasesHref = getUriWithOrg(orgslug, '/account/purchases')

  // -------------------------------------------------------------------------
  // Return-from-checkout panel
  // -------------------------------------------------------------------------
  const renderPhase = () => {
    switch (phase.kind) {
      case 'confirming':
        return (
          <StatusPanel
            tone="info"
            icon={<Loader2 size={22} className="animate-spin text-[#6559CA]" />}
            title={sc('offer_page.confirming_title')}
            description={sc('offer_page.confirming_description')}
          />
        )
      case 'success':
        return (
          <StatusPanel
            tone="success"
            icon={<CheckCircle2 size={24} className="text-[#6559CA]" />}
            title={sc('offer_page.success_title')}
            description={sc('offer_page.success_description')}
          >
            <OwnedResourceLinks resources={phase.resources} orgslug={orgslug} sc={sc} />
            <Link href={purchasesHref} className="inline-block text-sm font-semibold text-[#4F43A4] underline">
              {sc('offer_page.my_purchases')}
            </Link>
          </StatusPanel>
        )
      case 'pending':
        return (
          <StatusPanel
            tone="warning"
            icon={pendingTimedOut ? <Clock size={22} className="text-amber-600" /> : <Loader2 size={22} className="animate-spin text-amber-600" />}
            title={sc('offer_page.pending_title')}
            description={pendingTimedOut ? sc('offer_page.pending_timeout') : sc('offer_page.pending_description')}
          >
            {pendingTimedOut && (
              <Link href={purchasesHref} className="inline-block text-sm font-semibold text-[#4F43A4] underline">
                {sc('offer_page.my_purchases')}
              </Link>
            )}
          </StatusPanel>
        )
      case 'cancelled':
        return (
          <StatusPanel
            tone="info"
            icon={<XCircle size={22} className="text-[#6559CA]" />}
            title={sc('offer_page.cancelled_title')}
            description={sc('offer_page.cancelled_description')}
          />
        )
      case 'declined':
        return (
          <StatusPanel
            tone="warning"
            icon={<CreditCard size={22} className="text-amber-600" />}
            title={sc('offer_page.declined_title')}
            description={sc('offer_page.declined_description')}
          />
        )
      case 'failed':
        return (
          <StatusPanel
            tone="error"
            icon={<AlertCircle size={22} className="text-red-500" />}
            title={sc('offer_page.failed_title')}
            description={sc('offer_page.failed_description')}
          />
        )
      case 'error':
        return (
          <StatusPanel
            tone="error"
            icon={<AlertCircle size={22} className="text-red-500" />}
            title={sc('offer_page.error_title')}
            description={phase.message}
          >
            <Link href={purchasesHref} className="inline-block text-sm font-semibold text-[#4F43A4] underline">
              {sc('offer_page.my_purchases')}
            </Link>
          </StatusPanel>
        )
      default:
        return null
    }
  }

  // -------------------------------------------------------------------------
  // Not found (archived or unlisted). A buyer may still be coming back from
  // the provider for it, so the return panel shows here too.
  // -------------------------------------------------------------------------
  if (!offer) {
    return (
      <GeneralWrapperStyled>
        {renderPhase()}
        <div className="flex flex-col items-center justify-center py-24 text-center px-4">
          <div className="w-14 h-14 rounded-2xl bg-[#EEEDFF] flex items-center justify-center mb-4">
            <AlertCircle size={26} className="text-[#6559CA]" />
          </div>
          <h1 className="font-bold text-[#190933] text-xl">{sc('offer_page.not_found_title')}</h1>
          <p className="text-sm text-[#584F72] mt-1 max-w-sm">{sc('offer_page.not_found_description')}</p>
          <Link
            href={getUriWithOrg(orgslug, '/store')}
            className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-white bg-[#190933] hover:bg-[#41375B] transition-colors px-5 py-2.5 rounded-full"
          >
            <ArrowLeft size={14} /> {sc('offer_page.back_to_store')}
          </Link>
        </div>
      </GeneralWrapperStyled>
    )
  }

  // -------------------------------------------------------------------------
  // Pricing card: checkout / guest / owned
  // -------------------------------------------------------------------------
  const renderPurchaseBox = () => {
    if (owned && phase.kind !== 'success') {
      return (
        <div className="space-y-3">
          <div className="p-4 bg-[#EEEDFF] rounded-[20px]">
            <div className="flex items-center gap-2">
              <CheckCircle2 size={18} className="text-[#6559CA] shrink-0" />
              <p className="font-semibold text-[#190933] text-sm">{sc('offer_page.owned_title')}</p>
            </div>
            <p className="text-xs text-[#584F72] mt-1">{sc('offer_page.owned_description')}</p>
          </div>
          <OwnedResourceLinks resources={resources} orgslug={orgslug} sc={sc} />
        </div>
      )
    }
    if (phase.kind === 'success') {
      return <OwnedResourceLinks resources={phase.resources.length ? phase.resources : resources} orgslug={orgslug} sc={sc} />
    }

    // Sanar y Criar: already in a Pago Móvil order awaiting confirmation.
    if (pendingPurchase) {
      return (
        <div role="status" className="p-4 bg-amber-50 border border-amber-200 rounded-[20px] space-y-2">
          <p className="flex items-start gap-2 text-sm font-semibold text-[#190933] leading-snug">
            <Clock size={16} className="text-amber-700 shrink-0 mt-0.5" />
            <span>{ct('add.pending_purchase', { code: pendingPurchase.code })}</span>
          </p>
          <Link
            href={getUriWithOrg(orgslug, `/store/purchases/${encodeURIComponent(pendingPurchase.uuid)}`)}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#4F43A4] underline underline-offset-2"
          >
            {ct('add.view_order')} <ArrowRight size={13} />
          </Link>
        </div>
      )
    }

    // Sanar y Criar: wait for the providers before choosing between the
    // guest card and the cart buttons (anyone can fill a cart).
    if (!token && providersLoading) {
      return (
        <div className="flex items-center justify-center gap-2 py-3 text-sm text-[#584F72]">
          <Loader2 size={15} className="animate-spin" /> {sc('offer_page.providers_loading')}
        </div>
      )
    }

    if (!token && !hasManual) {
      return (
        <div className="space-y-3">
          <div className="p-4 bg-[#FFFCF9] border border-[#EAE8F2] rounded-[20px]">
            <div className="flex items-center gap-2">
              <UserPlus size={16} className="text-[#6559CA] shrink-0" />
              <p className="font-semibold text-[#190933] text-sm">{sc('offer_page.guest_title')}</p>
            </div>
            <p className="text-xs text-[#584F72] mt-1 leading-relaxed">{sc('offer_page.guest_description')}</p>
          </div>
          <Link
            href={signupHref}
            onClick={() => track(AnalyticsEvent.CheckoutLoginRedirected, { redirect_target: offerPath, target: 'signup' })}
            className="w-full flex items-center justify-center gap-2 py-3 px-5 rounded-full font-semibold text-sm bg-[#190933] hover:bg-[#41375B] text-white transition-colors"
          >
            <UserPlus size={15} /> {sc('offer_page.guest_signup')}
          </Link>
          <p className="text-xs text-center text-[#584F72]">
            {sc('offer_page.guest_have_account')}{' '}
            <Link
              href={loginHref}
              onClick={() => track(AnalyticsEvent.CheckoutLoginRedirected, { redirect_target: offerPath, target: 'login' })}
              className="font-semibold text-[#4F43A4] underline inline-flex items-center gap-1"
            >
              <LogIn size={12} /> {sc('offer_page.guest_login')}
            </Link>
          </p>
        </div>
      )
    }

    if (providersLoading) {
      return (
        <div className="flex items-center justify-center gap-2 py-3 text-sm text-[#584F72]">
          <Loader2 size={15} className="animate-spin" /> {sc('offer_page.providers_loading')}
        </div>
      )
    }

    if (payButtons.length === 0 && !hasManual) {
      return (
        <p className="text-sm text-[#584F72] bg-[#FFFCF9] border border-[#EAE8F2] rounded-[20px] px-4 py-3">
          {sc('offer_page.no_providers')}
        </p>
      )
    }

    const hasCard = payButtons.some((b) => b.method === 'card')
    const testMode = payButtons.some((b) => b.provider.test_mode)
    return (
      <div className="space-y-2.5">
        {/* Sanar y Criar: Pago Móvil (cart) first; PayPal below, if active. */}
        {hasManual && (
          <>
            <button
              type="button"
              onClick={buyNow}
              disabled={!!starting || busy}
              className="w-full flex items-center justify-center gap-2 min-h-[48px] py-3 px-5 rounded-full font-semibold text-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed bg-[#190933] hover:bg-[#41375B] text-white"
            >
              {methodIcon('manual', 'pago_movil')}
              <span>{ct('add.buy_now')}</span>
            </button>
            <AddToCartButton orgslug={orgslug} offerUuid={canonicalUuid} />
            <p className="text-xs text-center text-[#6D6485] leading-relaxed">{ct('add.pago_movil_hint')}</p>
            {payButtons.length > 0 && (
              <p className="flex items-center gap-3 pt-1 text-xs text-[#6D6485]">
                <span className="h-px flex-1 bg-[#EAE8F2]" aria-hidden="true" />
                {ct('add.or_paypal')}
                <span className="h-px flex-1 bg-[#EAE8F2]" aria-hidden="true" />
              </p>
            )}
          </>
        )}
        {testMode && (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
            {sc('offer_page.test_mode_banner')}
          </p>
        )}
        {payButtons.map(({ provider, method }, index) => {
          const key = `${provider.provider}:${method}`
          const isStarting = starting === key
          const primary = index === 0 && !hasManual
          return (
            <button
              key={key}
              type="button"
              onClick={() => startCheckout(provider, method)}
              disabled={!!starting || busy}
              className={`w-full flex items-center justify-center gap-2 py-3 px-5 rounded-full font-semibold text-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
                primary
                  ? 'bg-[#190933] hover:bg-[#41375B] text-white'
                  : 'bg-white hover:bg-[#EEEDFF] text-[#190933] border border-[#BBBBFF]'
              }`}
            >
              {isStarting ? <Loader2 size={15} className="animate-spin" /> : methodIcon(provider.provider.toLowerCase(), method)}
              <span>{isStarting ? sc('offer_page.redirecting') : methodLabel(provider, method, sc)}</span>
            </button>
          )
        })}
        {hasCard && <p className="text-xs text-center text-[#6D6485]">{sc('offer_page.card_hint')}</p>}
        {!token && (
          <p className="text-xs text-center text-[#584F72]">
            {sc('offer_page.guest_have_account')}{' '}
            <Link
              href={loginHref}
              onClick={() => track(AnalyticsEvent.CheckoutLoginRedirected, { redirect_target: offerPath, target: 'login' })}
              className="font-semibold text-[#4F43A4] underline inline-flex items-center gap-1"
            >
              <LogIn size={12} /> {sc('offer_page.guest_login')}
            </Link>
          </p>
        )}
        {checkoutError && (
          <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-3 py-2">
            {checkoutError}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="w-full">
      <GeneralWrapperStyled>
        <Link
          href={getUriWithOrg(orgslug, '/store')}
          className="inline-flex items-center gap-1.5 text-sm text-[#6D6485] hover:text-[#190933] transition-colors mb-7"
        >
          <ArrowLeft size={14} /> {sc('offer_page.back_to_store')}
        </Link>

        {renderPhase()}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left col */}
          <div className="lg:col-span-2 space-y-7 min-w-0">
            <div>
              <div className="flex items-center gap-2 mb-2.5">
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#4F43A4] bg-[#EEEDFF] rounded-full px-3 py-1">
                  <SquareCheck size={11} /> {sc('offer_page.one_time_badge')}
                </span>
              </div>
              <h1 className="text-3xl font-black text-[#190933] tracking-tight break-words">{offer.name}</h1>
              {offer.description && (
                <p className="mt-3 text-[#41375B] leading-relaxed text-base whitespace-pre-line">{offer.description}</p>
              )}
            </div>

            {resources.length > 0 && (
              <div>
                <h2 className="text-[13px] font-semibold text-[#AC4691] uppercase tracking-[0.18em] mb-4">
                  {sc('offer_page.included_heading', { count: resources.length })}
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {resources.map((r) => (
                    <ResourceCard key={r.resource_uuid} resource={r} orgslug={orgslug} orgUuid={r.org_uuid} sc={sc} />
                  ))}
                </div>
              </div>
            )}

            {benefits.length > 0 && (
              <div className="bg-white rounded-[20px] nice-shadow p-5 border border-[#EAE8F2]">
                <h2 className="text-[13px] font-semibold text-[#AC4691] uppercase tracking-[0.18em] mb-3">
                  {sc('offer_page.benefits_title')}
                </h2>
                <ul className="space-y-2.5">
                  {benefits.map((b, i) => (
                    <li key={i} className="flex items-start gap-2.5 text-sm text-[#41375B]">
                      <Sparkles size={14} className="text-[#7D75E2] mt-0.5 shrink-0" />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Right col: sticky pricing card */}
          <div className="lg:col-span-1 min-w-0">
            <div className="rounded-[20px] nice-shadow bg-white p-6 sticky top-24 border border-[#EAE8F2]">
              <div className="mb-5">
                <p className="text-xs text-[#6D6485] font-medium mb-1">
                  {offer.price_type === 'customer_choice' ? sc('offer_page.price_label_minimum') : sc('offer_page.price_label')}
                </p>
                <div className="text-4xl font-black text-[#190933]">{formattedPrice}</div>
              </div>

              {renderPurchaseBox()}

              {resources.length > 0 && (
                <div className="mt-5 pt-4 border-t border-[#EAE8F2]">
                  <p className="text-[13px] font-semibold text-[#AC4691] uppercase tracking-[0.18em] mb-3">
                    {sc('offer_page.included_short')}
                  </p>
                  <div className="space-y-2">
                    {resources.map((r) => {
                      const src = resourceThumbnail(r, r.org_uuid)
                      return (
                        <div key={r.resource_uuid} className="flex items-center gap-2.5 min-w-0">
                          <div
                            className="w-8 h-8 rounded-md overflow-hidden bg-[#EEEDFF] shrink-0 flex items-center justify-center"
                            style={{
                              backgroundImage: src ? cssUrl(src) : undefined,
                              backgroundSize: 'cover',
                              backgroundPosition: 'center',
                            }}
                          >
                            {!src && resourceIcon(r, 13)}
                          </div>
                          <p className="text-xs font-medium text-[#41375B] truncate">{r.name}</p>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              <div className="mt-5 pt-4 border-t border-[#EAE8F2] space-y-1.5">
                {payButtons.some((b) => b.provider.provider.toLowerCase() === 'paypal') && (
                  <p className="text-xs text-[#6D6485] flex items-center gap-1.5">
                    <ShieldCheck size={12} className="text-[#6559CA]" /> {sc('offer_page.secure_checkout')}
                  </p>
                )}
                <p className="text-xs text-[#6D6485] flex items-center gap-1.5">
                  <Zap size={12} className="text-[#6559CA] shrink-0" />{' '}
                  {/* Sanar y Criar: Pago Móvil access waits for the confirmation. */}
                  {hasManual ? ct('add.access_note') : sc('offer_page.instant_access')}
                </p>
                <p className="text-xs text-[#6D6485] flex items-center gap-1.5">
                  <BookOpen size={12} className="text-[#6559CA]" /> {sc('offer_page.account_access')}
                </p>
              </div>
            </div>
          </div>
        </div>
      </GeneralWrapperStyled>
    </div>
  )
}

'use client'
// Sanar y Criar: the cart (/store/cart), contract §D.4.
//
// - ?add=<offer_uuid> (repeatable, from the marketing site) adds and cleans the URL.
// - The products, their status and the totals come from POST cart/quote; the
//   cart itself only stores offer_uuids (lib/sc-cart.ts). The quote is asked
//   again on focus, every 5 minutes and after a failed confirmation, and
//   "Confirmar pedido" only works on a fresh, successful one.
// - Paying needs a session; "Confirmar pedido" creates the order and opens
//   /store/purchases/<uuid> with the Pago Móvil details. Without Pago Móvil,
//   each product can still be paid with PayPal from its own page.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { SiPaypal } from '@icons-pack/react-simple-icons'
import {
  AlertCircle, AlertTriangle, ArrowLeft, ArrowRight, BookMarked, BookOpen, CheckCircle2, Clock,
  Loader2, LogIn, RefreshCw, ShoppingCart, Smartphone, Trash2, UserPlus,
} from 'lucide-react'
import GeneralWrapperStyled from '@components/Objects/StyledElements/Wrappers/GeneralWrapper'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import { getUriWithOrg } from '@services/config/config'
import { safeImageSrc } from '@services/security/url'
import { checkoutCart, getCartQuote } from '@services/payments/cart'
import { cssUrl, errorCode, errorField, normalizeProductType, stripCoursePrefix, withRedirect } from '@components/Payments/commerce'
import { formatBs, formatIsoDate, formatRate, formatUsd } from '@/lib/sc-cart'
import { useCart } from './useCart'
import { useCartT, type CartTranslate } from './useCartT'
import { useMyPurchases } from './useMyPurchases'
import { cartKeys } from './cartKeys'
import { CartApiError, apiMessage, errorList, type CartQuote, type Purchase, type QuoteItem } from './types'

interface CartPageProps {
  orgslug: string
  orgId: number
}

interface CheckoutError {
  message: string
  purchase?: { uuid: string; code: string } | null
  login?: boolean
  /** The cart it was about: it stops showing once the cart changes. */
  cartKey: string
}

const QUOTE_REFRESH_MS = 5 * 60_000
// Focus target after removing the last product of the list.
const FOCUS_TITLE = '__title__'

const PRIMARY_BTN =
  'w-full inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors bg-[#190933] hover:bg-[#41375B] text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7D75E2] focus-visible:ring-offset-2'
const SECONDARY_BTN =
  'w-full inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors bg-white hover:bg-[#EEEDFF] text-[#190933] border border-[#BBBBFF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7D75E2] focus-visible:ring-offset-2'
const SECTION_TITLE = 'text-[13px] font-semibold text-[#AC4691] uppercase tracking-[0.18em]'

function isEbookOffer(item: QuoteItem | undefined): boolean {
  const resources = item?.resources ?? []
  return resources.length > 0 && resources.every((r) => normalizeProductType(r.product_type) === 'ebook')
}

// ---------------------------------------------------------------------------
// One product of the cart
// ---------------------------------------------------------------------------

function CartRow({
  uuid,
  item,
  orgslug,
  overlap,
  rowRef,
  onRemove,
  ct,
}: {
  uuid: string
  item: QuoteItem | undefined
  orgslug: string
  /** Named by OVERLAPPING_OFFERS: it covers the same content as another product. */
  overlap: boolean
  rowRef: (_el: HTMLLIElement | null) => void
  onRemove: (_uuid: string) => void
  ct: CartTranslate
}) {
  const resources = item?.resources ?? []
  const first = resources[0]
  const ebook = isEbookOffer(item)
  const thumb = safeImageSrc(item?.thumbnail_url ?? first?.thumbnail_url ?? null)
  const name = item ? item.name || ct('cart.unknown_product') : ''
  const status = item?.status
  const muted = !!status && status !== 'available'
  const courseHref = first?.course_uuid ? getUriWithOrg(orgslug, `/course/${stripCoursePrefix(first.course_uuid)}`) : null
  const pending = item?.pending_purchase

  return (
    <li
      ref={rowRef}
      // Focus lands here after removing the product above it.
      tabIndex={-1}
      className="bg-white rounded-[20px] nice-shadow p-3 sm:p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#7D75E2]"
    >
      {overlap && (
        <p className="mb-2.5 flex items-center gap-1.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800">
          <AlertTriangle size={13} className="shrink-0" aria-hidden="true" />
          {ct('cart.overlap')}
        </p>
      )}
      <div className="flex gap-3 sm:gap-4">
        <div
          className="w-24 sm:w-32 aspect-video self-start shrink-0 rounded-xl overflow-hidden bg-[#EEEDFF] flex items-center justify-center"
          style={thumb ? { backgroundImage: cssUrl(thumb), backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}
        >
          {!thumb &&
            (ebook ? <BookMarked size={20} className="text-[#AC4691]" /> : <BookOpen size={20} className="text-[#6559CA]" />)}
        </div>

        <div className="min-w-0 flex-1">
          {!item ? (
            <div className="space-y-2 py-1" aria-hidden="true">
              <div className="h-3 w-16 rounded-full bg-[#EEEDFF] animate-pulse" />
              <div className="h-4 w-4/5 rounded-full bg-[#EEEDFF] animate-pulse" />
              <div className="h-4 w-20 rounded-full bg-[#EEEDFF] animate-pulse" />
            </div>
          ) : (
            <>
              <p className="text-xs font-semibold text-[#6559CA]">
                {ebook ? ct('product.ebook') : ct('product.course')}
                {resources.length > 1 && ` · ${ct('product.includes', { count: resources.length })}`}
              </p>
              <p className={`mt-0.5 font-semibold leading-snug line-clamp-2 break-words ${muted ? 'text-[#6D6485]' : 'text-[#190933]'}`}>
                {name}
              </p>

              {status === 'unavailable' && (
                <p className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-red-700">
                  <AlertCircle size={13} className="shrink-0" aria-hidden="true" />
                  {ct('cart.status_unavailable')}
                </p>
              )}
              {status === 'owned' && (
                <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs font-semibold text-[#4F43A4]">
                  <CheckCircle2 size={13} className="shrink-0" aria-hidden="true" />
                  <span>{ct('cart.status_owned')}</span>
                  {courseHref && (
                    <>
                      <span aria-hidden="true">·</span>
                      <Link href={courseHref} className="underline underline-offset-2 hover:text-[#190933]">
                        {ebook ? ct('cart.read_ebook') : ct('cart.go_to_course')}
                      </Link>
                    </>
                  )}
                </p>
              )}
              {status === 'pending' && (
                <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs font-semibold text-amber-800">
                  <Clock size={13} className="shrink-0" aria-hidden="true" />
                  {pending?.code ? (
                    <>
                      <span>{ct('cart.status_pending', { code: pending.code })}</span>
                      <span aria-hidden="true">·</span>
                      <Link
                        href={getUriWithOrg(orgslug, `/store/purchases/${pending.purchase_uuid}`)}
                        className="underline underline-offset-2 hover:text-[#190933]"
                      >
                        {ct('cart.view_order')}
                      </Link>
                    </>
                  ) : (
                    <span>{ct('cart.status_pending_payment')}</span>
                  )}
                </p>
              )}

              <div className="mt-1.5 flex items-center justify-between gap-3">
                <span className={`font-bold tabular-nums ${muted ? 'text-[#6D6485]' : 'text-[#190933]'}`}>
                  {item.amount != null ? formatUsd(item.amount) : ''}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(uuid)}
                  aria-label={ct('cart.remove_aria', { name: name || ct('cart.unknown_product') })}
                  className="-me-2 inline-flex min-h-[44px] items-center gap-1.5 rounded-full px-3 text-sm font-medium text-[#6D6485] transition-colors hover:text-[#AC4691] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BBBBFF]"
                >
                  <Trash2 size={14} aria-hidden="true" />
                  {ct('cart.remove')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CartPage({ orgslug, orgId }: CartPageProps) {
  const { ct } = useCartT()
  const router = useRouter()
  const queryClient = useQueryClient()
  const session = useLHSession() as any
  const token: string | null = session?.data?.tokens?.access_token ?? null
  const user = session?.data?.user
  const viewer: string = user?.user_uuid ?? (user?.id != null ? String(user.id) : 'anonymous')
  const cart = useCart(orgId)
  const uuids = cart.uuids
  const cartKey = uuids.join(',')

  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const [redirecting, setRedirecting] = useState(false)
  const [checkoutError, setCheckoutError] = useState<CheckoutError | null>(null)
  // After a failed confirmation: when the quote then on screen was fetched.
  // The button waits for a newer one (dataUpdatedAt of a later fetch).
  const [confirmErrorAt, setConfirmErrorAt] = useState(0)
  // OVERLAPPING_OFFERS marks, valid only for the cart they were about.
  const [overlap, setOverlap] = useState<{ cartKey: string; uuids: string[] } | null>(null)

  // Focus management: after removing a product, the next one (or the title).
  const titleRef = useRef<HTMLHeadingElement>(null)
  const rowRefs = useRef(new Map<string, HTMLLIElement>())
  const focusAfterChange = useRef<string | null>(null)
  useEffect(() => {
    const target = focusAfterChange.current
    if (!target) return
    focusAfterChange.current = null
    const el = target === FOCUS_TITLE ? titleRef.current : rowRefs.current.get(target)
    el?.focus()
  }, [cartKey])

  // ?add=<uuid>&add=<uuid> from the marketing site: add, then clean the URL.
  const handledAddRef = useRef(false)
  useEffect(() => {
    if (handledAddRef.current) return
    handledAddRef.current = true
    const adds = new URLSearchParams(window.location.search).getAll('add')
    if (adds.length === 0) return
    let full = false
    for (const raw of adds) {
      if (cart.add(raw) === 'full') full = true
    }
    if (full) toast.error(ct('add.full'))
    router.replace(getUriWithOrg(orgslug, '/store/cart'))
    // Runs once per page load; the ref guards re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const quoteQuery = useQuery<CartQuote>({
    queryKey: cartKeys.quote(orgId, uuids, viewer),
    queryFn: async () => {
      const res = await getCartQuote(orgId, [...uuids], token)
      if (!res.success || !res.data || !Array.isArray(res.data.items)) throw new CartApiError(res.status, res.data)
      return res.data as CartQuote
    },
    enabled: cart.ready && uuids.length > 0,
    // Removing a product keeps the last quote on screen until the new one arrives.
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    // Prices, statuses and the rate move: ask again when she comes back to
    // the tab and every few minutes while it is open.
    refetchOnWindowFocus: 'always',
    refetchInterval: QUOTE_REFRESH_MS,
    refetchIntervalInBackground: false,
    // Never insist after a 429: it would only extend the wait.
    retry: (failures, error) => !(error instanceof CartApiError && error.status === 429) && failures < 1,
  })
  const quote = quoteQuery.data
  // The quote on screen is for exactly this cart (not the previous one).
  const fresh = !!quote && !quoteQuery.isPlaceholderData
  const quoteError = quoteQuery.error
  const quoteErrorMessage =
    quoteError instanceof CartApiError && quoteError.status === 429
      ? apiMessage(quoteError.data, 429) ?? ct('cart.rate_limited')
      : ct('cart.load_error')
  // Nothing to show at all / an older quote on screen whose refresh failed.
  const quoteFailed = quoteQuery.isError && !quote
  const quoteRefreshFailed = quoteQuery.isError && !!quote

  const { purchases } = useMyPurchases(orgId, token)
  const pendingPurchases = purchases.filter((p) => p.status === 'pending')

  const byUuid = useMemo(() => {
    const map = new Map<string, QuoteItem>()
    for (const item of quote?.items ?? []) {
      if (item?.offer_uuid) map.set(item.offer_uuid.toLowerCase(), item)
    }
    return map
  }, [quote])

  const availableItems = fresh ? (quote?.items ?? []).filter((i) => i.status === 'available') : []
  const availableUuids = availableItems.map((i) => i.offer_uuid)
  const blockedUuids = fresh
    ? uuids.filter((u) => {
        const s = byUuid.get(u)?.status
        return !!s && s !== 'available'
      })
    : []
  const overlapUuids = new Set(overlap && overlap.cartKey === cartKey ? overlap.uuids.map((u) => u.toLowerCase()) : [])

  const pm = quote?.pago_movil
  const pmEnabled = !!pm?.enabled
  const rate = pmEnabled && typeof pm?.rate === 'number' ? pm.rate : null
  const amountVes = pmEnabled && typeof pm?.amount_ves === 'number' ? pm.amount_ves : null
  const rateProblem = pmEnabled && (!!pm?.error || rate === null || amountVes === null)
  const pagoMovilUsable = pmEnabled && !rateProblem
  const paypalEnabled = fresh && !!quote?.paypal?.enabled
  // Pago Móvil works: PayPal is the alternative for a single product.
  const paypalOfferUuid = paypalEnabled && pagoMovilUsable && availableUuids.length === 1 ? availableUuids[0] : null
  // Pago Móvil off or without a rate: every product can go through PayPal.
  const paypalForEach = paypalEnabled && !pagoMovilUsable && availableItems.length > 0

  const quoteReady =
    fresh && !quoteQuery.isFetching && !quoteQuery.isError && quoteQuery.dataUpdatedAt > confirmErrorAt
  const canConfirm =
    !!token && quoteReady && (quote?.count ?? 0) > 0 && availableUuids.length > 0 && pagoMovilUsable && !submitting
  const visibleError = checkoutError && checkoutError.cartKey === cartKey ? checkoutError : null

  const removeItem = (uuid: string) => {
    const index = uuids.indexOf(uuid)
    focusAfterChange.current = uuids[index + 1] ?? FOCUS_TITLE
    cart.remove(uuid)
  }

  const removeBlocked = () => {
    const blocked = new Set(blockedUuids)
    focusAfterChange.current = uuids.find((u) => !blocked.has(u)) ?? FOCUS_TITLE
    cart.removeMany(blockedUuids)
  }

  const confirmOrder = async () => {
    if (submittingRef.current || !canConfirm || !token) return
    submittingRef.current = true
    setSubmitting(true)
    setCheckoutError(null)
    const sent = [...availableUuids]
    const sentKey = cartKey
    const quoteKey = cartKeys.quote(orgId, uuids, viewer)
    try {
      const res = await checkoutCart(orgId, sent, token)
      const purchase: Purchase | null = res.success && res.data?.purchase_uuid ? (res.data as Purchase) : null
      if (purchase) {
        setRedirecting(true)
        queryClient.setQueryData(cartKeys.purchase(orgId, purchase.purchase_uuid), purchase)
        router.push(getUriWithOrg(orgslug, `/store/purchases/${purchase.purchase_uuid}`))
        cart.removeMany(sent)
        // Course pages now show "pedido por confirmar"; "Mis compras" lists it.
        queryClient.invalidateQueries({ queryKey: ['payments', orgId] })
        return // keep the button disabled while the order page opens
      }

      const code = errorCode(res.data)
      const message = apiMessage(res.data, res.status) ?? ct('confirm.error_generic')
      if (res.status === 401) {
        setCheckoutError({ message: ct('confirm.session_expired'), login: true, cartKey: sentKey })
      } else if (code === 'PAYMENT_PENDING') {
        const purchaseUuid = errorField(res.data, 'purchase_uuid')
        const purchaseCode = errorField(res.data, 'purchase_code')
        setCheckoutError({
          message,
          purchase: purchaseUuid ? { uuid: purchaseUuid, code: purchaseCode ?? '' } : null,
          cartKey: sentKey,
        })
      } else {
        if (code === 'OVERLAPPING_OFFERS') setOverlap({ cartKey: sentKey, uuids: errorList(res.data, 'offer_uuids') })
        setCheckoutError({ message, cartKey: sentKey })
      }
      // Whatever failed, the button waits for a newer quote than the one on
      // screen: statuses, prices or the rate may have changed.
      setConfirmErrorAt(queryClient.getQueryState(quoteKey)?.dataUpdatedAt ?? 0)
      if (code) queryClient.invalidateQueries({ queryKey: ['payments', orgId] })
      else quoteQuery.refetch()
    } catch {
      setCheckoutError({ message: ct('confirm.error_generic'), cartKey: sentKey })
      setConfirmErrorAt(queryClient.getQueryState(quoteKey)?.dataUpdatedAt ?? 0)
      quoteQuery.refetch()
    }
    submittingRef.current = false
    setSubmitting(false)
  }

  const storeHref = getUriWithOrg(orgslug, '/store')
  const loginHref = getUriWithOrg(orgslug, withRedirect('/login', '/store/cart'))
  const signupHref = getUriWithOrg(orgslug, withRedirect('/signup', '/store/cart'))

  const retryButton = (
    <button
      type="button"
      onClick={() => quoteQuery.refetch()}
      disabled={quoteQuery.isFetching}
      className="inline-flex items-center gap-1.5 rounded-full bg-white border border-red-200 px-4 min-h-[40px] font-semibold text-red-700 hover:bg-red-100 disabled:opacity-60"
    >
      <RefreshCw size={14} className={quoteQuery.isFetching ? 'animate-spin' : ''} aria-hidden="true" /> {ct('cart.retry')}
    </button>
  )

  // -------------------------------------------------------------------------
  // States
  // -------------------------------------------------------------------------

  const renderBody = () => {
    if (redirecting) {
      return (
        <div role="status" className="flex flex-col items-center justify-center py-20 text-center">
          <Loader2 size={28} className="animate-spin text-[#6559CA]" aria-hidden="true" />
          <p className="mt-3 text-sm font-medium text-[#41375B]">{ct('confirm.redirecting')}</p>
        </div>
      )
    }

    if (!cart.ready) {
      return (
        <div role="status" className="flex items-center justify-center gap-2 py-20 text-sm text-[#584F72]">
          <Loader2 size={18} className="animate-spin" aria-hidden="true" /> {ct('cart.loading')}
        </div>
      )
    }

    if (cart.count === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-16 h-16 rounded-2xl bg-[#EEEDFF] flex items-center justify-center mb-4">
            <ShoppingCart size={28} className="text-[#6559CA]" strokeWidth={1.5} aria-hidden="true" />
          </div>
          <h2 className="text-xl font-bold text-[#190933] mb-2">{ct('cart.empty_title')}</h2>
          <p className="text-[#584F72] text-sm max-w-sm">{ct('cart.empty_description')}</p>
          <Link href={storeHref} className={`${PRIMARY_BTN} mt-6 w-auto px-6 min-h-[48px] text-sm`}>
            {ct('cart.see_store')} <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </div>
      )
    }

    return (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 lg:gap-8">
        {/* Products */}
        <section className="lg:col-span-2 min-w-0" aria-labelledby="cart-items-title">
          <h2 id="cart-items-title" className={`${SECTION_TITLE} mb-3`}>
            {ct('cart.items_heading', { count: cart.count })}
          </h2>
          {quoteFailed ? (
            <div role="alert" className="rounded-[20px] border border-red-100 bg-red-50 p-5 text-sm text-red-700 space-y-3">
              <p>{quoteErrorMessage}</p>
              {retryButton}
            </div>
          ) : (
            <ul className="space-y-3">
              {uuids.map((uuid) => (
                <CartRow
                  key={uuid}
                  uuid={uuid}
                  item={byUuid.get(uuid)}
                  orgslug={orgslug}
                  overlap={overlapUuids.has(uuid)}
                  rowRef={(el) => {
                    if (el) rowRefs.current.set(uuid, el)
                    else rowRefs.current.delete(uuid)
                  }}
                  onRemove={removeItem}
                  ct={ct}
                />
              ))}
            </ul>
          )}
          {blockedUuids.length > 0 && (
            <button
              type="button"
              onClick={removeBlocked}
              className="mt-3 inline-flex min-h-[44px] items-center gap-1.5 rounded-full border border-[#EAE8F2] bg-white px-4 text-sm font-semibold text-[#584F72] transition-colors hover:border-[#F0B4DF] hover:text-[#AC4691]"
            >
              <Trash2 size={14} aria-hidden="true" /> {ct('cart.remove_unavailable')}
            </button>
          )}
        </section>

        {/* Summary, method, pay */}
        <aside className="lg:col-span-1 min-w-0">
          <div className="lg:sticky lg:top-24 space-y-4">
            <section className="rounded-[20px] nice-shadow bg-white p-5" aria-labelledby="cart-summary-title">
              <h2 id="cart-summary-title" className={`${SECTION_TITLE} mb-3`}>{ct('summary.title')}</h2>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-[#584F72]">{ct('summary.total')}</span>
                <span className="text-lg font-bold text-[#190933] tabular-nums">
                  {quote ? formatUsd(quote.total) : '—'}
                </span>
              </div>

              {pagoMovilUsable && (quote?.count ?? 0) > 0 && (
                <div className="mt-4 rounded-2xl bg-[#EEEDFF] p-4">
                  <p className="text-xs font-semibold text-[#4F43A4]">{ct('summary.to_pay')}</p>
                  <p className="mt-1 text-[1.75rem] sm:text-3xl font-black leading-tight text-[#190933] tabular-nums break-words">
                    {formatBs(amountVes)}
                  </p>
                  <p className="mt-1 text-xs text-[#584F72] leading-relaxed">
                    {pm?.rate_source === 'manual'
                      ? ct('summary.rate_manual', { rate: formatRate(rate) })
                      : ct('summary.rate_bcv', { date: formatIsoDate(pm?.rate_date), rate: formatRate(rate) })}
                  </p>
                </div>
              )}
              {rateProblem && (
                <p role="alert" className="mt-4 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                  {ct('summary.rate_error')}
                </p>
              )}
              {fresh && quote?.count === 0 && (
                <p className="mt-3 text-sm text-[#584F72]">{ct('summary.nothing_to_pay')}</p>
              )}
              {quote && quoteQuery.isFetching && (
                <p className="mt-3 flex items-center gap-1.5 text-xs text-[#6D6485]" role="status">
                  <Loader2 size={12} className="animate-spin" aria-hidden="true" /> {ct('cart.updating')}
                </p>
              )}
            </section>

            <section className="rounded-[20px] nice-shadow bg-white p-5 space-y-3" aria-labelledby="cart-method-title">
              <h2 id="cart-method-title" className={SECTION_TITLE}>{ct('method.title')}</h2>
              {!quote ? (
                quoteFailed ? null : (
                  <div className="h-16 rounded-2xl bg-[#EEEDFF] animate-pulse" aria-hidden="true" />
                )
              ) : pmEnabled ? (
                <div className="flex items-start gap-3 rounded-2xl border-2 border-[#7D75E2] bg-[#FFFCF9] p-4">
                  <span className="w-9 h-9 rounded-xl bg-[#EEEDFF] flex items-center justify-center shrink-0">
                    <Smartphone size={18} className="text-[#6559CA]" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-[#190933]">{ct('method.pago_movil')}</p>
                    <p className="text-sm text-[#584F72] leading-relaxed">{ct('method.pago_movil_description')}</p>
                  </div>
                  <CheckCircle2 size={20} className="text-[#6559CA] shrink-0" aria-hidden="true" />
                </div>
              ) : (
                <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                  {ct('method.unavailable')}
                </p>
              )}
              {paypalOfferUuid && (
                <Link
                  href={getUriWithOrg(orgslug, `/store/offers/${paypalOfferUuid}`)}
                  className="inline-block text-sm font-semibold text-[#4F43A4] underline underline-offset-2 hover:text-[#190933]"
                >
                  {ct('method.paypal_link')}
                </Link>
              )}
              {paypalForEach && (
                <div className="space-y-2">
                  <p className="text-sm text-[#41375B]">{ct('method.paypal_each')}</p>
                  <ul className="space-y-2">
                    {availableItems.map((item) => {
                      const name = item.name || ct('cart.unknown_product')
                      return (
                        <li
                          key={item.offer_uuid}
                          className="flex items-center justify-between gap-3 rounded-2xl border border-[#EAE8F2] bg-[#FFFCF9] ps-3 pe-1.5 py-1.5"
                        >
                          <span className="min-w-0 truncate text-sm font-medium text-[#190933]">{name}</span>
                          <Link
                            href={getUriWithOrg(orgslug, `/store/offers/${item.offer_uuid}`)}
                            aria-label={ct('method.paypal_aria', { name })}
                            className="shrink-0 inline-flex min-h-[40px] items-center gap-1.5 rounded-full border border-[#BBBBFF] bg-white px-3 text-xs font-semibold text-[#190933] hover:bg-[#EEEDFF]"
                          >
                            <SiPaypal size={13} aria-hidden="true" /> {ct('method.paypal_button')}
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
            </section>

            {quoteRefreshFailed && (
              <div role="alert" className="rounded-[20px] border border-red-100 bg-red-50 p-4 text-sm text-red-700 space-y-3">
                <p>{quoteErrorMessage}</p>
                {retryButton}
              </div>
            )}

            {token ? (
              // Without Pago Móvil there is nothing to confirm here (PayPal is
              // paid on each product's page).
              !fresh || pmEnabled ? (
                <div className="space-y-2.5">
                  <button
                    type="button"
                    onClick={confirmOrder}
                    disabled={!canConfirm}
                    aria-busy={submitting}
                    className={`${PRIMARY_BTN} min-h-[52px] px-5 py-3.5 text-base disabled:opacity-60 disabled:cursor-not-allowed`}
                  >
                    {submitting ? (
                      <Loader2 size={17} className="animate-spin" aria-hidden="true" />
                    ) : (
                      <Smartphone size={17} aria-hidden="true" />
                    )}
                    {submitting ? ct('confirm.sending') : ct('confirm.button')}
                  </button>
                  <p className="text-xs text-center text-[#6D6485]">{ct('confirm.hint')}</p>
                  {visibleError && (
                    <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-3 py-2 space-y-1">
                      <p>{visibleError.message}</p>
                      {visibleError.purchase && (
                        <Link
                          href={getUriWithOrg(orgslug, `/store/purchases/${visibleError.purchase.uuid}`)}
                          className="inline-flex items-center gap-1 font-semibold underline underline-offset-2"
                        >
                          {ct('confirm.view_order', { code: visibleError.purchase.code })} <ArrowRight size={13} aria-hidden="true" />
                        </Link>
                      )}
                      {visibleError.login && (
                        <Link href={loginHref} className="inline-flex items-center gap-1 font-semibold underline underline-offset-2">
                          <LogIn size={13} aria-hidden="true" /> {ct('confirm.login_again')}
                        </Link>
                      )}
                    </div>
                  )}
                </div>
              ) : null
            ) : (
              <div className="rounded-[20px] border border-[#EAE8F2] bg-[#FFFCF9] p-5 space-y-4">
                <p className="flex items-start gap-2 text-sm text-[#41375B] leading-relaxed">
                  <UserPlus size={16} className="text-[#6559CA] shrink-0 mt-0.5" aria-hidden="true" />
                  <span>{ct('guest.text')}</span>
                </p>
                <div className="grid grid-cols-2 gap-2.5">
                  <Link href={loginHref} className={`${SECONDARY_BTN} min-h-[48px] px-3 text-sm`}>
                    <LogIn size={15} aria-hidden="true" /> {ct('guest.login')}
                  </Link>
                  <Link href={signupHref} className={`${PRIMARY_BTN} min-h-[48px] px-3 text-sm`}>
                    <UserPlus size={15} aria-hidden="true" /> {ct('guest.signup')}
                  </Link>
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
    )
  }

  return (
    <div className="w-full">
      <GeneralWrapperStyled>
        <Link
          href={storeHref}
          className="inline-flex items-center gap-1.5 text-sm text-[#6D6485] hover:text-[#190933] transition-colors mb-5"
        >
          <ArrowLeft size={14} aria-hidden="true" /> {ct('cart.back_to_store')}
        </Link>

        <div className="flex items-center gap-3 mb-5">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-[#EEEDFF] shrink-0">
            <ShoppingCart size={18} className="text-[#190933]" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h1
              ref={titleRef}
              // Focus lands here after removing the last product of the list.
              tabIndex={-1}
              className="text-2xl font-black text-[#190933] tracking-tight focus:outline-none"
            >
              {ct('cart.title')}
            </h1>
            {cart.ready && cart.count > 0 && !redirecting && (
              <p className="text-sm text-[#584F72] mt-0.5">{ct('cart.subtitle')}</p>
            )}
          </div>
        </div>

        {!redirecting && pendingPurchases.length > 0 && (
          <div className="mb-5 space-y-2">
            {pendingPurchases.slice(0, 3).map((p) => (
              <div
                key={p.purchase_uuid}
                role="status"
                className="flex flex-wrap items-center justify-between gap-2 rounded-[20px] border border-amber-200 bg-amber-50 px-4 py-3"
              >
                <p className="flex items-center gap-2 text-sm font-semibold text-[#190933]">
                  <Clock size={15} className="text-amber-700 shrink-0" aria-hidden="true" />
                  {ct('cart.pending_notice', { code: p.code })}
                </p>
                <Link
                  href={getUriWithOrg(orgslug, `/store/purchases/${p.purchase_uuid}`)}
                  className="inline-flex items-center gap-1 text-sm font-semibold text-[#4F43A4] underline underline-offset-2 hover:text-[#190933]"
                >
                  {ct('cart.pending_notice_link')} <ArrowRight size={13} aria-hidden="true" />
                </Link>
              </div>
            ))}
          </div>
        )}

        {renderBody()}
      </GeneralWrapperStyled>
    </div>
  )
}

'use client'
// Sanar y Criar: one cart order (/store/purchases/<uuid>), contract §D.5,
// paid with its manual method (Pago Móvil, transferencia, Zelle or Binance;
// contrato-pagos-manuales.md §A.6).
//
// Pending: three steps (pay with every value one tap away from the clipboard,
// send the receipt on WhatsApp with a prefilled message, wait for the
// confirmation email). The page polls every 20 s while visible and, once the
// order is paid, refreshes everything that depends on ownership.
import React, { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { SiWhatsapp } from '@icons-pack/react-simple-icons'
import {
  AlertCircle, AlertTriangle, ArrowLeft, ArrowRight, Ban, BookMarked, BookOpen, CalendarX, Check, CheckCircle2,
  Clock, Copy, Info, Loader2, LogIn, Mail, RefreshCw, ShoppingCart, XCircle,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@components/ui/dialog'
import GeneralWrapperStyled from '@components/Objects/StyledElements/Wrappers/GeneralWrapper'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import { getUriWithOrg } from '@services/config/config'
import { revalidateTags } from '@services/utils/ts/requests'
import { cancelPurchase, getPurchase } from '@services/payments/cart'
import { queryKeys } from '@/lib/query/keys'
import { methodLabel, normalizeProductType, stripCoursePrefix, withRedirect } from '@components/Payments/commerce'
import { useScT, type ScTranslate } from '@components/Payments/useScT'
import {
  amountForCopyIn,
  digitsOnly,
  formatAccountNumber,
  formatCaracasDateTime,
  formatIsoDate,
  formatPayAmount,
  formatRate,
  formatUsd,
  formatWhatsappNumber,
  isPlausiblePurchaseUuid,
  purchaseStatus,
  safeWhatsappUrl,
  usPhoneDigits,
  usdtNetworkLabel,
  whatsappChatUrl,
} from '@/lib/sc-cart'
import { useCart } from './useCart'
import { useCartT, type CartTranslate } from './useCartT'
import { cartKeys } from './cartKeys'
import { copyText } from './clipboard'
import { MethodIcon } from './MethodIcon'
import { PurchaseStatusChip } from './PurchaseStatusChip'
import { payAmountText, payEquivalent, payStepTitle, purchasePay, type PurchasePay } from './payMethods'
import { CartApiError, apiMessage, type Purchase, type PurchasePayment, type PurchaseResource } from './types'

const POLL_MS = 20_000

const PRIMARY_BTN =
  'inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors bg-[#190933] hover:bg-[#41375B] text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7D75E2] focus-visible:ring-offset-2'
const SECONDARY_BTN =
  'inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors bg-white hover:bg-[#EEEDFF] text-[#190933] border border-[#BBBBFF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7D75E2] focus-visible:ring-offset-2'
// WhatsApp green, dark enough for white text (5:1).
const WHATSAPP_BTN =
  'inline-flex items-center justify-center gap-2.5 rounded-full text-center leading-snug font-semibold transition-colors bg-[#15803D] hover:bg-[#116A33] text-white shadow-[0_6px_18px_-6px_rgba(21,128,61,0.55)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#15803D] focus-visible:ring-offset-2'

type CancelResult = { ok: true } | { ok: false; message: string; login?: boolean }

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function CopyRow({
  label,
  value,
  copyValue,
  emphasis = false,
  mono = false,
  ct,
}: {
  label: string
  value: string
  /** What "Copiar" puts on the clipboard; without it the row has no button (a value she picks from a list). */
  copyValue?: string
  emphasis?: boolean
  /** Long codes (a USDT address): monospace, broken anywhere. */
  mono?: boolean
  ct: CartTranslate
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current)
  }, [])

  const onCopy = async () => {
    if (!copyValue) return
    const ok = await copyText(copyValue)
    if (!ok) {
      toast.error(ct('purchase.copy_error'))
      return
    }
    setCopied(true)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex min-h-[68px] items-center justify-between gap-3 py-3 border-b border-[#EAE8F2] last:border-b-0">
      <div className="min-w-0">
        <dt className="text-xs font-medium text-[#6D6485]">{label}</dt>
        <dd
          className={`mt-0.5 text-[#190933] select-all ${
            mono ? 'break-all font-mono text-[15px] font-semibold leading-snug' : 'break-words tabular-nums'
          } ${mono ? '' : emphasis ? 'text-xl font-black' : 'text-[17px] font-semibold'}`}
        >
          {value}
        </dd>
      </div>
      {copyValue ? (
        <button
          type="button"
          onClick={onCopy}
          aria-label={ct('purchase.copy_aria', { label })}
          className={`shrink-0 inline-flex min-h-[44px] min-w-[96px] items-center justify-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7D75E2] ${
            copied
              ? 'border-green-200 bg-green-50 text-green-800'
              : 'border-[#BBBBFF] bg-white text-[#4F43A4] hover:bg-[#EEEDFF]'
          }`}
        >
          {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
          <span aria-live="polite">{copied ? ct('purchase.copied') : ct('purchase.copy')}</span>
        </button>
      ) : null}
    </div>
  )
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

interface DetailRow {
  key: string
  label: string
  value: string
  copy?: string
  mono?: boolean
  emphasis?: boolean
}

function accountTypeLabel(value: unknown, ct: CartTranslate): string {
  const type = text(value).toLowerCase()
  if (type === 'corriente') return ct('purchase.account_type_corriente')
  if (type === 'ahorro') return ct('purchase.account_type_ahorro')
  return text(value)
}

/** The details of the order's method, in the order she types them in her bank or app. */
function detailRows(pay: PurchasePay, payment: PurchasePayment, ct: CartTranslate): DetailRow[] {
  const bankName = text(payment.bank_name)
  const bankCode = text(payment.bank_code)
  const bank: DetailRow = {
    key: 'bank',
    label: ct('purchase.field_bank'),
    value: bankName && bankCode ? `${bankName} (${bankCode})` : bankName || bankCode,
    copy: bankCode || bankName,
  }
  const holder = text(payment.holder_name)
  const holderRow: DetailRow = { key: 'holder', label: ct('purchase.field_holder'), value: holder, copy: holder }
  const idDocument = text(payment.id_document)
  const idRow: DetailRow = {
    key: 'id',
    label: ct('purchase.field_id'),
    value: idDocument,
    copy: digitsOnly(idDocument) || idDocument,
  }
  const amount: DetailRow = {
    key: 'amount',
    label: ct('purchase.field_amount'),
    value: formatPayAmount(pay.amount, pay.currency),
    copy: amountForCopyIn(pay.amount, pay.currency),
    emphasis: true,
  }

  switch (pay.method) {
    case 'transferencia': {
      const account = text(payment.account_number)
      return [
        bank,
        {
          key: 'account',
          label: ct('purchase.field_account_number'),
          value: formatAccountNumber(account),
          copy: digitsOnly(account) || account,
        },
        // Picked from a list in the bank app: nothing to copy.
        { key: 'account_type', label: ct('purchase.field_account_type'), value: accountTypeLabel(payment.account_type, ct) },
        holderRow,
        idRow,
        amount,
      ]
    }
    case 'zelle': {
      const email = text(payment.email)
      const phone = text(payment.phone)
      return [
        { key: 'email', label: ct('purchase.field_zelle_email'), value: email, copy: email },
        { key: 'phone', label: ct('purchase.field_zelle_phone'), value: phone, copy: usPhoneDigits(phone) || phone },
        holderRow,
        amount,
      ]
    }
    case 'binance': {
      const payId = text(payment.pay_id)
      const address = text(payment.usdt_address)
      return [
        // Binance Pay sends to a Pay ID or to the account's email: name what it is.
        { key: 'pay_id', label: ct(payId.includes('@') ? 'purchase.field_pay_email' : 'purchase.field_pay_id'), value: payId, copy: payId },
        { key: 'address', label: ct('purchase.field_usdt_address'), value: address, copy: address, mono: true },
        // The network is chosen from a list in Binance: nothing to copy.
        {
          key: 'network',
          label: ct('purchase.field_network'),
          value: address ? usdtNetworkLabel(payment.usdt_network) : '',
        },
        amount,
      ]
    }
    default: {
      const phone = text(payment.phone)
      return [
        bank,
        { key: 'phone', label: ct('purchase.field_phone'), value: phone, copy: digitsOnly(phone) || phone },
        idRow,
        holderRow,
        amount,
      ]
    }
  }
}

function PaymentDetails({ pay, payment, ct }: { pay: PurchasePay; payment: PurchasePayment; ct: CartTranslate }) {
  // Empty fields are not shown.
  const rows = detailRows(pay, payment, ct).filter((row) => row.value)
  if (rows.length === 0) return null
  return (
    <dl className="rounded-2xl border border-[#EAE8F2] bg-[#FFFCF9] px-4">
      {rows.map((row) => (
        <CopyRow
          key={row.key}
          label={row.label}
          value={row.value}
          copyValue={row.copy || undefined}
          emphasis={row.emphasis}
          mono={row.mono}
          ct={ct}
        />
      ))}
    </dl>
  )
}

/** Binance: the network warning for an address, or that a Pay ID has no fee. */
function BinanceNote({ payment, ct }: { payment: PurchasePayment; ct: CartTranslate }) {
  const address = text(payment.usdt_address)
  if (address) {
    const network = usdtNetworkLabel(payment.usdt_network)
    return (
      <div role="note" className="mt-3 flex items-start gap-2.5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-700" aria-hidden="true" />
        <div className="min-w-0 space-y-1 text-sm leading-relaxed text-amber-900">
          <p className="font-semibold">{ct('purchase.binance_address_title')}</p>
          {network && <p>{ct('purchase.binance_network_warning', { network })}</p>}
          <p>{ct('purchase.binance_fee_note')}</p>
        </div>
      </div>
    )
  }
  if (!text(payment.pay_id)) return null
  return (
    <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-[#584F72]">
      <Info size={14} className="mt-px shrink-0 text-[#6559CA]" aria-hidden="true" />
      <span>{ct('purchase.binance_pay_id_note')}</span>
    </p>
  )
}

function Step({ n, title, children }: { n: number; title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <li className="rounded-[20px] nice-shadow bg-white p-4 sm:p-6">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#190933] text-sm font-bold text-white"
        >
          {n}
        </span>
        <h2 className="min-w-0 pt-0.5 text-lg font-bold leading-snug text-[#190933]">{title}</h2>
      </div>
      {children && <div className="mt-3">{children}</div>}
    </li>
  )
}

function Panel({
  tone,
  icon,
  title,
  titleRef,
  children,
}: {
  tone: 'success' | 'warning' | 'error' | 'neutral'
  icon: React.ReactNode
  title: string
  /** Lets the page move focus to the new state (after cancelling). */
  titleRef?: React.Ref<HTMLHeadingElement>
  children?: React.ReactNode
}) {
  const toneCls = {
    success: 'bg-[#EEEDFF] border-[#BBBBFF]',
    warning: 'bg-amber-50 border-amber-200',
    error: 'bg-red-50 border-red-200',
    neutral: 'bg-[#FFFCF9] border-[#EAE8F2]',
  }[tone]
  return (
    <div role="status" className={`rounded-[20px] border p-5 ${toneCls}`}>
      <div className="flex items-start gap-3">
        <div className="shrink-0 mt-0.5">{icon}</div>
        <div className="min-w-0 flex-1 space-y-3">
          <h2 ref={titleRef} tabIndex={-1} className="font-bold text-[#190933] text-lg leading-snug break-words focus:outline-none">
            {title}
          </h2>
          {children}
        </div>
      </div>
    </div>
  )
}

/** Unique course/ebook pages of an order. */
function orderResources(purchase: Purchase): PurchaseResource[] {
  const seen = new Set<string>()
  const out: PurchaseResource[] = []
  for (const item of purchase.items ?? []) {
    for (const r of item.resources ?? []) {
      const key = stripCoursePrefix(r.course_uuid ?? r.resource_uuid)
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(r)
    }
  }
  return out
}

function ResourceLinks({ purchase, orgslug, ct }: { purchase: Purchase; orgslug: string; ct: CartTranslate }) {
  const resources = orderResources(purchase)
  if (resources.length === 0) return null
  return (
    <div className="space-y-2">
      {resources.map((r) => {
        const isEbook = normalizeProductType(r.product_type) === 'ebook'
        const href = getUriWithOrg(orgslug, `/course/${stripCoursePrefix(r.course_uuid ?? r.resource_uuid)}`)
        return (
          <Link
            key={href}
            href={href}
            className="flex items-center justify-between gap-3 bg-white border border-[#EAE8F2] rounded-full ps-4 pe-1.5 py-1.5 min-h-[48px] hover:bg-[#FFFCF9] transition-colors"
          >
            <span className="flex items-center gap-2 min-w-0">
              {isEbook ? (
                <BookMarked size={15} className="text-[#AC4691] shrink-0" aria-hidden="true" />
              ) : (
                <BookOpen size={15} className="text-[#6559CA] shrink-0" aria-hidden="true" />
              )}
              <span className="text-sm font-medium text-[#190933] truncate">{r.name}</span>
            </span>
            <span className="shrink-0 inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-[#190933] rounded-full px-3 py-2">
              {isEbook ? ct('purchase.read_ebook') : ct('purchase.go_to_course')}
              <ArrowRight size={12} aria-hidden="true" />
            </span>
          </Link>
        )
      })}
    </div>
  )
}

function ProductsCard({
  purchase,
  pay,
  ct,
  sc,
}: {
  purchase: Purchase
  pay: PurchasePay
  ct: CartTranslate
  sc: ScTranslate
}) {
  const equivalent = payEquivalent(pay, purchase.amount, ct)
  return (
    <section className="rounded-[20px] nice-shadow bg-white p-4 sm:p-6" aria-labelledby="purchase-products-title">
      <h2
        id="purchase-products-title"
        className="text-[13px] font-semibold text-[#AC4691] uppercase tracking-[0.18em] mb-2"
      >
        {ct('purchase.products_title')}
      </h2>
      <ul>
        {(purchase.items ?? []).map((item) => {
          const resources = item.resources ?? []
          const isEbook = resources.length > 0 && resources.every((r) => normalizeProductType(r.product_type) === 'ebook')
          return (
            <li
              key={item.order_uuid || item.offer_uuid}
              className="flex items-start justify-between gap-3 py-3 border-b border-[#EAE8F2] last:border-b-0"
            >
              <div className="min-w-0">
                <p className="font-semibold text-[#190933] leading-snug break-words">{item.name}</p>
                <p className="text-xs text-[#6D6485] mt-0.5">
                  {isEbook ? ct('product.ebook') : ct('product.course')}
                  {resources.length > 1 && ` · ${ct('product.includes', { count: resources.length })}`}
                </p>
              </div>
              <span className="shrink-0 font-semibold text-[#190933] tabular-nums">{formatUsd(item.amount)}</span>
            </li>
          )
        })}
      </ul>
      <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-[#EAE8F2] pt-3">
        <span className="text-sm font-semibold text-[#584F72]">{ct('purchase.total')}</span>
        <span className="text-end">
          <span className="block font-black text-[#190933] tabular-nums">{payAmountText(pay, purchase.amount)}</span>
          {equivalent && <span className="block text-xs text-[#6D6485] tabular-nums">{equivalent}</span>}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-[#EAE8F2] pt-3">
        <span className="text-sm font-semibold text-[#584F72]">{ct('purchase.method_label')}</span>
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#190933]">
          <MethodIcon method={pay.method} size={15} className="shrink-0 text-[#6559CA]" />
          {methodLabel(pay.method, sc)}
        </span>
      </div>
    </section>
  )
}

function CancelDialog({
  open,
  onOpenChange,
  onConfirm,
  restoreFocus,
  loginHref,
  ct,
}: {
  open: boolean
  onOpenChange: (_open: boolean) => void
  onConfirm: () => Promise<CancelResult>
  /** Where focus goes when the dialog closes (null: back to the trigger). */
  restoreFocus: () => HTMLElement | null
  loginHref: string
  ct: CartTranslate
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<{ message: string; login?: boolean } | null>(null)
  const keepRef = useRef<HTMLButtonElement>(null)

  const confirm = async () => {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const result = await onConfirm()
      if (result.ok) onOpenChange(false)
      else setError({ message: result.message, login: result.login })
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Don't hide the dialog while the request is in flight.
        if (!next && pending) return
        if (!next) setError(null)
        onOpenChange(next)
      }}
    >
      <DialogContent
        className="w-[calc(100vw-32px)] max-w-md rounded-[20px] border-[#EAE8F2] bg-[#FFFCF9] p-6 sm:p-7"
        // Start on the safe choice, not on the destructive one.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          keepRef.current?.focus()
        }}
        // The trigger is gone once the order changes: focus its new state.
        onCloseAutoFocus={(event) => {
          const target = restoreFocus()
          if (target) {
            event.preventDefault()
            target.focus()
          }
        }}
      >
        <DialogHeader className="space-y-2 pe-8 text-start">
          <DialogTitle className="text-xl font-semibold leading-snug text-[#190933]">
            {ct('purchase.cancel_title')}
          </DialogTitle>
          <DialogDescription className="text-[15px] leading-relaxed text-[#41375B]">
            {ct('purchase.cancel_description')}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <div role="alert" className="mt-4 text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-3 py-2 space-y-1">
            <p>{error.message}</p>
            {error.login && (
              <Link href={loginHref} className="inline-flex items-center gap-1 font-semibold underline underline-offset-2">
                <LogIn size={13} aria-hidden="true" /> {ct('purchase.login')}
              </Link>
            )}
          </div>
        )}
        <DialogFooter className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:space-x-0">
          <button
            type="button"
            onClick={confirm}
            disabled={pending}
            aria-busy={pending}
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full border border-[#EAE8F2] bg-white px-5 py-2.5 text-sm font-semibold text-[#AC4691] transition-colors hover:border-[#F0B4DF] hover:bg-[#F9DDF0]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F0B4DF] disabled:opacity-70 cursor-pointer disabled:cursor-wait"
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {pending ? ct('purchase.cancelling') : ct('purchase.cancel_confirm')}
          </button>
          <button
            type="button"
            ref={keepRef}
            onClick={() => onOpenChange(false)}
            disabled={pending}
            className={`${PRIMARY_BTN} min-h-[44px] px-5 py-2.5 text-sm disabled:opacity-70`}
          >
            {ct('purchase.cancel_keep')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CenteredMessage({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode
  title: string
  description?: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-14 h-14 rounded-2xl bg-[#EEEDFF] flex items-center justify-center mb-4">{icon}</div>
      <h1 className="font-bold text-[#190933] text-xl">{title}</h1>
      {description && <p className="text-sm text-[#584F72] mt-1 max-w-sm">{description}</p>}
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PurchasePage({
  orgslug,
  orgId,
  purchaseUuid,
}: {
  orgslug: string
  orgId: number
  purchaseUuid: string
}) {
  const { ct, lng } = useCartT()
  const { sc } = useScT()
  const router = useRouter()
  const queryClient = useQueryClient()
  const session = useLHSession() as any
  const token: string | null = session?.data?.tokens?.access_token ?? null
  const cart = useCart(orgId)
  const [cancelOpen, setCancelOpen] = useState(false)
  const statusTitleRef = useRef<HTMLHeadingElement>(null)
  const focusStatusOnClose = useRef(false)
  const validUuid = isPlausiblePurchaseUuid(purchaseUuid)

  const query = useQuery<Purchase>({
    queryKey: cartKeys.purchase(orgId, purchaseUuid),
    queryFn: async () => {
      const res = await getPurchase(orgId, purchaseUuid, token as string)
      if (res.success && res.data?.purchase_uuid) return res.data as Purchase
      throw new CartApiError(res.status, res.data)
    },
    enabled: validUuid && !!token,
    retry: (failures, error) => {
      const status = error instanceof CartApiError ? error.status : 0
      return ![401, 403, 404, 429].includes(status) && failures < 2
    },
    // Poll while it waits for the confirmation; react-query pauses the
    // interval while the tab is hidden.
    refetchInterval: (q) => (q.state.data?.status === 'pending' ? POLL_MS : false),
    refetchIntervalInBackground: false,
  })
  const purchase = query.data
  const status = purchaseStatus(purchase?.status)

  // Paid: refresh everything that depends on ownership (same as the offer
  // page's refreshOwnership).
  const lastStatus = useRef<string | null>(null)
  useEffect(() => {
    const previous = lastStatus.current
    lastStatus.current = status
    if (status === 'paid' && previous && previous !== 'paid') {
      queryClient.invalidateQueries({ queryKey: ['payments', orgId] })
      queryClient.invalidateQueries({ queryKey: ['offers', 'by-resource'] })
      queryClient.invalidateQueries({ queryKey: queryKeys.trail.org(orgId) })
      revalidateTags(['courses'], orgslug).catch(() => {})
      router.refresh()
    }
  }, [status, queryClient, orgId, orgslug, router])

  const purchasesHref = getUriWithOrg(orgslug, '/account/purchases')
  const storeHref = getUriWithOrg(orgslug, '/store')
  const loginHref = getUriWithOrg(orgslug, withRedirect('/login', `/store/purchases/${purchaseUuid}`))

  const cancel = async (): Promise<CancelResult> => {
    if (!token) return { ok: false, message: ct('purchase.session_expired'), login: true }
    try {
      const res = await cancelPurchase(orgId, purchaseUuid, token)
      if (res.success && res.data?.purchase_uuid) {
        queryClient.setQueryData(cartKeys.purchase(orgId, purchaseUuid), res.data as Purchase)
        queryClient.invalidateQueries({ queryKey: ['payments', orgId] })
        focusStatusOnClose.current = true
        toast.success(ct('purchase.cancelled_toast'))
        return { ok: true }
      }
      if (res.status === 401) {
        // Never the API's own (English) wording here.
        return { ok: false, message: ct('purchase.session_expired'), login: true }
      }
      if (res.status === 409) {
        // NOT_PENDING: it changed meanwhile (paid, expired…); show the new state.
        toast.error(apiMessage(res.data, res.status) ?? ct('purchase.cancel_error'))
        focusStatusOnClose.current = true
        await query.refetch()
        return { ok: true }
      }
      return { ok: false, message: apiMessage(res.data, res.status) ?? ct('purchase.cancel_error') }
    } catch {
      return { ok: false, message: ct('purchase.cancel_error') }
    }
  }

  const restoreFocus = (): HTMLElement | null => {
    if (!focusStatusOnClose.current) return null
    focusStatusOnClose.current = false
    return statusTitleRef.current
  }

  const newOrder = () => {
    let full = false
    for (const item of purchase?.items ?? []) {
      if (cart.add(item.offer_uuid) === 'full') full = true
    }
    if (full) toast.error(ct('purchase.new_order_full'))
    router.push(getUriWithOrg(orgslug, '/store/cart'))
  }

  // -------------------------------------------------------------------------
  // Not found / no session / loading / error
  // -------------------------------------------------------------------------

  const errorStatus = query.error instanceof CartApiError ? query.error.status : 0
  const notFound = !validUuid || ([403, 404].includes(errorStatus) && !purchase)

  if (notFound) {
    return (
      <GeneralWrapperStyled>
        <CenteredMessage
          icon={<AlertCircle size={26} className="text-[#6559CA]" aria-hidden="true" />}
          title={ct('purchase.not_found_title')}
          description={ct('purchase.not_found_description')}
        >
          <Link href={purchasesHref} className={`${PRIMARY_BTN} mt-5 px-5 min-h-[44px] text-sm`}>
            {ct('purchase.my_purchases')} <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </CenteredMessage>
      </GeneralWrapperStyled>
    )
  }

  // No session in the browser, or the API no longer accepts it (401).
  if (!token || (errorStatus === 401 && !purchase)) {
    return (
      <GeneralWrapperStyled>
        <CenteredMessage icon={<LogIn size={24} className="text-[#6559CA]" aria-hidden="true" />} title={ct('purchase.login_title')}>
          <Link href={loginHref} className={`${PRIMARY_BTN} mt-5 px-6 min-h-[44px] text-sm`}>
            <LogIn size={15} aria-hidden="true" /> {ct('purchase.login')}
          </Link>
        </CenteredMessage>
      </GeneralWrapperStyled>
    )
  }

  if (!purchase) {
    if (query.isError) {
      return (
        <GeneralWrapperStyled>
          <CenteredMessage
            icon={<AlertCircle size={26} className="text-red-500" aria-hidden="true" />}
            title={ct('purchase.load_error')}
          >
            <button
              type="button"
              onClick={() => query.refetch()}
              className={`${SECONDARY_BTN} mt-5 px-5 min-h-[44px] text-sm`}
            >
              <RefreshCw size={14} aria-hidden="true" /> {ct('purchase.retry')}
            </button>
          </CenteredMessage>
        </GeneralWrapperStyled>
      )
    }
    return (
      <GeneralWrapperStyled>
        <div role="status" className="flex items-center justify-center gap-2 py-24 text-sm text-[#584F72]">
          <Loader2 size={18} className="animate-spin" aria-hidden="true" /> {ct('purchase.loading')}
        </div>
      </GeneralWrapperStyled>
    )
  }

  // -------------------------------------------------------------------------
  // The order
  // -------------------------------------------------------------------------

  const payment = purchase.payment
  // Its method, and what she pays in that method's currency.
  const pay = purchasePay(purchase)
  const waUrl = safeWhatsappUrl(purchase.whatsapp_url, purchase.whatsapp_number ?? undefined)
  const waNumber = formatWhatsappNumber(purchase.whatsapp_number)
  // Plain chat (no prefilled message): rejected, voided or closed orders.
  const chatUrl = whatsappChatUrl(purchase.whatsapp_number)
  // Only the methods paid in bolívares have a rate.
  const rateLine =
    pay.currency !== 'VES'
      ? ''
      : purchase.fx_source === 'manual'
        ? ct('purchase.rate_manual', { usd: formatUsd(purchase.amount), rate: formatRate(purchase.fx_rate) })
        : ct('purchase.rate_bcv', {
            usd: formatUsd(purchase.amount),
            rate: formatRate(purchase.fx_rate),
            date: formatIsoDate(purchase.fx_date),
          })

  const whatsappButton = waUrl ? (
    <a href={waUrl} target="_blank" rel="noopener" className={`${WHATSAPP_BTN} w-full min-h-[56px] px-6 py-3.5 text-base`}>
      <SiWhatsapp size={20} aria-hidden="true" />
      {ct('purchase.whatsapp_button')}
    </a>
  ) : null

  const chatButton = chatUrl ? (
    <a href={chatUrl} target="_blank" rel="noopener" className={`${WHATSAPP_BTN} w-full min-h-[52px] px-5 text-sm`}>
      <SiWhatsapp size={18} aria-hidden="true" /> {ct('purchase.contact_whatsapp')}
    </a>
  ) : null

  const renderPending = () => (
    <>
      <p className="flex items-center gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
        <Clock size={16} className="shrink-0" aria-hidden="true" />
        {ct('purchase.deadline', { date: formatCaracasDateTime(purchase.expires_at, lng) })}
      </p>

      <ol className="space-y-4">
        <Step
          n={1}
          title={
            <>
              {payStepTitle(pay.method, ct)}{' '}
              <strong className="whitespace-nowrap font-black text-[#4F43A4]">{payAmountText(pay, purchase.amount)}</strong>
            </>
          }
        >
          {payment ? <PaymentDetails pay={pay} payment={payment} ct={ct} /> : null}
          {rateLine && <p className="mt-3 text-xs text-[#584F72] tabular-nums">{rateLine}</p>}
          {payment && pay.method === 'binance' && <BinanceNote payment={payment} ct={ct} />}
          {payment?.instructions && (
            <div className="mt-3 rounded-2xl bg-[#EEEDFF] px-4 py-3">
              <p className="text-xs font-semibold text-[#4F43A4]">{ct('purchase.instructions_title')}</p>
              <p className="mt-1 text-sm text-[#41375B] leading-relaxed whitespace-pre-line break-words">
                {payment.instructions}
              </p>
            </div>
          )}
        </Step>

        <Step n={2} title={ct('purchase.step2_title')}>
          <p className="text-sm text-[#584F72] leading-relaxed mb-3">{ct('purchase.step2_description')}</p>
          {whatsappButton}
          {waNumber && (
            <p className="mt-2.5 text-center text-sm text-[#584F72]">
              {ct('purchase.whatsapp_or', { number: waNumber })}
            </p>
          )}
        </Step>

        <Step
          n={3}
          title={
            <span className="flex items-start gap-2">
              <span>{ct('purchase.step3_title')}</span>
              <Mail size={18} className="mt-1 shrink-0 text-[#6559CA]" aria-hidden="true" />
            </span>
          }
        />
      </ol>
    </>
  )

  const renderClosed = () => {
    switch (status) {
      case 'paid':
        return (
          <Panel
            tone="success"
            icon={<CheckCircle2 size={24} className="text-[#6559CA]" aria-hidden="true" />}
            title={ct('purchase.paid_title')}
            titleRef={statusTitleRef}
          >
            <p className="text-sm text-[#41375B]">{ct('purchase.paid_description')}</p>
            <ResourceLinks purchase={purchase} orgslug={orgslug} ct={ct} />
          </Panel>
        )
      case 'expired':
        return (
          <Panel
            tone="warning"
            icon={<CalendarX size={22} className="text-amber-700" aria-hidden="true" />}
            title={ct('purchase.expired_title')}
            titleRef={statusTitleRef}
          >
            <p className="text-sm text-[#41375B] leading-relaxed">{ct('purchase.expired_description')}</p>
            {whatsappButton}
            <button type="button" onClick={newOrder} className={`${SECONDARY_BTN} w-full min-h-[48px] px-5 text-sm`}>
              <ShoppingCart size={15} aria-hidden="true" /> {ct('purchase.new_order')}
            </button>
          </Panel>
        )
      case 'rejected':
        return (
          <Panel
            tone="error"
            icon={<XCircle size={22} className="text-red-600" aria-hidden="true" />}
            title={ct('purchase.rejected_title')}
            titleRef={statusTitleRef}
          >
            {purchase.reject_reason && (
              <p className="text-sm text-[#41375B] leading-relaxed break-words">
                {ct('purchase.rejected_reason', { reason: purchase.reject_reason })}
              </p>
            )}
            {chatButton}
          </Panel>
        )
      case 'cancelled':
        // Closed by the API because the same products were paid in another
        // order: its reason says which ("Estos productos ya se pagaron…").
        if (purchase.reject_reason) {
          return (
            <Panel
              tone="neutral"
              icon={<Info size={22} className="text-[#6559CA]" aria-hidden="true" />}
              title={purchase.reject_reason}
              titleRef={statusTitleRef}
            >
              <Link href={purchasesHref} className={`${PRIMARY_BTN} px-5 min-h-[44px] text-sm`}>
                {ct('purchase.my_purchases')} <ArrowRight size={14} aria-hidden="true" />
              </Link>
              {chatButton}
            </Panel>
          )
        }
        return (
          <Panel
            tone="neutral"
            icon={<XCircle size={22} className="text-[#6559CA]" aria-hidden="true" />}
            title={ct('purchase.cancelled_title')}
            titleRef={statusTitleRef}
          >
            <Link href={storeHref} className={`${PRIMARY_BTN} px-5 min-h-[44px] text-sm`}>
              <ArrowLeft size={14} aria-hidden="true" /> {ct('purchase.back_to_store')}
            </Link>
          </Panel>
        )
      case 'voided':
        return (
          <Panel
            tone="neutral"
            icon={<Ban size={22} className="text-[#AC4691]" aria-hidden="true" />}
            title={ct('purchase.voided_title')}
            titleRef={statusTitleRef}
          >
            {chatButton}
          </Panel>
        )
      default:
        return null
    }
  }

  return (
    <div className="w-full">
      <GeneralWrapperStyled>
        <div className="mx-auto max-w-2xl">
          <Link
            href={purchasesHref}
            className="inline-flex items-center gap-1.5 text-sm text-[#6D6485] hover:text-[#190933] transition-colors mb-5"
          >
            <ArrowLeft size={14} aria-hidden="true" /> {ct('purchase.my_purchases')}
          </Link>

          <header className="mb-5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h1 className="text-2xl font-black text-[#190933] tracking-tight tabular-nums break-words">
                {ct('purchase.title', { code: purchase.code })}
              </h1>
              <PurchaseStatusChip status={purchase.status} />
            </div>
            {purchase.created_at && (
              <p className="mt-1 text-sm text-[#6D6485]">
                {ct('purchase.created_on', { date: formatCaracasDateTime(purchase.created_at, lng) })}
              </p>
            )}
          </header>

          <div className="space-y-4">
            {status === 'pending' ? renderPending() : renderClosed()}

            <ProductsCard purchase={purchase} pay={pay} ct={ct} sc={sc} />

            {status === 'pending' && purchase.can_cancel && (
              <div className="pt-2 text-center">
                <button
                  type="button"
                  onClick={() => setCancelOpen(true)}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full px-4 text-sm font-medium text-[#6D6485] underline underline-offset-2 transition-colors hover:text-[#AC4691] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BBBBFF]"
                >
                  {ct('purchase.cancel_link')}
                </button>
              </div>
            )}
          </div>
        </div>
        <CancelDialog
          open={cancelOpen}
          onOpenChange={setCancelOpen}
          onConfirm={cancel}
          restoreFocus={restoreFocus}
          loginHref={loginHref}
          ct={ct}
        />
      </GeneralWrapperStyled>
    </div>
  )
}

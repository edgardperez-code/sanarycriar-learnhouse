'use client'
// Sanar y Criar: one order paid by hand in full (cart contract §C.4, manual
// methods contract §A.6): who bought, what, how much and with which method
// (in bolívares with the rate, in US$ by Zelle or in USDT by Binance), the
// payment details the buyer sees, the confirmation, the reasons, and the
// actions its state allows. A dialog on a computer, the whole screen wherever
// the dashboard shows its floating mobile dock (up to 1024 px, see
// ClientAdminLayout); the dock sits above dialogs, so the bottom of the screen
// is left free for it.
//
// While open, the order refreshes every 15 s and when the window gets the
// focus back. Opening moves the focus to the title; closing gives it back to
// the row that opened it (onCloseFocus).
import React, { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { AlertTriangle, BookOpen, ExternalLink, FileText, Info, Loader2, Mail, UserRound } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@components/ui/dialog'
import { useScT } from '@components/Payments/useScT'
import { paymentLabel, stripCoursePrefix } from '@components/Payments/commerce'
import { safeExternalUrl } from '@services/security/url'
import { formatRelative } from '@/lib/format'
import { queryKeys } from '@/lib/query/keys'
import {
  PurchaseAdmin,
  PurchaseItem,
  PurchasePayment,
  PurchaseResource,
  bankText,
  customerName,
  formatAccountNumber,
  formatDateTime,
  formatIsoDate,
  formatPurchasePay,
  formatRate,
  formatUsd,
  isOrderStatus,
  networkLabel,
  purchasePay,
  refundText,
  usdLine,
} from './ordersForm'
import { ExpiresBadge, MethodIcon, StatusChip, useNow } from './OrderBits'
import {
  FulfillmentRetry,
  OrderAction,
  OrderActionButtons,
  OrderActionDone,
  OrderActionForm,
  OrderChanged,
  actionAllowed,
} from './OrderActions'
import { isNotFound, useOrdersAuth, usePurchaseDetail } from './useOrdersApi'
import { OrdersTranslate, accountTypeLabel, ordersLabel, useOrdersT } from './useOrdersT'

type Props = {
  /** The order to show; null closes the dialog. */
  purchaseUuid: string | null
  /** The list row, shown while the fresh copy loads. */
  placeholder: PurchaseAdmin | null
  onClose: () => void
  /** Gives the focus back to whatever opened the dialog. */
  onCloseFocus?: () => void
}

export default function OrderDetailDialog({ purchaseUuid, placeholder, onClose, onCloseFocus }: Props) {
  const contentRef = useRef<HTMLDivElement>(null)
  return (
    <Dialog open={!!purchaseUuid} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        ref={contentRef}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          contentRef.current?.querySelector<HTMLElement>('[data-order-title]')?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onCloseFocus?.()
        }}
        className="flex h-[100dvh] max-h-[100dvh] w-screen max-w-none flex-col overflow-hidden rounded-none border-0 p-0 min-[1025px]:h-auto min-[1025px]:max-h-[90vh] min-[1025px]:w-[95vw] min-[1025px]:max-w-2xl min-[1025px]:rounded-2xl min-[1025px]:border"
      >
        {/* Keyed by order: another order starts again on its detail view. */}
        {purchaseUuid && <DetailBody key={purchaseUuid} purchaseUuid={purchaseUuid} placeholder={placeholder} />}
      </DialogContent>
    </Dialog>
  )
}

type Notice = { tone: 'warning' | 'error'; text: string }

function DetailBody({ purchaseUuid, placeholder }: { purchaseUuid: string; placeholder: PurchaseAdmin | null }) {
  const { ot, lng } = useOrdersT()
  const queryClient = useQueryClient()
  const { orgId } = useOrdersAuth()
  const now = useNow()
  const { data, error } = usePurchaseDetail(purchaseUuid, placeholder)
  const [view, setView] = useState<'detail' | OrderAction>('detail')
  const [notice, setNotice] = useState<Notice | null>(null)

  const purchase = data ?? null

  const store = (fresh: PurchaseAdmin | null | undefined) => {
    if (fresh && typeof fresh === 'object' && fresh.purchase_uuid) {
      queryClient.setQueryData(queryKeys.orders.detail(orgId, fresh.purchase_uuid), fresh)
    }
  }

  const pick = (action: OrderAction) => {
    setNotice(null)
    setView(action)
  }

  const onDone: OrderActionDone = (updated, action, extra) => {
    const fresh = updated && typeof updated === 'object' && updated.purchase_uuid ? updated : null
    store(fresh)
    // Lists, the menu count, customers, transactions and access all hang from here.
    queryClient.invalidateQueries({ queryKey: ['payments', orgId] })
    setView('detail')
    if (action === 'confirm') {
      if (extra.otherReference) {
        // Someone confirmed it first: nothing changed, she should know with which reference.
        setNotice({ tone: 'warning', text: ot('detail.already_confirmed', { reference: extra.otherReference }) })
        return
      }
      const name = customerName(fresh?.customer ?? purchase?.customer)
      toast.success(name ? ot('confirm_form.success', { name }) : ot('confirm_form.success_unnamed'))
    } else if (action === 'reject') {
      toast.success(extra.notified ? ot('reject_form.success_notified') : ot('reject_form.success'))
    } else {
      toast.success(ot('void_form.success'))
    }
  }

  const onChanged: OrderChanged = (fresh) => {
    store(fresh)
    queryClient.invalidateQueries({ queryKey: ['payments', orgId, 'orders'] })
    setView('detail')
    if (fresh && isOrderStatus(fresh.status)) {
      setNotice({ tone: 'warning', text: ordersLabel(ot, 'changed', fresh.status) })
    } else {
      setNotice({ tone: 'error', text: ot('detail.not_found') })
    }
  }

  const onRetried = (updated: PurchaseAdmin) => {
    store(updated)
    queryClient.invalidateQueries({ queryKey: ['payments', orgId] })
  }

  const formView = purchase && view !== 'detail' && actionAllowed(view, purchase.status) ? view : null
  // The 15 s refresh moved the order out of the state its open form needs: say why the form left.
  const shownNotice: Notice | null =
    notice ??
    (purchase && view !== 'detail' && !formView && isOrderStatus(purchase.status)
      ? { tone: 'warning', text: ordersLabel(ot, 'changed', purchase.status) }
      : null)

  return (
    <>
      {/* One header for every state: the title keeps the focus when the data arrives. */}
      <DialogHeader className="space-y-1.5 border-b border-gray-100 px-5 py-4 pe-14 text-start">
        <div className="flex flex-wrap items-center gap-2">
          <DialogTitle
            data-order-title=""
            tabIndex={-1}
            className="rounded text-lg text-[#190933] outline-none focus-visible:ring-2 focus-visible:ring-[#7D75E2]"
          >
            {purchase ? ot('detail.title', { code: purchase.code }) : ot('title')}
          </DialogTitle>
          {purchase && <StatusChip status={purchase.status} ot={ot} />}
        </div>
        {purchase ? (
          <DialogDescription className="text-xs text-gray-500">
            {ot('detail.created', { date: formatDateTime(purchase.created_at) })}
            {' · '}
            {formatRelative(purchase.created_at, lng)}
          </DialogDescription>
        ) : (
          <DialogDescription className="sr-only">{ot('detail.loading')}</DialogDescription>
        )}
      </DialogHeader>

      {!purchase ? (
        <div className="flex flex-1 items-center justify-center px-5 py-12 text-sm text-gray-500">
          {error ? (
            <p role="alert" className="text-red-600">
              {isNotFound(error) ? ot('detail.not_found') : ot('detail.load_error')}
            </p>
          ) : (
            <p className="flex items-center gap-2">
              <Loader2 size={16} className="animate-spin" aria-hidden />
              {ot('detail.loading')}
            </p>
          )}
        </div>
      ) : formView ? (
        <div className="flex-1 overflow-y-auto overscroll-contain px-5 pt-5 pb-[calc(6rem+env(safe-area-inset-bottom))] space-y-4 min-[1025px]:pb-5">
          <ActionSummary purchase={purchase} ot={ot} />
          <OrderActionForm
            purchase={purchase}
            action={formView}
            onBack={() => setView('detail')}
            onDone={onDone}
            onChanged={onChanged}
          />
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-5 space-y-5">
            {shownNotice && <NoticeBox notice={shownNotice} />}
            {purchase.needs_fulfillment && purchase.status === 'paid' && (
              <FulfillmentRetry purchase={purchase} onUpdated={onRetried} />
            )}
            <Timing purchase={purchase} ot={ot} now={now} />
            <AmountCard purchase={purchase} ot={ot} />
            <CustomerSection purchase={purchase} ot={ot} />
            <ProductsSection purchase={purchase} ot={ot} />
            <PaymentSection purchase={purchase} ot={ot} />
            <ConfirmationSection purchase={purchase} ot={ot} />
          </div>
          <div className="border-t border-gray-100 bg-[#FFFCF9] px-5 pt-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] min-[1025px]:pb-4">
            <OrderActionButtons purchase={purchase} onPick={pick} />
          </div>
        </>
      )}
    </>
  )
}

function NoticeBox({ notice }: { notice: Notice }) {
  const error = notice.tone === 'error'
  return (
    <p
      role="status"
      className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium ${
        error ? 'border-red-200 bg-red-50 text-red-700' : 'border-amber-200 bg-amber-50 text-amber-900'
      }`}
    >
      {error ? <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden /> : <Info size={16} className="mt-0.5 shrink-0" aria-hidden />}
      <span>{notice.text}</span>
    </p>
  )
}

function Section({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[#584F72]">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  )
}

function InfoList({ rows }: { rows: Array<{ label: string; value: React.ReactNode; mono?: boolean } | null | false> }) {
  const visible = rows.filter(Boolean) as Array<{ label: string; value: React.ReactNode; mono?: boolean }>
  if (!visible.length) return null
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-xl border border-[#EAE8F2] bg-white px-4 py-3 text-sm sm:grid-cols-2">
      {visible.map((row) => (
        <div key={row.label} className="min-w-0">
          <dt className="text-xs text-gray-500">{row.label}</dt>
          {/* overflow-wrap:anywhere: a long e-mail or note breaks instead of widening the dialog. */}
          <dd className={`text-[#190933] [overflow-wrap:anywhere] ${row.mono ? 'font-mono' : ''}`}>{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** "Tasa: 887,30 Bs/US$ · BCV 27/10/2026"; null when the order has no rate (Zelle, Binance). */
function rateText(purchase: PurchaseAdmin, ot: OrdersTranslate): string | null {
  if (purchasePay(purchase).currency !== 'VES' || purchase.fx_rate === null || purchase.fx_rate === undefined) return null
  const rate = formatRate(purchase.fx_rate)
  if (purchase.fx_source === 'manual') return ot('detail.rate_manual', { rate })
  return purchase.fx_date
    ? ot('detail.rate_bcv', { rate, date: formatIsoDate(purchase.fx_date) })
    : ot('detail.rate_bcv_undated', { rate })
}

/** Code, buyer and amount on top of an action form. */
function ActionSummary({ purchase, ot }: { purchase: PurchaseAdmin; ot: OrdersTranslate }) {
  const name = customerName(purchase.customer) || ot('list.no_customer')
  const usd = usdLine(purchase)
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 rounded-xl border border-[#EAE8F2] bg-[#FFFCF9] px-4 py-3">
      <div className="min-w-0">
        <p className="font-mono text-sm font-semibold text-[#190933]">{purchase.code}</p>
        <p className="truncate text-sm text-gray-600">{name}</p>
      </div>
      <div className="text-end">
        <p className="text-xl font-bold tracking-tight text-[#190933]">{formatPurchasePay(purchase)}</p>
        {usd && <p className="text-xs text-gray-500">{usd}</p>}
      </div>
    </div>
  )
}

function Timing({ purchase, ot, now }: { purchase: PurchaseAdmin; ot: OrdersTranslate; now: number }) {
  if (purchase.status === 'pending') {
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-gray-600">
        <span>{ot('detail.expires_on', { date: formatDateTime(purchase.expires_at) })}</span>
        <ExpiresBadge expiresAt={purchase.expires_at} now={now} ot={ot} />
      </p>
    )
  }
  if (purchase.status === 'expired') {
    return <p className="text-sm text-gray-600">{ot('detail.expired_on', { date: formatDateTime(purchase.expires_at) })}</p>
  }
  if (purchase.closed_at) {
    return <p className="text-sm text-gray-600">{ot('detail.closed_on', { date: formatDateTime(purchase.closed_at) })}</p>
  }
  return null
}

function AmountCard({ purchase, ot }: { purchase: PurchaseAdmin; ot: OrdersTranslate }) {
  const { sc } = useScT()
  const method = paymentLabel(purchase.provider, purchase.method, sc)
  const usd = usdLine(purchase)
  const rate = rateText(purchase, ot)
  return (
    <div className="rounded-2xl bg-[#190933] px-5 py-4 text-white">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-white/60">{ot('detail.section_amount')}</p>
        {method && (
          <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/90">
            <MethodIcon method={purchase.method} size={12} className="shrink-0" />
            <span className="sr-only">{ot('detail.method')}: </span>
            {method}
          </span>
        )}
      </div>
      <p className="mt-1 text-3xl font-bold tracking-tight">{formatPurchasePay(purchase)}</p>
      {usd && <p className="text-sm text-white/80">{usd}</p>}
      {rate && <p className="mt-2 text-xs text-[#C9C5F5]">{rate}</p>}
    </div>
  )
}

function CustomerSection({ purchase, ot }: { purchase: PurchaseAdmin; ot: OrdersTranslate }) {
  const customer = purchase.customer
  const name = customerName(customer)
  return (
    <Section title={ot('detail.section_customer')} icon={<UserRound size={13} aria-hidden />}>
      {customer ? (
        <InfoList
          rows={[
            { label: ot('list.col_customer'), value: name || '—' },
            customer.email
              ? {
                  label: ot('detail.email'),
                  value: (
                    <a href={`mailto:${customer.email}`} className="text-[#4F43A4] underline-offset-2 [overflow-wrap:anywhere] hover:underline">
                      <Mail size={13} aria-hidden className="me-1 inline-block align-[-2px]" />
                      {customer.email}
                    </a>
                  ),
                }
              : null,
            customer.username ? { label: ot('detail.username'), value: customer.username, mono: true } : null,
          ]}
        />
      ) : (
        <p className="text-sm text-gray-500">{ot('list.no_customer')}</p>
      )}
    </Section>
  )
}

function resourceHref(resource: PurchaseResource): string {
  return safeExternalUrl(resource.course_url) ?? `/course/${stripCoursePrefix(resource.course_uuid || resource.resource_uuid)}`
}

/**
 * "Esta persona ya tenía este producto (pedido SYC-…): devuélvele US$ 25,00
 * (Bs. 22.182,55)." In bolívares, its share of what was paid; by Zelle its
 * US$, by Binance its USDT.
 */
function DuplicateNotice({ item, purchase, ot }: { item: PurchaseItem; purchase: PurchaseAdmin; ot: OrdersTranslate }) {
  const duplicate = item.duplicate_of
  if (!duplicate) return null
  const amount = refundText(item.amount, purchase)
  return (
    <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
      <AlertTriangle size={14} className="mt-px shrink-0" aria-hidden />
      <span>
        {duplicate.purchase_code
          ? ot('detail.duplicate', { code: duplicate.purchase_code, amount })
          : ot('detail.duplicate_other', { amount })}
      </span>
    </p>
  )
}

function ProductsSection({ purchase, ot }: { purchase: PurchaseAdmin; ot: OrdersTranslate }) {
  const items = Array.isArray(purchase.items) ? purchase.items : []
  return (
    <Section title={ot('detail.section_products')} icon={<BookOpen size={13} aria-hidden />}>
      <ul className="divide-y divide-[#EAE8F2] rounded-xl border border-[#EAE8F2] bg-white">
        {items.map((item) => (
          <li key={item.order_uuid || item.offer_uuid} className="space-y-1.5 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 font-medium text-[#190933]">{item.name}</p>
              <p className="shrink-0 text-sm text-gray-600">{formatUsd(item.amount)}</p>
            </div>
            {(item.resources ?? []).length > 0 && (
              <ul className="space-y-1">
                {(item.resources ?? []).map((resource) => {
                  const ebook = resource.product_type === 'ebook'
                  return (
                    <li key={resource.resource_uuid || resource.course_uuid} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                      {ebook ? (
                        <FileText size={14} className="shrink-0 text-[#AC4691]" aria-hidden />
                      ) : (
                        <BookOpen size={14} className="shrink-0 text-[#7D75E2]" aria-hidden />
                      )}
                      <span className="min-w-0 text-gray-700">{resource.name}</span>
                      <span className="text-xs text-gray-400">{ebook ? ot('detail.product_ebook') : ot('detail.product_course')}</span>
                      <a
                        href={resourceHref(resource)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-medium text-[#4F43A4] underline-offset-2 hover:underline"
                      >
                        {ebook ? ot('detail.open_ebook') : ot('detail.open_course')}
                        <ExternalLink size={11} aria-hidden />
                      </a>
                    </li>
                  )
                })}
              </ul>
            )}
            <DuplicateNotice item={item} purchase={purchase} ot={ot} />
          </li>
        ))}
      </ul>
    </Section>
  )
}

function paymentTitle(method: string, ot: OrdersTranslate): string {
  switch (method) {
    case 'transferencia':
      return ot('detail.section_payment_transferencia')
    case 'zelle':
      return ot('detail.section_payment_zelle')
    case 'binance':
      return ot('detail.section_payment_binance')
    default:
      return ot('detail.section_payment')
  }
}

type InfoRow = { label: string; value: React.ReactNode; mono?: boolean } | null

/** The details the buyer is shown to pay with the order's method (empty ones are left out). */
function paymentRows(method: string, payment: PurchasePayment, ot: OrdersTranslate): InfoRow[] {
  const row = (label: string, value: string | undefined, mono = false): InfoRow => (value ? { label, value, mono } : null)
  const bank = bankText(payment.bank_name, payment.bank_code)
  const instructions = row(ot('detail.instructions'), payment.instructions)
  switch (method) {
    case 'transferencia':
      return [
        row(ot('detail.bank'), bank),
        row(ot('detail.account_number'), payment.account_number ? formatAccountNumber(payment.account_number) : '', true),
        row(ot('detail.account_type'), payment.account_type ? accountTypeLabel(ot, payment.account_type) : ''),
        row(ot('detail.holder'), payment.holder_name),
        row(ot('detail.id_document'), payment.id_document, true),
        instructions,
      ]
    case 'zelle':
      return [
        row(ot('detail.zelle_email'), payment.email),
        row(ot('detail.zelle_phone'), payment.phone, true),
        row(ot('detail.holder'), payment.holder_name),
        instructions,
      ]
    case 'binance':
      return [
        row(ot('detail.pay_id'), payment.pay_id, true),
        row(ot('detail.usdt_address'), payment.usdt_address, true),
        row(ot('detail.usdt_network'), payment.usdt_network ? networkLabel(payment.usdt_network) : ''),
        instructions,
      ]
    default:
      return [
        row(ot('detail.bank'), bank),
        row(ot('detail.phone'), payment.phone, true),
        row(ot('detail.id_document'), payment.id_document, true),
        row(ot('detail.holder'), payment.holder_name),
        instructions,
      ]
  }
}

function PaymentSection({ purchase, ot }: { purchase: PurchaseAdmin; ot: OrdersTranslate }) {
  const payment = purchase.payment
  if (!payment) return null
  return (
    <Section title={paymentTitle(purchase.method, ot)} icon={<MethodIcon method={purchase.method} size={13} />}>
      <InfoList rows={paymentRows(purchase.method, payment, ot)} />
    </Section>
  )
}

function ConfirmationSection({ purchase, ot }: { purchase: PurchaseAdmin; ot: OrdersTranslate }) {
  const reused = Array.isArray(purchase.reference_reused_in) ? purchase.reference_reused_in.filter(Boolean) : []
  const confirmedBy = purchase.confirmed_by ? purchase.confirmed_by.name || purchase.confirmed_by.username : ''
  const reason =
    purchase.reject_reason && (purchase.status === 'rejected' || purchase.status === 'voided')
      ? {
          label: purchase.status === 'voided' ? ot('detail.void_reason') : ot('detail.reject_reason'),
          value: purchase.reject_reason,
        }
      : null
  const rows = [
    purchase.bank_reference ? { label: ot('detail.reference'), value: purchase.bank_reference, mono: true } : null,
    purchase.confirmed_at ? { label: ot('detail.confirmed_on'), value: formatDateTime(purchase.confirmed_at) } : null,
    confirmedBy ? { label: ot('detail.confirmed_by'), value: confirmedBy } : null,
    purchase.note ? { label: ot('detail.note'), value: purchase.note } : null,
    reason,
  ]
  if (!rows.some(Boolean) && !reused.length) return null
  return (
    <Section title={ot('detail.section_confirmation')}>
      {reused.length > 0 && (
        <p role="note" className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span>{ot('detail.reused_warning', { codes: reused.join(', ') })}</span>
        </p>
      )}
      <InfoList rows={rows} />
    </Section>
  )
}

'use client'
// Sanar y Criar: provider-agnostic sales dashboard (overview, customers,
// transactions). Uses /overview and /transactions instead of the Stripe
// endpoints; subscriptions, MRR/ARR and churn are hidden because only
// one-time purchases exist; a provider chip replaces the card brand. A charge
// of a Pago Móvil order also shows the order code, linked to Pedidos.
import React, { useState } from 'react'
import Link from 'next/link'
import { useOrg } from '@components/Contexts/OrgContext'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query/keys'
import {
  getOrgCustomers,
  getPaymentsOverview,
  getPaymentsTransactions,
} from '@services/payments/payments'
import PageLoading from '@components/Objects/Loaders/PageLoading'
import {
  CreditCard,
  ExternalLink,
  DollarSign,
  Users,
  Activity,
  ChevronRight,
  ChevronLeft,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react'
import { getUserAvatarMediaDirectory } from '@services/media/media'
import UserAvatar from '@components/Objects/UserAvatar'
import { usePaymentsEnabled } from '@hooks/usePaymentsEnabled'
import UnconfiguredPaymentsDisclaimer from '@components/Pages/Payments/UnconfiguredPaymentsDisclaimer'
import { Button } from '@components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@components/ui/table'
import { formatCurrency, formatDate } from '@/lib/format'
import { useScT, ScTranslate } from '@components/Payments/useScT'
import { providerLabel } from '@components/Payments/commerce'
import { safeExternalUrl } from '@services/security/url'
import { parsePurchaseCode } from '@components/Dashboard/Pages/Orders/ordersForm'
import { useOrdersT } from '@components/Dashboard/Pages/Orders/useOrdersT'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function useFormatters() {
  const { sc, lng } = useScT()
  const fmt = (amount: number | null | undefined, currency?: string | null) =>
    amount == null ? '—' : formatCurrency(Number(amount), currency || 'USD', lng)
  const fmtDate = (iso: string | null | undefined) =>
    iso ? formatDate(iso, lng, { dateStyle: undefined, month: 'short', day: 'numeric', year: 'numeric' }) : '—'
  return { sc, fmt, fmtDate }
}

function ProviderChip({ provider, sc }: { provider?: string | null; sc: ScTranslate }) {
  const label = providerLabel(provider, sc)
  if (!label) return <span className="text-gray-400">—</span>
  const isPaypal = (provider ?? '').toLowerCase() === 'paypal'
  return (
    <span
      className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${
        isPaypal ? 'text-[#003087] bg-[#E6EEF8]' : 'text-[#6559CA] bg-[#EEEDFF]'
      }`}
    >
      {label}
    </span>
  )
}

/** Sanar y Criar: the Pago Móvil order a charge belongs to, linked to Pedidos. */
function PurchaseCodeLink({ code }: { code?: string | null }) {
  const { ot } = useOrdersT()
  const clean = parsePurchaseCode(code)
  if (!clean) return null
  return (
    <Link
      href={`/dash/orders?code=${encodeURIComponent(clean)}`}
      title={ot('charges.order_link_title', { code: clean })}
      className="whitespace-nowrap font-mono text-[11px] font-semibold text-[#4F43A4] underline-offset-2 hover:underline"
    >
      {clean}
    </Link>
  )
}

/** Provider chip plus, for a Pago Móvil order, its code. */
function ProviderWithOrder({ provider, purchaseCode, sc }: { provider?: string | null; purchaseCode?: string | null; sc: ScTranslate }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <ProviderChip provider={provider} sc={sc} />
      <PurchaseCodeLink code={purchaseCode} />
    </span>
  )
}

const STATUS_CLS: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  completed: 'bg-blue-100 text-blue-700',
  paid: 'bg-green-100 text-green-700',
  accredited: 'bg-green-100 text-green-700',
  succeeded: 'bg-green-100 text-green-700',
  pending: 'bg-amber-100 text-amber-700',
  created: 'bg-gray-100 text-gray-500',
  approved: 'bg-sky-100 text-sky-700',
  failed: 'bg-red-100 text-red-600',
  expired: 'bg-gray-100 text-gray-500',
  cancelled: 'bg-gray-100 text-gray-500',
  canceled: 'bg-gray-100 text-gray-500',
  refunded: 'bg-purple-100 text-purple-700',
}

function StatusPill({ status, sc }: { status: string; sc: ScTranslate }) {
  const key = (status ?? '').toLowerCase()
  const cls = STATUS_CLS[key] ?? 'bg-gray-100 text-gray-500'
  const label = STATUS_CLS[key] ? sc(`status.${key === 'canceled' ? 'cancelled' : key}`) : status
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {label}
    </span>
  )
}

/** Sanar y Criar: a second charge for something already bought, or a sandbox sale. */
function ChargeFlags({ charge, sc }: { charge: any; sc: ScTranslate }) {
  if (!charge?.needs_refund && !charge?.test_mode) return null
  return (
    <>
      {charge.needs_refund && (
        <span
          title={sc('customers.duplicate_charge_hint')}
          className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700"
        >
          {sc('customers.duplicate_charge')}
        </span>
      )}
      {charge.test_mode && (
        <span
          title={sc('customers.test_sale_hint')}
          className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600"
        >
          {sc('customers.test_sale')}
        </span>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Metric card
// ---------------------------------------------------------------------------
function MetricCard({
  label, value, icon: Icon, color,
}: { label: string; value: string; icon: any; color: string }) {
  return (
    <div className="bg-white border border-[#EAE8F2] rounded-xl px-5 py-4 flex items-center space-x-4">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${color}`}>
        <Icon size={18} />
      </div>
      <div>
        <div className="text-2xl font-bold text-[#190933] tracking-tight">{value}</div>
        <div className="text-xs text-gray-500">{label}</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab bar (internal)
// ---------------------------------------------------------------------------
type Tab = 'overview' | 'customers' | 'transactions'

const TABS: { id: Tab; labelKey: string; icon: any }[] = [
  { id: 'overview', labelKey: 'customers.tab_overview', icon: Activity },
  { id: 'customers', labelKey: 'customers.tab_customers', icon: Users },
  { id: 'transactions', labelKey: 'customers.tab_transactions', icon: CreditCard },
]

function customerName(c: any): string | null {
  return c?.name || c?.email || null
}

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------
function OverviewTab({ orgId, accessToken }: { orgId: number; accessToken: string }) {
  const { sc, fmt, fmtDate } = useFormatters()
  const { data, error, isLoading } = useQuery({
    queryKey: ['payments', orgId, 'overview'],
    queryFn: () => getPaymentsOverview(orgId, accessToken),
    enabled: !!(orgId && accessToken),
    staleTime: 60_000,
  })

  if (isLoading) return <PageLoading />
  if (error) return <ProviderUnavailable sc={sc} />

  const d = (data ?? {}) as any
  const recent: any[] = Array.isArray(d.recent_charges) ? d.recent_charges : []

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-2xl">
        <MetricCard label={sc('customers.metric_revenue')} value={fmt(d.total_revenue ?? 0, d.currency)} icon={DollarSign} color="bg-green-100 text-green-600" />
        <MetricCard label={sc('customers.metric_customers')} value={String(d.total_customers ?? 0)} icon={Users} color="bg-[#EEEDFF] text-[#6559CA]" />
      </div>
      {Number(d.duplicate_charges) > 0 && (
        <p role="alert" className="max-w-2xl text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          {sc('customers.duplicate_alert', { count: Number(d.duplicate_charges) })}
        </p>
      )}

      <div className="bg-white border border-[#EAE8F2] rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <span className="font-semibold text-[#190933] text-sm">{sc('customers.recent_transactions')}</span>
        </div>
        {recent.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-gray-400">{sc('customers.no_transactions')}</div>
        ) : (
          <div className="divide-y divide-gray-50">
            {recent.map((ch: any) => (
              <div key={ch.id} className="px-5 py-3 flex flex-wrap gap-2 items-center justify-between hover:bg-gray-50 transition-colors">
                <div className="flex items-center space-x-3 min-w-0">
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${ch.paid ? 'bg-green-100' : 'bg-red-100'}`}>
                    {ch.paid ? <CheckCircle2 size={13} className="text-green-600" /> : <AlertCircle size={13} className="text-red-500" />}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-800 truncate">
                      {customerName(ch.customer) ?? sc('customers.unknown_customer')}
                    </div>
                    <div className="text-xs text-gray-400">{fmtDate(ch.created)}{ch.description ? ` · ${ch.description}` : ''}</div>
                  </div>
                </div>
                <div className="flex items-center space-x-3">
                  <ChargeFlags charge={ch} sc={sc} />
                  <ProviderWithOrder provider={ch.provider ?? ch.payment?.provider} purchaseCode={ch.purchase_code} sc={sc} />
                  <span className="font-semibold text-gray-900">{fmt(ch.amount, ch.currency)}</span>
                  <StatusPill status={ch.paid ? 'paid' : ch.status} sc={sc} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Customers tab
// ---------------------------------------------------------------------------
function CustomersTab({ orgId, accessToken }: { orgId: number; accessToken: string }) {
  const { sc, fmt, fmtDate } = useFormatters()
  const { data: customers, error, isLoading } = useQuery({
    queryKey: queryKeys.payments.customers(orgId),
    queryFn: () => getOrgCustomers(orgId, accessToken),
    enabled: !!(orgId && accessToken),
    staleTime: 60_000,
  })

  if (isLoading) return <PageLoading />
  if (error) return <div className="p-6 text-sm text-red-500">{sc('customers.load_error')}</div>
  const list: any[] = Array.isArray(customers) ? customers : []
  if (list.length === 0) {
    return <Empty message={sc('customers.no_customers')} />
  }

  return (
    <div className="bg-white border border-[#EAE8F2] rounded-xl overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{sc('customers.col_customer')}</TableHead>
            <TableHead>{sc('customers.col_offer')}</TableHead>
            <TableHead>{sc('customers.col_amount')}</TableHead>
            <TableHead>{sc('customers.col_method')}</TableHead>
            <TableHead>{sc('customers.col_last_payment')}</TableHead>
            <TableHead>{sc('customers.col_status')}</TableHead>
            <TableHead>{sc('customers.col_since')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.map((item: any) => {
            const offer = item.offer
            const payment = item.payment ?? null
            return (
              <TableRow key={item.enrollment_id}>
                <TableCell>
                  <div className="flex items-center space-x-3">
                    <UserAvatar
                      border="border-2"
                      rounded="rounded-md"
                      avatar_url={getUserAvatarMediaDirectory(item.user?.user_uuid, item.user?.avatar_image)}
                    />
                    <div className="flex flex-col min-w-0">
                      <span className="font-medium truncate">
                        {item.user?.first_name ? `${item.user.first_name} ${item.user.last_name ?? ''}`.trim() : item.user?.username}
                      </span>
                      <span className="text-xs text-gray-400 truncate">{item.user?.email}</span>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="font-medium">{offer?.name ?? '—'}</TableCell>
                <TableCell>{offer ? fmt(offer.amount, offer.currency) : '—'}</TableCell>
                <TableCell><ProviderWithOrder provider={payment?.provider} purchaseCode={payment?.purchase_code} sc={sc} /></TableCell>
                <TableCell>
                  {payment?.last_charge_date ? (
                    <div className="flex flex-col">
                      <span className="text-sm">{fmtDate(payment.last_charge_date)}</span>
                      {payment.last_charge_amount != null && (
                        <span className="text-xs text-gray-400">{fmt(payment.last_charge_amount, payment.currency ?? offer?.currency)}</span>
                      )}
                    </div>
                  ) : <span className="text-gray-400">—</span>}
                </TableCell>
                <TableCell><StatusPill status={item.status} sc={sc} /></TableCell>
                <TableCell className="text-sm text-gray-500">{fmtDate(item.creation_date)}</TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Transactions tab (cursor-paginated)
// ---------------------------------------------------------------------------
function TransactionsTab({ orgId, accessToken }: { orgId: number; accessToken: string }) {
  const { sc, fmt, fmtDate } = useFormatters()
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [cursorStack, setCursorStack] = useState<string[]>([])

  const { data, error, isLoading } = useQuery({
    queryKey: ['payments', orgId, 'transactions', cursor],
    queryFn: () => getPaymentsTransactions(orgId, accessToken, 25, cursor),
    enabled: !!(orgId && accessToken),
    staleTime: 60_000,
  })

  const goNext = () => {
    if (data?.next_cursor) {
      setCursorStack(s => [...s, cursor ?? ''])
      setCursor(String(data.next_cursor))
    }
  }
  const goPrev = () => {
    const stack = [...cursorStack]
    const prev = stack.pop()
    setCursorStack(stack)
    setCursor(prev || undefined)
  }

  if (isLoading) return <PageLoading />
  if (error) return <ProviderUnavailable sc={sc} />
  const rows: any[] = Array.isArray(data?.data) ? data.data : []
  if (!rows.length) return <Empty message={sc('customers.no_transactions')} />

  return (
    <div className="space-y-3">
      <div className="bg-white border border-[#EAE8F2] rounded-xl overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{sc('customers.col_date')}</TableHead>
              <TableHead>{sc('customers.col_customer')}</TableHead>
              <TableHead>{sc('customers.col_method')}</TableHead>
              <TableHead>{sc('customers.col_amount')}</TableHead>
              <TableHead>{sc('customers.col_refunded')}</TableHead>
              <TableHead>{sc('customers.col_status')}</TableHead>
              <TableHead>{sc('customers.col_description')}</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((ch: any) => (
              <TableRow key={ch.id}>
                <TableCell className="text-sm text-gray-500 whitespace-nowrap">{fmtDate(ch.created)}</TableCell>
                <TableCell>
                  <div className="flex flex-col min-w-0">
                    <span className="font-medium truncate">{customerName(ch.customer) ?? '—'}</span>
                    {ch.customer?.name && ch.customer?.email && (
                      <span className="text-xs text-gray-400 truncate">{ch.customer.email}</span>
                    )}
                  </div>
                </TableCell>
                <TableCell><ProviderWithOrder provider={ch.provider ?? ch.payment?.provider} purchaseCode={ch.purchase_code} sc={sc} /></TableCell>
                <TableCell className="font-semibold">{fmt(ch.amount, ch.currency)}</TableCell>
                <TableCell className="text-sm">
                  {Number(ch.amount_refunded) > 0 ? (
                    <span className="text-purple-600">{fmt(ch.amount_refunded, ch.currency)}</span>
                  ) : '—'}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1">
                    <StatusPill status={ch.paid ? 'paid' : ch.status} sc={sc} />
                    <ChargeFlags charge={ch} sc={sc} />
                  </div>
                </TableCell>
                <TableCell className="text-sm text-gray-500 max-w-[200px] truncate">{ch.description || '—'}</TableCell>
                <TableCell>
                  {safeExternalUrl(ch.receipt_url) && (
                    <a href={safeExternalUrl(ch.receipt_url) as string} target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-gray-600 transition" title={sc('customers.view_receipt')} aria-label={sc('customers.view_receipt')}>
                      <ExternalLink size={13} />
                    </a>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-end space-x-2">
        <Button variant="outline" size="sm" className="rounded-full" onClick={goPrev} disabled={cursorStack.length === 0}>
          <ChevronLeft size={14} className="me-1" /> {sc('common.previous')}
        </Button>
        <Button variant="outline" size="sm" className="rounded-full" onClick={goNext} disabled={!data?.has_more}>
          {sc('common.next')} <ChevronRight size={14} className="ms-1" />
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared utility components
// ---------------------------------------------------------------------------
function Empty({ message }: { message: string }) {
  return <div className="bg-white border border-[#EAE8F2] rounded-xl py-12 text-center text-sm text-gray-400">{message}</div>
}

function ProviderUnavailable({ sc }: { sc: ScTranslate }) {
  return (
    <div className="bg-white border border-[#EAE8F2] rounded-xl py-10 text-center space-y-1">
      <AlertCircle size={20} className="mx-auto text-gray-400" />
      <p className="text-sm text-gray-500">{sc('customers.unavailable')}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
function PaymentsCustomersPage() {
  const org = useOrg() as any
  const session = useLHSession() as any
  const access_token = session?.data?.tokens?.access_token
  const { isEnabled, isLoading } = usePaymentsEnabled()
  const [activeTab, setActiveTab] = useState<Tab>('overview')
  const { sc } = useScT()

  if (!isEnabled && !isLoading) return <UnconfiguredPaymentsDisclaimer />
  if (isLoading) return <PageLoading />

  return (
    <div className="ms-4 me-4 sm:ms-10 sm:me-10 mx-auto space-y-4">
      <div className="flex flex-wrap items-center gap-1 bg-[#EEEDFF] p-1 rounded-full w-fit">
        {TABS.map(({ id, labelKey, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center space-x-2 px-4 py-2 rounded-full text-sm font-medium transition-colors ${
              activeTab === id
                ? 'bg-white text-[#190933] shadow-sm'
                : 'text-[#584F72] hover:text-[#190933]'
            }`}
          >
            <Icon size={15} />
            <span>{sc(labelKey)}</span>
          </button>
        ))}
      </div>

      <div>
        {activeTab === 'overview' && <OverviewTab orgId={org.id} accessToken={access_token} />}
        {activeTab === 'customers' && <CustomersTab orgId={org.id} accessToken={access_token} />}
        {activeTab === 'transactions' && <TransactionsTab orgId={org.id} accessToken={access_token} />}
      </div>
    </div>
  )
}

export default PaymentsCustomersPage

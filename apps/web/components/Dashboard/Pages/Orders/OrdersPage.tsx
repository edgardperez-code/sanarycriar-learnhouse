'use client'
// Sanar y Criar: /dash/orders ("Pedidos"). Lists the Pago Móvil orders by
// status ("Por confirmar" first), with a search by code, e-mail, name or bank
// reference, 25 per page, refreshed every 30 s while the tab is visible. A row
// opens the order's detail, where she marks it as paid, rejects or voids it.
// ?code=SYC-XXXXXX (the link of the new-order e-mail and of the charges) looks
// for that code among all orders and opens it.
import React, { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { motion } from 'motion/react'
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2, Receipt, Search, Settings, X } from 'lucide-react'
import { Breadcrumbs } from '@components/Objects/Breadcrumbs/Breadcrumbs'
import { Button } from '@components/ui/button'
import { Input } from '@components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@components/ui/table'
import { getUriWithOrg } from '@services/config/config'
import { formatRelative } from '@/lib/format'
import {
  DEFAULT_TAB,
  EMPTY_COUNTS,
  ORDER_LIMITS,
  ORDER_TABS,
  ORDERS_PAGE_SIZE,
  OrderTab,
  PurchaseAdmin,
  cleanSearch,
  customerName,
  formatBs,
  formatDateTime,
  formatUsd,
  pageRange,
  parsePurchaseCode,
  productSummary,
} from './ordersForm'
import { ExpiresBadge, StatusChip, useNow } from './OrderBits'
import OrderDetailDialog from './OrderDetailDialog'
import { isForbidden, useManualSettings, usePurchasesList } from './useOrdersApi'
import { OrdersTranslate, ordersLabel, useOrdersT } from './useOrdersT'

const SEARCH_DEBOUNCE_MS = 300

type Filters = {
  status: OrderTab
  offset: number
  /** What the search box shows. */
  search: string
  /** What the list asks for (the box, 300 ms later). */
  q: string
  /** ?code= waiting for its row to open the detail. */
  openCode: string | null
}

function filtersFor(code: string | null): Filters {
  return code
    ? { status: 'all', offset: 0, search: code, q: code, openCode: code }
    : { status: DEFAULT_TAB, offset: 0, search: '', q: '', openCode: null }
}

export default function OrdersPage({ orgslug }: { orgslug: string }) {
  const { ot, lng } = useOrdersT()
  const searchParams = useSearchParams()
  const now = useNow()
  const codeParam = parsePurchaseCode(searchParams?.get('code'))

  const [filters, setFilters] = useState<Filters>(() => filtersFor(codeParam))
  const [lastCode, setLastCode] = useState<string | null>(codeParam)
  const [selected, setSelected] = useState<string | null>(null)

  // ?code= changed while the page is open (back/forward, or "Pedidos" in the
  // menu, which drops it): look for the new code, or go back to the default
  // list. Adjusted while rendering, as React recommends for state that
  // follows a prop.
  if (codeParam !== lastCode) {
    setLastCode(codeParam)
    setSelected(null)
    setFilters(filtersFor(codeParam))
  }

  // Debounced search; a new query starts again at the first page.
  useEffect(() => {
    const next = cleanSearch(filters.search)
    if (next === filters.q) return
    const timer = window.setTimeout(() => {
      setFilters((f) => ({ ...f, q: next, offset: 0, openCode: null }))
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [filters.search, filters.q])

  const { data, isLoading, isFetching, error } = usePurchasesList({
    status: filters.status,
    q: filters.q,
    offset: filters.offset,
  })
  const { data: manual } = useManualSettings()

  const items = data?.items ?? []
  const counts = data?.counts ?? EMPTY_COUNTS
  const total = data?.total ?? 0

  // A page emptied by an action (the last order of page 2 confirmed): step back.
  useEffect(() => {
    if (!data || isFetching || items.length > 0 || filters.offset === 0) return
    const lastPage = Math.max(0, Math.floor(Math.max(0, total - 1) / ORDERS_PAGE_SIZE) * ORDERS_PAGE_SIZE)
    const timer = window.setTimeout(() => setFilters((f) => ({ ...f, offset: Math.min(f.offset, lastPage) })), 0)
    return () => window.clearTimeout(timer)
  }, [data, isFetching, items.length, filters.offset, total])

  // The ?code= order opens as soon as its row is in the list.
  const autoOpen = filters.openCode ? items.find((item) => item.code === filters.openCode) ?? null : null
  const selectedUuid = selected ?? autoOpen?.purchase_uuid ?? null
  const selectedRow = items.find((item) => item.purchase_uuid === selectedUuid) ?? null

  // The order whose row gets the focus back when its dialog closes.
  const lastOpened = useRef<string | null>(null)
  const openOrder = (item: PurchaseAdmin) => setSelected(item.purchase_uuid)
  const closeOrder = () => {
    lastOpened.current = selectedUuid
    setSelected(null)
    setFilters((f) => ({ ...f, openCode: null }))
  }
  const restoreFocus = () => {
    const uuid = lastOpened.current
    const selector = uuid ? `[data-order-open="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(uuid) : uuid}"]` : null
    // The table button on a computer, the card on a phone: the one on screen.
    const opener = selector
      ? Array.from(document.querySelectorAll<HTMLElement>(selector)).find((el) => el.offsetParent !== null)
      : undefined
    // The row may have left the list (confirmed from "Por confirmar"): the active tab instead.
    const target = opener ?? document.querySelector<HTMLElement>('[data-orders-tabs] button[aria-pressed="true"]')
    target?.focus()
  }

  const setTab = (status: OrderTab) => setFilters((f) => ({ ...f, status, offset: 0, openCode: null }))
  const setSearch = (search: string) => setFilters((f) => ({ ...f, search }))
  const clearSearch = () => setFilters((f) => ({ ...f, search: '', q: '', offset: 0, openCode: null }))
  const goTo = (offset: number) => setFilters((f) => ({ ...f, offset: Math.max(0, offset), openCode: null }))

  const range = pageRange(filters.offset, items.length, total)
  const configHref = getUriWithOrg(orgslug, '/dash/payments/configuration')

  let body: React.ReactNode
  if (error && !data) {
    body = (
      <div className="rounded-xl bg-white nice-shadow px-5 py-6 text-sm text-red-600">
        {isForbidden(error) ? ot('forbidden') : ot('load_error')}
      </div>
    )
  } else {
    body = (
      <div className="rounded-xl bg-white nice-shadow px-4 py-4 sm:px-5 space-y-4">
        {/* Status tabs + search */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <StatusTabs value={filters.status} counts={counts} loading={isLoading} onChange={setTab} ot={ot} />
          <div className="flex w-full items-center gap-2 lg:max-w-sm">
            <div className="relative w-full">
              <Search size={15} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-gray-400" aria-hidden />
              <Input
                type="search"
                value={filters.search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label={ot('list.search_label')}
                placeholder={ot('list.search_placeholder')}
                maxLength={ORDER_LIMITS.search}
                className="ps-9 pe-9"
              />
              {filters.search && (
                <button
                  type="button"
                  onClick={clearSearch}
                  className="absolute end-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                  aria-label={ot('list.clear_search')}
                  title={ot('list.clear_search')}
                >
                  <X size={14} aria-hidden />
                </button>
              )}
            </div>
            <span className="w-4 shrink-0" aria-live="polite">
              {isFetching && !isLoading && (
                <Loader2 size={15} className="animate-spin text-gray-400" aria-label={ot('list.refreshing')} />
              )}
            </span>
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-2 animate-pulse">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-14 rounded-lg bg-gray-100" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#EEEDFF] text-[#6559CA]">
              <Receipt size={22} aria-hidden />
            </div>
            <p className="max-w-sm text-sm text-gray-500">
              {filters.q ? ot('list.empty_search') : ordersLabel(ot, 'empty', filters.status)}
            </p>
          </div>
        ) : (
          <>
            {/* Table from md up */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{ot('list.col_code')}</TableHead>
                    <TableHead>{ot('list.col_customer')}</TableHead>
                    <TableHead>{ot('list.col_products')}</TableHead>
                    <TableHead className="text-end">{ot('list.col_amount')}</TableHead>
                    <TableHead>{ot('list.col_status')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <OrderRow key={item.purchase_uuid} item={item} now={now} lng={lng} ot={ot} onOpen={openOrder} />
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Stacked cards on phones */}
            <ul className="space-y-2 md:hidden">
              {items.map((item) => (
                <li key={item.purchase_uuid}>
                  <OrderCard item={item} now={now} lng={lng} ot={ot} onOpen={openOrder} />
                </li>
              ))}
            </ul>

            {total <= ORDERS_PAGE_SIZE && filters.offset === 0 ? (
              <p className="pt-1 text-end text-xs text-gray-400 tabular-nums">{ot('list.range', range)}</p>
            ) : (
              <nav className="flex items-center justify-between gap-3 pt-1" aria-label={ot('list.pager_label')}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => goTo(filters.offset - ORDERS_PAGE_SIZE)}
                  disabled={filters.offset <= 0 || isFetching}
                >
                  <ChevronLeft aria-hidden className="rtl:rotate-180" />
                  {ot('list.prev')}
                </Button>
                <span className="text-sm text-gray-500 tabular-nums">{ot('list.range', range)}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => goTo(filters.offset + ORDERS_PAGE_SIZE)}
                  disabled={filters.offset + items.length >= total || isFetching}
                >
                  {ot('list.next')}
                  <ChevronRight aria-hidden className="rtl:rotate-180" />
                </Button>
              </nav>
            )}
          </>
        )}
      </div>
    )
  }

  return (
    <div className="h-screen w-full bg-[#f8f8f8] flex flex-col">
      <PageHeader ot={ot} configHref={configHref} />
      <div className="h-6 flex-shrink-0"></div>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.1, type: 'spring', stiffness: 80 }}
        className="flex-1 overflow-y-auto"
      >
        <div className="ms-4 me-4 sm:ms-10 sm:me-10 pb-10 space-y-4">
          {manual && manual.enabled === false && (
            <div className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between">
              <p className="flex items-start gap-2">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
                <span>{ot('disabled_notice')}</span>
              </p>
              <Button asChild size="sm" variant="outline" className="shrink-0 self-start border-amber-300 bg-white text-amber-900 hover:bg-amber-100 sm:self-auto">
                <Link href={configHref}>
                  <Settings aria-hidden />
                  {ot('configure_link')}
                </Link>
              </Button>
            </div>
          )}
          {body}
        </div>
        {/* Room after the content for the floating mobile dock. */}
        <div aria-hidden className="h-24 lg:hidden" />
      </motion.div>

      <OrderDetailDialog purchaseUuid={selectedUuid} placeholder={selectedRow} onClose={closeOrder} onCloseFocus={restoreFocus} />
    </div>
  )
}

function PageHeader({ ot, configHref }: { ot: OrdersTranslate; configHref: string }) {
  return (
    <div className="ps-4 pe-4 sm:ps-10 sm:pe-10 tracking-tight bg-[#fcfbfc] z-10 nice-shadow flex-shrink-0 relative">
      <div className="pt-6 pb-4">
        <Breadcrumbs items={[{ label: ot('breadcrumb'), href: '/dash/orders', icon: <Receipt size={14} /> }]} />
      </div>
      <div className="my-2 pt-2 pb-5 flex flex-wrap gap-3 items-end justify-between">
        <div className="flex flex-col space-y-1 min-w-0">
          <h1 className="pt-3 font-bold text-3xl sm:text-4xl tracking-tighter truncate">{ot('title')}</h1>
          <p className="font-medium text-gray-400 text-md">{ot('subtitle')}</p>
        </div>
        <Link
          href={configHref}
          className="flex shrink-0 items-center gap-2 rounded-full border border-[#EAE8F2] bg-white px-3 py-1.5 text-sm font-medium text-[#190933] transition-colors hover:bg-[#EEEDFF]"
        >
          <Settings size={14} aria-hidden />
          <span>{ot('configure_link')}</span>
        </Link>
      </div>
    </div>
  )
}

function StatusTabs({
  value,
  counts,
  loading,
  onChange,
  ot,
}: {
  value: OrderTab
  counts: Record<OrderTab, number>
  loading: boolean
  onChange: (_tab: OrderTab) => void
  ot: OrdersTranslate
}) {
  return (
    <div
      role="group"
      aria-label={ot('tabs.label')}
      data-orders-tabs=""
      className="inline-flex max-w-full flex-wrap gap-0.5 self-start rounded-2xl border border-[#EAE8F2] bg-[#FFFCF9] p-0.5"
    >
      {ORDER_TABS.map((tab) => {
        const active = tab === value
        const count = Number(counts[tab]) || 0
        const attention = tab === 'pending' && count > 0 && !active
        return (
          <button
            key={tab}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(tab)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              active ? 'bg-[#190933] text-white' : 'text-[#584F72] hover:bg-[#EEEDFF]'
            }`}
          >
            {ordersLabel(ot, 'tabs', tab)}
            <span
              className={`min-w-[1.25rem] rounded-full px-1.5 py-px text-center text-[11px] tabular-nums ${
                active ? 'bg-white/20 text-white' : attention ? 'bg-amber-100 text-amber-800' : 'bg-[#EEEDFF] text-[#6559CA]'
              }`}
            >
              {loading ? '…' : count}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function Products({ item, ot }: { item: PurchaseAdmin; ot: OrdersTranslate }) {
  const { names, more } = productSummary(item.items)
  return (
    <span className="text-sm text-gray-700">
      {names.join(', ') || '—'}
      {more > 0 && <span className="ms-1 whitespace-nowrap text-xs text-gray-500">{ot('list.more_products', { count: more })}</span>}
    </span>
  )
}

type RowProps = {
  item: PurchaseAdmin
  now: number
  lng: string
  ot: OrdersTranslate
  onOpen: (_item: PurchaseAdmin) => void
}

function OrderRow({ item, now, lng, ot, onOpen }: RowProps) {
  const name = customerName(item.customer)
  return (
    <TableRow className="cursor-pointer hover:bg-[#FFFCF9]" onClick={() => onOpen(item)}>
      <TableCell className="align-top">
        <button
          type="button"
          data-order-open={item.purchase_uuid}
          onClick={(e) => {
            e.stopPropagation()
            onOpen(item)
          }}
          aria-label={ot('list.open', { code: item.code })}
          className="font-mono text-sm font-semibold text-[#190933] underline-offset-2 hover:text-[#6559CA] hover:underline"
        >
          {item.code}
        </button>
        <p className="mt-0.5 whitespace-nowrap text-xs text-gray-500" title={formatDateTime(item.created_at)}>
          {formatRelative(item.created_at, lng)}
        </p>
        <p className="whitespace-nowrap text-[11px] text-gray-400">{formatDateTime(item.created_at)}</p>
      </TableCell>
      <TableCell className="max-w-[14rem] align-top">
        <p className="truncate font-medium text-[#190933]">{name || ot('list.no_customer')}</p>
        {item.customer?.email && <p className="truncate text-xs text-gray-500">{item.customer.email}</p>}
      </TableCell>
      <TableCell className="max-w-[18rem] align-top">
        <Products item={item} ot={ot} />
      </TableCell>
      <TableCell className="whitespace-nowrap text-end align-top">
        <p className="text-base font-semibold text-[#190933]">{formatBs(item.amount_ves)}</p>
        <p className="text-xs text-gray-500">{formatUsd(item.amount)}</p>
      </TableCell>
      <TableCell className="align-top">
        <div className="flex flex-col items-start gap-1">
          <StatusChip status={item.status} ot={ot} />
          {item.status === 'pending' && <ExpiresBadge expiresAt={item.expires_at} now={now} ot={ot} />}
        </div>
      </TableCell>
    </TableRow>
  )
}

// A button holds phrasing content only, so the card is built from spans.
function OrderCard({ item, now, lng, ot, onOpen }: RowProps) {
  const name = customerName(item.customer)
  return (
    <button
      type="button"
      data-order-open={item.purchase_uuid}
      onClick={() => onOpen(item)}
      aria-label={ot('list.open', { code: item.code })}
      className="block w-full rounded-xl border border-[#EAE8F2] px-4 py-3 text-start transition-colors hover:bg-[#FFFCF9]"
    >
      <span className="flex items-start justify-between gap-2">
        <span className="font-mono text-sm font-semibold text-[#190933]">{item.code}</span>
        <StatusChip status={item.status} ot={ot} />
      </span>
      <span className="mt-1.5 block truncate text-sm font-medium text-[#190933]">
        {name || ot('list.no_customer')}
        {item.customer?.email && <span className="font-normal text-gray-500"> · {item.customer.email}</span>}
      </span>
      <span className="mt-0.5 block line-clamp-2">
        <Products item={item} ot={ot} />
      </span>
      <span className="mt-2 flex items-end justify-between gap-3">
        <span className="block">
          <span className="block text-lg font-bold leading-tight tracking-tight text-[#190933]">{formatBs(item.amount_ves)}</span>
          <span className="block text-xs text-gray-500">{formatUsd(item.amount)}</span>
        </span>
        <span className="flex flex-col items-end gap-0.5 text-end">
          {item.status === 'pending' && <ExpiresBadge expiresAt={item.expires_at} now={now} ot={ot} />}
          <span className="text-xs text-gray-500">{formatRelative(item.created_at, lng)}</span>
          <span className="whitespace-nowrap text-[11px] text-gray-400">{formatDateTime(item.created_at)}</span>
        </span>
      </span>
    </button>
  )
}

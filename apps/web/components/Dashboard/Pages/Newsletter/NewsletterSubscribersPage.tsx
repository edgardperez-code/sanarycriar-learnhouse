'use client'
// Sanar y Criar: "Suscriptores" tab of the newsletter section. Lists the
// emails left on the marketing site, with search, CSV export, deletion and a
// manual retry of the Resend sync.
import React, { useEffect, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  Inbox,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import { useOrg } from '@components/Contexts/OrgContext'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import { Button } from '@components/ui/button'
import { Input } from '@components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@components/ui/table'
import ConfirmationModal from '@components/Objects/StyledElements/ConfirmationModal/ConfirmationModal'
import { queryKeys } from '@/lib/query/keys'
import {
  deleteNewsletterSubscriber,
  getNewsletterSubscribers,
  syncNewsletterSubscribers,
} from '@services/newsletter/newsletter'
import { downloadNewsletterCsv } from '@services/newsletter/export'
import {
  NewsletterSubscriber,
  NewsletterSubscriberPage,
  NewsletterSyncResult,
  totalPages,
} from './newsletterForm'
import { NewsletterTranslate, useNewsletterT } from './useNewsletterT'
import { NewsletterRequestError, apiDetail, isForbidden, useNewsletterSettings } from './useNewsletterSettings'

const PAGE_SIZE = 25
const SEARCH_DEBOUNCE_MS = 300

// Dates read in Venezuelan time, like the CSV export.
const DATE_FORMAT = new Intl.DateTimeFormat('es-VE', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'America/Caracas',
})

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : DATE_FORMAT.format(date)
}

function sourceLabel(source: string, nl: NewsletterTranslate): string {
  switch (source) {
    case 'popup':
      return nl('source.popup')
    case 'footer':
      return nl('source.footer')
    default:
      return nl('source.other')
  }
}

function SyncBadge({ item, nl }: { item: NewsletterSubscriber; nl: NewsletterTranslate }) {
  let label: string
  let tone: string
  switch (item.sync_status) {
    case 'synced':
      label = nl('sync_status.synced')
      tone = 'text-green-700 bg-green-100'
      break
    case 'pending':
      label = nl('sync_status.pending')
      tone = 'text-amber-700 bg-amber-100'
      break
    case 'error':
      label = nl('sync_status.error')
      tone = 'text-red-700 bg-red-100'
      break
    default:
      label = nl('sync_status.skipped')
      tone = 'text-gray-600 bg-gray-100'
  }
  const title =
    item.sync_status === 'error' ? nl('subscribers.sync_error_hint', { error: item.sync_error || '—' }) : undefined
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${tone}`}>
      {item.sync_status === 'error' && <AlertTriangle size={11} aria-hidden />}
      {label}
    </span>
  )
}

function DeleteButton({
  item,
  onDelete,
  nl,
}: {
  item: NewsletterSubscriber
  onDelete: (_item: NewsletterSubscriber) => Promise<void>
  nl: NewsletterTranslate
}) {
  return (
    <ConfirmationModal
      status="warning"
      dialogTitle={nl('subscribers.delete_title')}
      confirmationMessage={nl('subscribers.delete_body', { email: item.email })}
      confirmationButtonText={nl('subscribers.delete_confirm')}
      functionToExecute={() => onDelete(item)}
      dialogTrigger={
        <button
          type="button"
          aria-label={nl('subscribers.delete_aria', { email: item.email })}
          title={nl('subscribers.delete')}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600"
        >
          <Trash2 size={15} aria-hidden />
        </button>
      }
    />
  )
}

export default function NewsletterSubscribersPage() {
  const org = useOrg() as any
  const session = useLHSession() as any
  const accessToken: string | undefined = session?.data?.tokens?.access_token
  const orgId: number = org?.id
  const queryClient = useQueryClient()
  const { nl } = useNewsletterT()
  const { data: settings } = useNewsletterSettings()

  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [exporting, setExporting] = useState(false)
  const [syncing, setSyncing] = useState(false)

  // Debounced search; a new query starts again at page 1. Same normalisation
  // as the API (strip, lower, 100 characters).
  useEffect(() => {
    const next = search.trim().toLowerCase().slice(0, 100)
    if (next === q) return
    const timer = window.setTimeout(() => {
      setQ(next)
      setPage(1)
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [search, q])

  const { data, isLoading, isFetching, error } = useQuery<NewsletterSubscriberPage, NewsletterRequestError>({
    queryKey: queryKeys.newsletter.subscribers(orgId, page, q),
    queryFn: async () => {
      const res = await getNewsletterSubscribers(orgId, { page, limit: PAGE_SIZE, q }, accessToken as string)
      if (!res.success) throw new NewsletterRequestError(res.status, apiDetail(res.data))
      return res.data as NewsletterSubscriberPage
    },
    enabled: !!(orgId && accessToken),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    retry: (failureCount, err) => !isForbidden(err) && failureCount < 2,
  })

  const invalidateList = () => queryClient.invalidateQueries({ queryKey: ['newsletter', orgId, 'subscribers'] })

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const pages = totalPages(total, data?.limit ?? PAGE_SIZE)
  const summary = data?.summary ?? { all: 0, unsynced: 0 }

  const handleDelete = async (item: NewsletterSubscriber) => {
    if (!accessToken) return
    try {
      const res = await deleteNewsletterSubscriber(orgId, item.id, accessToken)
      if (!res.success) {
        toast.error(nl('subscribers.delete_error'))
        return
      }
      if (res.data?.resend_removed === false) {
        toast(nl('subscribers.deleted_local_only'), {
          icon: <AlertTriangle size={18} className="shrink-0 text-amber-600" aria-hidden />,
          duration: 8000,
        })
      } else {
        toast.success(nl('subscribers.deleted'))
      }
      // The last row of a later page: step back so the list is not empty.
      if (items.length === 1 && page > 1) setPage((p) => Math.max(1, p - 1))
      await invalidateList()
    } catch {
      toast.error(nl('subscribers.delete_error'))
    }
  }

  const handleExport = async () => {
    if (!accessToken || exporting) return
    setExporting(true)
    try {
      await downloadNewsletterCsv(orgId, accessToken)
    } catch {
      toast.error(nl('subscribers.export_error'))
    } finally {
      setExporting(false)
    }
  }

  const handleSync = async () => {
    if (!accessToken || syncing) return
    setSyncing(true)
    try {
      const res = await syncNewsletterSubscribers(orgId, accessToken)
      if (!res.success) {
        toast.error(nl('subscribers.sync_error'))
        return
      }
      const result = res.data as NewsletterSyncResult
      toast.success(
        nl('subscribers.sync_done', { synced: result.synced, failed: result.failed, remaining: result.remaining }),
        { duration: 6000 }
      )
      await invalidateList()
    } catch {
      toast.error(nl('subscribers.sync_error'))
    } finally {
      setSyncing(false)
    }
  }

  if (error && !data) {
    return (
      <div className="ms-4 me-4 sm:ms-10 sm:me-10 rounded-xl bg-white nice-shadow px-5 py-6 text-sm text-red-600">
        {isForbidden(error) ? nl('forbidden') : nl('load_error')}
      </div>
    )
  }

  const showUnsynced = !!settings?.resend_enabled && summary.unsynced > 0

  return (
    <div className="ms-4 me-4 sm:ms-10 sm:me-10 pb-10 space-y-4">
      {/* Summary + Resend sync */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white nice-shadow px-5 py-4">
        <div className="min-w-0">
          <p className="font-semibold text-[#190933]">
            {isLoading ? '…' : nl('subscribers.total', { count: summary.all })}
          </p>
          {showUnsynced && (
            <p className="text-sm text-amber-700">{nl('subscribers.unsynced', { count: summary.unsynced })}</p>
          )}
        </div>
        {showUnsynced && (
          <Button type="button" variant="outline" size="sm" onClick={handleSync} disabled={syncing} aria-busy={syncing || undefined}>
            {syncing ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
            {syncing ? nl('subscribers.syncing') : nl('subscribers.sync')}
          </Button>
        )}
      </div>

      <div className="rounded-xl bg-white nice-shadow px-4 py-4 sm:px-5 space-y-4">
        {/* Search + export */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:max-w-sm">
            <Search size={15} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-gray-400" aria-hidden />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label={nl('subscribers.search_label')}
              placeholder={nl('subscribers.search_placeholder')}
              maxLength={100}
              className="ps-9"
            />
          </div>
          <div className="flex items-center gap-2">
            {isFetching && !isLoading && <Loader2 size={15} className="animate-spin text-gray-400" aria-hidden />}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={exporting || summary.all === 0}
              aria-busy={exporting || undefined}
            >
              {exporting ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
              {exporting ? nl('subscribers.exporting') : nl('subscribers.export')}
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-2 animate-pulse">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-10 rounded-md bg-gray-100" />
            ))}
          </div>
        ) : summary.all === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#EEEDFF] text-[#6559CA]">
              <Inbox size={22} aria-hidden />
            </div>
            <p className="font-semibold text-[#190933]">{nl('subscribers.empty_title')}</p>
            <p className="max-w-sm text-sm text-gray-500">{nl('subscribers.empty_body')}</p>
          </div>
        ) : items.length === 0 ? (
          <p className="py-10 text-center text-sm text-gray-500">{nl('subscribers.no_results', { q })}</p>
        ) : (
          <>
            {/* Table from sm up */}
            <div className="hidden sm:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{nl('subscribers.col_email')}</TableHead>
                    <TableHead>{nl('subscribers.col_date')}</TableHead>
                    <TableHead>{nl('subscribers.col_source')}</TableHead>
                    <TableHead>{nl('subscribers.col_page')}</TableHead>
                    <TableHead>{nl('subscribers.col_resend')}</TableHead>
                    <TableHead className="text-end">{nl('subscribers.col_actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="max-w-[18rem] truncate font-medium text-[#190933]" title={item.email}>
                        {item.email}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-gray-500">{formatDate(item.created_at)}</TableCell>
                      <TableCell className="text-sm">{sourceLabel(item.source, nl)}</TableCell>
                      <TableCell className="max-w-[12rem] truncate text-xs text-gray-500" title={item.page_path ?? undefined}>
                        {item.page_path ? <code dir="ltr">{item.page_path}</code> : '—'}
                      </TableCell>
                      <TableCell>
                        <SyncBadge item={item} nl={nl} />
                      </TableCell>
                      <TableCell className="text-end">
                        <DeleteButton item={item} onDelete={handleDelete} nl={nl} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Stacked cards on phones */}
            <ul className="space-y-2 sm:hidden">
              {items.map((item) => (
                <li key={item.id} className="rounded-lg border border-[#EAE8F2] px-3 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 break-all font-medium text-[#190933]">{item.email}</p>
                    <DeleteButton item={item} onDelete={handleDelete} nl={nl} />
                  </div>
                  <p className="mt-1 text-xs text-gray-500">{formatDate(item.created_at)}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-600">
                    <span>{sourceLabel(item.source, nl)}</span>
                    {item.page_path && (
                      <code dir="ltr" className="max-w-[10rem] truncate text-gray-500">
                        {item.page_path}
                      </code>
                    )}
                    <SyncBadge item={item} nl={nl} />
                  </div>
                </li>
              ))}
            </ul>

            {pages > 1 && (
              <nav className="flex items-center justify-between gap-3 pt-1" aria-label={nl('subscribers.page_of', { page, pages })}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1 || isFetching}
                >
                  <ChevronLeft aria-hidden />
                  {nl('subscribers.prev')}
                </Button>
                <span className="text-sm text-gray-500">{nl('subscribers.page_of', { page, pages })}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(pages, p + 1))}
                  disabled={page >= pages || isFetching}
                >
                  {nl('subscribers.next')}
                  <ChevronRight aria-hidden />
                </Button>
              </nav>
            )}
          </>
        )}
      </div>
    </div>
  )
}

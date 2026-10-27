'use client'
// Sanar y Criar: /dash/blog. Lists the org's articles (drafts and published)
// with status filters and a title search, and starts new ones: by hand or
// with AI. An AI job that is still running (also after a reload) shows up as
// a banner over the list.
import React, { useEffect, useState } from 'react'
import Link from 'next/link'
import { motion } from 'motion/react'
import { useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { ChevronLeft, ChevronRight, FlaskConical, Info, Loader2, Newspaper, PenLine, Search, Sparkles } from 'lucide-react'
import { Breadcrumbs } from '@components/Objects/Breadcrumbs/Breadcrumbs'
import { Button } from '@components/ui/button'
import { Input } from '@components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@components/ui/table'
import { getUriWithOrg } from '@services/config/config'
import { queryKeys } from '@/lib/query/keys'
import { AdminPostSummary, BLOG_LIMITS, BlogJob, jobIsActive, totalPages } from './blogForm'
import BlogAiGenerateDialog from './BlogAiGenerateDialog'
import BlogJobProgress from './BlogJobProgress'
import { BLOG_PAGE_SIZE, isForbidden, useActiveBlogJob, useBlogAuth, useBlogConfig, useBlogPosts } from './useBlogApi'
import { BlogTranslate, blogLabel, useBlogT } from './useBlogT'

const SEARCH_DEBOUNCE_MS = 300

type StatusFilter = '' | 'draft' | 'published'

// Dates read in Venezuelan time.
const DATE_TIME = new Intl.DateTimeFormat('es-VE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Caracas' })
const DATE_ONLY = new Intl.DateTimeFormat('es-VE', { dateStyle: 'medium', timeZone: 'America/Caracas' })

export function formatBlogDate(iso: string | null | undefined, withTime = true): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return (withTime ? DATE_TIME : DATE_ONLY).format(date)
}

export function StatusBadge({ status, bt }: { status: string; bt: BlogTranslate }) {
  const published = status === 'published'
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${
        published ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-800'
      }`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${published ? 'bg-green-500' : 'bg-amber-500'}`} />
      {blogLabel(bt, 'status', published ? 'published' : 'draft')}
    </span>
  )
}

function AiBadge({ bt }: { bt: BlogTranslate }) {
  return (
    <span
      title={bt('list.ai_badge_title')}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-[#EEEDFF] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[#6559CA]"
    >
      <Sparkles size={10} aria-hidden />
      {bt('list.ai_badge')}
    </span>
  )
}

function PageHeader({
  bt,
  aiEnabled,
  aiMock,
  configLoaded,
  onCreateAi,
  orgslug,
}: {
  bt: BlogTranslate
  aiEnabled: boolean
  aiMock: boolean
  configLoaded: boolean
  onCreateAi: () => void
  orgslug: string
}) {
  return (
    <div className="ps-4 pe-4 sm:ps-10 sm:pe-10 tracking-tight bg-[#fcfbfc] z-10 nice-shadow flex-shrink-0 relative">
      <div className="pt-6 pb-4">
        <Breadcrumbs items={[{ label: bt('breadcrumb'), href: '/dash/blog', icon: <Newspaper size={14} /> }]} />
      </div>
      <div className="my-2 pt-2 pb-5 flex flex-wrap gap-3 items-end justify-between">
        <div className="flex flex-col space-y-1 min-w-0">
          <h1 className="pt-3 font-bold text-3xl sm:text-4xl tracking-tighter truncate">{bt('title')}</h1>
          <p className="font-medium text-gray-400 text-md">{bt('subtitle')}</p>
        </div>
        <div className="flex flex-col items-start gap-1.5 sm:items-end shrink-0 max-w-full">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onCreateAi}
              disabled={!configLoaded || !aiEnabled}
              className="border-[#BBBBFF] text-[#41375B] hover:bg-[#EEEDFF]"
            >
              <Sparkles aria-hidden className="text-[#6559CA]" />
              {bt('list.create_ai')}
            </Button>
            <Button asChild className="bg-[#190933] text-white hover:bg-[#41375B]">
              <Link href={getUriWithOrg(orgslug, '/dash/blog/new')}>
                <PenLine aria-hidden />
                {bt('list.write')}
              </Link>
            </Button>
          </div>
          {configLoaded && !aiEnabled && (
            <p className="flex items-center gap-1.5 text-xs text-gray-500">
              <Info size={12} className="shrink-0" aria-hidden />
              {bt('list.ai_disabled')}
            </p>
          )}
          {configLoaded && aiEnabled && aiMock && (
            <p className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
              <FlaskConical size={12} className="shrink-0" aria-hidden />
              {bt('list.ai_mock')}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

export default function BlogListPage({ orgslug }: { orgslug: string }) {
  const { bt } = useBlogT()
  const queryClient = useQueryClient()
  const { orgId } = useBlogAuth()
  const { data: config } = useBlogConfig()
  const { data: activeJob } = useActiveBlogJob()

  const [status, setStatus] = useState<StatusFilter>('')
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogJobId, setDialogJobId] = useState<number | null>(null)
  const [dismissedJobId, setDismissedJobId] = useState<number | null>(null)

  // Debounced search; a new query starts again at page 1. Same normalisation
  // as the API (trimmed, 100 characters).
  useEffect(() => {
    const next = search.trim().slice(0, BLOG_LIMITS.search)
    if (next === q) return
    const timer = window.setTimeout(() => {
      setQ(next)
      setPage(1)
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [search, q])

  const { data, isLoading, isFetching, error } = useBlogPosts({ page, q, status })

  const items = data?.items ?? []
  const counts = data?.counts ?? { all: 0, draft: 0, published: 0 }
  const pages = totalPages(data?.total ?? 0, data?.limit ?? BLOG_PAGE_SIZE)
  const editorHref = (id: number) => getUriWithOrg(orgslug, `/dash/blog/${id}`)

  const bannerJob = activeJob && activeJob.operation === 'generate' && activeJob.id !== dismissedJobId ? activeJob : null

  const openDialog = () => {
    // Follow the running job if there is one; otherwise show the form.
    const latest = bannerJob ? queryClient.getQueryData<BlogJob>(queryKeys.blog.job(orgId, bannerJob.id)) ?? bannerJob : null
    setDialogJobId(latest && jobIsActive(latest) ? latest.id : null)
    setDialogOpen(true)
  }

  const onBannerFinished = (job: BlogJob) => {
    if (job.status !== 'done') return
    queryClient.invalidateQueries({ queryKey: ['blog', orgId, 'posts'] })
    toast.success(bt('list.job_done'))
  }

  const setFilter = (next: StatusFilter) => {
    setStatus(next)
    setPage(1)
  }

  const filters: { value: StatusFilter; label: string }[] = [
    { value: '', label: bt('list.filter_all', { count: counts.all }) },
    { value: 'draft', label: bt('list.filter_draft', { count: counts.draft }) },
    { value: 'published', label: bt('list.filter_published', { count: counts.published }) },
  ]

  let body: React.ReactNode
  if (error && !data) {
    body = (
      <div className="rounded-xl bg-white nice-shadow px-5 py-6 text-sm text-red-600">
        {isForbidden(error) ? bt('forbidden') : bt('load_error')}
      </div>
    )
  } else {
    body = (
      <div className="rounded-xl bg-white nice-shadow px-4 py-4 sm:px-5 space-y-4">
        {/* Filters + search */}
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div
            role="group"
            aria-label={bt('list.filter_label')}
            className="inline-flex max-w-full flex-wrap rounded-2xl border border-[#EAE8F2] bg-[#FFFCF9] p-0.5 self-start"
          >
            {filters.map((f) => {
              const active = f.value === status
              return (
                <button
                  key={f.value || 'all'}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setFilter(f.value)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    active ? 'bg-[#190933] text-white' : 'text-[#584F72] hover:bg-[#EEEDFF]'
                  }`}
                >
                  {isLoading ? f.label.replace(/\(\d+\)/, '(…)') : f.label}
                </button>
              )
            })}
          </div>
          <div className="flex items-center gap-2 md:max-w-sm w-full">
            <div className="relative w-full">
              <Search size={15} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-gray-400" aria-hidden />
              <Input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label={bt('list.search_label')}
                placeholder={bt('list.search_placeholder')}
                maxLength={BLOG_LIMITS.search}
                className="ps-9"
              />
            </div>
            <span className="w-4 shrink-0">
              {isFetching && !isLoading && <Loader2 size={15} className="animate-spin text-gray-400" aria-hidden />}
            </span>
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-2 animate-pulse">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-10 rounded-md bg-gray-100" />
            ))}
          </div>
        ) : counts.all === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#EEEDFF] text-[#6559CA]">
              <Newspaper size={22} aria-hidden />
            </div>
            <p className="max-w-sm text-sm text-gray-500">{bt('list.empty')}</p>
          </div>
        ) : items.length === 0 ? (
          <p className="py-10 text-center text-sm text-gray-500">{bt('list.empty_search')}</p>
        ) : (
          <>
            {/* Table from md up */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{bt('list.col_title')}</TableHead>
                    <TableHead>{bt('list.col_status')}</TableHead>
                    <TableHead>{bt('list.col_kind')}</TableHead>
                    <TableHead>{bt('list.col_category')}</TableHead>
                    <TableHead>{bt('list.col_updated')}</TableHead>
                    <TableHead>{bt('list.col_published')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <PostRow key={item.id} item={item} href={editorHref(item.id)} bt={bt} />
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Stacked cards on phones */}
            <ul className="space-y-2 md:hidden">
              {items.map((item) => (
                <li key={item.id}>
                  <Link
                    href={editorHref(item.id)}
                    className="block rounded-lg border border-[#EAE8F2] px-3 py-3 transition-colors hover:bg-[#FFFCF9]"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 font-medium text-[#190933]">{item.title || bt('list.untitled')}</p>
                      {item.source === 'ai' && <AiBadge bt={bt} />}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                      <StatusBadge status={item.status} bt={bt} />
                      <span>{blogLabel(bt, 'kind', item.kind)}</span>
                      <span aria-hidden>·</span>
                      <span>{blogLabel(bt, 'category', item.category)}</span>
                    </div>
                    <p className="mt-1 text-xs text-gray-400">
                      {bt('editor.updated_on', { date: formatBlogDate(item.updated_at) })}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>

            {pages > 1 && (
              <nav className="flex items-center justify-between gap-3 pt-1" aria-label={bt('list.page_of', { page, pages })}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1 || isFetching}
                >
                  <ChevronLeft aria-hidden className="rtl:rotate-180" />
                  {bt('list.prev')}
                </Button>
                <span className="text-sm text-gray-500">{bt('list.page_of', { page, pages })}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(pages, p + 1))}
                  disabled={page >= pages || isFetching}
                >
                  {bt('list.next')}
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
      <PageHeader
        bt={bt}
        orgslug={orgslug}
        aiEnabled={!!config?.ai_enabled}
        aiMock={!!config?.ai_mock}
        configLoaded={!!config}
        onCreateAi={openDialog}
      />
      <div className="h-6 flex-shrink-0"></div>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.1, type: 'spring', stiffness: 80 }}
        className="flex-1 overflow-y-auto"
      >
        <div className="ms-4 me-4 sm:ms-10 sm:me-10 pb-10 space-y-4">
          {bannerJob && !dialogOpen && (
            <BlogJobProgress
              key={bannerJob.id}
              jobId={bannerJob.id}
              variant="banner"
              onFinished={onBannerFinished}
              onDismiss={() => setDismissedJobId(bannerJob.id)}
              doneSlot={(job) =>
                job.post_id ? (
                  <Button asChild size="sm" className="bg-[#190933] text-white hover:bg-[#41375B]">
                    <Link href={editorHref(job.post_id)}>{bt('list.job_open')}</Link>
                  </Button>
                ) : null
              }
            />
          )}
          {body}
        </div>
        {/* Room after the content for the floating mobile dock. */}
        <div aria-hidden className="h-24 lg:hidden" />
      </motion.div>

      <BlogAiGenerateDialog
        orgslug={orgslug}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        config={config}
        jobId={dialogJobId}
        onJobStarted={(job) => setDialogJobId(job.id)}
        onRetry={() => setDialogJobId(null)}
      />
    </div>
  )
}

function PostRow({ item, href, bt }: { item: AdminPostSummary; href: string; bt: BlogTranslate }) {
  return (
    <TableRow>
      <TableCell className="max-w-[24rem]">
        <div className="flex items-center gap-2 min-w-0">
          <Link href={href} className="truncate font-medium text-[#190933] hover:text-[#6559CA] hover:underline" title={item.title}>
            {item.title || bt('list.untitled')}
          </Link>
          {item.source === 'ai' && <AiBadge bt={bt} />}
        </div>
      </TableCell>
      <TableCell>
        <StatusBadge status={item.status} bt={bt} />
      </TableCell>
      <TableCell className="text-sm whitespace-nowrap">{blogLabel(bt, 'kind', item.kind)}</TableCell>
      <TableCell className="text-sm whitespace-nowrap">{blogLabel(bt, 'category', item.category)}</TableCell>
      <TableCell className="whitespace-nowrap text-sm text-gray-500">{formatBlogDate(item.updated_at)}</TableCell>
      {/* An unpublished post keeps its published_at (its slug stays locked), but it is not live. */}
      <TableCell className="whitespace-nowrap text-sm text-gray-500">
        {item.status === 'published' ? formatBlogDate(item.published_at, false) : '—'}
      </TableCell>
    </TableRow>
  )
}

'use client'
// Sanar y Criar: the blog post editor (/dash/blog/new and /dash/blog/{id}).
// Main column: title, slug, Markdown body with preview, summary, key
// takeaways and FAQ. Side column: status and actions, type, category,
// excerpt, cover and SEO. The form is validated here with the API's own
// limits before every request; the API still has the last word.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { motion } from 'motion/react'
import { useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { ArrowLeft, ExternalLink, EyeOff, Info, Loader2, Newspaper, Save, Send, Sparkles, Trash2 } from 'lucide-react'
import { Breadcrumbs } from '@components/Objects/Breadcrumbs/Breadcrumbs'
import { Button } from '@components/ui/button'
import ConfirmationModal from '@components/Objects/StyledElements/ConfirmationModal/ConfirmationModal'
import { createBeforeUnloadHandler, shouldGuardNavigationClick } from '@components/Objects/Editor/unsavedChangesGuard'
import { getScSiteUrl } from '@components/Objects/Menus/scBrand'
import { getUriWithOrg } from '@services/config/config'
import { queryKeys } from '@/lib/query/keys'
import {
  createBlogPost,
  deleteBlogPost,
  publishBlogPost,
  unpublishBlogPost,
  updateBlogPost,
} from '@services/blog/blog'
import {
  AdminPost,
  BLOG_CATEGORIES,
  BLOG_KINDS,
  BLOG_LIMITS,
  BlogJob,
  BlogPostDraft,
  DraftError,
  SEO_TARGETS,
  applyRevisionToDraft,
  draftFromPost,
  editDraft,
  emptyDraft,
  isDraftDirty,
  postPayload,
  slugInput,
  slugify,
  suggestedSlug,
  validateDraft,
} from './blogForm'
import { Card, SelectField, TextField } from './BlogFields'
import BlogMarkdownField from './BlogMarkdownField'
import BlogListField from './BlogListField'
import BlogFaqField from './BlogFaqField'
import BlogCoverField from './BlogCoverField'
import BlogJobProgress from './BlogJobProgress'
import BlogAiReviseDialog from './BlogAiReviseDialog'
import { StatusBadge, formatBlogDate } from './BlogListPage'
import { apiDetail, isForbidden, useActiveBlogJob, useBlogAuth, useBlogConfig, useBlogPost } from './useBlogApi'
import { blogLabel, useBlogT } from './useBlogT'

type Busy = null | 'save' | 'publish' | 'unpublish' | 'delete'
type Attempt = null | 'save' | 'publish'

/** Warns before leaving with unsaved edits: reloads/tab close and in-app links. */
function useUnsavedGuard(dirty: boolean, message: string, leavingRef: React.MutableRefObject<boolean>) {
  useEffect(() => {
    if (!dirty) return
    const unload = createBeforeUnloadHandler(() => !leavingRef.current)
    const click = (event: MouseEvent) => {
      if (leavingRef.current) return
      const anchor = (event.target as HTMLElement | null)?.closest?.('a') as HTMLAnchorElement | null
      const guard = shouldGuardNavigationClick(
        {
          defaultPrevented: event.defaultPrevented,
          button: event.button,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
        },
        anchor
          ? { href: anchor.href, target: anchor.target, origin: anchor.origin, hasDownload: anchor.hasAttribute('download') }
          : null,
        window.location.origin
      )
      if (guard && !window.confirm(message)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    window.addEventListener('beforeunload', unload)
    document.addEventListener('click', click, true)
    return () => {
      window.removeEventListener('beforeunload', unload)
      document.removeEventListener('click', click, true)
    }
  }, [dirty, message, leavingRef])
}

function EditorShell({
  orgslug,
  title,
  crumb,
  children,
}: {
  orgslug: string
  title: string
  crumb: string
  children: React.ReactNode
}) {
  const { bt } = useBlogT()
  return (
    <div className="h-screen w-full bg-[#f8f8f8] flex flex-col">
      <div className="ps-4 pe-4 sm:ps-10 sm:pe-10 tracking-tight bg-[#fcfbfc] z-10 nice-shadow flex-shrink-0 relative">
        <div className="pt-6 pb-4">
          <Breadcrumbs
            items={[
              { label: bt('breadcrumb'), href: '/dash/blog', icon: <Newspaper size={14} /> },
              { label: crumb },
            ]}
          />
        </div>
        <div className="my-2 pt-2 pb-5 flex flex-wrap items-end justify-between gap-3">
          <h1 className="pt-3 font-bold text-3xl sm:text-4xl tracking-tighter truncate min-w-0">{title}</h1>
          <Link
            href={getUriWithOrg(orgslug, '/dash/blog')}
            className="inline-flex items-center gap-1.5 pb-1 text-sm font-medium text-[#584F72] hover:text-[#190933]"
          >
            <ArrowLeft size={15} aria-hidden className="rtl:rotate-180" />
            {bt('editor.back')}
          </Link>
        </div>
      </div>
      <div className="h-6 flex-shrink-0"></div>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.1, type: 'spring', stiffness: 80 }}
        className="flex-1 overflow-y-auto"
      >
        {children}
        {/* Room after the content for the floating mobile dock. */}
        <div aria-hidden className="h-24 lg:hidden" />
      </motion.div>
    </div>
  )
}

export default function BlogEditorPage({ orgslug, postId }: { orgslug: string; postId: number | null }) {
  const { bt } = useBlogT()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { orgId, accessToken } = useBlogAuth()
  const isNew = postId === null
  const { data: config } = useBlogConfig()
  const postQuery = useBlogPost(postId)
  const post: AdminPost | null = isNew ? null : postQuery.data ?? null
  const { data: activeJob } = useActiveBlogJob()

  // Local edits on top of the saved post; null = nothing edited.
  const [edits, setEdits] = useState<BlogPostDraft | null>(null)
  const [attempt, setAttempt] = useState<Attempt>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [reviseOpen, setReviseOpen] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [failedJob, setFailedJob] = useState<BlogJob | null>(null)
  const leavingRef = useRef(false)

  const saved = useMemo(() => (isNew ? emptyDraft() : post ? draftFromPost(post) : null), [isNew, post])
  const draft = edits ?? saved
  const dirty = !!(draft && saved && isDraftDirty(draft, saved))
  const isPublished = post?.status === 'published'

  // A revision of this post running on the server (also found after a reload).
  const activeRevise = activeJob && activeJob.operation === 'revise' && activeJob.post_id === postId ? activeJob : null
  const shownJobId = activeRevise?.id ?? failedJob?.id ?? null
  const locked = !!activeRevise

  useUnsavedGuard(dirty, bt('editor.leave_confirm'), leavingRef)

  const errors: DraftError[] = useMemo(() => {
    if (!draft) return []
    const all = validateDraft(draft, { forPublish: attempt === 'publish' || isPublished, allowEmptySlug: isNew })
    // Before the first save attempt only the limits she is already past are shown.
    return attempt ? all : all.filter((e) => e.code === 'too_long' || e.code === 'too_many')
  }, [draft, attempt, isPublished, isNew])

  // --- loading / errors ---
  if (!isNew && !post) {
    const error = postQuery.error
    return (
      <EditorShell orgslug={orgslug} title={bt('editor.edit_title')} crumb={bt('editor.edit_title')}>
        <div className="ms-4 me-4 sm:ms-10 sm:me-10 pb-10">
          {error ? (
            <div className="rounded-xl bg-white nice-shadow px-5 py-6 text-sm space-y-3">
              <p className="text-red-600">
                {isForbidden(error) ? bt('forbidden') : error.status === 404 ? bt('editor.not_found') : bt('load_error')}
              </p>
              <Link href={getUriWithOrg(orgslug, '/dash/blog')} className="inline-flex items-center gap-1.5 font-medium text-[#6559CA] hover:underline">
                <ArrowLeft size={14} aria-hidden className="rtl:rotate-180" />
                {bt('editor.back')}
              </Link>
            </div>
          ) : (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] animate-pulse">
              <div className="space-y-4">
                <div className="h-40 rounded-xl bg-white nice-shadow" />
                <div className="h-[32rem] rounded-xl bg-white nice-shadow" />
              </div>
              <div className="space-y-4">
                <div className="h-48 rounded-xl bg-white nice-shadow" />
                <div className="h-64 rounded-xl bg-white nice-shadow" />
              </div>
            </div>
          )}
        </div>
      </EditorShell>
    )
  }
  if (!draft) return null

  const errorText = (e: DraftError) => blogLabel(bt, 'editor.errors', e.code, { max: e.max, min: e.min })
  const errorFor = (field: keyof BlogPostDraft) => {
    const e = errors.find((x) => x.field === field && x.index === undefined)
    return e ? errorText(e) : null
  }
  const fieldErrors = (field: keyof BlogPostDraft) => errors.filter((e) => e.field === field)

  // While creating, an empty slug is sent as is: the API derives a free one
  // from the title (the suggestion is only a hint in the field).
  const update = <K extends keyof BlogPostDraft>(field: K, value: BlogPostDraft[K]) => {
    setEdits((prev) => editDraft(prev ?? draft, field, value))
  }

  const invalidateList = () => queryClient.invalidateQueries({ queryKey: ['blog', orgId, 'posts'] })
  const storePost = (p: AdminPost) => {
    queryClient.setQueryData(queryKeys.blog.post(orgId, p.id), p)
    invalidateList()
  }
  const openEditorOf = (id: number) => {
    leavingRef.current = true
    router.replace(getUriWithOrg(orgslug, `/dash/blog/${id}`))
  }
  const afterSync = () => {
    setEdits(null)
    setAttempt(null)
  }

  /** POST (creating) or PUT (edited) the form; the stored post, or null after a toast. */
  const persist = async (): Promise<AdminPost | null> => {
    if (!accessToken) return null
    const payload = postPayload(draft)
    const res = isNew
      ? await createBlogPost(orgId, payload, accessToken)
      : await updateBlogPost(orgId, (post as AdminPost).id, payload, accessToken)
    if (!res.success) {
      toast.error(apiDetail(res.data) ?? bt('editor.save_error'))
      return null
    }
    const stored = res.data as AdminPost
    storePost(stored)
    return stored
  }

  const checkForm = (forPublish: boolean) => {
    const found = validateDraft(draft, { forPublish, allowEmptySlug: isNew })
    if (found.length) toast.error(bt('editor.fix_errors'))
    return found.length === 0
  }

  const save = async () => {
    if (busy || locked) return
    setAttempt('save')
    if (!checkForm(isPublished)) return
    if (!isNew && !dirty) return
    setBusy('save')
    try {
      const stored = await persist()
      if (!stored) return
      toast.success(bt('editor.saved'))
      if (isNew) openEditorOf(stored.id)
      else afterSync()
    } catch {
      toast.error(bt('editor.save_error'))
    } finally {
      setBusy(null)
    }
  }

  const publish = async () => {
    if (busy || locked || !accessToken) return
    setAttempt('publish')
    if (!checkForm(true)) return
    setBusy('publish')
    try {
      let target: AdminPost | null = post
      if (isNew || dirty) {
        target = await persist()
        if (!target) return
      }
      if (!target) return
      const res = await publishBlogPost(orgId, target.id, accessToken)
      if (!res.success) {
        toast.error(apiDetail(res.data) ?? bt('editor.action_error'))
        // The draft itself was saved: show it as stored.
        if (isNew) openEditorOf(target.id)
        else afterSync()
        return
      }
      storePost(res.data as AdminPost)
      toast.success(bt('editor.published'))
      if (isNew) openEditorOf(target.id)
      else afterSync()
    } catch {
      toast.error(bt('editor.action_error'))
    } finally {
      setBusy(null)
    }
  }

  const unpublish = async () => {
    if (!post || !accessToken) return
    setBusy('unpublish')
    try {
      const res = await unpublishBlogPost(orgId, post.id, accessToken)
      if (!res.success) {
        toast.error(apiDetail(res.data) ?? bt('editor.action_error'))
        return
      }
      storePost(res.data as AdminPost)
      toast.success(bt('editor.unpublished'))
    } catch {
      toast.error(bt('editor.action_error'))
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (!post || !accessToken) return
    setBusy('delete')
    try {
      const res = await deleteBlogPost(orgId, post.id, accessToken)
      if (!res.success) {
        toast.error(apiDetail(res.data) ?? bt('editor.action_error'))
        return
      }
      toast.success(bt('editor.deleted'))
      leavingRef.current = true
      queryClient.removeQueries({ queryKey: queryKeys.blog.post(orgId, post.id) })
      invalidateList()
      router.push(getUriWithOrg(orgslug, '/dash/blog'))
    } catch {
      toast.error(bt('editor.action_error'))
    } finally {
      setBusy(null)
    }
  }

  const onReviseFinished = async (job: BlogJob) => {
    // The org has no running job any more.
    queryClient.setQueryData(queryKeys.blog.activeJob(orgId), null)
    if (job.status === 'error') {
      setFailedJob(job)
      return
    }
    if (job.status !== 'done') return
    setFailedJob(null)
    setInstruction('')
    if (job.applied) {
      await postQuery.refetch()
      afterSync()
      invalidateList()
      toast.success(bt('ai.revise_applied'))
    } else if (job.result) {
      // Not applied: the post is published, or the draft was saved meanwhile
      // (another tab). The proposal goes on top of the post as stored now.
      const fresh = (await postQuery.refetch()).data
      const current = fresh ?? queryClient.getQueryData<AdminPost>(queryKeys.blog.post(orgId, postId ?? 0)) ?? post
      setEdits(applyRevisionToDraft(draftFromPost(current), job.result))
      toast(current?.status === 'published' ? bt('ai.revise_loaded') : bt('ai.revise_loaded_draft'), {
        icon: <Sparkles size={18} className="shrink-0 text-[#6559CA]" aria-hidden />,
        duration: 9000,
      })
    }
  }

  // --- the AI button: why it is off, if it is ---
  const aiEnabled = !!config?.ai_enabled
  const reviseBlocker = isNew
    ? bt('ai.revise_save_first')
    : config && !aiEnabled
      ? bt('list.ai_disabled')
      : dirty
        ? bt('ai.revise_dirty')
        : null
  const reviseDisabled = !config || !!reviseBlocker || locked || busy !== null

  const autoSlug = draft.title.trim() ? suggestedSlug(draft.title) : ''
  const siteSlug = draft.slug || autoSlug
  const disabled = locked || busy !== null
  const titleText = isNew ? bt('editor.new_title') : bt('editor.edit_title')

  const statusCard = (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold text-[#190933]">{bt('editor.status_label')}</h2>
        <StatusBadge status={post?.status ?? 'draft'} bt={bt} />
      </div>
      <div className="space-y-1 text-xs text-gray-500">
        {isPublished && post?.published_at && <p>{bt('editor.published_on', { date: formatBlogDate(post.published_at) })}</p>}
        {!isPublished && <p>{bt('editor.draft_hint')}</p>}
        {post && <p>{bt('editor.updated_on', { date: formatBlogDate(post.updated_at) })}</p>}
        {post?.source === 'ai' && (
          <p className="inline-flex items-center gap-1 text-[#6559CA]">
            <Sparkles size={12} aria-hidden />
            {bt('editor.source_ai', { model: post.ai_model || 'IA' })}
          </p>
        )}
        {post && post.word_count > 0 && (
          <p>
            {bt('editor.reading_minutes', { count: post.reading_minutes })} · {bt('word_count', { count: post.word_count })}
          </p>
        )}
      </div>
      {isPublished && (
        <p className="flex items-start gap-2 rounded-lg bg-[#EEEDFF]/60 px-3 py-2 text-xs text-[#41375B]">
          <Info size={14} className="mt-0.5 shrink-0 text-[#6559CA]" aria-hidden />
          <span>{bt('editor.published_live_hint')}</span>
        </p>
      )}
      <p role="status" className="min-h-4 text-xs font-medium text-amber-700">
        {dirty ? bt('editor.unsaved') : ''}
      </p>

      <div className="flex flex-wrap gap-2">
        {isPublished ? (
          <>
            <Button
              type="button"
              size="sm"
              onClick={save}
              disabled={disabled || !dirty}
              aria-busy={busy === 'save' || undefined}
              className="bg-[#190933] text-white hover:bg-[#41375B]"
            >
              {busy === 'save' ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
              {busy === 'save' ? bt('editor.saving') : bt('editor.save_changes')}
            </Button>
            <ConfirmationModal
              status="info"
              dialogTitle={bt('editor.unpublish_confirm_title')}
              confirmationMessage={bt('editor.unpublish_confirm_text')}
              confirmationButtonText={bt('editor.unpublish')}
              functionToExecute={unpublish}
              dialogTrigger={
                <Button type="button" variant="outline" size="sm" disabled={disabled} aria-busy={busy === 'unpublish' || undefined}>
                  {busy === 'unpublish' ? <Loader2 className="animate-spin" aria-hidden /> : <EyeOff aria-hidden />}
                  {bt('editor.unpublish')}
                </Button>
              }
            />
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={save}
              disabled={disabled || (!isNew && !dirty)}
              aria-busy={busy === 'save' || undefined}
            >
              {busy === 'save' ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
              {busy === 'save' ? bt('editor.saving') : bt('editor.save_draft')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={publish}
              disabled={disabled}
              aria-busy={busy === 'publish' || undefined}
              className="bg-[#190933] text-white hover:bg-[#41375B]"
            >
              {busy === 'publish' ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden className="rtl:-scale-x-100" />}
              {busy === 'publish' ? bt('editor.publishing') : bt('editor.publish')}
            </Button>
          </>
        )}
      </div>

      <div className="flex flex-wrap gap-2 border-t border-[#EAE8F2] pt-3">
        {isPublished && post && (
          <Button asChild variant="outline" size="sm">
            <a href={getScSiteUrl('/blog/' + post.slug)} target="_blank" rel="noopener noreferrer">
              <ExternalLink aria-hidden />
              {bt('editor.view_on_site')}
            </a>
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setReviseOpen(true)}
          disabled={reviseDisabled}
          aria-describedby={reviseBlocker ? 'blog-revise-blocker' : undefined}
          className="border-[#BBBBFF] text-[#41375B] hover:bg-[#EEEDFF]"
        >
          <Sparkles aria-hidden className="text-[#6559CA]" />
          {bt('ai.revise_button')}
        </Button>
        {post && (
          <ConfirmationModal
            status="warning"
            dialogTitle={bt('editor.delete_confirm_title')}
            confirmationMessage={bt('editor.delete_confirm_text', { title: post.title })}
            confirmationButtonText={bt('editor.delete')}
            functionToExecute={remove}
            dialogTrigger={
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                aria-busy={busy === 'delete' || undefined}
                className="text-red-600 hover:bg-red-50 hover:text-red-700"
              >
                {busy === 'delete' ? <Loader2 className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
                {bt('editor.delete')}
              </Button>
            }
          />
        )}
      </div>
      {reviseBlocker && (
        <p id="blog-revise-blocker" className="text-xs text-gray-500">
          {reviseBlocker}
        </p>
      )}
    </Card>
  )

  return (
    <EditorShell orgslug={orgslug} title={titleText} crumb={draft.title.trim() || titleText}>
      <div className="ms-4 me-4 sm:ms-10 sm:me-10 pb-10 space-y-4">
        {shownJobId !== null && (
          <BlogJobProgress
            key={shownJobId}
            jobId={shownJobId}
            variant="inline"
            onFinished={onReviseFinished}
            onRetry={() => {
              setFailedJob(null)
              setReviseOpen(true)
            }}
            onDismiss={() => {
              setFailedJob(null)
              // A job given up on (shown as taking too long) must not keep the
              // editor locked: forget it here and ask the API, which marks it
              // as interrupted after 10 minutes (and re-locks if it still runs).
              queryClient.setQueryData(queryKeys.blog.activeJob(orgId), null)
              queryClient.invalidateQueries({ queryKey: queryKeys.blog.activeJob(orgId) })
            }}
          />
        )}

        {/* Phones: status first, then the article, then the settings. From lg up: two columns. */}
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:grid-rows-[auto_1fr] lg:items-start lg:gap-6">
          <div className="lg:col-start-2 lg:row-start-1 min-w-0">{statusCard}</div>

          <div className="lg:col-start-1 lg:row-start-1 lg:row-span-2 space-y-4 min-w-0">
            <Card>
              <TextField
                id="blog-title"
                label={bt('editor.title_label')}
                placeholder={bt('editor.title_placeholder')}
                value={draft.title}
                onChange={(v) => update('title', v)}
                max={BLOG_LIMITS.title}
                target={SEO_TARGETS.title}
                error={errorFor('title')}
                disabled={disabled}
                inputClassName="h-11 text-base font-semibold"
              />
              <TextField
                id="blog-slug"
                label={bt('editor.slug_label')}
                prefix="/blog/"
                dir="ltr"
                placeholder={autoSlug || 'mi-articulo'}
                value={draft.slug}
                onChange={(v) => update('slug', slugInput(v))}
                onBlur={() => {
                  const clean = slugify(draft.slug)
                  if (clean !== draft.slug) update('slug', clean)
                }}
                max={BLOG_LIMITS.slug}
                hint={
                  post?.slug_locked
                    ? bt('editor.slug_locked')
                    : [
                        siteSlug ? bt('editor.slug_hint', { url: getScSiteUrl('/blog/' + siteSlug) }) : '',
                        isNew && !draft.slug ? bt('editor.slug_auto') : '',
                      ]
                        .filter(Boolean)
                        .join(' ')
                }
                error={errorFor('slug')}
                disabled={disabled || !!post?.slug_locked}
              />
            </Card>

            <Card>
              <BlogMarkdownField
                value={draft.content_md}
                onChange={(v) => update('content_md', v)}
                savedMd={post ? post.content_md : null}
                savedHtml={post ? post.content_html : null}
                error={errorFor('content_md')}
                disabled={disabled}
              />
            </Card>

            <Card>
              <TextField
                id="blog-summary"
                label={bt('editor.summary_label')}
                hint={bt('editor.summary_hint')}
                value={draft.summary}
                onChange={(v) => update('summary', v)}
                max={BLOG_LIMITS.summary}
                wordTarget={SEO_TARGETS.summary_words}
                error={errorFor('summary')}
                multiline
                rows={4}
                disabled={disabled}
              />
              <BlogListField
                label={bt('editor.takeaways_label')}
                itemLabel={bt('editor.takeaways_label')}
                hint={bt('editor.takeaways_hint')}
                items={draft.key_takeaways}
                onChange={(v) => update('key_takeaways', v)}
                maxItems={BLOG_LIMITS.key_takeaways_items}
                maxLength={BLOG_LIMITS.key_takeaway}
                targetItems={SEO_TARGETS.key_takeaways}
                placeholder={bt('editor.takeaway_placeholder')}
                errors={fieldErrors('key_takeaways')}
                errorText={errorText}
                disabled={disabled}
              />
            </Card>

            <Card>
              <BlogFaqField
                items={draft.faq}
                onChange={(v) => update('faq', v)}
                errors={fieldErrors('faq')}
                errorText={errorText}
                disabled={disabled}
              />
            </Card>
          </div>

          <div className="lg:col-start-2 lg:row-start-2 space-y-4 min-w-0">
            <Card title={bt('editor.details_title')}>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
                <SelectField
                  id="blog-kind"
                  label={bt('editor.kind_label')}
                  value={draft.kind}
                  onChange={(v) => update('kind', v)}
                  options={BLOG_KINDS.map((k) => ({ value: k, label: blogLabel(bt, 'kind', k) }))}
                  error={errorFor('kind')}
                  disabled={disabled}
                />
                <SelectField
                  id="blog-category"
                  label={bt('editor.category_label')}
                  value={draft.category}
                  onChange={(v) => update('category', v)}
                  options={BLOG_CATEGORIES.map((c) => ({ value: c, label: blogLabel(bt, 'category', c) }))}
                  error={errorFor('category')}
                  disabled={disabled}
                />
              </div>
              <TextField
                id="blog-excerpt"
                label={bt('editor.excerpt_label')}
                hint={bt('editor.excerpt_hint')}
                value={draft.excerpt}
                onChange={(v) => update('excerpt', v)}
                max={BLOG_LIMITS.excerpt}
                target={SEO_TARGETS.excerpt}
                error={errorFor('excerpt')}
                multiline
                rows={3}
                disabled={disabled}
              />
            </Card>

            <Card title={bt('editor.cover_title')}>
              <BlogCoverField
                post={post}
                alt={draft.cover_alt}
                onAltChange={(v) => update('cover_alt', v)}
                altError={errorFor('cover_alt')}
                onPostChange={storePost}
                disabled={disabled}
              />
            </Card>

            <Card title={bt('editor.seo_title')}>
              <TextField
                id="blog-meta-title"
                label={bt('editor.meta_title_label')}
                hint={bt('editor.meta_title_hint')}
                placeholder={draft.title}
                value={draft.meta_title}
                onChange={(v) => update('meta_title', v)}
                max={BLOG_LIMITS.meta_title}
                target={SEO_TARGETS.meta_title}
                error={errorFor('meta_title')}
                disabled={disabled}
              />
              <TextField
                id="blog-meta-description"
                label={bt('editor.meta_description_label')}
                hint={bt('editor.meta_description_hint')}
                placeholder={draft.excerpt}
                value={draft.meta_description}
                onChange={(v) => update('meta_description', v)}
                max={BLOG_LIMITS.meta_description}
                target={SEO_TARGETS.meta_description}
                error={errorFor('meta_description')}
                multiline
                rows={3}
                disabled={disabled}
              />
              <BlogListField
                label={bt('editor.keywords_label')}
                itemLabel={bt('editor.keywords_label')}
                hint={bt('editor.keywords_hint')}
                items={draft.keywords}
                onChange={(v) => update('keywords', v)}
                maxItems={BLOG_LIMITS.keywords_items}
                maxLength={BLOG_LIMITS.keyword}
                targetItems={SEO_TARGETS.keywords}
                placeholder={bt('editor.keyword_placeholder')}
                errors={fieldErrors('keywords')}
                errorText={errorText}
                disabled={disabled}
              />
            </Card>
          </div>
        </div>
      </div>

      {post && (
        <BlogAiReviseDialog
          open={reviseOpen}
          onOpenChange={setReviseOpen}
          postId={post.id}
          instruction={instruction}
          onInstructionChange={setInstruction}
          onJobStarted={() => setFailedJob(null)}
        />
      )}
    </EditorShell>
  )
}

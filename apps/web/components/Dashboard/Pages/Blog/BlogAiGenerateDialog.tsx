'use client'
// Sanar y Criar: "Crear con IA". She describes the topic, the API starts a
// background job (202) and this dialog follows it; when the draft is ready the
// editor opens. Closing the dialog does not cancel anything: the list shows
// the job's progress in a banner instead. What she typed is kept while the
// list stays open (also after an error, for "Intentar de nuevo").
import React, { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Loader2, ShieldAlert, Sparkles } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@components/ui/dialog'
import { Button } from '@components/ui/button'
import { getUriWithOrg } from '@services/config/config'
import { queryKeys } from '@/lib/query/keys'
import { generateBlogPost } from '@services/blog/blog'
import {
  BLOG_AUDIENCES,
  BLOG_KINDS,
  BLOG_LENGTHS,
  BLOG_LIMITS,
  BlogConfig,
  BlogJob,
  DEFAULT_AUDIENCE,
  DEFAULT_KIND,
  DEFAULT_LENGTH,
  GenerateBody,
  textLength,
} from './blogForm'
import { SelectField, TextField } from './BlogFields'
import BlogJobProgress from './BlogJobProgress'
import { apiDetail, useBlogAuth } from './useBlogApi'
import { blogLabel, useBlogT } from './useBlogT'

type Props = {
  orgslug: string
  open: boolean
  onOpenChange: (_open: boolean) => void
  config: BlogConfig | undefined
  /** The job this dialog follows (null = show the form). */
  jobId: number | null
  onJobStarted: (_job: BlogJob) => void
  /** Back to the form after a failed job. */
  onRetry: () => void
}

const EMPTY_FORM: GenerateBody = {
  prompt: '',
  kind: DEFAULT_KIND,
  audience: DEFAULT_AUDIENCE,
  length: DEFAULT_LENGTH,
  keyword: '',
  facts: '',
}

export default function BlogAiGenerateDialog({ orgslug, open, onOpenChange, config, jobId, onJobStarted, onRetry }: Props) {
  const { bt } = useBlogT()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { orgId, accessToken } = useBlogAuth()
  const [form, setForm] = useState<GenerateBody>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [requestError, setRequestError] = useState<string | null>(null)

  const promptLength = textLength(form.prompt.trim())
  const valid =
    promptLength >= BLOG_LIMITS.prompt_min &&
    promptLength <= BLOG_LIMITS.prompt &&
    textLength(form.keyword.trim()) <= BLOG_LIMITS.ai_keyword &&
    textLength(form.facts.trim()) <= BLOG_LIMITS.facts
  const aiEnabled = !!config?.ai_enabled
  const isNews = form.kind === 'novedad' || form.kind === 'taller'

  const set = <K extends keyof GenerateBody>(key: K, value: GenerateBody[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
    setRequestError(null)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!valid || submitting || !aiEnabled || !accessToken) return
    setSubmitting(true)
    setRequestError(null)
    try {
      const body: GenerateBody = {
        ...form,
        prompt: form.prompt.trim(),
        keyword: form.keyword.trim(),
        facts: form.facts.trim(),
      }
      const res = await generateBlogPost(orgId, body, accessToken)
      if (!res.success) {
        setRequestError(apiDetail(res.data) ?? bt('ai.request_error'))
        return
      }
      const job = res.data as BlogJob
      queryClient.setQueryData(queryKeys.blog.job(orgId, job.id), job)
      queryClient.setQueryData(queryKeys.blog.activeJob(orgId), job)
      onJobStarted(job)
    } catch {
      setRequestError(bt('ai.request_error'))
    } finally {
      setSubmitting(false)
    }
  }

  const onFinished = (job: BlogJob) => {
    // The org has no running job any more.
    queryClient.setQueryData(queryKeys.blog.activeJob(orgId), null)
    if (job.status !== 'done') return
    queryClient.invalidateQueries({ queryKey: ['blog', orgId, 'posts'] })
    if (job.post_id) {
      setForm(EMPTY_FORM)
      router.push(getUriWithOrg(orgslug, `/dash/blog/${job.post_id}`))
    }
  }

  const retry = () => {
    setRequestError(null)
    onRetry()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] max-w-[95vw] sm:max-w-xl max-h-[90vh] overflow-y-auto p-0">
        <DialogHeader className="space-y-1 border-b border-gray-100 px-5 py-4 pe-14 text-start">
          <DialogTitle className="flex items-center gap-2 text-lg text-[#190933]">
            <Sparkles size={18} className="text-[#6559CA]" aria-hidden />
            {bt('ai.generate_title')}
          </DialogTitle>
          <DialogDescription className="text-sm text-gray-500">{bt('ai.generate_intro')}</DialogDescription>
        </DialogHeader>

        {jobId ? (
          <div className="space-y-4 px-5 py-5">
            <BlogJobProgress jobId={jobId} variant="dialog" onFinished={onFinished} onRetry={retry} />
            <div className="flex justify-end">
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                {bt('ai.close')}
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4 px-5 py-5" noValidate>
            <TextField
              id="blog-ai-prompt"
              label={bt('ai.prompt_label')}
              placeholder={bt('ai.prompt_placeholder')}
              hint={bt('ai.prompt_hint')}
              value={form.prompt}
              onChange={(v) => set('prompt', v)}
              max={BLOG_LIMITS.prompt}
              multiline
              rows={4}
              autoFocus
              disabled={submitting}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                id="blog-ai-kind"
                label={bt('ai.kind_label')}
                value={form.kind}
                onChange={(v) => set('kind', v)}
                options={BLOG_KINDS.map((k) => ({ value: k, label: blogLabel(bt, 'kind', k) }))}
                disabled={submitting}
              />
              <SelectField
                id="blog-ai-length"
                label={bt('ai.length_label')}
                value={form.length}
                onChange={(v) => set('length', v)}
                options={BLOG_LENGTHS.map((l) => ({ value: l, label: blogLabel(bt, 'ai.length', l) }))}
                disabled={submitting}
              />
            </div>
            <SelectField
              id="blog-ai-audience"
              label={bt('ai.audience_label')}
              value={form.audience}
              onChange={(v) => set('audience', v)}
              options={BLOG_AUDIENCES.map((a) => ({ value: a, label: blogLabel(bt, 'ai.audience', a) }))}
              disabled={submitting}
            />
            <TextField
              id="blog-ai-keyword"
              label={bt('ai.keyword_label')}
              hint={bt('ai.keyword_hint')}
              value={form.keyword}
              onChange={(v) => set('keyword', v)}
              max={BLOG_LIMITS.ai_keyword}
              disabled={submitting}
            />
            <TextField
              id="blog-ai-facts"
              label={bt('ai.facts_label')}
              placeholder={bt('ai.facts_placeholder')}
              hint={isNews && !form.facts.trim() ? `${bt('ai.facts_recommended')} ${bt('ai.facts_hint')}` : bt('ai.facts_hint')}
              value={form.facts}
              onChange={(v) => set('facts', v)}
              max={BLOG_LIMITS.facts}
              multiline
              rows={3}
              disabled={submitting}
            />

            <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <ShieldAlert size={15} className="mt-0.5 shrink-0" aria-hidden />
              <span>{bt('ai.privacy_warning')}</span>
            </p>

            {!aiEnabled && config && (
              <p className="text-sm font-medium text-red-600">{bt('list.ai_disabled')}</p>
            )}
            {requestError && (
              <p role="alert" className="flex items-start gap-2 text-sm font-medium text-red-600">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
                <span>{requestError}</span>
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <p className="text-xs text-gray-400">
                {config?.ai_hourly_limit ? bt('ai.hourly_limit', { limit: config.ai_hourly_limit }) : ''}
              </p>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
                  {bt('ai.cancel')}
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!valid || submitting || !aiEnabled}
                  aria-busy={submitting || undefined}
                  className="bg-[#190933] text-white hover:bg-[#41375B]"
                >
                  {submitting ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />}
                  {bt('ai.submit')}
                </Button>
              </div>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

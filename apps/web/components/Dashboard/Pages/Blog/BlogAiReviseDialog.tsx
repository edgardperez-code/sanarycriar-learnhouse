'use client'
// Sanar y Criar: "Mejorar con IA". Sends her instruction for the saved post;
// the API answers 202 with a job and the editor follows it (read-only until it
// ends). The instruction lives in the editor, so "Intentar de nuevo" keeps it.
import React, { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Loader2, ShieldAlert, Sparkles } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@components/ui/dialog'
import { Button } from '@components/ui/button'
import { queryKeys } from '@/lib/query/keys'
import { reviseBlogPost } from '@services/blog/blog'
import { BLOG_LIMITS, BlogJob, textLength } from './blogForm'
import { TextField } from './BlogFields'
import { apiDetail, useBlogAuth } from './useBlogApi'
import { useBlogT } from './useBlogT'

type Props = {
  open: boolean
  onOpenChange: (_open: boolean) => void
  postId: number
  instruction: string
  onInstructionChange: (_value: string) => void
  onJobStarted: (_job: BlogJob) => void
}

export default function BlogAiReviseDialog({ open, onOpenChange, postId, instruction, onInstructionChange, onJobStarted }: Props) {
  const { bt } = useBlogT()
  const queryClient = useQueryClient()
  const { orgId, accessToken } = useBlogAuth()
  const [submitting, setSubmitting] = useState(false)
  const [requestError, setRequestError] = useState<string | null>(null)

  const length = textLength(instruction.trim())
  const valid = length >= BLOG_LIMITS.instruction_min && length <= BLOG_LIMITS.instruction

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!valid || submitting || !accessToken) return
    setSubmitting(true)
    setRequestError(null)
    try {
      const res = await reviseBlogPost(orgId, postId, instruction.trim(), accessToken)
      if (!res.success) {
        setRequestError(apiDetail(res.data) ?? bt('ai.request_error'))
        return
      }
      const job = res.data as BlogJob
      queryClient.setQueryData(queryKeys.blog.job(orgId, job.id), job)
      queryClient.setQueryData(queryKeys.blog.activeJob(orgId), job)
      onJobStarted(job)
      onOpenChange(false)
    } catch {
      setRequestError(bt('ai.request_error'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setRequestError(null)
        onOpenChange(next)
      }}
    >
      <DialogContent className="w-[95vw] max-w-[95vw] sm:max-w-lg max-h-[90vh] overflow-y-auto p-0">
        <DialogHeader className="space-y-1 border-b border-gray-100 px-5 py-4 pe-14 text-start">
          <DialogTitle className="flex items-center gap-2 text-lg text-[#190933]">
            <Sparkles size={18} className="text-[#6559CA]" aria-hidden />
            {bt('ai.revise_title')}
          </DialogTitle>
          <DialogDescription className="text-sm text-gray-500">{bt('ai.revise_intro')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4 px-5 py-5" noValidate>
          <TextField
            id="blog-ai-instruction"
            label={bt('ai.revise_label')}
            placeholder={bt('ai.revise_placeholder')}
            hint={bt('ai.revise_hint')}
            value={instruction}
            onChange={(v) => {
              onInstructionChange(v)
              setRequestError(null)
            }}
            max={BLOG_LIMITS.instruction}
            multiline
            rows={4}
            autoFocus
            disabled={submitting}
          />
          <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <ShieldAlert size={15} className="mt-0.5 shrink-0" aria-hidden />
            <span>{bt('ai.revise_privacy_warning')}</span>
          </p>
          {requestError && (
            <p role="alert" className="flex items-start gap-2 text-sm font-medium text-red-600">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
              <span>{requestError}</span>
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
              {bt('ai.cancel')}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!valid || submitting}
              aria-busy={submitting || undefined}
              className="bg-[#190933] text-white hover:bg-[#41375B]"
            >
              {submitting ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />}
              {bt('ai.revise_submit')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

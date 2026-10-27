'use client'
// Sanar y Criar: follows one AI job (generate or revise) until it ends. The
// job runs on the server: closing the dialog or reloading the page does not
// stop it, and the list / editor pick it up again with GET ai/jobs/active.
import React, { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock, Loader2, Sparkles, X } from 'lucide-react'
import { Button } from '@components/ui/button'
import { BlogJob, formatElapsed, jobElapsedSeconds, jobIsActive } from './blogForm'
import { jobTimedOut, useBlogJob } from './useBlogApi'
import { useBlogT } from './useBlogT'

type Props = {
  jobId: number
  /** dialog: big, centred; banner: one line over the list; inline: editor card. */
  variant: 'dialog' | 'banner' | 'inline'
  /** Called once when the job reaches done or error. */
  onFinished?: (_job: BlogJob) => void
  onRetry?: () => void
  onDismiss?: () => void
  /** Extra content for the done state (the list's "Abrir borrador"). */
  doneSlot?: (_job: BlogJob) => React.ReactNode
}

export default function BlogJobProgress({ jobId, variant, onFinished, onRetry, onDismiss, doneSlot }: Props) {
  const { bt } = useBlogT()
  const { data: job, error, dataUpdatedAt } = useBlogJob(jobId)
  const [now, setNow] = useState(0)
  const firedRef = useRef<string | null>(null)

  const active = jobIsActive(job)
  const clock = now || dataUpdatedAt
  const timedOut = jobTimedOut(job, dataUpdatedAt, clock)

  // A ticking clock between polls.
  useEffect(() => {
    if (!active || timedOut) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active, timedOut])

  useEffect(() => {
    if (!job || jobIsActive(job)) return
    const key = `${job.id}:${job.status}`
    if (firedRef.current === key) return
    firedRef.current = key
    onFinished?.(job)
  }, [job, onFinished])

  const isRevise = job?.operation === 'revise'
  const elapsed = formatElapsed(jobElapsedSeconds(job, dataUpdatedAt, clock))

  const dismissButton = onDismiss ? (
    <button
      type="button"
      onClick={onDismiss}
      aria-label={bt('ai.dismiss')}
      title={bt('ai.dismiss')}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-black/5 hover:text-gray-600"
    >
      <X size={15} aria-hidden />
    </button>
  ) : null

  // --- error (the job failed, or we cannot read it) ---
  if ((job && job.status === 'error') || (!job && error)) {
    const message = job?.error || bt('ai.status_error')
    const title = isRevise ? bt('ai.revise_error_title') : bt('ai.error_title')
    return (
      <div
        role="alert"
        className={`flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 text-red-800 ${
          variant === 'dialog' ? 'px-4 py-4' : 'px-4 py-3'
        }`}
      >
        <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="font-semibold">{title}</p>
          <p className="text-sm">{message}</p>
          {onRetry && (
            <Button type="button" size="sm" variant="outline" onClick={onRetry} className="bg-white">
              {bt('ai.retry')}
            </Button>
          )}
        </div>
        {dismissButton}
      </div>
    )
  }

  // --- done ---
  if (job && job.status === 'done') {
    const text =
      variant === 'dialog'
        ? bt('ai.done')
        : isRevise
          ? job.applied
            ? bt('ai.revise_applied')
            : bt('ai.revise_loaded')
          : bt('list.job_done')
    return (
      <div
        role="status"
        className={`flex flex-wrap items-center gap-3 rounded-xl border border-green-200 bg-green-50 text-green-800 ${
          variant === 'dialog' ? 'px-4 py-4' : 'px-4 py-3'
        }`}
      >
        {variant === 'dialog' ? (
          <Loader2 size={18} className="shrink-0 animate-spin" aria-hidden />
        ) : (
          <CheckCircle2 size={18} className="shrink-0" aria-hidden />
        )}
        <p className="min-w-0 flex-1 font-medium">{text}</p>
        {doneSlot?.(job)}
        {dismissButton}
      </div>
    )
  }

  // --- still working (or not loaded yet) ---
  if (variant === 'dialog') {
    return (
      <div role="status" aria-live="polite" className="flex flex-col items-center gap-3 px-2 py-6 text-center">
        <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-[#EEEDFF] text-[#6559CA]">
          <Sparkles size={24} aria-hidden />
          {!timedOut && <Loader2 size={56} className="absolute inset-0 animate-spin text-[#BBBBFF]" aria-hidden />}
        </div>
        <p className="text-lg font-semibold text-[#190933]">{bt('ai.working_title')}</p>
        <p className="max-w-sm text-sm text-gray-500">{timedOut ? bt('ai.timeout') : bt('ai.working_text')}</p>
        <p className="inline-flex items-center gap-1.5 text-xs tabular-nums text-gray-400">
          <Clock size={12} aria-hidden />
          {bt('ai.elapsed', { time: elapsed })}
        </p>
      </div>
    )
  }

  const text = timedOut ? bt('ai.timeout') : isRevise ? bt('ai.revise_working') : bt('list.job_running')
  return (
    <div role="status" aria-live="polite" className="flex items-start gap-3 rounded-xl border border-[#BBBBFF] bg-[#EEEDFF]/60 px-4 py-3 text-[#41375B]">
      {timedOut ? (
        <Clock size={18} className="mt-0.5 shrink-0" aria-hidden />
      ) : (
        <Loader2 size={18} className="mt-0.5 shrink-0 animate-spin text-[#6559CA]" aria-hidden />
      )}
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-medium">{text}</p>
        {isRevise && !timedOut && <p className="text-xs">{bt('ai.revise_locked')}</p>}
        <p className="text-xs tabular-nums text-[#584F72]">{bt('ai.elapsed', { time: elapsed })}</p>
      </div>
      {timedOut && dismissButton}
    </div>
  )
}

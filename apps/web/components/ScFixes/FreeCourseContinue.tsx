'use client'
// Sanar y Criar: free courses with history get "Continuar" (to the exact
// point, same rule as the "Continuar donde lo dejaste" card) plus a
// low-emphasis "Salir del curso" that asks first, because leaving deletes the
// learner's progress (remove_course_from_trail also clears saved positions).
// Shared by CoursesActions (desktop) and CourseActionsMobile.
import React from 'react'
import { Loader2, LogOut } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@components/ui/dialog'
import { useCourseProgress } from '@/hooks/queries/useCourseProgress'
import { resolveContinueTarget } from '@components/SanarYCriar/ContinueLearningCard'
import { clearLocalCourseProgress } from '@components/SanarYCriar/progressLocal'
import { useFixesT } from './useFixesT'

/**
 * Where "Continuar" goes on a free course: the saved position (video `?t=`,
 * PDF `?page=`, or the next lesson once the last one is done) when there is
 * one, else `fallbackHref` (the first lesson not completed in the trail).
 */
export function useFreeCourseContinue({
  course,
  orgslug,
  trailData,
  fallbackHref,
}: {
  course: any
  orgslug: string
  trailData?: any
  fallbackHref: string | null
}) {
  // Same query (and cache entry) as ContinueLearningCard: no extra request.
  const { data: progress } = useCourseProgress(course?.course_uuid)
  const target = React.useMemo(
    () => resolveContinueTarget(course, progress, trailData, orgslug),
    [course, progress, trailData, orgslug]
  )
  return { hasProgress: !!target, href: target?.href ?? fallbackHref }
}

/**
 * Drop this device's progress mirror for a course the learner just left, so
 * a save from the last two minutes can't bring "Continuar" back. Delegates to
 * progressLocal.ts so the key format lives in one place.
 */
export function forgetLocalCourseProgress(userKey: string, course: any) {
  clearLocalCourseProgress(userKey, course)
}

/** Low-emphasis "Salir del curso" link that opens the confirmation. */
export function LeaveCourseLink({
  onClick,
  disabled,
  size = 'md',
}: {
  onClick: () => void
  disabled?: boolean
  size?: 'sm' | 'md'
}) {
  const { fx } = useFixesT()
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`mx-auto flex items-center justify-center gap-1.5 rounded-full px-3 py-1.5 font-medium text-[#6D6485] transition-colors hover:text-[#AC4691] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BBBBFF] disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed ${
        size === 'sm' ? 'text-xs' : 'text-sm'
      }`}
    >
      <LogOut className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} strokeWidth={1.75} />
      {fx('course_actions.leave')}
    </button>
  )
}

/**
 * Confirmation before leaving a free course. `onConfirm` resolves to true when
 * the learner left (the dialog then closes) and false to keep it open.
 */
export function LeaveCourseDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (_open: boolean) => void
  onConfirm: () => Promise<boolean>
}) {
  const { fx } = useFixesT()
  const [pending, setPending] = React.useState(false)
  const stayRef = React.useRef<HTMLButtonElement>(null)

  const confirm = async () => {
    if (pending) return
    setPending(true)
    try {
      if (await onConfirm()) onOpenChange(false)
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
        onOpenChange(next)
      }}
    >
      <DialogContent
        className="w-[calc(100vw-32px)] max-w-md rounded-[20px] border-[#EAE8F2] bg-[#FFFCF9] p-6 sm:p-7"
        // Start on the safe choice ("Quedarme"), not on the destructive one.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          stayRef.current?.focus()
        }}
      >
        <DialogHeader className="space-y-2 pe-8 text-start">
          <DialogTitle className="text-xl font-semibold leading-snug text-[#190933]">
            {fx('course_actions.leave_title')}
          </DialogTitle>
          <DialogDescription className="text-[15px] leading-relaxed text-[#41375B]">
            {fx('course_actions.leave_description')}
          </DialogDescription>
          <p className="text-sm text-[#6D6485]">{fx('course_actions.leave_hint')}</p>
        </DialogHeader>
        <DialogFooter className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:space-x-0">
          <button
            type="button"
            onClick={confirm}
            disabled={pending}
            aria-busy={pending}
            className="inline-flex items-center justify-center gap-2 rounded-full border border-[#EAE8F2] bg-white px-5 py-2.5 text-sm font-semibold text-[#AC4691] transition-colors hover:border-[#F0B4DF] hover:bg-[#F9DDF0]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F0B4DF] disabled:opacity-70 cursor-pointer disabled:cursor-wait"
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            {pending ? fx('course_actions.leaving') : fx('course_actions.leave_confirm')}
          </button>
          <button
            type="button"
            ref={stayRef}
            onClick={() => onOpenChange(false)}
            disabled={pending}
            className="inline-flex items-center justify-center rounded-full bg-[#190933] px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#41375B] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7D75E2] focus-visible:ring-offset-2 disabled:opacity-70 cursor-pointer"
          >
            {fx('course_actions.leave_cancel')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

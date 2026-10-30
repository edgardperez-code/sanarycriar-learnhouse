'use client'
// Sanar y Criar: free courses and ebooks need an account with a verified email.
// Shown instead of "Leer ahora / Descargar PDF" (EbookHero) or the start button
// (CoursesActions / CourseActionsMobile) when GET /payments/{org}/access says
// reason "login_required" or "verify_email". See freeAccessGate.ts.
import React from 'react'
import Link from 'next/link'
import { Gift, Mail, UserPlus, LogIn, RefreshCw } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useOrg } from '@components/Contexts/OrgContext'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import { getUriWithOrg } from '@services/config/config'
import { resendVerificationEmail } from '@services/auth/auth'
import { withRedirect } from '@components/Payments/commerce'
import { useCourseAccess } from '@components/Hooks/useCourseAccess'
import { type FreeGateReason, courseUuidFromPath, freeGateReason, rememberReturnPath } from './freeAccessGate'
import { useLearningT } from './useLearningT'

interface FreeAccessCardProps {
  reason: FreeGateReason
  orgslug: string
  /** Course page path, e.g. "/course/<uuid>" (the place to come back to). */
  coursePath: string
  isEbook: boolean
  /** Smaller paddings for the mobile actions box. */
  compact?: boolean
  className?: string
  /** Called once "Ya lo verifiqué" confirms access (e.g. refetch the activity). */
  onAccessGranted?: () => void
}

export default function FreeAccessCard({ reason, orgslug, coursePath, isEbook, compact, className, onAccessGranted }: FreeAccessCardProps) {
  const { lt } = useLearningT()
  const org = useOrg() as any
  const session = useLHSession() as any
  const queryClient = useQueryClient()
  const email: string | undefined = session?.data?.user?.email
  const [resend, setResend] = React.useState<{ state: 'idle' | 'sending' | 'sent' | 'error'; message?: string }>({ state: 'idle' })
  const [checking, setChecking] = React.useState(false)
  const [check, setCheck] = React.useState<'idle' | 'still' | 'error'>('idle')
  // Same query (and cache entry) the page uses for this course.
  const { refetch } = useCourseAccess(courseUuidFromPath(coursePath))

  // The verification link carries no ?redirect: remember this page instead.
  React.useEffect(() => {
    rememberReturnPath(coursePath)
  }, [coursePath])

  const onResend = async () => {
    if (!email) return
    setResend({ state: 'sending' })
    const res = await resendVerificationEmail(email, org?.id)
    if (res.success) setResend({ state: 'sent' })
    // A rate limit (429) gets its own Spanish copy (the API detail is English).
    else setResend({ state: 'error', message: res.status === 429 ? lt('free_gate.resend_rate_limited') : undefined })
  }

  const onVerified = async () => {
    setChecking(true)
    setCheck('idle')
    try {
      // Decide on this course's own fresh answer, not on whatever else is cached.
      const res = await refetch()
      if (res.isError || !res.data) {
        setCheck('error')
        return
      }
      if (freeGateReason(res.data) === 'verify_email') {
        setCheck('still')
        return
      }
      // Verified: refresh the other access queries of the org (actions, hero, ...).
      await queryClient.invalidateQueries({ queryKey: ['payments', org?.id, 'access'] })
      onAccessGranted?.()
    } catch {
      setCheck('error')
    } finally {
      setChecking(false)
    }
  }

  const box = compact ? 'p-3 rounded-[16px]' : 'p-5 rounded-[20px]'
  const primary =
    'inline-flex w-full items-center justify-center gap-2 rounded-full bg-[#190933] px-6 py-3 text-[15px] font-semibold text-[#FDF5EE] transition-colors hover:bg-[#2B1A4F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7D75E2] focus-visible:ring-offset-2 disabled:opacity-70'
  const secondary =
    'inline-flex w-full items-center justify-center gap-2 rounded-full border border-[#BBBBFF] bg-white px-6 py-3 text-[15px] font-semibold text-[#190933] transition-colors hover:border-[#7D75E2] hover:bg-[#EEEDFF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7D75E2] focus-visible:ring-offset-2'

  if (reason === 'login_required') {
    return (
      <div className={`border border-[#BBBBFF]/70 bg-[#EEEDFF] ${box} ${className ?? ''}`}>
        <div className="flex items-center gap-2">
          <Gift className="h-5 w-5 shrink-0 text-[#6559CA]" />
          <h3 className="font-semibold text-[#190933]">
            {isEbook ? lt('free_gate.login_title') : lt('free_gate.login_title_course')}
          </h3>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-[#41375B]">
          {isEbook ? lt('free_gate.login_text') : lt('free_gate.login_text_course')}
        </p>
        <div className={`mt-4 flex flex-col gap-2.5 ${compact ? '' : 'sm:flex-row sm:flex-wrap sm:[&>*]:w-auto'}`}>
          <Link href={getUriWithOrg(orgslug, withRedirect('/signup', coursePath))} prefetch={false} className={primary}>
            <UserPlus size={18} strokeWidth={1.75} />
            {lt('free_gate.signup')}
          </Link>
          <Link href={getUriWithOrg(orgslug, withRedirect('/login', coursePath))} prefetch={false} className={secondary}>
            <LogIn size={18} strokeWidth={1.75} />
            {lt('free_gate.login')}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className={`border border-[#BBBBFF]/70 bg-[#EEEDFF] ${box} ${className ?? ''}`}>
      <div className="flex items-center gap-2">
        <Mail className="h-5 w-5 shrink-0 text-[#6559CA]" />
        <h3 className="font-semibold text-[#190933]">
          {isEbook ? lt('free_gate.verify_title') : lt('free_gate.verify_title_course')}
        </h3>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-[#41375B] break-words [overflow-wrap:anywhere]">
        {email ? lt('free_gate.verify_text', { email }) : lt('free_gate.verify_text_no_email')}
      </p>
      <div className={`mt-4 flex flex-col gap-2.5 ${compact ? '' : 'sm:flex-row sm:flex-wrap sm:[&>*]:w-auto'}`}>
        <button
          type="button"
          onClick={onResend}
          disabled={!email || resend.state === 'sending'}
          className={primary}
        >
          <RefreshCw size={18} strokeWidth={1.75} className={resend.state === 'sending' ? 'animate-spin' : ''} />
          {resend.state === 'sending' ? lt('free_gate.resending') : lt('free_gate.resend')}
        </button>
        <button type="button" onClick={onVerified} disabled={checking} className={secondary}>
          {checking ? lt('free_gate.checking') : lt('free_gate.verified')}
        </button>
      </div>
      <div aria-live="polite">
        {resend.state === 'sent' && (
          <p className="mt-3 text-sm font-medium text-[#4F43A4]">{lt('free_gate.resent')}</p>
        )}
        {resend.state === 'error' && (
          <p className="mt-3 text-sm font-medium text-[#B42318]">{resend.message || lt('free_gate.resend_error')}</p>
        )}
        {check === 'still' && !checking && (
          <p className="mt-3 text-sm text-[#41375B]">{lt('free_gate.still_unverified')}</p>
        )}
        {check === 'error' && !checking && (
          <p className="mt-3 text-sm font-medium text-[#B42318]">{lt('free_gate.check_error')}</p>
        )}
      </div>
    </div>
  )
}

import React, { useState } from 'react'
import { removeCourse, startCourse } from '@services/courses/activity'
import { revalidateTags, asArray } from '@services/utils/ts/requests'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import { getUriWithOrg } from '@services/config/config'
import { getOffersByResource } from '@services/payments/offers'
import { UserPen, ClockIcon, ArrowRight, BookOpen, UserPlus, CheckCircle2, Lock, LogIn } from 'lucide-react'
import { OfferCard } from './OfferCard'
import { applyForContributor } from '@services/courses/courses'
import toast from 'react-hot-toast'
import { useContributorStatus } from '../../../../hooks/useContributorStatus'
import CourseProgress from '../CourseProgress/CourseProgress'
import UserAvatar from '@components/Objects/UserAvatar'
import { useOrg, useOrgMembership } from '@components/Contexts/OrgContext'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query/keys'
import { useTranslation } from 'react-i18next'
import { useLHAnalytics, AnalyticsEvent } from '@services/analytics'
// Sanar y Criar: ownership of paid courses comes from the payments access
// endpoint, not from the TrailRun (see docs/spec-tecnica.md 4.1).
import { useCourseAccess } from '@components/Hooks/useCourseAccess'
import { useScT } from '@components/Payments/useScT'
import { productTypeOfCourse, withRedirect } from '@components/Payments/commerce'
import { PendingPaymentCard } from '@components/Store/Cart/PendingPaymentCard'
// Sanar y Criar: free courses with history get "Continuar" + a confirmed leave.
import {
  LeaveCourseDialog,
  LeaveCourseLink,
  forgetLocalCourseProgress,
  useFreeCourseContinue,
} from '@components/ScFixes/FreeCourseContinue'
import { useFixesT } from '@components/ScFixes/useFixesT'
import { sessionUserKey } from '@components/SanarYCriar/progressLocal'
// Sanar y Criar: free content needs an account with a verified email.
import FreeAccessCard from '@components/SanarYCriar/FreeAccessCard'
import { freeGateReason } from '@components/SanarYCriar/freeAccessGate'

interface CourseRun {
  status: string
  course_id: string
  steps: Array<{
    activity_id: string
    complete: boolean
  }>
}

interface Course {
  id: string
  course_uuid: string
  trail?: {
    runs: CourseRun[]
  }
  chapters?: Array<{
    name: string
    activities: Array<{
      activity_uuid: string
      name: string
      activity_type: string
    }>
  }>
  open_to_contributors?: boolean
}

interface CourseActionsProps {
  courseuuid: string
  orgslug: string
  course: Course & {
    org_id: number
  }
  trailData?: any
}

function CoursesActions({ courseuuid, orgslug, course, trailData }: CourseActionsProps) {
  const { t } = useTranslation()
  const { sc } = useScT()
  const { fx } = useFixesT()
  const router = useRouter()
  const session = useLHSession() as any
  const [isActionLoading, setIsActionLoading] = useState(false)
  const [isContributeLoading, setIsContributeLoading] = useState(false)
  const { contributorStatus, refetch } = useContributorStatus(courseuuid)
  const [isProgressOpen, setIsProgressOpen] = useState(false)
  const [isLeaveOpen, setIsLeaveOpen] = useState(false)
  const org = useOrg() as any
  const { isUserPartOfTheOrg } = useOrgMembership()
  const queryClient = useQueryClient()
  const { track } = useLHAnalytics('learner')

  // Clean up course UUID by removing 'course_' prefix if it exists
  const cleanCourseUuid = course.course_uuid?.replace('course_', '');
  const resourceUuid = cleanCourseUuid ? `course_${cleanCourseUuid}` : null;
  const coursePath = `/course/${cleanCourseUuid ?? courseuuid}`
  const isEbook = productTypeOfCourse(course) === 'ebook'

  const run = trailData?.runs?.find(
    (run: any) => {
      const cleanRunCourseUuid = run.course?.course_uuid?.replace('course_', '');
      return cleanRunCourseUuid === cleanCourseUuid;
    }
  );
  const isStarted = !!run;

  // Public endpoint: no auth needed, works for unauthenticated visitors too
  const { data: offersResult, isLoading } = useQuery({
    queryKey: ['offers', 'by-resource', org?.id, resourceUuid],
    queryFn: () => getOffersByResource(org.id, resourceUuid!),
    enabled: !!org && !!resourceUuid,
    staleTime: 60_000,
  });
  const linkedOffers: any[] = asArray(offersResult);

  // Sanar y Criar: access decides "for sale" and "yours". If the access check
  // is unavailable, fall back to the offers list (and never offer "Leave").
  const { access, isLoading: isAccessLoading } = useCourseAccess(course.course_uuid)
  const forSale = access ? access.for_sale : linkedOffers.length > 0
  const hasAccess = access ? access.has_access : isStarted

  const allActivities = (course.chapters ?? []).flatMap((chapter: any) => chapter.activities ?? [])
  const firstActivity: any = allActivities[0]
  const completedIds = new Set((run?.steps ?? []).filter((s: any) => s.complete !== false).map((s: any) => String(s.activity_id)))
  const nextActivity: any = allActivities.find((a: any) => !completedIds.has(String(a.id))) ?? firstActivity

  const activityHref = (activity: any) =>
    getUriWithOrg(orgslug, '') + `/course/${courseuuid}/activity/${activity.activity_uuid.replace('activity_', '')}`

  // Sanar y Criar: continue point for free courses (saved progress first).
  const freeContinue = useFreeCourseContinue({
    course,
    orgslug,
    trailData,
    fallbackHref: nextActivity ? activityHref(nextActivity) : null,
  })

  const handleContinue = async () => {
    const href = freeContinue.href
    if (!href) return
    if (!isStarted) {
      // Saved progress without a TrailRun (opened from a direct link): start
      // the course as well, so it shows up in the learner's trail.
      setIsActionLoading(true)
      try {
        await startCourse('course_' + courseuuid, orgslug, session.data?.tokens?.access_token)
        if (org?.id) queryClient.invalidateQueries({ queryKey: queryKeys.trail.org(org.id) })
      } catch {
        // Best effort: the trail is a convenience, the lesson still opens.
      } finally {
        setIsActionLoading(false)
      }
    }
    router.push(href)
  }

  // Resolves true when the learner left (closes the confirmation dialog).
  const handleLeaveCourse = async (): Promise<boolean> => {
    try {
      await removeCourse('course_' + courseuuid, orgslug, session.data?.tokens?.access_token)
    } catch {
      toast.error(fx('course_actions.leave_error'))
      return false
    }
    forgetLocalCourseProgress(sessionUserKey(session), course)
    if (org?.id) queryClient.invalidateQueries({ queryKey: queryKeys.trail.org(org.id) })
    // The server deleted the saved positions too (progress.course / .activity).
    queryClient.invalidateQueries({ queryKey: ['progress'] })
    track(AnalyticsEvent.CourseLeft, { course_uuid: cleanCourseUuid })
    toast.success(fx('course_actions.leave_success'))
    return true
  }

  const handleCourseAction = async () => {
    if (!session.data?.user) {
      track(AnalyticsEvent.CourseSignupPrompted, {
        reason: 'unauthenticated',
        intended_action: isStarted ? 'leave_course' : 'start_course',
      })
      router.push(getUriWithOrg(orgslug, withRedirect('/signup', coursePath)))
      return
    }

    // Check if user is part of the organization
    if (!isUserPartOfTheOrg) {
      router.push(getUriWithOrg(orgslug, withRedirect('/signup', coursePath)))
      return
    }

    setIsActionLoading(true)
    const loadingToast = toast.loading(
      isStarted ? t('courses.leave_course') + '...' : t('courses.start_course') + '...'
    )

    try {
      if (isStarted) {
        await removeCourse('course_' + courseuuid, orgslug, session.data?.tokens?.access_token)
        if (org?.id) queryClient.invalidateQueries({ queryKey: queryKeys.trail.org(org.id) })
        track(AnalyticsEvent.CourseLeft, { course_uuid: cleanCourseUuid })
        toast.success(t('courses.leave_course_success'), { id: loadingToast })
      } else {
        await startCourse('course_' + courseuuid, orgslug, session.data?.tokens?.access_token)
        if (org?.id) queryClient.invalidateQueries({ queryKey: queryKeys.trail.org(org.id) })
        track(AnalyticsEvent.CourseStarted, {
          course_uuid: cleanCourseUuid,
          total_activities: course.chapters?.reduce((acc: number, chapter: any) => acc + chapter.activities.length, 0) || 0,
          has_offers: linkedOffers.length > 0,
        })
        toast.success(t('courses.start_course_success'), { id: loadingToast })

        if (firstActivity) {
          // Redirect to the first activity
          router.push(activityHref(firstActivity))
        }
      }
    } catch (error) {
      console.error('Failed to perform course action:', error)
      toast.error(
        isStarted
          ? t('courses.leave_course_error')
          : t('courses.start_course_error'),
        { id: loadingToast }
      )
    } finally {
      setIsActionLoading(false)
    }
  }

  // Sanar y Criar: the owner of a paid course can only start or continue it.
  // "Leave course" would wipe their progress (remove_course_from_trail).
  const handleOwnedAction = async () => {
    if (isStarted) {
      if (nextActivity) router.push(activityHref(nextActivity))
      return
    }
    setIsActionLoading(true)
    try {
      await startCourse('course_' + courseuuid, orgslug, session.data?.tokens?.access_token)
      if (org?.id) queryClient.invalidateQueries({ queryKey: queryKeys.trail.org(org.id) })
      track(AnalyticsEvent.CourseStarted, {
        course_uuid: cleanCourseUuid,
        total_activities: allActivities.length,
        has_offers: true,
      })
      if (firstActivity) router.push(activityHref(firstActivity))
    } catch (error) {
      console.error('Failed to start owned course:', error)
      // The trail is a convenience: still let the owner in.
      if (firstActivity) router.push(activityHref(firstActivity))
      else toast.error(t('courses.start_course_error'))
    } finally {
      setIsActionLoading(false)
    }
  }

  const handleApplyToContribute = async () => {
    if (!session.data?.user) {
      router.push(getUriWithOrg(orgslug, withRedirect('/signup', coursePath)))
      return
    }

    setIsContributeLoading(true)
    const loadingToast = toast.loading(t('courses.submitting_contributor_application'))

    try {
      const data = {
        message: "I would like to contribute to this course."
      }

      await applyForContributor('course_' + courseuuid, data, session.data?.tokens?.access_token)
      await revalidateTags(['courses'], orgslug)
      await refetch()
      track(AnalyticsEvent.ContributorApplicationSubmitted, { course_uuid: cleanCourseUuid })
      toast.success(t('courses.contributor_application_success'), { id: loadingToast })
    } catch (error) {
      console.error('Failed to apply as contributor:', error)
      toast.error(t('courses.contributor_application_error'), { id: loadingToast })
    } finally {
      setIsContributeLoading(false)
    }
  }

  const renderActionButton = (action: 'start' | 'leave') => {
    if (!session.data?.user) {
      return (
        <>
          <UserAvatar width={24} predefined_avatar="empty" rounded="rounded-full" border="border-2" borderColor="border-white" />
          <span>{action === 'start' ? t('courses.start_course') : t('courses.leave_course')}</span>
          <ArrowRight className="w-5 h-5" />
        </>
      );
    }

    return (
      <>
        <UserAvatar
          width={24}
          use_with_session={true}
          rounded="rounded-full"
          border="border-2"
          borderColor="border-white"
        />
        <span>{action === 'start' ? t('courses.start_course') : t('courses.leave_course')}</span>
        <ArrowRight className="w-5 h-5" />
      </>
    );
  };

  const renderContributorButton = () => {
    if (contributorStatus === 'INACTIVE' || course.open_to_contributors !== true) {
      return null;
    }

    if (!session.data?.user) {
      return (
        <button
          onClick={() => router.push(getUriWithOrg(orgslug, withRedirect('/signup', coursePath)))}
          aria-label={t('auth.sign_up_to_contribute')}
          className="w-full bg-white text-neutral-700 border border-neutral-200 py-3 rounded-lg nice-shadow font-semibold hover:bg-neutral-50 transition-colors flex items-center justify-center gap-2 mt-3 cursor-pointer"
        >
          <UserPen className="w-5 h-5" />
          {t('auth.authenticate_to_contribute')}
        </button>
      );
    }

    if (contributorStatus === 'ACTIVE') {
      return (
        <div className="w-full bg-green-50 text-green-700 border border-green-200 py-3 rounded-lg nice-shadow font-semibold flex items-center justify-center gap-2 mt-3">
          <UserPen className="w-5 h-5" />
          {t('courses.you_are_contributor')}
        </div>
      );
    }

    if (contributorStatus === 'PENDING') {
      return (
        <div className="w-full bg-amber-50 text-amber-700 border border-amber-200 py-3 rounded-lg nice-shadow font-semibold flex items-center justify-center gap-2 mt-3">
          <ClockIcon className="w-5 h-5" />
          {t('courses.contributor_application_pending')}
        </div>
      );
    }

    return (
      <button
        onClick={handleApplyToContribute}
        disabled={isContributeLoading}
        aria-label={t('courses.apply_to_contribute')}
        className="w-full bg-white text-neutral-700 py-3 rounded-lg nice-shadow font-semibold hover:bg-neutral-50 transition-colors flex items-center justify-center gap-2 mt-3 cursor-pointer disabled:cursor-not-allowed"
      >
        {isContributeLoading ? (
          <div className="w-5 h-5 border-2 border-neutral-700 border-t-transparent rounded-full animate-spin" />
        ) : (
          <>
            <UserPen className="w-5 h-5" />
            {t('courses.apply_to_contribute')}
          </>
        )}
      </button>
    );
  };

  const renderProgressSection = () => {
    const totalActivities = course.chapters?.reduce((acc: number, chapter: any) => acc + chapter.activities.length, 0) || 0;

    const completedActivities = run?.steps?.filter((step: any) => step.complete)?.length || 0;
    const progressPercentage = totalActivities > 0 ? Math.round((completedActivities / totalActivities) * 100) : 0;

    if (!isStarted) {
      return (
        <div className="relative bg-white nice-shadow rounded-lg overflow-hidden">
          <div
            className="absolute inset-0 opacity-[0.05]"
            style={{
              backgroundImage: 'radial-gradient(circle at center, #101010 1px, transparent 1px)',
              backgroundSize: '12px 12px'
            }}
          />
          <div className="relative p-4">
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-4">
                  <div className="relative w-16 h-16">
                    <svg className="w-full h-full transform -rotate-90">
                      <circle
                        cx="32"
                        cy="32"
                        r="28"
                        stroke="#EEEDFF"
                        strokeWidth="6"
                        fill="none"
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <BookOpen className="w-6 h-6 text-neutral-400" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-medium text-gray-900">{t('courses.ready_to_begin')}</div>
                    <div className="text-sm text-gray-500">
                      {t('courses.start_learning_journey', { count: totalActivities })}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return (
        <div className="relative bg-white nice-shadow rounded-lg overflow-hidden">
          <div
          className="absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage: 'radial-gradient(circle at center, #000 1px, transparent 1px)',
            backgroundSize: '24px 24px'
          }}
        />
        <div className="relative p-4">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <div className="flex items-center gap-4">
                <div className="relative w-16 h-16">
                  <svg className="w-full h-full transform -rotate-90">
                    <circle
                      cx="32"
                      cy="32"
                      r="28"
                      stroke="#EEEDFF"
                      strokeWidth="6"
                      fill="none"
                    />
                    <circle
                      cx="32"
                      cy="32"
                      r="28"
                      // Sanar y Criar: brand lavanda-600 (was emerald #10b981).
                      stroke="#6559CA"
                      strokeWidth="6"
                      fill="none"
                      strokeLinecap="round"
                      strokeDasharray={2 * Math.PI * 28}
                      strokeDashoffset={2 * Math.PI * 28 * (1 - (totalActivities > 0 ? completedActivities / totalActivities : 0))}
                      className="transition-all duration-500 ease-out"
                    />
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-lg font-bold text-gray-800">
                      {progressPercentage}%
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => {
                    track(AnalyticsEvent.CourseProgressViewed, {
                      course_uuid: cleanCourseUuid,
                      completed_activities: completedActivities,
                      total_activities: totalActivities,
                      progress_percentage: progressPercentage,
                    })
                    setIsProgressOpen(true)
                  }}
                  aria-label={t('courses.view_course_progress', { completed: completedActivities, total: totalActivities })}
                  className="flex-1 text-start hover:bg-neutral-50/50 p-2 rounded-lg transition-colors"
                >
                  <div className="text-sm font-medium text-gray-900">{t('courses.course_progress')}</div>
                  <div className="text-sm text-gray-500">
                    {t('courses.completed_of', { completed: completedActivities, total: totalActivities })}
                  </div>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  if (isLoading || isAccessLoading) {
    return <div className="animate-pulse h-20 bg-gray-100 rounded-lg nice-shadow" />
  }

  // Sanar y Criar: paid course the viewer already owns (or can manage).
  if (forSale && hasAccess) {
    const ownedTitle =
      access?.reason === 'admin' || access?.reason === 'author'
        ? sc('course_actions.staff_access_title')
        : isEbook ? sc('course_actions.owned_ebook_title') : sc('course_actions.owned_course_title')
    const ownedDescription =
      access?.reason === 'admin' || access?.reason === 'author'
        ? sc('course_actions.staff_access_description')
        : isEbook ? sc('course_actions.owned_ebook_description') : sc('course_actions.owned_course_description')
    const actionLabel = isEbook
      ? sc('course_actions.read_now')
      : isStarted ? sc('course_actions.continue') : sc('course_actions.start')

    return (
      <div className="bg-white nice-shadow rounded-lg overflow-hidden p-4">
        <div className="space-y-4">
          <div className="p-4 bg-[#EEEDFF] rounded-[20px]">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="w-5 h-5 text-[#6559CA] shrink-0" />
              <h3 className="text-[#190933] font-semibold">{ownedTitle}</h3>
            </div>
            <p className="text-[#584F72] text-sm mt-1">{ownedDescription}</p>
          </div>
          {!isEbook && isStarted && renderProgressSection()}
          {firstActivity && (
            <button
              onClick={handleOwnedAction}
              disabled={isActionLoading}
              aria-label={actionLabel}
              className="w-full py-3 rounded-full nice-shadow font-semibold transition-colors flex items-center justify-center gap-2 cursor-pointer bg-[#190933] text-white hover:bg-[#41375B] disabled:opacity-70"
            >
              {isActionLoading ? (
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <span>{actionLabel}</span>
                  <ArrowRight className="w-5 h-5" />
                </>
              )}
            </button>
          )}
          {renderContributorButton()}
          {!isEbook && (
            <CourseProgress
              course={course}
              orgslug={orgslug}
              isOpen={isProgressOpen}
              onClose={() => setIsProgressOpen(false)}
              trailData={trailData}
            />
          )}
        </div>
      </div>
    )
  }

  // Sanar y Criar: paid course the viewer does not own yet: offers to buy it.
  if (forSale) {
    const loginHref = getUriWithOrg(orgslug, withRedirect('/login', coursePath))
    // Sanar y Criar: a payment under review is shown instead of the offers,
    // so the buyer is not charged twice while PayPal confirms the first one.
    // A Pago Móvil order also names its code and links to it.
    if (access?.payment_pending) {
      return (
        <div className="space-y-3">
          <PendingPaymentCard access={access} orgslug={orgslug} />
        </div>
      )
    }
    return (
      <div className="space-y-3">
        {linkedOffers.length > 1 && (
          <p className="text-xs text-gray-400 font-medium px-1">
            {sc('course_actions.options_available', { count: linkedOffers.length })}
          </p>
        )}
        {linkedOffers.map((offer: any) => (
          <OfferCard key={offer.offer_uuid ?? offer.offer_id} offer={offer} orgslug={orgslug} />
        ))}
        {linkedOffers.length === 0 && (
          <div className="p-4 bg-white nice-shadow rounded-[20px] space-y-2">
            <div className="flex items-center gap-2">
              <Lock className="w-4 h-4 text-[#6559CA]" />
              <h3 className="text-[#190933] font-semibold text-sm">
                {isEbook ? sc('course_actions.paid_ebook_title') : sc('course_actions.paid_course_title')}
              </h3>
            </div>
            <Link href={getUriWithOrg(orgslug, '/store')} className="text-sm text-[#4F43A4] underline">
              {sc('course_actions.see_store')}
            </Link>
          </div>
        )}
        {!session.data?.user && (
          <p className="text-xs text-[#584F72] px-1 flex items-center gap-1.5">
            <LogIn className="w-3.5 h-3.5" />
            <span>{sc('course_actions.already_bought')}</span>{' '}
            <Link href={loginHref} className="font-semibold text-[#4F43A4] underline">
              {sc('course_actions.login')}
            </Link>
          </p>
        )}
        {renderContributorButton()}
      </div>
    )
  }

  // Sanar y Criar: free course behind sign-up / email verification.
  const freeGate = freeGateReason(access)
  if (freeGate) {
    return (
      <div className="space-y-3">
        <FreeAccessCard reason={freeGate} orgslug={orgslug} coursePath={coursePath} isEbook={isEbook} compact />
        {renderContributorButton()}
      </div>
    )
  }

  // Show join organization prompt for authenticated users who are not part of the org
  if (session.data?.user && !isUserPartOfTheOrg) {
    return (
      <div className="bg-white shadow-md shadow-gray-300/25 outline outline-1 outline-neutral-200/40 rounded-lg overflow-hidden p-4">
        <div className="space-y-4">
          <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg nice-shadow">
            <div className="flex items-center gap-3">
              <UserPlus className="w-5 h-5 text-amber-800" />
              <h3 className="text-amber-800 font-semibold">{t('courses.join_org_required')}</h3>
            </div>
            <p className="text-amber-700 text-sm mt-1">
              {t('courses.join_org_required_description')}
            </p>
          </div>
          <a
            href={getUriWithOrg(orgslug, withRedirect('/signup', coursePath))}
            className="w-full bg-neutral-900 text-white py-3 rounded-lg nice-shadow font-semibold hover:bg-neutral-800 transition-colors flex items-center justify-center gap-2"
          >
            <UserPlus className="w-5 h-5" />
            {t('courses.join_organization')}
          </a>
        </div>
      </div>
    )
  }

  // Sanar y Criar: free course with history (TrailRun or saved progress):
  // "Continuar" to the exact point; leaving is secondary and confirmed.
  if (session.data?.user && (isStarted || freeContinue.hasProgress)) {
    return (
      <div className="bg-white shadow-md shadow-gray-300/25 outline outline-1 outline-neutral-200/40 rounded-lg overflow-hidden p-4">
        <div className="space-y-4">
          {isStarted && renderProgressSection()}
          {freeContinue.href && (
            <button
              onClick={handleContinue}
              disabled={isActionLoading}
              aria-label={fx('course_actions.continue')}
              className="w-full py-3 rounded-full nice-shadow font-semibold transition-colors flex items-center justify-center gap-2 cursor-pointer bg-[#190933] text-white hover:bg-[#41375B] disabled:opacity-70"
            >
              {isActionLoading ? (
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <span>{fx('course_actions.continue')}</span>
                  <ArrowRight className="w-5 h-5" />
                </>
              )}
            </button>
          )}
          {isStarted && (
            <LeaveCourseLink onClick={() => setIsLeaveOpen(true)} disabled={isActionLoading} />
          )}
          {renderContributorButton()}
          <CourseProgress
            course={course}
            orgslug={orgslug}
            isOpen={isProgressOpen}
            onClose={() => setIsProgressOpen(false)}
            trailData={trailData}
          />
        </div>
        <LeaveCourseDialog open={isLeaveOpen} onOpenChange={setIsLeaveOpen} onConfirm={handleLeaveCourse} />
      </div>
    )
  }

  // Free course: upstream behaviour.
  return (
    <div className="bg-white shadow-md shadow-gray-300/25 outline outline-1 outline-neutral-200/40 rounded-lg overflow-hidden p-4">
      <div className="space-y-4">
        {/* Progress Section */}
        {renderProgressSection()}

        {/* Start/Leave Course Button */}
        <button
          onClick={handleCourseAction}
          disabled={isActionLoading}
          aria-label={isStarted ? t('courses.leave_course') : t('courses.start_course')}
          className={`w-full py-3 rounded-lg nice-shadow font-semibold transition-colors flex items-center justify-center gap-2 cursor-pointer ${
            isStarted
              ? 'bg-red-500 text-white hover:bg-red-600 disabled:bg-red-400'
              : 'bg-neutral-900 text-white hover:bg-neutral-800 disabled:bg-neutral-700'
          }`}
        >
          {isActionLoading ? (
            <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : (
            renderActionButton(isStarted ? 'leave' : 'start')
          )}
        </button>

        {/* Contributor Button */}
        {renderContributorButton()}

        {/* Course Progress Modal */}
        <CourseProgress
          course={course}
          orgslug={orgslug}
          isOpen={isProgressOpen}
          onClose={() => setIsProgressOpen(false)}
          trailData={trailData}
        />
      </div>
    </div>
  )
}

export default CoursesActions

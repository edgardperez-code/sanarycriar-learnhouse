'use client'

// Sanar y Criar: "Continuar donde lo dejaste" card on the course page. Points
// at the exact moment of the last video (`?t=`), the last PDF page
// (`?page=`), or at the next activity once the last one is finished.
import React from 'react'
import Link from 'next/link'
import { ArrowRight, FileText, Play, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { getUriWithOrg } from '@services/config/config'
import { useCourseProgress } from '@/hooks/queries/useCourseProgress'
import type { CourseProgress } from '@services/courses/progress'
import {
  cleanActivityUuid,
  cleanCourseUuid,
  completedActivityIds,
  flattenCourseActivities,
  formatClock,
  isNearEnd,
  isResumablePosition,
  progressRatio,
  type FlatActivity,
} from './progressLocal'
import './sc-learning.css'

export type ContinueMode = 'resume' | 'next' | 'review'

export interface ContinueTarget {
  mode: ContinueMode
  entry: FlatActivity
  href: string
  position: number | null
  duration: number | null
  page: number | null
}

export function activityHref(orgslug: string, courseUuid: string, activityUuid: string, query = '') {
  return (
    getUriWithOrg(orgslug, '') +
    `/course/${cleanCourseUuid(courseUuid)}/activity/${cleanActivityUuid(activityUuid)}${query}`
  )
}

/** Where "continue" should take the learner, or null when there is no history. */
export function resolveContinueTarget(
  course: any,
  progress: CourseProgress | undefined,
  trailData: any,
  orgslug: string
): ContinueTarget | null {
  const last = progress?.last
  if (!course || !last?.activity_uuid) return null
  const flat = flattenCourseActivities(course)
  const idx = flat.findIndex((f) => f.cleanUuid === cleanActivityUuid(last.activity_uuid))
  if (idx < 0) return null
  const entry = flat[idx]
  const isVideo = entry.activity?.activity_type === 'TYPE_VIDEO'
  const position = Number(last.position_seconds) || 0
  const duration = last.duration_seconds ? Number(last.duration_seconds) : null
  const done =
    !!last.completed ||
    completedActivityIds(trailData, course.course_uuid).has(entry.activity?.id) ||
    (isVideo && isNearEnd(position, duration))

  if (!done) {
    let query = ''
    if (isVideo && isResumablePosition(position, duration)) query = `?t=${Math.floor(position)}`
    else if (!isVideo && last.page && last.page > 1) query = `?page=${last.page}`
    return {
      mode: 'resume',
      entry,
      href: activityHref(orgslug, course.course_uuid, entry.cleanUuid, query),
      position: isVideo ? position : null,
      duration: isVideo ? duration : null,
      page: !isVideo ? last.page ?? null : null,
    }
  }

  const next = flat[idx + 1]
  if (next) {
    return {
      mode: 'next',
      entry: next,
      href: activityHref(orgslug, course.course_uuid, next.cleanUuid),
      position: null,
      duration: null,
      page: null,
    }
  }
  return {
    mode: 'review',
    entry,
    href: activityHref(orgslug, course.course_uuid, entry.cleanUuid),
    position: null,
    duration: null,
    page: null,
  }
}

export default function ContinueLearningCard({
  course,
  orgslug,
  trailData,
}: {
  course: any
  orgslug: string
  trailData?: any
}) {
  const { t } = useTranslation()
  const { data: progress } = useCourseProgress(course?.course_uuid)
  const target = React.useMemo(
    () => resolveContinueTarget(course, progress, trailData, orgslug),
    [course, progress, trailData, orgslug]
  )
  if (!target) return null

  const { mode, entry } = target
  const isVideo = entry.activity?.activity_type === 'TYPE_VIDEO'
  const ratio = mode === 'resume' ? progressRatio(target.position, target.duration) : null
  const eyebrow =
    mode === 'resume'
      ? t('sc_learning.continue.eyebrow', 'Continuar donde lo dejaste')
      : mode === 'next'
        ? t('sc_learning.continue.next_eyebrow', 'Sigue con la próxima lección')
        : t('sc_learning.continue.review_eyebrow', 'Terminaste la última lección')
  const button =
    mode === 'resume'
      ? t('sc_learning.continue.button', 'Continuar')
      : mode === 'next'
        ? t('sc_learning.continue.next_button', 'Empezar lección')
        : t('sc_learning.continue.review_button', 'Ver de nuevo')
  const Icon = mode === 'review' ? RotateCcw : isVideo ? Play : FileText

  let detail: string | null = null
  if (mode === 'resume' && isVideo && target.position && target.position >= 1) {
    detail = target.duration
      ? t('sc_learning.continue.position', 'Vas en {{time}} de {{total}}', {
          time: formatClock(target.position),
          total: formatClock(target.duration),
        })
      : t('sc_learning.continue.position_no_total', 'Vas en {{time}}', { time: formatClock(target.position) })
  } else if (mode === 'resume' && target.page && target.page > 1) {
    detail = t('sc_learning.continue.page', 'Página {{page}}', { page: target.page })
  }

  return (
    <section
      aria-label={eyebrow}
      className="flex flex-col gap-4 rounded-[20px] border border-[#EAE8F2] bg-[#FFFCF9] p-5 sm:flex-row sm:items-center sm:gap-5 sm:p-6"
    >
      <div className="hidden size-12 shrink-0 place-items-center rounded-full bg-[#EEEDFF] text-[#6559CA] sm:grid">
        <Icon size={20} strokeWidth={1.75} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[#AC4691]">{eyebrow}</p>
        <h3 className="sc-display mt-1 line-clamp-2 text-xl font-semibold leading-snug text-[#190933] sm:text-2xl" dir="auto">
          {entry.activity?.name}
        </h3>
        <p className="mt-1 truncate text-sm text-[#6D6485]" dir="auto">
          {t('sc_learning.continue.chapter', 'Capítulo {{number}} · {{name}}', {
            number: entry.chapterIndex + 1,
            name: entry.chapter?.name || '',
          })}
        </p>
        {(ratio != null || detail) && (
          <div className="mt-3 flex items-center gap-3">
            {ratio != null && (
              <div
                className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#EEEDFF]"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(ratio * 100)}
                aria-label={t('sc_learning.continue.progress_label', '{{percent}}% visto', {
                  percent: Math.round(ratio * 100),
                })}
              >
                <div className="h-full rounded-full bg-[#7D75E2]" style={{ width: `${Math.max(2, ratio * 100)}%` }} />
              </div>
            )}
            {detail && <span className="shrink-0 text-xs font-medium tabular-nums text-[#584F72]">{detail}</span>}
          </div>
        )}
      </div>
      <Link
        href={target.href}
        prefetch={false}
        className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full bg-[#190933] px-6 py-3 text-[15px] font-semibold text-[#FDF5EE] transition-colors hover:bg-[#2B1A4F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7D75E2] focus-visible:ring-offset-2"
      >
        {button}
        <ArrowRight size={16} strokeWidth={2} className="rtl:rotate-180" />
      </Link>
    </section>
  )
}

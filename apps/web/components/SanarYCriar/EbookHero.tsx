'use client'

// Sanar y Criar: course page in ebook mode (course.extra_metadata.product_type
// === 'ebook'): big cover, description and "Leer ahora" / "Descargar PDF",
// which open the course's PDF activity. The purchase area stays with
// CoursesActions (see EbookActionsGate); this component only shows the
// reading buttons once the visitor can open the PDF.
import React from 'react'
import Link from 'next/link'
import { BookOpen, Download, ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { getCourseThumbnailMediaDirectory } from '@services/media/media'
import { useCourseProgress } from '@/hooks/queries/useCourseProgress'
import { useCourseAccess } from '@components/Hooks/useCourseAccess'
import useAdminStatus from '@components/Hooks/useAdminStatus'
import { activityHref } from './ContinueLearningCard'
import { cleanActivityUuid, flattenCourseActivities, isEbookCourse } from './progressLocal'
import './sc-learning.css'

/** The ebook's PDF activity (first PDF document, else first document). */
export function findEbookPdf(course: any): any | null {
  const flat = flattenCourseActivities(course)
  return (
    flat.find((f) => f.activity?.activity_sub_type === 'SUBTYPE_DOCUMENT_PDF')?.activity ??
    flat.find((f) => f.activity?.activity_type === 'TYPE_DOCUMENT')?.activity ??
    null
  )
}

export interface EbookAccess {
  pdf: any | null
  hasAccess: boolean
  /** The answer is not known yet (session or access check pending). */
  loading: boolean
  /** Org admin or course author: sees setup hints. */
  isStaff: boolean
}

/**
 * Whether this visitor can open the ebook. `GET /payments/{org}/access` is the
 * source of truth (free, purchased, admin, author). If that check fails, fall
 * back to the course tree, where the API replaces paid content with
 * `{paid_access: false}` for visitors who haven't bought it.
 */
export function useEbookAccess(course: any): EbookAccess {
  const isEbook = isEbookCourse(course)
  const { access, isLoading, isError } = useCourseAccess(isEbook ? course?.course_uuid : null)
  const pdf = isEbook ? findEbookPdf(course) : null
  if (!isEbook) return { pdf: null, hasAccess: false, loading: false, isStaff: false }
  if (access) {
    const isStaff = access.reason === 'admin' || access.reason === 'author'
    return { pdf, hasAccess: access.has_access, loading: false, isStaff }
  }
  if (isError) {
    const hasAccess = !!pdf && pdf.content?.paid_access !== false && !pdf.is_locked
    return { pdf, hasAccess, loading: false, isStaff: false }
  }
  return { pdf, hasAccess: false, loading: isLoading, isStaff: false }
}

/**
 * Renders the purchase / sign-up area (children) on an ebook page only for
 * visitors who can't read it yet; readers get the buttons in EbookHero.
 * Courses always render the children.
 */
export function EbookActionsGate({ course, children }: { course: any; children: React.ReactNode }) {
  const { hasAccess, loading } = useEbookAccess(course)
  if (!isEbookCourse(course)) return <>{children}</>
  // While loading, CoursesActions shows its own placeholder.
  if (loading || !hasAccess) return <>{children}</>
  return null
}

export default function EbookHero({
  course,
  orgslug,
  orgUuid,
}: {
  course: any
  orgslug: string
  orgUuid?: string
}) {
  const { t } = useTranslation()
  const { pdf, hasAccess, loading, isStaff: isCourseStaff } = useEbookAccess(course)
  // Dashboard users see how to fix a missing PDF (free ebooks report no role).
  const { isAdmin } = useAdminStatus()
  const isStaff = isCourseStaff || isAdmin === true
  const { data: progress } = useCourseProgress(course?.course_uuid, { enabled: hasAccess })

  const savedPage = React.useMemo(() => {
    if (!pdf) return null
    const item = progress?.items?.find((i) => cleanActivityUuid(i.activity_uuid) === cleanActivityUuid(pdf.activity_uuid))
    return item?.page && item.page > 1 ? item.page : null
  }, [progress, pdf])

  const coverUrl = course?.thumbnail_image && orgUuid
    ? getCourseThumbnailMediaDirectory(orgUuid, course.course_uuid, course.thumbnail_image)
    : null
  const readHref = pdf ? activityHref(orgslug, course.course_uuid, pdf.activity_uuid, savedPage ? `?page=${savedPage}` : '') : null
  const downloadHref = pdf ? activityHref(orgslug, course.course_uuid, pdf.activity_uuid, '?download=1') : null

  return (
    <section className="overflow-hidden rounded-[20px] border border-[#EAE8F2] bg-[#FFFCF9]">
      <div className="grid items-center gap-6 p-5 sm:p-8 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:gap-10">
        <div className="mx-auto w-full max-w-[300px]">
          <div className="relative aspect-[3/4] w-full overflow-hidden rounded-[16px] bg-[#EEEDFF] ring-1 ring-[#BBBBFF]/60">
            {coverUrl ? (
              <img
                src={coverUrl}
                alt={t('sc_learning.ebook.cover_alt', 'Portada de {{name}}', { name: course?.name || '' })}
                fetchPriority="high"
                className="absolute inset-0 h-full w-full object-contain"
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center text-[#6559CA]">
                <BookOpen size={56} strokeWidth={1.5} />
              </div>
            )}
          </div>
        </div>

        <div className="min-w-0">
          <p className="text-[13px] font-semibold uppercase tracking-[0.18em] text-[#AC4691]">
            {t('sc_learning.ebook.eyebrow', 'Ebook en PDF')}
          </p>
          {course?.description && (
            <p className="sc-display mt-3 text-2xl font-semibold leading-snug text-[#190933] sm:text-[28px]" dir="auto">
              {course.description}
            </p>
          )}
          <p className="mt-3 text-[15px] leading-relaxed text-[#584F72]">
            {t('sc_learning.ebook.format', 'Léelo aquí mismo, desde tu teléfono o computadora, o descárgalo para tenerlo siempre contigo.')}
          </p>

          {loading ? (
            <div className="mt-6 flex flex-col gap-3 sm:flex-row" aria-hidden="true">
              <div className="h-12 w-full animate-pulse rounded-full bg-[#EEEDFF] sm:w-44" />
              <div className="h-12 w-full animate-pulse rounded-full bg-[#EEEDFF] sm:w-44" />
            </div>
          ) : hasAccess && readHref && downloadHref ? (
            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <Link
                href={readHref}
                prefetch={false}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-[#190933] px-7 py-3 text-base font-semibold text-[#FDF5EE] transition-colors hover:bg-[#2B1A4F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7D75E2] focus-visible:ring-offset-2"
              >
                <BookOpen size={18} strokeWidth={1.75} />
                {savedPage
                  ? t('sc_learning.ebook.continue_reading', 'Seguir leyendo (pág. {{page}})', { page: savedPage })
                  : t('sc_learning.ebook.read_now', 'Leer ahora')}
                <ArrowRight size={16} strokeWidth={2} className="rtl:rotate-180" />
              </Link>
              <Link
                href={downloadHref}
                prefetch={false}
                className="inline-flex items-center justify-center gap-2 rounded-full border border-[#BBBBFF] bg-white px-7 py-3 text-base font-semibold text-[#190933] transition-colors hover:border-[#7D75E2] hover:bg-[#EEEDFF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7D75E2] focus-visible:ring-offset-2"
              >
                <Download size={18} strokeWidth={1.75} />
                {t('sc_learning.ebook.download', 'Descargar PDF')}
              </Link>
            </div>
          ) : pdf ? (
            <p className="mt-6 rounded-[12px] bg-[#EEEDFF] px-4 py-3 text-sm leading-relaxed text-[#41375B]">
              {t('sc_learning.ebook.locked_hint', 'Cuando sea tuyo, podrás leerlo aquí mismo y descargarlo en PDF.')}
            </p>
          ) : (
            <p className="mt-6 rounded-[12px] bg-[#F9DDF0] px-4 py-3 text-sm leading-relaxed text-[#41375B]">
              {isStaff
                ? t('sc_learning.ebook.no_pdf_staff', 'Este ebook todavía no tiene su PDF. Agrégalo como actividad de documento PDF desde el panel del curso.')
                : t('sc_learning.ebook.no_pdf', 'Este ebook estará disponible muy pronto.')}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

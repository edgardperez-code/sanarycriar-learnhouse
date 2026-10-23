'use client'

import React from 'react'
import GeneralWrapperStyled from '@components/Objects/StyledElements/Wrappers/GeneralWrapper'
import CourseThumbnail from '@components/Objects/Thumbnails/CourseThumbnail'
import AuthenticatedClientElement from '@components/Security/AuthenticatedClientElement'
import NewCourseButton from '@components/Objects/StyledElements/Buttons/NewCourseButton'
import ContentPlaceHolderIfUserIsNotAdmin from '@components/Objects/ContentPlaceHolder'
import Link from 'next/link'
import { getUriWithOrg } from '@services/config/config'
import { useTranslation } from 'react-i18next'
import { BookOpen, CirclePlay } from 'lucide-react'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import { useOrg } from '@components/Contexts/OrgContext'
import { SC_PROFESSIONAL } from '@components/Objects/Menus/scBrand'

interface LandingClassicProps {
  courses: any[]
  orgslug: string
  org_id: string | number
}

// Sanar y Criar: the platform home is a short brand intro (eyebrow, Playfair
// title with one italic word, plain promise) followed by the catalog split
// into video courses and ebooks, like the marketing site's /cursos page.
function LandingClassic({ courses, orgslug, org_id }: LandingClassicProps) {
  const { t } = useTranslation()
  const session = useLHSession() as any
  const org = useOrg() as any
  const isAuthenticated = session?.status === 'authenticated'
  const storeEnabled = org?.config?.config?.resolved_features?.payments?.enabled === true

  // Limit to 12 courses (4x3 grid) for the home page
  const displayedCourses = courses.slice(0, 12)
  const hasMoreCourses = courses.length > 12
  const isEbook = (course: any) => course?.extra_metadata?.product_type === 'ebook'
  const videoCourses = displayedCourses.filter((course) => !isEbook(course))
  const ebooks = displayedCourses.filter(isEbook)

  const sections = [
    { key: 'courses', title: t('sc_brand.home.courses_title', { defaultValue: 'Cursos en video' }), items: videoCourses },
    { key: 'ebooks', title: t('sc_brand.home.ebooks_title', { defaultValue: 'Ebooks' }), items: ebooks },
  ].filter((section) => section.items.length > 0)

  return (
    <div className="w-full">
      <section className="sc-watercolor sc-watercolor-fade">
        <GeneralWrapperStyled>
          <div className="flex flex-col gap-6 pt-4 pb-2 md:flex-row md:items-end md:justify-between md:pt-8">
            <div className="max-w-3xl tracking-normal">
              <p className="sc-eyebrow">{t('sc_brand.home.eyebrow', { defaultValue: 'Cursos y ebooks' })}</p>
              <h1 className="mt-3 text-[2rem] leading-[1.12] font-semibold text-violeta md:text-[2.75rem]">
                {t('sc_brand.home.title_start', { defaultValue: 'Aprende a criar' })}{' '}
                <em className="sc-title-accent">{t('sc_brand.home.title_accent', { defaultValue: 'desde la calma' })}</em>.
              </h1>
              <p className="mt-4 max-w-[60ch] text-[1.0625rem] leading-relaxed text-violeta-600">
                {t('sc_brand.home.lead', {
                  defaultValue:
                    'Cursos en video y ebooks de {{name}}, psicóloga clínica infanto-juvenil ({{license}}). Al comprar, el acceso es inmediato y queda en tu cuenta.',
                  name: SC_PROFESSIONAL.name,
                  license: SC_PROFESSIONAL.license,
                })}
              </p>
              <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                {storeEnabled && (
                  <Link href={getUriWithOrg(orgslug, '/store')} className="sc-btn sc-btn-primary">
                    {t('sc_brand.home.store_cta', { defaultValue: 'Ver la tienda' })}
                  </Link>
                )}
                {isAuthenticated ? (
                  <Link href={getUriWithOrg(orgslug, '/account/purchases')} className="sc-btn sc-btn-outline">
                    {t('sc_brand.home.purchases_cta', { defaultValue: 'Mis compras' })}
                  </Link>
                ) : (
                  <Link href={getUriWithOrg(orgslug, '/login')} className="sc-btn sc-btn-outline">
                    {t('sc_brand.home.login_cta', { defaultValue: 'Ya compré: iniciar sesión' })}
                  </Link>
                )}
              </div>
            </div>
            <AuthenticatedClientElement
              ressourceType="courses"
              action="create"
              checkMethod="roles"
              orgId={org_id}
            >
              <Link href={getUriWithOrg(orgslug, '/courses?new=true')} className="self-start md:self-end">
                <NewCourseButton />
              </Link>
            </AuthenticatedClientElement>
          </div>
        </GeneralWrapperStyled>
      </section>

      <GeneralWrapperStyled>
        <div className="flex flex-col gap-12 pb-4 tracking-normal">
          {sections.map((section) => (
            <section key={section.key} aria-labelledby={`sc-home-${section.key}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 id={`sc-home-${section.key}`} className="text-2xl font-semibold text-violeta sm:text-[1.75rem]">
                  {section.title}
                </h2>
                <p className="text-sm text-violeta-400">
                  {section.items.length === 1
                    ? t('sc_brand.home.count_one', { defaultValue: '1 disponible' })
                    : t('sc_brand.home.count_other', { defaultValue: '{{n}} disponibles', n: section.items.length })}
                </p>
              </div>
              <div className="mt-5 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {section.items.map((course: any) => (
                  <div key={course.course_uuid} className="flex">
                    <CourseThumbnail course={course} orgslug={orgslug} />
                  </div>
                ))}
              </div>
            </section>
          ))}

          {courses.length === 0 && (
            <div className="sc-card flex flex-col items-start gap-4 p-7 sm:p-10">
              <div className="flex items-center gap-3 text-lavanda-600">
                <CirclePlay size={28} strokeWidth={1.5} aria-hidden="true" />
                <BookOpen size={28} strokeWidth={1.5} aria-hidden="true" />
              </div>
              <p className="sc-eyebrow">{t('sc_brand.home.empty_eyebrow', { defaultValue: 'Muy pronto' })}</p>
              <p className="font-display text-2xl font-semibold leading-snug text-violeta sm:text-[1.75rem]">
                {isAuthenticated
                  ? t('courses.no_courses')
                  : t('sc_brand.home.empty_title', { defaultValue: 'Estamos preparando los primeros cursos y ebooks.' })}
              </p>
              <div className="max-w-[58ch] text-violeta-600">
                {isAuthenticated ? (
                  <ContentPlaceHolderIfUserIsNotAdmin text={t('courses.create_courses_placeholder')} />
                ) : (
                  t('sc_brand.home.empty_text', {
                    defaultValue: 'Si ya compraste, inicia sesión para ver tu contenido.',
                  })
                )}
              </div>
              {!isAuthenticated && (
                <Link href={getUriWithOrg(orgslug, '/login')} className="sc-btn sc-btn-primary">
                  {t('auth.login')}
                </Link>
              )}
            </div>
          )}

          {hasMoreCourses && (
            <div className="text-center">
              <Link href={getUriWithOrg(orgslug, '/courses')} className="sc-btn sc-btn-outline">
                {t('courses.view_all_courses')} ({courses.length})
              </Link>
            </div>
          )}
        </div>
      </GeneralWrapperStyled>
    </div>
  )
}

export default LandingClassic

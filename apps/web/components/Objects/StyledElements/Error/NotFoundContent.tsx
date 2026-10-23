'use client'
// Sanar y Criar: body of the global 404 page (app/not-found.tsx), in the brand
// look and translated. A client component so it follows the language the user
// picked; the server render is Spanish like the rest of the platform.
import { ArrowRight } from 'lucide-react'
import Link from 'next/link'
import React from 'react'
import { useTranslation } from 'react-i18next'
import ScWordmark from '@components/Objects/Menus/ScWordmark'
import { errorText } from '@lib/errors/messages'

export default function NotFoundContent() {
  const { t, i18n } = useTranslation()
  const tr = (key: string) =>
    t(`sc_errors.not_found_page.${key}`, { defaultValue: errorText(`not_found_page.${key}`, i18n?.language) })

  return (
    <main className="sc-watercolor flex min-h-screen w-full flex-col items-center justify-center bg-nube px-4 py-16 text-center">
      <ScWordmark size="lg" />
      <p className="mt-12 font-display text-[5rem] leading-none font-semibold text-lavanda-500 sm:text-[6rem]" aria-hidden="true">
        404
      </p>
      <h1 className="mt-6 text-2xl font-semibold text-violeta sm:text-[1.75rem]">{tr('heading')}</h1>
      <p className="mt-4 max-w-[52ch] text-[1.0625rem] leading-relaxed text-violeta-600">{tr('description')}</p>
      <Link href="/" className="sc-btn sc-btn-primary mt-8 inline-flex items-center gap-2">
        {tr('home')}
        <ArrowRight size={18} className="transition-transform duration-150 ease-in-out" aria-hidden="true" />
      </Link>
    </main>
  )
}

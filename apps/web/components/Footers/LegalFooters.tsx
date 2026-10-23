'use client'
// Shared legal/footer bits, ported from the platform's look.
//
// AuthFooter:    the "By continuing, you agree to … Terms of Service and
//                Privacy Policy." line shown under the auth forms.
// CopyrightFooter: the "© {year} Sanar y Criar · Hilda Hernández" line for app
//                surfaces (the apex /home hub, the onboarding page, …).
//
// Sanar y Criar: legal pages live on our marketing site (getScSiteUrl(),
// https://www.sanarycriarve.com by default), never on LearnHouse's.
import React from 'react'
import Link from 'next/link'
import { useTranslation } from 'react-i18next'
import { getScSiteUrl, getScSourceUrl } from '@components/Objects/Menus/scBrand'

// Sanar y Criar: the auth forms point at our own legal pages on the
// marketing site (not LearnHouse's), plus the AGPL-3.0 source offer.
export function AuthFooter({ className = '' }: { className?: string }) {
  const { t } = useTranslation()
  return (
    <div className={`pb-8 pt-6 text-center px-6 space-y-1.5 ${className}`}>
      <p className="text-[13px] text-violeta-500">
        {t('sc_brand.auth_terms_prefix', { defaultValue: 'Al continuar, aceptas los' })}{' '}
        <a
          href={getScSiteUrl('/terminos')}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-violeta-600 underline underline-offset-4 decoration-rosa-300 hover:text-violeta"
        >
          {t('sc_brand.auth_terms', { defaultValue: 'Términos y condiciones' })}
        </a>{' '}
        {t('sc_brand.auth_and', { defaultValue: 'y la' })}{' '}
        <a
          href={getScSiteUrl('/privacidad')}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-violeta-600 underline underline-offset-4 decoration-rosa-300 hover:text-violeta"
        >
          {t('sc_brand.auth_privacy', { defaultValue: 'Política de privacidad' })}
        </a>
        {t('sc_brand.auth_terms_suffix', { defaultValue: ' de Sanar y Criar.' })}
      </p>
      <p className="text-[12px] text-violeta-400">
        {t('sc_brand.powered_by', { defaultValue: 'Plataforma basada en LearnHouse (AGPL-3.0)' })}
        {' · '}
        <a
          href={getScSourceUrl()}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-4 decoration-borde hover:text-violeta-600"
        >
          {t('sc_brand.source_code', { defaultValue: 'Código fuente' })}
        </a>
      </p>
    </div>
  )
}

export function CopyrightFooter({
  year,
  className = '',
  tone = 'light',
}: {
  year: number
  className?: string
  // `light` → dark text on light bg; `dark` → light text on dark bg.
  tone?: 'light' | 'dark'
}) {
  const { t } = useTranslation()
  const base = tone === 'dark' ? 'text-white/40' : 'text-black/35'
  const link = tone === 'dark' ? 'text-white/60 hover:text-white/80' : 'text-black/55 hover:text-black/75'
  return (
    <footer className={`w-full py-6 px-6 ${className}`}>
      <div className="flex flex-col sm:flex-row items-center justify-center gap-x-5 gap-y-2 text-[13px] font-medium">
        <p className={base}>
          {t('sc_brand.copyright', { defaultValue: '© {{year}} Sanar y Criar · Hilda Hernández', year })}
        </p>
        <nav className="flex items-center gap-x-5" aria-label={t('sc_brand.legal_nav_label', { defaultValue: 'Legal' })}>
          <Link
            href={getScSiteUrl('/terminos')}
            target="_blank"
            rel="noopener noreferrer"
            className={`${link} transition-colors`}
          >
            {t('sc_brand.legal.terms', { defaultValue: 'Términos' })}
          </Link>
          <Link
            href={getScSiteUrl('/privacidad')}
            target="_blank"
            rel="noopener noreferrer"
            className={`${link} transition-colors`}
          >
            {t('sc_brand.legal.privacy', { defaultValue: 'Privacidad' })}
          </Link>
        </nav>
      </div>
    </footer>
  )
}

'use client'
// Sanar y Criar: discreet footer for every learner page (replaces the
// LearnHouse logo and the "Made with LearnHouse" watermark). Legal pages live
// on the marketing site. The last line is the AGPL-3.0 §13 source offer.
import React from 'react'
import { useTranslation } from 'react-i18next'
import { useOrg } from '@components/Contexts/OrgContext'
import {
  SC_BRAND_NAME,
  SC_LEGAL_LINKS,
  SC_PROFESSIONAL,
  getScSiteUrl,
  getScSourceUrl,
} from '@components/Objects/Menus/scBrand'

export default function ScOrgFooter() {
  const { t } = useTranslation()
  const org = useOrg() as any
  const footerText =
    org?.config?.config?.customization?.general?.footer_text || org?.config?.config?.general?.footer_text || ''
  const year = new Date().getFullYear()

  return (
    // Opaque and above the page content: the lesson page's dark theater band
    // runs to the end of the page and would otherwise cover the footer.
    <footer className="relative w-full mt-16 border-t border-borde bg-nube" style={{ zIndex: 'var(--z-elevated)' }}>
      <div className="mx-auto max-w-(--breakpoint-2xl) px-4 sm:px-6 lg:px-8 py-8 space-y-3 text-[0.8125rem] leading-relaxed text-violeta-500">
        {footerText && <p className="text-violeta-600">{footerText}</p>}
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <p suppressHydrationWarning>
            © {year} {SC_BRAND_NAME} · {SC_PROFESSIONAL.name}, {SC_PROFESSIONAL.license}
          </p>
          <nav aria-label={t('sc_brand.legal_nav_label', { defaultValue: 'Legal' })}>
            <ul className="flex flex-wrap gap-x-5 gap-y-2">
              {SC_LEGAL_LINKS.map((link) => (
                <li key={link.key}>
                  <a
                    href={getScSiteUrl(link.path)}
                    className="hover:text-violeta hover:underline underline-offset-4 decoration-rosa-300"
                  >
                    {t(`sc_brand.legal.${link.key}`, { defaultValue: link.label })}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <p className="text-[0.75rem] text-violeta-400">
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
    </footer>
  )
}

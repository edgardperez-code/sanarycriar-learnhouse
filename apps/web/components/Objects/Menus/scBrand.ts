// Sanar y Criar: brand constants for the platform chrome (header, footer,
// auth pages). URLs that change per environment come from runtime config
// (NEXT_PUBLIC_* values, injected at container start by server-wrapper.js).
import { getConfig } from '@services/config/config'

export const SC_BRAND_NAME = 'Sanar y Criar'

export const SC_PROFESSIONAL = {
  name: 'Hilda Hernández',
  shortTitle: 'Psicóloga Infanto-Juvenil',
  license: 'FPV 8.914',
}

// Marketing site (Astro) with the legal pages.
const DEFAULT_SITE_URL = 'https://www.sanarycriarve.com'

// AGPL-3.0 §13: users interacting with the platform over the network must be
// offered its Corresponding Source. The default is the published fork;
// NEXT_PUBLIC_SC_SOURCE_URL can pin it to the deployed tag.
const DEFAULT_SOURCE_URL = 'https://github.com/edgardperez-code/sanarycriar-learnhouse/tree/sanarycriar'

function httpUrl(value: string, fallback: string): string {
  const v = (value || '').trim()
  return /^https?:\/\/[^\s]+$/i.test(v) ? v.replace(/\/+$/, '') : fallback
}

/** Marketing site URL, optionally joined with a path ("/terminos"). */
export function getScSiteUrl(path = ''): string {
  return httpUrl(getConfig('NEXT_PUBLIC_SC_SITE_URL'), DEFAULT_SITE_URL) + path
}

/** Where the platform's source code is published (AGPL-3.0 notice). */
export function getScSourceUrl(): string {
  return httpUrl(getConfig('NEXT_PUBLIC_SC_SOURCE_URL'), DEFAULT_SOURCE_URL)
}

/** Legal pages on the marketing site (sanarycriar/web: /terminos, /privacidad, /reembolsos). */
export const SC_LEGAL_LINKS = [
  { key: 'terms', path: '/terminos', label: 'Términos' },
  { key: 'privacy', path: '/privacidad', label: 'Privacidad' },
  { key: 'refunds', path: '/reembolsos', label: 'Reembolsos' },
] as const

'use client'

import { useEffect } from 'react'
import { useOrg } from './OrgContext'
// Sanar y Criar: applyOrgLanguage switches without marking a user pick, and
// Spanish is the effective default when the org has no explicit language.
import i18n, { applyOrgLanguage, DEFAULT_LANGUAGE, USER_PICKED_KEY } from '@/lib/i18n'

export default function OrgLanguageSync() {
  const org = useOrg() as any

  const configured: string | undefined =
    org?.config?.config?.customization?.general?.default_language ||
    org?.config?.config?.general?.default_language
  // Wait for the org to load, so a slow fetch never switches back and forth.
  const orgDefault: string | undefined = org ? configured || DEFAULT_LANGUAGE : undefined

  useEffect(() => {
    if (!orgDefault) return

    let userPicked: string | null = null
    try {
      userPicked = localStorage.getItem(USER_PICKED_KEY)
    } catch { /* storage unavailable: treat as no pick */ }
    if (userPicked) return

    if (i18n.language.split('-')[0] !== orgDefault) {
      applyOrgLanguage(orgDefault)
    }
  }, [orgDefault])

  return null
}

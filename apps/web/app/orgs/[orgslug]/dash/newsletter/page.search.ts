// Sanar y Criar: command-palette entries for the newsletter section. No
// featureKey: the section is always available and the API enforces the
// org-admin permission.
import { EnvelopeSimple, UsersThree } from '@phosphor-icons/react'
import type { SearchMeta } from '@/lib/dashboard-search/types'

export const searchMetas: SearchMeta[] = [
  {
    id: 'dash.newsletter.popup',
    titleKey: 'sc_newsletter.search.popup.title',
    descriptionKey: 'sc_newsletter.search.popup.description',
    keywordsKey: 'sc_newsletter.search.popup.keywords',
    icon: EnvelopeSimple,
    href: '/dash/newsletter/popup',
    group: 'settings',
  },
  {
    id: 'dash.newsletter.subscribers',
    titleKey: 'sc_newsletter.search.subscribers.title',
    descriptionKey: 'sc_newsletter.search.subscribers.description',
    keywordsKey: 'sc_newsletter.search.subscribers.keywords',
    icon: UsersThree,
    href: '/dash/newsletter/subscribers',
    group: 'settings',
  },
]

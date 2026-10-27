// Sanar y Criar: command-palette entry for the blog section. No featureKey:
// the section is always available and the API enforces the org-admin
// permission.
import { Article } from '@phosphor-icons/react'
import type { SearchMeta } from '@/lib/dashboard-search/types'

export const searchMetas: SearchMeta[] = [
  {
    id: 'dash.blog',
    titleKey: 'sc_blog.search.list.title',
    descriptionKey: 'sc_blog.search.list.description',
    keywordsKey: 'sc_blog.search.list.keywords',
    icon: Article,
    href: '/dash/blog',
    group: 'content',
    requiresOrgAdmin: true,
  },
]

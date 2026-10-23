import { useOrg } from '@components/Contexts/OrgContext'
import { getUriWithOrg } from '@services/config/config'
import { Books, FolderSimple, ChatsCircle, Headphones, Cube, ShoppingBag } from '@phosphor-icons/react'
import { menuIcon } from '@components/Objects/Menus/menuIcons'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import React from 'react'
import { useTranslation } from 'react-i18next'

type Builtin = { feature: string; link: string; labelKey: string; Icon: any }

const BUILTIN: Record<string, Builtin> = {
  courses: { feature: 'courses', link: '/courses', labelKey: 'courses.courses', Icon: Books },
  library: { feature: 'folders', link: '/library', labelKey: 'library.library', Icon: FolderSimple },
  podcasts: { feature: 'podcasts', link: '/podcasts', labelKey: 'podcasts.podcasts', Icon: Headphones },
  communities: { feature: 'communities', link: '/communities', labelKey: 'communities.title', Icon: ChatsCircle },
  playgrounds: { feature: 'playgrounds', link: '/playgrounds', labelKey: 'common.playgrounds', Icon: Cube },
  store: { feature: 'payments', link: '/store', labelKey: 'common.store', Icon: ShoppingBag },
}

// Default order when an org has no custom menu config.
const DEFAULT_ORDER = ['courses', 'library', 'podcasts', 'communities', 'playgrounds', 'store']

// Sanar y Criar: brand nav (text links like the marketing site, no icons;
// rosa-300 underline marks hover and the current section). `primaryColor`
// is accepted for API compatibility but the header always uses the brand
// palette. `variant="mobile"` renders the stacked list of the mobile panel.
function MenuLinks(props: { orgslug: string; primaryColor?: string; variant?: 'desktop' | 'mobile'; onNavigate?: () => void }) {
  const { t } = useTranslation()
  const org = useOrg() as any
  const pathname = usePathname() || ''
  const variant = props.variant ?? 'desktop'

  const rf = org?.config?.config?.resolved_features
  const isEnabled = (feature: string) => rf?.[feature]?.enabled === true

  const configItems: any[] | undefined =
    org?.config?.config?.customization?.menu?.items ?? org?.config?.config?.general?.menu?.items

  // Build the items to render (config-driven, else feature-driven defaults)
  const source =
    configItems && configItems.length
      ? [...configItems].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      : DEFAULT_ORDER.map((type, i) => ({ type, enabled: true, order: i, label: '', url: '' }))

  const rendered = source
    .map((item: any) => {
      if (item.type === 'custom') {
        if (!item.enabled || !item.url) return null
        const external = /^https?:\/\//i.test(item.url)
        return {
          key: `custom-${item.url}`,
          label: item.label || item.url,
          Icon: menuIcon(item.icon),
          href: external ? item.url : getUriWithOrg(props.orgslug, item.url),
          path: external ? '' : item.url,
          external,
        }
      }
      const meta = BUILTIN[item.type]
      if (!meta) return null
      if (!item.enabled) return null
      if (!isEnabled(meta.feature)) return null // plan/feature gating
      return {
        key: item.type,
        label: item.label || t(meta.labelKey),
        Icon: meta.Icon,
        href: getUriWithOrg(props.orgslug, meta.link),
        path: meta.link,
        external: false,
      }
    })
    .filter(Boolean) as any[]

  // "/courses" is current on /courses and on a course page; "/store" on offers.
  const isCurrent = (path: string) => {
    if (!path) return false
    if (path === '/courses') return /\/(courses|course)(\/|$)/.test(pathname)
    return pathname === path || pathname.startsWith(path + '/') || pathname.endsWith(path)
  }

  const linkClass =
    variant === 'mobile'
      ? 'flex min-h-12 items-center py-3 font-display text-[1.375rem] font-semibold text-violeta aria-[current=page]:text-lavanda-600'
      : 'whitespace-nowrap text-[0.9375rem] font-medium text-violeta-600 underline-offset-[0.4em] decoration-rosa-300 decoration-2 transition-colors hover:text-violeta hover:underline aria-[current=page]:text-violeta aria-[current=page]:underline'

  return (
    <ul className={variant === 'mobile' ? 'flex flex-col' : 'flex items-center gap-6 ps-2'}>
      {rendered.map((it) => {
        const current = isCurrent(it.path) ? 'page' : undefined
        return (
          <li key={it.key} className={variant === 'mobile' ? 'border-b border-borde last:border-b-0' : ''}>
            {it.external ? (
              <a href={it.href} target="_blank" rel="noopener noreferrer" className={linkClass} onClick={props.onNavigate}>
                {it.label}
              </a>
            ) : (
              <Link href={it.href} aria-current={current} className={linkClass} onClick={props.onNavigate}>
                {it.label}
              </Link>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export default MenuLinks

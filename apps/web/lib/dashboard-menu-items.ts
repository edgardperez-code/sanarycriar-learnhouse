import {
  House,
  BookOpen,
  Files,
  Users,
  CurrencyCircleDollar,
  Buildings,
  ChatsCircle,
  ChalkboardSimple,
  Cube,
  FolderSimple,
  Headphones,
  ChartBar,
  Code,
  EnvelopeSimple,
  Article,
  Receipt,
} from '@phosphor-icons/react'

export interface DashboardMenuItem {
  id: string
  href: string
  icon: typeof House
  labelKey: string
  /** Feature key used for plan-based gating. If undefined, item is always shown. */
  featureKey?: string
  /** If true, the feature defaults to disabled (must be explicitly enabled). */
  defaultDisabled?: boolean
}

export const DASHBOARD_MENU_ITEMS: DashboardMenuItem[] = [
  {
    id: 'home',
    href: '/dash',
    icon: House,
    labelKey: 'common.home',
  },
  {
    id: 'courses',
    href: '/dash/courses',
    icon: BookOpen,
    labelKey: 'courses.courses',
  },
  {
    id: 'assignments',
    href: '/dash/assignments',
    icon: Files,
    labelKey: 'common.assignments',
  },
  {
    id: 'library',
    href: '/dash/library',
    icon: FolderSimple,
    labelKey: 'library.library',
    featureKey: 'folders',
  },
  {
    id: 'communities',
    href: '/dash/communities',
    icon: ChatsCircle,
    labelKey: 'communities.title',
    featureKey: 'communities',
  },
  {
    id: 'podcasts',
    href: '/dash/podcasts',
    icon: Headphones,
    labelKey: 'podcasts.podcasts',
    featureKey: 'podcasts',
  },
  {
    id: 'boards',
    href: '/dash/boards',
    icon: ChalkboardSimple,
    labelKey: 'common.boards',
    featureKey: 'boards',
    defaultDisabled: true,
  },
  {
    id: 'playgrounds',
    href: '/dash/playgrounds',
    icon: Cube,
    labelKey: 'common.playgrounds',
    featureKey: 'playgrounds',
    defaultDisabled: true,
  },
  {
    id: 'users',
    href: '/dash/users/settings/users',
    icon: Users,
    labelKey: 'common.users',
  },
  {
    id: 'payments',
    href: '/dash/payments/overview',
    icon: CurrencyCircleDollar,
    labelKey: 'common.payments',
    featureKey: 'payments',
  },
  // Sanar y Criar: Pago Móvil orders of the cart ("Pedidos"), next to payments.
  { id: 'orders', href: '/dash/orders', icon: Receipt, labelKey: 'sc_orders.menu_label', featureKey: 'payments' },
  // Sanar y Criar: newsletter (sign-up pop-up + subscribers). No feature gate.
  {
    id: 'newsletter',
    href: '/dash/newsletter/popup',
    icon: EnvelopeSimple,
    labelKey: 'sc_newsletter.menu_label',
  },
  // Sanar y Criar: blog (articles of the marketing site, with AI). No feature gate.
  { id: 'blog', href: '/dash/blog', icon: Article, labelKey: 'sc_blog.menu_label' },
  {
    id: 'organization',
    href: '/dash/org/settings/general',
    icon: Buildings,
    labelKey: 'common.organization',
  },
  {
    id: 'analytics',
    href: '/dash/analytics',
    icon: ChartBar,
    labelKey: 'common.analytics',
  },
  {
    id: 'developers',
    href: '/dash/developers/api',
    icon: Code,
    labelKey: 'dashboard.developers.breadcrumb',
  },
]

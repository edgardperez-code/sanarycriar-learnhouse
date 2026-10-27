// Sanar y Criar: command-palette entry for "Pedidos" (Pago Móvil orders).
import { Receipt } from '@phosphor-icons/react'
import type { SearchMeta } from '@/lib/dashboard-search/types'

export const searchMetas: SearchMeta[] = [
  {
    id: 'dash.orders',
    titleKey: 'sc_orders.search.title',
    descriptionKey: 'sc_orders.search.description',
    keywordsKey: 'sc_orders.search.keywords',
    icon: Receipt,
    href: '/dash/orders',
    group: 'payments',
    featureKey: 'payments',
    requiresOrgAdmin: true,
  },
]

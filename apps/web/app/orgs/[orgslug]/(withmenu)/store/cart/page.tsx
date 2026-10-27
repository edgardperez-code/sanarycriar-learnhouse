// Sanar y Criar: the cart (contract §D.4). The cart lives in the browser, so
// the page itself is client-side; this server part only checks that the
// organization sells (same check as /store).
import { Metadata } from 'next'
import { getOrganizationContextInfo } from '@services/organizations/orgs'
import { getOrgSeoConfig, buildPageTitle } from '@/lib/seo/utils'
import StoreUnavailable from '@components/Payments/StoreUnavailable'
import CartPage from '@components/Store/Cart/CartPage'

type PageParams = Promise<{ orgslug: string }>

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { orgslug } = await params
  const org = await getOrganizationContextInfo(orgslug, { revalidate: 120, tags: ['organizations'] })
  const seoConfig = getOrgSeoConfig(org)
  return {
    title: buildPageTitle('Carrito', org?.name || 'Sanar y Criar', seoConfig),
    robots: { index: false, follow: false },
  }
}

export default async function StoreCartPage({ params }: { params: PageParams }) {
  const { orgslug } = await params
  const org = await getOrganizationContextInfo(orgslug, { revalidate: 120, tags: ['organizations'] })

  const paymentsEnabled = org?.config?.config?.resolved_features?.payments?.enabled ?? org?.config?.config?.features?.payments?.enabled !== false

  if (!paymentsEnabled) {
    return <StoreUnavailable />
  }

  return <CartPage orgslug={orgslug} orgId={org.id} />
}

// Sanar y Criar: one Pago Móvil order (contract §D.5). Only its buyer (or an
// admin) can read it, so a visitor without a session goes to the login first
// and comes back here.
import { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getOrganizationContextInfo } from '@services/organizations/orgs'
import { getServerSession } from '@/lib/auth/server'
import { getOrgSeoConfig, buildPageTitle } from '@/lib/seo/utils'
import StoreUnavailable from '@components/Payments/StoreUnavailable'
import PurchasePage from '@components/Store/Cart/PurchasePage'
import { isPlausiblePurchaseUuid } from '@/lib/sc-cart'

type PageParams = Promise<{ orgslug: string; purchaseUuid: string }>

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { orgslug } = await params
  const org = await getOrganizationContextInfo(orgslug, { revalidate: 120, tags: ['organizations'] })
  const seoConfig = getOrgSeoConfig(org)
  return {
    title: buildPageTitle('Tu pedido', org?.name || 'Sanar y Criar', seoConfig),
    robots: { index: false, follow: false },
  }
}

export default async function StorePurchasePage({ params }: { params: PageParams }) {
  const { orgslug, purchaseUuid } = await params
  const session = await getServerSession()

  // Browser-relative redirect, like account/[subpage]: the proxy adds the
  // /orgs/{slug} prefix. Only a well-formed id goes into the redirect.
  if (!session) {
    redirect(
      isPlausiblePurchaseUuid(purchaseUuid)
        ? `/login?redirect=/store/purchases/${purchaseUuid}`
        : '/login?redirect=/account/purchases'
    )
  }

  const org = await getOrganizationContextInfo(orgslug, { revalidate: 120, tags: ['organizations'] })
  const paymentsEnabled = org?.config?.config?.resolved_features?.payments?.enabled ?? org?.config?.config?.features?.payments?.enabled !== false

  if (!paymentsEnabled) {
    return <StoreUnavailable />
  }

  return <PurchasePage orgslug={orgslug} orgId={org.id} purchaseUuid={purchaseUuid} />
}

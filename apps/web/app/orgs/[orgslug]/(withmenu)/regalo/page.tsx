// Sanar y Criar: /regalo (contract "regalo" §B1), where the parenting test
// result and the free ebook land after signing up. The page itself is
// client-side (it depends on the session and on the sign-up mark); this
// server part loads the org and the featured offer's price, and hands the
// query over as props (searchParams is a Promise in Next 16).
import { Metadata } from 'next'
import { getOrganizationContextInfo } from '@services/organizations/orgs'
import { getOrgSeoConfig, buildPageTitle } from '@/lib/seo/utils'
import { getPublicOffers } from '@services/payments/offers'
import RegaloPage from '@components/SanarYCriar/RegaloPage'
import { parseRegaloParams, type RegaloOffer } from '@components/SanarYCriar/regalo'

type PageParams = Promise<{ orgslug: string }>
type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { orgslug } = await params
  const org = await getOrganizationContextInfo(orgslug, { revalidate: 120, tags: ['organizations'] })
  const seoConfig = getOrgSeoConfig(org)
  return {
    title: buildPageTitle('Tu regalo', org?.name || 'Sanar y Criar', seoConfig),
    robots: { index: false, follow: false },
  }
}

/** The offer's price from the public listing (as the store shows it); null if it is not there or the call fails. */
async function findOffer(orgId: number, offerUuid: string): Promise<RegaloOffer | null> {
  try {
    const res = await getPublicOffers(orgId)
    const offers: any[] = res?.success && Array.isArray(res.data) ? res.data : []
    const offer = offers.find((o) => String(o?.offer_uuid ?? '').toLowerCase() === offerUuid)
    const amount = Number(offer?.amount)
    if (!offer || !Number.isFinite(amount) || typeof offer.currency !== 'string') return null
    return { amount, currency: offer.currency, offer_type: typeof offer.offer_type === 'string' ? offer.offer_type : null }
  } catch {
    return null
  }
}

export default async function RegaloRoutePage({ params, searchParams }: { params: PageParams; searchParams: SearchParams }) {
  const { orgslug } = await params
  const query = parseRegaloParams(await searchParams)
  const org = await getOrganizationContextInfo(orgslug, { revalidate: 120, tags: ['organizations'] })

  // Same check as the store: without it there is no price and nothing to buy,
  // but the result and the free ebook still work.
  const storeEnabled = Boolean(
    org?.config?.config?.resolved_features?.payments?.enabled ?? org?.config?.config?.features?.payments?.enabled !== false
  )
  const offer = storeEnabled && query.oferta ? await findOffer(org.id, query.oferta) : null

  return <RegaloPage orgslug={orgslug} orgId={org.id} params={query} offer={offer} storeEnabled={storeEnabled} />
}

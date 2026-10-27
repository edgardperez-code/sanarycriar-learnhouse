import { Metadata } from 'next'
import { getOrganizationContextInfo } from '@services/organizations/orgs'
import { getOrgThumbnailMediaDirectory, getOrgOgImageMediaDirectory } from '@services/media/media'
import { getOrgSeoConfig, buildPageTitle, buildBreadcrumbJsonLd } from '@/lib/seo/utils'
import { getServerCanonicalUrl } from '@/lib/seo/utils.server'
import { JsonLd } from '@components/SEO/JsonLd'
import { getPublicOffers } from '@services/payments/offers'
import Store from './store'
// Sanar y Criar: translated unavailable state.
import StoreUnavailable from '@components/Payments/StoreUnavailable'

type PageParams = Promise<{ orgslug: string }>

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { orgslug } = await params
  const org = await getOrganizationContextInfo(orgslug, { revalidate: 120, tags: ['organizations'] })
  const seoConfig = getOrgSeoConfig(org)
  const ogImageUrl = seoConfig.default_og_image
    ? getOrgOgImageMediaDirectory(org?.org_uuid, seoConfig.default_og_image)
    : null
  const imageUrl = ogImageUrl || (org ? getOrgThumbnailMediaDirectory(org.org_uuid, org.thumbnail_image) : undefined)
  // Sanar y Criar: Spanish-first storefront metadata.
  const title = buildPageTitle('Tienda', org?.name || 'Sanar y Criar', seoConfig)
  // Sanar y Criar: no "acceso inmediato": with Pago Móvil access waits for the confirmation.
  const description = `Cursos y ebooks de ${org?.name || 'Sanar y Criar'} para aprender a tu ritmo, en tu cuenta y desde cualquier dispositivo.`
  const canonical = await getServerCanonicalUrl(orgslug, '/store')

  return {
    title,
    description,
    robots: { index: true, follow: true },
    alternates: { canonical },
    openGraph: {
      title,
      description,
      type: 'website',
      ...(imageUrl && { images: [{ url: imageUrl, width: 800, height: 600, alt: org?.name || 'Tienda' }] }),
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      ...(imageUrl && { images: [imageUrl] }),
    },
  }
}

export default async function StorePage({ params }: { params: PageParams }) {
  const { orgslug } = await params
  const org = await getOrganizationContextInfo(orgslug, { revalidate: 120, tags: ['organizations'] })

  const paymentsEnabled = org?.config?.config?.resolved_features?.payments?.enabled ?? org?.config?.config?.features?.payments?.enabled !== false

  if (!paymentsEnabled) {
    return <StoreUnavailable />
  }

  let offers: any[] = []
  try {
    const result = await getPublicOffers(org.id)
    offers = result?.success && Array.isArray(result.data) ? result.data : []
  } catch {
    offers = []
  }

  const breadcrumbJsonLd = buildBreadcrumbJsonLd([
    { name: 'Inicio', url: await getServerCanonicalUrl(orgslug, '/') },
    { name: 'Tienda', url: await getServerCanonicalUrl(orgslug, '/store') },
  ])

  return (
    <>
      <JsonLd data={breadcrumbJsonLd} />
      <Store orgslug={orgslug} offers={offers} />
    </>
  )
}

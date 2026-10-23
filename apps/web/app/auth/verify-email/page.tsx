import { getOrganizationContextInfo } from '@services/organizations/orgs'
import { getAuthOrgSlug } from '@services/org/orgResolution'
import VerifyEmailClient from './verify-email'
import { Metadata } from 'next'
import OrgNotFound from '@components/Objects/StyledElements/Error/OrgNotFound'
import { Suspense } from 'react'
import PageLoading from '@components/Objects/Loaders/PageLoading'

// Sanar y Criar: Spanish page title, "Sanar y Criar" fallback.
export async function generateMetadata(): Promise<Metadata> {
  const orgslug = await getAuthOrgSlug()

  if (!orgslug) {
    return { title: 'Verificar correo | Sanar y Criar' }
  }

  let org: any = null
  try {
    org = await getOrganizationContextInfo(orgslug, {
      revalidate: 60,
      tags: ['organizations'],
    })
  } catch {
    // Stale cookie or unknown org: fall back to generic title
  }

  return {
    title: 'Verificar correo' + ` | ${org?.name || 'Sanar y Criar'}`,
    robots: { index: false, follow: false },
  }
}

const VerifyEmailPage = async () => {
  const orgslug = await getAuthOrgSlug()

  let org: any = null
  if (orgslug) {
    try {
      org = await getOrganizationContextInfo(orgslug, {
        revalidate: 60,
        tags: ['organizations'],
      })
    } catch {
      org = null
    }
    if (!org) {
      return <OrgNotFound />
    }
  }

  return (
    <Suspense fallback={<PageLoading />}>
      <VerifyEmailClient org={org} />
    </Suspense>
  )
}

export default VerifyEmailPage

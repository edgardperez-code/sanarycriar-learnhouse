import React from 'react'
import { Metadata } from 'next'
import { getOrganizationContextInfo } from '@services/organizations/orgs'
import Trail from './trail'

export const dynamic = 'force-dynamic'

type MetadataProps = {
  params: Promise<{ orgslug: string }>
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}

export async function generateMetadata(props: MetadataProps): Promise<Metadata> {
  const params = await props.params;
  const org = await getOrganizationContextInfo(params.orgslug, {
    revalidate: 120,
    tags: ['organizations'],
  })
  return {
    // Sanar y Criar: Spanish page title, "Sanar y Criar" fallback.
    title: 'Mi progreso | ' + org.name,
    description:
      'Revisa tu progreso y retoma tus cursos donde los dejaste.',
  }
}

const TrailPage = async (params: any) => {
  let orgslug = (await params.params).orgslug

  return (
    <div>
      <Trail orgslug={orgslug} />
    </div>
  )
}

export default TrailPage

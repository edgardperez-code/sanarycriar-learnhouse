import React from 'react'
import { Metadata } from 'next'
import { getOrganizationContextInfo } from '@services/organizations/orgs'
import Copilot from './copilot'
import { getServerSession } from '@/lib/auth/server'

type MetadataProps = {
  params: Promise<{ orgslug: string }>
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}

export async function generateMetadata(props: MetadataProps): Promise<Metadata> {
  const params = await props.params
  const session = await getServerSession()
  const access_token = session?.tokens?.access_token
  const org = await getOrganizationContextInfo(params.orgslug, {
    revalidate: 120,
    tags: ['organizations'],
  }, access_token)
  return {
    // Sanar y Criar: Spanish page title, "Sanar y Criar" fallback.
    title: 'Copiloto | ' + org.name,
    description: 'Conversa con la IA sobre tus cursos.',
  }
}

const CopilotPage = async (params: any) => {
  const orgslug = (await params.params).orgslug

  return (
    <div>
      <Copilot orgslug={orgslug} />
    </div>
  )
}

export default CopilotPage

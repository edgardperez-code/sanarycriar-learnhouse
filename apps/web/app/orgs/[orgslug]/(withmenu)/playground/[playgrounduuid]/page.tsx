import { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getServerSession } from '@/lib/auth/server'
import { getPlayground } from '@services/playgrounds/playgrounds'
import PlaygroundViewClient from './view'

type PageParams = Promise<{ orgslug: string; playgrounduuid: string }>

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { playgrounduuid } = await params
  try {
    const pg = await getPlayground(playgrounduuid)
    return {
      title: pg.name,
      description: pg.description || `Espacio interactivo: ${pg.name}`, // Sanar y Criar: Spanish page title, "Sanar y Criar" fallback.
    }
  } catch {
    return { title: 'Espacio interactivo' }
  }
}

export default async function PlaygroundViewPage({ params }: { params: PageParams }) {
  const { orgslug, playgrounduuid } = await params
  const session = await getServerSession()
  const access_token = session?.tokens?.access_token

  let playground
  try {
    playground = await getPlayground(playgrounduuid, access_token ?? undefined)
  } catch {
    notFound()
  }

  if (!playground.published && !access_token) {
    notFound()
  }

  return (
    <PlaygroundViewClient
      playground={playground}
      orgslug={orgslug}
      canEdit={!!access_token}
    />
  )
}

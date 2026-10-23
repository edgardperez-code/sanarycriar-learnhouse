import type { Metadata } from 'next'
import NotFoundContent from '@components/Objects/StyledElements/Error/NotFoundContent'

// Rendered per request, not prerendered. Next 16 answers an unknown Server
// Action posted to a missing path from the static 404 entry, finds a text/plain
// error where it expects an RSC payload and throws a 500 instead of a 404.
export const dynamic = 'force-dynamic'

// Sanar y Criar: Spanish title (the server always renders the platform
// language); the page body is translated client-side in NotFoundContent.
export const metadata: Metadata = {
  title: 'Página no encontrada | Sanar y Criar',
}

// Sanar y Criar: brand 404 (was the LearnHouse logo and English copy).
export default function NotFound() {
  return <NotFoundContent />
}

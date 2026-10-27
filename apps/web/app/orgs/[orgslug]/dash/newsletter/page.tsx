import { redirect } from 'next/navigation'

// Sanar y Criar: bare /dash/newsletter → the pop-up settings. Browser-relative
// path only (the proxy adds the /orgs/{slug} prefix).
export default function NewsletterIndex() {
  redirect('/dash/newsletter/popup')
}

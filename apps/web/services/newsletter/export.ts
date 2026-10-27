// Sanar y Criar: CSV export of the newsletter subscribers. Runs in the browser
// (not a server action) so the file can be handed to the user as a download,
// like the audit-log export.
import { getAPIUrl } from '@services/config/config'
import { exportFileName } from '@components/Dashboard/Pages/Newsletter/newsletterForm'

export async function downloadNewsletterCsv(orgId: number, access_token: string): Promise<void> {
  const url = `${getAPIUrl()}newsletter/${encodeURIComponent(String(orgId))}/subscribers/export.csv`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${access_token}` },
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`Newsletter export failed (${response.status})`)

  const blob = await response.blob()
  const downloadUrl = window.URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = downloadUrl
  a.download = exportFileName()
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Give the browser a moment to start the download before freeing the blob.
  window.setTimeout(() => window.URL.revokeObjectURL(downloadUrl), 1000)
}

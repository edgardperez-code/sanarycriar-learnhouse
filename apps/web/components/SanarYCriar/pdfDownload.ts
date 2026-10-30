// Sanar y Criar: link that saves a content file instead of opening it.
//
// Phones ignore `<a download>` on another origin and most block script-driven
// blob saves, but every browser saves a plain link answered with
// `Content-Disposition: attachment`. The content route sends that header for
// `?download=1` (with `name` as the suggested filename), after the same access
// check as viewing the file, so only buyers get the PDF.
export function pdfDownloadUrl(fileUrl: string, name?: string | null): string {
  const params = new URLSearchParams({ download: '1' })
  const cleanName = String(name || '').trim()
  if (cleanName) params.set('name', cleanName)
  return `${fileUrl}${fileUrl.includes('?') ? '&' : '?'}${params.toString()}`
}

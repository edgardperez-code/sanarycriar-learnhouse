import { useOrg } from '@components/Contexts/OrgContext'
import { getActivityMediaDirectory } from '@services/media/media'
import { ArrowsOut, ArrowsIn, DownloadSimple, FilePdf, ArrowSquareOut } from '@phosphor-icons/react'
import { useTranslation } from 'react-i18next'
import React from 'react'
import { positiveIntParam } from '@/lib/copilot/sources'
// Sanar y Criar: "last opened" progress + `?download=1` from the ebook page.
import { useLHSession } from '@components/Contexts/LHSessionContext'
import { useProgressSaver } from '@components/SanarYCriar/useProgressSaver'

// Filename for the saved copy: the activity's name, so learners don't end up
// with a folder of opaque upload ids.
function downloadName(activity: any) {
  const base = String(activity?.name || 'document').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'document'
  return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`
}

const noSubscription = () => () => {}

// Sanar y Criar: Android Chrome and most in-app browsers have no built-in PDF
// viewer, so the iframe stays blank there. `navigator.pdfViewerEnabled` says
// so reliably (Chrome 94+, Firefox 99+, Safari 16.4+); unknown → keep the iframe.
const hasPdfViewer = () =>
  typeof navigator === 'undefined' || (navigator as any).pdfViewerEnabled !== false

function DocumentPdfActivity({
  activity,
  course,
  orgUuid,
  className,
  trackProgress = true,
}: {
  activity: any
  course: any
  orgUuid?: string
  className?: string
  /** Sanar y Criar: record that the learner opened this document. */
  trackProgress?: boolean
}) {
  const { t } = useTranslation()
  const org = useOrg() as any
  const resolvedOrgUuid = orgUuid || org?.org_uuid
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [isFullscreen, setIsFullscreen] = React.useState(false)

  const pdfUrl = getActivityMediaDirectory(
    resolvedOrgUuid,
    course?.course_uuid,
    activity.activity_uuid,
    activity.content.filename,
    'documentpdf'
  )

  // `?page=<n>` opens the document at a page, e.g. from a copilot citation.
  // Read through useSyncExternalStore so the server render and hydration agree.
  const search = React.useSyncExternalStore(noSubscription, () => window.location.search, () => '')
  const linkedPage = positiveIntParam(search, 'page')
  // Sanar y Criar: server render assumes a viewer; the client corrects it.
  const canShowInline = React.useSyncExternalStore(noSubscription, hasPdfViewer, () => true)

  // Sanar y Criar: mark the document as the learner's last stop in the course.
  // The browser's PDF viewer can't report the page being read (cross-origin
  // iframe), so only a `?page=` deep link carries a page.
  const session = useLHSession() as any
  const authenticated = session?.status === 'authenticated'
  const saver = useProgressSaver({
    activityUuid: activity?.activity_uuid,
    courseUuid: course?.course_uuid,
    enabled: trackProgress,
  })
  const openedRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!trackProgress || !authenticated || !activity?.activity_uuid) return
    if (openedRef.current === activity.activity_uuid) return
    openedRef.current = activity.activity_uuid
    if (linkedPage) saver.setPage(linkedPage)
    saver.update(0)
    saver.flush({ keepalive: false })
  }, [trackProgress, authenticated, activity?.activity_uuid, linkedPage, saver])

  React.useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // The file lives on the media origin, where a plain <a download> is ignored
  // and the browser would just open it. Fetch it and save the blob instead:
  // with the learner's cookies for the API, without them for a CDN that answers
  // `Access-Control-Allow-Origin: *` (which rejects credentialed requests).
  // Last resort is a new tab.
  const fetchPdf = async () => {
    for (const credentials of ['include', 'omit'] as const) {
      try {
        const res = await fetch(pdfUrl!, { credentials })
        if (res.ok) return await res.blob()
      } catch {
        /* CORS rejection: try the next mode */
      }
    }
    throw new Error('download failed')
  }

  const handleDownload = async () => {
    if (!pdfUrl) return
    try {
      const objectUrl = URL.createObjectURL(await fetchPdf())
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = downloadName(activity)
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
    } catch {
      window.open(pdfUrl, '_blank', 'noopener,noreferrer')
    }
  }

  // Sanar y Criar: "Descargar PDF" on the ebook page lands here with
  // `?download=1`; start the download once and drop the flag from the URL.
  const wantsDownload = new URLSearchParams(search).get('download') === '1'
  const downloadStartedRef = React.useRef(false)
  React.useEffect(() => {
    if (!wantsDownload || downloadStartedRef.current || !pdfUrl) return
    downloadStartedRef.current = true
    try {
      const url = new URL(window.location.href)
      url.searchParams.delete('download')
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    } catch {
      /* keep the URL as is */
    }
    handleDownload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsDownload, pdfUrl])

  // iOS Safari has no element fullscreen; opening the PDF on its own is the
  // closest it gets to a full-screen reader.
  const handleFullscreen = async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {})
      return
    }
    const el = containerRef.current
    if (el?.requestFullscreen) {
      try {
        await el.requestFullscreen()
        return
      } catch {
        /* fall through */
      }
    }
    if (pdfUrl) window.open(pdfUrl, '_blank', 'noopener,noreferrer')
  }

  const controlClass =
    'p-2 outline-none bg-black/50 hover:bg-black/70 focus-visible:ring-2 focus-visible:ring-white rounded-lg transition-colors'

  return (
    <div
      ref={containerRef}
      className={`group relative ${className ?? 'm-0 sm:m-8 bg-zinc-900 sm:rounded-md mt-0 sm:mt-14'} ${isFullscreen ? 'bg-zinc-900' : ''}`}
    >
      {canShowInline ? (
      <iframe
        className={className || isFullscreen ? 'w-full h-full' : 'sm:rounded-lg w-full h-[85vh] sm:h-[900px]'}
        src={linkedPage && pdfUrl ? `${pdfUrl}#page=${linkedPage}` : pdfUrl}
        title={activity?.name || t('editor.blocks.pdf_block.document_title')}
      />
      ) : (
        // Sanar y Criar: no inline viewer on this device: offer the file instead of a blank box.
        <div className="flex min-h-[320px] w-full items-center justify-center p-4 sm:p-8">
          <div className="w-full max-w-md rounded-[20px] bg-[#FFFCF9] p-6 text-center sm:p-8">
            <div className="mx-auto grid size-14 place-items-center rounded-full bg-[#EEEDFF] text-[#6559CA]">
              <FilePdf weight="duotone" className="h-7 w-7" />
            </div>
            <p className="mt-4 text-lg font-semibold text-[#190933]" dir="auto">
              {activity?.name || t('editor.blocks.pdf_block.document_title')}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-[#584F72]">
              {t(
                'sc_learning.pdf.no_viewer',
                'Este navegador no puede mostrar el PDF dentro de la página. Descárgalo o ábrelo con tu lector de PDF para leerlo con comodidad.'
              )}
            </p>
            <div className="mt-6 flex flex-col gap-3">
              <button
                type="button"
                onClick={handleDownload}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-[#190933] px-6 py-3 text-base font-semibold text-[#FDF5EE] transition-colors hover:bg-[#2B1A4F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7D75E2] focus-visible:ring-offset-2"
              >
                <DownloadSimple weight="bold" className="h-5 w-5" />
                {t('sc_learning.ebook.download', 'Descargar PDF')}
              </button>
              {pdfUrl && (
                <a
                  href={pdfUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-2 rounded-full border border-[#BBBBFF] bg-white px-6 py-3 text-base font-semibold text-[#190933] transition-colors hover:border-[#7D75E2] hover:bg-[#EEEDFF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7D75E2] focus-visible:ring-offset-2"
                >
                  <ArrowSquareOut weight="bold" className="h-5 w-5" />
                  {t('sc_learning.pdf.open', 'Abrir el PDF')}
                </a>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Always visible on touch screens, where there is no hover to reveal them. */}
      {canShowInline && (
      <div className="absolute top-2 end-2 flex gap-1 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          onClick={handleFullscreen}
          className={controlClass}
          title={t('editor.blocks.pdf_block.expand_pdf')}
          aria-label={t('editor.blocks.pdf_block.expand_pdf')}
        >
          {isFullscreen ? (
            <ArrowsIn weight="duotone" className="w-4 h-4 text-white" />
          ) : (
            <ArrowsOut weight="duotone" className="w-4 h-4 text-white" />
          )}
        </button>
        <button
          type="button"
          onClick={handleDownload}
          className={controlClass}
          title={t('editor.blocks.pdf_block.download_pdf')}
          aria-label={t('editor.blocks.pdf_block.download_pdf')}
        >
          <DownloadSimple weight="duotone" className="w-4 h-4 text-white" />
        </button>
      </div>
      )}
    </div>
  )
}

export default DocumentPdfActivity

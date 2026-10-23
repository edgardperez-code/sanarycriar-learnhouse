'use client'

// Sanar y Criar: small "Reanudando en mm:ss · Empezar desde el inicio" notice
// shown over the player when playback resumes from a saved position.
import React from 'react'
import { RotateCcw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatClock } from './progressLocal'

const AUTO_HIDE_MS = 6000

export default function ResumeToast({
  position,
  onRestart,
  onDismiss,
  autoHide = true,
}: {
  position: number
  onRestart: () => void
  onDismiss: () => void
  /** Start the hide timer (the player passes "playback started"). */
  autoHide?: boolean
}) {
  const { t } = useTranslation()

  // Stays while the video waits at the resumed point, so "Empezar desde el
  // inicio" is still there when the learner presses play.
  React.useEffect(() => {
    if (!autoHide) return
    const timer = setTimeout(onDismiss, AUTO_HIDE_MS)
    return () => clearTimeout(timer)
  }, [position, onDismiss, autoHide])

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-auto absolute top-3 start-3 z-[40] flex max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-full bg-[#190933]/90 py-1.5 ps-4 pe-1.5 text-[13px] font-medium text-[#FDF5EE] shadow-lg shadow-black/20 backdrop-blur-sm animate-in fade-in duration-300"
    >
      <span className="truncate">
        {t('sc_learning.resume.toast', 'Reanudando en {{time}}', { time: formatClock(position) })}
      </span>
      <span aria-hidden="true" className="text-[#BBBBFF]">·</span>
      <button
        type="button"
        onClick={onRestart}
        className="inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 font-semibold text-[#BBBBFF] transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BBBBFF]"
      >
        <RotateCcw size={13} strokeWidth={2} />
        {t('sc_learning.resume.restart', 'Empezar desde el inicio')}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('sc_learning.resume.dismiss', 'Cerrar aviso')}
        className="grid size-7 shrink-0 place-items-center rounded-full text-[#FDF5EE]/70 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BBBBFF]"
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  )
}

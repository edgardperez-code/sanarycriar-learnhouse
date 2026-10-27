'use client'
// Sanar y Criar: static mock of the marketing site's newsletter pop-up
// (web/src/components/islands/NewsletterPopup.tsx), drawn with the same brand
// tokens. It is inert: nothing inside can be focused, clicked or read twice by
// a screen reader. The mock screen is laid out at a real viewport width and
// shrunk with CSS zoom to fit the column, so the proportions match the site.
// The website is Spanish-only (left to right), so the mock is dir="ltr".
import React, { useEffect, useRef, useState } from 'react'
import { Check, EyeOff, Mail, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { NewsletterSettingsDraft } from './newsletterForm'
import { useNewsletterT } from './useNewsletterT'

type PreviewProps = {
  draft: NewsletterSettingsDraft
  device: 'desktop' | 'mobile'
  view: 'form' | 'success'
}

// Virtual screen sizes (CSS px). Desktop keeps a 16:10 frame; the phone is a
// common 360 px wide handset. Both grow taller if the texts need it.
const SCREEN = {
  desktop: { width: 800, height: 500 },
  mobile: { width: 360, height: 640 },
} as const

/** Zoom factor that fits `width` CSS px into the measured element. */
function useFitZoom(width: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(0.6)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const available = el.clientWidth
      if (available > 0) setZoom(Math.min(1, available / width))
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [width])
  return { ref, zoom }
}

/** Lavender circle with a pink dot (brand accent), as on the site. */
function BadgeIcon({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative inline-flex h-14 w-14 items-center justify-center rounded-full bg-lavanda-100 text-lavanda-700">
      {children}
      <span className="absolute -end-0.5 -top-0.5 h-3.5 w-3.5 rounded-full bg-rosa-300 ring-2 ring-nube" />
    </div>
  )
}

/** A few soft blocks that stand for the website behind the veil. */
function FakePage({ mobile }: { mobile: boolean }) {
  return (
    <div className="absolute inset-0 bg-nube">
      <div className="flex items-center justify-between border-b border-borde px-6 py-4">
        <div className="h-3 w-28 rounded-full bg-violeta/70" />
        {!mobile && (
          <div className="flex gap-4">
            <div className="h-2.5 w-14 rounded-full bg-violeta/25" />
            <div className="h-2.5 w-14 rounded-full bg-violeta/25" />
            <div className="h-2.5 w-14 rounded-full bg-violeta/25" />
          </div>
        )}
      </div>
      <div className="space-y-4 px-6 pt-10">
        <div className="h-2.5 w-24 rounded-full bg-rosa-300" />
        <div className="h-6 w-4/5 rounded-full bg-violeta/60" />
        <div className="h-6 w-3/5 rounded-full bg-violeta/60" />
        <div className="h-3 w-11/12 rounded-full bg-violeta/20" />
        <div className="h-3 w-4/5 rounded-full bg-violeta/20" />
        <div className="h-11 w-40 rounded-full bg-violeta/80" />
      </div>
    </div>
  )
}

export default function NewsletterPopupPreview({ draft, device, view }: PreviewProps) {
  const { nl } = useNewsletterT()
  const { t } = useTranslation()
  const mobile = device === 'mobile'
  const screen = SCREEN[device]
  const { ref, zoom } = useFitZoom(screen.width)
  const closeLabel = t('common.close')

  const card = (
    <div
      className={
        mobile
          ? 'relative z-10 w-full rounded-t-[24px] border border-borde bg-nube px-6 pb-6 pt-7 shadow-xl'
          : 'relative z-10 w-full max-w-md rounded-[20px] border border-borde bg-nube p-8 shadow-xl'
      }
    >
      {mobile && <div className="mx-auto -mt-3 mb-5 h-1.5 w-12 rounded-full bg-lavanda-300/70" />}

      <span
        className={`absolute inline-flex h-11 w-11 items-center justify-center rounded-full text-violeta-500 ${
          mobile ? 'end-2 top-2' : 'end-3 top-3'
        }`}
      >
        <X size={22} strokeWidth={2} />
      </span>

      {view === 'form' ? (
        <>
          <BadgeIcon>
            <Mail size={26} strokeWidth={1.75} />
          </BadgeIcon>
          <h3 className="mt-5 pe-8 font-['Playfair_Display',Georgia,serif] text-2xl font-semibold leading-snug text-violeta">
            {draft.title}
          </h3>
          <p className="mt-3 whitespace-pre-line text-[0.9875rem] leading-relaxed text-violeta-600">{draft.body}</p>

          <div className="mt-6">
            <label className="block text-[0.9375rem] font-semibold text-violeta">{nl('preview.email_label')}</label>
            <input
              type="email"
              disabled
              placeholder={nl('preview.email_placeholder')}
              className="mt-2 block w-full rounded-[12px] border border-borde bg-white px-4 py-3 text-base text-violeta placeholder:text-violeta-400"
            />
            <button
              type="button"
              disabled
              className="mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-full border-[1.5px] border-violeta bg-violeta px-6 py-3 text-center text-base font-semibold leading-tight text-nube"
            >
              {draft.button_label}
            </button>
          </div>

          <span className="mx-auto mt-2 flex min-h-11 w-fit items-center px-3 text-[0.9375rem] font-semibold text-lavanda-600 underline decoration-1 underline-offset-[0.2em]">
            {draft.dismiss_label}
          </span>

          <p className="mt-3 text-center text-sm leading-[1.55] text-violeta-400">
            {draft.privacy_note.trim() && <>{draft.privacy_note} </>}
            <span className="font-semibold text-lavanda-600 underline decoration-1 underline-offset-[0.2em]">
              {nl('preview.privacy_link')}
            </span>
          </p>
        </>
      ) : (
        <>
          <BadgeIcon>
            <Check size={28} strokeWidth={2} />
          </BadgeIcon>
          <p
            className={`mt-5 whitespace-pre-line pe-8 font-['Playfair_Display',Georgia,serif] font-semibold leading-snug text-violeta ${
              mobile ? 'text-xl' : 'text-2xl'
            }`}
          >
            {draft.success_message}
          </p>
          <span className="mt-7 inline-flex min-h-12 w-full items-center justify-center rounded-full border-[1.5px] border-violeta px-6 py-3 text-base font-semibold text-violeta">
            {closeLabel}
          </span>
        </>
      )}
    </div>
  )

  return (
    <div className="space-y-3">
      {!draft.enabled && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <EyeOff size={15} className="shrink-0" aria-hidden />
          <span>{nl('preview.disabled_note')}</span>
        </div>
      )}

      {/* Device frame: a browser window or a phone. */}
      <div
        className={
          mobile
            ? 'mx-auto w-full max-w-[320px] rounded-[2rem] border-8 border-violeta/85 bg-violeta/85 shadow-sm'
            : 'w-full overflow-hidden rounded-xl border border-borde bg-white shadow-sm'
        }
      >
        {!mobile && (
          <div aria-hidden className="flex items-center gap-1.5 border-b border-borde bg-blanco-calido px-3 py-2">
            <span className="h-2.5 w-2.5 rounded-full bg-rosa-300" />
            <span className="h-2.5 w-2.5 rounded-full bg-lavanda-300" />
            <span className="h-2.5 w-2.5 rounded-full bg-borde" />
          </div>
        )}
        <div ref={ref} className={mobile ? 'overflow-hidden rounded-[1.5rem]' : 'overflow-hidden'}>
          <div
            inert
            aria-hidden
            dir="ltr"
            className="relative flex font-sans select-none"
            style={{
              width: screen.width,
              minHeight: screen.height,
              zoom,
              alignItems: mobile ? 'flex-end' : 'center',
              justifyContent: 'center',
              padding: mobile ? 0 : 24,
            }}
          >
            <FakePage mobile={mobile} />
            <div className="absolute inset-0 bg-violeta/45" />
            {card}
          </div>
        </div>
      </div>

      <p className="text-xs text-gray-500">{nl('preview.approx_note')}</p>
    </div>
  )
}

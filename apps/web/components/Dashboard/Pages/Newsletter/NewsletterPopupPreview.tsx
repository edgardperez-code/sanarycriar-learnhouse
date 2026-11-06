'use client'
// Sanar y Criar: static mock of the marketing site's welcome pop-up
// (web/src/components/islands/NewsletterPopup.tsx), drawn with the same brand
// tokens. Since 2026-11 the pop-up offers the free guide: its button leads to
// the sign-up and the platform adds her to the letters once she is in, so
// there is no email field and no thank-you view (success_message is no longer
// shown anywhere). Computer: two columns, the gift drawn in CSS and the texts.
// Phone: a bottom sheet without the drawing, the body or the privacy note, as
// on the site. A word between asterisks in the title is the italic accent.
// It is inert: nothing inside can be focused, clicked or read twice by a
// screen reader. The mock screen is laid out at a real viewport width and
// shrunk with CSS zoom to fit the column, so the proportions match the site.
// The website is Spanish-only (left to right), so the mock is dir="ltr".
import React, { useEffect, useRef, useState } from 'react'
import { ArrowRight, EyeOff, UserRound, X } from 'lucide-react'
import { accentParts } from '@components/SanarYCriar/regalo'
import type { NewsletterSettingsDraft } from './newsletterForm'
import { useNewsletterT } from './useNewsletterT'

type PreviewProps = {
  draft: NewsletterSettingsDraft
  device: 'desktop' | 'mobile'
}

/** The free guide's title (site.funnel.giftTitle on the website): a book title, never translated. */
export const GIFT_TITLE = '¿Será que soy una mala mamá?'

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

/**
 * The free guide's cover, as the website's `.book .cover-free` (global.css):
 * sizes in container units, so it scales as one piece. The cover is artwork
 * (the ebook's printed title), so its words stay as they are.
 */
function GiftBook() {
  return (
    <div className="@container relative aspect-[4/5] w-[min(220px,100%)] rounded-[4px_14px_14px_4px] shadow-[24px_30px_50px_-22px_rgb(25_9_51/0.6),2px_2px_0_rgb(25_9_51/0.08)] [transform:rotateY(-14deg)_rotate(-3deg)]">
      <div className="absolute inset-0 flex flex-col overflow-hidden rounded-[inherit] bg-[radial-gradient(60%_45%_at_85%_12%,rgb(187_187_255/0.95),transparent_70%),radial-gradient(55%_40%_at_8%_92%,rgb(255_252_248/0.9),transparent_70%),linear-gradient(160deg,#f6c8e8_0%,var(--color-rosa-300)_55%,#e6b8ee_100%)] p-[9cqi_9cqi_8cqi_12cqi] text-violeta">
        <span className="self-start rounded-full bg-violeta px-[4cqi] py-[2.6cqi] text-[3.6cqi] font-semibold uppercase leading-none tracking-[0.12em] text-nube">
          Guía gratuita
        </span>
        <span className="font-heading mt-[9cqi] text-[8.4cqi] font-medium italic leading-[1.05]">¿Será que soy una</span>
        <span className="font-heading mt-[2cqi] text-[19cqi] font-black leading-[0.86] tracking-[-0.02em]">
          <span className="block">MALA</span>
          <span className="block">MAMÁ?</span>
        </span>
        <span className="font-heading mt-auto text-[4.6cqi] font-semibold leading-[1.2]">
          Hilda Hernández
          <small className="block font-sans text-[3cqi] font-medium uppercase leading-[1.4] tracking-[0.08em] text-violeta-600">
            Psicóloga infanto-juvenil
          </small>
        </span>
      </div>
      {/* Spine shade and page edges (the website's ::before / ::after). */}
      <span className="absolute inset-y-0 start-0 z-[3] w-[7%] rounded-s-[4px] bg-[linear-gradient(90deg,rgb(0_0_0/0.28),rgb(0_0_0/0)_70%),linear-gradient(90deg,rgb(255_255_255/0.25),rgb(255_255_255/0))]" />
      <span className="absolute -end-[9px] top-[2%] bottom-[2%] w-[10px] origin-left rounded-e-[4px] bg-[repeating-linear-gradient(180deg,#fffaf4_0_2px,#ece3da_2px_3px)] [transform:rotateY(60deg)]" />
    </div>
  )
}

export default function NewsletterPopupPreview({ draft, device }: PreviewProps) {
  const { nl } = useNewsletterT()
  const mobile = device === 'mobile'
  const screen = SCREEN[device]
  const { ref, zoom } = useFitZoom(screen.width)

  const panel = (
    <div
      className={
        mobile
          ? 'relative z-10 grid w-full rounded-t-[24px] bg-nube shadow-[0_40px_80px_-30px_rgba(25,9,51,0.7)]'
          : 'relative z-10 grid w-full max-w-[54rem] grid-cols-[0.85fr_1.15fr] overflow-hidden rounded-[24px] bg-nube shadow-[0_40px_80px_-30px_rgba(25,9,51,0.7)]'
      }
    >
      <span className="absolute end-3 top-3 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full bg-nube/90 text-violeta">
        <X size={20} strokeWidth={2} />
      </span>

      {/* The gift, drawn: only where there is room (not on phones). */}
      {!mobile && (
        <div className="relative grid place-items-center bg-rosa-200 bg-[radial-gradient(70%_50%_at_20%_15%,rgb(187_187_255/0.9),transparent_70%),radial-gradient(70%_55%_at_90%_95%,rgb(240_180_223/0.95),transparent_70%)] p-7">
          <span className="absolute start-4 top-4 rounded-full bg-violeta px-3 py-2 text-xs font-semibold uppercase tracking-[0.1em] text-nube">
            {nl('preview.gift_chip')}
          </span>
          <GiftBook />
        </div>
      )}

      <div className={mobile ? 'px-5 pb-[1.375rem] pt-6' : 'px-9 pb-8 pt-10'}>
        <div className="flex items-center gap-3 pe-12">
          {/* Hilda's photo lives on the website: a neutral circle stands for it. */}
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 border-rosa-300 bg-lavanda-100 text-lavanda-500">
            <UserRound size={20} strokeWidth={1.75} />
          </span>
          <span className="sc-eyebrow">{nl('preview.eyebrow')}</span>
        </div>
        <p
          className={`font-heading mt-3 font-semibold leading-tight text-violeta ${
            mobile ? 'pe-10 text-[1.7rem]' : 'text-[2.25rem]'
          }`}
        >
          {accentParts(draft.title).map((part, i) =>
            part.accent ? (
              <em key={i} className="sc-title-accent">
                {part.text}
              </em>
            ) : (
              <React.Fragment key={i}>{part.text}</React.Fragment>
            )
          )}
        </p>
        {/* On phones the site keeps the body for screen readers only. */}
        {!mobile && <p className="mt-3 whitespace-pre-line leading-relaxed text-violeta-600">{draft.body}</p>}

        <p className="mt-4 flex items-center gap-2.5 rounded-[12px] bg-rosa-200 px-3.5 py-3 text-[0.9rem] text-violeta-600">
          <span className="shrink-0 rounded-full bg-rosa-600 px-2.5 py-1.5 text-[0.6875rem] font-bold uppercase tracking-[0.1em] text-nube">
            {nl('preview.free_badge')}
          </span>
          <span>
            {nl('preview.free_line')} <strong className="font-semibold text-violeta">«{GIFT_TITLE}»</strong>
          </span>
        </p>

        <span className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-full border-[1.5px] border-violeta bg-violeta px-6 py-3 text-center text-base font-semibold leading-tight text-nube">
          {draft.button_label}
          <ArrowRight size={18} strokeWidth={2} className="shrink-0" />
        </span>

        <span className="mx-auto mt-2 flex min-h-11 w-fit items-center px-3 text-[0.9375rem] font-medium text-lavanda-600 underline decoration-1 underline-offset-[0.2em]">
          {draft.dismiss_label}
        </span>

        {!mobile && (
          <p className="mt-1 text-center text-sm leading-[1.55] text-violeta-400">
            {draft.privacy_note.trim() && <>{draft.privacy_note} </>}
            <span className="font-semibold text-lavanda-600 underline decoration-1 underline-offset-[0.2em]">
              {nl('preview.privacy_link')}
            </span>
          </p>
        )}
      </div>
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
            // The website's body text: 17 px Poppins, violeta-600.
            className="relative flex font-sans text-[1.0625rem] leading-[1.6] text-violeta-600 select-none"
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
            <div className={mobile ? 'absolute inset-0 bg-violeta/30' : 'absolute inset-0 bg-violeta/55 backdrop-blur-[3px]'} />
            {panel}
          </div>
        </div>
      </div>

      <p className="text-xs text-gray-500">{nl('preview.approx_note')}</p>
    </div>
  )
}

'use client'
import React from 'react'
import Link from 'next/link'
import { getOrgAuthBackgroundMediaDirectory } from '@services/media/media'
import { getUriWithOrg } from '@services/config/config'
import { cn } from '@/lib/utils'
import ScWordmark from '@components/Objects/Menus/ScWordmark'
import { SC_PROFESSIONAL } from '@components/Objects/Menus/scBrand'

interface AuthBrandingPanelProps {
  org: any
  welcomeText?: string
  // No-org (apex) panel copy: platform-style title + subtitle shown at the top
  // of the illustration. Falls back to the login wording when omitted.
  title?: string
  subtitle?: string
}

// Sanar y Criar: lavanda-100 panel with two soft watercolor stains (brand
// manual p.2: watercolors only on light backgrounds).
const BRAND_PANEL_BACKGROUND: React.CSSProperties = {
  background:
    'radial-gradient(26rem 20rem at 100% 0%, rgb(187 187 255 / 0.38), transparent 70%), ' +
    'radial-gradient(24rem 18rem at 0% 100%, rgb(240 180 223 / 0.3), transparent 70%), #EEEDFF',
}

// `welcomeText` (the page's own greeting) is no longer shown here: it repeats
// the form title. Kept in the props for the callers.
export default function AuthBrandingPanel({ org, title, subtitle }: AuthBrandingPanelProps) {
  const authBranding = org?.config?.config?.customization?.auth_branding || org?.config?.config?.general?.auth_branding || {}
  const {
    welcome_message = '',
    background_type = 'gradient',
    background_image = '',
    text_color = 'light',
    unsplash_photographer_name = '',
    unsplash_photographer_url = '',
    unsplash_photo_url = '',
  } = authBranding
  const UNSPLASH_UTM = '?utm_source=LearnHouse&utm_medium=referral'
  const withUtm = (url: string) => (url ? `${url}${UNSPLASH_UTM}` : '')

  // No org context (the generic apex login) → use the platform's auth
  // illustration instead of the flat gradient.
  const noOrg = !org

  const getBackgroundStyle = (): React.CSSProperties => {
    if (noOrg) {
      return {
        backgroundImage: 'url(/auth-default.png)',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }
    }
    if (background_type === 'gradient' || !background_image) {
      return BRAND_PANEL_BACKGROUND
    }
    if (background_type === 'custom' && background_image) {
      return {
        backgroundImage: `url(${getOrgAuthBackgroundMediaDirectory(org?.org_uuid, background_image)})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }
    }
    if (background_type === 'unsplash' && background_image) {
      return {
        backgroundImage: `url(${background_image})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }
    }
    return BRAND_PANEL_BACKGROUND
  }

  // No-org platform copy (defaults mirror the platform login illustration).
  const noOrgTitle = title || 'Welcome back to LearnHouse.'
  const noOrgSubtitle =
    subtitle || 'Pick up where you left off. Your courses, students, and tools are waiting.'
  // Treat the no-org illustration like a photo background: dark scrim, no
  // blueprint-grid overlay.
  const hasCustomBackground = noOrg || (background_type !== 'gradient' && background_image)

  return (
    <div className="relative h-full w-full">
      {/* Inset rounded card (platform-style) */}
      <div className="absolute inset-10 xl:inset-14 rounded-[20px] overflow-hidden">
        {/* Base layer: org's chosen background (gradient | custom | unsplash) */}
        <div className="absolute inset-0" style={getBackgroundStyle()} />

        {/* Dark scrim for org photo backgrounds (centered text needs it).
            The no-org illustration stays vivid; it's darkened only at the top. */}
        {hasCustomBackground && !noOrg && (
          <div className="absolute inset-0 bg-black/30" />
        )}

        {/* No-org: top blur + darken so the platform-style heading reads over
            the illustration (mirrors the platform login panel). */}
        {noOrg && (
          <>
            <div
              className="absolute top-0 start-0 end-0 h-[38%] z-[5] backdrop-blur-sm"
              style={{
                maskImage: 'linear-gradient(to bottom, black 10%, transparent 100%)',
                WebkitMaskImage: 'linear-gradient(to bottom, black 10%, transparent 100%)',
              }}
            />
            <div
              className="absolute top-0 start-0 end-0 h-[38%] z-[5] bg-black/35"
              style={{
                maskImage: 'linear-gradient(to bottom, black 10%, transparent 100%)',
                WebkitMaskImage: 'linear-gradient(to bottom, black 10%, transparent 100%)',
              }}
            />
          </>
        )}

        {/* Content */}
        <div className="relative z-10 flex flex-col h-full p-10">
          {noOrg ? (
            /* No-org apex panel, platform layout: heading at the TOP, no logo
               box, platform copy. */
            <div className="max-w-md text-white">
              <h1 className="font-black text-[28px] leading-tight tracking-tight">
                {noOrgTitle}
              </h1>
              <p className="mt-3 text-white/55 text-base font-medium leading-relaxed">
                {noOrgSubtitle}
              </p>
            </div>
          ) : (
            /* Sanar y Criar: brand panel (manual p.3 hero): wordmark, Hilda in
               the organic lavender-to-pink frame, eyebrow and a brand phrase
               (manual p.2). Only the org's own welcome message is added here;
               the page's welcome text is already the form title. */
            <div className={cn('flex flex-col h-full', hasCustomBackground ? 'sc-on-dark text-nube' : 'text-violeta')}>
              <Link prefetch href={getUriWithOrg(org?.slug, '/')} className="w-fit rounded-md">
                <ScWordmark size="lg" tone={hasCustomBackground ? 'light' : 'dark'} />
              </Link>
              {!hasCustomBackground && (
                <div className="flex-1 min-h-0 flex items-center justify-center py-6">
                  <div className="relative h-full max-h-[24rem] aspect-[100/108]">
                    <div
                      aria-hidden="true"
                      className="absolute inset-[5%_-3%_-2%_7%] rounded-[52%_48%_46%_54%/44%_50%_50%_56%] bg-[linear-gradient(150deg,var(--color-lavanda-300)_0%,var(--color-rosa-300)_100%)] opacity-80"
                    />
                    <div className="absolute inset-0 overflow-hidden rounded-[47%_53%_44%_56%/42%_44%_56%_58%] bg-[linear-gradient(165deg,var(--color-blanco-calido)_0%,var(--color-lavanda-100)_40%,var(--color-rosa-200)_100%)]">
                      <img
                        src="/sc-hilda.webp"
                        alt={`${SC_PROFESSIONAL.name}, ${SC_PROFESSIONAL.shortTitle.toLowerCase()}`}
                        width={720}
                        height={713}
                        className="absolute start-[-8.5%] top-[4.5%] h-auto w-[110%] max-w-none select-none"
                      />
                    </div>
                  </div>
                </div>
              )}
              <div className={cn('max-w-md', hasCustomBackground && 'mt-auto')}>
                <p className="sc-eyebrow">{SC_PROFESSIONAL.shortTitle} · {SC_PROFESSIONAL.license}</p>
                <p className="mt-3 font-display text-[2rem] xl:text-[2.375rem] font-semibold leading-[1.12] tracking-[-0.01em]">
                  Sanar tu historia para criar <em className="sc-title-accent">distinto</em>.
                </p>
                {welcome_message && (
                  <p className={cn('mt-3 text-[1.0625rem] leading-relaxed', hasCustomBackground ? 'text-nube/80' : 'text-violeta-600')}>
                    {welcome_message}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Unsplash attribution (required by Unsplash API guidelines) */}
          {background_type === 'unsplash' && background_image && unsplash_photographer_name && (
            <div className={cn(
              "absolute bottom-3 start-4 end-4 z-10 text-[11px] leading-tight",
              text_color === 'light' ? "text-white/70" : "text-gray-700"
            )}>
              Photo by{' '}
              <a
                href={withUtm(unsplash_photographer_url) || withUtm(unsplash_photo_url)}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:opacity-100 opacity-90"
              >
                {unsplash_photographer_name}
              </a>
              {' '}on{' '}
              <a
                href={`https://unsplash.com/${UNSPLASH_UTM}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:opacity-100 opacity-90"
              >
                Unsplash
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

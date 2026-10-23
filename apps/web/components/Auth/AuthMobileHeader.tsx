'use client'
import React from 'react'
import Link from 'next/link'
import { getOrgAuthBackgroundMediaDirectory } from '@services/media/media'
import { getUriWithOrg } from '@services/config/config'
import ScWordmark from '@components/Objects/Menus/ScWordmark'

interface AuthMobileHeaderProps {
  org: any
}

export default function AuthMobileHeader({ org }: AuthMobileHeaderProps) {
  const authBranding = org?.config?.config?.customization?.auth_branding || org?.config?.config?.general?.auth_branding || {}
  const {
    background_type = 'gradient',
    background_image = '',
    unsplash_photographer_name = '',
    unsplash_photographer_url = '',
    unsplash_photo_url = '',
  } = authBranding
  const UNSPLASH_UTM = '?utm_source=LearnHouse&utm_medium=referral'
  const withUtm = (url: string) => (url ? `${url}${UNSPLASH_UTM}` : '')

  // Sanar y Criar: a light brand bar (nube, borde) with the text wordmark;
  // an admin-chosen photo background still applies.
  const getBackgroundStyle = (): React.CSSProperties => {
    if (background_type === 'gradient' || !background_image) {
      return {}
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
    return {}
  }

  const hasCustomBackground = background_type !== 'gradient' && background_image

  return (
    <div
      className={`relative flex items-center gap-4 px-5 py-4 overflow-hidden ${hasCustomBackground ? 'rounded-b-[20px]' : 'border-b border-borde bg-nube/90'}`}
      style={getBackgroundStyle()}
    >
      {hasCustomBackground && (
        <div className="absolute inset-0 bg-black/30" />
      )}

      <Link prefetch href={getUriWithOrg(org?.slug, '/')} className="relative z-10 rounded-md">
        <ScWordmark tone={hasCustomBackground ? 'light' : 'dark'} />
      </Link>

      {/* Unsplash attribution (required by Unsplash API guidelines) */}
      {background_type === 'unsplash' && background_image && unsplash_photographer_name && (
        <span className="relative z-10 ms-auto text-[10px] leading-tight text-white/70 truncate max-w-[45%] text-end">
          Photo by{' '}
          <a
            href={withUtm(unsplash_photographer_url) || withUtm(unsplash_photo_url)}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            {unsplash_photographer_name}
          </a>
          {' '}on{' '}
          <a
            href={`https://unsplash.com/${UNSPLASH_UTM}`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Unsplash
          </a>
        </span>
      )}
    </div>
  )
}

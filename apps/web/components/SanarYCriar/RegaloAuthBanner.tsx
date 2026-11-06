'use client'
// Sanar y Criar: banner above the sign-up and login forms when their
// ?redirect is the gift page (/regalo…), saying what the account is for: the
// test result and the free ebook (contract "regalo" §B2).
import React from 'react'
import { Gift } from 'lucide-react'
import { regaloResultadoOf } from './regalo'
import { useLearningT } from './useLearningT'

interface RegaloAuthBannerProps {
  /** The canonical /regalo path of the ?redirect (regaloPathFrom), or null for no banner. */
  path: string | null
  mode: 'signup' | 'login'
}

export default function RegaloAuthBanner({ path, mode }: RegaloAuthBannerProps) {
  const { lt } = useLearningT()
  if (!path) return null
  const withResult = regaloResultadoOf(path) !== null
  let text: string
  if (mode === 'signup') text = withResult ? lt('regalo.banner.signup_result') : lt('regalo.banner.signup')
  else text = withResult ? lt('regalo.banner.login_result') : lt('regalo.banner.login')
  return (
    <div className="mt-6 flex items-start gap-3 rounded-[16px] border border-[#BBBBFF]/70 bg-[#EEEDFF] px-4 py-3">
      <Gift size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-[#6559CA]" aria-hidden="true" />
      <p className="text-sm font-semibold leading-relaxed text-[#190933]">{text}</p>
    </div>
  )
}

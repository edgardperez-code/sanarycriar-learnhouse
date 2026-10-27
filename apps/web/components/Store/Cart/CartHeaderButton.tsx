'use client'
// Sanar y Criar: cart icon of the public header (contract §D.3). Only shows
// when the cart has something. `variant="mobile"` is the "Carrito (2)" row of
// the mobile menu panel.
import React from 'react'
import Link from 'next/link'
import { ShoppingCartSimple } from '@phosphor-icons/react'
import { useOrg } from '@components/Contexts/OrgContext'
import { getUriWithOrg } from '@services/config/config'
import { useCart } from './useCart'
import { useCartT } from './useCartT'

function paymentsEnabled(org: any): boolean {
  const config = org?.config?.config
  return config?.resolved_features?.payments?.enabled ?? config?.features?.payments?.enabled !== false
}

export default function CartHeaderButton({
  orgslug,
  variant = 'desktop',
  onNavigate,
}: {
  orgslug: string
  variant?: 'desktop' | 'mobile'
  onNavigate?: () => void
}) {
  const org = useOrg() as any
  const { count } = useCart(org?.id)
  const { ct } = useCartT()

  if (!count || !paymentsEnabled(org)) return null
  const href = getUriWithOrg(orgslug, '/store/cart')

  if (variant === 'mobile') {
    return (
      <Link
        href={href}
        onClick={onNavigate}
        className="flex min-h-12 items-center gap-2 border-t border-borde py-3 text-base font-medium text-violeta-600"
      >
        <ShoppingCartSimple size={18} weight="regular" aria-hidden="true" />
        {ct('header.mobile_label', { count })}
      </Link>
    )
  }

  // Phones: a compact icon next to the menu button, only from 390px wide;
  // narrower, the wordmark's subtitle would be cut off and the cart stays
  // reachable from the menu row and the page's own buttons.
  return (
    <Link
      href={href}
      aria-label={ct('header.aria', { count })}
      className="relative hidden min-[390px]:inline-flex md:inline-flex h-11 w-9 -me-1.5 md:me-0 md:h-auto md:w-auto items-center justify-center rounded-full md:rounded-lg md:p-2 text-violeta hover:bg-lavanda-100 transition-colors"
    >
      <ShoppingCartSimple size={22} weight="regular" aria-hidden="true" />
      <span
        aria-hidden="true"
        className="absolute top-1 -end-1 md:-top-0.5 md:-end-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-rosa-600 text-white text-[11px] font-bold leading-[18px] text-center"
      >
        {count}
      </span>
    </Link>
  )
}

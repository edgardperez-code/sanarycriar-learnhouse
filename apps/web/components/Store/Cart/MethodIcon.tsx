'use client'
// Sanar y Criar: the icon of a manual payment method (cart, order page, Mis
// compras, offer page). Always decorative: the method's name is next to it.
import React from 'react'
import { SiBinance, SiZelle } from '@icons-pack/react-simple-icons'
import { Landmark, Smartphone } from 'lucide-react'

export function MethodIcon({
  method,
  size = 18,
  className = '',
}: {
  method: string | null | undefined
  size?: number
  className?: string
}) {
  // The brand marks are filled: a little smaller looks the same size as the
  // outlined lucide icons.
  const brandSize = Math.max(10, size - 2)
  switch (method) {
    case 'transferencia':
      return <Landmark size={size} className={className} aria-hidden="true" />
    case 'zelle':
      return <SiZelle size={brandSize} className={className} aria-hidden="true" title="" />
    case 'binance':
      return <SiBinance size={brandSize} className={className} aria-hidden="true" title="" />
    default:
      return <Smartphone size={size} className={className} aria-hidden="true" />
  }
}

export default MethodIcon

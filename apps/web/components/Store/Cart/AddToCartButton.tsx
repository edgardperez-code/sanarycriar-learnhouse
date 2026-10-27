'use client'
// Sanar y Criar: "Agregar al carrito" (store cards and offer page). Once the
// product is in the cart it becomes a link: "En el carrito ✓ · Ver carrito".
// Adding needs no session: the login is asked for when paying.
//
// The button is replaced by the link, so keyboard and screen-reader users
// would lose their place: focus moves to the new link and a polite live
// region says "Agregado al carrito".
import React, { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import toast from 'react-hot-toast'
import { ShoppingCart } from 'lucide-react'
import { getUriWithOrg } from '@services/config/config'
import { useCart } from './useCart'
import { useCartT } from './useCartT'

const BASE =
  'w-full inline-flex items-center justify-center gap-2 rounded-full font-semibold text-sm px-5 min-h-[44px] py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7D75E2] focus-visible:ring-offset-2'

const STYLES = {
  primary: 'bg-[#190933] hover:bg-[#41375B] text-white',
  secondary: 'bg-white hover:bg-[#EEEDFF] text-[#190933] border border-[#BBBBFF]',
}

export function AddToCartButton({
  orgslug,
  offerUuid,
  variant = 'secondary',
  className = '',
}: {
  orgslug: string
  offerUuid: string
  variant?: 'primary' | 'secondary'
  className?: string
}) {
  const { ct } = useCartT()
  const cart = useCart()
  const inCart = cart.has(offerUuid)
  const linkRef = useRef<HTMLAnchorElement>(null)
  const focusLinkNext = useRef(false)
  const [announcement, setAnnouncement] = useState('')

  useEffect(() => {
    if (inCart && focusLinkNext.current) {
      focusLinkNext.current = false
      linkRef.current?.focus()
    }
  }, [inCart])

  const onAdd = () => {
    const result = cart.add(offerUuid)
    if (result === 'added' || result === 'exists') {
      focusLinkNext.current = true
      setAnnouncement(ct('add.added_live'))
    } else if (result === 'full') {
      toast.error(ct('add.full'))
    } else {
      toast.error(ct('add.invalid'))
    }
  }

  return (
    <>
      {inCart ? (
        <Link
          ref={linkRef}
          href={getUriWithOrg(orgslug, '/store/cart')}
          className={`${BASE} bg-[#EEEDFF] hover:bg-[#E2E0FF] text-[#4F43A4] ${className}`}
        >
          <ShoppingCart size={15} aria-hidden="true" />
          {ct('add.in_cart')}
        </Link>
      ) : (
        <button type="button" onClick={onAdd} className={`${BASE} ${STYLES[variant]} ${className}`}>
          <ShoppingCart size={15} aria-hidden="true" />
          {ct('add.add_to_cart')}
        </button>
      )}
      {/* Always mounted, so screen readers notice when the text appears. */}
      <span role="status" className="sr-only">
        {announcement}
      </span>
    </>
  )
}

export default AddToCartButton

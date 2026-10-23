'use client'
// Sanar y Criar: translated "store not available" state (the store page is a
// server component and cannot use the i18n hook itself).
import React from 'react'
import { ShoppingBag } from 'lucide-react'
import { useScT } from './useScT'

export default function StoreUnavailable() {
  const { sc } = useScT()
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4">
      <div className="w-16 h-16 rounded-2xl bg-[#EEEDFF] flex items-center justify-center mb-4">
        <ShoppingBag size={28} className="text-[#6559CA]" strokeWidth={1.5} />
      </div>
      <h2 className="text-xl font-bold text-[#190933] mb-2">{sc('store.unavailable_title')}</h2>
      <p className="text-[#584F72] text-sm max-w-sm">{sc('store.unavailable_description')}</p>
    </div>
  )
}

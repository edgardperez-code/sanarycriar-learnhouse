'use client'
// Sanar y Criar: the buyer's Pago Móvil orders (GET purchases/mine). Any
// failure (no session, payments off, API not deployed) is an empty list: the
// callers only use it to show extra notices.
import { useQuery } from '@tanstack/react-query'
import { getMyPurchases } from '@services/payments/cart'
import { cartKeys } from './cartKeys'
import type { Purchase } from './types'

export function useMyPurchases(orgId: number | null | undefined, token: string | null | undefined) {
  const query = useQuery<Purchase[]>({
    queryKey: cartKeys.mine(orgId as number),
    queryFn: async () => {
      const res = await getMyPurchases(orgId as number, token as string)
      if (!res.success) return []
      const items = res.data?.items
      return Array.isArray(items) ? (items as Purchase[]) : []
    },
    enabled: !!orgId && !!token,
    staleTime: 30_000,
    retry: false,
  })
  return { purchases: query.data ?? [], isLoading: query.isLoading && !!orgId && !!token }
}

export default useMyPurchases

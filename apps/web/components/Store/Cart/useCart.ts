'use client'
// Sanar y Criar: the cart of the current organization as React state.
// The source of truth is lib/sc-cart.ts (localStorage, shared by every tab);
// this hook only subscribes to it.
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useOrg } from '@components/Contexts/OrgContext'
import {
  addToCart,
  clearCart,
  readCart,
  removeFromCart,
  removeManyFromCart,
  subscribeCart,
  type AddResult,
  type CartItem,
} from '@/lib/sc-cart'

// The snapshot is a string so React can compare it by value.
const EMPTY_SNAPSHOT = '[]'
const noopSubscribe = () => () => {}

export function useCart(orgIdOverride?: number | null) {
  const org = useOrg() as any
  const orgId: number | null = orgIdOverride ?? org?.id ?? null

  const snapshot = useSyncExternalStore(
    subscribeCart,
    () => (orgId == null ? EMPTY_SNAPSHOT : JSON.stringify(readCart(orgId).items)),
    // Server render and hydration: empty. The real cart appears right after.
    () => EMPTY_SNAPSHOT
  )
  // False during the server render and hydration (the cart is not known yet).
  const ready = useSyncExternalStore(noopSubscribe, () => true, () => false)

  const items = useMemo<CartItem[]>(() => {
    try {
      const parsed = JSON.parse(snapshot)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }, [snapshot])
  const uuids = useMemo(() => items.map((i) => i.offer_uuid), [items])

  const add = useCallback(
    (offerUuid: string): AddResult => (orgId == null ? 'invalid' : addToCart(orgId, offerUuid)),
    [orgId]
  )
  const remove = useCallback(
    (offerUuid: string) => (orgId == null ? false : removeFromCart(orgId, offerUuid)),
    [orgId]
  )
  const removeMany = useCallback(
    (offerUuids: readonly string[]) => (orgId == null ? 0 : removeManyFromCart(orgId, offerUuids)),
    [orgId]
  )
  const clear = useCallback(() => {
    if (orgId != null) clearCart(orgId)
  }, [orgId])
  const has = useCallback(
    (offerUuid: string | null | undefined) => !!offerUuid && uuids.includes(offerUuid.toLowerCase()),
    [uuids]
  )

  return { orgId, ready, items, uuids, count: items.length, add, remove, removeMany, clear, has }
}

export default useCart

// Sanar y Criar: react-query keys of the cart and the buyer's orders.
// All of them hang from ['payments', orgId, …], so invalidating
// ['payments', orgId] (refreshOwnership on the offer page, a confirmed order)
// refreshes them too.
export const cartKeys = {
  /** The quote depends on who asks (owned / pending products), hence `viewer`. */
  quote: (orgId: number, uuids: readonly string[], viewer: string = 'anonymous') =>
    ['payments', orgId, 'cart', 'quote', viewer, uuids.join(',')] as const,
  mine: (orgId: number) => ['payments', orgId, 'purchases', 'mine'] as const,
  purchase: (orgId: number, uuid: string) => ['payments', orgId, 'purchases', 'detail', uuid] as const,
}

export default cartKeys

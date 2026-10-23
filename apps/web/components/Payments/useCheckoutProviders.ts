'use client'
// Sanar y Criar: active payment providers (public), shared by the checkout
// buttons and the admin offer forms (supported currencies).
import { useQuery } from '@tanstack/react-query'
import { getCheckoutProviders } from '@services/payments/checkout'

export interface CheckoutProvider {
  provider: string
  label?: string
  environment?: 'sandbox' | 'live' | string
  /** Sandbox on a production instance: only the team can buy (test purchases). */
  test_mode?: boolean
  client_id?: string
  methods: string[]
  currencies: string[]
}

export const checkoutProvidersKey = (orgId: number | undefined) => ['payments', orgId, 'checkout-providers'] as const

export function useCheckoutProviders(orgId: number | undefined) {
  const query = useQuery<CheckoutProvider[]>({
    queryKey: checkoutProvidersKey(orgId),
    queryFn: async () => {
      const res = await getCheckoutProviders(orgId as number)
      if (!res.success) throw new Error(`providers lookup failed (${res.status})`)
      return Array.isArray(res.data)
        ? res.data.map((p: any) => ({
            ...p,
            methods: Array.isArray(p?.methods) ? p.methods : [],
            currencies: Array.isArray(p?.currencies) ? p.currencies : [],
          }))
        : []
    },
    enabled: !!orgId,
    staleTime: 60_000,
  })

  const providers = query.data ?? []
  // Currencies any active provider can charge; USD is the platform default.
  const currencies = Array.from(new Set(providers.flatMap((p) => p.currencies.map((c) => c.toUpperCase()))))

  return {
    providers,
    currencies: currencies.length ? currencies : ['USD'],
    isLoading: query.isLoading,
    isError: query.isError,
  }
}

export default useCheckoutProviders

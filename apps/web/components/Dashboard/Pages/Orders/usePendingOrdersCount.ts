'use client'
// Sanar y Criar: how many Pago Móvil orders wait for confirmation, for the
// "Pedidos (3)" menu label. Asked only for someone who can manage the org,
// with a session and with payments on; every 60 s and again when the window
// gets the focus back. A 403 (not an admin after all) or a 404 (an API
// without orders) counts as 0 and stops asking; a 401 (the session is being
// renewed) counts as 0 and keeps asking.
import { useQuery } from '@tanstack/react-query'
import { useOrg } from '@components/Contexts/OrgContext'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import useAdminStatus from '@components/Hooks/useAdminStatus'
import { queryKeys } from '@/lib/query/keys'
import { getPurchasesSummary } from '@services/payments/orders'

export const SUMMARY_REFRESH_MS = 60_000

type Summary = { pending: number; off: boolean }

export function usePendingOrdersCount(): number {
  const org = useOrg() as any
  const session = useLHSession() as any
  const { canManageOrg } = useAdminStatus()
  const orgId: number | undefined = org?.id
  const accessToken: string | undefined = session?.data?.tokens?.access_token
  const paymentsOn = org?.config?.config?.resolved_features?.payments?.enabled === true

  const { data } = useQuery<Summary>({
    queryKey: queryKeys.orders.summary(orgId as number),
    queryFn: async () => {
      const res = await getPurchasesSummary(orgId as number, accessToken as string)
      if (res.status === 403 || res.status === 404) return { pending: 0, off: true }
      if (res.status === 401) return { pending: 0, off: false }
      if (!res.success) throw new Error(`orders summary failed (${res.status})`)
      const pending = Math.floor(Number(res.data?.pending))
      return { pending: Number.isFinite(pending) && pending > 0 ? pending : 0, off: false }
    },
    enabled: !!(orgId && accessToken && paymentsOn && canManageOrg),
    staleTime: 30_000,
    refetchInterval: (query) => (query.state.data?.off ? false : SUMMARY_REFRESH_MS),
    refetchOnWindowFocus: (query) => (query.state.data?.off ? false : 'always'),
    retry: 1,
  })

  return canManageOrg ? data?.pending ?? 0 : 0
}

export default usePendingOrdersCount

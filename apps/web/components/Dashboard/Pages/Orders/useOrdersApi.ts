'use client'
// Sanar y Criar: react-query hooks for the "Pedidos" dashboard (list, one
// order, Pago Móvil settings) and the error type they throw.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useOrg } from '@components/Contexts/OrgContext'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import { queryKeys } from '@/lib/query/keys'
import { getManualSettings, getPurchaseAdmin, getPurchasesAdmin } from '@services/payments/orders'
import {
  EMPTY_COUNTS,
  ManualSettings,
  ORDERS_PAGE_SIZE,
  OrderTab,
  PurchaseAdmin,
  PurchasesPage,
} from './ordersForm'

/** The list refreshes itself this often while the tab is visible. */
export const LIST_REFRESH_MS = 30_000
/** An open order refreshes itself this often (and when the window gets the focus back). */
export const DETAIL_REFRESH_MS = 15_000

/** A failed call, with the HTTP status and the API's body (detail.code, detail.message). */
export class OrdersRequestError extends Error {
  status: number
  data: any

  constructor(status: number, data: any) {
    super(`Orders request failed (${status})`)
    this.name = 'OrdersRequestError'
    this.status = status
    this.data = data
  }
}

/** Throws an OrdersRequestError for a failed `{success, data, status}` result. */
export function unwrap<T>(res: { success: boolean; data: any; status: number }): T {
  if (!res?.success) throw new OrdersRequestError(res?.status ?? 0, res?.data)
  return res.data as T
}

export function isForbidden(error: unknown): boolean {
  return error instanceof OrdersRequestError && (error.status === 401 || error.status === 403)
}

export function isNotFound(error: unknown): boolean {
  return error instanceof OrdersRequestError && error.status === 404
}

// A permission error or a missing row will not fix itself on retry.
const retryUnlessFinal = (failureCount: number, error: unknown) =>
  !(error instanceof OrdersRequestError && [401, 403, 404].includes(error.status)) && failureCount < 2

/** The org id and the access token every call needs. */
export function useOrdersAuth() {
  const org = useOrg() as any
  const session = useLHSession() as any
  const accessToken: string | undefined = session?.data?.tokens?.access_token
  const orgId: number = org?.id
  return { orgId, accessToken, ready: !!(orgId && accessToken) }
}

export function useManualSettings() {
  const { orgId, accessToken, ready } = useOrdersAuth()
  return useQuery<ManualSettings, OrdersRequestError>({
    queryKey: queryKeys.orders.manualSettings(orgId),
    queryFn: async () => unwrap<ManualSettings>(await getManualSettings(orgId, accessToken as string)),
    enabled: ready,
    staleTime: 60_000,
    retry: retryUnlessFinal,
  })
}

function normalizePage(data: any): PurchasesPage {
  const items: PurchaseAdmin[] = Array.isArray(data?.items) ? data.items : []
  const total = Number(data?.total)
  return {
    items,
    total: Number.isFinite(total) && total >= 0 ? total : items.length,
    counts: { ...EMPTY_COUNTS, ...(data?.counts && typeof data.counts === 'object' ? data.counts : {}) },
  }
}

export function usePurchasesList(params: { status: OrderTab; q: string; offset: number }) {
  const { orgId, accessToken, ready } = useOrdersAuth()
  const { status, q, offset } = params
  return useQuery<PurchasesPage, OrdersRequestError>({
    queryKey: queryKeys.orders.list(orgId, status, q, offset),
    queryFn: async () =>
      normalizePage(
        unwrap<PurchasesPage>(
          await getPurchasesAdmin(orgId, { status, q, offset, limit: ORDERS_PAGE_SIZE }, accessToken as string)
        )
      ),
    enabled: ready,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
    // react-query pauses the interval while the browser tab is hidden.
    refetchInterval: LIST_REFRESH_MS,
    retry: retryUnlessFinal,
  })
}

/**
 * One order, fresh from the API (the list row shows meanwhile). Mounted only
 * while its dialog is open, so the 15 s refresh and the refetch on focus stop
 * when it closes.
 */
export function usePurchaseDetail(purchaseUuid: string | null, placeholder?: PurchaseAdmin | null) {
  const { orgId, accessToken, ready } = useOrdersAuth()
  return useQuery<PurchaseAdmin, OrdersRequestError>({
    queryKey: queryKeys.orders.detail(orgId, purchaseUuid ?? ''),
    queryFn: async () => unwrap<PurchaseAdmin>(await getPurchaseAdmin(orgId, purchaseUuid as string, accessToken as string)),
    enabled: ready && !!purchaseUuid,
    placeholderData: placeholder ?? undefined,
    staleTime: 0,
    // A missing order or a lost permission will not come back by asking again.
    refetchInterval: (query) => (isForbidden(query.state.error) || isNotFound(query.state.error) ? false : DETAIL_REFRESH_MS),
    refetchOnWindowFocus: 'always',
    retry: retryUnlessFinal,
  })
}

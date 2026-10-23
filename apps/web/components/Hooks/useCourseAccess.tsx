'use client'
// Sanar y Criar: "is this course/ebook mine?" from GET /payments/{org}/access.
// This is the source of truth for ownership (not the TrailRun), see spec 4.1.
import { useQuery } from '@tanstack/react-query'
import { useOrg } from '@components/Contexts/OrgContext'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import { getResourceAccess } from '@services/payments/checkout'
import { toCourseResourceUuid } from '@components/Payments/commerce'

export type AccessReason = 'free' | 'purchased' | 'admin' | 'author' | 'anonymous' | 'none'

export interface ResourceAccess {
  for_sale: boolean
  has_access: boolean
  reason: AccessReason
  offers_count: number
  /** A payment of an offer covering it is under review: do not offer to buy again. */
  payment_pending?: boolean
}

/** Query key prefix; invalidating ['payments', orgId] also refreshes it. */
export const courseAccessKey = (orgId: number | undefined, resourceUuid: string | null, viewer: string) =>
  ['payments', orgId, 'access', resourceUuid, viewer] as const

export function useCourseAccess(courseUuid: string | null | undefined) {
  const org = useOrg() as any
  const session = useLHSession() as any
  const accessToken: string | undefined = session?.data?.tokens?.access_token
  const viewer: string = session?.data?.user?.user_uuid ?? session?.data?.user?.id?.toString() ?? 'anonymous'
  const resourceUuid = toCourseResourceUuid(courseUuid)
  const sessionReady = session?.status !== 'loading'

  const query = useQuery<ResourceAccess>({
    queryKey: courseAccessKey(org?.id, resourceUuid, viewer),
    queryFn: async () => {
      const res = await getResourceAccess(org.id, resourceUuid!, accessToken)
      if (!res.success || !res.data || typeof res.data.for_sale !== 'boolean') {
        throw new Error(`access check failed (${res.status})`)
      }
      return res.data as ResourceAccess
    },
    enabled: !!org?.id && !!resourceUuid && sessionReady,
    staleTime: 30_000,
    retry: 1,
  })

  return {
    access: query.data ?? null,
    // Still waiting on the session counts as loading: the answer depends on it.
    isLoading: !sessionReady || query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  }
}

export default useCourseAccess

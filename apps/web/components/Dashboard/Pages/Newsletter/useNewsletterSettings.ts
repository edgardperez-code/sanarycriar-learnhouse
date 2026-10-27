'use client'
// Sanar y Criar: the newsletter settings query, shared by the page header
// (Resend button) and both tabs so they read one cache entry.
import { useQuery } from '@tanstack/react-query'
import { useOrg } from '@components/Contexts/OrgContext'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import { queryKeys } from '@/lib/query/keys'
import { getNewsletterSettings } from '@services/newsletter/newsletter'
import type { NewsletterAdminSettings } from './newsletterForm'

/** A failed newsletter API call, with the HTTP status and the API's detail. */
export class NewsletterRequestError extends Error {
  status: number
  detail?: string

  constructor(status: number, detail?: string) {
    super(detail || `Newsletter request failed (${status})`)
    this.name = 'NewsletterRequestError'
    this.status = status
    this.detail = detail
  }
}

/** The API's `detail` when it is a plain message (pagos-style 4xx), else undefined. */
export function apiDetail(data: any): string | undefined {
  return typeof data?.detail === 'string' && data.detail.trim() ? data.detail : undefined
}

export function isForbidden(error: unknown): boolean {
  return error instanceof NewsletterRequestError && (error.status === 401 || error.status === 403)
}

export function useNewsletterSettings() {
  const org = useOrg() as any
  const session = useLHSession() as any
  const accessToken: string | undefined = session?.data?.tokens?.access_token
  const orgId: number = org?.id

  return useQuery<NewsletterAdminSettings, NewsletterRequestError>({
    queryKey: queryKeys.newsletter.settings(orgId),
    queryFn: async () => {
      const res = await getNewsletterSettings(orgId, accessToken as string)
      if (!res.success) throw new NewsletterRequestError(res.status, apiDetail(res.data))
      return res.data as NewsletterAdminSettings
    },
    enabled: !!(orgId && accessToken),
    staleTime: 30_000,
    // A permission error will not fix itself on retry.
    retry: (failureCount, error) => !isForbidden(error) && failureCount < 2,
  })
}

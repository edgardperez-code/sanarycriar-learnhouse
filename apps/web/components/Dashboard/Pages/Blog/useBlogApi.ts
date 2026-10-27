'use client'
// Sanar y Criar: react-query hooks for the blog dashboard (config, list, post,
// AI jobs) and the error type every blog call throws.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useOrg } from '@components/Contexts/OrgContext'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import { queryKeys } from '@/lib/query/keys'
import {
  getActiveBlogJob,
  getBlogConfig,
  getBlogJob,
  getBlogPost,
  getBlogPosts,
} from '@services/blog/blog'
import {
  AdminPost,
  AdminPostPage,
  BlogConfig,
  BlogJob,
  DEFAULT_POLL_MS,
  JOB_CLIENT_TIMEOUT_SECONDS,
  jobElapsedSeconds,
  jobIsActive,
} from './blogForm'

export const BLOG_PAGE_SIZE = 20

/** A failed blog API call, with the HTTP status and the API's detail. */
export class BlogRequestError extends Error {
  status: number
  detail?: string

  constructor(status: number, detail?: string) {
    super(detail || `Blog request failed (${status})`)
    this.name = 'BlogRequestError'
    this.status = status
    this.detail = detail
  }
}

/** The API's `detail` when it is a plain message (our 4xx/5xx), else undefined. */
export function apiDetail(data: any): string | undefined {
  return typeof data?.detail === 'string' && data.detail.trim() ? data.detail : undefined
}

export function isForbidden(error: unknown): boolean {
  return error instanceof BlogRequestError && (error.status === 401 || error.status === 403)
}

/** Throws a BlogRequestError for a failed `{success, data, status}` result. */
export function unwrap<T>(res: { success: boolean; data: any; status: number }): T {
  if (!res.success) throw new BlogRequestError(res.status, apiDetail(res.data))
  return res.data as T
}

// A permission error or a missing row will not fix itself on retry.
const retryUnlessFinal = (failureCount: number, error: unknown) =>
  !(error instanceof BlogRequestError && [401, 403, 404].includes(error.status)) && failureCount < 2

/** The org id and the access token every blog call needs. */
export function useBlogAuth() {
  const org = useOrg() as any
  const session = useLHSession() as any
  const accessToken: string | undefined = session?.data?.tokens?.access_token
  const orgId: number = org?.id
  return { orgId, accessToken, ready: !!(orgId && accessToken) }
}

export function useBlogConfig() {
  const { orgId, accessToken, ready } = useBlogAuth()
  return useQuery<BlogConfig, BlogRequestError>({
    queryKey: queryKeys.blog.config(orgId),
    queryFn: async () => unwrap<BlogConfig>(await getBlogConfig(orgId, accessToken as string)),
    enabled: ready,
    staleTime: 60_000,
    retry: retryUnlessFinal,
  })
}

export function useBlogPosts(params: { page: number; q: string; status: string }) {
  const { orgId, accessToken, ready } = useBlogAuth()
  const { page, q, status } = params
  return useQuery<AdminPostPage, BlogRequestError>({
    queryKey: queryKeys.blog.posts(orgId, page, q, status),
    queryFn: async () =>
      unwrap<AdminPostPage>(
        await getBlogPosts(orgId, { page, limit: BLOG_PAGE_SIZE, q, status }, accessToken as string)
      ),
    enabled: ready,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    retry: retryUnlessFinal,
  })
}

export function useBlogPost(postId: number | null) {
  const { orgId, accessToken, ready } = useBlogAuth()
  return useQuery<AdminPost, BlogRequestError>({
    queryKey: queryKeys.blog.post(orgId, postId ?? 0),
    queryFn: async () => unwrap<AdminPost>(await getBlogPost(orgId, postId as number, accessToken as string)),
    enabled: ready && !!postId,
    staleTime: 30_000,
    // The form is reset from this query: a background refetch must not wipe edits.
    refetchOnWindowFocus: false,
    retry: retryUnlessFinal,
  })
}

/**
 * The org's pending/running AI job (or null). Fetched when a page mounts and
 * then kept as is: the job itself is followed with useBlogJob, and the pages
 * write this entry when they start or finish a job.
 */
export function useActiveBlogJob() {
  const { orgId, accessToken, ready } = useBlogAuth()
  return useQuery<BlogJob | null, BlogRequestError>({
    queryKey: queryKeys.blog.activeJob(orgId),
    queryFn: async () => {
      const data = unwrap<{ job: BlogJob | null }>(await getActiveBlogJob(orgId, accessToken as string))
      return data?.job ?? null
    },
    enabled: ready,
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: retryUnlessFinal,
  })
}

/** True when a job has looked active for longer than the client waits. */
export function jobTimedOut(job: BlogJob | null | undefined, updatedAt: number, now: number): boolean {
  return jobIsActive(job) && jobElapsedSeconds(job, updatedAt, now) > JOB_CLIENT_TIMEOUT_SECONDS
}

/** Polls one AI job every `poll_after_ms` while it is pending/running. */
export function useBlogJob(jobId: number | null) {
  const { orgId, accessToken, ready } = useBlogAuth()
  return useQuery<BlogJob, BlogRequestError>({
    queryKey: queryKeys.blog.job(orgId, jobId ?? 0),
    queryFn: async () => unwrap<BlogJob>(await getBlogJob(orgId, jobId as number, accessToken as string)),
    enabled: ready && !!jobId,
    retry: 2,
    staleTime: 0,
    refetchInterval: (query) => {
      const job = query.state.data
      if (!jobIsActive(job)) return false
      // Safety cut: the API marks a job stale after 10 minutes; past 11 the
      // page stops asking and tells her to come back later.
      if (jobTimedOut(job, query.state.dataUpdatedAt, Date.now())) return false
      const wait = Number(job?.poll_after_ms)
      return wait >= 1000 ? wait : DEFAULT_POLL_MS
    },
  })
}

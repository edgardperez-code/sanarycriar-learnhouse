'use client'

// Sanar y Criar: learner progress queries (video position, last page).
import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import { queryKeys } from '@lib/query/keys'
import {
  getActivityProgress,
  getCourseProgress,
  type ActivityProgressRow,
  type CourseProgress,
} from '@services/courses/progress'
import {
  cleanActivityUuid,
  cleanCourseUuid,
  isLocalFresh,
  isLocalNewer,
  mergeCourseProgress,
  readLocalActivityProgress,
  readLocalCourseLast,
  sessionUserKey,
} from '@components/SanarYCriar/progressLocal'

// A 4xx (signed out, not bought, route missing) won't change on retry.
const retryUnlessClientError = (failureCount: number, error: any) => {
  const status = Number(error?.status)
  if (status >= 400 && status < 500) return false
  return failureCount < 2
}

/**
 * Progress of the signed-in learner on one course: the last activity touched
 * and the position on every activity. Disabled for anonymous visitors.
 */
export function useCourseProgress(courseUuid: string | undefined, options: { enabled?: boolean } = {}) {
  const session = useLHSession() as any
  const accessToken = session?.data?.tokens?.access_token as string | undefined
  const authenticated = session?.status === 'authenticated' && !!accessToken
  const clean = cleanCourseUuid(courseUuid)
  const userKey = sessionUserKey(session)

  const query = useQuery<CourseProgress>({
    queryKey: queryKeys.progress.course(clean),
    queryFn: () => getCourseProgress(clean, accessToken),
    enabled: !!clean && authenticated && options.enabled !== false,
    staleTime: 15_000,
    retry: retryUnlessClientError,
  })

  const merged = React.useMemo(
    () => (clean && authenticated ? mergeCourseProgress(query.data, readLocalCourseLast(userKey, clean)) : undefined),
    // dataUpdatedAt: re-read the local mirror whenever the server copy refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query.data, query.dataUpdatedAt, clean, authenticated, userKey]
  )

  return { ...query, data: merged }
}

/**
 * The learner's saved position on one activity. Server copy for signed-in
 * learners, merged with this device's mirror (the fresher one wins).
 */
export function useActivityProgress(activityUuid: string | undefined, options: { enabled?: boolean } = {}) {
  const session = useLHSession() as any
  const accessToken = session?.data?.tokens?.access_token as string | undefined
  const authenticated = session?.status === 'authenticated' && !!accessToken
  const clean = cleanActivityUuid(activityUuid)
  const userKey = sessionUserKey(session)
  const enabled = !!clean && options.enabled !== false

  const query = useQuery<ActivityProgressRow | null>({
    queryKey: queryKeys.progress.activity(clean),
    queryFn: () => getActivityProgress(clean, accessToken),
    enabled: enabled && authenticated,
    // Fresh on every open of the activity, but not while watching it: the
    // saver keeps this entry up to date itself.
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: retryUnlessClientError,
  })

  const sessionLoading = session?.status === 'loading'
  // Settled = we know everything we are going to know before playback starts.
  const settled = enabled && !sessionLoading && (!authenticated || query.isFetched || query.isError)

  const data = React.useMemo(() => {
    if (!enabled) return null
    const local = readLocalActivityProgress(userKey, clean)
    const server = query.data ?? null
    // Server answer known: the local mirror only wins while it is newer (a
    // save still in flight). Signed out / offline / loading: use the mirror.
    const serverKnown = authenticated && query.isSuccess
    const useLocal =
      !!local && (!serverKnown || (server ? isLocalNewer(local, server.update_date) : isLocalFresh(local)))
    if (local && useLocal) {
      return {
        position_seconds: local.p,
        duration_seconds: local.d ?? server?.duration_seconds ?? null,
        page: local.pg ?? server?.page ?? null,
        completed: !!(local.c || server?.completed),
      } as ActivityProgressRow
    }
    return server
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, authenticated, query.isSuccess, query.data, query.dataUpdatedAt, clean, userKey])

  return { ...query, data, settled }
}

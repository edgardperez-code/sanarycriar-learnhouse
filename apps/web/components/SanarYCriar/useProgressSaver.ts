'use client'

// Sanar y Criar: saves the learner's position on an activity.
//
// Writes go out at most every ~10 s of playback (`tick`) and always on
// pause / seek / end / tab hidden / page hide / unmount (`flush`), with
// `fetch(..., { keepalive: true })` so the last one survives navigation.
// Every write is mirrored to localStorage first. Each save carries
// `client_ts`, the client clock when its position was read, so a periodic
// save that lands after the on-leave one can't move the position back.
import React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useLHSession } from '@components/Contexts/LHSessionContext'
import { useOrg } from '@components/Contexts/OrgContext'
import { queryKeys } from '@lib/query/keys'
import { saveActivityProgress, type CourseProgress } from '@services/courses/progress'
import { cleanActivityUuid, cleanCourseUuid, sessionUserKey, writeLocalProgress } from './progressLocal'

/** Seconds of playback between periodic saves. */
export const SAVE_EVERY_SECONDS = 10
/** Auto-complete threshold used by the API (`max_position / duration`). */
const AUTO_COMPLETE_RATIO = 0.9

interface SaverState {
  pos: number
  dur: number | null
  page: number | null
  completed: boolean
  /** `Date.now()` when pos / page / completed were last read (0: never). */
  readAt: number
  dirty: boolean
  lastSentPos: number
  inFlight: boolean
  /** A pause / seek save arrived while one was out: send it when that one returns. */
  queued: boolean
  /** Server writes stopped (not bought, no access, route missing). */
  disabled: boolean
  /** Token the API rejected with 401; writes resume once the session refreshes it. */
  rejectedToken: string | null
  backoffUntil: number
  trailRefreshed: boolean
}

const initialState = (): SaverState => ({
  pos: 0,
  dur: null,
  page: null,
  completed: false,
  readAt: 0,
  dirty: false,
  lastSentPos: Number.NEGATIVE_INFINITY,
  inFlight: false,
  queued: false,
  disabled: false,
  rejectedToken: null,
  backoffUntil: 0,
  trailRefreshed: false,
})

export interface ProgressSaver {
  /** Record the current position (cheap; call on every timeupdate). */
  update: (_position: number, _duration?: number | null) => void
  /** Record the current PDF page. */
  setPage: (_page: number) => void
  /** Mark the activity as watched to the end. */
  markCompleted: () => void
  /** Save if ~10 s of playback passed since the last save. */
  tick: () => void
  /** Save now if anything changed. */
  flush: (_options?: { keepalive?: boolean }) => void
}

export function useProgressSaver({
  activityUuid,
  courseUuid,
  enabled = true,
}: {
  activityUuid?: string
  courseUuid?: string
  enabled?: boolean
}): ProgressSaver {
  const session = useLHSession() as any
  const org = useOrg() as any
  const queryClient = useQueryClient()

  // Refs so unload/unmount handlers always see the latest values. Synced in
  // an effect (declared first, so it runs before the ones below).
  const tokenRef = React.useRef<string | undefined>(undefined)
  const userKeyRef = React.useRef('anon')
  const orgIdRef = React.useRef<number | undefined>(undefined)
  const enabledRef = React.useRef(enabled)
  const accessToken = session?.status === 'authenticated' ? session?.data?.tokens?.access_token : undefined
  const userKey = sessionUserKey(session)
  const orgId = org?.id
  React.useEffect(() => {
    tokenRef.current = accessToken
    userKeyRef.current = userKey
    orgIdRef.current = orgId
    enabledRef.current = enabled
  }, [accessToken, userKey, orgId, enabled])
  // Set from effects (not during render) so the unmount/switch flush still
  // targets the activity being left.
  const idsRef = React.useRef({ activity: '', course: '' })

  const stateRef = React.useRef<SaverState>(initialState())

  const patchCaches = React.useCallback(
    (activity: string, course: string, s: SaverState, row: any) => {
      queryClient.setQueryData(queryKeys.progress.activity(activity), row ?? undefined)
      if (!course) return
      queryClient.setQueryData<CourseProgress | undefined>(queryKeys.progress.course(course), (old) => {
        if (!old) return old
        const activity_uuid = 'activity_' + activity
        const entry = {
          activity_uuid,
          position_seconds: s.pos,
          duration_seconds: s.dur,
          max_position_seconds: Math.max(row?.max_position_seconds ?? 0, s.pos),
          page: s.page,
          completed: !!(row?.completed ?? s.completed),
        }
        const items = old.items.filter((i) => cleanActivityUuid(i.activity_uuid) !== activity)
        items.push(entry)
        const sameLast = cleanActivityUuid(old.last?.activity_uuid) === activity
        return {
          items,
          last: {
            ...(sameLast ? old.last! : { activity_type: null, activity_name: null, chapter_name: null }),
            ...entry,
            update_date: new Date().toISOString(),
          },
        }
      })
      // Next mount of the course page refetches; the patch covers until then.
      queryClient.invalidateQueries({ queryKey: queryKeys.progress.course(course), refetchType: 'none' })
    },
    [queryClient]
  )

  // Lets a returning save send the one queued behind it.
  const sendRef = React.useRef<(_keepalive: boolean) => void>(() => {})
  const send = React.useCallback(
    (keepalive: boolean) => {
      const s = stateRef.current
      const { activity, course } = idsRef.current
      if (!activity || !enabledRef.current) return
      const token = tokenRef.current
      const toServer = !!token && token !== s.rejectedToken && !s.disabled && Date.now() >= s.backoffUntil
      // A save while the previous one is still out: keep it dirty and send
      // it when that one returns (keepalive saves on leave go out at once).
      if (toServer && s.inFlight && !keepalive) {
        s.queued = true
        return
      }
      s.queued = false
      s.dirty = false
      s.lastSentPos = s.pos
      writeLocalProgress(userKeyRef.current, activity, course || undefined, {
        p: s.pos,
        d: s.dur,
        pg: s.page,
        c: s.completed,
      })
      if (!toServer) return
      s.inFlight = true
      const snapshot = { ...s }
      saveActivityProgress(
        activity,
        {
          position_seconds: s.pos,
          duration_seconds: s.dur,
          page: s.page,
          completed: s.completed,
          // Queued / retried / keepalive saves keep the stamp of the position
          // they carry, not the time they finally went out.
          client_ts: s.readAt || undefined,
        },
        token,
        { keepalive }
      )
        .then((res) => {
          if (res.ok) {
            patchCaches(activity, course, snapshot, res.data)
            const ratio = snapshot.dur ? snapshot.pos / snapshot.dur : 0
            const currentOrgId = orgIdRef.current
            // The API auto-completes the step at 90 % / on end: refresh the checkmarks once.
            if (currentOrgId && !s.trailRefreshed && (snapshot.completed || ratio >= AUTO_COMPLETE_RATIO)) {
              s.trailRefreshed = true
              queryClient.invalidateQueries({ queryKey: queryKeys.trail.org(currentOrgId) })
            }
          } else if (res.status === 401) {
            // Expired token: stop until the session hands out a new one.
            s.rejectedToken = token ?? null
            s.dirty = true
          } else if ([402, 403, 404, 405].includes(res.status)) {
            s.disabled = true
          } else if (res.status === 429) {
            s.backoffUntil = Date.now() + 30_000
            s.dirty = true
          } else {
            // Network error / 5xx: keep the change so the next flush retries it.
            s.dirty = true
          }
        })
        .finally(() => {
          s.inFlight = false
          // E.g. paused right after a periodic save left on a slow connection.
          if (s.queued && s.dirty && stateRef.current === s) sendRef.current(false)
        })
    },
    [patchCaches, queryClient]
  )
  React.useEffect(() => {
    sendRef.current = send
  }, [send])

  const update = React.useCallback((position: number, duration?: number | null) => {
    const s = stateRef.current
    if (!Number.isFinite(position) || position < 0) return
    s.pos = position
    s.readAt = Date.now()
    if (duration && Number.isFinite(duration) && duration > 0) s.dur = duration
    if (Math.abs(position - s.lastSentPos) > 0.5) s.dirty = true
  }, [])

  const setPage = React.useCallback((page: number) => {
    const s = stateRef.current
    if (!Number.isFinite(page) || page < 1) return
    if (s.page !== page) {
      s.page = page
      s.readAt = Date.now()
      s.dirty = true
    }
  }, [])

  const markCompleted = React.useCallback(() => {
    const s = stateRef.current
    if (s.dur) s.pos = s.dur
    s.completed = true
    s.readAt = Date.now()
    s.dirty = true
  }, [])

  const tick = React.useCallback(() => {
    const s = stateRef.current
    if (s.dirty && Math.abs(s.pos - s.lastSentPos) >= SAVE_EVERY_SECONDS) send(false)
  }, [send])

  const flush = React.useCallback(
    (options?: { keepalive?: boolean }) => {
      if (stateRef.current.dirty) send(options?.keepalive ?? true)
    },
    [send]
  )

  React.useEffect(() => {
    idsRef.current = { ...idsRef.current, course: cleanCourseUuid(courseUuid) }
  }, [courseUuid])

  // New activity: start clean. Leaving it (unmount / switch): last save.
  React.useEffect(() => {
    idsRef.current = { activity: cleanActivityUuid(activityUuid), course: idsRef.current.course }
    stateRef.current = initialState()
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush({ keepalive: true })
    }
    const onPageHide = () => flush({ keepalive: true })
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      flush({ keepalive: true })
    }
  }, [activityUuid, flush])

  return React.useMemo(
    () => ({ update, setPage, markCompleted, tick, flush }),
    [update, setPage, markCompleted, tick, flush]
  )
}

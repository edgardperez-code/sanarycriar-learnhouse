// Sanar y Criar: learner progress (video position / last PDF page) API client.
// Contract: docs/spec-tecnica.md section 3 (`/api/v1/progress`).
import { getAPIUrl } from '@services/config/config'
import { RequestBodyWithAuthHeader, errorHandling } from '@services/utils/ts/requests'

export interface ActivityProgressBody {
  position_seconds: number
  duration_seconds?: number | null
  page?: number | null
  completed?: boolean
  /**
   * Client clock (epoch ms, `Date.now()`) when the position was read. The API
   * ignores a save older than the stored one while that one is recent, so a
   * periodic save landing after the on-leave save can't move the position back.
   */
  client_ts?: number
}

/** Upper bound the API accepts for `client_ts` (epoch ms, year 2286). */
const MAX_CLIENT_TS = 10 ** 13

/** One stored row, as returned by PUT / GET `/progress/activity/{uuid}`. */
export interface ActivityProgressRow {
  activity_uuid?: string
  position_seconds: number
  duration_seconds?: number | null
  max_position_seconds?: number | null
  page?: number | null
  completed?: boolean
  update_date?: string | null
  [key: string]: unknown
}

export interface CourseProgressLast {
  activity_uuid: string
  activity_type?: string | null
  activity_name?: string | null
  chapter_name?: string | null
  position_seconds: number
  duration_seconds?: number | null
  page?: number | null
  update_date?: string | null
  completed?: boolean
}

export interface CourseProgressItem {
  activity_uuid: string
  position_seconds: number
  duration_seconds?: number | null
  max_position_seconds?: number | null
  page?: number | null
  completed?: boolean
}

export interface CourseProgress {
  last: CourseProgressLast | null
  items: CourseProgressItem[]
}

export interface SaveProgressResult {
  ok: boolean
  status: number
  data: ActivityProgressRow | null
}

/** `abc` / `activity_abc` → `activity_abc` (the API expects the prefixed form). */
export function toActivityUuid(uuid: string): string {
  return 'activity_' + String(uuid || '').replace(/^activity_/, '')
}

/** `abc` / `course_abc` → `course_abc`. */
export function toCourseUuid(uuid: string): string {
  return 'course_' + String(uuid || '').replace(/^course_/, '')
}

export async function getCourseProgress(
  courseUuid: string,
  accessToken?: string
): Promise<CourseProgress> {
  const result = await fetch(
    `${getAPIUrl()}progress/course/${toCourseUuid(courseUuid)}`,
    RequestBodyWithAuthHeader('GET', null, null, accessToken)
  )
  const res = await errorHandling(result)
  return {
    last: res?.last ?? null,
    items: Array.isArray(res?.items) ? res.items : [],
  }
}

export async function getActivityProgress(
  activityUuid: string,
  accessToken?: string
): Promise<ActivityProgressRow | null> {
  const result = await fetch(
    `${getAPIUrl()}progress/activity/${toActivityUuid(activityUuid)}`,
    RequestBodyWithAuthHeader('GET', null, null, accessToken)
  )
  const res = await errorHandling(result)
  return res ?? null
}

/**
 * Upsert the learner's position on an activity.
 *
 * Uses `fetch` with `keepalive` (not `sendBeacon`, which cannot carry the
 * bearer header) so the last save still lands while the page is hidden or
 * unloading. It never throws and never goes through `errorHandling`: a
 * background save must not bounce the learner to the login page mid-video.
 */
export async function saveActivityProgress(
  activityUuid: string,
  body: ActivityProgressBody,
  accessToken?: string,
  options: { keepalive?: boolean } = {}
): Promise<SaveProgressResult> {
  const payload: ActivityProgressBody = {
    position_seconds: Math.max(0, Math.round((Number(body.position_seconds) || 0) * 10) / 10),
  }
  if (body.duration_seconds != null && Number.isFinite(body.duration_seconds) && body.duration_seconds > 0) {
    payload.duration_seconds = Math.round(body.duration_seconds * 10) / 10
  }
  if (body.page != null && Number.isFinite(body.page) && body.page > 0) {
    payload.page = Math.floor(body.page)
  }
  if (body.completed) payload.completed = true
  // Whole milliseconds inside the API's range; anything else is left out
  // (the save then falls back to last-write-wins instead of a 422).
  const clientTs = Number(body.client_ts)
  if (body.client_ts != null && Number.isFinite(clientTs) && clientTs >= 0 && clientTs <= MAX_CLIENT_TS) {
    payload.client_ts = Math.floor(clientTs)
  }

  try {
    const result = await fetch(`${getAPIUrl()}progress/activity/${toActivityUuid(activityUuid)}`, {
      ...RequestBodyWithAuthHeader('PUT', payload, null, accessToken),
      keepalive: !!options.keepalive,
    })
    let data: ActivityProgressRow | null = null
    try {
      data = await result.json()
    } catch {
      data = null
    }
    return { ok: result.ok, status: result.status, data: result.ok ? data : null }
  } catch {
    return { ok: false, status: 0, data: null }
  }
}

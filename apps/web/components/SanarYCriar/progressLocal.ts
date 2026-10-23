// Sanar y Criar: helpers shared by the progress UI (video resume, "continue"
// card, chapter dropdown bars). The server is the source of truth across
// devices; localStorage only mirrors the latest position on this device for an
// instant resume and to cover the moment between an unload-time save and the
// next read.
import type { CourseProgress } from '@services/courses/progress'

/** A local entry younger than this beats the server copy (save/read race). */
export const LOCAL_FRESH_MS = 2 * 60 * 1000
/** Don't resume in the first seconds: there is nothing worth skipping. */
export const RESUME_MIN_SECONDS = 5
/** Near the end means "finished": start over / go to the next activity. */
export const RESUME_END_MARGIN_SECONDS = 15
/** ...capped at this share of the video, so short clips aren't "done" early. */
const RESUME_END_MARGIN_RATIO = 0.1

export interface LocalActivityProgress {
  /** position (s) */
  p: number
  /** duration (s) */
  d?: number | null
  /** page (PDF) */
  pg?: number | null
  /** completed */
  c?: boolean
  /** saved at (ms epoch, client clock) */
  ts: number
}

export interface LocalCourseLast extends LocalActivityProgress {
  /** clean activity uuid */
  a: string
}

export const cleanActivityUuid = (uuid?: string | null) => String(uuid || '').replace(/^activity_/, '')
export const cleanCourseUuid = (uuid?: string | null) => String(uuid || '').replace(/^course_/, '')

export function sessionUserKey(session: any): string {
  const user = session?.data?.user
  return String(user?.user_uuid || user?.id || 'anon')
}

const activityKey = (userKey: string, activityUuid: string) =>
  `sc:progress:${userKey}:${cleanActivityUuid(activityUuid)}`
const courseKey = (userKey: string, courseUuid: string) =>
  `sc:progress:last:${userKey}:${cleanCourseUuid(courseUuid)}`

function readJson<T>(key: string): T | null {
  try {
    if (typeof window === 'undefined') return null
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as T) : null
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown) {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode / quota / blocked storage: the server copy still works */
  }
}

export function readLocalActivityProgress(userKey: string, activityUuid: string) {
  const entry = readJson<LocalActivityProgress>(activityKey(userKey, activityUuid))
  return entry && Number.isFinite(entry.p) && Number.isFinite(entry.ts) ? entry : null
}

export function readLocalCourseLast(userKey: string, courseUuid: string) {
  const entry = readJson<LocalCourseLast>(courseKey(userKey, courseUuid))
  return entry && entry.a && Number.isFinite(entry.p) && Number.isFinite(entry.ts) ? entry : null
}

export function writeLocalProgress(
  userKey: string,
  activityUuid: string,
  courseUuid: string | undefined,
  entry: Omit<LocalActivityProgress, 'ts'>
) {
  const value: LocalActivityProgress = { ...entry, ts: Date.now() }
  writeJson(activityKey(userKey, activityUuid), value)
  if (courseUuid) {
    writeJson(courseKey(userKey, courseUuid), { ...value, a: cleanActivityUuid(activityUuid) })
  }
}

/**
 * Forget this device's mirror of a course (its "last" entry and every
 * activity's position), e.g. after the learner leaves the course, so a save
 * from the last two minutes can't bring "Continuar" back.
 */
export function clearLocalCourseProgress(userKey: string, course: any) {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.removeItem(courseKey(userKey, course?.course_uuid))
    for (const entry of flattenCourseActivities(course)) {
      if (entry.cleanUuid) window.localStorage.removeItem(activityKey(userKey, entry.cleanUuid))
    }
  } catch {
    /* blocked storage: nothing was mirrored either */
  }
}

export const isLocalFresh =(entry: { ts: number } | null | undefined) =>
  !!entry && Date.now() - entry.ts < LOCAL_FRESH_MS

/**
 * Whether this device's copy should win over the server's: it is fresh and
 * newer than the server row (a save from another device, or one that already
 * reached the server, is not overridden).
 */
export function isLocalNewer(entry: { ts: number } | null | undefined, serverUpdateDate?: string | null): boolean {
  if (!entry || !isLocalFresh(entry)) return false
  const serverTs = serverUpdateDate ? Date.parse(serverUpdateDate) : NaN
  return !Number.isFinite(serverTs) || entry.ts > serverTs
}

/**
 * Overlay a fresh local "last" onto the server answer, so the course page
 * shows where the learner really stopped even when its read raced the
 * unload-time save.
 */
export function mergeCourseProgress(
  server: CourseProgress | undefined,
  local: LocalCourseLast | null
): CourseProgress | undefined {
  if (!local || !isLocalNewer(local, server?.last?.update_date)) return server
  const base: CourseProgress = server ?? { last: null, items: [] }
  const activity_uuid = 'activity_' + local.a
  const sameAsServer = cleanActivityUuid(base.last?.activity_uuid) === local.a
  const items = [...base.items]
  const idx = items.findIndex((i) => cleanActivityUuid(i.activity_uuid) === local.a)
  const prev = idx >= 0 ? items[idx] : null
  const merged = {
    activity_uuid,
    position_seconds: local.p,
    duration_seconds: local.d ?? prev?.duration_seconds ?? null,
    max_position_seconds: Math.max(prev?.max_position_seconds ?? 0, local.p),
    page: local.pg ?? prev?.page ?? null,
    completed: !!(local.c || prev?.completed),
  }
  if (idx >= 0) items[idx] = { ...prev!, ...merged }
  else items.push(merged)
  return {
    items,
    last: {
      ...(sameAsServer ? base.last! : { activity_type: null, activity_name: null, chapter_name: null }),
      ...merged,
      update_date: new Date(local.ts).toISOString(),
    },
  }
}

/** 75 → "1:15", 3725 → "1:02:05". */
export function formatClock(totalSeconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

/** 0..1, or null when the duration is unknown. */
export function progressRatio(position?: number | null, duration?: number | null): number | null {
  if (!duration || !Number.isFinite(duration) || duration <= 0) return null
  return Math.min(1, Math.max(0, (Number(position) || 0) / duration))
}

/** Whether a position is in the last stretch of the video (credits, outro). */
export function isNearEnd(position?: number | null, duration?: number | null): boolean {
  if (!duration || !Number.isFinite(duration) || duration <= 0) return false
  const margin = Math.min(RESUME_END_MARGIN_SECONDS, duration * RESUME_END_MARGIN_RATIO)
  return (Number(position) || 0) >= duration - margin
}

/** Whether a saved position is worth resuming (not at the very start or end). */
export function isResumablePosition(position?: number | null, duration?: number | null): boolean {
  const p = Number(position) || 0
  if (p < RESUME_MIN_SECONDS) return false
  return !isNearEnd(p, duration)
}

export interface FlatActivity {
  activity: any
  chapter: any
  chapterIndex: number
  cleanUuid: string
}

/** Course activities in reading order (same flattening as the activity page). */
export function flattenCourseActivities(course: any): FlatActivity[] {
  const out: FlatActivity[] = []
  ;(course?.chapters ?? []).forEach((chapter: any, chapterIndex: number) => {
    ;(chapter?.activities ?? []).forEach((activity: any) => {
      out.push({ activity, chapter, chapterIndex, cleanUuid: cleanActivityUuid(activity?.activity_uuid) })
    })
  })
  return out
}

/** Completed activity ids for a course from the trail (TrailStep = done). */
export function completedActivityIds(trailData: any, courseUuid: string): Set<any> {
  const clean = cleanCourseUuid(courseUuid)
  const run = Array.isArray(trailData?.runs)
    ? trailData.runs.find((r: any) => cleanCourseUuid(r?.course?.course_uuid) === clean)
    : null
  const ids = new Set<any>()
  ;(run?.steps ?? []).forEach((step: any) => {
    if (step?.complete !== false) ids.add(step.activity_id)
  })
  return ids
}

export const isEbookCourse = (course: any) => course?.extra_metadata?.product_type === 'ebook'

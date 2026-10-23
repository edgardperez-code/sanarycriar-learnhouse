'use client'

// Sanar y Criar: resume + progress saving for hosted videos. Works on the
// <video> element LearnHousePlayer hands out through `onVideoElement`, so the
// player itself stays untouched.
//
// Start position priority: `?t=` (the player applies it as details.startTime)
// > saved position > details.startTime.
import React from 'react'
import { useActivityProgress } from '@/hooks/queries/useCourseProgress'
import { useProgressSaver } from '@components/SanarYCriar/useProgressSaver'
import { isResumablePosition } from '@components/SanarYCriar/progressLocal'

/** An auto-resume only moves a player that is still (about) where it started. */
const UNTOUCHED_TOLERANCE_SECONDS = 3
const SEEK_SAVE_DEBOUNCE_MS = 1000

/** A `?t=` this close to the saved position is a "continue" link: say so. */
const LINKED_RESUME_TOLERANCE_SECONDS = 2

/**
 * Saved position to resume at, or null (nothing saved, at start/end, or a
 * `?t=` deep link, which wins). `linkedIsResume`: the `?t=` link points at
 * the saved position (the course page "Continuar" card), so the player shows
 * the "Reanudando en…" notice for it too.
 */
export function useResumeTarget(activityUuid: string | undefined, linkedStart: number | null, enabled: boolean) {
  const { data: saved, settled } = useActivityProgress(activityUuid, { enabled })
  const savedResumable = !!saved && isResumablePosition(saved.position_seconds, saved.duration_seconds)
  const target = !linkedStart && savedResumable ? Math.floor(saved!.position_seconds) : null
  const linkedIsResume =
    !!linkedStart &&
    savedResumable &&
    Math.abs(Number(saved!.position_seconds) - linkedStart) <= LINKED_RESUME_TOLERANCE_SECONDS
  return { target, linkedIsResume, settled: settled || !enabled }
}

export function useHostedVideoProgress({
  videoEl,
  activityUuid,
  courseUuid,
  baseStart,
  linkedStart,
  enabled = true,
}: {
  videoEl: HTMLVideoElement | null
  activityUuid: string
  courseUuid?: string
  baseStart: number
  linkedStart: number | null
  enabled?: boolean
}) {
  const saver = useProgressSaver({ activityUuid, courseUuid, enabled })
  const { target, linkedIsResume } = useResumeTarget(activityUuid, linkedStart, enabled)
  // Keyed by activity so a reused component never shows the previous one's notice.
  const [toast, setToast] = React.useState<{ activity: string; at: number } | null>(null)
  const toastAt = toast && toast.activity === activityUuid ? toast.at : null
  // Playback started on this activity (lets the resume notice time out).
  const [startedOn, setStartedOn] = React.useState<string | null>(null)
  const started = startedOn === activityUuid
  const elRef = React.useRef<HTMLVideoElement | null>(null)

  const hasPlayedRef = React.useRef(false)
  const userSeekedRef = React.useRef(false)
  const programmaticSeekRef = React.useRef(false)
  // Where the player was put without the learner's input (startTime / resume).
  const autoPosRef = React.useRef(linkedStart ?? baseStart)

  React.useEffect(() => {
    hasPlayedRef.current = false
    userSeekedRef.current = false
    programmaticSeekRef.current = false
  }, [activityUuid])

  React.useEffect(() => {
    elRef.current = videoEl
  }, [videoEl])

  React.useEffect(() => {
    autoPosRef.current = linkedStart ?? baseStart
  }, [activityUuid, linkedStart, baseStart])

  // Save on playback, pause, seek and end.
  React.useEffect(() => {
    const el = videoEl
    if (!el || !enabled) return
    let seekTimer: ReturnType<typeof setTimeout> | undefined
    // A detached element (player swapped on activity change / MP4 fallback)
    // still fires `pause`; it must not write into the next activity.
    const sync = () => {
      if (el.isConnected) saver.update(el.currentTime, el.duration)
    }
    const onTimeUpdate = () => {
      if (el.paused || el.seeking || !el.isConnected) return
      sync()
      saver.tick()
    }
    const onPlaying = () => {
      hasPlayedRef.current = true
      setStartedOn(activityUuid)
    }
    const onPause = () => {
      if (el.ended || !el.isConnected) return // `ended` follows and saves as completed
      sync()
      saver.flush({ keepalive: false })
    }
    const onSeeked = () => {
      if (programmaticSeekRef.current) {
        programmaticSeekRef.current = false
        return
      }
      // The player's own startTime / fallback seeks happen before playback.
      if (!hasPlayedRef.current || !el.isConnected) return
      userSeekedRef.current = true
      setToast(null)
      sync()
      if (seekTimer) clearTimeout(seekTimer)
      seekTimer = setTimeout(() => saver.flush({ keepalive: false }), SEEK_SAVE_DEBOUNCE_MS)
    }
    const onEnded = () => {
      if (!el.isConnected) return
      saver.update(el.duration || el.currentTime, el.duration)
      saver.markCompleted()
      saver.flush({ keepalive: false })
    }
    el.addEventListener('timeupdate', onTimeUpdate)
    el.addEventListener('playing', onPlaying)
    el.addEventListener('pause', onPause)
    el.addEventListener('seeked', onSeeked)
    el.addEventListener('ended', onEnded)
    return () => {
      if (seekTimer) clearTimeout(seekTimer)
      // Keep the latest position for the unmount / unload save.
      if (hasPlayedRef.current) sync()
      el.removeEventListener('timeupdate', onTimeUpdate)
      el.removeEventListener('playing', onPlaying)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('seeked', onSeeked)
      el.removeEventListener('ended', onEnded)
    }
  }, [videoEl, enabled, saver, activityUuid])

  // Resume at the saved position once the metadata is in. The saved position
  // may arrive after the player started (server answer); it still applies as
  // long as the learner hasn't moved the playhead themselves.
  React.useEffect(() => {
    const el = videoEl
    if (!el || target == null || !enabled) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const apply = () => {
      if (userSeekedRef.current) return
      if (Math.abs(el.currentTime - autoPosRef.current) > UNTOUCHED_TOLERANCE_SECONDS) return
      if (Math.abs(el.currentTime - target) < 1) return
      if (Number.isFinite(el.duration) && !isResumablePosition(target, el.duration)) return
      programmaticSeekRef.current = true
      el.currentTime = target
      autoPosRef.current = target
      setToast({ activity: activityUuid, at: target })
    }
    // Deferred a tick so it runs after the player's own loadedmetadata
    // handler (which seeks to details.startTime).
    const schedule = () => {
      timer = setTimeout(apply, 0)
    }
    if (el.readyState >= 1) schedule()
    else el.addEventListener('loadedmetadata', schedule, { once: true })
    return () => {
      if (timer) clearTimeout(timer)
      el.removeEventListener('loadedmetadata', schedule)
    }
  }, [videoEl, target, enabled, activityUuid])

  // A "Continuar" deep link (`?t=` = saved position): the player seeks there
  // itself through details.startTime; only the notice is added.
  React.useEffect(() => {
    const el = videoEl
    if (!el || !linkedIsResume || !linkedStart || !enabled) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const show = () => {
      timer = setTimeout(() => {
        if (userSeekedRef.current || hasPlayedRef.current) return
        setToast((prev) => (prev && prev.activity === activityUuid ? prev : { activity: activityUuid, at: linkedStart }))
      }, 0)
    }
    if (el.readyState >= 1) show()
    else el.addEventListener('loadedmetadata', show, { once: true })
    return () => {
      if (timer) clearTimeout(timer)
      el.removeEventListener('loadedmetadata', show)
    }
  }, [videoEl, linkedIsResume, linkedStart, enabled, activityUuid])

  const restart = React.useCallback(() => {
    userSeekedRef.current = true
    setToast(null)
    const el = elRef.current
    if (!el) return
    if (Math.abs(el.currentTime - baseStart) > 0.1) {
      programmaticSeekRef.current = true
      el.currentTime = baseStart
    }
    autoPosRef.current = baseStart
    saver.update(baseStart, el.duration)
  }, [baseStart, saver])

  const dismiss = React.useCallback(() => setToast(null), [])

  return { toastAt, started, restart, dismiss }
}

'use client'

// Sanar y Criar: the YouTube branch of VideoActivity with resume + progress.
// The iframe API has no time events, so the position is polled while playing.
import React from 'react'
import YouTube from 'react-youtube'
import { useProgressSaver } from '@components/SanarYCriar/useProgressSaver'
import ResumeToast from '@components/SanarYCriar/ResumeToast'
import { useResumeTarget } from './useVideoProgress'

const POLL_MS = 1000
// Wait this long at most for the saved position before creating the player
// (changing `playerVars.start` afterwards would rebuild the iframe).
const RESUME_WAIT_MS = 1500

// YT.PlayerState
const ENDED = 0
const PLAYING = 1
const PAUSED = 2

interface Details {
  startTime?: number
  endTime?: number | null
  autoplay?: boolean
  muted?: boolean
}

interface Props {
  videoId: string
  activityUuid: string
  courseUuid?: string
  details?: Details
  linkedStart: number | null
  trackProgress?: boolean
}

// The iframe API answers synchronously; the youtube-player wrapper with a
// promise. Accept both.
const read = async (fn: () => any): Promise<number> => {
  try {
    const value = await Promise.resolve(fn())
    return Number(value) || 0
  } catch {
    return 0
  }
}

export default function YouTubeProgressPlayer(props: Props) {
  const { activityUuid, linkedStart, details, trackProgress = true } = props
  const { target, linkedIsResume, settled } = useResumeTarget(activityUuid, linkedStart, trackProgress)
  const [waitedEnough, setWaitedEnough] = React.useState(false)
  React.useEffect(() => {
    const timer = setTimeout(() => setWaitedEnough(true), RESUME_WAIT_MS)
    return () => clearTimeout(timer)
  }, [])

  if (!settled && !waitedEnough) {
    return <div className="w-full h-full bg-black/90" aria-hidden="true" />
  }
  // Resumed from the saved position, directly or through a "Continuar" `?t=` link.
  const resumed = (!linkedStart && target != null) || linkedIsResume
  return (
    <YouTubeWithProgress
      {...props}
      trackProgress={trackProgress}
      initialStart={linkedStart ?? target ?? (details?.startTime || 0)}
      resumed={resumed}
    />
  )
}

function YouTubeWithProgress({
  videoId,
  activityUuid,
  courseUuid,
  details,
  trackProgress = true,
  initialStart,
  resumed,
}: Props & { initialStart: number; resumed: boolean }) {
  const saver = useProgressSaver({ activityUuid, courseUuid, enabled: trackProgress })
  const baseStart = details?.startTime || 0
  // Frozen at mount: later progress updates must not rebuild the iframe.
  const [start] = React.useState(() => Math.floor(initialStart) || 0)
  const [wasResumed] = React.useState(resumed)
  const [toastAt, setToastAt] = React.useState<number | null>(null)
  const [started, setStarted] = React.useState(false)

  const playerRef = React.useRef<any>(null)
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null)

  const sample = React.useCallback(async () => {
    const player = playerRef.current
    if (!player) return
    const [position, duration] = await Promise.all([
      read(() => player.getCurrentTime()),
      read(() => player.getDuration()),
    ])
    saver.update(position, duration)
  }, [saver])

  const stopPolling = React.useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = null
  }, [])

  React.useEffect(() => stopPolling, [stopPolling])

  const onStateChange = (event: { data: number; target: any }) => {
    playerRef.current = event.target
    if (event.data === PLAYING) {
      setStarted(true)
      stopPolling()
      pollRef.current = setInterval(() => {
        sample().then(() => saver.tick())
      }, POLL_MS)
    } else if (event.data === PAUSED) {
      stopPolling()
      sample().then(() => saver.flush({ keepalive: false }))
    } else if (event.data === ENDED) {
      stopPolling()
      sample().then(() => {
        saver.markCompleted()
        saver.flush({ keepalive: false })
      })
    }
  }

  const restart = () => {
    setToastAt(null)
    try {
      playerRef.current?.seekTo(baseStart, true)
    } catch {
      /* player gone */
    }
    // Leaving right away keeps "from the start" rather than the old position.
    saver.update(baseStart)
  }
  const dismiss = React.useCallback(() => setToastAt(null), [])

  return (
    <>
      <YouTube
        className="w-full h-full"
        opts={{
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: details?.autoplay ? 1 : 0,
            mute: details?.muted ? 1 : 0,
            start,
            end: details?.endTime || undefined,
            controls: 1,
            modestbranding: 1,
            rel: 0,
          },
        }}
        videoId={videoId}
        onReady={(event: any) => {
          playerRef.current = event.target
          if (wasResumed) {
            // `playerVars.start` already cues the saved position without
            // starting playback; seekTo would autoplay.
            if (trackProgress) setToastAt(start)
          } else if (start) {
            // Upstream behaviour for details.startTime / `?t=`.
            event.target.seekTo(start, true)
          }
        }}
        onStateChange={onStateChange}
      />
      {toastAt != null && (
        <ResumeToast position={toastAt} onRestart={restart} onDismiss={dismiss} autoHide={started} />
      )}
    </>
  )
}

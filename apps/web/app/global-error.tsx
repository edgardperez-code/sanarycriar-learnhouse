"use client";

import * as Sentry from "@sentry/nextjs";
import '../styles/globals.css'
import { classifyError } from '@lib/errors/classify'
import { detectClientLanguage, directionForLanguage } from '@lib/direction'
import { ERRORS_DEFAULT_LANGUAGE, categoryText, errorText, errorsLanguage, reportDialogLabels } from '@lib/errors/messages'
import { AlertTriangle, ChevronDown, ChevronRight, Home, LogOut, MessageSquareWarning, RefreshCcw } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'

// Last-resort boundary: catches errors thrown in the root layout itself, so it
// renders OUTSIDE every provider (no router, no AuthContext, no i18n). Kept
// fully self-contained: it classifies the error for a meaningful message and
// offers reload / home / sign out / report, all via plain DOM + the Sentry SDK.
//
// Sanar y Criar: the copy comes from lib/errors/messages (sc_errors bundles,
// no i18next), in the language detected the same way as dir-init.js
// (explicit pick, ?lng, else Spanish).

// The language never changes while this screen is up: nothing to subscribe to.
const subscribeNoop = () => () => {}
const serverLanguage = () => ERRORS_DEFAULT_LANGUAGE

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [eventId, setEventId] = useState<string | undefined>()
  const [showDetails, setShowDetails] = useState(false)
  const [signingOut, setSigningOut] = useState(false)

  // dir-init.js can't help here: this boundary renders its own <html>, so the
  // attribute has to come from React. Detect on the client. A server-rendered
  // error page is LTR (and Spanish) for one frame, acceptable on an error
  // screen, and not worth a second blocking script.
  // Sanar y Criar: useSyncExternalStore keeps hydration consistent (server
  // snapshot 'es', then the detected language) for the text too.
  const detected = useSyncExternalStore(subscribeNoop, detectClientLanguage, serverLanguage)
  const dir = directionForLanguage(detected)
  const lng = errorsLanguage(detected)
  const tr = (key: string) => errorText(key, lng)

  const { category, detail, status } = classifyError(error)

  useEffect(() => {
    const msg = error?.message || ''
    if (
      msg.includes('Failed to find Server Action') ||
      msg.includes('older or newer deployment') ||
      error?.name === 'ChunkLoadError' ||
      msg.includes('Loading chunk')
    ) {
      window.location.reload()
      return
    }
    if (Sentry.isInitialized()) {
      setEventId(Sentry.captureException(error))
    }
    console.error(error)
  }, [error])

  const report = () => {
    try {
      if (!Sentry.isInitialized()) return
      const id = eventId || Sentry.lastEventId()
      Sentry.showReportDialog({
        ...(id ? { eventId: id } : {}),
        ...reportDialogLabels(lng),
      })
    } catch (e) {
      console.error('Failed to open feedback dialog:', e)
    }
  }

  const doSignOut = async () => {
    setSigningOut(true)
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    } catch {
      // ignore; we redirect to login regardless
    }
    window.location.href = '/login'
  }

  const btn = 'flex items-center gap-2 px-5 py-2 rounded-full font-bold text-sm transition-colors shadow-sm'

  return (
    <html lang={lng} dir={dir} suppressHydrationWarning>
      <body className="flex flex-col items-center justify-center min-h-screen bg-gray-50 p-4">
        <div className="flex flex-col items-center space-y-6 max-w-xl text-center">
          <div className="bg-rose-100 p-4 rounded-2xl">
            <AlertTriangle className="text-rose-700" size={44} />
          </div>
          <div>
            <h2 className="text-2xl md:text-3xl font-bold text-rose-700">{categoryText(category.kind, 'title', lng)}</h2>
            <span className="text-[11px] uppercase tracking-wide font-semibold text-rose-400">
              {categoryText(category.kind, 'label', lng)}
            </span>
          </div>
          <p className="text-gray-600">{categoryText(category.kind, 'description', lng)}</p>

          <div className="flex flex-wrap items-center justify-center gap-3">
            <button onClick={() => reset()} className={`${btn} text-white bg-rose-700 hover:bg-rose-800`}>
              <RefreshCcw size={16} />
              <span>{tr('actions.try_again')}</span>
            </button>
            <a href="/home" className={`${btn} text-gray-100 bg-gray-700 hover:bg-gray-800`}>
              <Home size={16} />
              <span>{tr('actions.home')}</span>
            </a>
            <button onClick={doSignOut} disabled={signingOut} className={`${btn} text-gray-600 bg-gray-100 hover:bg-gray-200 disabled:opacity-50`}>
              <LogOut size={16} />
              <span>{signingOut ? tr('actions.signing_out') : tr('actions.signout')}</span>
            </button>
            {Sentry.isInitialized() && (
              <button onClick={report} className={`${btn} text-rose-700 bg-rose-100 hover:bg-rose-200`}>
                <MessageSquareWarning size={16} />
                <span>{tr('actions.report')}</span>
              </button>
            )}
          </div>

          {(detail || status || error?.digest || eventId) && (
            <div className="w-full max-w-lg">
              <button
                onClick={() => setShowDetails((s) => !s)}
                className="flex items-center gap-1 mx-auto text-xs font-semibold text-gray-400 hover:text-gray-600 transition-colors"
              >
                {showDetails ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span>{showDetails ? tr('details.hide') : tr('details.show')}</span>
              </button>
              {showDetails && (
                <div className="mt-3 bg-gray-100 border border-gray-200 rounded-xl p-4 text-start text-xs font-mono text-gray-700 break-all space-y-1.5">
                  {detail && <div><span className="text-gray-400">{tr('details.cause')} </span>{detail}</div>}
                  {status !== undefined && <div><span className="text-gray-400">{tr('details.status')} </span>{status}</div>}
                  {error?.digest && <div><span className="text-gray-400">{tr('details.digest')} </span>{error.digest}</div>}
                  {eventId && <div><span className="text-gray-400">{tr('details.ref')} </span>{eventId}</div>}
                </div>
              )}
            </div>
          )}
        </div>
      </body>
    </html>
  );
}

'use client'
// Sanar y Criar: keep a sanitized ?redirect when hopping between the login and
// signup pages, so a buyer who started on an offer or course page lands back
// there after authenticating.
import { useSyncExternalStore } from 'react'
import { redirectFromSearch, withRedirect } from './commerce'

// The query string does not change without a navigation (which re-renders the
// page anyway), so there is nothing to subscribe to.
const noopSubscribe = () => () => {}
const readSearch = () => window.location.search
const serverSearch = () => ''

/**
 * `path` plus the current page's own ?redirect / ?next (same-origin paths
 * only). The server snapshot is empty, so hydration matches and the link gains
 * its redirect right after.
 */
export function useAuthRedirectHref(path: string): string {
  const search = useSyncExternalStore(noopSubscribe, readSearch, serverSearch)
  return withRedirect(path, redirectFromSearch(search))
}

const readPathname = () => window.location.pathname
const serverPathname = () => null

/** The current pathname (null during SSR/hydration), e.g. to come back after login. */
export function useCurrentPathname(): string | null {
  return useSyncExternalStore(noopSubscribe, readPathname, serverPathname)
}

/** The current page's sanitized ?redirect / ?next, or null. Client only. */
export function currentAuthRedirect(): string | null {
  if (typeof window === 'undefined') return null
  return redirectFromSearch(window.location.search)
}

export default useAuthRedirectHref

/**
 * The browser half's view of the host: one fetch, one shape.
 *
 * Same-origin, so no token and no CORS: the shell and this plugin answer on one
 * port. The host's route is the only thing here that knows JSON at all — the
 * components above it take the parsed value.
 */

import type { ToggleState } from './types'

/** The route prefix the host registers. */
const PREFIX = '/toolbridge/api'

/** A job as the panel reads it; a subset of the host's view. */
export interface PanelJob {
  id: string
  kind: string
  argv: string[]
  status: string
  lane: string
  long: boolean
  aheadOf: number
  exitCode: number | null
  durationSec: number | null
  summary: string | null
  error: string | null
  tail?: string
}

/** Everything the sidebar needs for one conversation. */
export interface SessionView {
  sessionId: string | null
  toggles: ToggleState
  defaults: ToggleState
  cwd: string | null
  lanes: { queue: number; long: number }
  /** A browser connection is mounted (the fact, as opposed to the switch's intent). */
  browserMounted: boolean
  /** Why the last browser mount failed; null when there is nothing to report. */
  browserError: string | null
  jobs: PanelJob[]
  config: {
    dartFormatExe: string | null
    defaultTimeoutSec: number
    playwright: { browser: string; caps: string; outputDir: string | null }
  }
}

/** A failed call, as a value rather than a throw at the call site. */
export type Fetched<T> = { ok: true; value: T } | { ok: false; message: string }

async function request<T>(path: string, init?: RequestInit): Promise<Fetched<T>> {
  try {
    const response = await fetch(`${PREFIX}${path}`, {
      headers: { 'content-type': 'application/json' },
      ...init,
    })
    const text = await response.text()
    if (!response.ok) {
      let message = `HTTP ${response.status}`
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } }
        if (parsed.error?.message !== undefined) message = parsed.error.message
      } catch {
        // A non-JSON body is the status line's job to describe.
      }
      return { ok: false, message }
    }
    return { ok: true, value: JSON.parse(text) as T }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** Read one conversation's state, jobs and lane depth. */
export function fetchState(sessionId: string): Promise<Fetched<SessionView>> {
  return request<SessionView>(`/state?sessionId=${encodeURIComponent(sessionId)}`)
}

/** Read one job's log tail, for the panel's expanded row. */
export function fetchJob(id: string, tail: number): Promise<Fetched<PanelJob>> {
  return request<PanelJob>(`/job?id=${encodeURIComponent(id)}&tail=${String(tail)}`)
}

/** Flip one switch, and get back the state the host actually applied. */
export function postToggle(
  sessionId: string,
  key: keyof ToggleState,
  value: boolean,
): Promise<Fetched<{ sessionId: string; toggles: ToggleState }>> {
  return request<{ sessionId: string; toggles: ToggleState }>('/toggle', {
    method: 'POST',
    body: JSON.stringify({ sessionId, key, value }),
  })
}

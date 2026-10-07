/**
 * The sidebar panel: what this conversation's toolchain is doing.
 *
 * The retired server opened a browser tab at boot for exactly this, and paid for
 * it with a token in the address bar and a page that went stale whenever the
 * process restarted. That tab is replaced by a per-conversation panel that
 * cannot go stale — it asks the plugin that owns the jobs — and that shows the
 * two facts the human actually needs when a build looks stuck: how deep each lane
 * is, and what the current job is printing.
 *
 * The panel is deliberately read-only about the switches: they live in the
 * conversation header, and a capability switch duplicated in two places is a
 * switch that eventually disagrees with itself.
 */

import { useCallback, useEffect, useState } from 'react'

import { fetchJob, fetchState } from './api'
import type { PanelJob, SessionView } from './api'

const panel: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
  fontSize: '12px',
  lineHeight: '18px',
  padding: '10px',
}

const sectionTitle: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 600,
  letterSpacing: '0.04em',
  opacity: 0.6,
  textTransform: 'uppercase',
}

const factRow: React.CSSProperties = { display: 'flex', gap: '6px', opacity: 0.85 }
const jobRow = (selected: boolean): React.CSSProperties => ({
  border: '1px solid currentColor',
  borderRadius: '6px',
  cursor: 'pointer',
  opacity: selected ? 1 : 0.75,
  padding: '6px 8px',
  textAlign: 'left',
  width: '100%',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
})

const tailBox: React.CSSProperties = {
  border: '1px solid currentColor',
  borderRadius: '6px',
  maxHeight: '320px',
  opacity: 0.9,
  overflow: 'auto',
  padding: '6px 8px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
}

/** How one job reads at a glance. */
function jobLine(job: PanelJob): string {
  const parts = [job.status]
  if (job.lane === 'long') parts.push('long lane')
  if (job.exitCode !== null) parts.push(`exit ${job.exitCode}`)
  if (job.durationSec !== null) parts.push(`${job.durationSec}s`)
  if (job.status === 'queued' && job.aheadOf > 0) parts.push(`behind ${job.aheadOf}`)
  return parts.join(' · ')
}

/** Props the slot runtime passes to a tab body, plus the fallback we thread ourselves. */
export interface BridgePanelProps {
  /** The conversation, when the slot runtime supplies it. */
  sessionId?: string
  /** Framework-bound tab reader, present for a sidebar tab body. */
  useTabInfo?: () => { tab?: { navigation?: { params?: unknown } }; actions?: { close?: () => void } }
}

/**
 * Render the panel.
 * @param props - slot props; the session id may arrive directly or through navigation params.
 */
export function BridgePanel(props: BridgePanelProps): React.ReactElement {
  const sessionId = resolveSessionId(props)
  const [view, setView] = useState<SessionView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [tail, setTail] = useState<string>('')

  const refresh = useCallback(async (): Promise<void> => {
    const result = await fetchState(sessionId ?? '')
    if (result.ok) {
      setView(result.value)
      setError(null)
    } else {
      setError(result.message)
    }
  }, [sessionId])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 4000)
    return () => clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    if (selected === null) {
      setTail('')
      return
    }
    let live = true
    const read = async (): Promise<void> => {
      const result = await fetchJob(selected, 200)
      if (!live) return
      if (result.ok) setTail(result.value.tail ?? '')
      else setTail(`(${result.message})`)
    }
    void read()
    const timer = setInterval(() => void read(), 4000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [selected])

  if (view === null) {
    return <div style={panel}>{error === null ? 'Reading tool-bridge state…' : `Tool bridge: ${error}`}</div>
  }

  const jobs = view.jobs
  return (
    <div style={panel}>
      <div>
        <div style={sectionTitle}>Conversation</div>
        <div style={factRow}>
          <span>{view.cwd ?? 'no working directory yet'}</span>
        </div>
        <div style={factRow}>
          <span>Toolchain {view.toggles.bridge ? 'on' : 'off'}</span>
          <span>·</span>
          <span>Browser {view.browserMounted ? 'connected' : view.toggles.browser ? 'starting' : 'off'}</span>
        </div>
      </div>

      <div>
        <div style={sectionTitle}>Lanes</div>
        <div style={factRow}>
          <span>queue {view.lanes.queue}</span>
          <span>·</span>
          <span>long {view.lanes.long}</span>
        </div>
        <div style={factRow}>
          <span>
            {view.config.dartFormatExe === null
              ? 'formatter: PATH dart (no CI pin)'
              : `formatter pin: ${view.config.dartFormatExe}`}
          </span>
        </div>
        <div style={factRow}>
          <span>
            browser: {view.config.playwright.browser} · caps {view.config.playwright.caps}
          </span>
        </div>
      </div>

      <div>
        <div style={sectionTitle}>Jobs ({jobs.length})</div>
        {jobs.length === 0 ? (
          <div style={{ opacity: 0.7 }}>Nothing has run in this conversation yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {[...jobs].reverse().map((job) => (
              <button
                key={job.id}
                type="button"
                style={jobRow(job.id === selected)}
                onClick={() => setSelected(job.id === selected ? null : job.id)}
              >
                <div>{jobLine(job)}</div>
                <div style={{ opacity: 0.8, wordBreak: 'break-all' }}>{job.argv.join(' ')}</div>
                {job.summary === null ? null : <div>{job.summary}</div>}
                {job.error === null ? null : <div style={{ color: '#c0392b' }}>{job.error}</div>}
              </button>
            ))}
          </div>
        )}
      </div>

      {selected === null ? null : (
        <div>
          <div style={sectionTitle}>Log</div>
          <div style={tailBox}>{tail === '' ? '(no output yet)' : tail}</div>
        </div>
      )}
    </div>
  )
}

/** The session id a tab body needs, from the props or the tab's navigation params. */
function resolveSessionId(props: BridgePanelProps): string | undefined {
  if (props.sessionId !== undefined && props.sessionId !== '') return props.sessionId
  const params = props.useTabInfo?.().tab?.navigation?.params
  if (typeof params === 'object' && params !== null) {
    const candidate = (params as { sessionId?: unknown }).sessionId
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

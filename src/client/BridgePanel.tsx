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
 * **Which conversation it is a panel of comes from the seat, not from the tab.**
 * The seat is session-scoped, so the framework resolves the conversation of the
 * pane this body is drawn in and hands it over (`sessionId` below). It is not
 * read off `useTabInfo().tab.navigation.params`: the sidebar's own guide opens a
 * page type by kind alone, so a panel opened from the guide carries no
 * navigation parameters at all — reading them left this panel asking the host
 * about no conversation, and the host answered "0 jobs" for every one of them
 * (ADR-0012).
 *
 * The panel is deliberately read-only about the switches: they live in the
 * conversation row above the composer, and a capability switch duplicated in two
 * places is a switch that eventually disagrees with itself.
 *
 * Three layout rules are load-bearing:
 *
 * - **This panel IS the scroll region** (`panelFrame` carries the three
 *   properties, with the measurement behind them). Since 0.2.0-rc the sidebar
 *   clips every tab body in a fixed-height `overflow:hidden` flex container, so a
 *   panel that does not scroll itself has no scroller anywhere in its subtree and
 *   its content is simply cut off at the fold.
 * - **The log also scrolls**, and caps its own height, so a chatty build cannot
 *   push the job list out of reach even though the panel scrolls underneath it.
 * - **Every colour, border and face comes from `./theme`**, which is one place
 *   where the shell's design tokens are named — the same vocabulary the switch
 *   row and the tab chip use.
 */

import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

import { fetchJob, fetchState } from './api'
import type { PanelJob, SessionView } from './api'
import { HAIRLINE, card, danger, dot, jobRow, logBody, mono, muted, panelFrame, pill, sectionTitle } from './theme'

/** The panel's own frame: a stack of blocks, monospace, and the subtree's scroller. */
const panel = panelFrame

/** A row of capsules, wrapping on a narrow sidebar. */
const pillRow: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '4px' }

/** A card whose children run edge to edge, so hairline separators span it. */
const flushCard: CSSProperties = { ...card, padding: 0, gap: 0, overflow: 'hidden' }

/** The left column of a job row: the dot. */
const dotColumn: CSSProperties = { paddingTop: '7px' }

/** The right column of a job row: argv, then the facts, then the summary. */
const jobText: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0, flex: 1 }

/** The log's banner: the argv the tail belongs to, and the job's state. */
const logBanner: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '8px',
  padding: '6px 10px',
  borderBottom: HAIRLINE,
  color: 'var(--dsw-alias-label-tertiary)',
  fontFamily: mono.fontFamily,
  fontSize: '11px',
}

/** The status dot's colour, by job state. */
const DOT_COLOUR: Readonly<Record<string, string>> = {
  queued: 'var(--dsw-alias-label-tertiary)',
  running: 'var(--dsw-alias-label-secondary)',
  done: 'var(--dsw-alias-label-tertiary)',
  failed: 'var(--dsw-alias-state-error-primary)',
  killed: 'var(--dsw-alias-state-error-primary)',
}

/** How one job reads at a glance, beside its argv. */
function jobLine(job: PanelJob): string {
  const parts = [job.status]
  if (job.lane === 'long') parts.push('long lane')
  if (job.exitCode !== null) parts.push(`exit ${job.exitCode}`)
  if (job.durationSec !== null) parts.push(`${job.durationSec}s`)
  if (job.status === 'queued' && job.aheadOf > 0) parts.push(`behind ${job.aheadOf}`)
  return parts.join(' · ')
}

/** What the Browser capsule says: the switch's intent and the connection's fact, told apart. */
function browserWord(view: SessionView): string {
  if (view.browserMounted) return 'connected'
  return view.toggles.browser ? 'starting' : 'off'
}

/** Where the formatter comes from, as one line. */
function formatterLine(view: SessionView): string {
  return view.config.dartFormatExe === null
    ? 'formatter: PATH dart (no CI pin)'
    : `formatter pin: ${view.config.dartFormatExe}`
}

/**
 * What the tab seat hands this panel.
 *
 * A session-scoped seat is rendered under one conversation's scope, and the
 * framework resolves that scope before the body can mount at all — a strict
 * session slot with no binding is a `SlotAssemblyError`, not an empty id. So
 * there is no "which conversation?" case to handle here, and none to guess at.
 */
export interface BridgePanelInjected {
  /** The conversation of the pane this tab is drawn in. */
  sessionId: string
}

/** The panel's props: the seat's runtime face plus the session the seat resolved. */
export type BridgePanelProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & InjectFace<BridgePanelInjected>

/**
 * Render the panel.
 * @param props - the seat's runtime face and the conversation it belongs to.
 */
export function BridgePanel({ sessionId }: BridgePanelProps): React.ReactElement {
  const [view, setView] = useState<SessionView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [tail, setTail] = useState<string>('')

  const refresh = useCallback(async (): Promise<void> => {
    const result = await fetchState(sessionId)
    if (result.ok) {
      setView(result.value)
      setError(null)
    } else {
      setError(result.message)
    }
  }, [sessionId])

  useEffect(() => {
    void refresh()
    // The browser half connects and the lanes move on their own; a slow poll
    // keeps the panel honest without an event stream the host does not have.
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
  const selectedJob = jobs.find((job) => job.id === selected) ?? null

  return (
    <div style={panel}>
      <div style={card}>
        <div style={{ wordBreak: 'break-all' }}>{view.cwd ?? 'no working directory yet'}</div>
        <div style={pillRow}>
          <span style={pill}>toolchain {view.toggles.bridge ? 'on' : 'off'}</span>
          <span style={pill}>browser {browserWord(view)}</span>
        </div>
        {view.browserError === null ? null : (
          <div style={danger} role="alert">
            browser failed: {view.browserError}
          </div>
        )}
        <div style={muted}>{formatterLine(view)}</div>
        <div style={muted}>
          browser: {view.config.playwright.browser} · caps {view.config.playwright.caps}
        </div>
      </div>

      <div>
        <div style={sectionTitle}>Lanes</div>
        <div style={{ ...pillRow, marginTop: '4px' }}>
          <span style={pill}>queue {view.lanes.queue}</span>
          <span style={pill}>long {view.lanes.long}</span>
        </div>
      </div>

      <div>
        <div style={sectionTitle}>Jobs ({jobs.length})</div>
        {jobs.length === 0 ? (
          <div style={{ ...muted, marginTop: '4px' }}>Nothing has run in this conversation yet.</div>
        ) : (
          <div style={{ ...flushCard, marginTop: '4px' }}>
            {[...jobs].reverse().map((job, index) => (
              <button
                key={job.id}
                type="button"
                style={{
                  ...jobRow(job.id === selected),
                  ...(index === 0 ? {} : { borderTop: HAIRLINE }),
                }}
                onClick={() => setSelected(job.id === selected ? null : job.id)}
              >
                <span style={dotColumn}>
                  {/* The status word is in the text below; the dot only colours it. */}
                  <span style={dot(DOT_COLOUR[job.status] ?? 'var(--dsw-alias-label-secondary)')} aria-hidden />
                </span>
                <span style={jobText}>
                  <span style={{ wordBreak: 'break-all' }}>{job.argv.join(' ')}</span>
                  <span style={muted}>{jobLine(job)}</span>
                  {job.summary === null ? null : <span style={muted}>{job.summary}</span>}
                  {job.error === null ? null : <span style={danger}>{job.error}</span>}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {selectedJob === null ? null : (
        <div>
          <div style={sectionTitle}>Log</div>
          <div style={{ ...flushCard, marginTop: '4px' }}>
            <div style={logBanner}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selectedJob.argv.join(' ')}
              </span>
              <span style={{ marginLeft: 'auto', flex: 'none' }}>{jobLine(selectedJob)}</span>
            </div>
            <div style={logBody}>{tail === '' ? '(no output yet)' : tail}</div>
          </div>
        </div>
      )}
    </div>
  )
}

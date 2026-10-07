/**
 * Per-conversation toggles: which halves are on, kept durably.
 *
 * The state is two booleans per session, and it has to survive a resume — turning
 * the browser on for a conversation and finding it off after the harness
 * restarts would be worse than not having the switch. It is therefore a small
 * JSON document under the plugin's own state directory, written atomically
 * (temp file plus rename) so a crash mid-write leaves the previous record rather
 * than a truncated one.
 *
 * Unknown sessions fall back to the configured defaults, which is what makes a
 * default change apply to conversations nobody has switched yet without
 * rewriting the ones that were switched on purpose.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Which halves of the plugin a conversation has on. */
export interface ToggleState {
  /** The toolchain tools (`bridge_run`, `bridge_arb_edit`). */
  bridge: boolean
  /** Playwright MCP's browser tools. */
  browser: boolean
}

/** One session's record: the switches, plus the directory it was switched in. */
interface SessionRecord extends ToggleState {
  /** The working directory this session ran in, for the sidebar's lane view. */
  cwd?: string
  /** Epoch ms of the last change, for a stable listing order. */
  changedAt: number
}

interface Document {
  version: 1
  sessions: Record<string, SessionRecord>
}

const EMPTY: Document = { version: 1, sessions: {} }

export class ToggleStore {
  private document: Document

  constructor(
    private readonly file: string,
    private readonly defaults: ToggleState,
  ) {
    this.document = this.load()
  }

  private load(): Document {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Document>
      if (raw.version !== 1 || typeof raw.sessions !== 'object' || raw.sessions === null) return { ...EMPTY }
      return { version: 1, sessions: raw.sessions as Record<string, SessionRecord> }
    } catch {
      // No file yet, or one this version cannot read: the defaults are the
      // honest answer, and the next write replaces the document.
      return { ...EMPTY }
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, JSON.stringify(this.document, null, 2), 'utf8')
    renameSync(temporary, this.file)
  }

  /**
   * The switches for one session.
   * @param sessionId - the conversation's session id.
   * @returns its state, or the configured defaults when it never changed one.
   */
  get(sessionId: string): ToggleState {
    const record = this.document.sessions[sessionId]
    if (record === undefined) return { ...this.defaults }
    return { bridge: record.bridge, browser: record.browser }
  }

  /** The directory this session was last seen in, for the sidebar. */
  cwd(sessionId: string): string | undefined {
    return this.document.sessions[sessionId]?.cwd
  }

  /** Remember the directory a session runs in, without touching its switches. */
  remember(sessionId: string, cwd: string): void {
    const record = this.document.sessions[sessionId]
    if (record?.cwd === cwd) return
    this.document.sessions[sessionId] = {
      ...(record ?? { ...this.defaults, changedAt: Date.now() }),
      cwd,
      changedAt: record?.changedAt ?? Date.now(),
    }
    this.persist()
  }

  /**
   * Set one switch for one session and write it durably.
   * @param sessionId - the conversation.
   * @param key - which half.
   * @param value - its new state.
   * @returns the session's complete state after the change.
   */
  set(sessionId: string, key: keyof ToggleState, value: boolean): ToggleState {
    const record = this.document.sessions[sessionId] ?? { ...this.defaults, changedAt: Date.now() }
    this.document.sessions[sessionId] = { ...record, [key]: value, changedAt: Date.now() }
    this.persist()
    return this.get(sessionId)
  }

  /** The configured defaults, for the sidebar and the API. */
  get defaultState(): ToggleState {
    return { ...this.defaults }
  }
}

/** Where the toggle document lives under a state directory. */
export function toggleFile(stateDir: string): string {
  return join(stateDir, 'toggles.json')
}

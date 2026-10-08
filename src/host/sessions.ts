/**
 * Applying a conversation's switches to its live agent.
 *
 * A toggle is not a setting that is read later: it decides what the agent can
 * see and what processes exist, both of which change *now*. Two mechanisms do
 * the work, and they are different on purpose.
 *
 * - The toolchain half is registered once, globally, and a conversation that
 *   switched it off gets a **restriction** on its own agent scope
 *   (`ctx.tools.restrict`). That mask is what keeps the two schemas out of that
 *   conversation's prompt, lifts when the agent goes away, and — being scoped —
 *   cannot be seen by any other conversation.
 * - The browser half is a **scoped plugin load**: the MCP client is loaded into a
 *   scope minted for this agent, so its tools and its server process exist only
 *   while the switch is on and belong to that conversation alone.
 *
 * Both take effect immediately. Registering or restricting tools changes the
 * next request's tool set, and the MCP client connects as soon as it loads; the
 * only honest caveat is that a change invalidates the request prefix from that
 * point on, which is what any tool-set change does.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

import { BROWSER_SERVER_NAME, mountBrowser } from './browser'
import type { BridgeEngine } from './bridge'
import type { ToolBridgeConfig } from './config'
import type { ToggleState, ToggleStore } from './toggles'

/** The model-facing names the toolchain half owns. */
export const BRIDGE_TOOL_NAMES = ['bridge_run', 'bridge_arb_edit'] as const

/** What one session's switches currently do to its agent. */
interface Applied {
  /** Lifts the tool restriction, when one is in force. */
  unrestrict?: () => void
  /** Closes the browser connection, when one was mounted. */
  unmountBrowser?: () => Promise<void>
}

/** What the sidebar reads for one conversation. */
export interface PanelState {
  /** The conversation this answers for, exactly as it was asked for. */
  sessionId: string
  toggles: ToggleState
  defaults: ToggleState
  cwd: string | null
  lanes: { queue: number; long: number }
  /** Whether a browser connection is actually mounted, as opposed to switched on. */
  browserMounted: boolean
  /**
   * Why the last browser mount failed, when it did.
   *
   * The switch carries *intent*; this carries the *fact*. Without it a browser
   * that would not start is indistinguishable from one that is connected, and
   * the switch would show "on" for a capability that is not there.
   */
  browserError: string | null
}

export class SessionSwitches {
  private readonly applied = new Map<string, Applied>()
  /** Live agents by session id, so a panel read can report a session's directory. */
  private readonly live = new Map<string, Agent>()
  /** Why a conversation's last browser mount failed; cleared by a successful mount or a switch-off. */
  private readonly browserErrors = new Map<string, string>()

  constructor(
    private readonly ctx: Context,
    private readonly engine: BridgeEngine,
    private readonly store: ToggleStore,
    private readonly config: ToolBridgeConfig,
  ) {}

  /**
   * Bring one freshly created agent in line with its conversation's switches.
   *
   * Registered on the serial `agent/created` event, so the tools and the
   * connection exist before the conversation's first model request — a
   * restriction applied later would still cost the schemas of the request that
   * raced it.
   * @param agent - the created agent.
   */
  async onAgentCreated(agent: Agent): Promise<void> {
    const cwd = agent.session.header.cwd
    if (cwd !== undefined) this.store.remember(agent.id, cwd)
    this.live.set(agent.id, agent)
    const state = this.store.get(agent.id)
    // The agent's own scope owns both effects, so disposal unwinds them even if
    // nothing else ever touches this map again.
    agent.ctx.effect(() => async () => {
      await this.detach(agent.id)
    }, 'toolbridge switches')
    if (!state.bridge) this.applyRestriction(agent)
    if (state.browser) await this.attachBrowser(agent)
  }

  /** Release whatever one session had applied, on its disposal. */
  async onAgentDisposed(agent: Agent): Promise<void> {
    this.live.delete(agent.id)
    await this.detach(agent.id)
  }

  /**
   * Flip one switch and apply it to the live conversation when there is one.
   * @param sessionId - the conversation.
   * @param key - which half.
   * @param value - its new state.
   * @returns the conversation's complete switch state.
   */
  async set(sessionId: string, key: keyof ToggleState, value: boolean): Promise<ToggleState> {
    const toggles = this.store.set(sessionId, key, value)
    const agent = this.ctx.agents.get(sessionId as never) as Agent | undefined
    if (agent !== undefined) {
      if (key === 'bridge') {
        if (value) this.applied.get(sessionId)?.unrestrict?.()
        else this.applyRestriction(agent)
      } else if (value) {
        await this.attachBrowser(agent)
      } else {
        await this.detachBrowser(sessionId)
      }
    }
    return toggles
  }

  /**
   * Everything the sidebar needs about one conversation.
   *
   * The conversation is named by the caller and never inferred here. It used to
   * accept an empty id and fall back to "the only live session", which is what
   * made a panel with no conversation render as a well-formed `Jobs (0)` rather
   * than as the absence it was: the browser half asked with no id exactly when it
   * did not know which pane it was in, and this answered confidently about a
   * different question (ADR-0012).
   * @param sessionId - the conversation, named by the seat the panel is drawn in.
   * @returns the panel's view.
   */
  async state(sessionId: string): Promise<PanelState> {
    const toggles = this.store.get(sessionId)
    const known = this.store.cwd(sessionId)
    const live = this.live.get(sessionId) ?? (this.ctx.agents.get(sessionId as never) as Agent | undefined)
    const cwd = live?.session.header.cwd ?? known
    return {
      sessionId,
      toggles,
      defaults: this.store.defaultState,
      cwd: cwd ?? null,
      lanes: cwd === undefined ? { queue: 0, long: 0 } : this.engine.depth(cwd),
      browserMounted: this.applied.get(sessionId)?.unmountBrowser !== undefined,
      browserError: this.browserErrors.get(sessionId) ?? null,
    }
  }

  private applyRestriction(agent: Agent): void {
    const applied = this.applied.get(agent.id) ?? {}
    if (applied.unrestrict !== undefined) return
    // Deny rather than allow: the mask must not decide anything about tools the
    // plugin does not own, so a later shipped tool is unaffected by it.
    applied.unrestrict = agent.ctx.tools.restrict({ deny: [...BRIDGE_TOOL_NAMES] })
    this.applied.set(agent.id, applied)
  }

  private async attachBrowser(agent: Agent): Promise<void> {
    const applied = this.applied.get(agent.id) ?? {}
    if (applied.unmountBrowser !== undefined) return
    try {
      const unmount = await mountBrowser(this.ctx, agent, this.config)
      this.applied.set(agent.id, { ...applied, unmountBrowser: unmount })
      this.browserErrors.delete(agent.id)
    } catch (error) {
      // A browser that will not start must not fail the conversation: the half
      // is optional, and the caller can read why and try again by flipping the
      // switch after fixing it. The reason is kept so the row can say so —
      // a switch left showing "on" over an absent browser would be a lie.
      const reason = error instanceof Error ? error.message : String(error)
      this.browserErrors.set(agent.id, reason)
      this.ctx.logger.error(
        `toolbridge: browser MCP for ${BROWSER_SERVER_NAME} failed to start for session ${agent.id}: ${reason}`,
      )
    }
  }

  private async detachBrowser(sessionId: string): Promise<void> {
    // Switching the half off is not a failure state: the reason goes with the
    // connection, so a later switch-on starts from a clean row.
    this.browserErrors.delete(sessionId)
    const applied = this.applied.get(sessionId)
    if (applied === undefined) return
    const unmount = applied.unmountBrowser
    if (unmount === undefined) return
    // Hold the disposer in a local before clearing the slot. Reading it back off
    // the record after clearing it yields `undefined`, and awaiting that calls
    // nothing at all: the connection and its browser outlive the switch-off, and
    // the panel reports a mount that is still there as gone.
    applied.unmountBrowser = undefined
    await unmount()
  }

  private async detach(sessionId: string): Promise<void> {
    const applied = this.applied.get(sessionId)
    if (applied === undefined) return
    this.applied.delete(sessionId)
    applied.unrestrict?.()
    await applied.unmountBrowser?.()
  }
}

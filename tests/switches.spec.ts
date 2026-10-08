/**
 * The conversation switches, at the seam the browser half's switch-off used to
 * break.
 *
 * Switching the browser half OFF has to close the connection that switching it
 * on opened. The recorded toggle is not that mechanism: a toggle can read
 * `false` while the MCP server and its browser process are still alive, which is
 * what a disposer that is cleared but never called produces — and the sidebar
 * reads `browserMounted` off that same cleared slot, so it reports the surviving
 * connection as gone. These cases therefore assert on the *disposer being
 * called*, not on the state that surrounds it.
 *
 * Every case drives `SessionSwitches` with a stubbed agent and a mocked
 * `mountBrowser`, so no MCP server, no Playwright and no browser process is
 * involved.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mountBrowser = vi.hoisted(() => vi.fn())

vi.mock('../src/host/browser', () => ({
  BROWSER_SERVER_NAME: 'ui',
  mountBrowser,
}))

import { SessionSwitches } from '../src/host/sessions'
import type { ToggleState } from '../src/host/toggles'

const SESSION = 'session-under-test'

/** The parts of an agent the switch logic touches. */
interface FakeAgent {
  id: string
  session: { header: { cwd: string } }
  ctx: {
    effect: (body: () => unknown, label?: string) => void
    tools: { restrict: (mask: unknown) => () => void }
  }
}

/** A fresh agent for the session under test; nothing is mounted until `set` says so. */
function makeAgent(id: string = SESSION, cwd: string = 'D:\\Projects\\demo'): FakeAgent {
  return {
    id,
    session: { header: { cwd } },
    ctx: { effect: () => {}, tools: { restrict: () => () => {} } },
  }
}

/** The toggle record, in memory: the switch state is the input, never the assertion. */
class FakeStore {
  private readonly sessions = new Map<string, ToggleState>()
  private readonly directories = new Map<string, string>()

  get(id: string): ToggleState {
    return this.sessions.get(id) ?? { bridge: true, browser: false }
  }

  set(id: string, key: keyof ToggleState, value: boolean): ToggleState {
    const next = { ...this.get(id), [key]: value }
    this.sessions.set(id, next)
    return next
  }

  /** The directory this session was last seen in, as the durable store remembers it. */
  cwd(id: string): string | undefined {
    return this.directories.get(id)
  }

  remember(id: string, cwd: string): void {
    this.directories.set(id, cwd)
  }
}

/** The switches, wired to one agent and nothing else. */
function makeSwitches(agent: FakeAgent): SessionSwitches {
  const ctx = {
    agents: { get: (id: string) => (id === agent.id ? agent : undefined) },
    logger: { error: () => {} },
  }
  return new SessionSwitches(ctx as never, {} as never, new FakeStore() as never, {} as never)
}

describe('switching the browser half', () => {
  beforeEach(() => {
    mountBrowser.mockReset()
  })

  it('closes the connection when the half is switched off', async () => {
    const unmount = vi.fn(async () => {})
    mountBrowser.mockResolvedValue(unmount)
    const switches = makeSwitches(makeAgent())

    await switches.set(SESSION, 'browser', true)
    expect(mountBrowser).toHaveBeenCalledTimes(1)
    expect(unmount).not.toHaveBeenCalled()

    await switches.set(SESSION, 'browser', false)
    expect(unmount).toHaveBeenCalledTimes(1)
  })

  it('disposes once, not once per switch-off', async () => {
    const unmount = vi.fn(async () => {})
    mountBrowser.mockResolvedValue(unmount)
    const switches = makeSwitches(makeAgent())

    await switches.set(SESSION, 'browser', true)
    await switches.set(SESSION, 'browser', false)
    await switches.set(SESSION, 'browser', false)

    expect(unmount).toHaveBeenCalledTimes(1)
  })

  it('mounts again after a switch-off, and closes that connection too', async () => {
    const first = vi.fn(async () => {})
    const second = vi.fn(async () => {})
    mountBrowser.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const switches = makeSwitches(makeAgent())

    await switches.set(SESSION, 'browser', true)
    await switches.set(SESSION, 'browser', false)
    await switches.set(SESSION, 'browser', true)
    await switches.set(SESSION, 'browser', false)

    expect(mountBrowser).toHaveBeenCalledTimes(2)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when nothing was mounted', async () => {
    const switches = makeSwitches(makeAgent())

    await switches.set(SESSION, 'browser', false)

    expect(mountBrowser).not.toHaveBeenCalled()
  })
})

/**
 * The panel read, which used to answer a question nobody asked.
 *
 * `state('')` meant "the only live session, whichever it is" — a guess the
 * browser half fell back on exactly when it did not know which pane it was in,
 * and which answered `0 jobs` for a conversation that had run plenty (ADR-0012).
 * The read is now about the id it was given and nothing else, live agent or not,
 * and an empty id is a question this class no longer has an answer to.
 */
describe('reading one conversation’s panel state', () => {
  /** The switches with lane depth, a remembered directory, and one agent that can be brought live. */
  function makePanelSwitches(): {
    switches: SessionSwitches
    bringLive: (id: string, cwd: string) => Promise<void>
  } {
    const store = new FakeStore()
    store.remember('session-b', 'D:\\Projects\\other')
    const engine = {
      depth: (cwd: string): { queue: number; long: number } => ({ queue: cwd === 'D:\\Projects\\other' ? 2 : 0, long: 0 }),
    }
    const ctx = {
      agents: { get: (id: string) => (id === 'session-a' ? makeAgent('session-a') : undefined) },
      logger: { error: () => {} },
    }
    const switches = new SessionSwitches(ctx as never, engine as never, store as never, {} as never)
    return {
      switches,
      bringLive: async (id, cwd) => {
        await switches.onAgentCreated(makeAgent(id, cwd) as never)
      },
    }
  }

  it('answers for the conversation it was asked about, from that conversation’s directory', async () => {
    const state = await makePanelSwitches().switches.state('session-b')

    expect(state.sessionId).toBe('session-b')
    expect(state.cwd).toBe('D:\\Projects\\other')
    // Lane depth follows the directory, not the session that happens to be live.
    expect(state.lanes).toEqual({ queue: 2, long: 0 })
  })

  it('answers "nothing yet" for a conversation with no agent and no directory', async () => {
    const state = await makePanelSwitches().switches.state('session-c')

    expect(state.sessionId).toBe('session-c')
    expect(state.cwd).toBeNull()
    expect(state.lanes).toEqual({ queue: 0, long: 0 })
    expect(state.toggles).toEqual({ bridge: true, browser: false })
  })

  it('does not fall back to the sole live session when the id is empty', async () => {
    const { switches, bringLive } = makePanelSwitches()
    // Exactly one conversation is live — the condition the old fallback needed —
    // and its directory is right there to be mistaken for an answer.
    await bringLive('session-a', 'D:\\Projects\\demo')

    const state = await switches.state('')

    // The guess would have reported `session-a`'s directory and lanes here; the
    // route refuses the empty id long before this, and the class has no second
    // meaning for it to fall back on.
    expect(state.cwd).toBeNull()
    expect(state.lanes).toEqual({ queue: 0, long: 0 })
  })
})

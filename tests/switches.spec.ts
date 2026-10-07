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
function makeAgent(): FakeAgent {
  return {
    id: SESSION,
    session: { header: { cwd: 'D:\\Projects\\demo' } },
    ctx: { effect: () => {}, tools: { restrict: () => () => {} } },
  }
}

/** The toggle record, in memory: the switch state is the input, never the assertion. */
class FakeStore {
  private readonly sessions = new Map<string, ToggleState>()

  get(id: string): ToggleState {
    return this.sessions.get(id) ?? { bridge: true, browser: false }
  }

  set(id: string, key: keyof ToggleState, value: boolean): ToggleState {
    const next = { ...this.get(id), [key]: value }
    this.sessions.set(id, next)
    return next
  }

  remember(): void {}
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

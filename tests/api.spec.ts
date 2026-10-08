/**
 * The sidebar's route, at the one question it used to answer wrongly.
 *
 * `/state` tolerated a missing `sessionId` and answered for "the only live
 * session", which is how a panel with no conversation came back as a
 * well-formed `Jobs (0)` instead of as the absence it was (ADR-0012). The route
 * now requires the id, and the jobs it reports are the conversation's own — the
 * two halves that keep "no conversation" from being answered as "nothing ran".
 *
 * The route is driven directly with a stub request and response, and the engine
 * and switch surfaces are stubs: what is under test is the shape of the request
 * the route accepts and what it forwards, not HTTP plumbing or the job ledger.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import { API_PREFIX, registerApi } from '../src/host/api'
import type { BridgeEngine } from '../src/host/bridge'
import type { ToolBridgeConfig } from '../src/host/config'
import type { SessionSwitches } from '../src/host/sessions'

/** The resolved configuration, spelled out: the route only reads a few fields. */
const CONFIG: ToolBridgeConfig = {
  stateDir: '',
  defaults: { bridge: true, browser: false },
  dartFormatExe: '',
  playwright: { browser: 'msedge', caps: 'vision,devtools', outputDir: '', toolCallTimeoutMs: 120_000, args: [] },
  defaultTimeoutSec: 600,
}

/** A response stub that records the status and the body a handler wrote. */
function recordingResponse(): { res: ServerResponse; status: () => number; json: () => Record<string, unknown> } {
  let status = 0
  let body = ''
  const res = {
    writeHead: (code: number): void => {
      status = code
    },
    end: (text: string): void => {
      body = text
    },
  } as unknown as ServerResponse
  return { res, status: () => status, json: () => JSON.parse(body) as Record<string, unknown> }
}

/** A request stub: the path below the prefix, the method, and a JSON body when one is sent. */
function request(path: string, method: string, body?: unknown): IncomingMessage {
  return {
    url: `${API_PREFIX}${path}`,
    method,
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
    },
  } as unknown as IncomingMessage
}

/** The registered route handler, wired to recording stubs. */
function routeFor(): {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  askedOwners: string[]
} {
  const askedOwners: string[] = []
  const engine = {
    listForOwner: (owner: string): unknown[] => {
      askedOwners.push(owner)
      // Only one conversation has ever run anything here, so a job list that
      // arrives for any other owner is itself the failure.
      return owner === 'session-a' ? [{ id: 'bridge-1' }] : []
    },
    read: (): undefined => undefined,
  } as unknown as BridgeEngine
  const switches = {
    state: async (sessionId: string): Promise<unknown> => ({
      sessionId,
      toggles: { bridge: true, browser: false },
      defaults: { bridge: true, browser: false },
      cwd: 'D:\\Projects\\demo',
      lanes: { queue: 0, long: 1 },
      browserMounted: false,
      browserError: null,
    }),
  } as unknown as SessionSwitches

  let handle: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
  const ctx = {
    webServer: {
      register: (route: { handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => {
        handle = route.handler
        return (): void => {}
      },
    },
  } as unknown as Context
  registerApi(ctx, engine, switches, CONFIG)
  if (handle === undefined) throw new Error('the route was never registered')
  return { handle, askedOwners }
}

describe('the sidebar route', () => {
  it('refuses a state read that names no conversation', async () => {
    const { handle, askedOwners } = routeFor()
    const response = recordingResponse()

    await handle(request('/state', 'GET'), response.res)

    expect(response.status()).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'bad-request' } })
    expect(String((response.json().error as { message: string }).message)).toContain('sessionId is required')
    // The load-bearing half: it did not quietly answer about some other
    // conversation instead.
    expect(askedOwners).toEqual([])
  })

  it('reports the jobs of the conversation it was asked about', async () => {
    const { handle, askedOwners } = routeFor()
    const response = recordingResponse()

    await handle(request('/state?sessionId=session-a', 'GET'), response.res)

    expect(response.status()).toBe(200)
    expect(response.json()).toMatchObject({ sessionId: 'session-a', lanes: { queue: 0, long: 1 } })
    expect(response.json().jobs).toEqual([{ id: 'bridge-1' }])
    expect(askedOwners).toEqual(['session-a'])
  })

  it('does not report one conversation’s jobs for another id', async () => {
    const { handle } = routeFor()
    const response = recordingResponse()

    await handle(request('/state?sessionId=session-b', 'GET'), response.res)

    expect(response.status()).toBe(200)
    expect(response.json()).toMatchObject({ sessionId: 'session-b', jobs: [] })
  })

  it('refuses a toggle that names no conversation or no switch', async () => {
    const { handle } = routeFor()
    const response = recordingResponse()

    await handle(request('/toggle', 'POST', { key: 'bridge', value: true }), response.res)

    expect(response.status()).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'bad-request' } })
  })
})

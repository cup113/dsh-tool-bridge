/**
 * Host↔browser transport for the sidebar and the header switches.
 *
 * A tree-out plugin cannot use the generated `ctx.remote.*` namespaces — their
 * client contracts are produced by the harness repository's own build — so this
 * uses the sanctioned alternative: a prefix route on `ctx.webServer` that the
 * browser half calls same-origin. The shell and the plugin share an origin, so
 * there is no token to hand out and nothing for a confined process to read.
 *
 * Every response is JSON, and every failure is JSON too: a client that gets a
 * non-JSON body cannot tell "the route is missing" from "the plugin threw".
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Context } from '@deepseek-ai/cordis'

import type { BridgeEngine } from './bridge'
import type { SessionSwitches } from './sessions'
import type { ToolBridgeConfig } from './config'

/** The route prefix the browser half fetches from. */
export const API_PREFIX = '/toolbridge/api'

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/**
 * Register the plugin's HTTP surface.
 * @param ctx - the plugin's context, already carrying `webServer`.
 * @param engine - the toolchain engine, for the job list.
 * @param switches - the per-session switches, for reads and writes.
 * @param config - resolved plugin configuration.
 * @returns the disposer that removes the route.
 */
export function registerApi(
  ctx: Context,
  engine: BridgeEngine,
  switches: SessionSwitches,
  config: ToolBridgeConfig,
): () => void {
  return ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const route = url.pathname.slice(API_PREFIX.length)
      try {
        if (route === '/state' && req.method === 'GET') {
          const sessionId = url.searchParams.get('sessionId') ?? ''
          // A panel is a view of one conversation and the seat it is drawn in is
          // session-scoped, so the browser half always knows which one it means.
          // Refusing the empty id is what keeps "no conversation" from being
          // answered as a well-formed empty panel: that guess (`the only live
          // session`) is what made a panel opened from the sidebar read `0 jobs`
          // however much the conversation had run (ADR-0012).
          if (sessionId === '') {
            send(res, 400, {
              error: {
                code: 'bad-request',
                message: 'sessionId is required: a panel answers for one conversation',
              },
            })
            return
          }
          const state = await switches.state(sessionId)
          send(res, 200, {
            ...state,
            jobs: engine.listForOwner(sessionId),
            config: {
              dartFormatExe: config.dartFormatExe === '' ? null : config.dartFormatExe,
              defaultTimeoutSec: config.defaultTimeoutSec,
              playwright: {
                browser: config.playwright.browser,
                caps: config.playwright.caps,
                outputDir: config.playwright.outputDir === '' ? null : config.playwright.outputDir,
              },
            },
          })
          return
        }
        if (route === '/toggle' && req.method === 'POST') {
          const body = await readJson(req)
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          const key = body.key === 'bridge' || body.key === 'browser' ? body.key : null
          if (sessionId === '' || key === null || typeof body.value !== 'boolean') {
            send(res, 400, { error: { code: 'bad-request', message: 'sessionId, key (bridge|browser) and value are required' } })
            return
          }
          const toggles = await switches.set(sessionId, key, body.value)
          send(res, 200, { sessionId, toggles })
          return
        }
        if (route === '/job' && req.method === 'GET') {
          const id = url.searchParams.get('id') ?? ''
          const grep = url.searchParams.get('grep')
          const tailRaw = url.searchParams.get('tail')
          const view = engine.read(id, grep, tailRaw === null ? undefined : Number(tailRaw))
          if (view === undefined) {
            send(res, 404, { error: { code: 'unknown-job', message: `unknown job: ${id}` } })
            return
          }
          send(res, 200, view)
          return
        }
        send(res, 404, { error: { code: 'not-found', message: `no route: ${route}` } })
      } catch (error) {
        send(res, 500, {
          error: { code: 'route-failed', message: error instanceof Error ? error.message : String(error) },
        })
      }
    },
  })
}

/**
 * The plugin entry: wiring, not behaviour.
 *
 * What this file decides is *composition*: which services the plugin waits for,
 * where its state and logs live, and that the switches are applied to a
 * conversation as it is created. Everything else is a module with one job.
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-tools'

import { registerApi } from './api'
import { BridgeEngine } from './bridge'
import { Config } from './config'
import type { ToolBridgeConfig } from './config'
import { Lanes } from './queue'
import { SessionSwitches } from './sessions'
import { ToggleStore, toggleFile } from './toggles'
import { registerBridgeTools } from './tools'

/** Cordis plugin name, used by loader diagnostics. */
export const name = 'toolbridge'

/**
 * Services this plugin needs. Every one of them is required: `tools` and `jobs`
 * are what a job *is* here, `agents` is how a switch reaches a live
 * conversation, and `webServer` is the sidebar's transport. A composition
 * without them would leave the plugin half-alive, which is worse than pending.
 */
export const inject = ['tools', 'jobs', 'agents', 'webServer']

export { Config }
export type { ToolBridgeConfig }

/**
 * Mount the plugin.
 * @param ctx - the plugin's context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: ToolBridgeConfig): void {
  const stateDir = resolveStateDir(config)
  mkdirSync(stateDir, { recursive: true })

  const engine = new BridgeEngine(ctx, new Lanes(), {
    logDir: join(stateDir, 'logs'),
    dartFormatExe: config.dartFormatExe,
  })
  const store = new ToggleStore(toggleFile(stateDir), {
    bridge: config.defaults.bridge,
    browser: config.defaults.browser,
  })
  const switches = new SessionSwitches(ctx, engine, store, config)

  registerBridgeTools(ctx, engine, config)
  ctx.effect(() => registerApi(ctx, engine, switches, config), 'toolbridge api')

  // Serial on purpose: the tools and the browser connection must exist before
  // the conversation's first model request, and this event is awaited before
  // queued input runs.
  ctx.on('agent/created', async ({ agent }) => {
    await switches.onAgentCreated(agent as Agent)
  })
  ctx.on('agent/disposed', async ({ agent }) => {
    await switches.onAgentDisposed(agent as Agent)
  })
}

/**
 * Where the plugin keeps its own state.
 *
 * `$DSH_HOME/toolbridge` is the harness's home when it is set, and `~/.dsh`
 * otherwise — the same directory the retired server's callers looked at, and one
 * nothing else in the plugin has to be told about.
 * @param config - resolved plugin configuration.
 * @returns the absolute state directory.
 */
function resolveStateDir(config: ToolBridgeConfig): string {
  if (config.stateDir !== '') return config.stateDir
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'toolbridge')
}

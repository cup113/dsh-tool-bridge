/**
 * The browser half: Playwright MCP, mounted for one conversation at a time.
 *
 * The retired arrangement was a profile row, which meant every session of the
 * profile paid for Playwright's tool catalog and opened a connection whether or
 * not that conversation would look at a page. Here the MCP client is loaded into
 * a scope minted for one agent, so:
 *
 * - the server process exists only while the toggle is on for that conversation,
 * - its tools are registered in that agent's scope, so no other conversation
 *   sees them and none pays their schema cost,
 * - disposal (toggle off, conversation over, plugin unload) closes the server.
 *
 * The pattern is the one the harness's own experimental browser providers use
 * (`createScope` + a scoped `ctx.plugin` of the MCP client), reproduced here in
 * the small: no attachment semantics, no exclusivity, no resource manager —
 * just "one connection per conversation that asked for one".
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'

import type { ToolBridgeConfig } from './config'

/** The model-facing namespace, kept as `ui` so the tool names stay `mcp__ui__browser_*`. */
export const BROWSER_SERVER_NAME = 'ui'

/** Build the server's argv from the configuration. */
export function playwrightArgs(config: ToolBridgeConfig): string[] {
  const args = [
    '-y',
    '@playwright/mcp@latest',
    `--browser=${config.playwright.browser}`,
    `--caps=${config.playwright.caps}`,
  ]
  if (config.playwright.outputDir !== '') {
    args.push(`--output-dir=${config.playwright.outputDir}`)
  }
  args.push(...config.playwright.args)
  return args
}

/**
 * Mount the browser MCP server for one conversation.
 *
 * The returned disposer closes the connection and unregisters the tools; it is
 * idempotent, because the toggle and the agent's own disposal can both reach it.
 * @param ctx - the plugin's context.
 * @param agent - the conversation's agent; its scope owns the connection.
 * @param config - resolved plugin configuration.
 * @returns a disposer that unmounts the server.
 */
export async function mountBrowser(ctx: Context, agent: Agent, config: ToolBridgeConfig): Promise<() => Promise<void>> {
  const scope: Scope = createScope(ctx, agent)
  try {
    await scope.ctx.plugin(
      McpClient,
      McpClient.Config({
        transport: 'stdio',
        serverName: BROWSER_SERVER_NAME,
        command: 'npx',
        args: playwrightArgs(config),
        ...(agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd }),
        toolCallTimeoutMs: config.playwright.toolCallTimeoutMs,
        // A browser that cannot start must not take the conversation with it:
        // unlike the harness's resident provider, this is an optional half, and
        // the caller reads the failure from the plugin's log instead.
        failOnStartupError: true,
        reconnect: { enabled: false },
      }),
    )
  } catch (error) {
    await scope.dispose()
    throw error
  }
  let closed = false
  return async () => {
    if (closed) return
    closed = true
    await scope.dispose()
  }
}

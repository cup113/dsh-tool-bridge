/**
 * Plugin configuration.
 *
 * These fields are the ones that used to be boot flags of the retired server —
 * `--cwd`, `--dart-format` — plus the two per-conversation defaults and the
 * browser row's flags. They moved into the profile because a plugin has no
 * command line: the profile's patch layer is where a machine-specific value
 * belongs, and `cordis.patch.yml` documents the override shape.
 */

import z from '@deepseek-ai/schemastery'

/** Playwright MCP's launch flags, as the profile row used to carry them. */
export const PlaywrightConfig = z.object({
  /**
   * Browser channel. `msedge` drives the Edge Windows already ships, so no
   * `playwright install` download and no browser cache (measured: the channel
   * launches with no download).
   */
  browser: z.string().default('msedge'),
  /**
   * Capabilities to enable. `vision` adds the coordinate mouse tools — the only
   * pointer a canvas-rendered page can be driven with — and `devtools` adds the
   * video/trace recorders. Measured: 44 tools with both, ~25 for core alone.
   */
  caps: z.string().default('vision,devtools'),
  /**
   * Where video, trace and PDF files are written. Deliberately outside any
   * session workspace: an artifact for the human is copied in on purpose, and
   * the copy is the model's step (README, "The browser half").
   */
  outputDir: z.string().default(''),
  /**
   * A screenshot or a stopped video can take longer than the 60 s MCP default.
   */
  toolCallTimeoutMs: z.number().min(1).default(120_000),
  /** Extra arguments appended after the flags above, for an unusual setup. */
  args: z.array(z.string()).default([]),
})

export const Config = z.object({
  /**
   * Where the plugin keeps its own state (the per-session toggle record). Empty
   * means `$DSH_HOME/toolbridge`, or `~/.dsh/toolbridge` without that variable.
   * The plugin process is not confined, so this is an ordinary directory.
   */
  stateDir: z.string().default(''),
  /** Whether a new conversation starts with each half on. */
  defaults: z
    .object({
      /**
       * The toolchain half. On by default: it is the reason the plugin exists,
       * and its two tool schemas are cheap next to a browser catalog.
       */
      bridge: z.boolean().default(true),
      /**
       * The browser half. Off by default, because turning it on is what makes a
       * session pay for Playwright MCP's tool catalog and spawn a server.
       */
      browser: z.boolean().default(false),
    })
    .default({}),
  /**
   * The formatter pin: a standalone `dart.exe` whose version matches the one a
   * project's CI formats with. `dart format` output changes between releases, so
   * formatting with a newer local SDK is what turns CI's
   * `dart format --set-exit-if-changed` check red. Only `dart format` routes to
   * the pin; every other `dart`/`flutter` command keeps the PATH SDK, because
   * `dart analyze` also depends on the Flutter framework version resolved
   * through the package config, which a formatter pin cannot align.
   */
  dartFormatExe: z.string().default(''),
  /** The browser half's MCP server. */
  playwright: PlaywrightConfig.default({}),
  /**
   * How long a foreground `bridge_run` may wait before returning the job as it
   * stands, in seconds. The job is never killed by this: the caller reads it on
   * with `job_output`.
   */
  defaultTimeoutSec: z.number().min(1).default(600),
})

/**
 * The resolved configuration, written out rather than inferred.
 *
 * Schemastery's schema type is an author-facing description whose defaults the
 * runtime resolves; spelling the resolved shape here is what lets the rest of
 * the plugin read `config.playwright.browser` as a `string` instead of a
 * `string | undefined` that is never actually absent.
 */
export interface ToolBridgeConfig {
  stateDir: string
  defaults: { bridge: boolean; browser: boolean }
  dartFormatExe: string
  playwright: {
    browser: string
    caps: string
    outputDir: string
    toolCallTimeoutMs: number
    args: string[]
  }
  defaultTimeoutSec: number
}

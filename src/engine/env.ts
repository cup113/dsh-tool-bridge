/**
 * The environment every tool this plugin starts is given.
 *
 * A job's output is read by a model and rendered as text in a panel, and neither
 * can use a terminal escape sequence or answer a pager. On Windows a reporter
 * colours a *pipe* happily — `tinyrainbow` counts `platform === 'win32'` as
 * colour support — so the bytes would arrive coloured whether or not anything is
 * watching. Measured: a real vitest job log carried 240 escape bytes in 2 309,
 * and because every vitest pattern in `digest.ts` anchors on `^`, the digest for
 * that run was `null` — a green suite reported as nothing.
 *
 * The harness's own `pwsh` tool applies these same three overrides to its
 * children for exactly this reason ("model-friendly environment overrides"), and
 * this plugin is the harness's other producer of tool output.
 *
 * This is the convention; `engine/ansi.ts` is the guarantee. A tool that ignores
 * `NO_COLOR`, forces colour with its own flag, or writes an escape sequence from
 * inside a program is still handled there, at every read.
 */

/** Environment overrides applied to every tool this plugin spawns. */
export const TOOL_ENV_OVERRIDES: NodeJS.ProcessEnv = {
  NO_COLOR: '1',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
}

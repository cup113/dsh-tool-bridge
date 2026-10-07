/**
 * Shapes the browser half shares with the host.
 *
 * These are `import type` only: the client bundle is loaded by the shell's
 * frozen module table, so a value import from outside that table fails at load.
 * Duplicating two boolean flags as a type is the cheap side of that constraint.
 */

/** Which halves of the plugin a conversation has on. */
export interface ToggleState {
  bridge: boolean
  browser: boolean
}

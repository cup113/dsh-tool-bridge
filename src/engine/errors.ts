/**
 * How the engine says no, and how it says it broke.
 *
 * The retired server answered over HTTP, where "you sent nonsense" and "the
 * guardrail refuses this" were `ValueError` mapped to 400 and 403 at the route.
 * A tool call has no status line, so the distinction is carried as a code on the
 * error: a refusal is an *argued answer* the model should read and act on, while
 * a failure is the environment breaking. Both surface as a tool error; only the
 * code lets the caller tell "rephrase the request" from "the toolchain is not
 * installed".
 */

/** The two refusal codes the retired HTTP layer used, kept for parity. */
export type RefusalCode =
  /** The request itself is malformed or unsupported: fix the request. */
  | 400
  /** The guardrail refuses this command: pick another one (ADR-0001). */
  | 403

/**
 * A deliberate refusal. The message is model-facing and is expected to name what
 * is allowed instead, because a refusal that does not say what to do next is
 * just a wall.
 */
export class RefusalError extends Error {
  readonly code: RefusalCode

  constructor(code: RefusalCode, message: string) {
    super(message)
    this.name = 'RefusalError'
    this.code = code
  }
}

/** Refuse with a code, in one expression. */
export function refuse(code: RefusalCode, message: string): never {
  throw new RefusalError(code, message)
}

/**
 * The environment broke: a required executable is missing, a pinned SDK is not
 * where it was pinned, a project's own binary is not installed.
 *
 * Distinct from {@link RefusalError} on purpose: nothing about the *request* is
 * wrong, so retrying the same call after fixing the environment is correct.
 */
export class ToolFailure extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ToolFailure'
  }
}

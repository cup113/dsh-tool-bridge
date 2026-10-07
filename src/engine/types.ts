/**
 * Shared vocabulary for the engine and the tools that expose it.
 *
 * These are the shapes the OLD server put on the wire; they survive the port
 * unchanged because they are what the model and the sidebar read, and because
 * `docs/adr/` plus `CONTEXT.md` describe them by name. Where a field's absence
 * is meaningful (`known`, `counts`, `flavor`), the type says so instead of
 * encoding a sentinel.
 */

/** One channel of a two-lane serialization domain. */
export type Lane = 'queue' | 'long'

/** The terminal or in-flight state of a job, as the tools report it. */
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'killed'

/** Why a failure is not the caller's: the registry entry that claimed it. */
export interface KnownMatch {
  kind: string
  reason: string | null
}

/** One failing (or unfinished) test, exactly as the progress lines report it. */
export interface ReportedFailure {
  file: string | null
  name: string
  /** The reporter said this test never finished (a load or compile failure). */
  didNotComplete: boolean
}

/**
 * A reported failure plus the registry's verdict, when one applied.
 *
 * `known` is the per-failure half of the digest's answer: its presence means
 * "this was already red before your change", and its absence means the failure
 * is new — which is also why it is never spelled `false`.
 */
export interface TestFailure extends ReportedFailure {
  known?: KnownMatch
}

/** The counts on the last `+passed ~skipped -failed:` progress line. */
export interface TestCounts {
  passed: number
  skipped: number
  failed: number
}

/**
 * The result of reading a test log.
 *
 * `flavor` names the runner the digest came from (`flutter` for
 * `flutter test`/`dart test`, `vitest` for a vitest run) and is null for
 * everything else — it is what decides whether the known-failure registry
 * applies, since a *passing* run also has a digest.
 */
export interface TestLogDigest {
  flavor: string | null
  summary: string | null
  counts: TestCounts | null
  failures: TestFailure[]
}

/** One registry entry, normalised and ready to match. */
export interface KnownEntry {
  file: string | null
  name: string | null
  pattern: RegExp | null
  kind: string
  platform: string | null
  reason: string | null
}

/** A loaded registry: where it lives, what it holds, why it may be empty. */
export interface Registry {
  path: string
  exists: boolean
  entries: KnownEntry[]
  error: string | null
}

/**
 * The digest's answer to "is this failure mine?".
 *
 * `known`/`new` count **distinct tests**, which is the unit `failed` states;
 * `events` is how many `[E]` lines carried them, and `unparsed` is the part of
 * `failed` the inventory never named. `known + new + unparsed === failed`
 * whenever the inventory is reconcilable with the authoritative count, which is
 * exactly when `summary` may carry the split.
 */
export interface BaselineReport {
  source: string
  known: number
  new: number
  failed: number | null
  tests: number
  events: number
  unparsed: number
  newFailures: TestFailure[]
  error: string | null
}

/** The `_known` shapes a baseline report is built from, before the split. */
export interface RegistryCounts {
  known: number
  new: number
  failed: number | null
  tests: number
  events: number
  unparsed: number
  newFailures: TestFailure[]
}

/* ------------------------------------------------------------------ ARB edit */

/** A map of ARB file name → translated string, for one new key. */
export type ArbValueMap = Record<string, string>

/** One key to insert, with the values to write into each named ARB file. */
export interface ArbNewField {
  key: string
  value: ArbValueMap
}

/** One edit group: an inclusive delete range and/or an insert anchor + fields. */
export interface ArbGroup {
  insertAfter?: string
  deleteFrom?: string
  deleteTo?: string
  newFields?: ArbNewField[]
}

/** A validated arb-edit instruction. */
export interface ArbInstruction {
  groups: ArbGroup[]
  dryRun: boolean
}

/** One ARB file's planned new content plus a human-readable change list. */
export interface FilePlan {
  name: string
  path: string
  /** The planned file content, as bytes: line endings are preserved exactly. */
  newBytes: Uint8Array
  inserts: string[]
  deletes: string[]
}

/** An ARB file named in a value map but absent from the arb-dir. */
export interface SkippedFile {
  file: string
  reason: string
}

/**
 * The output of the plan phase: everything needed to apply, and nothing applied
 * yet. `untranslatedFile` comes from `l10n.yaml` and is read only after
 * `flutter gen-l10n` has run.
 */
export interface ArbPlan {
  files: FilePlan[]
  skipped: SkippedFile[]
  untranslatedFile: string | null
}

/** One file's applied change set, as the tool result reports it. */
export interface ArbChange {
  file: string
  inserts: string[]
  deletes: string[]
}

/** The untranslated-messages file, when it exists with real content. */
export interface ArbUntranslated {
  file: string
  lines: number
  content: string
}

/** The structured outcome of an arb-edit job. */
export interface ArbResult {
  dryRun: boolean
  edited: string[]
  skipped: SkippedFile[]
  changes: ArbChange[]
  genL10n: { exitCode: number } | null
  untranslated: ArbUntranslated | null
}

/* ------------------------------------------------------------------ requests */

/** How an `uncommitted` scope reaches a command. */
export type ScopeMode = 'expand' | 'filter'

/** The runner a digest came from, as the flavor vocabulary spells it. */
export type Flavor = 'flutter' | 'vitest'

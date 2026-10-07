/**
 * The known-failure registry: reading a project's written-down pre-existing
 * failures, matching a run against them, and splitting that run into known and
 * new.
 *
 * The feature exists because "is this failure mine?" is a question a fresh
 * session cannot answer from memory, and guessing it is worse than not
 * answering: a failure wrongly called *new* costs an investigation, while a
 * failure wrongly called *known* buries the regression the change just
 * introduced. That asymmetry decides every rule in this module — a registry
 * that cannot be read claims nothing, an entry that does not validate is an
 * error rather than a pattern that matches nothing, and the split only reaches
 * the one-line summary when its numbers reconcile with the count that summary
 * already states.
 *
 * Python spelled these `current_platform`, `parse_known_failures`, …; the port
 * keeps `src/engine`'s camelCase.
 */

import { readFileSync, statSync } from 'node:fs'

import { refuse } from './errors'
import {
  KNOWN_FAILURES_MAX_BYTES,
  KNOWN_FAILURES_RELPATH,
  KNOWN_KINDS,
  KNOWN_PLATFORMS,
  knownFailuresPath,
} from './surface'
import type {
  BaselineReport,
  KnownEntry,
  Registry,
  TestCounts,
  TestFailure,
} from './types'

/**
 * `os.name == "nt"`, read once: the platform is a property of the process, not
 * of a request, so it cannot change between two calls.
 */
const IS_WINDOWS = process.platform === 'win32'

/** `windows` or `posix` — the only platform distinction the bridge knows. */
export function currentPlatform(): 'windows' | 'posix' {
  return IS_WINDOWS ? 'windows' : 'posix'
}

/** A caught value's message, spelled the way Python's `str(error)` spells it. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The allowed values of an enumerated field, in Python's `sorted(...)` repr
 * (`['defect', 'environment', …]`).
 *
 * These strings are model-facing and asserted verbatim, so their spelling is
 * part of the contract, not a formatting detail.
 */
function sortedRepr(values: Iterable<string>): string {
  return `[${[...values].sort().map((value) => `'${value}'`).join(', ')}]`
}

/** Whether a parsed JSON value is an object — Python's `isinstance(x, dict)`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validates a registry document. Throws a 400 refusal naming the entry.
 *
 * Every entry needs exactly one of `name` (the test name, exact) or `match` (a
 * regex searched in it), and may narrow further with `file`, `platform`,
 * `kind` and `reason`. Validation is strict on purpose: a typo that silently
 * matched nothing would make a known failure look new — which is the one
 * direction this feature must never fail in.
 *
 * A `ValueError` in the retired server meant "the request is malformed", which
 * its HTTP layer answered 400; there is no request here, so the same refusal is
 * carried on the error code.
 */
export function parseKnownFailures(raw: unknown): KnownEntry[] {
  if (!isRecord(raw)) {
    refuse(400, 'registry must be a JSON object')
  }
  const entries = raw['entries']
  if (!Array.isArray(entries)) {
    refuse(400, "registry needs an 'entries' list")
  }
  const items: readonly unknown[] = entries
  const parsed: KnownEntry[] = []
  for (let index = 0; index < items.length; index += 1) {
    const where = `entries[${index}]`
    const entry = items[index]
    if (!isRecord(entry)) {
      refuse(400, `${where} must be an object`)
    }
    // `??` and not a defaulted `get`: Python's `entry.get("name")` is None both
    // when the key is absent and when it is JSON null, while `get("kind", …)`
    // below defaults only on absence.
    const name = entry['name'] ?? null
    const source = entry['match'] ?? null
    if ((name === null) === (source === null)) {
      refuse(400, `${where} needs exactly one of 'name' or 'match'`)
    }
    if (name !== null && typeof name !== 'string') {
      refuse(400, `${where}.name must be a string`)
    }
    let pattern: RegExp | null = null
    if (source !== null) {
      if (typeof source !== 'string') {
        refuse(400, `${where}.match must be a string`)
      }
      try {
        pattern = new RegExp(source)
      } catch (error) {
        refuse(400, `${where}.match is not a valid regex: ${errorText(error)}`)
      }
    }
    const fileName = entry['file'] ?? null
    if (fileName !== null && typeof fileName !== 'string') {
      refuse(400, `${where}.file must be a string`)
    }
    const kind = entry['kind'] === undefined ? 'unclassified' : entry['kind']
    if (typeof kind !== 'string' || !KNOWN_KINDS.has(kind)) {
      refuse(400, `${where}.kind must be one of ${sortedRepr(KNOWN_KINDS)}`)
    }
    const platform = entry['platform'] ?? null
    if (platform !== null && !(typeof platform === 'string' && KNOWN_PLATFORMS.has(platform))) {
      refuse(400, `${where}.platform must be one of ${sortedRepr(KNOWN_PLATFORMS)}`)
    }
    const reason = entry['reason'] ?? null
    if (reason !== null && typeof reason !== 'string') {
      refuse(400, `${where}.reason must be a string`)
    }
    parsed.push({ file: fileName, name, pattern, kind, platform, reason })
  }
  return parsed
}

/**
 * Reads `<cwd>/.toolbridge/known-failures.json`. Never throws.
 *
 * A registry that cannot be read comes back with `entries == []` and an
 * `error`, and the digest repeats that verbatim. The reason is the failure mode
 * this whole feature is about: "everything is new" and "everything is known"
 * must never look alike, so a broken file has to announce itself instead of
 * quietly claiming nothing.
 *
 * A file that is simply absent is not broken: that is the feature being off,
 * which `exists: false` (and a null report) says.
 */
export function loadKnownFailures(cwd: string): Registry {
  const path = knownFailuresPath(cwd)
  const registry: Registry = {
    path: KNOWN_FAILURES_RELPATH,
    exists: false,
    entries: [],
    error: null,
  }
  try {
    if (!statSync(path).isFile()) return registry
  } catch {
    // Missing, or a parent this process cannot traverse: no registry at all,
    // which is not the same answer as a registry that failed to load.
    return registry
  }
  registry.exists = true
  try {
    // The cap is checked before the read, on the file's own byte size: the
    // limit exists so a runaway generated file cannot be slurped into a job's
    // digest, which is exactly the file that is too big to parse.
    if (statSync(path).size > KNOWN_FAILURES_MAX_BYTES) {
      refuse(400, `registry is larger than ${KNOWN_FAILURES_MAX_BYTES} bytes`)
    }
    // `errors="replace"` in Python; `toString('utf8')` substitutes U+FFFD for
    // the same bytes, so a mis-encoded registry is a parse error, not a throw.
    const text = readFileSync(path).toString('utf8')
    const document: unknown = JSON.parse(text)
    registry.entries = parseKnownFailures(document)
  } catch (error) {
    registry.error = errorText(error)
  }
  return registry
}

/**
 * Whether a failure's reported path is the registry's relative path.
 *
 * The reporter prints an absolute path, and on Windows often one with mixed
 * separators (that mixedness is itself a whole family of Windows-only
 * failures), so this is a segment-boundary suffix test over normalised slashes
 * — case-insensitive on Windows, because that is what the filesystem is.
 */
export function pathMatches(actual: string | null, expected: string): boolean {
  if (!actual) return false
  let reported = actual.replaceAll('\\', '/')
  let wanted = expected.replaceAll('\\', '/').replace(/^\/+/u, '')
  if (IS_WINDOWS) {
    reported = reported.toLowerCase()
    wanted = wanted.toLowerCase()
  }
  return reported === wanted || reported.endsWith('/' + wanted)
}

/**
 * The first entry that claims this failure, or null. Entries are ordered.
 *
 * A `file`-scoped entry never claims a failure the reporter printed without a
 * path (a single-file run): the alternative would be attributing an unknown
 * failure to whichever suite happened to be named in the registry — the one
 * direction this feature must not fail in.
 */
export function knownEntryFor(
  entries: readonly KnownEntry[],
  failure: TestFailure,
): KnownEntry | null {
  const name = failure.name || ''
  const platform = currentPlatform()
  for (const entry of entries) {
    if (entry.platform !== null && entry.platform !== platform) continue
    if (entry.file !== null && !pathMatches(failure.file, entry.file)) continue
    if (entry.name !== null) {
      if (name === entry.name) return entry
      continue
    }
    if (entry.pattern !== null && entry.pattern.test(name)) return entry
  }
  return null
}

/**
 * Splits a run's failures into known and new. Null when there is no registry.
 *
 * `failures` is annotated **in place** with `known`, because one entry has to
 * be readable on its own. The list that says *which* failures are new is
 * `newFailures`; `summary` only carries the counts. A caller that has to act on
 * a regression must read the list — the one-liner is a glance, not the answer.
 *
 * The split counts **distinct tests** (`file` + `name`), not `[E]` events: a
 * test that fails in its body *and* in its tearDown prints two progress lines,
 * while the authoritative `counts.failed` counts it once. Counting events would
 * make the split disagree with the very number the summary leads with —
 * observed on a real 6105-test run, where 79 `[E]` lines covered 77 failing
 * tests. Every event is still annotated; only the tally deduplicates.
 *
 * A registry carrying an `error` claims nothing at all: its entries are
 * discarded rather than matched, so an unreadable file cannot annotate a
 * failure as known.
 */
export function baselineReport(
  failures: readonly TestFailure[],
  counts: TestCounts | null,
  registry: Registry,
): BaselineReport | null {
  if (!registry.exists) return null
  const report: BaselineReport = {
    source: registry.path,
    known: 0,
    new: 0,
    failed: counts === null ? null : counts.failed,
    tests: 0,
    events: failures.length,
    unparsed: 0,
    newFailures: [],
    error: registry.error,
  }
  const entries = registry.error === null ? registry.entries : []
  const newFailures: TestFailure[] = []
  const counted = new Set<string>()
  let known = 0
  for (const failure of failures) {
    const entry = knownEntryFor(entries, failure)
    if (entry !== null) {
      failure.known = { kind: entry.kind, reason: entry.reason }
    }
    // The identity of a *test* across its events: Python's `(file, name or "")`
    // tuple, serialised so that a null file and the string "null" stay apart.
    const key = JSON.stringify([failure.file, failure.name || ''])
    if (counted.has(key)) continue // the same test's second event: annotated, not re-counted
    counted.add(key)
    if (entry === null) {
      newFailures.push(failure)
      continue
    }
    known += 1
  }
  report.known = known
  report.new = newFailures.length
  report.tests = counted.size
  report.newFailures = newFailures
  if (counts !== null) {
    // `counts.failed` is authoritative while the inventory can be shorter (a
    // reporter whose failure lines this parser does not recognise), so the gap
    // is named instead of letting the split look complete.
    report.unparsed = Math.max(0, counts.failed - counted.size)
  }
  return report
}

/**
 * `83 passed, 4 failed` + ` (3 known, 1 new)` when a registry applies.
 *
 * Only a summary that reports failures is annotated: "see log" means the run
 * was killed or the reporter was unrecognised, and its whole point is to not
 * claim a count. And the suffix is withheld when the split cannot be reconciled
 * with the count the summary already states (an inventory naming more tests
 * than `counts.failed`) — a one-liner that contradicts itself in the same
 * breath is worse than no hint at all.
 *
 * A report carrying an `error` never annotates either: the split would read as
 * authoritative while the registry that produced it never loaded.
 */
export function summarizeWithBaseline(
  summary: string | null,
  report: BaselineReport | null,
): string | null {
  if (summary === null || report === null || report.error !== null) return summary
  if (!summary.includes('failed')) return summary
  const failed = report.failed
  if (failed === null || report.tests > failed) return summary
  const { known, unparsed } = report
  const fresh = report.new
  if (known + fresh + unparsed === 0) return summary
  const parts = [`${known} known`, `${fresh} new`]
  if (unparsed) parts.push(`${unparsed} unparsed`)
  return `${summary} (${parts.join(', ')})`
}

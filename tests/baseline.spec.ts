/**
 * The known-failure registry, ported from `tests/test_toolhub.py`
 * (`KnownFailureRegistryTests`, plus the vitest-registry case from
 * `VitestLogTests`).
 *
 * The registry answers "is this failure mine?" for a project that has already
 * written its pre-existing failures down (platform-specific, flaky, ...). The
 * two directions must stay distinguishable: a matched failure is annotated and
 * lands in the split's `known` count, an unmatched one is *named* in
 * `newFailures`, and a registry that cannot be read claims neither.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  baselineReport,
  currentPlatform,
  knownEntryFor,
  loadKnownFailures,
  parseKnownFailures,
  summarizeWithBaseline,
} from '../src/engine/baseline'
import { KNOWN_FAILURES_MAX_BYTES, KNOWN_FAILURES_RELPATH } from '../src/engine/surface'
import type {
  BaselineReport,
  Registry,
  TestCounts,
  TestFailure,
  TestLogDigest,
} from '../src/engine/types'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The registry scratch cwd: a job reads `<cwd>/.toolbridge/known-failures.json`. */
const SCRATCH = join(HERE, '.tmp-baseline')

/**
 * The digest the retired server's `analyze_test_log` produces for
 * `tests/fixtures/expanded_failed.txt`: six `[E]` lines, `83 passed, 6 failed`.
 *
 * Frozen as data on purpose. The log parsers are a separate slice of the port,
 * and this spec is about what the registry does with a digest, not about
 * re-deriving one; the fixture (`tests/fixtures/**`, never edited) is what the
 * literal was read from, so the two cannot drift apart silently.
 */
function expandedFailedDigest(): TestLogDigest {
  return {
    flavor: 'flutter',
    summary: '83 passed, 6 failed',
    counts: { passed: 83, skipped: 0, failed: 6 },
    failures: [
      {
        file: 'C:/ws/test/desktop/alpha_test.dart',
        name: 'alpha refuses a bad key',
        didNotComplete: false,
      },
      {
        file: 'C:/ws/test/desktop/bravo_test.dart',
        name: 'bravo retries once',
        didNotComplete: false,
      },
      {
        file: 'C:/ws/features/feed/gamma_test.dart',
        name: 'gamma restores state',
        didNotComplete: false,
      },
      {
        file: 'C:/ws/features/feed/delta_test.dart',
        name: 'delta dedupes',
        didNotComplete: false,
      },
      {
        file: 'C:/ws/features/feed/epsilon_test.dart',
        name: 'epsilon syncs',
        didNotComplete: true,
      },
      {
        file: 'C:/ws/features/feed/zeta_test.dart',
        name: 'zeta handles empty',
        didNotComplete: false,
      },
    ],
  }
}

/** The same, for `tests/fixtures/expanded_passed.txt`: no failures at all. */
function expandedPassedDigest(): TestLogDigest {
  return {
    flavor: 'flutter',
    summary: '33 passed, 2 skipped',
    counts: { passed: 33, skipped: 2, failed: 0 },
    failures: [],
  }
}

/** And for `tests/fixtures/vitest_two_files_failed.txt`. */
function vitestFailedDigest(): TestLogDigest {
  return {
    flavor: 'vitest',
    summary: '3 passed, 1 failed',
    counts: { passed: 3, skipped: 0, failed: 1 },
    failures: [
      { file: 'src/App.test.ts', name: 'add > fails on purpose', didNotComplete: false },
    ],
  }
}

/** Writes the registry, raw when a string (for malformed-document tests). */
function writeRegistry(document: string | object): void {
  const target = join(SCRATCH, '.toolbridge')
  mkdirSync(target, { recursive: true })
  const text = typeof document === 'string' ? document : JSON.stringify(document)
  writeFileSync(join(target, 'known-failures.json'), text, 'utf8')
}

/** A report the caller knows must exist, or a loud failure if it does not. */
function mustReport(report: BaselineReport | null): BaselineReport {
  if (report === null) throw new Error('a registry was written but produced no report')
  return report
}

interface Split {
  digest: TestLogDigest
  registry: Registry
  report: BaselineReport
  summary: string | null
}

/** The whole pipeline: log → digest → registry → annotated split. */
function split(
  registryDocument: string | object,
  digest: TestLogDigest = expandedFailedDigest(),
): Split {
  writeRegistry(registryDocument)
  const registry = loadKnownFailures(SCRATCH)
  const report = mustReport(baselineReport(digest.failures, digest.counts, registry))
  return { digest, registry, report, summary: summarizeWithBaseline(digest.summary, report) }
}

describe('known-failure registry', () => {
  beforeEach(() => {
    rmSync(SCRATCH, { recursive: true, force: true })
    mkdirSync(SCRATCH, { recursive: true })
  })

  afterEach(() => {
    rmSync(SCRATCH, { recursive: true, force: true })
  })

  it('without a registry nothing changes', () => {
    const digest = expandedFailedDigest()
    const registry = loadKnownFailures(SCRATCH)
    expect(registry.exists).toBe(false)
    expect(baselineReport(digest.failures, digest.counts, registry)).toBeNull()
    expect(summarizeWithBaseline(digest.summary, null)).toBe('83 passed, 6 failed')
  })

  it('entries claim failures by name and by regex', () => {
    const { digest, report, summary } = split({
      entries: [
        {
          name: 'alpha refuses a bad key',
          kind: 'platform',
          platform: currentPlatform(),
          reason: 'Windows-only: path separator',
        },
        { match: '^(bravo|delta) ', kind: 'flaky', reason: 'timing' },
      ],
    })
    expect(report.known).toBe(3)
    expect(report.new).toBe(3)
    expect(report.newFailures.map((entry) => entry.name)).toEqual([
      'gamma restores state',
      'epsilon syncs',
      'zeta handles empty',
    ])
    expect(digest.failures[0]?.known).toEqual({
      kind: 'platform',
      reason: 'Windows-only: path separator',
    })
    expect(digest.failures[2]).not.toHaveProperty('known')
    expect(summary).toBe('83 passed, 6 failed (3 known, 3 new)')
  })

  it('platform gating skips the other os', () => {
    // A Windows-only entry must not silence a failure on CI's Linux.
    const other = currentPlatform() === 'windows' ? 'posix' : 'windows'
    const elsewhere = split({
      entries: [{ name: 'alpha refuses a bad key', platform: other }],
    })
    expect(elsewhere.report.known).toBe(0)
    expect(elsewhere.report.newFailures[0]?.name).toBe('alpha refuses a bad key')
    const here = split({
      entries: [
        { name: 'alpha refuses a bad key', platform: currentPlatform(), kind: 'platform' },
      ],
    })
    expect(here.report.known).toBe(1)
  })

  it('file narrows an entry to one suite', () => {
    const right = split({
      entries: [{ file: 'test/desktop/alpha_test.dart', name: 'alpha refuses a bad key' }],
    })
    expect(right.report.known).toBe(1)
    const wrong = split({
      entries: [{ file: 'test/other/alpha_test.dart', name: 'alpha refuses a bad key' }],
    })
    expect(wrong.report.known).toBe(0)
  })

  it('a windows-style reported path still matches', () => {
    // The reporter's absolute, mixed-separator path is normalised, not typed.
    const entries = parseKnownFailures({
      entries: [{ file: 'test/desktop/alpha_test.dart', name: 'alpha x' }],
    })
    const failure: TestFailure = {
      file: 'C:\\WS\\test\\desktop\\alpha_test.dart',
      name: 'alpha x',
      didNotComplete: false,
    }
    expect(knownEntryFor(entries, failure)).not.toBeNull()
    failure.file = 'C:\\WS\\test\\other\\alpha_test.dart'
    expect(knownEntryFor(entries, failure)).toBeNull()
  })

  it('the first matching entry wins', () => {
    const { report } = split({
      entries: [
        { match: 'alpha', kind: 'flaky', reason: 'first' },
        { match: 'alpha', kind: 'platform', reason: 'second' },
      ],
    })
    expect(report.known).toBe(1)
    expect(report.newFailures[0]?.name).toBe('bravo retries once')
  })

  it('a shorter inventory is reported as unparsed', () => {
    // `counts.failed` is authoritative; the split must not look complete.
    writeRegistry({ entries: [{ name: 'alpha refuses a bad key' }] })
    const digest = expandedFailedDigest()
    const registry = loadKnownFailures(SCRATCH)
    const report = mustReport(
      baselineReport(digest.failures.slice(0, 4), digest.counts, registry),
    )
    expect(report.unparsed).toBe(2)
    expect(summarizeWithBaseline(digest.summary, report)).toBe(
      '83 passed, 6 failed (1 known, 3 new, 2 unparsed)',
    )
  })

  it('a broken registry claims nothing and says so', () => {
    writeRegistry('{ not json')
    const digest = expandedFailedDigest()
    const registry = loadKnownFailures(SCRATCH)
    expect(registry.exists).toBe(true)
    expect(registry.error).not.toBeNull()
    const report = mustReport(baselineReport(digest.failures, digest.counts, registry))
    expect(report.known).toBe(0)
    expect(report.new).toBe(6)
    expect(report.error).toBe(registry.error)
    expect(digest.failures[0]).not.toHaveProperty('known')
    // No split is claimed in the summary either: the one-liner must not read as
    // "all known" when the registry never loaded.
    expect(summarizeWithBaseline(digest.summary, report)).toBe('83 passed, 6 failed')
  })

  it('schema errors name the entry', () => {
    const cases: readonly (readonly [string | object, string])[] = [
      ['[]', 'must be a JSON object'],
      [{ entries: {} }, "needs an 'entries' list"],
      [{ entries: [7] }, 'entries[0] must be an object'],
      [{ entries: [{}] }, "needs exactly one of 'name' or 'match'"],
      [{ entries: [{ name: 'x', match: 'y' }] }, 'exactly one'],
      [{ entries: [{ name: 'x', kind: 'mystery' }] }, 'kind must be one of'],
      [{ entries: [{ name: 'x', platform: 'linux' }] }, 'platform must be'],
      [{ entries: [{ match: '([', kind: 'flaky' }] }, 'not a valid regex'],
      [{ entries: [{ name: 'x', reason: 5 }] }, 'reason must be a string'],
      [{ entries: [{ name: 5 }] }, 'name must be a string'],
    ]
    for (const [document, expected] of cases) {
      writeRegistry(document)
      const registry = loadKnownFailures(SCRATCH)
      expect(registry.error ?? '', `document: ${JSON.stringify(document)}`).toContain(expected)
    }
  })

  it('a registry larger than the cap is an error, not a parse', () => {
    // No Python counterpart: the cap is only reachable with a file this size.
    // The padded document is valid JSON, so the cap is the only thing that can
    // produce this answer.
    writeRegistry(`{"entries": []}${' '.repeat(KNOWN_FAILURES_MAX_BYTES)}`)
    const registry = loadKnownFailures(SCRATCH)
    expect(registry.exists).toBe(true)
    expect(registry.error).toBe(
      `registry is larger than ${KNOWN_FAILURES_MAX_BYTES} bytes`,
    )
    expect(registry.entries).toEqual([])
  })

  it('a passing run is never annotated', () => {
    const { report, summary } = split(
      { entries: [{ match: '.*' }] },
      expandedPassedDigest(),
    )
    expect(report.known).toBe(0)
    expect(summary).toBe('33 passed, 2 skipped')
  })

  it('a test that reports twice is counted once', () => {
    // A failure in the body *and* in tearDown prints two `[E]` lines. Observed
    // on a real run: 79 `[E]` lines covered 77 failing tests, which made a naive
    // split contradict the count the summary leads with.
    writeRegistry({ entries: [{ name: 'alpha refuses a bad key' }] })
    const digest = expandedFailedDigest()
    const alpha = digest.failures.find((event) => event.name === 'alpha refuses a bad key')
    if (alpha === undefined) throw new Error('the fixture digest lost its alpha event')
    const failures: TestFailure[] = [...digest.failures, { ...alpha }]
    const registry = loadKnownFailures(SCRATCH)
    const report = mustReport(baselineReport(failures, digest.counts, registry))
    expect(report.events).toBe(7)
    expect(report.tests).toBe(6)
    expect(report.failed).toBe(6)
    expect(report.known).toBe(1)
    expect(report.new).toBe(5)
    expect(report.unparsed).toBe(0)
    // Every event is annotated, the duplicate included: an event that lost its
    // `known` would read as new.
    for (const event of [failures[0], failures.at(-1)]) {
      expect(event?.known).toBeDefined()
    }
    expect(summarizeWithBaseline(digest.summary, report)).toBe(
      '83 passed, 6 failed (1 known, 5 new)',
    )
  })

  it('an unreconcilable inventory keeps the summary plain', () => {
    // More named tests than `counts.failed` states: claim no split at all.
    writeRegistry({ entries: [{ name: 'alpha refuses a bad key' }] })
    const digest = expandedFailedDigest()
    const registry = loadKnownFailures(SCRATCH)
    const counts: TestCounts = { passed: 83, skipped: 0, failed: 3 }
    const report = mustReport(baselineReport(digest.failures, counts, registry))
    expect(report.tests).toBe(6)
    expect(report.failed).toBe(3)
    expect(report.unparsed).toBe(0)
    expect(summarizeWithBaseline(digest.summary, report)).toBe('83 passed, 6 failed')
  })

  it('the registry split applies to a vitest run', () => {
    const digest = vitestFailedDigest()
    const registry: Registry = {
      path: KNOWN_FAILURES_RELPATH,
      exists: true,
      entries: parseKnownFailures({
        entries: [{ match: '^add > fails', kind: 'flaky', reason: 'races' }],
      }),
      error: null,
    }
    const report = mustReport(baselineReport(digest.failures, digest.counts, registry))
    expect(report.known).toBe(1)
    expect(report.new).toBe(0)
    expect(summarizeWithBaseline(digest.summary, report)).toBe(
      '3 passed, 1 failed (1 known, 0 new)',
    )
  })
})

/**
 * Reading a test log back: what the runner said, and how much of it is complete.
 *
 * Two reporters are read — `package:test` (behind `flutter test`/`dart test`)
 * and vitest. Both write a *log*, not a result, so every number here is
 * recovered from lines meant for a human: the last progress line is the
 * authoritative count, the `[E]`/`FAIL` lines are the failure inventory, and a
 * terminal marker is the only proof the suite actually finished. The three are
 * kept apart deliberately, so a killed run can keep its inventory while
 * claiming no counts at all.
 */

import { readFileSync } from 'node:fs'
import { stripAnsi } from './ansi'
import { isTestRun, isVitestRun, mightRunVitest, splitPathAndName } from './argv'
import type { TestCounts, TestFailure, TestLogDigest } from './types'

/* ------------------------------------------------------- package:test lines */

/** A `package:test` progress line: "00:25 +67 ~2 -4: <description>". */
const TEST_COUNTS_RE = /^\d\d:\d\d \+(\d+)(?: ~(\d+))?(?: -(\d+))?: /
/** A failing test's progress line, with the `[E]` marker the reporters append. */
const TEST_FAILURE_RE =
  /^\d\d:\d\d \+\d+(?: ~\d+)?(?: -\d+)?: (?<name>.+?)(?<unfinished> - did not complete)? \[E\]$/
const TEST_BLOCK_HEADER = 'Failing tests:'
const TEST_BLOCK_MORE_RE = /^\.\.\. and (\d+) more$/
const TEST_DID_NOT_COMPLETE = ' (did not complete)'
const TEST_TERMINAL_MARKERS: readonly string[] = [
  'All tests passed!',
  'All other tests passed!',
  'All tests skipped.',
  'Some tests failed.',
]

/* ------------------------------------------------------------ vitest lines */

/*
 * vitest 5's default reporter, as a job log gets it. The end-of-run summary is
 * both the authoritative count and the only proof the run finished — there is
 * no flutter-style "Some tests failed." marker:
 *
 *        Test Files  1 failed | 1 passed (2)
 *             Tests  1 failed | 3 passed (4)
 *
 * A run killed mid-suite prints neither, which is why `counts === null` stays
 * "see log". Anchoring on `Tests`/`Test Files` **followed by two spaces** is
 * also what keeps jest's `Tests: 1 failed, 2 passed, 3 total` out.
 *
 * "No TTY, so no colour" is *not* true here, which is why `readLogLines` strips
 * first: measured on Windows, a piped vitest run still emits the escapes, and a
 * `^`-anchored pattern never sees such a line at all.
 */
const VITEST_TESTS_LINE_RE = /^ *Tests {2,}(?<body>\S.*)$/
const VITEST_FILES_LINE_RE = /^ *Test Files {2,}(?<body>\S.*)$/
/** "1 failed | 3 passed | 1 skipped (4)". */
const VITEST_COUNT_RE = /(\d+) (failed|passed|skipped|todo)/g
const VITEST_TOTAL_RE = /\((\d+)\)\s*$/
/*
 * The separator bar is U+23AF repeated, and the `⎯⎯ Failed Tests 1 [1/1]⎯` form
 * carries a counter before its closing bar, so only the head is matched. The
 * character class is Python's `[^\w\s]`, spelled as Unicode letter/digit/
 * underscore because a JS `\w` alone would be ASCII-only where Python's is not.
 */
const VITEST_SECTION_RE =
  /^[^\p{L}\p{N}_\s]{2,} (?<name>Failed Tests|Failed Suites|Unhandled Errors) (?<count>\d+) /u
const VITEST_FAIL_RE = /^ *FAIL {2,}(?<rest>\S.*)$/
const VITEST_NO_TESTS = 'no tests'
/*
 * A suite that never loaded is reported the way the flutter digest reports a
 * compile failure — a failure whose name starts with "loading " — so one
 * registry rule can claim it on either runner.
 */
const VITEST_LOAD_PREFIX = 'loading '

/**
 * A log's lines, as Python's text-mode iteration yields them.
 *
 * The file is already UTF-8: the retired server forced that at the console
 * whatever the code page was, and the log arrives on disk in that encoding, so
 * it is read as `utf8` with no re-decoding step. `open(..., encoding="utf-8")`
 * is universal-newline mode, so CRLF and lone CR collapse to LF before the
 * per-line `rstrip("\n")` each parser does; splitting here keeps that shape
 * (and yields no trailing empty line for a file that ends with a newline, as
 * iteration does not).
 *
 * `undefined` is the unreadable-file arm — Python's `OSError` — which every
 * caller answers exactly as the Python does.
 *
 * Colour is stripped here, at the one point both reporters' lines come from:
 * the assumption below that a piped job log is colourless is false on Windows
 * (see `ansi.ts`), and every pattern in this file anchors on `^`, so a coloured
 * line did not merely look odd — it produced no counts at all.
 */
function readLogLines(logPath: string): string[] | undefined {
  let text: string
  try {
    text = stripAnsi(readFileSync(logPath, 'utf8'))
  } catch {
    return undefined
  }
  const lines = text.replace(/\r\n?/gu, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** No digest: not a test run, or a runner this bridge does not read. */
export function emptyDigest(): TestLogDigest {
  return { flavor: null, summary: null, counts: null, failures: [] }
}

/** One `path: name` line of the `Failing tests:` block. */
export function splitBlockEntry(text: string): TestFailure {
  const finished = !text.endsWith(TEST_DID_NOT_COMPLETE)
  const described = finished ? text : text.slice(0, -TEST_DID_NOT_COMPLETE.length)
  const { file, name } = splitPathAndName(described)
  return { file, name, didNotComplete: !finished }
}

/**
 * Lends block paths to path-less failures, then appends block orphans.
 *
 * Order and completeness stay the `[E]` lines' (run order, uncapped); the block
 * only ever supplies a missing file. An entry the block reports but the
 * progress lines missed is appended rather than dropped.
 */
export function attachPaths(failures: TestFailure[], block: TestFailure[]): TestFailure[] {
  const used = new Set<number>()
  for (const entry of failures) {
    for (const [index, candidate] of block.entries()) {
      if (used.has(index) || candidate.name !== entry.name) continue
      used.add(index)
      if (entry.file === null) entry.file = candidate.file
      entry.didNotComplete = Boolean(entry.didNotComplete || candidate.didNotComplete)
      break
    }
  }
  for (const [index, candidate] of block.entries()) {
    if (!used.has(index)) failures.push({ ...candidate })
  }
  return failures
}

/**
 * The one-line digest, kept deliberately close to the old wording.
 *
 * A missing terminal marker means the run was killed or truncated mid-suite;
 * "+N so far" would read as a finished suite, so that case stays opaque.
 */
export function summarizeTestRun(counts: TestCounts | null, terminal: boolean): string {
  if (counts === null) return terminal ? 'all tests passed' : 'see log'
  const { passed, failed, skipped } = counts
  if (failed) return `${passed} passed, ${failed} failed`
  if (!terminal) return 'see log'
  return `${passed} passed` + (skipped ? `, ${skipped} skipped` : '')
}

/**
 * Digest for a `flutter test` / `dart test` log.
 *
 * The authoritative count comes from the last `+passed ~skipped -failed:`
 * progress line. The failure inventory comes from the `[E]` progress lines
 * rather than from the `Failing tests:` block, because that block lists at most
 * four entries and then "... and N more" (test_core caps it and sorts by path,
 * so a failure can be evicted by alphabet) — and the `failures-only` reporter
 * never writes it at all. The block is still read, but only to lend a suite path
 * to an entry that has none.
 *
 * Returns `{ summary, counts, failures }` where summary is the one-line digest,
 * counts is `{ passed, skipped, failed }` from the last progress line, and
 * failures is `[{ file, name, didNotComplete }]` in run order.
 */
export function parseFlutterLog(logPath: string): TestLogDigest {
  const result = emptyDigest()
  result.flavor = 'flutter'
  const failures: TestFailure[] = []
  const block: TestFailure[] = []
  let counts: TestCounts | null = null
  let terminal = false
  let inBlock = false
  const lines = readLogLines(logPath)
  if (lines === undefined) return result
  for (const line of lines) {
    if (inBlock) {
      const stripped = line.trim()
      if (TEST_BLOCK_MORE_RE.test(stripped)) {
        inBlock = false
        continue
      }
      if (line.startsWith('  ') && stripped) {
        block.push(splitBlockEntry(stripped))
        continue
      }
      inBlock = false
    }
    if (line === TEST_BLOCK_HEADER) {
      inBlock = true
      continue
    }
    const failure = TEST_FAILURE_RE.exec(line)
    if (failure) {
      const { file, name } = splitPathAndName(failure.groups?.name ?? '')
      failures.push({
        file,
        name,
        didNotComplete: Boolean(failure.groups?.unfinished),
      })
      // No `continue`: the same line carries the running counts,
      // and on a killed run it may be the last one there is.
    }
    const progress = TEST_COUNTS_RE.exec(line)
    if (progress) {
      counts = {
        passed: Number(progress[1] ?? 0),
        skipped: Number(progress[2] ?? 0),
        failed: Number(progress[3] ?? 0),
      }
    }
    // Checked last and without `continue`: the terminal markers ride on the
    // very progress lines that carry the final counts.
    if (TEST_TERMINAL_MARKERS.some((marker) => line.includes(marker))) terminal = true
  }

  result.failures = attachPaths(failures, block)
  result.counts = counts
  result.summary = summarizeTestRun(counts, terminal)
  return result
}

/**
 * Whether a log carries the vitest reporter's own markers.
 *
 * Needed because `pnpm run test` says nothing about vitest in its argv, and the
 * known-failure split has to apply to exactly the runs that have a digest.
 */
export function looksLikeVitest(logPath: string): boolean {
  const lines = readLogLines(logPath)
  if (lines === undefined) return false
  for (const line of lines) {
    if (
      VITEST_TESTS_LINE_RE.test(line) ||
      VITEST_FILES_LINE_RE.test(line) ||
      VITEST_SECTION_RE.test(line)
    ) {
      return true
    }
  }
  return false
}

/**
 * `src/App.test.ts > add > fails on purpose` -> (path, `add > fails ...`).
 *
 * The default reporter names a failure as `<path> > <suite> > <name>`, so the
 * suite path is what precedes the *first* separator and the rest is the test's
 * full name — which is what a known-failure entry matches on.
 */
export function splitVitestFailure(rest: string): { file: string | null; name: string } {
  const separator = rest.indexOf(' > ')
  if (separator >= 0) {
    const tail = rest.slice(separator + 3)
    if (tail) return { file: rest.slice(0, separator).trim(), name: tail.trim() }
  }
  return { file: null, name: rest }
}

/**
 * The body of a `Tests  ...` summary line as counts.
 *
 * `skipped` is preferred from the trailing total rather than from the
 * `skipped` token alone, so a `todo` test lands in the same "not run" bucket
 * instead of disappearing from the numbers.
 */
export function parseVitestCounts(body: string): TestCounts {
  if (body.includes(VITEST_NO_TESTS)) return { passed: 0, skipped: 0, failed: 0 }
  const counts: TestCounts = { passed: 0, skipped: 0, failed: 0 }
  for (const match of body.matchAll(VITEST_COUNT_RE)) {
    const number = Number(match[1] ?? 0)
    const kind = match[2]
    if (kind === 'failed') counts.failed += number
    else if (kind === 'passed') counts.passed += number
    else counts.skipped += number
  }
  const total = VITEST_TOTAL_RE.exec(body)
  if (total !== null) {
    const unaccounted = Number(total[1] ?? 0) - counts.passed - counts.failed
    if (unaccounted >= 0) counts.skipped = unaccounted
  }
  return counts
}

/**
 * Digest for a vitest run.
 *
 * Counts come from the `Tests` summary line, with the failing **suites** of the
 * `Failed Suites` section folded into `failed`: a file that cannot be imported
 * runs no tests at all, so its summary line reads `Tests  no tests` while the
 * run is red — a digest reporting "0 passed" there would be worse than none.
 * The inventory is the `FAIL` lines, complete and in run order; unlike
 * `flutter test`'s `Failing tests:` block, the reporter caps nothing.
 */
export function parseVitestLog(logPath: string): TestLogDigest {
  const result = emptyDigest()
  result.flavor = 'vitest'
  const failures: TestFailure[] = []
  let counts: TestCounts | null = null
  let suitesFailed = 0
  let inSuites = false
  const lines = readLogLines(logPath)
  if (lines === undefined) return result
  for (const line of lines) {
    const section = VITEST_SECTION_RE.exec(line)
    if (section) {
      // Which section a FAIL line sits in is what separates "this
      // suite did not load" from "this test failed".
      inSuites = section.groups?.name === 'Failed Suites'
      if (inSuites) suitesFailed = Number(section.groups?.count ?? 0)
      continue
    }
    const failed = VITEST_FAIL_RE.exec(line)
    if (failed) {
      const rest = (failed.groups?.rest ?? '').trim()
      if (inSuites) {
        // `FAIL  src/broken.test.ts [ src/broken.test.ts ]`
        const file = rest.split(' [ ', 1)[0]?.trim() ?? ''
        failures.push({ file, name: VITEST_LOAD_PREFIX + file, didNotComplete: false })
      } else {
        const { file, name } = splitVitestFailure(rest)
        failures.push({ file, name, didNotComplete: false })
      }
      continue
    }
    const tests = VITEST_TESTS_LINE_RE.exec(line)
    if (tests) counts = parseVitestCounts(tests.groups?.body ?? '')
  }

  if (counts !== null && suitesFailed) counts.failed += suitesFailed
  result.failures = failures
  result.counts = counts
  // The summary line is the run's last output, so seeing it *is* reaching the
  // end: a killed vitest run never writes one.
  result.summary = summarizeTestRun(counts, counts !== null)
  return result
}

/**
 * The digest for a job, whichever runner produced its log.
 *
 * Two runners are read — `flutter test`/`dart test`, and vitest. What a command
 * *is* decides the parser, except for `run <script>`: the script name is the
 * project's own word for what it runs, so there the log content is the only
 * evidence. Anything else has no digest at all.
 */
export function analyzeTestLog(argv: readonly string[], logPath: string): TestLogDigest {
  if (isTestRun(argv)) return parseFlutterLog(logPath)
  if (isVitestRun(argv) || (mightRunVitest(argv) && looksLikeVitest(logPath))) {
    return parseVitestLog(logPath)
  }
  return emptyDigest()
}

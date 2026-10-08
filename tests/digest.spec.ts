/**
 * The TS port of the digest cases in `tests/test_toolhub.py`
 * (`TestLogAnalyzerTests` and `VitestDigestTests`), plus the primitives those
 * cases reach only indirectly.
 *
 * The fixtures are language-neutral, so they are read exactly as the Python
 * suite reads them. Scratch logs are the one exception: the killed-run and
 * counts cases need a log the fixtures do not carry, and Python wrote them into
 * `tests/.tmp-node-logs/` the same way this writes `tests/.tmp-digest/`.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  attachPaths,
  analyzeTestLog,
  looksLikeVitest,
  parseFlutterLog,
  parseVitestCounts,
  parseVitestLog,
  splitBlockEntry,
  splitVitestFailure,
  summarizeTestRun,
} from '../src/engine/digest'
import type { TestFailure } from '../src/engine/types'

/** Mirrors the Python `fixture(name)` helper over `tests/fixtures/`. */
function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
}

const FLUTTER_TEST = ['flutter', 'test', 'test/desktop']
const VITEST = ['vitest', 'run']

const scratchDir = fileURLToPath(new URL('./.tmp-digest/', import.meta.url))
const scratchLog = (name: string, text: string): string => {
  const path = join(scratchDir, name)
  writeFileSync(path, text, 'utf8')
  return path
}

beforeAll(() => {
  mkdirSync(scratchDir, { recursive: true })
})

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true })
})

describe('analyzeTestLog: counts authoritative, failures complete, run order', () => {
  const digest = (name: string) => analyzeTestLog(FLUTTER_TEST, fixture(name))

  it('reads counts and summary', () => {
    const result = digest('expanded_failed.txt')
    expect(result.counts).toEqual({ passed: 83, skipped: 0, failed: 6 })
    expect(result.summary).toBe('83 passed, 6 failed')
  })

  it('reports failures complete and in run order', () => {
    const result = digest('expanded_failed.txt')
    const { failures } = result
    expect(failures).toHaveLength(6)
    expect(failures.map((entry) => entry.name)).toEqual([
      'alpha refuses a bad key',
      'bravo retries once',
      'gamma restores state',
      'delta dedupes',
      'epsilon syncs',
      'zeta handles empty',
    ])
  })

  it('still reports failures the block evicted', () => {
    // The block shows four entries plus '... and 2 more'; we report all.
    const result = digest('expanded_failed.txt')
    const names = result.failures.map((entry) => entry.name)
    expect(names).toContain('alpha refuses a bad key')
    expect(names).toContain('bravo retries once')
  })

  it('takes paths from the progress lines', () => {
    const result = digest('expanded_failed.txt')
    expect(result.failures[0]?.file).toBe('C:/ws/test/desktop/alpha_test.dart')
  })

  it('flags a test that did not complete', () => {
    const result = digest('expanded_failed.txt')
    const flagged = result.failures.filter((entry) => entry.didNotComplete).map((entry) => entry.name)
    expect(flagged).toEqual(['epsilon syncs'])
  })

  it('keeps everything for the failures-only reporter, which has no block', () => {
    // The fixture carries this reporter's real shape — every progress line bare,
    // without the `HH:MM` prefix the other reporters write — so this case fails
    // if the reader ever anchors on the timestamp again.
    const result = digest('failures_only_failed.txt')
    expect(result.counts?.failed).toBe(2)
    expect(result.summary).toBe('12 passed, 2 failed')
    expect(result.failures).toHaveLength(2)
    expect(result.failures.every((entry) => entry.file === null)).toBe(true)
  })

  it('takes paths from the block on a single-file run', () => {
    const result = digest('single_file_failed.txt')
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.file).toBe('C:/ws/test/unit/thing_test.dart')
    expect(result.failures[0]?.name).toBe('my failing test')
  })

  it('reports a load failure', () => {
    const result = digest('load_failure.txt')
    expect(result.counts).toEqual({ passed: 0, skipped: 0, failed: 1 })
    expect(result.failures[0]?.name).toBe('loading C:/ws/test/broken_test.dart')
    expect(result.failures[0]?.file).toBe('C:/ws/test/broken_test.dart')
  })

  it('reports skips on a passing run', () => {
    const result = digest('expanded_passed.txt')
    expect(result.summary).toBe('33 passed, 2 skipped')
    expect(result.failures).toEqual([])
  })

  it('has no digest for a non-test command', () => {
    const result = analyzeTestLog(['flutter', 'analyze'], fixture('expanded_failed.txt'))
    expect(result.summary).toBeNull()
    expect(result.counts).toBeNull()
    expect(result.failures).toEqual([])
  })

  it('digests dart test too', () => {
    const result = analyzeTestLog(['dart', 'test'], fixture('expanded_failed.txt'))
    expect(result.summary).toBe('83 passed, 6 failed')
  })

  it('does not claim completion for a killed run', () => {
    // Counts without a terminal marker mean a truncated suite, not a pass.
    const result = digest('killed_run.txt')
    expect(result.counts).toEqual({ passed: 5, skipped: 0, failed: 0 })
    expect(result.summary).toBe('see log')
  })
})

describe('vitest digest: the reporter read the way the flutter one already was', () => {
  const digest = (name: string, argv: readonly string[] = VITEST) =>
    analyzeTestLog(argv, fixture(name))

  it('reads counts, summary and flavor', () => {
    const result = digest('vitest_two_files_failed.txt')
    expect(result.flavor).toBe('vitest')
    expect(result.counts).toEqual({ passed: 3, skipped: 0, failed: 1 })
    expect(result.summary).toBe('3 passed, 1 failed')
  })

  it('carries the suite and the full name in the failure inventory', () => {
    const result = digest('vitest_two_files_failed.txt')
    expect(result.failures).toEqual([
      { file: 'src/App.test.ts', name: 'add > fails on purpose', didNotComplete: false },
    ])
  })

  it('gives a passing run counts and no failures', () => {
    const result = digest('vitest_passing.txt')
    expect(result.counts).toEqual({ passed: 2, skipped: 0, failed: 0 })
    expect(result.summary).toBe('2 passed')
    expect(result.failures).toEqual([])
  })

  it('counts a suite that never loaded as a failure', () => {
    // `Tests  no tests` with a red run: the suite failure is the failure.
    const result = digest('vitest_load_failure.txt')
    expect(result.counts).toEqual({ passed: 0, skipped: 0, failed: 1 })
    expect(result.summary).toBe('0 passed, 1 failed')
    expect(result.failures).toEqual([
      { file: 'src/Broken.test.ts', name: 'loading src/Broken.test.ts', didNotComplete: false },
    ])
  })

  // The script name is the project's word for it, so content decides.
  // Parameterised over the manager because the argv gate (`mightRunVitest`) has
  // to open the log for npm's spellings too — the shorthand `npm test`
  // included, since that is the argv it arrives as after normalisation.
  for (const argv of [
    ['pnpm', 'run', 'test'],
    ['npm', 'run', 'test'],
    ['npm', 'test'],
  ]) {
    it(`recognises a run script from the log: ${argv.join(' ')}`, () => {
      const result = analyzeTestLog(argv, fixture('vitest_two_files_failed.txt'))
      expect(result.flavor).toBe('vitest')
      expect(result.summary).toBe('3 passed, 1 failed')
    })
  }

  for (const argv of [
    ['pnpm', 'run', 'build'],
    ['npm', 'run', 'build'],
  ]) {
    it(`has no digest for a package-manager job with a foreign log: ${argv.join(' ')}`, () => {
      const result = analyzeTestLog(argv, fixture('expanded_failed.txt'))
      expect(result.flavor).toBeNull()
      expect(result.summary).toBeNull()
    })
  }

  it('keeps the inventory of a killed run but claims no counts', () => {
    const log = scratchLog(
      'killed.txt',
      '\n RUN  v5.0.3 C:/ws\n\n' +
        ' ❯ src/App.test.ts (2 tests | 1 failed) 6ms\n\n' +
        '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯\n\n' +
        ' FAIL  src/App.test.ts > add > fails on purpose\n' +
        'AssertionError: expected 3 to be 4\n',
    )
    const result = analyzeTestLog(VITEST, log)
    expect(result.counts).toBeNull()
    expect(result.summary).toBe('see log')
    expect(result.failures).toHaveLength(1)
  })

  it('keeps an absolute reported path', () => {
    const log = scratchLog(
      'absolute.txt',
      ' FAIL  C:/ws/src/App.test.ts > add > fails on purpose\n' +
        '      Tests  1 failed (1)\n',
    )
    const result = analyzeTestLog(VITEST, log)
    expect(result.failures[0]?.file).toBe('C:/ws/src/App.test.ts')
    expect(result.failures[0]?.name).toBe('add > fails on purpose')
    expect(result.summary).toBe('0 passed, 1 failed')
  })

  it('treats skipped and todo as both not run', () => {
    // `skipped` comes from the total, so a `todo` does not vanish.
    const log = scratchLog('counts.txt', '      Tests  2 passed | 1 failed | 1 todo (4)\n')
    const result = analyzeTestLog(VITEST, log)
    expect(result.counts).toEqual({ passed: 2, skipped: 1, failed: 1 })
  })

  it('still says so for a flutter digest', () => {
    const result = analyzeTestLog(['flutter', 'test'], fixture('expanded_failed.txt'))
    expect(result.flavor).toBe('flutter')
  })
})

/**
 * Colour, which this bridge's own jobs really do get.
 *
 * `digest.ts` assumed a colourless log ("no TTY, so no colour") and the fixtures
 * are colourless, so nothing here noticed that the assumption is false on
 * Windows: vitest's reporter colours through a pipe because `tinyrainbow` counts
 * `platform === 'win32'` as colour support, and a real job log was measured with
 * 240 escape bytes in 2 345. Every vitest line regex is `^`-anchored, so a run
 * whose summary line begins with `\u001b[2m` produces no counts at all — the
 * digest silently reported nothing for a green suite.
 *
 * The sequences below are the measured ones, copied from a real job log
 * (`~/.dsh/toolbridge/logs/1791447598494-f356694e.log`), including the
 * `\u001b[22m\u001b[1m` reverse the reporter emits around a bold run.
 */
const ESC = '\u001b'
const DIM = `${ESC}[2m`
const DIM_OFF = `${ESC}[22m`
const BOLD = `${ESC}[1m`
const GREEN = `${ESC}[32m`
const RED = `${ESC}[31m`
const COLOUR_OFF = `${ESC}[39m`
const GRAY = `${ESC}[90m`

describe('a coloured log digests exactly like a plain one', () => {
  it('reads the vitest summary through the reporter\'s escapes', () => {
    const log = scratchLog(
      'colored.txt',
      `${DIM}      Tests ${DIM_OFF} ${BOLD}${GREEN}3 passed${COLOUR_OFF}${DIM_OFF}${GRAY} (3)${COLOUR_OFF}\n` +
        `${DIM}   Duration ${DIM_OFF} 1.94s${DIM}\n` +
        `${DIM} Test Files ${DIM_OFF} ${BOLD}${GREEN}1 passed${COLOUR_OFF}${DIM_OFF}${GRAY} (1)${COLOUR_OFF}\n`,
    )
    const result = analyzeTestLog(VITEST, log)
    expect(result.counts).toEqual({ passed: 3, skipped: 0, failed: 0 })
    expect(result.summary).toBe('3 passed')
  })

  it('keeps a coloured failure inventory, and its counts', () => {
    const log = scratchLog(
      'colored-failure.txt',
      `${DIM} ❯${DIM_OFF} ${RED}src/App.test.ts${COLOUR_OFF} (2 tests | 1 failed) 6ms\n\n` +
        `${RED} FAIL ${COLOUR_OFF} src/App.test.ts > add > fails on purpose\n` +
        `AssertionError: expected 3 to be 4\n\n` +
        `${DIM}      Tests ${DIM_OFF} ${BOLD}${RED}1 failed${COLOUR_OFF}${DIM_OFF} | ${BOLD}${GREEN}1 passed${COLOUR_OFF}${DIM_OFF}${GRAY} (2)${COLOUR_OFF}\n`,
    )
    const result = analyzeTestLog(VITEST, log)
    expect(result.counts).toEqual({ passed: 1, skipped: 0, failed: 1 })
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.file).toBe('src/App.test.ts')
    expect(result.failures[0]?.name).toBe('add > fails on purpose')
  })

  it('reads a `package:test` progress line through escapes anywhere in it', () => {
    // Synthetic on purpose — no captured coloured flutter log was available, and
    // the point is the general one: the reader's two parsers share one line
    // source, so an escape the reporter puts anywhere must not defeat them.
    const log = scratchLog(
      'colored-flutter.txt',
      `${ESC}[32m00:25 +67${ESC}[0m ~2 ${ESC}[31m-4${ESC}[0m: a failing test ${ESC}[31m[E]${ESC}[0m\n` +
        `${ESC}[1mFailing tests:${ESC}[0m\n` +
        `  ${ESC}[31msrc/a_test.dart: a failing test${ESC}[0m\n` +
        `${ESC}[31mSome tests failed.${ESC}[0m\n`,
    )
    const result = analyzeTestLog(FLUTTER_TEST, log)
    expect(result.counts).toEqual({ passed: 67, skipped: 2, failed: 4 })
    expect(result.summary).toBe('67 passed, 4 failed')
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.name).toBe('a failing test')
    expect(result.failures[0]?.file).toBe('src/a_test.dart')
  })
})

/**
 * The `failures-only` reporter, whose shape is not the one the fixtures carry.
 *
 * `failures-only` writes **every** progress line without the `HH:MM` prefix —
 * measured on a real 2 503-line job log: 0 prefixed progress lines, 240 bare
 * ones, and the run's last line `+7430 ~49 -8: Some tests failed.` while the job
 * exited 1. Every `package:test` pattern was anchored on the timestamp, so the
 * digest got no counts and no failure inventory from it at all, and then read
 * that same last line as a terminal marker and announced **"all tests passed"**
 * — a false success for a failed run, which a panel screenshot caught.
 *
 * Both halves are fixed together because either one alone still lies: without the
 * bare form the counts are missing, and without the marker's polarity the missing
 * counts are reported as a pass.
 */
describe('a failures-only run is read for what it is', () => {
  it('recovers the counts and the inventory from a bare progress line', () => {
    const log = scratchLog(
      'failures-only.txt',
      '+284: D:/ws/test/a_test.dart: a test that passed\n' +
        '+570 -1: D:/ws/test/b_test.dart: imported IDs cannot escape the private directory [E]\n' +
        '+7430 ~49 -8: Some tests failed.\n',
    )
    const result = analyzeTestLog(FLUTTER_TEST, log)
    expect(result.counts).toEqual({ passed: 7430, skipped: 49, failed: 8 })
    expect(result.summary).toBe('7430 passed, 8 failed')
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.file).toBe('D:/ws/test/b_test.dart')
    expect(result.failures[0]?.name).toBe('imported IDs cannot escape the private directory')
  })

  it('never reads the failure marker as a pass', () => {
    // Counts are absent and the marker says the suite failed: the only honest
    // answer is the one that claims nothing.
    const log = scratchLog('marker-only.txt', 'Some tests failed.\n')
    const result = analyzeTestLog(FLUTTER_TEST, log)
    expect(result.counts).toBeNull()
    expect(result.summary).toBe('see log')
  })

  it('still trusts a success marker that carries no counts', () => {
    // The one case where a claim is evidence-backed: the reporter itself said so.
    const log = scratchLog('all-passed.txt', 'All tests passed!\n')
    expect(analyzeTestLog(FLUTTER_TEST, log).summary).toBe('all tests passed')
  })

  it('does not claim a pass when the marker reports failures the counts missed', () => {
    const log = scratchLog('suites.txt', '+12: D:/ws/test/a_test.dart: a test\nSome tests failed.\n')
    const result = analyzeTestLog(FLUTTER_TEST, log)
    expect(result.counts).toEqual({ passed: 12, skipped: 0, failed: 0 })
    expect(result.summary).toBe('see log')
  })
})

/**
 * The Python suite exercises these only through `analyze_test_log`, so its
 * branches no fixture reaches (a terminal run with no counts, the orphan path
 * of `attach_paths`, the `skipped` suffix) are pinned here directly from the
 * ported bodies.
 */
describe('digest primitives', () => {
  it('summarizes counts, a suite verdict, and their absence', () => {
    // A verdict, not a boolean: the marker set carries both "All tests passed!"
    // and "Some tests failed.", and reading the second as the first is how a
    // failed run came to be summarized as a pass.
    expect(summarizeTestRun(null, 'passed')).toBe('all tests passed')
    expect(summarizeTestRun(null, 'failed')).toBe('see log')
    expect(summarizeTestRun(null, 'unfinished')).toBe('see log')
    expect(summarizeTestRun({ passed: 3, skipped: 0, failed: 2 }, 'failed')).toBe('3 passed, 2 failed')
    expect(summarizeTestRun({ passed: 3, skipped: 0, failed: 2 }, 'unfinished')).toBe('3 passed, 2 failed')
    expect(summarizeTestRun({ passed: 3, skipped: 0, failed: 0 }, 'passed')).toBe('3 passed')
    expect(summarizeTestRun({ passed: 3, skipped: 2, failed: 0 }, 'passed')).toBe('3 passed, 2 skipped')
    expect(summarizeTestRun({ passed: 3, skipped: 1, failed: 0 }, 'unfinished')).toBe('see log')
    // The reporter's own verdict wins over counts that show no failures.
    expect(summarizeTestRun({ passed: 3, skipped: 0, failed: 0 }, 'failed')).toBe('see log')
  })

  it('splits a block entry, keeping the did-not-complete suffix out of the name', () => {
    expect(splitBlockEntry('pkg/a_test.dart: does a thing (did not complete)')).toEqual({
      file: 'pkg/a_test.dart',
      name: 'does a thing',
      didNotComplete: true,
    })
    expect(splitBlockEntry('a name (did not complete)')).toEqual({
      file: null,
      name: 'a name',
      didNotComplete: true,
    })
    expect(splitBlockEntry('pkg/a_test.dart: does a thing')).toEqual({
      file: 'pkg/a_test.dart',
      name: 'does a thing',
      didNotComplete: false,
    })
  })

  it('lends a block path and appends a block orphan', () => {
    const failures: TestFailure[] = [{ file: null, name: 'x', didNotComplete: false }]
    const block: TestFailure[] = [
      { file: 'pkg/a_test.dart', name: 'x', didNotComplete: false },
      { file: 'pkg/b_test.dart', name: 'orphan', didNotComplete: true },
    ]
    const merged = attachPaths(failures, block)
    expect(merged).toBe(failures)
    expect(merged).toEqual([
      { file: 'pkg/a_test.dart', name: 'x', didNotComplete: false },
      { file: 'pkg/b_test.dart', name: 'orphan', didNotComplete: true },
    ])
  })

  it('parses vitest counts from a Tests summary body', () => {
    expect(parseVitestCounts('no tests')).toEqual({ passed: 0, skipped: 0, failed: 0 })
    expect(parseVitestCounts('1 failed | 3 passed (4)')).toEqual({
      passed: 3,
      skipped: 0,
      failed: 1,
    })
    expect(parseVitestCounts('2 passed | 1 failed | 1 todo (4)')).toEqual({
      passed: 2,
      skipped: 1,
      failed: 1,
    })
  })

  it('splits a vitest failure at the first separator only', () => {
    expect(splitVitestFailure('src/App.test.ts > add > fails on purpose')).toEqual({
      file: 'src/App.test.ts',
      name: 'add > fails on purpose',
    })
    expect(splitVitestFailure('no path here')).toEqual({ file: null, name: 'no path here' })
    expect(splitVitestFailure('src/App.test.ts > ')).toEqual({ file: null, name: 'src/App.test.ts > ' })
  })

  it('sniffs the vitest reporter markers in a log', () => {
    expect(looksLikeVitest(fixture('vitest_two_files_failed.txt'))).toBe(true)
    expect(looksLikeVitest(fixture('expanded_failed.txt'))).toBe(false)
    expect(looksLikeVitest(fixture('does-not-exist.log'))).toBe(false)
  })

  it('returns an empty digest for an unreadable log', () => {
    const missing = fixture('does-not-exist.log')
    expect(analyzeTestLog(VITEST, missing)).toEqual({
      flavor: 'vitest',
      summary: null,
      counts: null,
      failures: [],
    })
    expect(parseFlutterLog(missing)).toEqual({
      flavor: 'flutter',
      summary: null,
      counts: null,
      failures: [],
    })
    expect(parseVitestLog(missing)).toEqual({
      flavor: 'vitest',
      summary: null,
      counts: null,
      failures: [],
    })
    expect(analyzeTestLog(['flutter', 'analyze'], missing)).toEqual({
      flavor: null,
      summary: null,
      counts: null,
      failures: [],
    })
  })
})

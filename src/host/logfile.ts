/**
 * Reading a job's log: the bounded tail, and the full scan a filter needs.
 *
 * The two readings are deliberately different sizes. Without a filter the tail
 * is a bounded end-of-file read, because that is all a caller wants when it is
 * looking at how a build ended. With a filter the *whole* file is scanned:
 * a 256 KiB window would answer "no matches" for a failure sitting earlier in
 * the file, and a filter that lies is worse than no filter. Only the last N
 * matches are kept while every match is counted, so "none" is never confused
 * with "not all of them".
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'

import { stripAnsi } from '../engine/ansi'

/** How much of the end of a log an unfiltered tail reads. */
export const TAIL_SCAN_BYTES = 256 * 1024
/** The default number of log lines a response carries. */
export const DEFAULT_TAIL_LINES = 200
/** The most lines a response may ask for. */
export const MAX_TAIL_LINES = 5000

/** The response's account of what the log view did, so "no matches" never reads as "no output". */
export interface LogView {
  /** The pattern that was applied, or null without one. */
  grep: string | null
  /** Lines the pattern matched over the whole log; null without a pattern. */
  matched: number | null
  /** Lines actually returned; null without a pattern. */
  returned: number | null
  /** Lines read while scanning; null without a pattern. */
  scannedLines: number | null
  /** Whether the pattern matched more lines than were returned. */
  truncated: boolean
}

function readWindow(path: string, bytes: number): { text: string; whole: boolean } {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return { text: '', whole: true }
  }
  const start = Math.max(0, size - bytes)
  const length = size - start
  if (length <= 0) return { text: '', whole: true }
  const handle = openSync(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(length)
    const read = readSync(handle, buffer, 0, length, start)
    return { text: buffer.subarray(0, read).toString('utf8'), whole: start === 0 }
  } catch {
    return { text: '', whole: true }
  } finally {
    closeSync(handle)
  }
}

/**
 * The last `lines` lines of a log file, read from the end.
 *
 * When the window did not reach the start of the file, its first line is a
 * fragment of a longer one and is dropped: half a line is not a line.
 *
 * Escape sequences are removed before the split, so the caller's lines are text
 * — this is the view the model and the panel read, and neither can render
 * colour (see `engine/ansi.ts`). A sequence the window cut in half goes with the
 * line it started in.
 */
export function readTailText(path: string, lines: number): string {
  if (lines <= 0) return ''
  const { text, whole } = readWindow(path, TAIL_SCAN_BYTES)
  let split = stripAnsi(text).split(/\r\n|[\r\n]/u)
  if (!whole && split.length > 1) split = split.slice(1)
  if (split.at(-1) === '') split.pop()
  return split.slice(-lines).join('\n')
}

/**
 * The log tail, optionally keeping only lines a regex matches, plus the view's
 * account of what happened.
 *
 * The strip happens before the split and the count, deliberately: `matched`,
 * `returned` and `scannedLines` describe the text the caller actually receives,
 * so a pattern is never matched against bytes that were then removed from the
 * answer — a filter that lies about what it counted is worse than no filter at
 * all.
 * @param path - the job's log file.
 * @param grep - the caller's pattern, or null for the bounded tail.
 * @param lines - how many lines may be returned.
 * @returns the text and its {@link LogView}.
 */
export function readFiltered(path: string, grep: RegExp | null, lines: number): { text: string; log: LogView } {
  if (grep === null) {
    return {
      text: readTailText(path, lines),
      log: { grep: null, matched: null, returned: null, scannedLines: null, truncated: false },
    }
  }
  let text: string
  try {
    text = stripAnsi(readFileSync(path, 'utf8'))
  } catch {
    text = ''
  }
  // Text-level splitting with the universal newline set on purpose: a `compact`
  // reporter separates progress lines with a bare CR, which a byte-wise scan
  // would treat as one enormous line.
  const all = text.split(/\r\n|[\r\n]/u)
  if (all.at(-1) === '') all.pop()
  const kept: string[] = []
  let matched = 0
  let scanned = 0
  for (const line of all) {
    scanned += 1
    if (grep.test(line)) {
      // `grep` from a caller is not global, so `test` has no lasting state; a
      // pattern that somehow is gets its `lastIndex` reset by the assignment.
      matched += 1
      if (lines > 0) {
        kept.push(line)
        if (kept.length > lines) kept.shift()
      }
    }
  }
  const returned = kept.length
  return {
    text: kept.join('\n'),
    log: { grep: grep.source, matched, returned, scannedLines: scanned, truncated: matched > returned },
  }
}

/** Clamp a caller's `tail` to the accepted range. */
export function clampTail(lines: number | undefined): number {
  if (lines === undefined) return DEFAULT_TAIL_LINES
  if (!Number.isFinite(lines)) return DEFAULT_TAIL_LINES
  return Math.max(0, Math.min(MAX_TAIL_LINES, Math.trunc(lines)))
}

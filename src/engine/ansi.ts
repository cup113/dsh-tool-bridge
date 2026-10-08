/**
 * Terminal colour, removed at the boundary where output becomes model-facing.
 *
 * Every toolchain underneath this bridge colours its output when it believes
 * something is watching, and this bridge's jobs are read by a model and rendered
 * as text in a panel — neither of which can use an escape sequence. Worse than
 * useless, in fact: on Windows vitest colours *through a pipe*, because
 * `tinyrainbow` counts `platform === 'win32'` as colour support, and a real job
 * log was measured at 240 escape bytes in 2 345. Every vitest line pattern in
 * `digest.ts` anchors on `^`, so a summary line beginning `\u001b[2m` produced no
 * counts at all: a green suite came back with a null digest and `see log`.
 *
 * Two halves, because prevention and cure cover different failures:
 *
 * - `runner.ts` sets `NO_COLOR=1` for every job, the same override the harness's
 *   own `pwsh` tool applies to its children — so the *file* is plain text too,
 *   and the bytes a caller greps with the ordinary file tools match.
 * - this strip runs at each read that hands text to the model (the log tail and
 *   filter, the digest's line source, the job output ring), because that
 *   override is a convention, not a guarantee: a tool that ignores `NO_COLOR`,
 *   forces colour with its own flag, or writes a colour code from inside a
 *   program has no reason to consult it.
 *
 * The log file itself is never rewritten. It is the raw record, and the one
 * thing a reader can go back to when a stripped view is not enough.
 */

/**
 * One escape sequence: CSI (`\u001b[…m`), OSC (`\u001b]…` ended by BEL or ST),
 * or a bare two-character escape. The 8-bit CSI (`\u009b`) is accepted too, since
 * a program reaching an ANSI-capable console may emit it.
 */
const ANSI_RE = /[\u001b\u009b](?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/gu

/** How far back a trailing escape sequence is looked for; none is longer. */
const ESCAPE_LOOKBACK = 32

/** The ESC that starts every sequence this module removes. */
const ESC = 0x1b

/**
 * Remove terminal escape sequences from text.
 *
 * `replace` with a global pattern, so a string with many sequences is one pass
 * and a string with none is a scan that finds nothing to do — which matters
 * because this runs on every read of every job log.
 * @param text - the text to clean, as read or decoded.
 * @returns the same text without escape sequences.
 */
export function stripAnsi(text: string): string {
  return text.includes('\u001b') || text.includes('\u009b') ? text.replace(ANSI_RE, '') : text
}

/**
 * How many trailing bytes belong to an escape sequence that is not finished yet.
 *
 * The job output ring is fed by incremental reads, so a delta can end in the
 * middle of a sequence the writer emitted whole — the read boundary and the
 * write boundary are unrelated. Those bytes are held back rather than emitted:
 * stripped text with a `[32m` fragment left in it is exactly the mojibake this
 * module exists to prevent, one read later. The counterpart of the incomplete
 * UTF-8 character, and it is handled in the same place for the same reason.
 *
 * A byte that cannot begin or continue a sequence ends the search, so ordinary
 * text is never held back.
 * @param bytes - the bytes at the end of a read window.
 * @returns the number of trailing bytes to leave for the next read.
 */
export function incompleteEscapeSuffix(bytes: Uint8Array): number {
  const end = bytes.length
  const floor = Math.max(0, end - ESCAPE_LOOKBACK)
  for (let index = end - 1; index >= floor; index -= 1) {
    const byte = bytes[index] as number
    if (byte !== ESC) continue
    const next = bytes[index + 1]
    if (next === undefined) return end - index // "\u001b"
    if (next === 0x5b) {
      // CSI: params then a final byte in [@-~].
      for (let scan = index + 2; scan < end; scan += 1) {
        const candidate = bytes[scan] as number
        if (candidate >= 0x40 && candidate <= 0x7e) return 0
      }
      return end - index
    }
    if (next === 0x5d) {
      // OSC: runs until BEL or ST, neither of which is here yet.
      for (let scan = index + 2; scan < end; scan += 1) {
        if (bytes[scan] === 0x07) return 0
        if (bytes[scan] === ESC && bytes[scan + 1] === 0x5c) return 0
      }
      return end - index
    }
    return 0 // a two-character escape: complete as soon as its second byte is here
  }
  return 0
}

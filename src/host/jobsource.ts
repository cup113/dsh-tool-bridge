/**
 * The job's output ring, fed from the log file the run is already writing.
 *
 * A bridge job's output had exactly one destination — its own UTF-8 log file —
 * and the harness's `job_output` reads somewhere else entirely: the job's output
 * ring, which nothing ever wrote to. Measured in a real session, every read of a
 * bridge job came back empty whatever the job did:
 *
 *     job_output bridge-41  -> (no new output) / [status: running, flutter test]
 *     job_output bridge-43  -> (no new output) / [status: failed, exit code: 1]
 *     job_output bridge-47  -> (no new output) / [status: completed]
 *
 * while the same log read back fine through the tool's own `tail`, the tool
 * description promised `job_output`, and `CONTEXT.md` described the ring as the
 * harness's. So this is the missing half: a pull source (`JobOutputSource`) the
 * registry pumps into the ring at its own cadence (150 ms by default), reading
 * the log by UTF-8 byte offset.
 *
 * Three details are load-bearing.
 *
 * **The log file is the source of truth, not a copy.** Nothing is duplicated
 * into memory per byte: a read is `open`/`read`/`close` over the delta, and the
 * file is also what the source advertises as its `spillPath` — the complete
 * stream, for a reader whose cursor fell behind retention. That is honest here
 * in a way it is not for a process's pipe: the log is append-only and never
 * trimmed, so the path really does hold everything.
 *
 * **Offsets are UTF-8 byte offsets, and a character is never split.** The
 * registry's coordinate space is bytes while the ring hands out `string`s, so a
 * read that ends mid-character would decode a replacement character and the
 * caller would see mojibake in the middle of CJK output — the exact class of
 * damage this project avoids elsewhere. A trailing partial sequence is therefore
 * held back and re-read with the bytes that complete it. An escape sequence the
 * writer has not finished is held back the same way, and for the same reason.
 *
 * **The mirror is text, not bytes.** Escape sequences are stripped from what the
 * ring carries (see `engine/ansi.ts`): the ring is read by a model, which cannot
 * use colour, and a stripped delta is what keeps a coloured reporter from
 * spending tokens on `[32m`. The log file keeps the raw bytes.
 *
 * **The mirror is bounded.** Past {@link JOB_OUTPUT_MIRROR_BYTES} the source
 * stops advancing its window and reports a lossy read, which the ring renders as
 * a gap plus the spill path: the model reads the file itself rather than the
 * plugin mirroring a multi-megabyte log into the ring.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs'

import type { JobOutputSource, JobSourceRead } from '@deepseek-ai/dsh-jobs'

import { incompleteEscapeSuffix, stripAnsi } from '../engine/ansi'

/**
 * How much of a job's output is mirrored into the ring, in bytes.
 *
 * Sized from the real thing this was fixed for: the `flutter test` log in the
 * incident was 1.4 MB. Well under the ring's own live retention (256 KiB) it
 * would be pointless — the model's cursor does not consume while a job runs — so
 * the mirror is generous and the cap exists only to bound a pathological stream.
 * Past it, the read is lossy and the log file is the answer.
 */
export const JOB_OUTPUT_MIRROR_BYTES = 4 * 1024 * 1024

/**
 * How many bytes at the end of `bytes` are an incomplete UTF-8 sequence.
 *
 * Returns the length of the longest prefix that is *complete*, so the caller
 * decodes that and leaves the remainder to the next read. Only the last three
 * bytes can belong to a split character, and a byte that cannot start a sequence
 * is itself undecodable, so it is returned as complete rather than held back
 * forever.
 * @param bytes - the bytes read from the window's start to its end.
 * @returns the number of bytes that decode cleanly from the front.
 */
export function completeUtf8Prefix(bytes: Uint8Array): number {
  const end = bytes.length
  const floor = Math.max(0, end - 3)
  for (let index = end - 1; index >= floor; index -= 1) {
    const byte = bytes[index] as number
    if ((byte & 0xc0) === 0x80) continue // a continuation byte: keep walking back
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
    const have = end - index
    return needed > have ? index : end
  }
  // Nothing but continuation bytes in the last four positions: a lone tail that
  // no read will ever complete, so it is not held back.
  return end
}

/**
 * One run's log, as the job registry's pull source.
 *
 * Reads are pure with respect to the file: the registry owns the cursor, this
 * owns only the window floor it enforces for {@link JOB_OUTPUT_MIRROR_BYTES}.
 * A missing file is an empty read, never an error: the file is created by the
 * run's own write stream, whose open is asynchronous, so the first poll can
 * legitimately land before the log exists.
 */
export class LogOutputSource implements JobOutputSource {
  /** The log's bytes are one stream; the run merges stderr into it on purpose. */
  readonly channel = 'stdout'

  /** The lowest offset this source can still serve (`0` until the cap bites). */
  private served = 0

  constructor(
    /** The run's log file. */
    private readonly path: string,
    /** The mirror cap; {@link JOB_OUTPUT_MIRROR_BYTES} unless a test says otherwise. */
    private readonly cap: number = JOB_OUTPUT_MIRROR_BYTES,
  ) {}

  /**
   * The log's current size, or null when it does not exist yet.
   * @returns the byte length.
   */
  private size(): number | null {
    try {
      return statSync(this.path).size
    } catch {
      return null
    }
  }

  /** The bytes in `[from, to)`, or null when the file cannot be read. */
  private bytesOf(from: number, to: number): Buffer | null {
    const length = to - from
    if (length <= 0) return Buffer.alloc(0)
    let handle: number
    try {
      handle = openSync(this.path, 'r')
    } catch {
      return null
    }
    try {
      const buffer = Buffer.allocUnsafe(length)
      const read = readSync(handle, buffer, 0, length, from)
      return buffer.subarray(0, read)
    } catch {
      return null
    } finally {
      closeSync(handle)
    }
  }

  /**
   * Everything the log gained since `fromByte`.
   *
   * A read below the window floor is lossy and returns the surviving tail, which
   * the registry turns into a gap chunk — the discontinuity is shown, not
   * silently spliced. `nextOffset` never moves backwards, which is the ring's
   * own assumption: consumers concatenate chunks by offset, so a cursor that
   * regressed would duplicate text rather than recover it.
   * @param fromByte - the whole-stream byte offset to resume from.
   * @returns the delta, the next offset, the lossy flag, and the log as spill path.
   */
  read(fromByte: number): JobSourceRead {
    const size = this.size()
    if (size === null) return { text: '', nextOffset: Math.max(0, Math.trunc(fromByte)), lossy: false }
    const floor = Math.max(0, size - this.cap)
    if (floor > this.served) this.served = floor
    const lossy = fromByte < this.served
    const start = lossy ? this.served : Math.max(0, Math.trunc(fromByte))
    if (start >= size) return { text: '', nextOffset: start, lossy, spillPath: this.path }
    const bytes = this.bytesOf(start, size)
    if (bytes === null) return { text: '', nextOffset: start, lossy: false }
    // Two kinds of incomplete tail are held back for the next read: a character
    // the writer split, and an escape sequence the writer has not finished. Both
    // would otherwise decode into visible damage at exactly this boundary.
    const whole = completeUtf8Prefix(bytes)
    const usable = whole - incompleteEscapeSuffix(bytes.subarray(0, whole))
    return {
      text: stripAnsi(bytes.subarray(0, usable).toString('utf8')),
      nextOffset: start + usable,
      lossy,
      spillPath: this.path,
    }
  }
}

/**
 * The pull sources one job registers for its log.
 *
 * A function rather than an inline ternary so the decision is testable without
 * starting a process: a command's log *is* its output and is the only thing
 * `job_output` could read, while a sub-tool narrates through `JobHandle.append`
 * and would otherwise interleave two accounts of the same job.
 * @param logPath - the run's log file, or null for a job that narrates itself.
 * @returns one mirror source, or none.
 */
export function logMirror(logPath: string | null): JobOutputSource[] {
  return logPath === null ? [] : [new LogOutputSource(logPath)]
}

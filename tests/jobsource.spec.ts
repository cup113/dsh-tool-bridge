/**
 * The log mirror: the source that makes a bridge job's output visible to
 * `job_output`.
 *
 * The defect these cases exist for produced no error at all — every read of a
 * bridge job came back `(no new output)` whether the job passed, failed or
 * finished — so the assertions have to be about bytes: that a delta is exactly
 * what the log gained, that nothing is duplicated or lost as the file grows, and
 * that a multi-byte character split across two reads is not turned into
 * mojibake. The last one is not hypothetical: this bridge's own logs carry CJK
 * (the ARB values are Chinese), and the registry's offsets are bytes while the
 * ring hands out strings.
 *
 * The registry's pump is *its* code, not this file's, so its cadence is not
 * simulated here beyond the one thing a source must support: read at a cursor,
 * advance to `nextOffset`, append the text. What is asserted is that a source
 * driven exactly that way yields the log's bytes once, in order.
 */

import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { JOB_OUTPUT_MIRROR_BYTES, LogOutputSource, completeUtf8Prefix, logMirror } from '../src/host/jobsource'

const SCRATCH = fileURLToPath(new URL('./.tmp-jobs/', import.meta.url))

// File-level on purpose: a per-describe `afterAll` would remove the scratch
// directory between the last two blocks and leave the second one writing into a
// directory that no longer exists.
beforeAll(() => {
  mkdirSync(SCRATCH, { recursive: true })
})

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

let counter = 0
function scratchPath(name: string): string {
  counter += 1
  const path = join(SCRATCH, `${counter}-${name}`)
  rmSync(path, { force: true })
  return path
}

describe('completeUtf8Prefix: a character is never cut in half', () => {
  const bytes = (...values: number[]): Uint8Array => new Uint8Array(values)

  it('passes pure ASCII through whole', () => {
    expect(completeUtf8Prefix(bytes(0x61, 0x62, 0x63))).toBe(3)
  })

  it('holds back a two-byte character with only its lead byte present', () => {
    // U+00E9 (é) is C3 A9.
    expect(completeUtf8Prefix(bytes(0x61, 0xc3))).toBe(1)
  })

  it('holds back a three-byte character split after one and after two bytes', () => {
    // U+4E2D (中) is E4 B8 AD.
    expect(completeUtf8Prefix(bytes(0x61, 0xe4))).toBe(1)
    expect(completeUtf8Prefix(bytes(0x61, 0xe4, 0xb8))).toBe(1)
    expect(completeUtf8Prefix(bytes(0x61, 0xe4, 0xb8, 0xad))).toBe(4)
  })

  it('holds back a four-byte character until its last byte arrives', () => {
    // U+1F600 is F0 9F 98 80.
    expect(completeUtf8Prefix(bytes(0xf0, 0x9f, 0x98))).toBe(0)
    expect(completeUtf8Prefix(bytes(0xf0, 0x9f, 0x98, 0x80))).toBe(4)
  })

  it('does not hold back forever on a tail no later byte can complete', () => {
    // Continuation bytes with no lead in reach: nothing will ever complete
    // them, so refusing to decode them would stall the source at this offset.
    expect(completeUtf8Prefix(bytes(0x61, 0x80, 0x80, 0x80, 0x80))).toBe(5)
  })

  it('passes an empty read through', () => {
    expect(completeUtf8Prefix(bytes())).toBe(0)
  })
})

describe('LogOutputSource: the log as an incremental stream', () => {
  it('reads nothing, and moves nothing, before the log exists', () => {
    // The log is created by the run's own write stream, whose open is
    // asynchronous, so the registry's first poll can legitimately get here.
    const path = scratchPath('absent.log')
    const source = new LogOutputSource(path)
    expect(source.read(0)).toEqual({ text: '', nextOffset: 0, lossy: false })
    expect(source.read(17)).toEqual({ text: '', nextOffset: 17, lossy: false })
  })

  it('returns each delta once, in order, as the log grows', () => {
    const path = scratchPath('grow.log')
    const source = new LogOutputSource(path)
    writeFileSync(path, 'Resolving dependencies...\n', 'utf8')
    const first = source.read(0)
    expect(first.text).toBe('Resolving dependencies...\n')
    expect(first.lossy).toBe(false)
    expect(first.spillPath).toBe(path)

    appendFileSync(path, '+6266 ~48: flutter_test\n', 'utf8')
    const second = source.read(first.nextOffset)
    expect(second.text).toBe('+6266 ~48: flutter_test\n')

    const third = source.read(second.nextOffset)
    expect(third.text).toBe('')
    expect(third.nextOffset).toBe(second.nextOffset)
  })

  it('completes a character the writer split across two reads', () => {
    const path = scratchPath('split.log')
    const source = new LogOutputSource(path)
    const cjk = Buffer.from('中', 'utf8')
    writeFileSync(path, Buffer.concat([Buffer.from('start '), cjk.subarray(0, 1)]))
    const first = source.read(0)
    // The lead byte is not decodable yet, so it stays unread: a replacement
    // character here would be the mojibake this case exists to prevent.
    expect(first.text).toBe('start ')
    expect(first.nextOffset).toBe(6)

    appendFileSync(path, cjk.subarray(1))
    const second = source.read(first.nextOffset)
    expect(second.text).toBe('中')
    expect(second.nextOffset).toBe(9)
  })

  it('reports a lossy read once the mirror cap is passed, and keeps serving', () => {
    const path = scratchPath('capped.log')
    const source = new LogOutputSource(path, 16)
    writeFileSync(path, 'x'.repeat(64), 'utf8')
    const read = source.read(0)
    expect(read.lossy).toBe(true)
    // The surviving tail is the whole window, and it is a suffix of the log.
    expect(read.text).toBe('x'.repeat(16))
    expect(read.nextOffset).toBe(64)

    appendFileSync(path, 'tail', 'utf8')
    const next = source.read(read.nextOffset)
    expect(next.lossy).toBe(false)
    expect(next.text).toBe('tail')
  })

  it('never moves the cursor backwards, even if the file shrinks', () => {
    // One log per job and append-only is the contract, so a shrink means
    // something outside this model happened. A regressed offset would make the
    // registry duplicate text rather than recover it, which is worse.
    const path = scratchPath('shrunk.log')
    const source = new LogOutputSource(path)
    writeFileSync(path, 'aaaa', 'utf8')
    expect(source.read(0).nextOffset).toBe(4)
    writeFileSync(path, 'a', 'utf8')
    const after = source.read(4)
    expect(after.text).toBe('')
    expect(after.nextOffset).toBeGreaterThanOrEqual(4)
  })

  it('mirrors the whole log when it is under the cap', () => {
    const path = scratchPath('under.log')
    writeFileSync(path, 'ok', 'utf8')
    expect(JOB_OUTPUT_MIRROR_BYTES).toBeGreaterThan(1024 * 1024)
    expect(new LogOutputSource(path).read(0).lossy).toBe(false)
  })

  it('hands the ring text, not terminal colour', () => {
    const path = scratchPath('colored.log')
    writeFileSync(path, '\u001b[32m197 passed\u001b[39m\n', 'utf8')
    expect(new LogOutputSource(path).read(0).text).toBe('197 passed\n')
  })

  it('holds back an escape sequence the writer has not finished', () => {
    // The read boundary and the writer's buffer boundary are unrelated, so a
    // delta can end inside a sequence. Emitting the fragment would put `[32m`
    // into the ring one read later — the same damage as not stripping at all.
    const path = scratchPath('split-escape.log')
    const sequence = Buffer.from('\u001b[32m', 'utf8')
    writeFileSync(path, Buffer.concat([Buffer.from('done '), sequence.subarray(0, 3)]))
    const first = new LogOutputSource(path).read(0)
    expect(first.text).toBe('done ')
    expect(first.nextOffset).toBe(5)

    appendFileSync(path, sequence.subarray(3))
    const second = new LogOutputSource(path).read(first.nextOffset)
    expect(second.text).toBe('')
    expect(second.nextOffset).toBe(10)
  })
})

describe('logMirror: which jobs register a source at all', () => {
  it('gives a command job one source over its log', () => {
    const path = scratchPath('mirror.log')
    writeFileSync(path, 'built\n', 'utf8')
    const sources = logMirror(path)
    expect(sources).toHaveLength(1)
    expect(sources[0]?.read(0).text).toBe('built\n')
    expect(existsSync(path)).toBe(true)
  })

  it('gives a self-narrating job none, rather than a second account of itself', () => {
    expect(logMirror(null)).toEqual([])
  })
})

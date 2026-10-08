/**
 * The strip that keeps escape sequences out of everything the model reads.
 *
 * The defect behind it was silent in the usual way: a coloured vitest summary
 * line produced a null digest, and the fixtures were all colourless, so nothing
 * failed. Each case here is therefore about a *shape* of colour, and the two
 * awkward ones are the reasons the module is not a one-line regex: a sequence
 * split across two incremental reads (which would otherwise leave a `[32m`
 * fragment in the job output ring) and a sequence that only looks complete.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { incompleteEscapeSuffix, stripAnsi } from '../src/engine/ansi'
import { readFiltered, readTailText } from '../src/host/logfile'

const SCRATCH = fileURLToPath(new URL('./.tmp-ansi/', import.meta.url))
const SGR = '\u001b[32m'
const RESET = '\u001b[0m'

beforeAll(() => {
  mkdirSync(SCRATCH, { recursive: true })
})

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

describe('stripAnsi: the sequences a reporter actually writes', () => {
  it('removes SGR colour and keeps the text', () => {
    expect(stripAnsi(`${SGR}3 passed${RESET}`)).toBe('3 passed')
  })

  it('removes the dim/bold reverse tinyrainbow emits around a count', () => {
    // Measured: `\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m197 passed\u001b[39m`.
    // The space *between* the two sequences is load-bearing: it is the second of
    // the two spaces `digest.ts` anchors `Tests {2,}` on, so a strip that ate it
    // would break the digest in the opposite direction.
    const line = '\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m197 passed\u001b[39m\u001b[22m'
    expect(stripAnsi(line)).toBe('      Tests  197 passed')
  })

  it('removes several sequences in one pass', () => {
    expect(stripAnsi(`${SGR}a${RESET}${SGR}b${RESET}`)).toBe('ab')
  })

  it('removes an OSC title, terminated by BEL or by ST', () => {
    expect(stripAnsi('\u001b]0;a title\u0007text')).toBe('text')
    expect(stripAnsi('\u001b]0;a title\u001b\\text')).toBe('text')
  })

  it('removes a two-character escape', () => {
    expect(stripAnsi('a\u001bMb')).toBe('ab')
  })

  it('leaves text with no escapes alone, including CJK', () => {
    const plain = '局域网同步 +5639 ~49 -2: 一条测试'
    expect(stripAnsi(plain)).toBe(plain)
    // The fast path must not copy either: identical text comes back identical.
    expect(stripAnsi(plain)).toBe(plain)
  })

  it('leaves a bare bracket that is not a sequence', () => {
    expect(stripAnsi('[32m is literal when the ESC is missing')).toBe('[32m is literal when the ESC is missing')
  })
})

describe('incompleteEscapeSuffix: what an incremental read must hold back', () => {
  const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'))

  it('holds back a lone ESC and a CSI with no final byte yet', () => {
    expect(incompleteEscapeSuffix(bytes('text\u001b'))).toBe(1)
    expect(incompleteEscapeSuffix(bytes('text\u001b['))).toBe(2)
    expect(incompleteEscapeSuffix(bytes('text\u001b[3'))).toBe(3)
  })

  it('releases a complete sequence', () => {
    expect(incompleteEscapeSuffix(bytes('text\u001b[32m'))).toBe(0)
  })

  it('holds back an OSC until its terminator arrives, and release it after', () => {
    expect(incompleteEscapeSuffix(bytes('text\u001b]0;title'))).toBe(9)
    expect(incompleteEscapeSuffix(bytes('text\u001b]0;title\u0007'))).toBe(0)
  })

  it('never holds back ordinary text whose last byte is not an escape', () => {
    expect(incompleteEscapeSuffix(bytes('plain text'))).toBe(0)
    expect(incompleteEscapeSuffix(bytes(''))).toBe(0)
    // A bracket with no ESC before it is just text.
    expect(incompleteEscapeSuffix(bytes('[32m'))).toBe(0)
  })
})

describe('the log views hand back text, not terminal bytes', () => {
  const coloured = (name: string, text: string): string => {
    const path = join(SCRATCH, name)
    writeFileSync(path, text, 'utf8')
    return path
  }

  it('strips the tail a caller reads', () => {
    const path = coloured('tail.log', `plain line\n${SGR}+5639 ~49 -2: a test${RESET}\n`)
    expect(readTailText(path, 10)).toBe('plain line\n+5639 ~49 -2: a test')
  })

  it('counts what it returns, so a filter cannot lie about its own matches', () => {
    const path = coloured(
      'filter.log',
      `${SGR}Tests  2 passed${RESET}\nnoise\n${SGR}Tests  1 failed${RESET}\n`,
    )
    const read = readFiltered(path, /Tests {2}/u, 10)
    expect(read.text).toBe('Tests  2 passed\nTests  1 failed')
    expect(read.log.matched).toBe(2)
    expect(read.log.scannedLines).toBe(3)
  })

  it('matches a pattern that could never match the coloured bytes', () => {
    // The point of stripping before matching: this pattern is anchored on the
    // text, and it is the pattern a caller would naturally write.
    const path = coloured('anchored.log', `${SGR}Tests  197 passed${RESET}\n`)
    expect(readFiltered(path, /^Tests/u, 5).log.matched).toBe(1)
  })
})

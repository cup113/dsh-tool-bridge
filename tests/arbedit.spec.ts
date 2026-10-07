/**
 * The TS port of the ARB cases in `tests/test_toolhub.py`
 * (`ArbInstructionValidationTests` and `ArbEditLibTests`).
 *
 * The fixtures are read exactly as the Python suite reads them, with one
 * addition: the cases that *write* (the old `ArbToolJobTests` did that through
 * the job runner) need somewhere to land, so the tree is copied into
 * `tests/.tmp-arb/` and removed again, the same way the Python jobs tests used
 * `tests/.tmp-arbtool/`. Nothing here ever edits `tests/fixtures/arb/`, and the
 * plan-only cases run against it to prove it stays byte-identical.
 *
 * The contract the Python suite pinned is asserted directly: CRLF survives per
 * file, a CJK value is written as raw UTF-8 rather than `\uXXXX`, a plan that
 * fails leaves zero files touched, an `@key` block stays attached to its key,
 * a delete range is inclusive, and a file named in a value map but absent from
 * the arb-dir is reported as `skipped`.
 */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  applyArbEdits,
  detectLineEnding,
  parseL10nYaml,
  planArbEdits,
  readUntranslated,
  validateInstructions,
} from '../src/engine/arbedit'
import { RefusalError } from '../src/engine/errors'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `tests/fixtures/arb` — read-only, exactly like the Python `ARB_FIXTURES`. */
const FIXTURES = join(HERE, 'fixtures', 'arb')
/** `tests/fixtures` — a real directory with no `l10n.yaml` in it. */
const FIXTURES_ROOT = join(HERE, 'fixtures')
const ARB_DIR = join(FIXTURES, 'lib', 'l10n')
/** The scratch tree: a copy of the fixtures, because an apply has to land somewhere. */
const SCRATCH = join(HERE, '.tmp-arb')
const APPLY = join(SCRATCH, 'apply')
const BARE_PROJECT = join(SCRATCH, 'bare-project')

const APP_FILES = ['app_en.arb', 'app_zh.arb', 'app_zh_Hant.arb'] as const

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
  cpSync(FIXTURES, SCRATCH, { recursive: true })
  // A project whose l10n.yaml carries no untranslated-messages-file: the plan
  // must answer null there rather than inventing a path.
  mkdirSync(join(BARE_PROJECT, 'lib', 'l10n'), { recursive: true })
  writeFileSync(join(BARE_PROJECT, 'l10n.yaml'), 'arb-dir: lib/l10n\n', 'utf8')
  writeFileSync(join(BARE_PROJECT, 'lib', 'l10n', 'app_en.arb'), '{\n  "a": "A"\n}\n', 'utf8')
})

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

/** A minimal valid arb-edit instruction, for the schema cases. */
function instruction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    groups: [
      {
        insertAfter: 'firstKey',
        newFields: [{ key: 'newOne', value: { 'app_en.arb': 'New one' } }],
      },
    ],
    ...overrides,
  }
}

/** A plan over the fixtures, validated first as the tool's own seam does. */
function planFor(instructions: Record<string, unknown>, cwd = FIXTURES) {
  return planArbEdits(cwd, validateInstructions(instructions))
}

/** Every planned file's new bytes, keyed by name. */
function planned(instructions: Record<string, unknown>): Record<string, Uint8Array> {
  return Object.fromEntries(planFor(instructions).files.map((file) => [file.name, file.newBytes]))
}

/** One planned file's new bytes; throws rather than returning undefined. */
function plannedBytes(instructions: Record<string, unknown>, name: string): Buffer {
  const bytes = planned(instructions)[name]
  if (bytes === undefined) throw new Error(`nothing planned for ${name}`)
  return Buffer.from(bytes)
}

/** Byte-exact `app_*.arb` contents as base64, the "nothing was written" oracle. */
function arbSnapshot(cwd: string): Record<string, string> {
  return Object.fromEntries(
    APP_FILES.map((name) => [name, readFileSync(join(cwd, 'lib', 'l10n', name)).toString('base64')]),
  )
}

/** Whether `haystack` carries `needle` as UTF-8 bytes (Python's `assertIn(b"...")`). */
function containsBytes(haystack: Uint8Array, needle: string): boolean {
  return Buffer.from(haystack).includes(Buffer.from(needle, 'utf8'))
}

/** A parsed ARB object, without leaking `any` into the assertions. */
function parseJson(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('not a JSON object')
  }
  return parsed as Record<string, unknown>
}

/** A thrown error, so its class and message can be asserted on. */
function caughtFrom(work: () => void): unknown {
  try {
    work()
  } catch (error) {
    return error
  }
  return undefined
}

describe('validateInstructions', () => {
  const REFUSED: readonly (readonly [unknown, string])[] = [
    [{ cwd: 'D:/elsewhere', groups: [] }, 'pins the working directory'],
    [instruction({ dryrun: true }), 'unknown field'],
    [instruction({ groups: null }), 'non-empty list'],
    [instruction({ groups: [] }), 'non-empty list'],
    [instruction({ groups: ['nope'] }), 'must be an object'],
    [instruction({ dryRun: 'yes' }), 'must be a boolean'],
    [
      instruction({ groups: [{ insertAfter: 'a', deleteFrom: 'b' }] }),
      'deleteFrom and deleteTo must be provided together',
    ],
    [
      instruction({ groups: [{ insertAfter: 'a', deleteFrom: '', deleteTo: 'b' }] }),
      'non-empty strings',
    ],
    [
      instruction({ groups: [{ newFields: [{ key: 'k', value: { 'a.arb': 'v' } }] }] }),
      'insertAfter is required',
    ],
    [
      instruction({ groups: [{ insertAfter: 'a' }] }),
      'needs newFields or a deleteFrom/deleteTo range',
    ],
    [
      instruction({
        groups: [{ insertAfter: 'a', newFields: [{ key: '', value: { 'a.arb': 'v' } }] }],
      }),
      'key must be a non-empty string',
    ],
    [
      instruction({
        groups: [{ insertAfter: 'a', newFields: [{ key: '@meta', value: { 'a.arb': 'v' } }] }],
      }),
      'gen-l10n writes @key',
    ],
    [
      instruction({ groups: [{ insertAfter: 'a', newFields: [{ key: 'k', value: {} }] }] }),
      'non-empty map',
    ],
    [
      instruction({
        groups: [{ insertAfter: 'a', newFields: [{ key: 'k', value: { 'a.arb': 7 } }] }],
      }),
      'must be a string',
    ],
    [
      instruction({
        groups: [{ insertAfter: 'a', newFields: [{ key: 'k', value: 'not-a-map' }] }],
      }),
      'non-empty map',
    ],
    [{ dryRun: false }, 'groups'],
  ]

  it('normalizes a valid instruction', () => {
    const normalized = validateInstructions(instruction())
    expect(normalized.dryRun).toBe(false)
    expect(normalized.groups).toHaveLength(1)
  })

  it('accepts a pure delete without an insertAfter', () => {
    const normalized = validateInstructions({
      groups: [{ deleteFrom: 'gone', deleteTo: 'gone' }],
    })
    expect(normalized.groups[0]?.deleteFrom).toBe('gone')
  })

  it('refuses each bad body with a message naming its field', () => {
    for (const [body, fragment] of REFUSED) {
      const error = caughtFrom(() => validateInstructions(body))
      expect(error, JSON.stringify(body)).toBeInstanceOf(RefusalError)
      expect((error as RefusalError).code, JSON.stringify(body)).toBe(400)
      expect((error as RefusalError).message, JSON.stringify(body)).toContain(fragment)
    }
  })

  it('refuses a non-object body', () => {
    for (const body of [[], 'groups', 7, null]) {
      expect(caughtFrom(() => validateInstructions(body)), JSON.stringify(body)).toBeInstanceOf(
        RefusalError,
      )
    }
  })
})

describe('planArbEdits: line surgery', () => {
  it('inserts after a plain key and keeps the JSON valid', () => {
    const instructions = {
      groups: [
        {
          insertAfter: 'firstKey',
          newFields: [
            { key: 'newOne', value: { 'app_en.arb': 'New one', 'app_zh.arb': '新的一項' } },
          ],
        },
      ],
    }
    const english = plannedBytes(instructions, 'app_en.arb').toString('utf8')
    expect(parseJson(english).newOne).toBe('New one')
    expect(english).toContain('  "firstKey": "First",\n  "newOne": "New one",')
    expect(parseJson(plannedBytes(instructions, 'app_zh.arb').toString('utf8')).newOne).toBe('新的一項')
  })

  it('inserts after a key’s @key metadata block, not inside it', () => {
    const english = Buffer.from(
      plannedBytes(
        {
          groups: [
            { insertAfter: 'withMeta', newFields: [{ key: 'afterMeta', value: { 'app_en.arb': 'x' } }] },
          ],
        },
        'app_en.arb',
      ),
    ).toString('utf8')
    // The @key block stays glued to its key: the new entry follows it.
    expect(english).toContain('  },\n  "afterMeta": "x",\n  "midKey"')
    expect(parseJson(english).afterMeta).toBe('x')
  })

  it('gets the trailing comma right at __END__', () => {
    const english = Buffer.from(
      plannedBytes(
        {
          groups: [
            { insertAfter: '__END__', newFields: [{ key: 'tailKey', value: { 'app_en.arb': 't' } }] },
          ],
        },
        'app_en.arb',
      ),
    ).toString('utf8')
    // The formerly last entry gains a comma; the new last one does not.
    expect(english).toContain('  "lastKey": "Last",\n  "tailKey": "t"\n}')
    expect(parseJson(english).tailKey).toBe('t')
  })

  it('reports both halves of a single-key replacement', () => {
    const plan = planFor({
      groups: [
        {
          insertAfter: 'firstKey',
          deleteFrom: 'midKey',
          deleteTo: 'midKey',
          newFields: [{ key: 'midKey', value: { 'app_en.arb': 'Mid v2' } }],
        },
      ],
    })
    const entry = plan.files[0]
    expect(entry?.inserts).toEqual(['midKey'])
    expect(entry?.deletes).toEqual(['midKey'])
    const parsed = parseJson(Buffer.from(entry?.newBytes ?? []).toString('utf8'))
    expect(parsed.midKey).toBe('Mid v2')
    expect(Object.keys(parsed)).toEqual(['firstKey', 'midKey', 'withMeta', '@withMeta', 'lastKey'])
  })

  it('takes the metadata block along with a deleted range', () => {
    const instructions = {
      groups: [
        {
          insertAfter: 'firstKey',
          deleteFrom: 'withMeta',
          deleteTo: 'midKey',
          // Naming the files explicitly keeps the delete scoped to the two that
          // carry the range (see the global-delete case for what an empty
          // newFields means).
          newFields: [
            { key: 'mergedKey', value: { 'app_en.arb': 'Merged', 'app_zh.arb': '已合并' } },
          ],
        },
      ],
    }
    const plan = planned(instructions)
    const english = Buffer.from(plannedBytes(instructions, 'app_en.arb')).toString('utf8')
    expect(english).not.toContain('@withMeta')
    expect(english).not.toContain('midKey')
    expect(Object.keys(parseJson(english))).toEqual(['firstKey', 'mergedKey', 'lastKey'])
    expect(
      Object.keys(parseJson(plannedBytes(instructions, 'app_zh.arb').toString('utf8'))),
    ).toEqual(['firstKey', 'mergedKey', 'lastKey'])
    expect(Object.keys(plan)).toEqual(['app_en.arb', 'app_zh.arb'])
  })

  it('keeps CRLF files CRLF and writes CJK as raw UTF-8', () => {
    const raw = plannedBytes(
      {
        groups: [
          { insertAfter: 'firstKey', newFields: [{ key: 'cjkKey', value: { 'app_zh.arb': '中文值' } }] },
        ],
      },
      'app_zh.arb',
    )
    expect(containsBytes(raw, '\r\n')).toBe(true)
    const withoutCrlf = raw.toString('latin1').split('\r\n').join('')
    expect(withoutCrlf).not.toContain('\n')
    // The bytes are the UTF-8 of 中文值, never a \uXXXX escape.
    expect(containsBytes(raw, '"cjkKey": "中文值"')).toBe(true)
    const text = raw.toString('utf8')
    expect(text).not.toContain('\\u4e2d')
    expect(parseJson(text).cjkKey).toBe('中文值')
  })

  it('keeps LF files LF', () => {
    const raw = plannedBytes(
      {
        groups: [{ insertAfter: 'firstKey', newFields: [{ key: 'k', value: { 'app_en.arb': 'v' } }] }],
      },
      'app_en.arb',
    )
    expect(containsBytes(raw, '\r\n')).toBe(false)
    expect(detectLineEnding(raw)).toBe('\n')
    expect(detectLineEnding(readFileSync(join(ARB_DIR, 'app_zh.arb')))).toBe('\r\n')
  })

  it('names the file whose anchor is missing, and writes nothing', () => {
    const before = arbSnapshot(FIXTURES)
    const error = caughtFrom(() =>
      planFor({
        groups: [
          {
            insertAfter: 'firstKey',
            deleteFrom: 'midKey',
            deleteTo: 'midKey',
            newFields: [{ key: 'k', value: { 'app_en.arb': 'x', 'app_zh_Hant.arb': 'y' } }],
          },
        ],
      }),
    )
    // A semantic failure is a failed plan, not a 400 refusal.
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(RefusalError)
    expect((error as Error).message).toContain('app_zh_Hant.arb')
    expect((error as Error).message).toContain('midKey')
    expect(arbSnapshot(FIXTURES)).toEqual(before)
  })

  it('skips a file missing from the arb-dir instead of failing', () => {
    const plan = planFor({
      groups: [
        {
          insertAfter: 'firstKey',
          newFields: [{ key: 'k', value: { 'app_en.arb': 'x', 'app_xx.arb': 'y' } }],
        },
      ],
    })
    expect(plan.files.map((entry) => entry.name)).toEqual(['app_en.arb'])
    expect(plan.skipped).toEqual([{ file: 'app_xx.arb', reason: 'not found' }])
  })

  it('targets every app_*.arb file for a pure delete', () => {
    const plan = planFor({ groups: [{ deleteFrom: 'firstKey', deleteTo: 'firstKey' }] })
    expect(plan.files.map((entry) => entry.name)).toEqual([...APP_FILES])
    for (const entry of plan.files) {
      expect(Object.keys(parseJson(Buffer.from(entry.newBytes).toString('utf8')))).not.toContain(
        'firstKey',
      )
    }
  })

  it('fails a global delete that misses one file', () => {
    // An empty newFields means every app_*.arb — so a key only some files have
    // fails the plan instead of half-editing the set.
    const error = caughtFrom(() =>
      planFor({ groups: [{ deleteFrom: 'midKey', deleteTo: 'midKey' }] }),
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('app_zh_Hant.arb')
  })

  it('writes nothing at all', () => {
    const before = arbSnapshot(FIXTURES)
    planFor({
      groups: [{ insertAfter: 'firstKey', newFields: [{ key: 'k', value: { 'app_en.arb': 'x' } }] }],
    })
    expect(arbSnapshot(FIXTURES)).toEqual(before)
  })

  it('names the path when l10n.yaml is missing', () => {
    const error = caughtFrom(() => planFor(instruction(), FIXTURES_ROOT))
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('l10n.yaml not found')
  })
})

describe('parseL10nYaml and the untranslated file', () => {
  it('reads the mini-parser’s shape', () => {
    expect(parseL10nYaml(FIXTURES)).toEqual({
      'arb-dir': 'lib/l10n',
      'template-arb-file': 'app_en.arb',
      'untranslated-messages-file': 'desiredFileName.txt',
    })
  })

  it('resolves untranslatedFile from l10n.yaml, and null when it is absent', () => {
    expect(planFor(instruction()).untranslatedFile).toBe(join(FIXTURES, 'desiredFileName.txt'))
    const plan = planArbEdits(
      BARE_PROJECT,
      validateInstructions({
        groups: [{ insertAfter: 'a', newFields: [{ key: 'b', value: { 'app_en.arb': 'B' } }] }],
      }),
    )
    expect(plan.files.map((entry) => entry.name)).toEqual(['app_en.arb'])
    expect(plan.untranslatedFile).toBeNull()
  })

  it('reads the file only when it carries real content', () => {
    const read = readUntranslated(join(FIXTURES, 'desiredFileName.txt'))
    expect(read?.file).toBe('desiredFileName.txt')
    expect(read?.lines).toBeGreaterThan(0)
    expect(read?.content).toContain('midKey')
    expect(readUntranslated(null)).toBeNull()
    expect(readUntranslated(join(FIXTURES, 'no-such-file.txt'))).toBeNull()
    // gen-l10n sometimes leaves an empty placeholder behind.
    writeFileSync(join(SCRATCH, 'placeholder.txt'), '{}', 'utf8')
    expect(readUntranslated(join(SCRATCH, 'placeholder.txt'))).toBeNull()
    writeFileSync(join(SCRATCH, 'blank.txt'), '\n', 'utf8')
    expect(readUntranslated(join(SCRATCH, 'blank.txt'))).toBeNull()
  })
})

describe('applyArbEdits: the write half', () => {
  it('writes what the plan computed, and only for the named files', () => {
    rmSync(APPLY, { recursive: true, force: true })
    cpSync(FIXTURES, APPLY, { recursive: true })
    const before = arbSnapshot(APPLY)
    const plan = planArbEdits(
      APPLY,
      validateInstructions({
        groups: [
          {
            insertAfter: 'firstKey',
            newFields: [
              { key: 'newOne', value: { 'app_en.arb': 'New one', 'app_zh.arb': '新的一項' } },
            ],
          },
          { insertAfter: 'firstKey', deleteFrom: 'midKey', deleteTo: 'midKey', newFields: [] },
        ],
      }),
    )
    // Planning is pure: the copy on disk is still byte-identical.
    expect(arbSnapshot(APPLY)).toEqual(before)
    // app_zh_Hant.arb is not named in any value map, so it is untouched.
    expect(plan.files.map((entry) => entry.name)).toEqual(['app_en.arb', 'app_zh.arb'])

    expect(applyArbEdits(plan)).toEqual(['app_en.arb', 'app_zh.arb'])
    const english = readFileSync(join(APPLY, 'lib', 'l10n', 'app_en.arb'), 'utf8')
    expect(english).not.toContain('midKey')
    expect(parseJson(english)).toEqual({
      firstKey: 'First',
      newOne: 'New one',
      withMeta: 'With meta {count}',
      '@withMeta': { placeholders: { count: {} } },
      lastKey: 'Last',
    })
    const chinese = readFileSync(join(APPLY, 'lib', 'l10n', 'app_zh.arb'))
    expect(parseJson(chinese.toString('utf8')).newOne).toBe('新的一項')
    expect(containsBytes(chinese, '\r\n')).toBe(true)
    expect(arbSnapshot(APPLY)['app_zh_Hant.arb']).toBe(before['app_zh_Hant.arb'])
  })
})

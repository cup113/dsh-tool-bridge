/**
 * The uncommitted scope, as the retired server's `UncommittedScopeTests` pinned it.
 *
 * The porcelain strings are the ones captured from real git (a modified, a
 * deleted, a renamed, an untracked, an ignored and a staged file), because the
 * rename record is the fact worth pinning: the destination comes first and the
 * source path rides in its own bare record. The refusal strings come from the
 * `/run` route's own cases, checked here at the seam the route used — the route
 * itself has no counterpart in this port.
 *
 * One case drives real git against a scratch repository under
 * `tests/.tmp-scope/` (removed again when the suite ends); every other case
 * injects the reader, so they never shell out.
 */

import { execFile } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { RefusalError, refuse } from '../src/engine/errors'
import {
  parsePorcelain,
  pathFilterRegex,
  runGitStatus,
  scopeMode,
  scopeRefusal,
  uncommittedDartFiles,
} from '../src/engine/scope'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRATCH = join(HERE, '.tmp-scope')
const REPO = join(SCRATCH, 'repo')
/** A directory git cannot run in, exactly like the Python case's `.tmp-scope-not-here`. */
const NOT_HERE = join(HERE, '.tmp-scope-not-here')

/**
 * Captured from `git status --porcelain=v1 -z --untracked-files=all` in a
 * scratch repo holding a modified, a deleted, a renamed, an untracked, an
 * ignored and a staged file.
 */
const PORCELAIN =
  ' M a.dart\0 D c.dart\0R  renamed.dart\0b.dart\0?? untracked.dart\0' +
  '!! ignored.dart\0A  staged.dart\0'

/** The message the route answers an unscopable command with, verbatim. */
const SCOPED_NOTE =
  ' (scoped: dart format — it expands to the uncommitted files;' +
  ' dart/flutter analyze and fix — they filter their output to them)'

/** A rejected promise's reason, so its code and message can be asserted on. */
async function caughtFrom(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  return undefined
}

/** Runs git for the scratch-repository case; setup only, never the code under test. */
function gitRun(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const options = { cwd, encoding: 'utf8' as const, windowsHide: true }
    execFile('git', [...args], options, (error, _stdout, stderr) => {
      if (error === null) {
        resolve()
        return
      }
      reject(new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`))
    })
  })
}

/** A commit in the scratch repo needs an identity; the argv carries one so no config is read. */
const COMMIT_IDENTITY: readonly string[] = [
  '-c', 'user.name=scope spec', '-c', 'user.email=scope@example.invalid',
]

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

describe('parsePorcelain', () => {
  it('selects what exists and is uncommitted', () => {
    expect(parsePorcelain(PORCELAIN)).toEqual([
      'a.dart',
      'renamed.dart',
      'untracked.dart',
      'staged.dart',
    ])
  })

  it('never quotes or escapes a path', () => {
    // `-z` hands over a CJK path as itself, not as \NNN escapes.
    expect(parsePorcelain('?? lib/中文 名字.dart\0')).toEqual(['lib/中文 名字.dart'])
  })

  it('skips a rename source without losing the record after it', () => {
    // The source record is bare: it carries no status, so a parser that did not
    // skip exactly one record would read `b.dart` as a path and lose the `A`
    // entry that follows it.
    expect(parsePorcelain('R  renamed.dart\0b.dart\0A  staged.dart\0')).toEqual([
      'renamed.dart',
      'staged.dart',
    ])
  })
})

describe('uncommittedDartFiles', () => {
  it('scopes only .dart files', async () => {
    expect(await uncommittedDartFiles('unused', async () => PORCELAIN)).toEqual([
      'a.dart',
      'renamed.dart',
      'staged.dart',
      'untracked.dart',
    ])
  })

  it('reads a real repository end to end', async () => {
    rmSync(SCRATCH, { recursive: true, force: true })
    mkdirSync(REPO, { recursive: true })
    await gitRun(REPO, ['init', '--quiet'])
    writeFileSync(join(REPO, 'a.dart'), 'void a() {}\n')
    writeFileSync(join(REPO, 'b.dart'), 'void b() {}\n')
    writeFileSync(join(REPO, 'c.dart'), 'void c() {}\n')
    writeFileSync(join(REPO, '.gitignore'), 'ignored.dart\n')
    await gitRun(REPO, ['add', '.'])
    await gitRun(REPO, [...COMMIT_IDENTITY, 'commit', '--quiet', '-m', 'init'])
    // Now the six shapes the captured porcelain above holds: modified, deleted,
    // renamed, untracked, ignored and staged.
    writeFileSync(join(REPO, 'a.dart'), 'void a() { /* changed */ }\n')
    rmSync(join(REPO, 'c.dart'))
    await gitRun(REPO, ['mv', 'b.dart', 'renamed.dart'])
    writeFileSync(join(REPO, 'untracked.dart'), 'void untracked() {}\n')
    writeFileSync(join(REPO, 'staged.dart'), 'void staged() {}\n')
    await gitRun(REPO, ['add', 'staged.dart'])
    writeFileSync(join(REPO, 'ignored.dart'), 'void ignored() {}\n')
    writeFileSync(join(REPO, 'notes.md'), 'not a dart file\n')

    const expected = ['a.dart', 'renamed.dart', 'staged.dart', 'untracked.dart']
    const porcelain = parsePorcelain(await runGitStatus(REPO))
    expect([...porcelain].sort()).toEqual([
      'a.dart',
      'notes.md',
      'renamed.dart',
      'staged.dart',
      'untracked.dart',
    ])
    // The rename destination is what git reports, a deleted path stays out, and
    // an ignored file is not a path git was asked about.
    expect(porcelain).not.toContain('b.dart')
    expect(porcelain).not.toContain('c.dart')
    expect(porcelain).not.toContain('ignored.dart')
    expect(await uncommittedDartFiles(REPO)).toEqual(expected)
  })

  it('refuses when git cannot answer', async () => {
    // A directory git cannot run in is an error, never an empty scope.
    const error = await caughtFrom(uncommittedDartFiles(NOT_HERE))
    expect(error).toBeInstanceOf(RefusalError)
    expect((error as RefusalError).code).toBe(400)
    expect((error as RefusalError).message.startsWith('git status could not run:')).toBe(true)
  })

  it('reports the refusal git gives outside a repository', async () => {
    const error = await caughtFrom(uncommittedDartFiles(tmpdir()))
    expect(error).toBeInstanceOf(RefusalError)
    expect((error as RefusalError).code).toBe(400)
    expect((error as RefusalError).message).toContain(
      'git status failed (exit 128): fatal: not a git repository',
    )
  })

  it('passes a git failure through unchanged', async () => {
    // The route answered this 400 with git's message, so the caller is told to
    // drop the scope rather than handed an empty one.
    const failure = 'git status failed (exit 128): fatal: not a git repository'
    const error = await caughtFrom(
      uncommittedDartFiles('unused', async () => {
        refuse(400, failure)
      }),
    )
    expect(error).toBeInstanceOf(RefusalError)
    expect((error as RefusalError).code).toBe(400)
    expect((error as RefusalError).message).toContain('not a git repository')
  })
})

describe('scopeMode', () => {
  it('expands dart format', () => {
    expect(scopeMode('dart', ['format', 'lib'])).toBe('expand')
  })

  it('filters analyze and fix for both commands', () => {
    for (const [cmd, verb] of [
      ['dart', 'analyze'],
      ['flutter', 'analyze'],
      ['dart', 'fix'],
      ['flutter', 'fix'],
    ] as const) {
      expect(scopeMode(cmd, [verb]), `${cmd} ${verb}`).toBe('filter')
    }
  })

  it('cannot scope anything else', () => {
    for (const [cmd, verb] of [
      ['dart', 'test'],
      ['flutter', 'test'],
      ['dart', 'pub'],
      ['git', 'status'],
    ] as const) {
      expect(scopeMode(cmd, [verb]), `${cmd} ${verb}`).toBeNull()
    }
    expect(scopeMode('dart', [])).toBeNull()
  })
})

describe('scopeRefusal', () => {
  it('names what is scoped instead', () => {
    expect(scopeRefusal('dart', ['test'])).toBe(
      'scope is not supported for dart test' + SCOPED_NOTE,
    )
  })

  it('drops a verb that is not there rather than leaving a trailing space', () => {
    expect(scopeRefusal('dart', [])).toBe('scope is not supported for dart' + SCOPED_NOTE)
  })

  it('is the 403 an unscopable command is refused with', () => {
    for (const [cmd, args] of [
      ['git', ['status']],
      ['dart', ['test']],
      ['flutter', ['test']],
    ] as const) {
      expect(scopeMode(cmd, args), `${cmd} ${args.join(' ')}`).toBeNull()
      const error = (() => {
        try {
          refuse(403, scopeRefusal(cmd, args))
        } catch (thrown) {
          return thrown
        }
        return undefined
      })()
      expect(error).toBeInstanceOf(RefusalError)
      expect((error as RefusalError).code).toBe(403)
      expect((error as RefusalError).message).toContain('scope is not supported')
    }
  })
})

describe('pathFilterRegex', () => {
  it('matches paths, not prefixes', () => {
    const pattern = pathFilterRegex(['lib/a.dart', 'test/b_test.dart'])
    expect(pattern.test('   info • unused • lib/a.dart:3:1')).toBe(true)
    expect(pattern.test('   info • unused • lib/ab.dart:3:1')).toBe(false)
  })

  it('treats a path as data, not as a pattern', () => {
    const pattern = pathFilterRegex(['lib/a.dart'])
    expect(pattern.test('lib/a.dart')).toBe(true)
    // Unescaped, `.` would match the `X` here and blame an unrelated file.
    expect(pattern.test('lib/aXdart')).toBe(false)
  })
})

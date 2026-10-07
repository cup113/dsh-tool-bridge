import { describe, expect, it } from 'vitest'
import { RefusalError } from '../src/engine/errors'
import { SCRIPT_BINARIES } from '../src/engine/surface'
import { buildArgv, validate } from '../src/engine/validate'

/**
 * The refusal a call makes, read the way the model would.
 *
 * Every refusal in `validate`/`buildArgv` answered 403 at the retired route —
 * both are reached only through `ToolHub.submit`, inside the `/run` handler's
 * `except ValueError` branch — so the code is asserted here once instead of in
 * every case, which is also what keeps the ported message fragments honest.
 */
function refusal(run: () => void): string {
  try {
    run()
  } catch (error) {
    if (error instanceof RefusalError) {
      expect(error.code).toBe(403)
      return error.message
    }
    throw error
  }
  throw new Error('expected a refusal')
}

describe('git restore guard (RestoreGuardTests)', () => {
  // `git restore` is allowed only for literal paths inside the worktree.
  const ALLOWED: string[][] = [
    ['git', 'restore', '--', 'lib/a.dart', 'test/b_test.dart'],
    ['git', 'restore', 'lib/a.dart'],
    ['git', 'restore', '-q', 'lib/a.dart'],
    ['git', 'restore', '--staged', 'lib/a.dart'],
    ['git', 'restore', '-S', '-W', 'lib/a.dart'],
    ['git', 'restore', '-SW', 'lib/a.dart'],
    ['git', 'restore', '--no-staged', 'lib/a.dart'],
    ['git', 'restore', '--', 'test/desktop/-leading-dash.dart'],
  ]

  // argv -> (required fragment of the refusal, canary token that must survive)
  const REFUSED: ReadonlyArray<readonly [string[], string, string | null]> = [
    [['git', 'restore'], 'at least one explicit path', null],
    [['git', 'restore', '--'], 'at least one explicit path', null],
    [['git', 'restore', '.'], 'must name files inside', null],
    [['git', 'restore', './'], 'must name files inside', null],
    [['git', 'restore', 'canary-parent/../lib/a.dart'], 'canary-parent', 'canary-parent'],
    [['git', 'restore', 'canary-wild/*.dart'], 'canary-wild', 'canary-wild'],
    [['git', 'restore', 'canary-glob/**'], 'canary-glob', 'canary-glob'],
    [['git', 'restore', 'canary-q?.dart'], 'canary-q', 'canary-q'],
    [['git', 'restore', ':canary-magic'], 'canary-magic', 'canary-magic'],
    [['git', 'restore', ':/'], 'pathspec magic', null],
    [['git', 'restore', 'D:/canary-abs/a.dart'], 'canary-abs', 'canary-abs'],
    [['git', 'restore', '/canary-root/a.dart'], 'must be relative', 'canary-root'],
    [['git', 'restore', '--pathspec-from-file=canary-list.txt'], 'canary-list', 'canary-list'],
    [['git', 'restore', '--pathspec-file-nul', 'lib/a.dart'], 'not allowed', null],
    [['git', 'restore', '-s', 'HEAD~1', 'lib/a.dart'], 'not allowed', null],
    [['git', 'restore', '--source=HEAD~1', 'lib/a.dart'], 'not allowed', null],
    [['git', 'restore', '-p', 'lib/a.dart'], 'not allowed', null],
    [['git', 'restore', '--recurse-submodules', 'lib/a.dart'], 'not allowed', null],
    [['git', 'restore', '--merge', 'lib/a.dart'], 'not allowed', null],
    [['git', 'restore', '--conflict=diff3', 'lib/a.dart'], 'not allowed', null],
  ]

  it('allows the documented forms', () => {
    for (const argv of ALLOWED) {
      validate([...argv])
    }
  })

  it('refuses the forms that would name work the caller did not', () => {
    for (const [argv, fragment, canary] of REFUSED) {
      const message = refusal(() => validate([...argv]))
      expect(message, `argv=${JSON.stringify(argv)}`).toContain(fragment)
      if (canary !== null) {
        expect(message, `argv=${JSON.stringify(argv)}`).toContain(canary)
      }
    }
  })

  it('keeps the destructive verbs out', () => {
    for (const verb of ['reset', 'clean', 'checkout', 'switch', 'stash', 'push']) {
      refusal(() => validate(['git', verb, '--', 'lib/a.dart']))
    }
  })

  it('names the substitute in the checkout refusal', () => {
    const message = refusal(() => validate(['git', 'checkout', '--', 'lib/a.dart']))
    expect(message).toContain('git restore --')
  })

  it('still refuses a branch delete', () => {
    refusal(() => validate(['git', 'branch', '-D', 'feature']))
  })

  it('is not bypassed by a glob', () => {
    // The guard would be vacuous if a pattern slipped through.
    refusal(() => validate(['git', 'restore', '*']))
  })
})

describe('inline commit message (CommitMessageTests)', () => {
  // "message" is folded in as argv, so no temp file ever exists.
  it('folds the message in as -m', () => {
    const argv = buildArgv('git', ['commit', '--amend'], 'slice 2: 中文')
    expect(argv).toEqual(['git', 'commit', '-m', 'slice 2: 中文', '--amend'])
    validate(argv)
  })

  it('keeps a multiline message whole', () => {
    const body = 'subject line\n\nbody paragraph'
    const argv = buildArgv('git', ['commit'], body)
    expect(argv[3]).toBe(body)
  })

  it('leaves argv alone without a message', () => {
    expect(buildArgv('git', ['commit', '-m', 'x'], null)).toEqual(['git', 'commit', '-m', 'x'])
  })

  it('refuses a message without a git commit', () => {
    for (const args of [['status'], ['add', '-A'], ['', 'commit']]) {
      refusal(() => buildArgv('git', args, 'nope'))
    }
    refusal(() => buildArgv('flutter', ['test'], 'nope'))
  })

  it('refuses a message beside a message flag', () => {
    for (const token of ['-m', '--message=x', '-F', '--file=msg.txt']) {
      refusal(() => buildArgv('git', ['commit', token], 'inline'))
    }
  })

  it('refuses an empty message', () => {
    for (const message of ['', '   ', '\n']) {
      refusal(() => buildArgv('git', ['commit'], message))
    }
  })

  it('refuses a commit with no message at all', () => {
    const message = refusal(() => validate(['git', 'commit']))
    expect(message).toContain('message')
  })

  it('still allows the message sources git has', () => {
    for (const token of ['-m', '--message', '-F', '--file', '--reuse-message']) {
      validate(['git', 'commit', token])
    }
  })
})

describe('pnpm surface (PnpmSurfaceTests)', () => {
  const ALLOWED: string[][] = [
    ['pnpm', 'install'],
    ['pnpm', 'install', '--no-frozen-lockfile'],
    ['pnpm', 'add', '-D', 'svelte'],
    ['pnpm', 'update'],
    ['pnpm', 'run', 'build'],
    ['pnpm', 'run', 'dev', '--', '--host'],
    ['pnpm', 'exec', 'vitest', 'run', '--pool=threads'],
    ['pnpm', 'exec', '--', 'vitest', 'run'],
    ['pnpm', 'why', 'svelte'],
  ]

  const REFUSED: string[][] = [
    ['pnpm'],
    ['pnpm', '--version'],
    ['pnpm', 'publish'],
    ['pnpm', 'dlx', 'create-svelte'],
    ['pnpm', 'store', 'prune'],
    ['pnpm', '-C', 'elsewhere', 'run', 'build'],
    ['pnpm', 'install', '--prefix', 'elsewhere'],
    ['pnpm', 'install', '-g', 'typescript'],
    ['pnpm', 'run', 'build', '-w'],
    ['pnpm', 'exec', 'node', '--version'],
    ['pnpm', 'exec', 'cmd', '/c', 'echo hi'],
    ['pnpm', 'exec', './node_modules/.bin/vitest', 'run'],
    ['pnpm', 'exec', '-c', 'vitest run'],
    ['pnpm', 'exec'],
  ]

  it('allows the documented forms', () => {
    for (const argv of ALLOWED) {
      validate([...argv])
    }
  })

  it('refuses everything else', () => {
    for (const argv of REFUSED) {
      refusal(() => validate([...argv]))
    }
  })

  it('says what a retargeting flag would have done', () => {
    // The refusal has to read as "run somewhere else", not as a typo.
    for (const argv of [
      ['pnpm', '-C', 'elsewhere', 'install'],
      ['pnpm', 'install', '--prefix=elsewhere'],
      ['pnpm', 'install', '-g', 'typescript'],
    ]) {
      const message = refusal(() => validate([...argv]))
      expect(message, `argv=${JSON.stringify(argv)}`).toContain('pinned')
    }
  })

  it('names the substitute for an exec target outside the tool set', () => {
    const message = refusal(() => validate(['pnpm', 'exec', 'node', '-e', '1']))
    expect(message).toContain('pnpm run')
  })

  it('treats the script binaries as commands of their own', () => {
    for (const name of [...SCRIPT_BINARIES].sort()) {
      validate([name, '--version'])
    }
  })

  it('lists what is allowed for an unknown command', () => {
    // The refusal has to name the surface, so a typo is self-correcting.
    const message = refusal(() => validate(['yarn', 'install']))
    for (const name of ['npm', 'pnpm', 'vitest']) {
      expect(message).toContain(name)
    }
  })
})

describe('npm surface (NpmSurfaceTests)', () => {
  // `npm` is a package manager on the same terms as `pnpm`, plus its own two.
  //
  // What is npm-specific here, and why each is asserted:
  //
  // - `test`/`start` are the only bare-script shorthands npm itself has; they
  //   must be normalised to `run <script>`, not accepted as verbs of their own,
  //   or the long-lane guess and the digest would read a different argv.
  // - `--location=global` is refused while `--location=project` is not: the flag
  //   is the one blocked flag whose *value* decides, so a guard that only looked
  //   at the flag's name would be wrong in one of the two directions.
  // - `npx` is an exec form, not a manager: it has no verbs, so `npx install`
  //   must fail the same way `npx cow` does.
  const ALLOWED: string[][] = [
    ['npm', 'install'],
    ['npm', 'ci'],
    ['npm', 'install', '--no-audit', '--no-fund'],
    ['npm', 'add', '-D', 'svelte'],
    ['npm', 'update'],
    ['npm', 'run', 'build'],
    ['npm', 'run', 'dev', '--', '--host'],
    ['npm', 'exec', 'vitest', 'run', '--pool=threads'],
    ['npm', 'exec', '--', 'vitest', 'run'],
    ['npm', 'why', 'svelte'],
    ['npm', 'install', '--location=project'],
    ['npx', 'vitest', 'run'],
    ['npx', '--', 'vite', 'build'],
  ]

  const REFUSED: string[][] = [
    ['npm'],
    ['npm', '--version'],
    ['npm', 'publish'],
    ['npm', 'config', 'get', 'registry'],
    ['npm', 'init', '-y'],
    ['npm', 'link'],
    ['npm', 'unlink'],
    ['npm', 'cache', 'clean', '--force'],
    ['npm', 'install', '--prefix', 'elsewhere'],
    ['npm', 'install', '--prefix=elsewhere'],
    ['npm', 'install', '-C', 'elsewhere'],
    ['npm', 'install', '-Celsewhere'],
    ['npm', 'install', '-g', 'typescript'],
    ['npm', 'install', '--global', 'typescript'],
    ['npm', 'install', '--location=global'],
    ['npm', 'install', '--location', 'global'],
    ['npm', 'test', '-w', 'app'],
    ['npm', 'install', '--workspace', 'app'],
    ['npm', 'exec', 'node', '--version'],
    ['npm', 'exec', 'cmd', '/c', 'echo hi'],
    ['npm', 'exec'],
    ['npx', 'cowsay'],
    ['npx', '--yes', 'cowsay'],
    ['npx', '--package', 'left-pad', 'cowsay'],
    ['npx', '-p', 'left-pad', 'cowsay'],
    ['npx', '-c', 'echo hi'],
    ['npx'],
    ['npx', 'install'],
  ]

  it('allows the documented forms', () => {
    for (const argv of ALLOWED) {
      validate([...argv])
    }
  })

  it('refuses everything else', () => {
    for (const argv of REFUSED) {
      refusal(() => validate([...argv]))
    }
  })

  it('normalises the shorthands rather than accepting them as verbs', () => {
    // `npm test` is `npm run test` by the time anything reads the argv.
    const cases: ReadonlyArray<readonly [string[], string[]]> = [
      [['npm', 'test'], ['npm', 'run', 'test']],
      [['npm', 'start'], ['npm', 'run', 'start']],
      [['npm', 'start', '--', '--host'], ['npm', 'run', 'start', '--', '--host']],
      [['npm', 'test', '--', '--coverage'], ['npm', 'run', 'test', '--', '--coverage']],
    ]
    for (const [argv, want] of cases) {
      const normalised = [...argv]
      validate(normalised)
      expect(normalised, `argv=${JSON.stringify(argv)}`).toEqual(want)
    }
  })

  it('treats only npm\'s own two names as shorthands', () => {
    // `npm build` is not a thing npm understands, so it is not a verb here.
    const message = refusal(() => validate(['npm', 'build']))
    expect(message).toContain('npm verb not allowed')
  })

  it('judges --location by its value', () => {
    // The value-dependent guard has to fail in exactly one direction.
    validate(['npm', 'install', '--location=project'])
    for (const argv of [
      ['npm', 'install', '--location=global'],
      ['npm', 'install', '--location', 'global'],
      ['npm', 'install', '--location=user'],
    ]) {
      const message = refusal(() => validate([...argv]))
      expect(message, `argv=${JSON.stringify(argv)}`).toContain('--location')
    }
  })

  it('leaves a flag after the separator to the script', () => {
    // `--` ends the manager's surface; `npm run build -- --prefix x` is fine.
    validate(['npm', 'run', 'build', '--', '--prefix', 'webpack-thing'])
  })

  it('says what a retargeting flag would have done', () => {
    for (const argv of [
      ['npm', 'install', '--prefix', 'elsewhere'],
      ['npm', 'install', '-C', 'elsewhere'],
      ['npm', 'install', '-g', 'typescript'],
      ['npm', 'install', '--workspace', 'app'],
      ['pnpm', 'install', '--workspace', 'app'],
    ]) {
      const message = refusal(() => validate([...argv]))
      expect(message, `argv=${JSON.stringify(argv)}`).toContain('pinned')
    }
  })

  it('names the substitute for an exec target outside the tool set', () => {
    const cases: ReadonlyArray<readonly [string[], string]> = [
      [['npm', 'exec', 'node', '-e', '1'], 'npm run'],
      [['npx', 'cowsay'], 'npm run'],
      [['pnpm', 'exec', 'node', '-e', '1'], 'pnpm run'],
    ]
    for (const [argv, substitute] of cases) {
      const message = refusal(() => validate([...argv]))
      expect(message, `argv=${JSON.stringify(argv)}`).toContain(substitute)
    }
  })

  it('keeps pnpm\'s own refusal wording', () => {
    // Two managers, one guard — but a refusal always names which one.
    const message = refusal(() => validate(['pnpm', 'install', '-g', 'typescript']))
    expect(message.startsWith('pnpm flag not allowed')).toBe(true)
  })
})

/**
 * The launcher slice's self-tests, ported from `tests/test_toolhub.py`.
 *
 * The Python suite patched `shutil.which` with a lookup table so the wrapper
 * layouts found in the wild (nvm4w, corepack, Node's own npm) could be faked
 * without touching the machine's install tree. Here the lookup is a parameter
 * (see `WhichFn`), which is the same idea without monkey-patching a module: a
 * test that leaked through to the real npm/node would pass without its own
 * fixture, and the NpmLaunchTests comment in the Python file records that
 * happening.
 *
 * Scratch trees live under `tests/.tmp-resolve/` and are removed at the end.
 * The `dart format` pin needs a real file to point at, because `resolveLaunch`
 * checks it rather than trusting it.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { ToolFailure } from '../src/engine/errors'
import type { WhichFn } from '../src/engine/resolve'
import {
  dartFormatTarget,
  nodeEntryFromShim,
  resolveLaunch,
  resolvePackageManager,
  resolvePnpm,
  wantsLongLane,
} from '../src/engine/resolve'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRATCH = join(HERE, '.tmp-resolve')

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

/**
 * `shutil.which` as a lookup table: a name that is not in it is not on this
 * machine. Deliberately no fallback to the real `PATH`.
 */
function patchedWhich(mapping: Record<string, string | null>): WhichFn {
  return (name) => mapping[name] ?? null
}

/** Writes a file, creating its parent directories, and returns the path. */
function writeFile(path: string, contents = ''): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents, 'utf8')
  return path
}

/**
 * A fake installed package, laid out the way pnpm leaves it.
 *
 * `entry` is created inside the package directory; null skips creating it, which
 * is how a `bin` field pointing outside the package is set up.
 */
function writePackage(
  root: string,
  packageName: string,
  binField: unknown,
  entry: string | null,
  source = '// fake\n',
): string {
  const packageDir = join(root, 'node_modules', ...packageName.split('/'))
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: packageName, bin: binField }),
    'utf8',
  )
  if (entry === null) return packageDir
  return writeFile(join(packageDir, entry), source)
}

describe('dart format pin', () => {
  const PIN = 'D:\\pinned\\dart.exe'
  const PIN_SCRATCH = join(SCRATCH, 'pin')

  it('routes only a `dart format` job', () => {
    for (const argv of [
      ['dart', 'format'],
      ['dart', 'format', 'lib'],
      ['dart', 'format', '--output=none', '--set-exit-if-changed', 'lib/a.dart'],
      ['D:\\flutter\\bin\\dart.bat', 'format', 'lib'],
      ['dart.exe', 'format'],
    ]) {
      expect(dartFormatTarget(argv, PIN)).toBe(PIN)
    }
    // Everything else keeps the PATH toolchain on purpose: `dart analyze`/`test`/
    // `pub` and every `flutter` command must match the SDK installed here.
    for (const argv of [
      ['dart'],
      ['dart', 'analyze', 'lib'],
      ['dart', 'test'],
      ['dart', 'pub', 'get'],
      ['dart', 'run', 'tool/generate.dart'],
      ['dart', '--version'],
      ['flutter', 'format', 'lib'],
      ['git', 'status'],
    ]) {
      expect(dartFormatTarget(argv, PIN)).toBeNull()
    }
  })

  it('routes nothing without a pin', () => {
    expect(dartFormatTarget(['dart', 'format'], null)).toBeNull()
  })

  it('swaps in the pin at launch', () => {
    const fake = writeFile(join(PIN_SCRATCH, 'dart.exe'))
    const launch = resolveLaunch(['dart', 'format', '--output=none', 'lib/a.dart'], fake)
    expect(launch.argv).toEqual([fake, 'format', '--output=none', 'lib/a.dart'])
    // A standalone dart is a real executable: no `.bat` unwrapping, and no
    // FLUTTER_ROOT to add.
    expect(launch.env).toEqual({})
  })

  it('fails loudly when the pin is missing', () => {
    // Falling back to the PATH dart would be the bug the pin prevents.
    const gone = join(PIN_SCRATCH, 'gone.exe')
    expect(() => resolveLaunch(['dart', 'format', 'lib'], gone)).toThrow(
      'pinned dart format executable is missing',
    )
  })
})

describe('long-lane detection', () => {
  // Which commands are expected to run until they are killed.
  const LONG: [string, string[]][] = [
    ['vite', []],
    ['vite', ['dev']],
    ['vite', ['serve']],
    ['vite', ['preview']],
    ['vite', ['dev', '--port', '5199']],
    ['vitest', []],
    ['vitest', ['--pool=threads']],
    ['vitest', ['watch']],
    ['pnpm', ['run', 'dev']],
    ['pnpm', ['run', 'start', '--', '--host']],
    ['pnpm', ['exec', 'vite', 'dev']],
    ['pnpm', ['exec', 'vitest']],
    // The npm spellings, including the normalised shorthands: `npm start` is
    // passed the way `ToolHub.submit` passes it, i.e. already `run start`.
    ['npm', ['run', 'dev']],
    ['npm', ['run', 'start', '--', '--host']],
    ['npm', ['run', 'serve']],
    ['npm', ['exec', 'vite', 'dev']],
    ['npm', ['exec', 'vitest']],
    ['npx', ['vite']],
    ['npx', ['vite', 'dev']],
    ['npx', ['vitest']],
  ]

  const SHORT: [string, string[]][] = [
    ['vite', ['build']],
    ['vite', ['--version']],
    ['vite', ['optimize']],
    ['vitest', ['run']],
    ['vitest', ['--run']],
    ['vitest', ['run', '--pool=threads']],
    ['vitest', ['--version']],
    ['pnpm', ['install']],
    ['pnpm', ['run', 'build']],
    ['pnpm', ['run', 'test']],
    ['pnpm', ['exec', 'vitest', 'run']],
    ['npm', ['install']],
    ['npm', ['ci']],
    ['npm', ['run', 'build']],
    ['npm', ['run', 'test']],
    ['npm', ['exec', 'vitest', 'run']],
    ['npm', ['exec', 'vite', 'build']],
    ['npm', ['test']],
    ['npx', ['vitest', 'run']],
    ['npx', ['vite', 'build']],
    ['npx', ['--version']],
    ['svelte-check', ['--tsconfig', './tsconfig.json']],
    ['flutter', ['test']],
  ]

  it('long shapes', () => {
    for (const [cmd, args] of LONG) {
      expect(wantsLongLane(cmd, args)).toBe(true)
    }
  })

  it('short shapes', () => {
    for (const [cmd, args] of SHORT) {
      expect(wantsLongLane(cmd, args)).toBe(false)
    }
  })
})

describe('script binary launch', () => {
  // A script binary runs as `node <pkg>/<bin>`, out of the pinned cwd.
  const ROOT = join(SCRATCH, 'project')
  const NODE = join(ROOT, 'node.EXE')
  const which = patchedWhich({ node: NODE })

  beforeAll(() => {
    mkdirSync(ROOT, { recursive: true })
    writeFile(NODE)
  })

  beforeEach(() => {
    rmSync(join(ROOT, 'node_modules'), { recursive: true, force: true })
  })

  it('resolves a `bin` declared as an object', () => {
    const target = writePackage(ROOT, 'vite', { vite: 'bin/vite.js' }, 'bin/vite.js')
    const launch = resolveLaunch(['vite', 'build'], null, ROOT, which)
    expect(launch.argv).toEqual([NODE, target, 'build'])
    expect(launch.env).toEqual({})
  })

  it('resolves a `bin` declared as a string', () => {
    const target = writePackage(ROOT, 'vitest', './vitest.mjs', 'vitest.mjs')
    const launch = resolveLaunch(['vitest', 'run'], null, ROOT, which)
    expect(launch.argv[1]).toBe(target)
  })

  it('resolves a command whose package is named differently', () => {
    const target = writePackage(
      ROOT,
      'typescript',
      { tsc: './bin/tsc', tsserver: './bin/tsserver' },
      'bin/tsc',
    )
    const launch = resolveLaunch(['tsc', '--noEmit'], null, ROOT, which)
    expect(launch.argv[1]).toBe(target)
  })

  it('resolves a scoped package', () => {
    const target = writePackage(
      ROOT,
      '@sveltejs/kit',
      { 'svelte-kit': 'src/cli.js' },
      'src/cli.js',
    )
    const launch = resolveLaunch(['svelte-kit', 'sync'], null, ROOT, which)
    expect(launch.argv[1]).toBe(target)
  })

  it('names the manifest of a package that is not installed', () => {
    expect(() => resolveLaunch(['vite', 'build'], null, ROOT, which)).toThrow('node_modules')
  })

  it('refuses a `bin` entry escaping its package', () => {
    writePackage(ROOT, 'vite', { vite: '../../../outside.js' }, null)
    expect(() => resolveLaunch(['vite', 'build'], null, ROOT, which)).toThrow(
      'outside its package',
    )
  })

  it('searches the pinned cwd and nothing else', () => {
    // A package next to *this* test file must not be picked up.
    writePackage(ROOT, 'vite', { vite: 'bin/vite.js' }, 'bin/vite.js')
    expect(() => resolveLaunch(['vite', 'build'], null, HERE, which)).toThrow(ToolFailure)
  })
})

describe('pnpm launch', () => {
  // `pnpm` on PATH is a wrapper, so its JavaScript entry is launched.
  const ROOT = join(SCRATCH, 'pnpm')
  const NODE = join(ROOT, 'node.EXE')
  const ENTRY = join(ROOT, 'nvm4w', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
  const WRAPPER = join(ROOT, 'nvm4w', 'pnpm.CMD')
  const COREPACK_ENTRY = join(ROOT, 'corepack', 'node_modules', 'corepack', 'dist', 'pnpm.js')
  const COREPACK_WRAPPER = join(ROOT, 'corepack', 'pnpm.CMD')
  const STANDALONE = join(ROOT, 'standalone', 'pnpm.exe')

  // `node` is pinned for the same reason the npm tests pin it: without it, a
  // resolve that fell through to the Node-install probe would answer with the
  // machine's own npm entry and the two layout tests below would pass without
  // ever touching their fixture — which is what they used to do.
  const which = patchedWhich({ node: NODE, pnpm: WRAPPER })

  beforeAll(() => {
    writeFile(NODE)
    writeFile(ENTRY, '// pnpm\n')
    writeFile(
      WRAPPER,
      '@ECHO off\nendLocal & "%_prog%"  "%dp0%\\node_modules\\pnpm\\bin\\pnpm.mjs" %*\n',
    )
    // A corepack-managed install keeps pnpm elsewhere: only the wrapper names
    // the entry point, which is what the shim reader is for.
    writeFile(COREPACK_ENTRY, '// corepack pnpm\n')
    writeFile(COREPACK_WRAPPER, '@ECHO off\nnode "%dp0%\\node_modules\\corepack\\dist\\pnpm.js" %*\n')
    writeFile(STANDALONE)
  })

  it('resolves the usual layout', () => {
    expect(resolvePnpm(which)).toEqual([NODE, ENTRY])
  })

  it('reads a wrapper that only names its own entry', () => {
    const corepackWhich = patchedWhich({ node: NODE, pnpm: COREPACK_WRAPPER })
    expect(resolvePnpm(corepackWhich)).toEqual([NODE, COREPACK_ENTRY])
  })

  it('uses a standalone pnpm.exe as it is', () => {
    expect(resolvePnpm(patchedWhich({ node: NODE, pnpm: STANDALONE }))).toEqual([STANDALONE])
  })

  it('fails when pnpm is not on PATH', () => {
    expect(() => resolvePnpm(patchedWhich({ node: NODE, pnpm: null }))).toThrow(ToolFailure)
  })

  it('fails when a wrapper names no findable entry', () => {
    const orphan = writeFile(join(ROOT, 'orphan', 'pnpm.CMD'), '@ECHO off\necho nothing to see\n')
    expect(() => resolvePnpm(patchedWhich({ node: NODE, pnpm: orphan }))).toThrow(ToolFailure)
  })

  it('launches node plus the entry for a job', () => {
    const launch = resolveLaunch(['pnpm', 'run', 'build'], null, null, which)
    expect(launch.argv).toEqual([NODE, ENTRY, 'run', 'build'])
  })
})

describe('npm launch', () => {
  /**
   * `npm`/`npx` on PATH are wrappers, and the entry they run is not the last path
   * they mention.
   *
   * Node's own `npm.cmd` names `node_modules\npm\bin\npm-prefix.js` (a helper it
   * shells out to first) and `node_modules\npm\bin\npm-cli.js` (the entry it
   * runs), and the fallback assignment naming the helper comes last — so a reader
   * that took the last mention by position would launch the prefix printer
   * instead of npm.
   *
   * Every test here pins `node` as well as the wrapper, and that is load-bearing
   * rather than tidy. `resolvePackageManager` probes the Node installation for
   * npm's entry (Node ships npm inside itself), so a test that pinned only `npm`
   * would resolve through the machine's real Node and pass without the fixture —
   * the assertions would be vacuous, which is exactly what happened before
   * `nodeExe` was pinned here.
   */
  const ROOT = join(SCRATCH, 'npm')
  const NODE_DIR = join(ROOT, 'npm-node')
  const NPM_CLI = join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const NPX_CLI = join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npx-cli.js')
  const NPM_PREFIX = join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npm-prefix.js')
  const FAKE_NODE = join(NODE_DIR, 'node.EXE')
  const WRAPPER = join(NODE_DIR, 'npm.CMD')
  const NPX_WRAPPER = join(NODE_DIR, 'npx.CMD')

  const whichExtra = { node: FAKE_NODE }

  const npmWrapperText =
    [
      ":: Created by npm, please don't edit manually.",
      '@ECHO OFF',
      'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
      'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
      `FOR /F "delims=" %%F IN ('CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"') DO (`,
      '  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"',
      ')',
      'IF EXIST "%NPM_PREFIX_NPM_CLI_JS%" (',
      '  SET "NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%"',
      ')',
      '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
    ].join('\r\n') + '\r\n'

  beforeAll(() => {
    writeFile(FAKE_NODE)
    writeFile(NPM_CLI, '// npm cli\n')
    writeFile(NPX_CLI, '// npx cli\n')
    // Present on purpose. A shim reader that took the last path by position
    // would pick *this* one up, because the fallback assignment that names it is
    // the last mention in the file — so its existence is what makes the ordering
    // assertion mean something.
    writeFile(NPM_PREFIX, '// npm prefix helper\n')
    writeFile(WRAPPER, npmWrapperText)
    writeFile(NPX_WRAPPER, '@ECHO OFF\r\nSET "NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js"\r\n"%NODE_EXE%" "%NPX_CLI_JS%" %*\r\n')
  })

  it('resolves the real npm wrapper to its cli and not its prefix helper', () => {
    // Both candidates are on disk, so only the ordering rule can separate them —
    // which is the point of the fixture.
    expect(resolvePackageManager('npm', patchedWhich({ ...whichExtra, npm: WRAPPER }))).toEqual([
      FAKE_NODE,
      NPM_CLI,
    ])
  })

  it('resolves npx to its own entry', () => {
    expect(
      resolvePackageManager('npx', patchedWhich({ ...whichExtra, npx: NPX_WRAPPER })),
    ).toEqual([FAKE_NODE, NPX_CLI])
  })

  it('launches a job through the wrapper', () => {
    const launch = resolveLaunch(
      ['npm', 'run', 'build'],
      null,
      null,
      patchedWhich({ ...whichExtra, npm: WRAPPER }),
    )
    expect(launch.argv).toEqual([FAKE_NODE, NPM_CLI, 'run', 'build'])
  })

  it('launches the run verb a shorthand was normalised to', () => {
    // `npm test` reaches the launcher as `run test`: `validate()` rewrites the
    // shorthand before the job is submitted (see `shorthandToRun`, not part of
    // this slice), so the launcher only ever sees the normalised argv — shim and
    // all.
    const launch = resolveLaunch(
      ['npm', 'run', 'test'],
      null,
      null,
      patchedWhich({ ...whichExtra, npm: WRAPPER }),
    )
    expect(launch.argv).toEqual([FAKE_NODE, NPM_CLI, 'run', 'test'])
  })

  it('fails when npm is not on PATH', () => {
    expect(() => resolvePackageManager('npm', patchedWhich({ ...whichExtra, npm: null }))).toThrow(
      ToolFailure,
    )
  })

  it('finds Node-bundled npm through the node install probe', () => {
    // No wrapper beside the entry, and no shim to read: still resolved. npm ships
    // inside Node, so this is the layout a real install usually has: `node.exe`
    // and `node_modules/npm` are siblings, and nothing in npm's own directory
    // names its entry.
    const bare = join(ROOT, 'bare-node')
    const entry = writeFile(join(bare, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '// npm\n')
    const fakeNode = writeFile(join(bare, 'node.EXE'))
    expect(
      resolvePackageManager('npm', patchedWhich({ node: fakeNode, npm: join(bare, 'npm.CMD') })),
    ).toEqual([fakeNode, entry])
  })

  it('does not use the node install probe for pnpm', () => {
    // pnpm is never bundled with Node, so that probe must not answer for it.
    // Without the scope, a pnpm resolve whose wrapper is pointed elsewhere would
    // come back as *npm's* entry — which is how two pnpm launcher tests started
    // passing for the wrong reason.
    const bare = join(ROOT, 'bare-node')
    const wrapper = writeFile(join(bare, 'pnpm.CMD'), '@ECHO off\necho nothing\n')
    const fakeNode = writeFile(join(bare, 'node.EXE'))
    expect(() =>
      resolvePackageManager('pnpm', patchedWhich({ node: fakeNode, pnpm: wrapper })),
    ).toThrow(ToolFailure)
  })

  it('prefers the entry the wrapper really runs', () => {
    // Both candidates exist; the helper is named last, the entry wins. This is
    // the one place the naming rule is observable on its own: the resolve tests
    // above reach npm's entry through the Node-install probe before the shim
    // reader is ever consulted. Position cannot decide it — a wrapper may launch
    // a variable that a *later* line reassigns, so the reader looks for the
    // `-cli` name the entry always carries and the helpers beside it do not.
    const elsewhere = join(ROOT, 'npm-elsewhere')
    const entry = writeFile(join(elsewhere, 'some', 'tool', 'tool-cli.js'), '// entry\n')
    writeFile(join(elsewhere, 'some', 'tool', 'tool-helper.js'), '// helper\n')
    const wrapper = writeFile(
      join(elsewhere, 'tool.CMD'),
      '@ECHO off\n' +
        'SET "TOOL_JS=%dp0%\\some\\tool\\tool-cli.js"\n' +
        'SET "TOOL_HELPER=%dp0%\\some\\tool\\tool-helper.js"\n' +
        '"%NODE_EXE%" "%TOOL_JS%" %*\n',
    )
    expect(nodeEntryFromShim(wrapper)).toBe(entry)
  })

  it('reads a corepack-style wrapper that names only its own entry', () => {
    const elsewhere = join(ROOT, 'corepack-elsewhere')
    const entry = writeFile(
      join(elsewhere, 'node_modules', 'corepack', 'dist', 'pnpm.js'),
      '// corepack pnpm\n',
    )
    const wrapper = writeFile(
      join(elsewhere, 'pnpm.CMD'),
      '@ECHO off\nnode "%dp0%\\node_modules\\corepack\\dist\\pnpm.js" %*\n',
    )
    expect(nodeEntryFromShim(wrapper)).toBe(entry)
  })

  it('names no entry for a wrapper with nothing to read', () => {
    const wrapper = writeFile(
      join(ROOT, 'empty-wrapper', 'tool.CMD'),
      '@ECHO off\r\necho nothing to see\r\n',
    )
    expect(nodeEntryFromShim(wrapper)).toBeNull()
  })
})

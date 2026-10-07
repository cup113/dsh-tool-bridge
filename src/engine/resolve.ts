/**
 * Turning an allowlisted argv into a real executable invocation.
 *
 * This is the Windows launcher slice of the retired server, moved across whole:
 * on Windows `flutter`, `dart`, `npm`, `npx` and `pnpm` are `.bat`/`.cmd`
 * wrappers, which CreateProcess cannot execute and which would drag `cmd.exe` —
 * and its parsing rules — into the middle of an argv that is supposed to have no
 * shell. Each wrapper is therefore unwrapped to the real thing behind it: the
 * SDK's own `dart.exe` (with the flutter_tools snapshot for `flutter`), the
 * package manager's JavaScript entry under `node.exe`, or a project-local
 * package's `bin` entry under `node.exe`.
 *
 * **Windows only, deliberately.** The retired server gated its unwrapping on
 * `os.name == "nt"` and carried a POSIX fallback that nobody ever exercised —
 * its own README says so ("The code carries a POSIX fallback that nobody has
 * exercised, so treat elsewhere as untested rather than supported"). That branch
 * is dropped here rather than carried as an untested claim: a `.cmd` found by
 * the PATH lookup is unwrapped, and there is no second code path pretending to
 * have been measured.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, delimiter, dirname, join, sep } from 'node:path'

import { commandName, execTarget } from './argv'
import { ToolFailure } from './errors'
import {
  LONG_SCRIPTS,
  NODE_INSTALL_ENTRIES,
  PACKAGE_MANAGER_ENTRIES,
  PACKAGE_MANAGER_RUNNERS,
  PACKAGE_MANAGERS,
  SCRIPT_BINARIES,
} from './surface'

/**
 * Command name -> the package that provides it, when they differ. Everything
 * else is looked up under its own name.
 *
 * `surface.ts` keeps the *command* table (`SCRIPT_BINARIES`) because it is part
 * of the guardrail; this map belongs to the resolver, which is the only reader
 * of it.
 */
const SCRIPT_BINARY_PACKAGES: Record<string, string> = {
  tsc: 'typescript',
  'svelte-kit': '@sveltejs/kit',
}

/**
 * A PATH lookup, as `shutil.which` is used here: the executable path, or null.
 *
 * Injectable so a test never has to consult the machine it runs on — the Python
 * suite patched `shutil.which` for exactly that reason, and a resolver test that
 * leaked through to the real npm/node would pass without its own fixture.
 */
export type WhichFn = (name: string) => string | null

/** The argv to launch plus environment additions. */
export interface Launch {
  argv: string[]
  env: Record<string, string>
}

/** `os.path.isfile` — existence *as a file*, following symlinks like Python does. */
function isFile(target: string): boolean {
  try {
    return statSync(target).isFile()
  } catch {
    return false
  }
}

/**
 * `os.path.realpath` in its non-strict form: resolve what exists, keep the rest.
 *
 * Python's `realpath` does not throw on a path that is not there — it resolves
 * the deepest existing ancestor through its symlinks and leaves the tail
 * appended. That matters for one caller: a `bin` entry pointing outside its
 * package is checked *before* the target's existence is, so the escape check has
 * to work on a path that does not exist. Node's `realpathSync` throws ENOENT
 * there, hence this walk.
 */
function realpathish(target: string): string {
  try {
    return realpathSync(target)
  } catch {
    const parent = dirname(target)
    if (parent === target) return target
    return join(realpathish(parent), basename(target))
  }
}

/** The subset of Python's `repr` the messages below use for a string operand. */
function pyRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'"
  let body = ''
  for (const character of value) {
    if (character === '\\') body += '\\\\'
    else if (character === quote) body += `\\${character}`
    else body += character
  }
  return `${quote}${body}${quote}`
}

/** The error text of an unknown throw, for a message that has to name a cause. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `shutil.which` on Windows, reimplemented against `PATH`/`PATHEXT`.
 *
 * Spawning `where.exe` is not an option — a piped child is exactly what the DSH
 * sandbox denies — so the search is done with `node:fs`, following CPython's
 * algorithm: a name carrying a separator is checked in place and nowhere else; a
 * bare name is looked for in `.` first and then along `PATH`, with the `PATHEXT`
 * extensions appended (and, as in CPython, `os.access(..., X_OK)` on Windows is
 * an existence test). `PATHEXT` is read, not invented: with it unset, only the
 * bare name is tried, which is what CPython does too.
 */
export function whichOnPath(name: string): string | null {
  if (name.includes('/') || name.includes('\\')) {
    return existsSync(name) ? name : null
  }
  const rawPath = process.env['PATH']
  const searchPath = rawPath !== undefined && rawPath !== '' ? rawPath : '.'
  const directories = searchPath.split(delimiter)
  if (!directories.includes('.')) directories.unshift('.')
  const extensions = (process.env['PATHEXT'] ?? '').split(delimiter)
  const lower = name.toLowerCase()
  const files = extensions.some((extension) => lower.endsWith(extension.toLowerCase()))
    ? [name]
    : extensions.map((extension) => name + extension)
  const seen = new Set<string>()
  for (const directory of directories) {
    const key = directory.toLowerCase().replaceAll('/', '\\')
    if (seen.has(key)) continue
    seen.add(key)
    for (const file of files) {
      const candidate = join(directory, file)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * The pinned dart executable for a `dart format` job, else null.
 *
 * Routing keys on `format` being the *first* argument after `dart` — the shape
 * CI uses (`dart format --output=none --set-exit-if-changed <files>`) and the
 * only one a scoped job produces. Everything else keeps the PATH toolchain on
 * purpose: `dart analyze`/`test`/`pub` and every `flutter` command must match
 * the Flutter SDK installed here, not CI's.
 */
export function dartFormatTarget(argv: readonly string[], pin: string | null): string | null {
  if (pin === null || argv.length < 2) return null
  const [first, second] = argv
  if (first === undefined || second === undefined) return null
  if (commandName(first) !== 'dart' || second !== 'format') return null
  return pin
}

/**
 * Whether a command is expected to run until someone kills it.
 *
 * Peeling an exec form first, the shapes that are certainly long are vite's dev
 * server and vitest's watch mode; a `run <script>` cannot be known (the name is
 * the project's), so the conventional server/watcher names in `LONG_SCRIPTS`
 * count too. Both error directions argue for guessing: a long job left on the
 * queue lane starves every build behind it until it is killed, while a one-shot
 * job put on the long lane merely occupies that lane until it exits.
 * `--help`/`--version` are excluded so a probe never lands there at all.
 *
 * **Ordering assumption:** `npm test`/`npm start` reach here already normalised
 * to `run test`/`run start` by `validate()` (the shorthand rewrite happens before
 * the job is submitted), which is why the shorthand needs no case of its own —
 * and why this must be applied to the *normalised* argv, never the caller's
 * typing.
 */
export function wantsLongLane(cmd: string, args: readonly string[]): boolean {
  let parts = [...args]
  let exe = commandName(cmd)
  if (PACKAGE_MANAGERS.has(exe)) {
    const verb = parts[0] ?? ''
    const rest = parts.slice(1)
    if (verb === 'exec') {
      const peeled = execTarget([cmd, ...args])
      if (peeled === undefined) return false
      exe = peeled.target
      parts = peeled.args
    } else if (verb === 'run' || verb === 'run-script') {
      const script = rest.find((token) => !token.startsWith('-'))
      return script !== undefined && LONG_SCRIPTS.has(script)
    } else {
      return false
    }
  } else if (exe === 'npx') {
    const peeled = execTarget([cmd, ...args])
    if (peeled === undefined) return false
    exe = peeled.target
    parts = peeled.args
  }
  if (parts.some((token) => token === '--help' || token === '-h' || token === '--version' || token === '-v')) {
    return false
  }
  const positional = parts.filter((token) => !token.startsWith('-'))
  if (exe === 'vite') {
    // Bare `vite` is the dev server; `preview` serves until it is stopped.
    const head = positional[0]
    return head === undefined || head === 'dev' || head === 'serve' || head === 'preview'
  }
  if (exe === 'vitest') {
    // `vitest` alone watches; `run`/`--run` is the one-shot form.
    return !positional.includes('run') && !parts.includes('--run')
  }
  return false
}

/**
 * Turns an allowlisted command into a real executable invocation.
 *
 * On Windows `flutter` and `dart` are `.bat` wrappers, which CreateProcess
 * cannot execute and which would drag `cmd.exe` — and its parsing rules — into
 * the middle of an argv that is supposed to have no shell. Both wrappers only
 * launch the SDK's own `dart.exe` (with the flutter_tools snapshot for
 * `flutter`), so that is what we call directly. `pnpm` is the same problem with
 * a different shape (see `resolvePnpm`), and a project-local script binary is
 * reached the same way (see `resolveScriptBinary`).
 *
 * `dartFormatExe` is the boot-time **format pin**: when it is set, a `dart
 * format` job launches *that* executable instead. It is an explicit path to a
 * real `dart.exe` (a standalone SDK, not a wrapper), so it needs neither the
 * `.bat` dance nor `FLUTTER_ROOT` — and it is checked here rather than trusted,
 * because a pin that has gone missing must fail the job loudly rather than fall
 * back to the formatter the pin exists to avoid.
 *
 * `cwd` is the pinned working directory, and only a script binary needs it: that
 * is where its package is installed. It is a defaulted argument rather than a
 * required one because `flutter`/`dart`/`git`/`pnpm` resolve globally; every job
 * passes `job.cwd`.
 *
 * Returns the argv to launch plus environment additions. Throws
 * {@link ToolFailure} (Python's `FileNotFoundError`).
 */
export function resolveLaunch(
  argv: readonly string[],
  dartFormatExe: string | null = null,
  cwd: string | null = null,
  which: WhichFn = whichOnPath,
): Launch {
  const pin = dartFormatTarget(argv, dartFormatExe)
  if (pin !== null) {
    if (!isFile(pin)) {
      throw new ToolFailure(`pinned dart format executable is missing: ${pin}`)
    }
    return { argv: [pin, ...argv.slice(1)], env: {} }
  }
  const name = commandName(argv[0] ?? '')
  if (SCRIPT_BINARIES.has(name)) {
    // The target is resolved before `node` is asked for, as in the Python: when
    // both are wrong, "the package is not installed" is the answer that names
    // what the caller can actually fix.
    const target = resolveScriptBinary(cwd ?? process.cwd(), name)
    return { argv: [nodeExe(which), target, ...argv.slice(1)], env: {} }
  }
  if (PACKAGE_MANAGER_RUNNERS.has(name)) {
    return { argv: [...resolvePackageManager(name, which), ...argv.slice(1)], env: {} }
  }
  const exe = which(argv[0] ?? '')
  if (exe === null) {
    throw new ToolFailure(`executable not found on PATH: ${argv[0] ?? ''}`)
  }
  if (exe.toLowerCase().endsWith('.bat') || exe.toLowerCase().endsWith('.cmd')) {
    // exe is `<FLUTTER_ROOT>/bin/flutter.bat` (or dart.bat); the SDK cache hangs
    // off the same `bin`, while FLUTTER_ROOT is its parent — flutter_tools
    // appends `bin/cache` to FLUTTER_ROOT itself.
    const flutterBin = dirname(exe)
    const flutterRoot = dirname(flutterBin)
    const dartExe = join(flutterBin, 'cache', 'dart-sdk', 'bin', 'dart.exe')
    if (!existsSync(dartExe)) {
      throw new ToolFailure(`${exe} is a wrapper but its SDK dart.exe is missing: ${dartExe}`)
    }
    if (basename(exe).toLowerCase().startsWith('flutter')) {
      const snapshot = join(flutterBin, 'cache', 'flutter_tools.snapshot')
      if (!existsSync(snapshot)) {
        throw new ToolFailure(`flutter_tools.snapshot missing: ${snapshot}`)
      }
      return { argv: [dartExe, snapshot, ...argv.slice(1)], env: { FLUTTER_ROOT: flutterRoot } }
    }
    return { argv: [dartExe, ...argv.slice(1)], env: { FLUTTER_ROOT: flutterRoot } }
  }
  return { argv: [exe, ...argv.slice(1)], env: {} }
}

/** The Node interpreter a script binary runs under. */
export function nodeExe(which: WhichFn = whichOnPath): string {
  const exe = which('node')
  if (exe === null) {
    throw new ToolFailure(
      "node is not on PATH — the bridge needs it to run a project's own " +
        'vite/vitest/svelte-check/tsc',
    )
  }
  return exe
}

/**
 * The JavaScript entry point of a project-local script binary.
 *
 * Not `node_modules/.bin/<name>.CMD`: that is a shell wrapper, which CreateProcess
 * cannot execute — running it would drag `cmd.exe` into the middle of an argv
 * that is supposed to have no shell, the same reason `flutter.bat` is unpacked.
 * The wrapper's body names exactly this target (`node "%~dp0\..\vite\bin\vite.js"`),
 * so the package's own `bin` field is read instead, which also follows pnpm's
 * `node_modules/<pkg>` symlink into the virtual store.
 *
 * Throws {@link ToolFailure} when the package is not installed in the pinned
 * cwd, or when its `bin` field points outside the package.
 */
export function resolveScriptBinary(cwd: string, name: string): string {
  const packageName = SCRIPT_BINARY_PACKAGES[name] ?? name
  const packageDir = join(cwd, 'node_modules', ...packageName.split('/'))
  const manifest = join(packageDir, 'package.json')
  if (!isFile(manifest)) {
    throw new ToolFailure(
      `${name} is not installed in ${cwd}: ${manifest} is missing ` +
        "(install the project's dependencies first)",
    )
  }
  let document: unknown
  try {
    document = JSON.parse(readFileSync(manifest, 'utf8'))
  } catch (error) {
    // The prefix is the retired server's; the cause's text is this runtime's
    // (`JSON.parse`'s wording is not CPython's, and no message asserts it).
    throw new ToolFailure(`cannot read ${manifest}: ${describeError(error)}`, { cause: error })
  }
  // Python read `document.get("bin")` here and would have raised AttributeError
  // on a manifest that is not an object; the refusal below is the same answer
  // without the crash.
  const record =
    typeof document === 'object' && document !== null
      ? (document as Record<string, unknown>)
      : null
  let entry: unknown = record === null ? undefined : record['bin']
  if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
    entry = (entry as Record<string, unknown>)[name]
  }
  if (typeof entry !== 'string' || entry === '') {
    throw new ToolFailure(`${packageName} declares no \`bin\` entry for ${pyRepr(name)}`)
  }
  const root = realpathish(packageDir)
  const target = realpathish(join(packageDir, entry))
  if (target !== root && !target.startsWith(root + sep)) {
    throw new ToolFailure(`${name} points outside its package: ${pyRepr(entry)}`)
  }
  if (!isFile(target)) {
    throw new ToolFailure(`${name} entry point is missing: ${target}`)
  }
  return target
}

/**
 * How to launch a package manager as a real executable.
 *
 * On Windows `npm`, `npx` and `pnpm` on PATH are `.cmd` wrappers, which
 * CreateProcess cannot execute. A standalone pnpm ships `pnpm.exe` and is used
 * as it is; otherwise the wrapper's JavaScript entry is located — first by the
 * layout the tool's own install uses (`PACKAGE_MANAGER_ENTRIES`), then by reading
 * the wrapper itself, because a corepack-managed install names its own path.
 * Throws {@link ToolFailure}. The order of the attempts *is* the behaviour.
 */
export function resolvePackageManager(name: string, which: WhichFn = whichOnPath): string[] {
  const exe = which(name)
  if (exe === null) {
    throw new ToolFailure(
      `${name} is not on PATH — install it, or run the project's scripts ` +
        "with its own package manager",
    )
  }
  if (exe.toLowerCase().endsWith('.exe')) {
    return [exe]
  }
  const base = dirname(exe)
  for (const parts of PACKAGE_MANAGER_ENTRIES[name] ?? []) {
    const candidate = join(base, ...parts)
    if (isFile(candidate)) {
      return [nodeExe(which), candidate]
    }
  }
  // Node's own npm and npx live one directory down, beside `node.exe`. Scoped to
  // those two on purpose: pnpm is never bundled with Node, and probing the Node
  // installation for it would answer with *npm's* entry whenever `which` is
  // pointed elsewhere (which is exactly how the pnpm tests fake a wrapper).
  if (name === 'npm' || name === 'npx') {
    const node = which('node')
    if (node !== null) {
      const nodeDir = dirname(node)
      const suffix = name === 'npx' ? 'npx-cli' : 'npm-cli'
      for (const parts of NODE_INSTALL_ENTRIES) {
        const candidate = join(nodeDir, ...parts)
        if (basename(candidate).includes(suffix) && isFile(candidate)) {
          return [nodeExe(which), candidate]
        }
      }
    }
  }
  const entry = nodeEntryFromShim(exe)
  if (entry !== null) {
    return [nodeExe(which), entry]
  }
  throw new ToolFailure(`cannot find ${name}'s JavaScript entry point behind the wrapper ${exe}`)
}

/** `resolvePackageManager("pnpm")`, kept as its own name for callers. */
export function resolvePnpm(which: WhichFn = whichOnPath): string[] {
  return resolvePackageManager('pnpm', which)
}

/**
 * The JS entry a `.cmd` wrapper launches, read out of the wrapper itself.
 *
 * Needed for a corepack-managed install, whose wrapper names its own path, so the
 * layout probe beside it cannot find the package.
 *
 * Written with plain string work rather than a regular expression on purpose.
 * Two attempts at a pattern both failed on the same trap: `\r\n` inside a
 * character class means the literal letters `r` and `n` in a raw string, and the
 * real newline characters only in a non-raw one, so the pattern silently refused
 * to match `node_modules` and read nothing at all. Splitting on the separators
 * has no such hidden state.
 *
 * Two details decide whether this works on a real wrapper:
 *
 * - **Batch path variables are not paths.** Node's own `npm.cmd` writes
 *   `"%~dp0\node_modules\npm\bin\npm-cli.js"`, and `%~dp0` expands to the
 *   wrapper's directory *with* a trailing separator, while pnpm's wrapper writes
 *   `"%dp0%\node_modules\pnpm\bin\pnpm.mjs"` and leaves the separator to the
 *   surrounding text. Either way the variable is dropped and the remainder
 *   resolved against the wrapper's directory.
 * - **The last candidate that *exists* wins**, not the last one mentioned. A
 *   wrapper may name several — `npm.cmd` names `npm-prefix.js` (a helper it
 *   shells out to first) and `npm-cli.js` (the entry it runs) — so existence, not
 *   position, is what separates them.
 */
export function nodeEntryFromShim(shim: string): string | null {
  let text: string
  try {
    text = readFileSync(shim, 'utf8')
  } catch {
    return null
  }
  const base = dirname(shim)
  const paths: string[][] = []
  for (const token of text.replaceAll('\r\n', '\n').replaceAll('"', '\n').split('\n')) {
    const trimmed = token.trim()
    const lowered = trimmed.toLowerCase()
    if (!lowered.endsWith('.mjs') && !lowered.endsWith('.cjs') && !lowered.endsWith('.js')) {
      continue
    }
    let cleaned = trimmed
    if (cleaned.toUpperCase().startsWith('SET')) {
      cleaned = cleaned.slice(3).trim()
    }
    if (cleaned.includes('=')) {
      // `SET "NPM_CLI_JS=%~dp0\..."`: the name is not part of the path.
      cleaned = cleaned.slice(cleaned.indexOf('=') + 1)
    }
    for (const variable of ['%~dp0', '%dp0%', '%CD%']) {
      // `%~dp0` carries its own trailing separator; `%dp0%` does not.
      if (cleaned.startsWith(variable)) {
        cleaned = cleaned.slice(variable.length).replace(/^[\\/]+/u, '')
        break
      }
    }
    if (cleaned.includes('=')) {
      // Still an assignment, so not a path.
      continue
    }
    const parts = cleaned.replaceAll('/', '\\').split('\\').filter((part) => part !== '')
    if (parts.length >= 2) {
      paths.push(parts)
    }
  }
  // Every wrapper this has to read names its entry `<tool>-cli.<ext>` — npm's
  // `npm-cli.js`, npx's `npx-cli.js`, corepack's `corepack.js` (no suffix, so the
  // fallback covers it) — while the helpers beside them do not (`npm-prefix.js`).
  // That name is the reliable signal; position is not, because a wrapper may name
  // the entry and then, later, a helper it also calls. Among equally good
  // candidates the last one wins, since a wrapper's final assignment is the one
  // its last invocation uses.
  const preferred = paths.filter((parts) => parts[parts.length - 1]?.includes('-cli.') === true)
  for (const parts of [...(preferred.length > 0 ? preferred : paths)].reverse()) {
    const resolved = join(base, ...parts)
    if (isFile(resolved)) {
      return resolved
    }
  }
  return null
}

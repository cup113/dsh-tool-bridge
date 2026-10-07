/**
 * The command surface, as tables.
 *
 * Everything here is data lifted from the retired server unchanged, because
 * these tables *are* the guardrail ADR-0001 argues about: what the tool accepts
 * by name, which verbs each package manager has, which flags are refused, and
 * how a scope reaches a command. Keeping them in one module with the refusals
 * next door is the point — a table and its refusal message drifting apart is
 * how a guardrail becomes a decoration.
 */

/**
 * SCRIPT_BINARIES — the project's own Node tools, accepted by name and resolved
 * inside the job's working directory rather than through `.bin` (a `.cmd`
 * wrapper would put `cmd.exe` back in the middle of an argv that is supposed to
 * have no shell).
 */
export const SCRIPT_BINARIES = new Set(['vite', 'vitest', 'svelte-check', 'svelte-kit', 'tsc'])

export const ALLOWED_EXES = new Set(['flutter', 'dart', 'git', 'npm', 'npx', 'pnpm', ...SCRIPT_BINARIES])

/**
 * PACKAGE_MANAGERS — both package managers are accepted on the same terms: the
 * tool never detects which one a project uses (the lockfile is advisory and a
 * fork may carry either), so the caller names the manager its project resolves
 * with. ADR-0006 records why the second one was admitted.
 */
export const PACKAGE_MANAGERS = new Set(['npm', 'pnpm'])

/**
 * `npx` is accepted, but as an exec form rather than a verb-guarded manager: it
 * *is* `npm exec` with the package argument implied.
 */
export const PACKAGE_MANAGER_RUNNERS = new Set([...PACKAGE_MANAGERS, 'npx'])

/**
 * How a package manager's JavaScript entry point is found behind its Windows
 * wrapper, as paths relative to the wrapper's own directory. The general
 * fallback reads the wrapper itself (`nodeEntryFromShim`), which is what a
 * corepack-managed install needs because its wrapper names its own path.
 */
export const PACKAGE_MANAGER_ENTRIES: Record<string, readonly (readonly string[])[]> = {
  npm: [
    ['node_modules', 'npm', 'bin', 'npm-cli.js'],
    ['node_modules', 'npm', 'bin', 'npm-cli.cjs'],
  ],
  npx: [
    ['node_modules', 'npm', 'bin', 'npx-cli.js'],
    ['node_modules', 'npm', 'bin', 'npx-cli.cjs'],
  ],
  pnpm: [
    ['node_modules', 'pnpm', 'bin', 'pnpm.mjs'],
    ['node_modules', 'pnpm', 'bin', 'pnpm.cjs'],
  ],
}

/**
 * Node's own npm ships *inside* the Node installation, next to `node.exe`, so
 * its wrapper directory has no `node_modules/npm` of its own to probe. Measured
 * on nvm4w: `%USERPROFILE%\nvm4w\nodejs\npm.CMD` is the wrapper and the entry is
 * one directory down at `nodejs/node_modules/npm/bin/npm-cli.js`. Without this
 * the layout probe finds nothing and only the shim reader can answer.
 */
export const NODE_INSTALL_ENTRIES: readonly (readonly string[])[] = [
  ['node_modules', 'npm', 'bin', 'npm-cli.js'],
  ['node_modules', 'npm', 'bin', 'npm-cli.cjs'],
]

/**
 * pnpm verbs: install a tree (including the dependency build scripts a confined
 * install silently skips), run the project's own scripts, change dependencies
 * and inspect the result. Excluded by omission: `dlx`, `publish`,
 * `config`/`setup`/`self-update`, `store` and `link`/`unlink` — every one of
 * them writes machine state outside the project.
 */
export const PNPM_VERBS = new Set([
  'install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade',
  'rebuild', 'dedupe', 'run', 'run-script', 'exec', 'why', 'list', 'ls',
  'outdated', 'audit', 'licenses',
])

/**
 * The npm peer of PNPM_VERBS. `ci` is the *strict* install (resolves only from
 * `package-lock.json`, never rewrites it); `link`/`unlink`/`publish`/`config`/
 * `init`/`pack`/`prune`/`owner`/`team`/`token`/`doctor`/`cache` are absent by
 * omission. Note `ls` is not pnpm's `ls`: npm lists packages where pnpm lists
 * scripts.
 */
export const NPM_VERBS = new Set([
  'install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'update', 'up',
  'upgrade', 'rebuild', 'dedupe', 'run', 'run-script', 'exec', 'why', 'explain',
  'list', 'ls', 'outdated', 'audit', 'licenses',
])

/**
 * npm's bare-script shorthands: only `npm test` and `npm start` are abbreviated,
 * and `npm build` is not something npm understands — accepting it would invent a
 * surface npm does not have.
 */
export const NPM_RUN_SHORTHANDS = new Set(['test', 'start'])

export const PACKAGE_MANAGER_VERBS: Record<string, Set<string>> = {
  npm: NPM_VERBS,
  pnpm: PNPM_VERBS,
}

/**
 * Flags that retarget one of the two anchors a job runs under: the working
 * directory (ADR-0002) and "this project, not this machine". `-C`/`--dir`/
 * `--prefix` move the directory, `-w`/`--workspace-root`/`--workspace` move it
 * up to a workspace root or sideways to a package that may lie outside it, and
 * `-g`/`--global` leaves the project entirely.
 *
 * One table serves both managers on purpose, and the two spellings of `-w` are
 * why: pnpm's `-w` is `--workspace-root`, npm's is `--workspace <name>` (which
 * is pnpm's `--workspace`). One flag, three retargets, one refusal.
 */
export const PACKAGE_MANAGER_BLOCKED_FLAGS = new Set([
  '-C', '--dir', '--prefix', '-w', '--workspace-root', '--workspace', '-g', '--global',
])

/** The one blocked flag whose *value* decides: `=global`/`=user` vs `=project`. */
export const PACKAGE_MANAGER_LOCATION_FLAG = '--location'
export const PACKAGE_MANAGER_GLOBAL_LOCATIONS = new Set(['global', 'user'])

/**
 * `pnpm exec`/`npm exec`/`npx` look in `node_modules/.bin` *and then on PATH*:
 * measured, `pnpm exec node --version` and `pnpm exec cmd /c echo hi` both work,
 * and npx additionally *fetches* what it cannot find. Left alone that is general
 * command execution behind an allowlisted verb, so the exec target must be a
 * script binary and these flags stay out.
 */
export const EXEC_BLOCKED_FLAGS = new Set(['-c', '--shell-mode', '-p', '--package'])

/** The two lanes a job may run on. */
export const LANE_QUEUE = 'queue'
export const LANE_LONG = 'long'

/**
 * Script names a project conventionally gives a server or a watcher. Detection
 * cannot be exact for `run <script>` (the name is the project's), and the two
 * error directions are not symmetric: a long job on the queue lane starves
 * everything until it is killed, while a one-shot job on the long lane merely
 * occupies it until it exits.
 */
export const LONG_SCRIPTS = new Set(['dev', 'start', 'serve', 'watch', 'storybook'])

/** git verbs this tool will run; everything else is refused by omission. */
export const GIT_VERBS = new Set(['status', 'diff', 'log', 'add', 'commit', 'branch', 'restore'])

/** Per-verb flags that turn a safe verb destructive. */
export const GIT_BLOCKED_FLAGS: Record<string, Set<string>> = {
  branch: new Set(['-d', '-D', '--delete', '-m', '-M', '--move']),
  commit: new Set(),
  add: new Set(),
  status: new Set(),
  diff: new Set(),
  log: new Set(),
}

/**
 * Verbs whose flag surface is an allow list rather than a deny list.
 *
 * `restore` is the one allowed verb that can irrecoverably discard uncommitted
 * work, so both directions of its blast radius are bounded: which flags, and
 * which pathspecs. The deny list cannot express that — the dangerous thing is
 * the default — so everything absent here (`--source`, `--pathspec-from-file`,
 * `-p/--patch`, `--recurse-submodules`, `-m/--merge`, `--overlay`) is refused by
 * omission.
 */
export const GIT_ALLOWED_FLAGS: Record<string, Set<string>> = {
  restore: new Set(['-S', '--staged', '-W', '--worktree', '-q', '--quiet']),
}

/**
 * Characters that make a pathspec a pattern instead of a path. The point of
 * allowing restore is "undo these named files"; `git restore .` is the
 * whole-worktree wipe the tool exists to keep out of reach.
 */
export const PATHSPEC_WILDCARDS = new Set(['*', '?', '[', ']'])

/** Arguments that carry a commit message, so the inline `message` cannot fight one. */
export const MESSAGE_SOURCE_FLAGS = new Set([
  '-m', '--message', '-F', '--file', '-C', '--reuse-message', '-c',
  '--reedit-message', '--fixup', '--squash', '--no-edit',
])

/** The one scope a request may name: the working tree's uncommitted files. */
export const SCOPE_UNCOMMITTED = 'uncommitted'

/**
 * Verbs a scope may be applied to, split by *how*: `dart format` takes any
 * number of trailing paths, so the files are appended to argv and the tool
 * itself is narrowed. `dart analyze` takes at most one directory and `dart fix`
 * takes no path at all, so no argv can express "these files" — there the scope
 * narrows the *reported* lines instead and the exit code still covers the whole
 * project.
 */
export const SCOPE_EXPAND_VERBS = new Set(['format'])
export const SCOPE_FILTER_VERBS = new Set(['analyze', 'fix'])
export const SCOPE_COMMANDS = new Set(['dart', 'flutter'])

/** Endings a scoped command cares about: a changed README or ARB file is not a target. */
export const SCOPE_FILE_SUFFIX = '.dart'

/** How long `git status` may take before the scope is refused, in milliseconds. */
export const GIT_STATUS_TIMEOUT_MS = 20_000

/** The optional per-project known-failure registry (baseline attribution). */
export const KNOWN_FAILURES_RELPATH = '.toolbridge/known-failures.json'
export const KNOWN_FAILURES_MAX_BYTES = 512 * 1024

/**
 * Platforms an entry may be gated to. The tool knows one local distinction —
 * Windows or not — and that is the one that matters: CI runs Linux, where a
 * Windows-only family is expected to pass.
 */
export const KNOWN_PLATFORMS = new Set(['windows', 'posix'])

/**
 * Assessment families an entry may carry: `platform` (fails on this OS only),
 * `flaky` (intermittent), `environment` (setup/machine), `defect` (a real
 * pre-existing bug, in nobody's change) and `unclassified`.
 */
export const KNOWN_KINDS = new Set(['platform', 'flaky', 'environment', 'defect', 'unclassified'])

/** Where the registry lives, relative to the job's working directory. */
export function knownFailuresPath(cwd: string): string {
  return `${cwd.replace(/[\\/]+$/u, '')}\\${KNOWN_FAILURES_RELPATH.replaceAll('/', '\\')}`
}

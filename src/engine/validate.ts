/**
 * The command surface, enforced: which argv this bridge will run, and why not.
 *
 * The tables live in `./surface`; the refusals that argue with them live beside
 * them here, which is the pairing the tables' own header asks for. Two
 * properties of the ported block are load-bearing and easy to lose:
 *
 * - `validate` **rewrites** the list it is handed: npm's bare-script shorthands
 *   become `run <script>`. The caller holds the spawned argv, so that rewrite is
 *   what the job JSON, the long-lane guess and the digest all read.
 * - Every refusal here answered **403**, never 400. The retired route reached
 *   this module only through `ToolHub.submit`, whose `except ValueError` sends
 *   403; every 400 in that handler was decided *before* the call (`cmd`/`args`/
 *   `message`/`scope` types, the log query, the scope mode). That is also why
 *   `buildArgv`'s `'message' must be a string` guard cannot fire over HTTP, and
 *   is kept only for a caller that reaches the function directly.
 */

import { commandName } from './argv'
import { refuse } from './errors'
import {
  ALLOWED_EXES,
  EXEC_BLOCKED_FLAGS,
  GIT_ALLOWED_FLAGS,
  GIT_BLOCKED_FLAGS,
  GIT_VERBS,
  MESSAGE_SOURCE_FLAGS,
  NPM_RUN_SHORTHANDS,
  PACKAGE_MANAGER_BLOCKED_FLAGS,
  PACKAGE_MANAGER_GLOBAL_LOCATIONS,
  PACKAGE_MANAGER_LOCATION_FLAG,
  PACKAGE_MANAGERS,
  PACKAGE_MANAGER_VERBS,
  PATHSPEC_WILDCARDS,
  SCRIPT_BINARIES,
} from './surface'

/**
 * Python's `repr` of a string, which is how every `{token!r}` in these refusals
 * was formatted.
 *
 * Worth reproducing rather than approximating, because the refusal *is* the
 * model's feedback: `'git'` reads as a quoted token where `git` reads as a word
 * in a sentence, and the single/double quote choice is part of the message a
 * test may assert. The rule is Python's: single quotes unless the text contains
 * one and not a double quote; backslash, the quoting character and the common
 * control characters escaped; printable non-ASCII kept as written.
 */
function repr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'"
  let out = ''
  for (const char of value) {
    if (char === '\\' || char === quote) {
      out += `\\${char}`
    } else if (char === '\n') {
      out += '\\n'
    } else if (char === '\r') {
      out += '\\r'
    } else if (char === '\t') {
      out += '\\t'
    } else if (char === ' ' || !/[\p{C}\p{Z}]/u.test(char)) {
      // Python's `str.isprintable` keeps the ASCII space and everything outside
      // the Unicode Other/Separator categories, which is what this mirrors.
      out += char
    } else {
      const code = char.codePointAt(0) ?? 0
      const digits = code.toString(16)
      out +=
        code <= 0xff
          ? `\\x${digits.padStart(2, '0')}`
          : code <= 0xffff
            ? `\\u${digits.padStart(4, '0')}`
            : `\\U${digits.padStart(8, '0')}`
    }
  }
  return `${quote}${out}${quote}`
}

/**
 * Python's `sorted(...)`, rendered as the list repr these messages carry.
 *
 * The default sort of both languages compares by code unit and neither is
 * numeric-aware, so the tables' lowercase-ASCII members come out in the same
 * order — which matters, because the refusal states the surface and a caller
 * diffing two refusals must not see them disagree.
 */
function sortedList(values: ReadonlySet<string>): string {
  return `[${[...values].sort().map((value) => repr(value)).join(', ')}]`
}

/**
 * Refuses anything outside the documented surface.
 *
 * May *normalise* `argv` in place — `npm test` becomes `npm run test` — so the
 * caller must treat the list it passed as possibly rewritten. One caller holds
 * the spawned argv (`ToolHub.submit`), which is what makes the rewrite visible
 * everywhere downstream: the job JSON, the long-lane guess and the digest all
 * read the normalised form rather than the caller's typing.
 */
export function validate(argv: string[]): void {
  shorthandToRun(argv)
  // An empty argv cannot arrive from the route (`cmd` must be a non-empty
  // string), so the missing head takes the same refusal a misspelled command
  // does rather than an IndexError no caller could read.
  const head = argv[0] ?? ''
  const exe = commandName(head)
  if (!ALLOWED_EXES.has(exe)) {
    refuse(403, `command not allowed: ${repr(head)} (allowed: ${sortedList(ALLOWED_EXES)})`)
  }
  if (exe === 'git') {
    validateGit(argv.slice(1))
    return
  }
  if (PACKAGE_MANAGERS.has(exe)) {
    validatePackageManager(exe, argv.slice(1))
    return
  }
  if (exe === 'npx') {
    validateNpx(argv.slice(1))
  }
}

/** The `git` surface: named verbs, per-verb flag guards, a message rule. */
export function validateGit(args: readonly string[]): void {
  const verb = args[0]
  if (verb === undefined) {
    refuse(403, 'git needs a verb')
  }
  if (verb.startsWith('-')) {
    // `git --version` and friends carry no repository risk, but keep the
    // surface honest: only the documented verbs.
    refuse(403, `git verb not allowed: ${repr(verb)}`)
  }
  if (!GIT_VERBS.has(verb)) {
    refuse(403, verbRefusal(verb))
  }
  const body = args.slice(1)
  const allowed = GIT_ALLOWED_FLAGS[verb]
  if (allowed !== undefined) {
    validateRestore(body, allowed)
    return
  }
  const blocked = GIT_BLOCKED_FLAGS[verb] ?? new Set<string>()
  for (const arg of body) {
    if (blocked.has(arg)) {
      refuse(403, `git ${verb} flag not allowed: ${repr(arg)}`)
    }
  }
  if (verb === 'commit' && !hasMessageSource(body)) {
    refuse(
      403,
      "git commit needs a message: pass the inline 'message' field to " +
        '/run, or one of -m/--message/-F/--file/-C/--reuse-message',
    )
  }
}

/**
 * Rewrites `npm test` / `npm start` into `npm run test` / `npm run start`.
 *
 * Done to the argv list in place, before validation and before the long-lane
 * guess, so the shorthand is not a second surface: everything downstream reads
 * the same `run <script>` argv every other script gets. `test` and `start` are
 * the only two names npm itself abbreviates — `npm build` is not a thing — so
 * nothing else is accepted as one.
 */
export function shorthandToRun(argv: string[]): void {
  const head = argv[0]
  if (argv.length < 2 || head === undefined || commandName(head) !== 'npm') {
    return
  }
  const shorthand = argv[1]
  if (shorthand !== undefined && NPM_RUN_SHORTHANDS.has(shorthand)) {
    argv.splice(1, 0, 'run')
  }
}

/**
 * The blocked flag a token sets, if any.
 *
 * Handles the three shapes a flag travels in: `--dir x`, `--dir=x` and a short
 * one attached to its value (`-Cx`), which is why a short blocked flag is
 * matched as a prefix rather than by equality.
 */
export function blockedFlag(token: string, blocked: ReadonlySet<string>): string | null {
  const equals = token.indexOf('=')
  const head = equals >= 0 ? token.slice(0, equals) : token
  if (blocked.has(head)) {
    return head
  }
  for (const short of blocked) {
    if (
      short.startsWith('-') &&
      !short.startsWith('--') &&
      token.startsWith(short) &&
      token.length > short.length
    ) {
      return short
    }
  }
  return null
}

/** Why a retargeting flag is refused, and what the caller meant by it. */
export function flagRefusal(manager: string, flag: string): string {
  const where = manager === 'pnpm' ? 'the pinned working directory' : 'the pinned cwd'
  return (
    `${manager} flag not allowed: ${repr(flag)} — it would run outside ${where} ` +
    '(as a different directory, a workspace root, a workspace package, or the ' +
    "machine's global prefix); the bridge pins one cwd per session and no " +
    'request can retarget it'
  )
}

/** Why `--location=<global>` is refused while `--location=project` is not. */
export function locationRefusal(manager: string, value: string): string {
  return (
    `${manager} flag not allowed: '--location=${value}' — it selects the ` +
    "machine's global prefix, which is outside the pinned project; " +
    "'--location=project' is accepted"
  )
}

/**
 * The value of a `--location` token, in either of its shapes.
 *
 * npm writes it as `--location=global` or as the two tokens
 * `--location global`, so both have to be read to refuse the global one.
 */
export function locationValue(token: string): string | null {
  if (token === PACKAGE_MANAGER_LOCATION_FLAG) {
    return ''
  }
  const equals = token.indexOf('=')
  if (equals >= 0 && token.slice(0, equals) === PACKAGE_MANAGER_LOCATION_FLAG) {
    return token.slice(equals + 1)
  }
  return null
}

/**
 * Refuses a retargeting flag anywhere in a remaining-argv list.
 *
 * Stops at the `--` that ends the manager's own surface: everything after it
 * belongs to the script or binary being run, where a token spelled like a
 * manager flag means something else entirely.
 */
export function checkRetargeting(
  manager: string,
  tokens: readonly string[],
  extra: ReadonlySet<string>,
): void {
  const blocked = new Set([...PACKAGE_MANAGER_BLOCKED_FLAGS, ...extra])
  for (const [index, token] of tokens.entries()) {
    if (token === '--') {
      return
    }
    if (!token.startsWith('-')) {
      continue
    }
    const hit = blockedFlag(token, blocked)
    if (hit !== null) {
      refuse(403, flagRefusal(manager, hit))
    }
    const value = locationValue(token)
    if (value === null) {
      continue
    }
    let selected = value
    if (!selected) {
      const following = tokens[index + 1] ?? ''
      selected = following.startsWith('-') ? '' : following
    }
    if (PACKAGE_MANAGER_GLOBAL_LOCATIONS.has(selected)) {
      refuse(403, locationRefusal(manager, selected))
    }
  }
}

/**
 * The package-manager surface: named verbs, no retargeting, `exec` guarded.
 *
 * The verb list is an allow list (unlike `flutter`/`dart`, which take any
 * subcommand) because the interesting question for a package manager is what it
 * is allowed to touch, and the answer differs per verb — and, for `ls`, per
 * manager.
 */
export function validatePackageManager(manager: string, args: readonly string[]): void {
  const verb = args[0]
  if (verb === undefined) {
    refuse(403, `${manager} needs a verb`)
  }
  const hit = blockedFlag(verb, PACKAGE_MANAGER_BLOCKED_FLAGS)
  if (hit !== null) {
    refuse(403, flagRefusal(manager, hit))
  }
  if (verb.startsWith('-')) {
    refuse(403, `${manager} needs a verb before flags: ${repr(verb)}`)
  }
  // `manager` is one of `PACKAGE_MANAGERS` by construction, so the empty
  // fallback is the record lookup the Python did, not a reachable surface.
  const verbs = PACKAGE_MANAGER_VERBS[manager] ?? new Set<string>()
  if (!verbs.has(verb)) {
    refuse(403, `${manager} verb not allowed: ${repr(verb)} (allowed: ${sortedList(verbs)})`)
  }
  if (verb === 'exec') {
    validateExec(manager, args.slice(1))
    return
  }
  checkRetargeting(manager, args.slice(1), new Set())
}

/**
 * `npx` is an exec form, not a manager: it runs, it does not install.
 *
 * `npx` **is** `npm exec` with the package named implicitly, so it gets the exec
 * narrowing and none of the verbs — there is no `npx install` to allow.
 */
export function validateNpx(args: readonly string[]): void {
  validateExec('npx', args)
}

/**
 * `npm exec`/`npx`/`pnpm exec` may run a project script binary, nothing else.
 *
 * Measured: the exec forms reach `node --version` and `cmd /c echo hi` because
 * they fall back to PATH, and npx fetches what it cannot find. Allowed as-is
 * that would hand out general command execution behind an allowlisted name —
 * the one thing this list exists to prevent (ADR-0001) — so the target has to
 * be a bare script binary name. Anything else is a 403 naming the run verb.
 */
export function validateExec(manager: string, args: readonly string[]): void {
  let target: string | null = null
  for (const token of args) {
    if (token === '--') {
      continue
    }
    if (token.startsWith('-')) {
      checkRetargeting(manager, [token], EXEC_BLOCKED_FLAGS)
      continue
    }
    target = token
    break
  }
  if (target === null) {
    refuse(403, `${manager} needs a script binary to run, e.g. ${manager} vitest run`)
  }
  if (!SCRIPT_BINARIES.has(target)) {
    const substitute =
      manager === 'npm' || manager === 'npx' ? 'npm run <script>' : 'pnpm run <script>'
    refuse(
      403,
      `${manager} exec target not allowed: ${repr(target)} ` +
        `(allowed: ${sortedList(SCRIPT_BINARIES)}) — it runs anything it finds, ` +
        'including things on PATH (and npx fetches what it cannot find), so ' +
        "only the project's own tools are accepted; run a package script " +
        `with '${substitute}' instead`,
    )
  }
}

/** The refusal for an unknown git verb, with the substitute when there is one. */
export function verbRefusal(verb: string): string {
  let message = `git verb not allowed: ${repr(verb)} (allowed: ${sortedList(GIT_VERBS)})`
  if (verb === 'checkout' || verb === 'switch') {
    message += " — to discard worktree changes to named paths, use 'git restore -- <path>'"
  }
  return message
}

/**
 * Whether a flag token sets only allow-listed flags.
 *
 * `--no-X` is the same surface as `--X` (so it is canonicalised), and a short
 * cluster like `-SW`/`-SWq` sets each letter, so each one must be allowed.
 */
export function flagAllowed(token: string, allowed: ReadonlySet<string>): boolean {
  if (token.startsWith('--')) {
    return allowed.has(`--${token.slice(2).replace(/^no-/u, '')}`)
  }
  if (token.length > 2) {
    return [...token.slice(1)].every((char) => allowed.has(`-${char}`))
  }
  return allowed.has(token)
}

/**
 * Whether a pathspec would escape the worktree, in any of the three shapes
 * Python refused here.
 *
 * `os.path.isabs` (a drive *and* a root, a UNC share, or a leading separator),
 * `os.path.splitdrive` (also truthy for a drive-relative `C:lib/a.dart`) and
 * the explicit `spec[0] in "/\\"` check that catches a rooted path on Windows —
 * where `os.path.isabs` is false, yet git would still resolve it against the
 * drive. All three raise the same message, so folding them into one condition
 * changes nothing a caller or a test can see.
 */
function escapesWorktree(spec: string): boolean {
  return /^[A-Za-z]:/u.test(spec) || spec.startsWith('/') || spec.startsWith('\\')
}

/**
 * Refuses any pathspec that is not a literal path inside the worktree.
 *
 * `git restore` discards uncommitted work irrecoverably, so the only shape this
 * bridge accepts is "these named files, please": no pathspec magic, no globs,
 * no absolute paths, no `..`, and no bare `.` (which is the whole worktree).
 */
export function guardRestorePathspec(spec: string): void {
  if (!spec) {
    refuse(403, 'git restore pathspec must not be empty')
  }
  if (spec.startsWith(':')) {
    refuse(403, `git restore pathspec magic is not allowed: ${repr(spec)}`)
  }
  if (escapesWorktree(spec)) {
    refuse(403, `git restore pathspec must be relative: ${repr(spec)}`)
  }
  const wildcard = [...new Set([...spec].filter((char) => PATHSPEC_WILDCARDS.has(char)))].sort()
  if (wildcard.length > 0) {
    refuse(
      403,
      'git restore pathspec must name files, not a pattern: ' +
        `${repr(spec)} contains ${repr(wildcard.join(''))}`,
    )
  }
  const parts = spec.split(/[\\/]/u).filter((part) => part !== '' && part !== '.')
  if (parts.length === 0 || parts.includes('..')) {
    refuse(
      403,
      'git restore pathspec must name files inside the working ' +
        `directory: ${repr(spec)}`,
    )
  }
}

/** The `restore` surface: an allow-listed flag set and literal pathspecs. */
export function validateRestore(args: readonly string[], allowed: ReadonlySet<string>): void {
  const pathspecs: string[] = []
  let afterSeparator = false
  for (const token of args) {
    if (afterSeparator) {
      pathspecs.push(token)
      continue
    }
    if (token === '--') {
      afterSeparator = true
      continue
    }
    if (token.startsWith('-')) {
      if (!flagAllowed(token, allowed)) {
        refuse(403, `git restore flag not allowed: ${repr(token)}`)
      }
      continue
    }
    pathspecs.push(token)
  }
  if (pathspecs.length === 0) {
    refuse(
      403,
      'git restore needs at least one explicit path, e.g.' +
        ' git restore -- lib/main.dart',
    )
  }
  for (const spec of pathspecs) {
    guardRestorePathspec(spec)
  }
}

/** Whether a `git commit` argv already carries a message. */
export function hasMessageSource(args: readonly string[]): boolean {
  for (const token of args) {
    const equals = token.indexOf('=')
    const head = equals >= 0 ? token.slice(0, equals) : token
    if (MESSAGE_SOURCE_FLAGS.has(head)) {
      return true
    }
  }
  return false
}

/**
 * Assembles the argv, folding an inline commit message in as `-m <text>`.
 *
 * `-m` rather than a temp file or stdin: no file exists for a later
 * `git add -A` to sweep up (the incident this closes), nothing to clean up, and
 * no pipe to deadlock on. The message therefore travels as argv — UTF-8 through
 * JSON, never through a shell or a pwsh `Set-Content`.
 */
export function buildArgv(
  cmd: string,
  args: readonly string[],
  message: string | null,
): string[] {
  if (message === null) {
    return [cmd, ...args]
  }
  if (typeof message !== 'string') {
    refuse(403, "'message' must be a string")
  }
  if (!message.trim()) {
    refuse(403, "'message' must not be empty")
  }
  const head = args[0]
  if (commandName(cmd) !== 'git' || head === undefined || head !== 'commit') {
    refuse(403, "'message' is only valid for git commit")
  }
  const body = args.slice(1)
  for (const token of body) {
    const equals = token.indexOf('=')
    const flag = equals >= 0 ? token.slice(0, equals) : token
    if (MESSAGE_SOURCE_FLAGS.has(flag)) {
      refuse(403, `pass the commit message either inline or as ${repr(token)}, not both`)
    }
  }
  return [cmd, 'commit', '-m', message, ...body]
}

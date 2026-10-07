/**
 * Reading an argv back: what command is this, and does it run a test runner?
 *
 * These are the questions the digest and the long-lane guess ask *before*
 * looking at a log, so they live apart from both: resolution needs
 * `commandName`, the digest needs the exec-form peel, and neither should have to
 * import the other.
 */

import { PACKAGE_MANAGERS, PACKAGE_MANAGER_RUNNERS } from './surface'

/** The bare tool name behind a path or a Windows wrapper suffix. */
export function commandName(cmd: string): string {
  const lastSlash = Math.max(cmd.lastIndexOf('/'), cmd.lastIndexOf('\\'))
  let exe = (lastSlash >= 0 ? cmd.slice(lastSlash + 1) : cmd).toLowerCase()
  for (const suffix of ['.bat', '.exe', '.cmd']) {
    if (exe.endsWith(suffix)) {
      exe = exe.slice(0, -suffix.length)
      break
    }
  }
  return exe
}

/** Whether argv is a `flutter test` / `dart test` invocation. */
export function isTestRun(argv: readonly string[]): boolean {
  if (argv.length < 2) return false
  const first = argv[0]
  const second = argv[1]
  if (first === undefined || second === undefined) return false
  return (commandName(first) === 'flutter' || commandName(first) === 'dart') && second === 'test'
}

/**
 * Peel an exec form: the script binary it runs, and its own arguments.
 *
 * `pnpm exec vitest run`, `npm exec vitest run` and `npx vitest run` all mean
 * "run the project's vitest", so they are one shape with three spellings.
 * Returns undefined for anything else, including an exec form with no target or
 * one whose target is a flag.
 */
export function execTarget(argv: readonly string[]): { target: string; args: string[] } | undefined {
  const first = argv[0]
  if (first === undefined) return undefined
  const name = commandName(first)
  let rest: readonly string[]
  if (name === 'npx') {
    rest = argv.slice(1)
  } else if (PACKAGE_MANAGERS.has(name) && argv[1] === 'exec') {
    rest = argv.slice(2)
  } else {
    return undefined
  }
  const positional = rest.filter((token) => token !== '--')
  const head = positional[0]
  if (head === undefined || head.startsWith('-')) return undefined
  return { target: commandName(head), args: positional.slice(1) }
}

/**
 * Whether argv certainly runs vitest — the binary, or an exec form of it.
 *
 * `pnpm run test` (and `npm run test`, or the `npm test` shorthand) also runs
 * vitest and cannot be told from the argv, which is what `mightRunVitest` plus
 * the log sniff are for.
 */
export function isVitestRun(argv: readonly string[]): boolean {
  const first = argv[0]
  if (first === undefined) return false
  if (commandName(first) === 'vitest') return true
  const peeled = execTarget(argv)
  return peeled !== undefined && peeled.target === 'vitest'
}

/**
 * Whether argv *could* be a vitest run without naming it.
 *
 * Only a gate for the content sniff, so a `git log` or `dart analyze` job never
 * opens its log looking for a reporter it cannot have.
 */
export function mightRunVitest(argv: readonly string[]): boolean {
  const first = argv[0]
  return first !== undefined && (PACKAGE_MANAGER_RUNNERS.has(commandName(first)) || commandName(first) === 'vitest')
}

/**
 * Split a reporter `path: name` description, if it really has a path.
 *
 * A single-file run prints no path at all (`printPath` is on only when more than
 * one test file was selected) and a test name may contain a colon, so the head
 * has to *look* like a path: end in `.dart` or contain a separator.
 */
export function splitPathAndName(text: string): { file: string | null; name: string } {
  const separator = text.indexOf(': ')
  if (separator >= 0) {
    const head = text.slice(0, separator)
    const tail = text.slice(separator + 2)
    if (head.includes('/') || head.includes('\\') || head.endsWith('.dart')) {
      return { file: head, name: tail }
    }
  }
  return { file: null, name: text }
}

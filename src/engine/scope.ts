/**
 * The uncommitted scope: which files it selects, and how it reaches a command.
 *
 * "Uncommitted" is the caller's word for everything that is not in HEAD yet —
 * staged, unstaged and untracked alike — so the answer comes from `git status`,
 * never from a guess this module could make. The file list is computed at submit
 * time, and an empty one is *refused* rather than widened: `dart format` with no
 * paths rewrites the whole tree, which is the one outcome the scope exists to
 * prevent, and a job whose scope quietly did nothing would be worse than no
 * scope at all.
 */

import { execFile } from 'node:child_process'
import type { ExecFileException } from 'node:child_process'
import { commandName } from './argv'
import { TOOL_ENV_OVERRIDES } from './env'
import { RefusalError } from './errors'
import {
  GIT_STATUS_TIMEOUT_MS,
  SCOPE_COMMANDS,
  SCOPE_EXPAND_VERBS,
  SCOPE_FILE_SUFFIX,
  SCOPE_FILTER_VERBS,
} from './surface'
import type { ScopeMode } from './types'

/** The exact argv `git status` is read with — an argv list, never a shell. */
const GIT_STATUS_ARGV: readonly string[] = [
  '--no-optional-locks',
  'status',
  '--porcelain=v1',
  '-z',
  '--untracked-files=all',
]

/**
 * The paths of files that are uncommitted in `git status --porcelain -z`.
 *
 * The `-z` form is the one to parse: records are NUL-separated and paths are
 * never quoted, so a CJK filename arrives as itself instead of as a
 * `\NNN`-escaped string (verified against git on Windows). A record is
 * ``XY <path>``; for a rename or copy the **destination comes first** and the
 * source path rides in the following bare record, which is skipped.
 *
 * Deleted and ignored entries are dropped — the question a scope answers is
 * "which files can be formatted or analyzed right now", and neither can.
 */
export function parsePorcelain(data: string): string[] {
  const paths: string[] = []
  const records = data.split('\0')
  let index = 0
  while (index < records.length) {
    const record = records[index] ?? ''
    index += 1
    // Shorter than `XY ` plus one character cannot carry a path at all.
    if (record.length < 4) continue
    const status = record.slice(0, 2)
    const path = record.slice(3)
    if (status === '??') {
      paths.push(path)
      continue
    }
    if (status === '!!') continue
    const kind = status.charAt(0)
    if (kind === 'R' || kind === 'C') index += 1 // the source path, not what is on disk now
    if (status.includes('D') || path === '') continue
    paths.push(path)
  }
  return paths
}

/** The refusal a `git status` that did not answer is reported with. */
function gitStatusError(error: ExecFileException, stderr: string): RefusalError {
  if (error.killed === true) {
    return new RefusalError(
      400,
      `git status timed out after ${GIT_STATUS_TIMEOUT_MS / 1000}s`,
    )
  }
  if (typeof error.code === 'number') {
    const detail = stderr.trim()
    return new RefusalError(
      400,
      `git status failed (exit ${error.code}): ${detail === '' ? 'no detail' : detail}`,
    )
  }
  return new RefusalError(400, `git status could not run: ${error.message}`)
}

/**
 * `git status --porcelain -z --untracked-files=all` in the pinned cwd.
 *
 * `--no-optional-locks` keeps it from refreshing the index: this runs while the
 * single worker may be running a `git` job of its own, and fighting over
 * `index.lock` would turn a read into a spurious failure. A refusal carries
 * git's own message, so the caller learns whether the directory is not a
 * repository, git is missing, or the read simply took too long — every one of
 * which is answered by dropping the scope, not by scoping nothing.
 */
export function runGitStatus(cwd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      'git',
      GIT_STATUS_ARGV,
      {
        cwd,
        timeout: GIT_STATUS_TIMEOUT_MS,
        // The counterpart of `creationflags=CREATE_NO_WINDOW`: a console would
        // flash on every scoped request.
        windowsHide: true,
        encoding: 'utf8',
        // No credential prompt: this process has no terminal to answer one, so
        // a prompt would cost the whole request. The colour overrides ride along
        // for the same reason they do on a job: whatever this returns is parsed
        // and shown, and terminal bytes in it are nobody's friend.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...TOOL_ENV_OVERRIDES },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout)
          return
        }
        reject(gitStatusError(error, stderr))
      },
    )
  })
}

/** The `git status` reader a scoped request uses; injectable so tests never shell out. */
export type RunGit = (cwd: string) => Promise<string>

/**
 * The uncommitted `.dart` files under `cwd`, sorted and deduplicated.
 *
 * Staged, unstaged and untracked alike: "uncommitted" is the caller's word for
 * everything that is not in HEAD yet. Refuses rather than returning an empty
 * list when git cannot answer, because "nothing is uncommitted" and "the answer
 * never arrived" must not lead to the same job.
 */
export async function uncommittedDartFiles(
  cwd: string,
  runGit?: RunGit,
): Promise<string[]> {
  const status = await (runGit ?? runGitStatus)(cwd)
  const wanted = new Set(
    parsePorcelain(status).filter((path) => path.endsWith(SCOPE_FILE_SUFFIX)),
  )
  return [...wanted].sort()
}

/**
 * How a scope applies to this command: `expand`, `filter`, or null.
 *
 * `expand` is `dart format` alone, because it takes any number of trailing
 * paths, so the files are appended to argv and the tool itself is narrowed.
 * `analyze`/`fix` can only take a `filter`: `dart analyze` accepts at most one
 * directory and `dart fix` takes no path at all, so no argv can express "these
 * files" — the scope narrows the *reported* lines instead, and the exit code
 * still covers the whole project.
 *
 * Null means the command cannot be scoped at all and the caller must refuse it,
 * rather than queue a job whose scope quietly did nothing.
 */
export function scopeMode(cmd: string, args: readonly string[]): ScopeMode | null {
  const verb = args[0]
  if (!SCOPE_COMMANDS.has(commandName(cmd)) || verb === undefined) return null
  if (SCOPE_FILTER_VERBS.has(verb)) return 'filter'
  if (commandName(cmd) === 'dart' && SCOPE_EXPAND_VERBS.has(verb)) return 'expand'
  return null
}

/** Why this command cannot take an uncommitted scope, and what can. */
export function scopeRefusal(cmd: string, args: readonly string[]): string {
  const verb = args[0] ?? ''
  return (
    `scope is not supported for ${cmd} ${verb}`.trimEnd() +
    ' (scoped: dart format — it expands to the uncommitted files;' +
    ' dart/flutter analyze and fix — they filter their output to them)'
  )
}

/**
 * A regex matching any of `paths`, for filtering a tool's log lines.
 *
 * Escaped, because a path is data: `.` must not match anything, and the forward
 * slashes git reports are exactly the form the analyzer prints. The line
 * terminators a POSIX filename may carry are escaped too — a raw one is not
 * valid in a pattern.
 */
export function pathFilterRegex(paths: readonly string[]): RegExp {
  return new RegExp(paths.map(escapeRegexLiteral).join('|'))
}

/** One path as regex source: every metacharacter it may contain, escaped. */
function escapeRegexLiteral(path: string): string {
  return path.replace(/[.*+?^${}()|[\]\\\n\r\u2028\u2029]/gu, (character) => {
    switch (character) {
      case '\n':
        return '\\n'
      case '\r':
        return '\\r'
      case '\u2028':
        return '\\u2028'
      case '\u2029':
        return '\\u2029'
      default:
        return `\\${character}`
    }
  })
}

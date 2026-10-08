/**
 * Ending a job's whole process tree, not only the process this plugin owns.
 *
 * `child.kill()` reaches exactly one process, and on Windows nothing else
 * follows it down. Killing `dart.exe flutter_tools.snapshot test` left its
 * `flutter_tester.exe` children running, and those are the processes a Flutter
 * test run gives its native assets to: measured in a real session on
 * 2026-10-08, a `flutter test` job was killed at 14:41:49 and the two testers
 * it had started (14:40:16, 14:41:48) were still alive 1h20m later, one of them
 * holding `build\native_assets\windows\sqlite3.dll` mapped as an image section.
 * Windows refuses to delete a mapped image, so every later `flutter test` in
 * that project died in its native-asset step with
 *
 *     Flutter failed to delete file at "...\build\native_assets\windows\sqlite3.dll"
 *
 * and the holder could not be found from inside the file sandbox at all — its
 * `taskkill /m` is denied and 25 of 27 processes refuse a module-list read —
 * which is what made four consecutive failed runs look like a mystery lock.
 *
 * The mechanism here is `taskkill /T /F`, and what makes it usable is the same
 * thing that makes this plugin exist: the bridge runs in the host process,
 * outside the file sandbox, so the processes it starts — and the `taskkill` it
 * starts to end them — are unconfined. Measured, not assumed: a `flutter test`
 * job wrote into its project's `build/` in the very minutes a sandboxed `pwsh`
 * was refused the same write.
 *
 * ADR-0004 recorded the opposite measurement and was right for its subject: the
 * retired server *was* a sandboxed process, so its `taskkill` inherited the
 * restriction and answered "access denied" while the target was alive. That is
 * why the owned handle is still the fallback and this sweep is not the only
 * kill — see `ProcessRun.cancel`, where the sweep runs first, because
 * `taskkill /T` walks the parent-child chain from the root and a root this
 * process already terminated leaves it nothing to walk.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** One tree-kill attempt: whether it worked, and why not when it did not. */
export interface TreeKill {
  ok: boolean
  detail: string | null
}

/** Kill one process and everything below it. Never rejects. */
export type TreeKillFn = (pid: number) => Promise<TreeKill>

/** The `spawn` shape this module needs, injectable so a test owns the helper. */
export type HelperSpawn = (command: string, args: readonly string[]) => ChildProcess

/** How long a sweep may take before it is called off and reported as failed. */
export const TREE_KILL_TIMEOUT_MS = 10_000

/** How much of `taskkill`'s stderr a detail line keeps. */
const DETAIL_MAX_CHARS = 400

/** The tree kill for a platform whose processes do not form a tree to sweep. */
export const NO_TREE_KILL: TreeKillFn = () => Promise.resolve({ ok: true, detail: null })

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Flatten a helper's stderr into one bounded line. */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().slice(0, DETAIL_MAX_CHARS)
}

/**
 * The `taskkill.exe` to run: `%SystemRoot%\System32\taskkill.exe`, or null.
 *
 * The absolute path is used rather than `PATH`'s `taskkill`, so the one command
 * whose whole job is to end processes cannot itself be replaced by a `PATH`
 * entry. `windir` is the older spelling of the same variable and is read for
 * the reason `PATHEXT` is in `resolve.ts`: the machine states it, we do not
 * invent it.
 * @param env - the environment to read, injectable for tests.
 * @param exists - the existence probe, injectable for tests.
 * @returns the absolute helper path, or null when this machine does not state one.
 */
export function taskkillExe(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const root = env['SystemRoot'] ?? env['windir'] ?? ''
  if (root === '') return null
  const candidate = join(root, 'System32', 'taskkill.exe')
  return exists(candidate) ? candidate : null
}

function spawnTaskkill(command: string, args: readonly string[]): ChildProcess {
  return spawn(command, [...args], {
    // Only stderr is read: it carries the reason a kill was refused ("Access is
    // denied", "not found"), while stdout is a human line nothing parses.
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
}

/**
 * Kill `pid` and its descendants with `taskkill /T /F`.
 *
 * Callers must start this while the root is still alive — the sweep walks the
 * parent-child chain from it — and must not treat its failure as the end of the
 * kill: a refused sweep is a reason to fall back to the handle they own, and
 * `detail` is what the job log records either way.
 * @param command - the resolved `taskkill.exe`.
 * @param pid - the root of the tree.
 * @param options - injectable helper and timeout, for tests.
 * @returns the outcome; a refused, missing or slow helper is reported, never thrown.
 */
export function taskkillTree(
  command: string,
  pid: number,
  options: { spawn?: HelperSpawn; timeoutMs?: number } = {},
): Promise<TreeKill> {
  const spawnHelper = options.spawn ?? spawnTaskkill
  const timeoutMs = options.timeoutMs ?? TREE_KILL_TIMEOUT_MS
  return new Promise<TreeKill>((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (value: TreeKill): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(value)
    }
    let child: ChildProcess
    try {
      child = spawnHelper(command, ['/T', '/F', '/PID', String(pid)])
    } catch (error) {
      // A spawn that cannot even create its stdio is a failure like any other:
      // the caller's own handle is the fallback, and the job still settles.
      resolve({ ok: false, detail: `cannot start taskkill: ${describe(error)}` })
      return
    }
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < DETAIL_MAX_CHARS) stderr += chunk.toString('utf8')
    })
    child.on('error', (error: Error) => {
      finish({ ok: false, detail: `taskkill failed: ${error.message}` })
    })
    child.on('close', (code: number | null) => {
      if (code === 0) {
        finish({ ok: true, detail: null })
        return
      }
      const reason = oneLine(stderr)
      finish({
        ok: false,
        detail: `taskkill exited ${String(code)}${reason === '' ? '' : `: ${reason}`}`,
      })
    })
    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // A helper that will not die must not hold the job open.
      }
      finish({ ok: false, detail: `taskkill did not finish within ${timeoutMs} ms` })
    }, timeoutMs)
    // A pending sweep must not be the reason a process stays alive: the job
    // settles on its own schedule and this timer only bounds the helper.
    timer.unref()
  })
}

/**
 * The tree kill this platform gets.
 *
 * Windows only, deliberately, on the same terms as `resolve.ts`: a POSIX branch
 * would be a second code path nobody has exercised, and the process-group
 * signal it would need is not what a caller of this module asked for. A missing
 * helper is reported rather than skipped, because "nothing was swept" is
 * exactly the state that leaves an orphan holding a file.
 * @returns the sweep to hand to {@link ProcessRun}, or the no-op.
 */
export function defaultTreeKill(): TreeKillFn {
  if (process.platform !== 'win32') return NO_TREE_KILL
  const command = taskkillExe()
  if (command === null) {
    return () =>
      Promise.resolve({
        ok: false,
        detail: 'taskkill.exe is not under %SystemRoot%\\System32, so the process tree was not swept',
      })
  }
  return (pid: number) => taskkillTree(command, pid)
}

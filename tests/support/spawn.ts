/**
 * Shared measurements a spec needs before it can claim anything.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

/**
 * Whether this process may start a child with piped stdio at all.
 *
 * The DSH file sandbox denies the named pipes libuv needs for that, so the
 * answer is no under `workspace-write` and yes in CI — and the bridge, which is
 * where these specs are normally run from, is outside the sandbox. Measuring it
 * keeps a case honest: a skip says "not measurable in this environment", never
 * "passed".
 * @returns whether a piped child can be started here.
 */
export async function canSpawnPiped(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve(false)
      return
    }
    child.on('error', () => resolve(false))
    child.on('close', () => resolve(true))
  })
}

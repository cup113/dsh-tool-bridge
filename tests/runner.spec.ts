/**
 * `ProcessRun`: the log it writes, the exit it settles on, and the kill that
 * has to reach further than the process it owns.
 *
 * The fake-child cases are about the *shape* of a settlement — that a kill is
 * still a kill, that a refused tree sweep is recorded rather than swallowed, and
 * especially that settlement does not happen before the sweep does. That last
 * one is a real invariant, not a detail: the lanes serialize on settlement, so a
 * job that settles while its children are still running lets the next build
 * start on top of them — which is how two `flutter test` runs came to share one
 * `build\native_assets` directory in the first place.
 *
 * The last case is the drill, and it is the reason this file matters: it starts
 * a real grandchild, kills the tree, and asks the OS whether the grandchild is
 * gone. It measures whether a piped child can be started at all before it
 * claims anything, because this suite runs inside the DSH file sandbox, where
 * that spawn is denied (`EPERM`) — the boundary the bridge itself lives on the
 * other side of. Confined, the drill reports itself skipped; in CI, where
 * nothing is confined, it is the test that fails if the tree kill regresses.
 */

import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ToolFailure } from '../src/engine/errors'
import { ProcessRun } from '../src/host/runner'
import type { RunSettlement } from '../src/host/runner'
import type { TreeKill, TreeKillFn } from '../src/host/killtree'
import { canSpawnPiped } from './support/spawn'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRATCH = join(HERE, '.tmp-runner')

/** A child process with no OS behind it: the two streams and the events used. */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killCalls = 0

  constructor(readonly pid: number | undefined = 4242) {
    super()
  }

  kill(): boolean {
    this.killCalls += 1
    return true
  }

  out(text: string): void {
    this.stdout.emit('data', Buffer.from(text, 'utf8'))
  }

  err(text: string): void {
    this.stderr.emit('data', Buffer.from(text, 'utf8'))
  }

  close(code: number | null): void {
    this.exitCode = code
    this.emit('close', code)
  }
}

/** Let every already-queued callback and one round of fs work run. */
function flush(ms = 25): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The settlement as it stands, without awaiting it (undefined = still pending). */
function observed(run: ProcessRun): { value: RunSettlement | undefined } {
  const box: { value: RunSettlement | undefined } = { value: undefined }
  void run.settled.then((value) => {
    box.value = value
  })
  return box
}

let counter = 0
/**
 * A fresh log path per case, with any file from an interrupted earlier run
 * removed first: the runner appends on purpose (one log per job in production),
 * so a leftover file would otherwise leak its lines into this run's assertion.
 */
function newLogPath(name: string): string {
  counter += 1
  const path = join(SCRATCH, `${counter}-${name}.log`)
  rmSync(path, { force: true })
  return path
}

describe('ProcessRun: one run, one log, one settlement', () => {
  beforeAll(() => {
    mkdirSync(SCRATCH, { recursive: true })
  })

  afterAll(() => {
    rmSync(SCRATCH, { recursive: true, force: true })
  })

  it('combines both streams into the log and settles on the exit code', async () => {
    const child = new FakeChild()
    const logPath = newLogPath('combined')
    const run = new ProcessRun(['prog', 'arg'], SCRATCH, {}, logPath, {
      spawnProcess: () => child as unknown as ChildProcess,
      killTree: () => Promise.resolve({ ok: true, detail: null }),
    })
    run.start()
    child.out('out line\n')
    child.err('err line\n')
    child.close(3)
    await expect(run.settled).resolves.toEqual({ exitCode: 3, killed: false, error: null })
    expect(readFileSync(logPath, 'utf8')).toBe('out line\nerr line\n')
  })

  it('reports a process that could not start, and still settles', async () => {
    const run = new ProcessRun(['nope'], SCRATCH, {}, newLogPath('nostart'), {
      spawnProcess: () => {
        throw new Error('spawn EPERM')
      },
      killTree: () => Promise.resolve({ ok: true, detail: null }),
    })
    expect(() => run.start()).toThrow(ToolFailure)
    await expect(run.settled).resolves.toEqual({
      exitCode: null,
      killed: false,
      error: 'cannot start nope: Error: spawn EPERM',
    })
  })

  it('sweeps the tree of the pid it started, and keeps the owned kill', async () => {
    const child = new FakeChild(9001)
    const swept: number[] = []
    const run = new ProcessRun(['prog'], SCRATCH, {}, newLogPath('sweep'), {
      spawnProcess: () => child as unknown as ChildProcess,
      killTree: (pid) => {
        swept.push(pid)
        return Promise.resolve({ ok: true, detail: null })
      },
    })
    run.start()
    expect(run.cancel()).toBe(true)
    expect(swept).toEqual([9001])
    await flush()
    expect(child.killCalls).toBe(1)
    child.close(null)
    await expect(run.settled).resolves.toEqual({ exitCode: null, killed: true, error: null })
  })

  it('walks the tree before ending the root, so the sweep can still find it', async () => {
    // The order is the whole mechanism: `taskkill /T` resolves the root's pid
    // when it runs, so a root ended first leaves the walk nothing to walk — the
    // measured failure was `taskkill exited 128: process not found`, with every
    // descendant missed.
    const child = new FakeChild(9002)
    let release: ((value: TreeKill) => void) | undefined
    const sweeps = new Promise<TreeKill>((resolve) => {
      release = resolve
    })
    const run = new ProcessRun(['prog'], SCRATCH, {}, newLogPath('order'), {
      spawnProcess: () => child as unknown as ChildProcess,
      killTree: () => sweeps,
    })
    run.start()
    run.cancel()
    await flush()
    expect(child.killCalls).toBe(0)
    release?.({ ok: true, detail: null })
    await flush()
    expect(child.killCalls).toBe(1)
    child.close(null)
    await run.settled
  })

  it('waits for the sweep before settling, so the lane cannot move on early', async () => {
    const child = new FakeChild()
    let release: ((value: TreeKill) => void) | undefined
    const sweeps = new Promise<TreeKill>((resolve) => {
      release = resolve
    })
    const run = new ProcessRun(['prog'], SCRATCH, {}, newLogPath('deferred'), {
      spawnProcess: () => child as unknown as ChildProcess,
      killTree: () => sweeps,
    })
    run.start()
    run.cancel()
    child.close(null)
    const seen = observed(run)
    await flush()
    expect(seen.value).toBeUndefined()
    release?.({ ok: true, detail: null })
    await expect(run.settled).resolves.toEqual({ exitCode: null, killed: true, error: null })
  })

  it('records a refused sweep in the log, with the reason the helper gave', async () => {
    const child = new FakeChild()
    const logPath = newLogPath('refused')
    const run = new ProcessRun(['prog'], SCRATCH, {}, logPath, {
      spawnProcess: () => child as unknown as ChildProcess,
      killTree: () => Promise.resolve({ ok: false, detail: 'taskkill exited 5: Access is denied.' }),
    })
    run.start()
    child.out('working...\n')
    run.cancel()
    child.close(null)
    await run.settled
    expect(readFileSync(logPath, 'utf8')).toBe(
      'working...\n[toolbridge] taskkill exited 5: Access is denied.\n',
    )
  })

  it('records a sweep that threw, and settles anyway', async () => {
    const child = new FakeChild()
    const logPath = newLogPath('threw')
    const run = new ProcessRun(['prog'], SCRATCH, {}, logPath, {
      spawnProcess: () => child as unknown as ChildProcess,
      killTree: () => Promise.reject(new Error('boom')),
    })
    run.start()
    run.cancel()
    child.close(null)
    await expect(run.settled).resolves.toEqual({ exitCode: null, killed: true, error: null })
    expect(readFileSync(logPath, 'utf8')).toBe('[toolbridge] process tree was not swept: Error: boom\n')
  })

  it('settles a kill that lands before the process exists, without sweeping', async () => {
    let killed = false
    const run = new ProcessRun(['prog'], SCRATCH, {}, newLogPath('queued'), {
      killTree: () => {
        killed = true
        return Promise.resolve({ ok: true, detail: null })
      },
    })
    expect(run.cancel()).toBe(false)
    expect(killed).toBe(false)
    await expect(run.settled).resolves.toEqual({ exitCode: null, killed: true, error: null })
  })

  it('does not sweep a process that has already exited', async () => {
    const child = new FakeChild()
    let sweeps = 0
    const run = new ProcessRun(['prog'], SCRATCH, {}, newLogPath('gone'), {
      spawnProcess: () => child as unknown as ChildProcess,
      killTree: () => {
        sweeps += 1
        return Promise.resolve({ ok: true, detail: null })
      },
    })
    run.start()
    child.close(0)
    await run.settled
    expect(run.cancel()).toBe(false)
    expect(sweeps).toBe(0)
    expect(child.killCalls).toBe(0)
  })
})

/* ------------------------------------------------------------------ the drill */

/** Whether a pid is still there, asked of the OS rather than of our own bookkeeping. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Best-effort cleanup for a process this suite started and no longer wants. */
function reap(pid: number): void {
  if (!isAlive(pid)) return
  try {
    process.kill(pid)
  } catch {
    // Already gone between the check and the kill.
  }
}

/**
 * One real two-level process tree, with the grandchild's pid read back.
 *
 * The grandchild is **detached**, and the drill does not work without that. The
 * shape it has to model is a descendant that a single-process kill leaves
 * running — which is what the incident's orphaned `flutter_tester.exe` was, and
 * what a plain `child.kill()` of this root also leaves. Measured here: an
 * *attached* grandchild dies with its node parent even when nothing sweeps the
 * tree, so a drill built on one passes with the tree kill deleted. The control
 * half below asserts exactly this, so the day the shape stops meaning that, the
 * drill says so instead of going quietly vacuous.
 * @returns the run, the root's pid, and the grandchild's pid.
 */
async function startTree(): Promise<{ run: ProcessRun; rootPid: number; grandchildPid: number }> {
  const dir = join(SCRATCH, 'drill')
  mkdirSync(dir, { recursive: true })
  const logPath = newLogPath('drill')
  const script = [
    "const { spawn } = require('node:child_process')",
    "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: true })",
    'g.unref()',
    "console.log('GRANDCHILD ' + g.pid)",
    'setTimeout(() => {}, 60000)',
  ].join('; ')
  const run = new ProcessRun([process.execPath, '-e', script], dir, process.env, logPath)
  run.start()
  const rootPid = run.pid
  if (rootPid === undefined) throw new Error('the drill could not read the root pid')
  for (let i = 0; i < 100; i += 1) {
    await flush(50)
    const match = /GRANDCHILD (\d+)/u.exec(readFileSync(logPath, 'utf8'))
    if (match?.[1] !== undefined) return { run, rootPid, grandchildPid: Number(match[1]) }
  }
  throw new Error('the drill never saw the grandchild pid')
}

/** Poll until a pid is gone, or report that it stayed. Two seconds is the whole budget. */
async function waitGone(pid: number, attempts = 40): Promise<boolean> {
  for (let i = 0; i < attempts && isAlive(pid); i += 1) await flush(50)
  return !isAlive(pid)
}

describe('the drill: a killed run leaves nothing of its tree behind', () => {
  // Real processes, real waits, and a failure path that spends both polling
  // budgets; the default five seconds is not enough room to fail legibly.
  it(
    'ends a grandchild that a single-process kill leaves standing',
    { timeout: 30_000 },
    async () => {
    if (process.platform !== 'win32') {
      console.warn('runner drill skipped: the tree sweep is Windows-only by design (kernel32 taskkill /T)')
      return
    }
    if (!(await canSpawnPiped())) {
      // Not a pass and not a failure: this environment cannot start the shape
      // being measured (see `canSpawnPiped`). CI runs it for real.
      console.warn('runner drill skipped: this environment denies a child with piped stdio')
      return
    }

    // Half one: the shape itself. The root is killed by the same primitive
    // `child.kill()` uses and nothing sweeps anything, so a grandchild that dies
    // here would make half two unable to tell a working tree kill from a missing
    // one — which is a fact about this environment worth failing over, because a
    // drill that cannot fail guards nothing.
    const control = await startTree()
    let plainKillReachedIt: boolean
    try {
      process.kill(control.rootPid)
      await control.run.settled
      plainKillReachedIt = await waitGone(control.grandchildPid, 4)
    } finally {
      reap(control.grandchildPid)
    }
    expect(
      plainKillReachedIt,
      'the drill lost its meaning: a plain single-process kill already reaped the detached grandchild, so this case cannot fail when the tree kill is removed',
    ).toBe(false)

    // Half two: the same tree, ended through the runner. Everything the sweep is
    // for has to be gone by the time the run settles, because settlement is what
    // releases the lane.
    const subject = await startTree()
    try {
      expect(isAlive(subject.grandchildPid), 'the grandchild never started').toBe(true)
      subject.run.cancel()
      await subject.run.settled
      expect(
        await waitGone(subject.grandchildPid),
        'the grandchild outlived the run: the tree sweep never reached it',
      ).toBe(true)
    } finally {
      reap(subject.grandchildPid)
    }
    },
  )
})

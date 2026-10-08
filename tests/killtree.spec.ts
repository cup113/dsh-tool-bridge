/**
 * The tree kill: what it runs, what it reports, and what it does when it cannot
 * run at all.
 *
 * The bug these cases exist for is not subtle in its consequences — a killed
 * `flutter test` left testers holding `build\native_assets\windows\sqlite3.dll`
 * mapped, and every later run in that project died deleting it — but its code
 * path is entirely about *failure* modes: a helper that is missing, refused, or
 * slow. So each case here replaces the helper and asserts the reported fact,
 * because a sweep that fails silently is exactly the state that made the
 * original lock take an hour to explain.
 */

import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'

import {
  NO_TREE_KILL,
  TREE_KILL_TIMEOUT_MS,
  defaultTreeKill,
  taskkillExe,
  taskkillTree,
} from '../src/host/killtree'
import type { HelperSpawn } from '../src/host/killtree'

/** A child that never had real stdio, with the two events this module listens for. */
class FakeHelper extends EventEmitter {
  readonly stderr = new EventEmitter()
  killed = false
  readonly calls: string[][]

  constructor(calls: string[][]) {
    super()
    this.calls = calls
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  settle(code: number | null, err: string): void {
    if (err !== '') this.stderr.emit('data', Buffer.from(err, 'utf8'))
    this.emit('close', code)
  }
}

/**
 * A `spawn` stand-in that hands back one fake helper and records the argv.
 *
 * The scripted outcome lands on a timer, never synchronously: a real helper
 * cannot exit before its parent has attached a listener, and a fake that does
 * would test a race the real one cannot have.
 */
function helperSpawn(onSpawn?: (helper: FakeHelper) => void): { spawn: HelperSpawn; helpers: FakeHelper[] } {
  const helpers: FakeHelper[] = []
  const spawn: HelperSpawn = (_command, args) => {
    const helper = new FakeHelper([[...args]])
    helpers.push(helper)
    if (onSpawn !== undefined) setTimeout(() => onSpawn(helper), 0)
    return helper as unknown as ChildProcess
  }
  return { spawn, helpers }
}

describe('taskkillExe: the helper is named by the machine, not by PATH', () => {
  it('prefers SystemRoot and builds the System32 path', () => {
    expect(taskkillExe({ SystemRoot: 'C:\\Windows' }, () => true)).toBe('C:\\Windows\\System32\\taskkill.exe')
  })

  it('falls back to windir, the older spelling of the same variable', () => {
    expect(taskkillExe({ windir: 'D:\\Win' }, () => true)).toBe('D:\\Win\\System32\\taskkill.exe')
  })

  it('reports no helper when the machine states no root', () => {
    expect(taskkillExe({}, () => true)).toBeNull()
  })

  it('reports no helper when the named executable is not there', () => {
    expect(taskkillExe({ SystemRoot: 'C:\\Windows' }, () => false)).toBeNull()
  })
})

describe('taskkillTree: one sweep of one pid, reported either way', () => {
  it('runs /T /F against the pid and reports success on exit 0', async () => {
    const { spawn, helpers } = helperSpawn((helper) => helper.settle(0, ''))
    const outcome = await taskkillTree('taskkill.exe', 4242, { spawn })
    expect(outcome).toEqual({ ok: true, detail: null })
    expect(helpers[0]?.calls).toEqual([['/T', '/F', '/PID', '4242']])
  })

  it('reports the helper stderr when the sweep is refused', async () => {
    const { spawn } = helperSpawn((helper) => helper.settle(128, 'ERROR: Access is denied.\r\n'))
    const outcome = await taskkillTree('taskkill.exe', 7, { spawn })
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toBe('taskkill exited 128: ERROR: Access is denied.')
  })

  it('reports a helper that cannot be started, without throwing', async () => {
    const spawn: HelperSpawn = () => {
      throw new Error('spawn EPERM')
    }
    const outcome = await taskkillTree('taskkill.exe', 7, { spawn })
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toBe('cannot start taskkill: spawn EPERM')
  })

  it('reports an asynchronous helper failure too', async () => {
    const { spawn } = helperSpawn((helper) => helper.emit('error', new Error('ENOENT')))
    const outcome = await taskkillTree('taskkill.exe', 7, { spawn })
    expect(outcome).toEqual({ ok: false, detail: 'taskkill failed: ENOENT' })
  })

  it('bounds a helper that never finishes, and kills it', async () => {
    const { spawn, helpers } = helperSpawn()
    const outcome = await taskkillTree('taskkill.exe', 7, { spawn, timeoutMs: 20 })
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toBe('taskkill did not finish within 20 ms')
    expect(helpers[0]?.killed).toBe(true)
  })

  it('reports only the first outcome, so a late close cannot overwrite a timeout', async () => {
    const { spawn, helpers } = helperSpawn()
    const pending = taskkillTree('taskkill.exe', 7, { spawn, timeoutMs: 20 })
    const outcome = await pending
    helpers[0]?.settle(0, '')
    await expect(pending).resolves.toEqual(outcome)
  })

  it('keeps a long helper message to one bounded line', async () => {
    const noise = `${'x'.repeat(5000)}\n`
    const { spawn } = helperSpawn((helper) => helper.settle(1, noise))
    const outcome = await taskkillTree('taskkill.exe', 7, { spawn })
    expect(outcome.ok).toBe(false)
    expect(outcome.detail?.length).toBeLessThanOrEqual('taskkill exited 1: '.length + 400)
  })

  it('defaults its own timeout to a bound a caller never has to pass', () => {
    expect(TREE_KILL_TIMEOUT_MS).toBeGreaterThan(0)
  })
})

describe('defaultTreeKill: this platform, or a reported no-op', () => {
  it('hands Windows a real sweep and every other platform the no-op', () => {
    const sweep = defaultTreeKill()
    if (process.platform === 'win32') {
      // Deliberately not called with a live pid here: a real `taskkill` is a
      // child with a piped stderr, and this suite runs inside the file sandbox,
      // where that spawn is denied (`EPERM`) — the very boundary this module
      // exists on the other side of. The sweep's own behaviour is covered by
      // the injected-helper cases above, and by the drill in `runner.spec.ts`.
      expect(sweep).not.toBe(NO_TREE_KILL)
      return
    }
    expect(sweep).toBe(NO_TREE_KILL)
  })

  it('resolves the no-op as a successful sweep, because there is nothing to sweep', async () => {
    await expect(NO_TREE_KILL(1)).resolves.toEqual({ ok: true, detail: null })
  })
})

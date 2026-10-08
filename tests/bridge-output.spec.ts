/**
 * The wiring, not the plumbing: which job gets a log mirror, and does the mirror
 * actually serve that job's log.
 *
 * The defect this guards produced the exact symptom the unit tests cannot see —
 * `job_output` on a bridge job returned `(no new output)` whether the job passed,
 * failed or finished — because the ring was never fed at all. A test that only
 * exercises `LogOutputSource` would keep passing with the source never being
 * registered, so this one drives the engine as far as the registry contract
 * allows: a stand-in `ctx.jobs` that records the `JobSpec` (including its
 * `output` sources) and starts nothing of its own.
 *
 * The job body does start a real process, because it is the engine's own body and
 * the registry's contract is what schedules it. The command is chosen so the
 * spawn is harmless and cheap: `git status --porcelain` in a directory that is
 * not a repository, which fails in a few milliseconds and writes its refusal to
 * stderr — text this test then reads back through the registered source, which is
 * the whole point.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobHandle, JobSpec } from '@deepseek-ai/dsh-jobs'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BridgeEngine } from '../src/host/bridge'
import type { BridgeJobView } from '../src/host/bridge'
import { Lanes } from '../src/host/queue'
import { canSpawnPiped } from './support/spawn'

const SCRATCH = fileURLToPath(new URL('./.tmp-bridge-output/', import.meta.url))
/**
 * A working directory that is not inside any repository: `git status` there
 * fails with `fatal: not a git repository`, which is deterministic output to
 * read back. The scratch directory would not do — it sits inside this project,
 * so git walks up and finds *this* repository, and the job succeeds instead.
 */
const CWD = tmpdir()
const LOGS = join(SCRATCH, 'logs')

beforeAll(() => {
  mkdirSync(SCRATCH, { recursive: true })
})

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

/** A `ctx.jobs` that records specs and starts no work of its own. */
function recordingJobs(specs: JobSpec[]): Context['jobs'] {
  let issued = 0
  return {
    start(spec: JobSpec): string {
      specs.push(spec)
      issued += 1
      const id = `bridge-${issued}`
      // The engine's starter must be invoked synchronously, exactly as the real
      // registry does, or the record would have no id when `submitCommand`
      // builds its first view.
      spec.run({
        id,
        append: () => undefined,
        updateProgress: () => undefined,
      } as unknown as JobHandle)
      return id
    },
    remove: () => undefined,
    kill: () => 'requested' as const,
  } as unknown as Context['jobs']
}

/** An agent stub: a session id and the working directory the job is pinned to. */
function agentAt(cwd: string): Agent {
  return {
    id: 'session-under-test',
    session: { header: { cwd } },
  } as unknown as Agent
}

/** Wait until the job's own ledger says it is finished. */
async function settledView(engine: BridgeEngine, id: string): Promise<BridgeJobView> {
  for (let i = 0; i < 200; i += 1) {
    const view = engine.read(id, null, 0)
    if (view !== undefined && (view.status === 'done' || view.status === 'failed' || view.status === 'killed')) {
      return view
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`job ${id} never settled`)
}

describe('a command job mirrors its log into the job output ring', () => {
  it('registers one source that serves that job\'s own log', async () => {
    if (!(await canSpawnPiped())) {
      // Not a pass and not a failure: this environment cannot start the job this
      // case needs (see `support/spawn.ts`). CI runs it for real.
      console.warn('bridge-output case skipped: this environment denies a child with piped stdio')
      return
    }
    const specs: JobSpec[] = []
    const engine = new BridgeEngine({ jobs: recordingJobs(specs) } as unknown as Context, new Lanes(), {
      logDir: LOGS,
      dartFormatExe: '',
    })

    const view = await engine.submitCommand({ cmd: 'git', args: ['status', '--porcelain'] }, agentAt(CWD))
    const spec = specs[0]
    expect(spec?.output).toHaveLength(1)

    const settled = await settledView(engine, view.id)
    expect(settled.exitCode).not.toBeNull()

    // The source the engine registered must be reading *this* job's log, and it
    // must be reading it as the complete stream (what a reader whose cursor fell
    // behind retention is offered). The content is compared against the file
    // itself rather than against a remembered string: what is being asserted is
    // "the mirror is the log", which holds whatever the command printed.
    const log = readFileSync(settled.logPath, 'utf8')
    expect(log).not.toBe('')
    const read = spec?.output?.[0]?.read(0)
    expect(read?.spillPath).toBe(settled.logPath)
    expect(read?.text).toBe(log)
    expect(read?.nextOffset).toBe(Buffer.byteLength(log, 'utf8'))
  })

  it('registers none for a job that narrates itself', async () => {
    const specs: JobSpec[] = []
    const engine = new BridgeEngine({ jobs: recordingJobs(specs) } as unknown as Context, new Lanes(), {
      logDir: LOGS,
      dartFormatExe: '',
    })

    engine.submitSubTool({
      owner: 'session-under-test' as never,
      cwd: CWD,
      displayArgv: ['tool:arb-edit', '1 group(s)'],
      body: async (_record, job: JobHandle): Promise<void> => {
        // A sub-tool's own narration is the ring's only writer; a second source
        // over the gen-l10n log would give the model two accounts of one job.
        job.append('nothing to edit\n')
      },
    })

    expect(specs[0]?.output ?? []).toEqual([])
  })
})

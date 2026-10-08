/**
 * The toolchain engine: one submitted job, from argv to digest.
 *
 * This is the piece the retired server wrapped in HTTP. It keeps what was the
 * actual product — the guardrail, the serialization, the failure inventory, the
 * known-failure split — and drops what existed only to make that product
 * reachable from a confined process: the socket, the bearer token, the status
 * page, the parent watchdog.
 *
 * Every job it starts is a `ctx.jobs` job owned by the calling session. That one
 * choice buys four things the retired server had to build or could not have: the
 * harness's own job roster shows it, the model's own `job_output`/`job_kill`
 * control it, a finished background job wakes its owner with a completion
 * notice, and — because the jobs registry installs the Workspace archive
 * admission — **archiving the conversation kills it**.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobHandle, JobHooks, JobId, JobOutcome, JobOutputSource } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'

import { baselineReport, loadKnownFailures, summarizeWithBaseline } from '../engine/baseline'
import { RefusalError, ToolFailure, refuse } from '../engine/errors'
import { wantsLongLane } from '../engine/resolve'
import { pathFilterRegex, scopeMode, scopeRefusal, uncommittedDartFiles } from '../engine/scope'
import { LANE_LONG, LANE_QUEUE, SCOPE_UNCOMMITTED } from '../engine/surface'
import type { BaselineReport, JobStatus, Lane, TestCounts, TestFailure } from '../engine/types'
import { validate } from '../engine/validate'
import { logMirror } from './jobsource'
import { clampTail, readFiltered } from './logfile'
import type { LogView } from './logfile'
import { Lanes } from './queue'
import { ProcessRun, planRun } from './runner'
import { readTestDigest } from './runner'

/**
 * This plugin's job kind, declared the way the registry expects: kinds are an
 * open, merge-extensible map, and the registry treats the value as an opaque id
 * namespace (`bridge-1`, `bridge-2`, …).
 */
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    bridge: 'bridge'
  }
}

/** What the engine itself executes for a job, beyond a resolved argv. */
type JobBody = (record: BridgeRecord, job: JobHandle) => Promise<void>

/** One job's identity and live state, as this engine's own ledger keeps it. */
interface BridgeRecord {
  id: JobId | null
  readonly owner: SessionId
  readonly cwd: string
  readonly lane: Lane
  readonly kind: 'cmd' | 'arb-edit'
  readonly scope: string | null
  readonly long: boolean
  readonly logPath: string
  readonly argv: string[]
  readonly env: NodeJS.ProcessEnv
  resolvedArgv: string[] | null
  status: JobStatus
  exitCode: number | null
  startedAt: number | null
  finishedAt: number | null
  summary: string | null
  counts: TestCounts | null
  failures: TestFailure[]
  baseline: BaselineReport | null
  error: string | null
  result: unknown
  /** Unfinished jobs ahead of this one on its lane, at submit time. */
  aheadOf: number
  run: ProcessRun | null
  /** A kill that landed before the job's first turn must win over starting it. */
  cancelled: boolean
}

/** One submission, already through the tool layer's schema checks. */
export interface SubmitCommandRequest {
  cmd: string
  args: readonly string[]
  message?: string | null
  scope?: string | null
  long?: boolean | null
}

/** A caller's view of a job: the retired server's job JSON, minus the transport. */
export interface BridgeJobView {
  id: string
  kind: 'cmd' | 'arb-edit'
  argv: string[]
  resolvedArgv: string[] | null
  status: JobStatus
  lane: Lane
  long: boolean
  scope: string | null
  aheadOf: number
  exitCode: number | null
  startedAt: number | null
  finishedAt: number | null
  durationSec: number | null
  summary: string | null
  counts: TestCounts | null
  error: string | null
  logPath: string
  /** The log view: how many lines matched, how many came back, and why. */
  log?: LogView
  /** The last lines of the log, narrowed by `grep` when one was given. */
  tail?: string
  /** The complete failure inventory, in run order; rides with the log view. */
  failures?: TestFailure[]
  /** The known-failure split; null when the project keeps no registry. */
  baseline?: BaselineReport | null
  /** A sub-tool's structured outcome. */
  result?: unknown
}

/** What one job needs to start, beyond the caller's own request. */
interface RegisterOptions {
  owner: SessionId
  cwd: string
  lane: Lane
  kind: 'cmd' | 'arb-edit'
  scope: string | null
  argv: string[]
  resolvedArgv: string[]
  env: NodeJS.ProcessEnv
  /**
   * Whether to mirror the job's log into the registry's output ring as a pull
   * source. True for a command, whose log *is* its output and is the only thing
   * `job_output` could read; false for a sub-tool, which narrates its own
   * progress through `JobHandle.append`.
   */
  mirrorOutput: boolean
  body: JobBody
}

/**
 * The engine: one instance per plugin activation, owning the lanes, the job
 * ledger, and the log directory.
 */
export class BridgeEngine {
  private readonly records = new Map<string, BridgeRecord>()

  constructor(
    private readonly ctx: Context,
    private readonly lanes: Lanes,
    private readonly options: {
      /** Where job logs are written: one UTF-8 file per job, both streams combined. */
      logDir: string
      /** The formatter pin, or an empty string for PATH's dart. */
      dartFormatExe: string
    },
  ) {
    mkdirSync(this.options.logDir, { recursive: true })
  }

  /**
   * Submit a command: normalise, guard, resolve, and register it as a job.
   *
   * The guardrail runs at submit time, so a refused command costs a request
   * rather than a queued job — the same reason the uncommitted scope is computed
   * here, where "nothing is uncommitted" can still be refused instead of
   * becoming a job that formats the whole tree.
   * @param request - the caller's command.
   * @param agent - the calling agent: its session owns the job and supplies the working directory.
   * @returns the job's initial view, with its id and its place in line.
   */
  async submitCommand(request: SubmitCommandRequest, agent: Agent): Promise<BridgeJobView> {
    const argv = [request.cmd, ...request.args]
    // Normalises `npm test` into `npm run test` in place, before anything reads
    // the argv: the lane guess, the job JSON and the digest must agree.
    validate(argv)
    const cmd = argv[0] as string
    const args = argv.slice(1)
    const cwd = workingDirectory(agent)

    let grep: string | null = null
    const scope = request.scope ?? null
    if (scope !== null) {
      if (scope !== SCOPE_UNCOMMITTED) {
        refuse(400, `unknown scope: ${JSON.stringify(scope)} (supported: ${SCOPE_UNCOMMITTED})`)
      }
      const mode = scopeMode(cmd, args)
      if (mode === null) refuse(403, scopeRefusal(cmd, args))
      // Read once, here, at submit time: an empty set must be a refusal rather
      // than a job that widens to the whole tree (`dart format` with no paths
      // rewrites everything).
      const files = await uncommittedDartFiles(cwd)
      if (files.length === 0) {
        refuse(400, 'no uncommitted .dart files to scope this command to')
      }
      if (mode === 'expand') {
        args.push(...files)
      } else {
        // An analyzer takes a directory, not a file list, so here the scope
        // narrows the *returned lines*; the exit code still covers the project.
        grep = pathFilterRegex(files).source
      }
    }

    const plan = planRun({ cmd, args, message: request.message ?? null }, cwd, this.options.dartFormatExe)
    const lane: Lane = (request.long ?? wantsLongLane(cmd, args)) ? LANE_LONG : LANE_QUEUE
    return this.register({
      owner: agent.id,
      cwd,
      lane,
      kind: 'cmd',
      scope,
      argv: plan.argv,
      resolvedArgv: plan.resolvedArgv,
      env: plan.env,
      mirrorOutput: true,
      body: async (record, job) => {
        const run = new ProcessRun(record.resolvedArgv ?? [], record.cwd, record.env, record.logPath)
        record.run = run
        job.updateProgress(`${record.argv[0] ?? ''} ${record.argv[1] ?? ''}`.trim())
        run.start()
        const settlement = await run.settled
        record.exitCode = settlement.exitCode
        record.error = settlement.error
        record.status = settlement.killed
          ? 'killed'
          : settlement.error !== null
            ? 'failed'
            : settlement.exitCode === 0
              ? 'done'
              : 'failed'
        this.annotate(record)
      },
    })
  }

  /**
   * Submit a job whose body this engine runs itself.
   *
   * A sub-tool is a Job like any other — it queues behind a running build, it is
   * killed by the same id, its log is its own — and the only difference is what
   * the single worker executes. `argv` is a display line nothing spawns.
   * @param args - the display argv and the body to run.
   * @returns the job's initial view.
   */
  submitSubTool(args: {
    owner: SessionId
    cwd: string
    displayArgv: string[]
    body: JobBody
  }): BridgeJobView {
    return this.register({
      owner: args.owner,
      cwd: args.cwd,
      lane: LANE_QUEUE,
      kind: 'arb-edit',
      scope: null,
      argv: args.displayArgv,
      resolvedArgv: [],
      env: process.env,
      // A sub-tool narrates through `JobHandle.append` (its own lines about what
      // it edited), so a second source over the gen-l10n log would interleave
      // two accounts of the same job. Its log is for the `tail`/`grep` view.
      mirrorOutput: false,
      body: args.body,
    })
  }

  /** Unfinished depth of both lanes for one directory, for the sidebar. */
  depth(cwd: string): { queue: number; long: number } {
    return this.lanes.snapshot(cwd)
  }

  /** Every job this engine still holds, oldest first. */
  list(): BridgeJobView[] {
    return [...this.records.values()]
      .sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0))
      .map((record) => this.view(record))
  }

  /**
   * One conversation's jobs, for the sidebar panel.
   *
   * Ownership is deliberately absent from {@link BridgeJobView}: the model reads
   * that shape, and which session owns a job is not its business. The panel asks
   * by owner instead, here, where the ledger knows.
   * @param owner - the session whose jobs to list.
   * @returns those jobs, oldest first.
   */
  listForOwner(owner: string): BridgeJobView[] {
    return [...this.records.values()]
      .filter((record) => record.owner === owner)
      .sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0))
      .map((record) => this.view(record))
  }

  /**
   * One job's view, with the caller's log knobs applied.
   * @param id - the job id.
   * @param grep - an optional pattern selecting log lines.
   * @param tail - how many lines to return.
   * @returns the view, or undefined for a job this engine never had.
   */
  read(id: string, grep: string | null, tail: number | undefined): BridgeJobView | undefined {
    const record = this.records.get(id)
    if (record === undefined) return undefined
    return this.view(record, { grep, tail })
  }

  /**
   * The view a tool returns, or a failure naming the unknown id.
   * @param id - the job id.
   * @param grep - an optional pattern selecting log lines.
   * @param tail - how many lines to return.
   * @returns the view.
   */
  result(id: string, grep: string | null, tail: number | undefined): BridgeJobView {
    const view = this.read(id, grep, tail)
    if (view === undefined) throw new ToolFailure(`unknown job: ${id}`)
    return view
  }

  /**
   * Stop one job and its process, through the job registry so the registry's own
   * bookkeeping (status, completion notice, roster) stays authoritative.
   * @param id - the job to stop.
   * @param reason - recorded in the job's terminal detail.
   * @returns whether a kill was requested.
   */
  kill(id: string, reason?: string): boolean {
    const record = this.records.get(id)
    if (record === undefined || record.id === null) return false
    try {
      return this.ctx.jobs.kill(record.id, record.owner, reason) === 'requested'
    } catch {
      return false
    }
  }

  /**
   * Drop a settled job's record once its caller has collected the result.
   *
   * A foreground run's result is already in the model's hands, so leaving it in
   * the roster would only repeat it; a job the model may still read is kept.
   * @param id - the settled job to forget.
   */
  forget(id: string): void {
    const record = this.records.get(id)
    if (record === undefined || record.id === null) return
    this.records.delete(id)
    try {
      this.ctx.jobs.remove(record.id, record.owner)
    } catch {
      // Still live, or already dropped by the registry: our ledger is the part
      // this engine owns, and the registry's record outlives it harmlessly.
    }
  }

  private register(options: RegisterOptions): BridgeJobView {
    const record: BridgeRecord = {
      id: null,
      owner: options.owner,
      cwd: options.cwd,
      lane: options.lane,
      kind: options.kind,
      scope: options.scope,
      long: options.lane === LANE_LONG,
      logPath: join(this.options.logDir, `${Date.now()}-${randomUUID().slice(0, 8)}.log`),
      argv: options.argv,
      env: options.env,
      resolvedArgv: options.resolvedArgv,
      status: 'queued',
      exitCode: null,
      startedAt: null,
      finishedAt: null,
      summary: null,
      counts: null,
      failures: [],
      baseline: null,
      error: null,
      result: null,
      aheadOf: this.lanes.depth(options.cwd, options.lane),
      run: null,
      cancelled: false,
    }

    // `start` invokes the starter synchronously, so the id exists by the time it
    // returns and the caller's first view already carries it.
    this.ctx.jobs.start({
      kind: 'bridge',
      label: record.argv.join(' '),
      owner: options.owner,
      // The ring is fed from the log the run writes, and the registry owns the
      // cadence: this is what makes `job_output` see a bridge job's output at
      // all (see `jobsource.ts` for the measurement that made it a fix rather
      // than a feature).
      output: logMirror(options.mirrorOutput ? record.logPath : null),
      run: (job: JobHandle): JobHooks => {
        record.id = job.id
        this.records.set(job.id, record)
        const queued = this.lanes.enqueue(options.cwd, options.lane, async () => {
          if (record.cancelled) return
          record.status = 'running'
          record.startedAt = Date.now()
          try {
            await options.body(record, job)
          } finally {
            record.finishedAt = Date.now()
          }
        })
        record.aheadOf = queued.aheadOf
        return {
          cancel: (reason?: string) => {
            // Marked before the OS is asked: the process's own exit is otherwise
            // indistinguishable from the kill's, and a job classified from the
            // kill's exit code reads as a toolchain failure.
            record.cancelled = true
            if (record.status === 'queued') record.status = 'killed'
            if (reason !== undefined && reason !== '') record.error = reason
            record.run?.cancel()
          },
          done: queued.result.then(
            () => this.terminal(record),
            (error: unknown) => ({
              status: record.cancelled ? ('killed' as const) : ('failed' as const),
              detail: error instanceof Error ? error.message : String(error),
            }),
          ),
        }
      },
    } satisfies Parameters<Context['jobs']['start']>[0])

    return this.view(record)
  }

  /** A job's terminal outcome, as the registry records it. */
  private terminal(record: BridgeRecord): JobOutcome {
    if (record.status === 'killed') {
      return { status: 'killed', ...(record.error === null ? {} : { detail: record.error }) }
    }
    if (record.status === 'failed') {
      return {
        status: 'failed',
        detail: record.exitCode === null ? (record.error ?? 'failed') : `exit code: ${record.exitCode}`,
      }
    }
    return {
      status: 'completed',
      ...(record.exitCode === null || record.exitCode === 0 ? {} : { detail: `exit code: ${record.exitCode}` }),
    }
  }

  /** Read a finished job's log back as a digest, plus the known-failure split. */
  private annotate(record: BridgeRecord): void {
    const digest = readTestDigest(record.argv, record.logPath)
    record.counts = digest.counts
    record.failures = digest.failures
    const registry = loadKnownFailures(record.cwd)
    if (registry.exists) {
      // The Python argument order, kept: the digest's own counts are the
      // authoritative total the split has to reconcile with.
      record.baseline = baselineReport(record.failures, record.counts, registry)
      record.summary = summarizeWithBaseline(digest.summary, record.baseline)
    } else {
      record.baseline = null
      record.summary = digest.summary
    }
  }

  private view(record: BridgeRecord, log?: { grep: string | null; tail: number | undefined }): BridgeJobView {
    const end = record.finishedAt ?? Date.now()
    const view: BridgeJobView = {
      id: record.id ?? '',
      kind: record.kind,
      argv: record.argv,
      resolvedArgv: record.resolvedArgv,
      status: record.status,
      lane: record.lane,
      long: record.long,
      scope: record.scope,
      aheadOf: record.aheadOf,
      exitCode: record.exitCode,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      durationSec: record.startedAt === null ? null : Math.round(((end - record.startedAt) / 100) / 10),
      summary: record.summary,
      counts: record.counts,
      error: record.error,
      logPath: record.logPath,
    }
    if (record.kind === 'arb-edit') view.result = record.result
    if (log !== undefined) {
      const pattern = log.grep === null ? null : compileGrep(log.grep)
      const read = readFiltered(record.logPath, pattern, clampTail(log.tail))
      view.tail = read.text
      view.log = read.log
      if (record.kind === 'cmd') {
        view.failures = record.failures
        view.baseline = record.baseline
      }
    }
    return view
  }
}

/** Compile a caller's `grep`, answering a bad pattern the way the route did. */
export function compileGrep(pattern: string): RegExp {
  try {
    return new RegExp(pattern)
  } catch (error) {
    throw new RefusalError(400, `grep is not a valid regex: ${String(error)}`)
  }
}

/** The job's working directory: its session's cwd, or the process's. */
export function workingDirectory(agent: Agent): string {
  return agent.session.header.cwd ?? process.cwd()
}

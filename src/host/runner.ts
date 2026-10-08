/**
 * Running one command: the argv that actually starts, the log it writes, and
 * the digest read back from that log.
 *
 * Arguments always travel as an argv list — there is no shell anywhere, which is
 * also why a Windows `.bat` wrapper is never the thing that runs (see
 * `resolve.ts`). A job's stdout and stderr are combined into one UTF-8 log file,
 * because the toolchains interleave them and the caller reads a single stream;
 * the "GBK would mangle CJK output" problem the retired server solved by
 * decoding explicitly does not exist here, where the bytes are never decoded by
 * a console at all.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { appendFileSync, createWriteStream, mkdirSync } from 'node:fs'
import type { WriteStream } from 'node:fs'
import { dirname } from 'node:path'

import { analyzeTestLog } from '../engine/digest'
import { TOOL_ENV_OVERRIDES } from '../engine/env'
import { ToolFailure } from '../engine/errors'
import { resolveLaunch } from '../engine/resolve'
import type { BaselineReport, TestCounts, TestFailure } from '../engine/types'
import { defaultTreeKill } from './killtree'
import type { TreeKillFn } from './killtree'

/** What the caller asked to run, before resolution. */
export interface RunSpec {
  /** The accepted command name or path the caller typed. */
  cmd: string
  args: readonly string[]
  /** A commit message folded into argv as `-m <text>`; never a file. */
  message?: string | null
}

/** The argv that will actually start, plus the environment it starts with. */
export interface RunPlan {
  /** The caller's argv after normalisation — what the job JSON shows. */
  argv: string[]
  /** What truly ran: the SDK's own `dart.exe`, the pinned formatter, a script binary under `node`. */
  resolvedArgv: string[]
  env: NodeJS.ProcessEnv
}

/**
 * Turn a request into the argv that starts.
 *
 * `cwd` is the job's working directory and the only place a project-local script
 * binary is looked for; `dartFormatExe` is the formatter pin, which routes
 * *only* `dart format` to another SDK.
 * @param spec - the caller's command.
 * @param cwd - the job's working directory.
 * @param dartFormatExe - the formatter pin, or an empty string for PATH's dart.
 * @returns the argv to spawn and its environment.
 */
export function planRun(spec: RunSpec, cwd: string, dartFormatExe: string): RunPlan {
  const argv = [spec.cmd, ...spec.args]
  if (spec.message !== null && spec.message !== undefined && spec.message !== '') {
    argv.push('-m', spec.message)
  }
  const { argv: resolvedArgv, env } = resolveLaunch(argv, dartFormatExe === '' ? null : dartFormatExe, cwd)
  // The overrides come last, so nothing in the job's own environment can put
  // colour back into a log a model has to read (see `engine/env.ts`).
  const merged: NodeJS.ProcessEnv = { ...process.env, ...env, ...TOOL_ENV_OVERRIDES }
  // Nothing may block on a prompt this process has no terminal to answer: a git
  // credential or signing prompt would hang a job until its timeout.
  if (resolvedArgv.some((token) => token.toLowerCase().includes('git'))) {
    merged.GIT_TERMINAL_PROMPT = '0'
  }
  return { argv, resolvedArgv, env: merged }
}

/** How a finished run ended. */
export interface RunSettlement {
  /** The process's exit code, or null when a signal ended it. */
  exitCode: number | null
  /** Whether this tool killed it rather than it exiting on its own. */
  killed: boolean
  /** Why it could not run at all, when that is the case. */
  error: string | null
}

/** The `spawn` shape a run needs, injectable so a test owns the child. */
export type SpawnProcess = (argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => ChildProcess

/** What a test may replace, so no test has to start a real process to be true. */
export interface ProcessRunOptions {
  /** How the process starts; the real `spawn` unless a test injects one. */
  spawnProcess?: SpawnProcess
  /** How a cancel reaches the whole tree; {@link defaultTreeKill} unless a test injects one. */
  killTree?: TreeKillFn
}

/**
 * Start one process with its stdio on pipes and no console.
 *
 * The default behind {@link ProcessRun}: real `spawn`, combined streams, hidden
 * window. It is a named function rather than an inline call so the fake a test
 * passes has one signature to match, and so the real `spawn` options live in
 * one place.
 * @param argv - the resolved argv; `argv[0]` is the executable.
 * @param cwd - the working directory the job is pinned to.
 * @param env - the merged environment.
 * @returns the child process.
 */
export function spawnProcess(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(argv[0] as string, argv.slice(1), {
    cwd,
    env,
    // Combined on purpose: the caller reads one stream, and the toolchains
    // interleave progress with diagnostics.
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

/**
 * One spawned process and the log it is writing.
 *
 * The kill path takes the status decision itself, before asking the OS: the
 * process's own exit is otherwise indistinguishable from the kill's, and a job
 * classified from a kill's exit code reads as a failure of the toolchain.
 *
 * It also ends the whole tree, not just the process it holds a handle to: see
 * `killtree.ts` for the measurement that made that a requirement rather than a
 * nicety. The tree sweep runs first and the owned handle is the fallback,
 * because `taskkill /T` can only walk a chain whose root is still alive.
 */
export class ProcessRun {
  private child: ChildProcess | undefined
  private sink: WriteStream | undefined
  private killed = false
  private settledResolve: ((value: RunSettlement) => void) | undefined
  /** The pending tree sweep; settlement waits for it. Resolved until a cancel asks for one. */
  private sweep: Promise<void> = Promise.resolve()
  /** Cancel notes waiting to be appended at the log's end; see {@link note}. */
  private readonly notes: string[] = []
  private readonly spawnProcess: SpawnProcess
  private readonly killTree: TreeKillFn

  /** Resolves once the process has exited and its log is flushed. */
  readonly settled: Promise<RunSettlement>

  constructor(
    /** What truly ran, for the job JSON. */
    readonly resolvedArgv: readonly string[],
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
    /** The UTF-8 log file this run appends to. */
    readonly logPath: string,
    options: ProcessRunOptions = {},
  ) {
    this.spawnProcess = options.spawnProcess ?? spawnProcess
    this.killTree = options.killTree ?? defaultTreeKill()
    this.settled = new Promise<RunSettlement>((resolve) => {
      this.settledResolve = resolve
    })
  }

  /** Start the process. Throws when the executable cannot be started at all. */
  start(): void {
    mkdirSync(dirname(this.logPath), { recursive: true })
    this.sink = createWriteStream(this.logPath, { flags: 'a' })
    let child: ChildProcess
    try {
      child = this.spawnProcess(this.resolvedArgv, this.cwd, this.env)
    } catch (error) {
      this.finish(null, `cannot start ${this.resolvedArgv[0] ?? '?'}: ${String(error)}`)
      throw new ToolFailure(`cannot start ${this.resolvedArgv[0] ?? '?'}: ${String(error)}`)
    }
    this.child = child
    child.stdout?.on('data', (chunk: Buffer) => this.sink?.write(chunk))
    child.stderr?.on('data', (chunk: Buffer) => this.sink?.write(chunk))
    child.on('error', (error: Error) => {
      this.finish(null, `cannot start ${this.resolvedArgv[0] ?? '?'}: ${error.message}`)
    })
    child.on('close', (code: number | null) => {
      this.finish(code, null)
    })
  }

  /** The process's pid, for the kill message. */
  get pid(): number | undefined {
    return this.child?.pid
  }

  /**
   * Terminate the process this run owns **and every process below it**.
   *
   * Two steps, in a fixed order, because each covers the other's failure mode.
   * The tree sweep runs **first, and the owned kill waits for it**: `taskkill
   * /T` walks the parent-child chain from the root, and it resolves that pid
   * when it finally runs, not when it is spawned — measured here, a sweep
   * started alongside the kill came back `taskkill exited 128: process "N" not
   * found` because the root was already gone by the time the helper looked, and
   * every descendant was then missed. So the walk gets its moment, and the
   * owned handle is the fallback that ends the direct child when the sweep is
   * refused, missing, or too slow (see `killtree.ts` for why that fallback
   * still matters under a sandbox). Nothing waits on it beyond the sweep:
   * settlement waits for the same promise, so the job's own timing is unchanged.
   *
   * The method stays synchronous because the job registry's `cancel` contract
   * says so; only the OS work behind it is deferred.
   */
  cancel(): boolean {
    if (this.killed) return false
    this.killed = true
    const child = this.child
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
      // Never started, or already gone: the settlement still has to happen, and
      // a queued job killed before its first turn never had a process at all.
      if (child === undefined) this.finish(null, null)
      return false
    }
    /** The last resort, and the root's own end once the walk has had its turn. */
    const endOwned = (): void => {
      try {
        child.kill()
      } catch {
        // A kill must never raise: the job's status is the caller's answer.
      }
    }
    const pid = child.pid
    if (pid === undefined) {
      // A pid-less child cannot be walked to either, so the handle is all there is.
      endOwned()
      return true
    }
    this.sweep = this.killTree(pid).then(
      (outcome) => {
        if (!outcome.ok && outcome.detail !== null) this.note(outcome.detail)
        endOwned()
      },
      (error: unknown) => {
        this.note(`process tree was not swept: ${String(error)}`)
        endOwned()
      },
    )
    return true
  }

  /**
   * Record a cancel's own outcome in the run's log.
   *
   * The log is the one artifact that outlives the process, so it is where "the
   * tree was not swept" has to be legible: a later reader who finds a
   * still-running child has the reason rather than the same mystery this
   * comment opened with. It is only worth a line when it is bad news.
   *
   * The line is queued rather than written, and that is not stylistic: the log
   * is an append stream whose file does not exist until its asynchronous open
   * completes, so a direct write here could land *before* bytes the process had
   * already produced — measured, with a note that arrived first in a log whose
   * first line was printed before the kill. Queuing keeps the log's one real
   * contract, that it is the process's output in order, and the queue is flushed
   * at settlement, after the stream has finished for good.
   */
  private note(detail: string): void {
    this.notes.push(detail)
  }

  /** Append every queued note at the log's end. Best-effort: this is a diagnostic. */
  private flushNotes(): void {
    if (this.notes.length === 0) return
    const text = this.notes.splice(0).map((detail) => `[toolbridge] ${detail}\n`).join('')
    try {
      appendFileSync(this.logPath, text, 'utf8')
    } catch {
      // The log is diagnostic here; losing it must not fail anything.
    }
  }

  private finish(code: number | null, error: string | null): void {
    const sink = this.sink
    this.sink = undefined
    const settle = (): void => {
      const resolve = this.settledResolve
      this.settledResolve = undefined
      // Settlement waits for the sweep, and the notes are flushed with it: it is
      // what makes "settled" and "nothing of this run is still running, and its
      // log is complete" the same moment — which is the whole point of keeping
      // the tree kill inside the lock the lanes serialize on.
      void this.sweep.then(() => {
        this.flushNotes()
        resolve?.({ exitCode: code, killed: this.killed, error })
      })
    }
    if (sink === undefined) {
      settle()
      return
    }
    sink.end(settle)
  }
}

/** The parsed view of a finished test run, digest and baseline split together. */
export interface TestDigestView {
  summary: string | null
  counts: TestCounts | null
  failures: TestFailure[]
  baseline: BaselineReport | null
}

/**
 * Read a finished job's log as a test digest.
 *
 * A `flutter test`/`dart test` run and a vitest run (by argv, or by the
 * reporter's own markers when a script name hides the runner) each produce the
 * same shape; everything else produces nothing, because a digest on a `git log`
 * would be an invented answer.
 * @param argv - the job's normalised argv.
 * @param logPath - its log file.
 * @returns the digest fields, with a null summary when the log says nothing.
 */
export function readTestDigest(
  argv: readonly string[],
  logPath: string,
): { summary: string | null; counts: TestCounts | null; failures: TestFailure[] } {
  const digest = analyzeTestLog([...argv], logPath)
  return { summary: digest.summary, counts: digest.counts, failures: digest.failures }
}

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
import { createWriteStream, mkdirSync } from 'node:fs'
import type { WriteStream } from 'node:fs'
import { dirname } from 'node:path'

import { analyzeTestLog } from '../engine/digest'
import { ToolFailure } from '../engine/errors'
import { resolveLaunch } from '../engine/resolve'
import type { BaselineReport, TestCounts, TestFailure } from '../engine/types'

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
  const merged: NodeJS.ProcessEnv = { ...process.env, ...env }
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

/**
 * One spawned process and the log it is writing.
 *
 * The kill path takes the status decision itself, before asking the OS: the
 * process's own exit is otherwise indistinguishable from the kill's, and a job
 * classified from a kill's exit code reads as a failure of the toolchain.
 */
export class ProcessRun {
  private child: ChildProcess | undefined
  private sink: WriteStream | undefined
  private killed = false
  private settledResolve: ((value: RunSettlement) => void) | undefined

  /** Resolves once the process has exited and its log is flushed. */
  readonly settled: Promise<RunSettlement>

  constructor(
    /** What truly ran, for the job JSON. */
    readonly resolvedArgv: readonly string[],
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
    /** The UTF-8 log file this run appends to. */
    readonly logPath: string,
  ) {
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
      child = spawn(this.resolvedArgv[0] as string, this.resolvedArgv.slice(1), {
        cwd: this.cwd,
        env: this.env,
        // Combined on purpose: the caller reads one stream, and the toolchains
        // interleave progress with diagnostics.
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
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
   * Terminate the process this run owns.
   *
   * The owned handle is used rather than a fresh `taskkill`, which is a separate
   * process asking for access it can be refused. `taskkill /T` would reach
   * grandchildren (esbuild's service, a forked test runner); those exit with
   * their parent's collapsed stdio, and the job's status is what the caller sees
   * either way.
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
    try {
      child.kill()
    } catch {
      // A kill must never raise: the job's status is the caller's answer.
    }
    return true
  }

  private finish(code: number | null, error: string | null): void {
    const sink = this.sink
    this.sink = undefined
    const settle = (): void => {
      this.settledResolve?.({ exitCode: code, killed: this.killed, error })
      this.settledResolve = undefined
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

/**
 * The two model-facing tools.
 *
 * This file is where the retired `SKILL.md` went. A skill taught the model to
 * start a server, read a port and a token out of job output, build a JSON body,
 * and nest three timeouts; a tool description teaches the same thing in the
 * place the model reads before it calls. What survives is the part that was
 * never about HTTP: which commands are accepted and why, what a refusal means,
 * when a job belongs on the long lane, and how to read a test result.
 *
 * The canonical value is the job view, minus its nulls: a PTC program reads
 * `result.failures` and `result.baseline.newFailures` directly, and the rendered
 * text is for the model's eyes only.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JobHandle } from '@deepseek-ai/dsh-jobs'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { applyArbEdits, planArbEdits, readUntranslated, validateInstructions } from '../engine/arbedit'
import { RefusalError, ToolFailure } from '../engine/errors'
import { resolveLaunch } from '../engine/resolve'
import type { ArbResult, BaselineReport, JobStatus, Lane, TestCounts, TestFailure } from '../engine/types'
import { BridgeEngine, workingDirectory } from './bridge'
import type { BridgeJobView } from './bridge'
import type { ToolBridgeConfig } from './config'
import { ProcessRun } from './runner'

/** One failing test, as both `failures` and `baseline.newFailures` report it. */
const FailureItemSchema = {
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      file: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
      name: { type: 'string', required: true },
      didNotComplete: { type: 'boolean', required: true },
      known: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true },
          reason: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
        description: 'Present when the known-failure registry claimed this failure; absent means it is new.',
      },
    },
  },
} as const

/** The job JSON, as the canonical value of both tools. */
const JobOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: 'Job id: read it later with job_output, stop it with job_kill.' },
    status: {
      type: 'string',
      required: true,
      enum: ['queued', 'running', 'done', 'failed', 'killed'],
      description: 'Job status.',
    },
    lane: {
      type: 'string',
      required: true,
      enum: ['queue', 'long'],
      description: 'Which serialized lane it ran on.',
    },
    argv: { type: 'array', required: true, items: { type: 'string' }, description: 'The request after normalisation.' },
    resolvedArgv: {
      required: true,
      oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }],
      description: 'What actually started, or null while the job is still queued.',
    },
    aheadOf: {
      type: 'number',
      required: true,
      description: 'Unfinished jobs ahead of it on its own lane, at submit time.',
    },
    exitCode: { type: 'number', description: 'Process exit code; absent while running.' },
    durationSec: { type: 'number', description: 'Seconds from start to finish, or to now while it runs.' },
    summary: {
      type: 'string',
      description: 'The one-line digest of a test run: "83 passed, 4 failed (3 known, 1 new)".',
    },
    counts: {
      type: 'object',
      additionalProperties: false,
      properties: {
        passed: { type: 'number', required: true },
        skipped: { type: 'number', required: true },
        failed: { type: 'number', required: true },
      },
      description: "Read from the reporter's last progress line: the authoritative totals.",
    },
    error: { type: 'string', description: 'Why the job failed, when it did.' },
    tail: { type: 'string', description: 'The log lines returned, newest last.' },
    log: {
      type: 'object',
      additionalProperties: false,
      properties: {
        // Nulls are spelled out rather than dropped: an unfiltered read really
        // does report "no pattern was applied", which is not the same fact as
        // "a pattern matched nothing".
        grep: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
        matched: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
        returned: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
        scannedLines: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
        truncated: { type: 'boolean', required: true },
      },
      description: 'What the log view did, so "no matches" never reads as "no output".',
    },
    failures: { ...FailureItemSchema, type: 'array', description: 'The complete failure inventory, in run order.' },
    baseline: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string', required: true, description: 'The registry file this came from.' },
        known: { type: 'number', required: true },
        new: { type: 'number', required: true },
        failed: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
        tests: { type: 'number', required: true, description: 'Distinct tests the inventory named.' },
        events: { type: 'number', required: true, description: 'Failure lines those tests produced.' },
        unparsed: { type: 'number', required: true, description: 'The part of `failed` no line named.' },
        newFailures: {
          ...FailureItemSchema,
          type: 'array',
          required: true,
          description: 'The complete, ordered list of failures your change introduced — read this to act.',
        },
        error: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
      },
      description: 'The known/new split: a reason a failure is not yours, or the evidence that it is.',
    },
    result: { type: 'json', description: 'A sub-tool\'s structured outcome.' },
    logPath: {
      type: 'string',
      required: true,
      description: 'The UTF-8 log file, readable with the ordinary file tools.',
    },
  },
} as const

/** The canonical value both tools return. */
export interface JobOutput {
  id: string
  status: JobStatus
  lane: Lane
  argv: string[]
  resolvedArgv: string[] | null
  aheadOf: number
  exitCode?: number
  durationSec?: number
  summary?: string
  counts?: TestCounts
  error?: string
  tail?: string
  log?: {
    grep: string | null
    matched: number | null
    returned: number | null
    scannedLines: number | null
    truncated: boolean
  }
  failures?: TestFailure[]
  baseline?: BaselineReport
  result?: JsonValue
  logPath: string
}

/**
 * Project a job view onto the canonical value.
 *
 * Absent facts are omitted rather than sent as `null`: a missing `counts` means
 * "not a test run", and a field that is present-but-null would make every reader
 * check both spellings of the same absence.
 * @param view - the engine's view.
 * @returns the value the tool returns.
 */
export function toOutput(view: BridgeJobView): JobOutput {
  const output: JobOutput = {
    id: view.id,
    status: view.status,
    lane: view.lane,
    argv: view.argv,
    resolvedArgv: view.resolvedArgv,
    aheadOf: view.aheadOf,
    logPath: view.logPath,
  }
  if (view.exitCode !== null) output.exitCode = view.exitCode
  if (view.durationSec !== null) output.durationSec = view.durationSec
  if (view.summary !== null) output.summary = view.summary
  if (view.counts !== null) output.counts = view.counts
  if (view.error !== null) output.error = view.error
  if (view.tail !== undefined) output.tail = view.tail
  if (view.log !== undefined) output.log = view.log
  if (view.failures !== undefined) output.failures = view.failures
  if (view.baseline !== undefined && view.baseline !== null) output.baseline = view.baseline
  // The arb result is built from JSON-only fields (strings, string lists, a
  // nested exit code), so the snapshot the registry takes is the same value; the
  // cast is the price of the engine's view carrying it as `unknown` rather than
  // making every reader of the ledger know about arb-edit.
  if (view.result !== undefined && view.result !== null) output.result = view.result as JsonValue
  return output
}

/** Render a job view the way the retired server's one-line summary read. */
function renderJob(value: JobOutput): string {
  const head = [`${value.status}${value.exitCode === undefined ? '' : ` exit=${value.exitCode}`}`]
  if (value.durationSec !== undefined) head.push(`${value.durationSec}s`)
  if (value.aheadOf > 0 && value.status === 'queued') head.push(`queued behind ${value.aheadOf}`)
  const lines = [`${head.join(' ')}${value.summary === undefined ? '' : `  ${value.summary}`}`]
  lines.push(`argv: ${value.argv.join(' ')}`)
  if (value.resolvedArgv !== null && value.resolvedArgv.length > 0) {
    lines.push(`ran: ${value.resolvedArgv.join(' ')}`)
  }
  lines.push(`job: ${value.id} (lane ${value.lane}; read it on with job_output ${value.id})`)
  if (value.error !== undefined) lines.push(`error: ${value.error}`)
  const fresh = value.baseline?.newFailures ?? []
  if (fresh.length > 0) {
    lines.push('new failures:')
    for (const failure of fresh) lines.push(`  ${failure.file ?? ''} > ${failure.name}`)
  }
  if (value.tail !== undefined && value.tail !== '') {
    if (value.log !== undefined && value.log.matched !== null) {
      lines.push(`log: ${value.log.matched} matched, ${value.log.returned} returned, ${value.log.scannedLines} scanned`)
    }
    lines.push(value.tail)
  }
  return lines.join('\n')
}

/** Render an arb-edit result. */
function renderArb(value: JobOutput): string {
  const result = value.result as ArbResult | undefined
  if (result === undefined || result === null || typeof result !== 'object') return renderJob(value)
  const lines = [
    `${value.status}${result.dryRun ? ' (dry run)' : ''}`,
    `edited: ${result.edited.length === 0 ? 'none' : result.edited.join(', ')}`,
  ]
  for (const change of result.changes) {
    const plus = change.inserts.length === 0 ? '' : ` +${change.inserts.join(',')}`
    const minus = change.deletes.length === 0 ? '' : ` -${change.deletes.join(',')}`
    lines.push(`  ${change.file}:${plus === '' && minus === '' ? ' (no change)' : `${plus}${minus}`}`)
  }
  for (const skipped of result.skipped) lines.push(`  skipped ${skipped.file}: ${skipped.reason}`)
  if (result.genL10n !== null) lines.push(`gen-l10n exit=${result.genL10n.exitCode}`)
  if (result.untranslated !== null) {
    lines.push(`untranslated messages in ${result.untranslated.file} (${result.untranslated.lines} lines)`)
  }
  if (value.error !== undefined) lines.push(`error: ${value.error}`)
  lines.push(`job: ${value.id} (read it on with job_output ${value.id})`)
  if (value.tail !== undefined && value.tail !== '') lines.push(value.tail)
  return lines.join('\n')
}

/**
 * Wait for a job inside the tool call, or hand it back still running.
 *
 * The registry's own wait is used rather than a local poll, for one reason that
 * matters to the model: a settlement a live wait releases is reported as
 * `awaited`, so a result the caller is about to read does NOT also arrive later
 * as a completion notice. A timeout is not an error and never kills the job.
 */
async function awaitJob(
  ctx: Context,
  engine: BridgeEngine,
  id: string,
  agent: { id: string },
  timeoutSec: number,
  signal: AbortSignal,
): Promise<void> {
  const bounded = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(1, timeoutSec) * 1000)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
  await Promise.race([
    ctx.jobs.wait(id as never, Math.max(1, timeoutSec) * 1000, agent.id as never).then(
      () => undefined,
      () => undefined,
    ),
    bounded,
  ])
}

/**
 * Register both tools.
 * @param ctx - the plugin's context, already carrying `tools` and `jobs`.
 * @param engine - the toolchain engine the tools drive.
 * @param config - resolved plugin configuration.
 */
export function registerBridgeTools(ctx: Context, engine: BridgeEngine, config: ToolBridgeConfig): void {
  ctx.tools.register(
    defineTool({
      name: 'bridge_run',
      description: [
        'Run a toolchain command that the file sandbox denies, outside that sandbox: `flutter`/`dart` (any subcommand), a guard-railed `git`, a package manager (`pnpm`, `npm`, `npx`), or the project\'s own `vite`/`vitest`/`svelte-check`/`svelte-kit`/`tsc` from its node_modules.',
        'Prefer it over the shell tools for those commands: the shell runs inside the sandbox, where the Flutter SDK cannot take its own lockfile and where a Node toolchain dies on `spawn EPERM` (the sandbox denies the named pipes libuv needs for child stdio).',
        'A refused command is a deliberate answer, not a bug: `dart run` is not confined by anything here, so the refusals bound *recoverable surprise* (`git restore .`, `reset --hard`, `git push`, `pnpm exec <anything>`, a cwd-retargeting flag), not reachability.',
        'Test runs come back digested: `summary`, `counts` and the complete `failures` inventory, plus a `baseline` split against the project\'s `.toolbridge/known-failures.json` — `baseline.newFailures` names the failures your change introduced, and a failure is yours unless the registry claimed it.',
        'A command that runs until killed (`vite dev`, `vitest` in watch mode, a `dev`/`start`/`serve`/`watch` script) is guessed onto its own lane so it cannot starve the builds behind it; pass `long` to override the guess either way, and `background: true` to submit without waiting.',
        '`wait` (default true) blocks for queue time plus run time, bounded by `timeoutSec`. When that expires the job is still running and unchanged: fetch it with `job_output <id>`, stop it with `job_kill <id>`. The job\'s output is mirrored into the job runtime\'s own output ring as the run writes it, so a running job can be read incrementally and a settled one read in full.',
        'Every run is serialized with every other run in the same working directory — concurrent Flutter invocations corrupt `build/`, and two Vite builds share `dist/`. `aheadOf` says how many unfinished jobs are in front of yours on your own lane.',
      ].join(' '),
      parameters: {
        cmd: {
          type: 'string',
          required: true,
          description: 'The command: flutter, dart, git, pnpm, npm, npx, vite, vitest, svelte-check, svelte-kit or tsc.',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments, passed as an argv list. There is no shell: a quoted string stays one argument.',
        },
        message: {
          type: 'string',
          description:
            'A commit message for `git commit`, folded in as `-m <text>`. No file is ever created for it, so a later `git add -A` cannot sweep it into a commit. Refused for every other command, and refused alongside an `-m`/`-F`/`-C` the argv already carries.',
        },
        scope: {
          type: 'string',
          enum: ['uncommitted'],
          description:
            '`uncommitted` narrows the command to the working tree\'s uncommitted `.dart` files, read once here. `dart format` receives them as trailing paths (the formatter itself is narrowed — CI\'s changed-files check, run locally); `analyze`/`fix` can only take a directory, so there the scope narrows the returned lines and the exit code still covers the whole project. Nothing uncommitted is a refusal, not a whole-tree run.',
        },
        long: {
          type: 'boolean',
          description: 'Force the long lane (`true`) or the queue (`false`) instead of guessing.',
        },
        background: {
          type: 'boolean',
          description:
            'Submit without waiting and return the job id at once. Its output then arrives through `job_output`, a completion notice wakes you when it settles, and `job_kill` stops it.',
        },
        timeoutSec: {
          type: 'number',
          description: `Seconds to wait inside this call (default ${config.defaultTimeoutSec}). Expiry returns the job as it stands; it is never killed by a timeout.`,
        },
        grep: {
          type: 'string',
          description:
            'A regex selecting which log lines come back. The whole log is scanned and every match counted, so "no matches" is distinguishable from "no output". Cannot be combined with `scope`, which is also a log filter.',
        },
        tail: {
          type: 'number',
          description: 'How many log lines to return (default 200, capped at 5000, `0` for none).',
        },
      },
      output: {
        schema: JobOutputSchema,
        render: (_args, value) => [{ type: 'text', text: renderJob(value) }],
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) throw new ToolFailure('bridge_run needs a session: no agent on this execution')
        if (args.scope !== undefined && args.grep !== undefined) {
          throw new RefusalError(400, 'pass either grep or scope, not both')
        }
        const view = await engine.submitCommand(
          {
            cmd: args.cmd,
            args: args.args ?? [],
            message: args.message ?? null,
            scope: args.scope ?? null,
            long: args.long ?? null,
          },
          agent,
        )
        if (args.background !== true) {
          await awaitJob(ctx, engine, view.id, agent, args.timeoutSec ?? config.defaultTimeoutSec, exec.signal)
        }
        return toOutput(engine.result(view.id, args.grep ?? null, args.tail))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'bridge_arb_edit',
      description: [
        'Edit Flutter ARB localization files and run `flutter gen-l10n`, as one atomic operation: the ARB edit is file surgery, but the gen-l10n that must follow it cannot run inside the file sandbox — and doing both here makes the pair one request instead of two escalations.',
        'Every target file is planned in memory first, so a missing anchor fails the job with zero files touched and names the file and key. Run with `dryRun: true` to see exactly what would change without writing anything.',
        'Line endings are preserved per file and values are written as raw UTF-8, so CJK text needs no escaping.',
        'If gen-l10n fails, the edits *were* written: read the log, fix the ARB, and re-post. `result.genL10n.exitCode` says so and `result.untranslated` reports the configured untranslated-messages file when it has content.',
      ].join(' '),
      parameters: {
        groups: {
          type: 'array',
          required: true,
          description: 'One or more edit groups, applied in order.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              insertAfter: {
                type: 'string',
                description:
                  'Key to insert after, or `__END__` for the end of the file. Required when `newFields` is non-empty. If the anchor owns an `@key` metadata block, the new entries go after the block so it stays attached.',
              },
              deleteFrom: {
                type: 'string',
                description: 'First key of an inclusive range to delete (needs `deleteTo`).',
              },
              deleteTo: {
                type: 'string',
                description: 'Last key of that inclusive range; its `@key` block goes with it.',
              },
              newFields: {
                type: 'array',
                description:
                  'Keys to insert, each with the value to write per ARB file. Omit entirely for a pure delete. Keys starting with `@` are refused: gen-l10n generates that metadata.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    key: { type: 'string', required: true, description: 'The new message key.' },
                    value: {
                      type: 'object',
                      additionalProperties: true,
                      description:
                        'ARB file name → translated string, e.g. {"app_en.arb": "LAN Sync", "app_zh.arb": "局域网同步"}.',
                    },
                  },
                },
              },
            },
          },
        },
        dryRun: { type: 'boolean', description: 'Plan only: nothing is written and gen-l10n does not run.' },
        timeoutSec: { type: 'number', description: 'Seconds to wait inside this call; expiry leaves the job running.' },
        grep: { type: 'string', description: 'A regex selecting which log lines come back.' },
        tail: { type: 'number', description: 'How many log lines to return (default 200).' },
      },
      output: {
        schema: JobOutputSchema,
        render: (_args, value) => [{ type: 'text', text: renderArb(value) }],
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) throw new ToolFailure('bridge_arb_edit needs a session: no agent on this execution')
        const cwd = workingDirectory(agent)
        // The schema layer: everything checkable without the filesystem. A
        // semantic problem (an anchor missing from one file) belongs to the plan
        // phase inside the job, where it fails with nothing written.
        const instruction = validateInstructions({ groups: args.groups, dryRun: args.dryRun ?? false })
        const view = engine.submitSubTool({
          owner: agent.id,
          cwd,
          displayArgv: ['tool:arb-edit', `${instruction.groups.length} group(s)`],
          body: async (record, job: JobHandle) => {
            const plan = planArbEdits(cwd, instruction)
            const result: ArbResult = {
              dryRun: instruction.dryRun,
              edited: [],
              skipped: plan.skipped,
              changes: plan.files.map((file) => ({ file: file.name, inserts: file.inserts, deletes: file.deletes })),
              genL10n: null,
              untranslated: null,
            }
            if (instruction.dryRun) {
              record.result = result
              record.exitCode = 0
              record.status = 'done'
              job.append(`dry run: ${plan.files.length} file(s) would be edited\n`)
              return
            }
            result.edited = applyArbEdits(plan)
            record.result = result
            job.append(`${result.edited.length} ARB file(s) edited\n`)
            const resolved = resolveLaunch(['flutter', 'gen-l10n'], null, cwd)
            record.resolvedArgv = resolved.argv
            const run = new ProcessRun(resolved.argv, cwd, { ...process.env, ...resolved.env }, record.logPath)
            record.run = run
            run.start()
            const settlement = await run.settled
            record.exitCode = settlement.exitCode ?? 1
            result.genL10n = { exitCode: record.exitCode }
            result.untranslated = readUntranslated(plan.untranslatedFile)
            record.status = settlement.killed ? 'killed' : record.exitCode === 0 ? 'done' : 'failed'
          },
        })
        await awaitJob(ctx, engine, view.id, agent, args.timeoutSec ?? config.defaultTimeoutSec, exec.signal)
        return toOutput(engine.result(view.id, args.grep ?? null, args.tail))
      },
    }),
  )
}

# Sub-tools are queue jobs, not a second execution path

**Status**: accepted

The bridge accepted only executables (`flutter`, `dart`, a guard-railed `git`).
Editing Flutter ARB localization files needs more than one command, though: the
edit itself is file surgery the confined agent could do, but the `flutter
gen-l10n` that must follow it cannot run under the sandbox at all. The old
`flutter-arb-edit` skill owned that sequence, so using it cost a second
`danger-full-access` escalation — exactly the cost the bridge exists to remove.

A **sub-tool** is that sequence as a first-class operation: it is literally a
`ctx.jobs` job — `bridge_arb_edit` registers one with `kind: 'bridge'`, it queues
behind a running build on the same lane, it is stopped by the same id through
`job_kill`, and its log is the job's own — and the only difference from a command
is what the single worker executes. `arb-edit` is the first member.

## Considered options

- **Run the sub-tool synchronously in the tool handler.** Simplest, and rejected:
  it bypasses the single-worker queue. `flutter gen-l10n` writes generated files
  into the project, which is the same class of race that made the queue necessary
  for `flutter build`; a synchronous handler would also lose `job_kill`, the job
  log, and any trace in the harness's job roster.
- **Allow `python` in the accepted-executable list and run the old script through
  `bridge_run`.** Rejected: it widens the accepted-executable surface for one
  script, returns a log instead of a structured result, and pushes the
  instruction JSON through a temp file — the pattern the inline commit `message`
  field exists to avoid.
- **Split the operation: agent does the file edits, bridge runs gen-l10n.**
  Rejected: one atomic operation reported by two mechanisms, and a failed plan
  could no longer guarantee that no file was written.

## Consequences

- A sub-tool job is a Job, so `wait`, `timeoutSec`, `tail`, `grep`, `aheadOf`,
  `job_kill` and the harness's job roster all apply unchanged. Its job view
  carries the structured `result` where a command's carries a digest, and the
  engine's own ledger keeps `kind` (`cmd` vs `arb-edit`) so the two render
  differently.
- Because that job is owned by the calling session, the conversation can stop it
  by ceasing to exist: archiving the conversation kills the jobs it owns, through
  the Workspace archive admission the jobs registry installs. That is a bound the
  retired server could not express at all — it watched a process, not a
  conversation.
- Validation is split along the same line as `bridge_run`: schema errors are
  checkable without the filesystem, so they are refused at submit time, while
  semantic errors (an anchor missing from one file) fail the job with nothing
  written.
- `arb-edit` plans every file before writing any. The old script edited files
  one at a time and could abort halfway when a later file lacked a delete
  anchor; now that instruction is a clean failure with zero files touched.
- The instruction body carries **no** `cwd`: a sub-tool runs in the
  conversation's working directory like everything else (ADR-0002). Editing a
  different project means having the conversation in that project's directory.
- Both tools are one switch. The toolchain half is registered once, globally, and
  a conversation that turned it off gets a restriction naming `bridge_run` and
  `bridge_arb_edit` together, so a conversation cannot have the sub-tool without
  the runner beside it.

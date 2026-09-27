# Sub-tools are queue jobs, not a second execution path

**Status**: accepted

The bridge accepted only executables (`flutter`, `dart`, a guard-railed `git`).
Editing Flutter ARB localization files needs more than one command, though: the
edit itself is file surgery the confined agent could do, but the `flutter
gen-l10n` that must follow it cannot run under the sandbox at all. The old
`flutter-arb-edit` skill owned that sequence, so using it cost a second
`danger-full-access` escalation — exactly the cost the bridge exists to remove.

A **sub-tool** is that sequence as a first-class operation: `POST /tools/<name>`
creates a Job the same way `/run` does, and the only difference is what the
single worker executes — a Python runner instead of an argv. `arb-edit` is the
first member.

## Considered options

- **Run the sub-tool synchronously in the HTTP handler thread.** Simplest, and
  rejected: it bypasses the single-worker queue. `flutter gen-l10n` writes
  generated files into the project, which is the same class of race that made
  the queue necessary for `flutter build`; a synchronous route would also lose
  `POST /jobs/<id>/kill`, the job log, and any trace on the human's status page.
- **Allow `python` in `ALLOWED_EXES` and run the old script through `/run`.**
  Rejected: it widens the accepted-executable surface for one script, returns a
  log instead of a structured result, and pushes the instruction JSON through a
  temp file — the pattern the inline commit `message` field exists to avoid.
- **Split the operation: agent does the file edits, bridge runs gen-l10n.**
  Rejected: one atomic operation reported by two mechanisms, and a failed plan
  could no longer guarantee that no file was written.

## Consequences

- A sub-tool job is a Job, so `wait`, `timeoutSec`, `tail`, `grep`, `aheadOf`,
  `/jobs/<id>/kill` and the status page all apply unchanged. Its job JSON adds
  `kind` (`tool` vs `cmd`) and `result`.
- Validation is split along the same line as `/run`: schema errors are checkable
  without the filesystem, so they answer `400` at submit time, while semantic
  errors (an anchor missing from one file) fail the job with nothing written.
- `arb-edit` plans every file before writing any. The old script edited files
  one at a time and could abort halfway when a later file lacked a delete
  anchor; now that instruction is a clean failure with zero files touched.
- The instruction body carries **no** `cwd`: a sub-tool runs in the pinned
  directory like everything else (ADR-0002). Editing a different project means
  starting a bridge with that `--cwd`.
- `/health` reports `tools`, so a client can tell a bridge that supports a
  sub-tool from one deployed before it.

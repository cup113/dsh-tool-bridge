# Model-facing output is plain text

**Status**: accepted

Third time in one day, same shape. A defect that returns a well-formed empty
answer is invisible to every reader: `ProcessRun.cancel()` left orphans behind
without saying so (ADR-0008), `job_output` returned `(no new output)` for jobs
that had plenty (ADR-0009), and now the **digest** returned `null` for a green
suite because the reporter coloured its output.

The measurement, on a real bridge job log (`flutter`/vitest jobs both):

- 240 escape bytes in 2 309 — a summary line that reads, byte for byte,
  `\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m197 passed\u001b[39m\u001b[22m`.
- Every vitest pattern in `digest.ts` anchors on `^`, so that line matched
  nothing: `counts === null`, `summary === 'see log'`, no failure inventory.
  Verified directly — the same line matches once the escapes are removed, and
  not before.
- `digest.ts` carried the assumption in a comment: *"vitest 5's default reporter,
  as a job log gets it (no TTY, so no colour)"*. It is false here. The reporter's
  colour library (`tinyrainbow`) counts `platform === 'win32'` as colour support
  and so colours a **pipe**; the fixtures are colourless, so no test noticed.

Nor is the digest the only surface: a **Tail**, a **Log filter**'s lines, and the
Ring a model reads through `job_output` all carried the same bytes, spending
tokens on `[32m` and making a caller's own regex behave differently from the text
it is shown.

## Decision

**Two halves: turn colour off for every tool the plugin starts, and strip it at
every read that hands text to the model.**

The override half is the harness's own: its `pwsh` tool gives its children
`NO_COLOR=1`, `PAGER=cat`, `GIT_PAGER=cat` under the heading "model-friendly
environment overrides", for the same reason. The bridge is the harness's other
producer of tool output and had none of them; `engine/env.ts` now holds them and
applies them last, so nothing in a job's own environment can put colour back.
Measured: the reporter's colour is defeatable this way (`vitest run --no-color`
produced a log with no escapes at all).

The strip half is the guarantee, at the three reads that matter: the log tail and
filter (`host/logfile.ts`), the line source both digests share
(`engine/digest.ts`), and the output-ring mirror (`host/jobsource.ts`). Ordering is
part of it — the strip happens *before* a filter's lines are counted, so
`matched`/`returned`/`scannedLines` describe the text the caller receives rather
than bytes that were then removed from it.

The ring needs one extra care the file readers do not: an incremental read can end
in the middle of a sequence the writer emitted whole, because the read boundary
and the write boundary are unrelated. Those bytes are held back and re-read, the
same treatment an incomplete UTF-8 character already got — otherwise the ring
would receive a `[32m` fragment one read later, which is the damage this change
exists to prevent.

**The log file is never rewritten.** It is the raw record, it is what a caller can
go back to when the stripped view is not enough, and a rewriting writer would be a
new failure mode on the one artifact that outlives a run.

## Considered options

- **`--no-color` on every command's argv.** Rejected: it edits the caller's
  command, the plugin would have to know each tool's spelling of the flag, and a
  tool that has no such flag would silently keep its colour.
- **The environment override alone.** Rejected by measurement, not taste: it is a
  convention. A tool that ignores `NO_COLOR`, forces colour with its own flag, or
  writes a sequence from inside a program leaves the digest broken exactly as
  before — and the digest is the bridge's flagship result.
- **Rewriting the log file once, at the end of a run.** Rejected: mutating the raw
  record, for a benefit the read-side strip already gives.
- **Making the parsers colour-tolerant** (optional escape groups in every
  pattern). Rejected: it must be repeated in every pattern of every reader,
  it fixes only the digest, and the tail and the ring would still be coloured.

## Consequences

- A caller's `grep` pattern is matched against the same text it is shown, and a
  **Digest** reads a coloured log exactly like a plain one — pinned by three
  cases in `tests/digest.spec.ts` whose escape sequences are the measured ones,
  plus the source's own cases in `tests/ansi.spec.ts`.
- The digest's comment no longer asserts the opposite of what happens.
- `runGitStatus` (the uncommitted scope's own `git status`) takes the same
  overrides: it parses and returns tool output like any other read.
- **Honest limit**: the two halves are verified by tests and by measurement of the
  offending bytes, not end to end through a live session — the running plugin is
  loaded from the built bundle, so the environment override reaches a job only
  after a rebuild and a harness restart. The strip needs no restart to be
  correct, only to be *loaded*.

# The job output ring is fed from the log, so `job_output` reads a bridge job

**Status**: accepted

`CONTEXT.md` described a **Job** as one whose "output ring" the harness's job
runtime owns and `job_output` reads. Half of that was true. `job_*` is indeed how
a bridge job is listed, waited on and killed — but the ring had no writer at all:
`bridge_run` starts a process with `node:child_process`, and its stdout and
stderr go into the run's own UTF-8 log file and nowhere else. Only
`bridge_arb_edit` ever called `JobHandle.append`, for its two narration lines.

The result was a tool that answered confidently and emptily, measured across a
whole session:

- `job_output bridge-41` → `(no new output)` / `[status: running, flutter test]`
- `job_output bridge-43` → `(no new output)` / `[status: failed, exit code: 1]`
- `job_output bridge-47` → `(no new output)` / `[status: completed]`

Success and failure, running and finished: the same nothing, because the ring was
empty in every case. The same job's log read back fine through `bridge_run`'s own
`tail`/`grep`, so nothing looked broken — the tool description even said "fetch it
with `job_output <id>`", and a timed-out call is documented to hand the job back
to be read that way. This is the worst shape a defect can have here: the model
follows the documented path, gets a well-formed empty answer, and concludes the
job produced no output.

## Decision

**A command job registers the log file as a `JobOutputSource`, and the registry
pumps it into the output ring.** One writer, one stream, two readers: the tool's
own `tail`/`grep` view keeps reading the file, and the ring mirrors it on the
registry's cadence (150 ms by default).

Three properties are deliberate:

- **The log file is the source of truth, not a copy.** A read is
  `open`/`read`/`close` over the delta; nothing is buffered per byte in the
  plugin. The same file is advertised as the source's `spillPath`, which is
  honest here in a way it is not for a process pipe: one log per job, append-only,
  never trimmed, so the path really does hold the complete stream for a reader
  whose cursor fell behind retention.
- **Offsets are UTF-8 byte offsets, and a character is never split.** The
  registry's coordinates are bytes while the ring hands out strings, so a read
  ending mid-character would decode a replacement character — mojibake in the
  middle of output that is routinely CJK (the ARB values are Chinese). A trailing
  partial sequence is held back and re-read with the bytes that complete it.
- **The mirror is bounded** at 4 MiB (`JOB_OUTPUT_MIRROR_BYTES`), sized from the
  incident's own 1.4 MB `flutter test` log. Past the cap the read is lossy, which
  the ring renders as a gap plus the spill path: the model reads the file rather
  than the plugin mirroring an unbounded stream into memory.

`bridge_arb_edit` deliberately does **not** get one: it narrates itself through
`JobHandle.append`, and a second source over the gen-l10n log would give the
model two interleaved accounts of one job.

## Considered options

- **`job.append` from the run's `data` handler**, which is what the sub-tool
  already does. Rejected: it puts every byte of every build log into the ring
  with no bound, and the ring's live retention is 256 KiB — the plugin would be
  copying bytes into a buffer that immediately drops them, while the log file,
  which is what the caller actually wants to keep, is written anyway.
- **Tell the model to read the log file with the ordinary file tools** and drop
  the `job_output` claim. Rejected: it makes a bridge job second-class among the
  harness's jobs — no incremental read of a running job, no completion read, and a
  documented control (`job_output`) that stays broken for exactly one producer.
- **A `JobOutcome.result` at settlement carrying the log tail.** Rejected as the
  answer: it arrives once, at the end, so a running job is still unreadable, and
  it duplicates a digest the tool already returns.
- **Widening the digest into the ring** (counts, failures, baseline). Rejected as
  scope: the tool's own result already carries the digest, and the ring is a byte
  stream, not a place for structured verdicts.

## Consequences

- `bridge_run`'s job view is unchanged; what changes is that the harness's own
  read now returns the job's output. `job_output` on a bridge job streams while
  it runs and is complete once it settles.
- The ring's retention rules now apply to a bridge job's output like any other
  producer's: 256 KiB live, then the settled cap, with the log file as the
  fallback for anything a reader missed.
- The residual gap is stated rather than implied: the **pump** is the registry's
  code, so the plugin's suite covers the source (bytes, ordering, UTF-8
  boundaries, the cap, the cursors) and the registration (a command job gets one
  source that serves that job's log; a sub-tool gets none), while the on-the-wire
  integration is exercised by the harness at runtime. It is not claimed here as
  measured end to end.

# A runner's verdict is not a flag, and `failures-only` writes bare progress lines

**Status**: accepted

A panel row read, in one glance:

```
flutter test --reporter=failures-only
failed · long lane · exit 1 · 401s
all tests passed
```

The job failed and the digest announced a pass. Two defects had to line up for
that sentence, and both were assumptions the fixtures agreed with.

**The marker was a boolean.** `TEST_TERMINAL_MARKERS` held `All tests passed!`
next to `Some tests failed.`, and either one set `terminal = true`.
`summarizeTestRun(counts, terminal)` then had exactly one place to claim a pass
with no counts — `if (counts === null) return terminal ? 'all tests passed' : 'see log'` —
so the *failure* marker took that branch. A test pinned it
(`summarizeTestRun(null, true) === 'all tests passed'`), which is why it read as
intended rather than as a bug.

**The progress line has two shapes, and only one was read.** `--reporter=failures-only`
writes every one of its progress lines bare — no `HH:MM` prefix — while
`TEST_COUNTS_RE` and `TEST_FAILURE_RE` both anchored on the timestamp. Measured on
the captured log behind that panel row (2 503 lines):

- 0 timestamped progress lines, 240 bare ones;
- 8 `[E]` failure lines, *all* of them bare, so the **failure inventory was empty
  too** — not just the counts;
- last line `+7430 ~49 -8: Some tests failed.` while the job exited 1.

So `counts === null` was guaranteed for this reporter, the verdict was `true` by
the second defect, and the digest invented "all tests passed" for a run with
8 failures. Nothing else noticed: the fixtures for this reporter carry
*timestamped* lines, so they exercise a shape the real reporter never writes.

## Decision

**A verdict, not a flag; and both progress-line shapes are read.**

- `SuiteVerdict = 'passed' | 'failed' | 'unfinished'`, derived from two marker
  sets. "All tests passed" is now claimed in exactly one situation: no counts at
  all *and* a **success** marker. A failure marker never yields a pass, even when
  the counts show no failures — a suite that died before it counted anything.
- Both `package:test` patterns accept the bare form, so a `failures-only` run
  yields its counts and its complete inventory.

Measured after, on that same log: `counts = {passed: 7430, skipped: 49, failed: 8}`,
8 failures listed, `summary = "7430 passed, 8 failed"`. Before: `counts = null`,
0 failures, `"all tests passed"`.

## Considered options

- **Patch only the no-counts branch** (keep the boolean, require a success
  marker). Fixes the false pass, leaves the counts and the whole inventory of
  every `failures-only` run unread — the more useful half of the data.
- **Accept a bare line only when it is the last line.** Rejected: the failure
  lines are bare too, and the inventory is what a caller acts on.
- **Read the tool's exit code instead of a marker.** Rejected: a digest is a
  reading of a log, and the exit code belongs to the job — a killed run, which is
  exactly when a digest matters most, has none. The two must stay independent so
  they can disagree, which is how this was caught.
- **Drop the "all tests passed" claim entirely.** Rejected, but it is a close
  call: the claim is the reporter's own sentence, and the branch is reachable only
  when a success marker appears with no progress line at all — rare, and it is
  what the ported suite pinned. The honest version of that is the one now in the
  code: one branch, success markers only, and the failure marker explicitly
  excluded.

## Consequences

- The `failures-only` fixture was rewritten to the reporter's real shape (bare
  lines), so the existing case now fails if the reader anchors on the timestamp
  again. It passed both ways before the fix, which is the whole reason this
  shipped.
- `summarizeTestRun`'s second parameter changed type, and the vitest parser passes
  `counts === null ? 'unfinished' : 'passed'`: vitest reports failures inside the
  summary line rather than in a separate marker, so a run that wrote one and
  counted no failures really did pass.
- Three new cases cover the bare form, a marker-only log, and a failure marker
  that the counts contradict; the primitive case now pins all three verdicts.

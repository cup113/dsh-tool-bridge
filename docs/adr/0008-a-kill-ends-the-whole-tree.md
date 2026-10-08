# A kill ends the whole process tree, and the sweep runs before the handle

**Status**: accepted

`child.kill()` ends exactly one process. For a toolchain job that is not enough:
`flutter test` runs as `dart.exe` (the `flutter_tools` snapshot) which starts one
`flutter_tester.exe` per test process, `vitest` forks workers, and `esbuild`
starts a service. Nothing follows the parent down by itself.

That gap turned into a file lock on 2026-10-08, in a real session, and the
sequence is worth recording because every step of it looked like something else:

- 14:35:52 a `flutter test` job was submitted with `long: true`.
- 14:41:49 the same job was killed. `ProcessRun.cancel()` called `child.kill()`,
  which ended `dart.exe` and nothing else.
- The two `flutter_tester.exe` processes it had started at 14:40:16 and 14:41:48
  stayed alive for the next hour and twenty minutes. One of them had
  `build\native_assets\windows\sqlite3.dll` mapped as an image section, and
  Windows refuses to delete a mapped image.
- Every later `flutter test` in that project therefore died in its native-asset
  step — `Flutter failed to delete file at
  "...\build\native_assets\windows\sqlite3.dll"` — four runs in a row.
- The holder could not be found at all, which is what made it look mysterious:
  from inside the file sandbox `taskkill /m` is denied, `Get-Process` sees 26 of
  331 processes, and 25 of the 27 it does see refuse a module-list read. The
  orphan was only named by an unconfined enumeration.
- Renaming the containing directory made the failure disappear, which is the
  tell: the mapping follows the file object, so moving the path out from under it
  is enough to let the next run proceed. That is a workaround, not a fix.

## Decision

**Every kill sweeps the tree first, then ends the process this run owns.**

The sweep is `taskkill /T /F /PID <root>`, resolved to
`%SystemRoot%\System32\taskkill.exe` rather than to whatever `PATH` offers, since
the one command whose whole job is to end processes should not itself be
redirectable. It is available to the plugin because the plugin runs in the host
process, outside the file sandbox — the same property that lets a job write a
project's `build/` while a sandboxed `pwsh` is refused that same write, measured
in the same minutes.

The order is the load-bearing part, and it was measured rather than reasoned:
`taskkill` resolves the pid when it finally runs, not when it is spawned. A first
attempt that started the sweep and the owned kill together came back, in the job
log, `taskkill exited 128: process "N" not found` — the root was already gone, so
the walk found nothing and every descendant was missed. The owned handle is
therefore held back until the walk is done, and then used as the fallback that
ends the direct child when the sweep is refused, missing, or too slow.

Settlement waits for the sweep. That is not tidiness: the lanes serialize on
settlement, so a job that settles while its children are still running releases
the lane onto their `build/` directory — the very race the queue exists to
prevent. "Settled" and "nothing of this run is still running" are one moment by
construction.

A refused sweep is written into the job's log (`[toolbridge] taskkill exited …`)
because the alternative is the state this ADR opened with: an orphan nobody can
name. The line is queued and appended at settlement, not written when the sweep
resolves — the log is an append stream whose file does not exist until its
asynchronous open completes, and a direct write could land *before* bytes the
process had already produced (measured, and fixed by the queue).

## Considered options

- **`taskkill /T /F` as the only kill.** Rejected: it is a separate process
  asking for access, and ADR-0004 measured it being refused under the old
  server's sandbox. Keeping the owned handle as the fallback means a refused
  sweep still ends the direct child, and the job always settles.
- **`taskkill` first, then the handle, but concurrently.** Rejected by
  measurement, as above: the concurrent form makes the sweep a no-op in the
  common case, because the root dies first.
- **A Windows Job Object, kill-on-close** (`@deepseek-ai/dsh-win32-process`,
  which the harness ships and the sandbox uses). The most correct mechanism
  available: the whole tree is one kernel-owned unit, nothing to walk. Rejected
  for this change because it replaces `node:child_process` with FFI process
  creation in the plugin — a much larger change to the runner than the defect
  warrants, and one whose failure modes (token handling, stdio inheritance,
  breakaway) are exactly where the sandbox code needed care. It remains the
  better answer if the sweep ever proves insufficient.
- **Enumeration instead of `taskkill`** (walk the process list, kill children
  first). Rejected: it re-implements a documented tool with a hand-rolled,
  inherently racy traversal, and `taskkill /T` already does it.
- **`taskkill /T` on POSIX with a process-group signal.** Rejected on the same
  terms as `resolve.ts`: the plugin is Windows-only by design and a POSIX branch
  nobody exercises is a claim, not a feature. `defaultTreeKill()` returns the
  reported no-op elsewhere.

## Consequences

- `ProcessRun` takes an injectable `killTree` (and `spawnProcess`), so the kill
  path is testable without a real process, and `defaultTreeKill()` is the only
  place that decides a platform's mechanism.
- The job's log can now carry a `[toolbridge]` line the toolchain never printed.
  It is the diagnostic that was missing when this bug was live.
- The kill is asynchronous behind a synchronous `cancel()`: the registry's
  contract says `cancel` returns now, and the OS work behind it is allowed to
  take the sweep's moment. The worst case is a helper that has to be timed out
  (10 s) before the owned kill lands.
- A regression drill covers it (`tests/runner.spec.ts`): a real root, a real
  detached grandchild, killed through the runner. Its first half kills the same
  shape with a plain single-process kill and *asserts that the grandchild
  survives*, so the drill fails loudly rather than passing vacuously if the shape
  ever stops meaning what it means — which it did: an attached grandchild dies
  with its node parent in this environment, and a drill built on one passed with
  the tree kill deleted.

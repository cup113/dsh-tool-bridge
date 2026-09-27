# tool-bridge

A session-scoped, loopback-only server that runs the Flutter/Dart toolchain, a
small git verb set, and sub-tools such as `arb-edit` on behalf of a confined DSH
agent, so the agent pays one `danger-full-access` approval per session instead
of one per command. This file fixes the vocabulary; `docs/adr/` records the
decisions that are expensive to reverse.

## Language

### The server and its cost

**Bridge**:
The running server process — one per session, bound to a random loopback port, started once with the session's single escalation.
_Avoid_: proxy, gateway, toolhub daemon, plugin

**Escalation**:
One `danger-full-access` approval of one command, granted by the human for that command only.
_Avoid_: permission, privilege, access level, "opening the sandbox"

**Escalation count**:
How many times a session had to leave the bridge to get a command run; the bridge's reason to exist is driving this to one per session.
_Avoid_: escalation hole, privilege leak, 提权口

**Allowlist**:
The set of executables (`flutter`, `dart`, `git`) and git verbs the bridge accepts.
_Avoid_: sandbox, security boundary, whitelist, permission system

**Guardrail**:
What the allowlist actually is: a bound on *recovery cost and surprise* for a fallible caller, not on privilege — `dart run <file>.dart` already executes arbitrary code with the bridge's access.
_Avoid_: protection, isolation, containment

**Pinned cwd**:
The one working directory fixed at boot; every job runs there and no request can change it.
_Avoid_: workspace root (the cwd is usually the workspace, but that is a coincidence, not the definition)

### Work

**Job**:
One accepted command plus its log file and digest; the unit `/run` returns and `/jobs` lists.
_Avoid_: task, run, invocation, process (a job may outlive or precede its process)

**Job status**:
`queued` → `running` → `done` | `failed` | `killed`.
_Avoid_: pending, success, error, cancelled

**Queue**:
The single-worker line jobs wait in; at most one toolchain job runs at a time because concurrent Flutter runs corrupt `build/`.
_Avoid_: pool, concurrency, workers

**Sub-tool**:
A named operation the bridge executes as a **Job** — `arb-edit` is the first — with the instruction as the request body and a structured `result` instead of a test **Digest**. It exists so an operation whose steps include a toolchain call is one request and no extra **Escalation**.
_Avoid_: endpoint, plugin, macro, command

**Plan phase**:
The stage that computes every target file's new content before any file is written, so a semantic error (a missing anchor) leaves the whole set untouched.
_Avoid_: validation (that is the schema check at submit time), preview

**`result`**:
The structured outcome of a **Sub-tool** job: which files were edited, which keys were inserted or deleted, the gen-l10n exit code, and any untranslated messages.
_Avoid_: output, report, digest (a Digest belongs to a test run)

**Digest**:
The parsed view of a finished test job: `summary`, `counts`, `failures`. Absent for non-test jobs.
_Avoid_: result, report, analysis

**Counts**:
`passed`/`skipped`/`failed` read from the last `+N ~S -K:` progress line; the authoritative total.
_Avoid_: totals, stats, "the numbers in the summary"

**Failure inventory**:
The per-test failure list taken from `[E]` progress lines, in run order, with a suite path filled in from the block when one is available.
_Avoid_: failure list (ambiguous — see the block), errors

**`Failing tests:` block**:
The reporter's own end-of-run summary: at most four entries, sorted by path, then `... and N more`. A truncated digest, *not* the inventory.
_Avoid_: failure inventory, failure list, "the fixed format"

**Tail**:
How many log lines a response returns — `/run` defaults to 200, `/jobs/<id>?tail=N` to 200, both capped at 5000.
_Avoid_: maxLines, limit, count, head

**Log filter** (`grep`):
An optional regex that selects which log lines are eligible; `tail` then caps the number returned. The response's `log` object reports `matched`, `returned`, `scannedLines` and `truncated` so "no matches" never reads as "no output".
_Avoid_: search, filter, pattern match

### Git surface

**Pathspec guard**:
The rule that `restore` accepts only literal, relative, non-wildcard paths — no `.`, `..`, `:` magic, glob, absolute path, or `--pathspec-from-file`.
_Avoid_: path validation, path check

**Destructive (git)**:
Irreversible **and** not confined to paths the caller just named. `reset --hard` is destructive; `restore .` is destructive; `restore -- lib/a.dart` is not.
_Avoid_: history-rewriting (too narrow — `restore .` rewrites no history and is still destructive)

**Inline message**:
A commit message passed as the `/run` field `message`, which the bridge folds into argv as `-m <text>`. No file is ever created for it.
_Avoid_: commit body, message file, `-F` file

### Investigation

**Baseline attribution**:
Deciding whether a failing test was already failing before the caller's change — the question "is this failure mine?".
_Avoid_: regression bisect, blame

**Backup-and-restore**:
The sanctioned baseline-attribution recipe: copy the dirty files to a scratch directory inside the workspace, `git restore -- <paths>`, run the job, copy the files back.
_Avoid_: stash (a different, deliberately absent mechanism), revert

## Relationships

- One **Bridge** serves one session and owns one **Queue** and one **Pinned cwd**.
- A **Sub-tool** is a **Job**: it queues, logs and is killed like any other, and its **`result`** is what a **Digest** cannot express.
- A **Sub-tool** runs in the **Pinned cwd** like everything else; its body carries no `cwd`.
- A **Bridge** is started by exactly one **Escalation**; every job after that costs none, so the **Escalation count** is normally 1.
- A **Job** has one **Job status**, one log, and — for a test run — one **Digest**.
- A **Digest** holds one **Counts** and one **Failure inventory**; the **`Failing tests:` block** may supply paths to the inventory but never its order or completeness.
- A **Tail** and an optional **Log filter** shape a response, not a job: the raw log is never rewritten.
- The **Allowlist** is a **Guardrail**; it is not a privilege boundary, because `dart` reaches arbitrary code.

## Example dialogue

> **Dev:** "The feedback calls `git restore` the last escalation hole. So allowing it closes a privilege leak?"
> **Maintainer:** "No — nothing leaks. The allowlist never confined privilege; `dart run` already executes anything. What the refusal cost us was an **escalation count** of two per session instead of one, so the fix is about recovery cost, not security."
> **Dev:** "Then why not allow `git restore .` too? It's path-scoped by definition."
> **Maintainer:** "Because **destructive** means irreversible *and* unnamed. `restore .` throws away every uncommitted file in one call, which is exactly the class we keep out; `restore -- lib/a.dart` names what it destroys. That's the whole **pathspec guard**."
> **Dev:** "And the failure list — the reporter prints a `Failing tests:` block, why not parse that?"
> **Maintainer:** "That's a truncated digest: four entries, alphabetical, and `-r failures-only` doesn't print it at all. The **failure inventory** is the `[E]` lines; the block only lends a path."
> **Dev:** "If a fix looks wrong, can I run the test at the parent commit to check?"
> **Maintainer:** "For your own uncommitted work, use **backup-and-restore** — copy, `git restore -- <paths>`, run, copy back. For a *different* commit there is no entry; the **Pinned cwd** is deliberate (ADR-0002)."

## Flagged ambiguities

- "escalation hole" / "提权口" was used for *a command that costs an extra approval* — resolved: that is an **escalation count**, not a privilege leak; the allowlist is a **Guardrail** (ADR-0001).
- "destructive git" was used to mean *history rewriting* — resolved: **destructive** = irreversible **and** not confined to named paths, which is why `restore .` is refused but `restore -- <path>` is allowed.
- "the `Failing tests:` block is the failure list" — resolved: it is a **truncated digest** (≤4 entries, sorted by path, absent under `failures-only`); the **Failure inventory** is the `[E]` lines.
- `maxLines` (from the field feedback) and the existing `tail` are the same knob — resolved: one name, **Tail**.
- "the token lives only in memory" — resolved: the bridge never writes it to a file, but auto-open puts it in the browser's address bar and history; say "never written to a file", not "memory only".
- "arbitrary command execution is absent" (README) — resolved: it is absent as *an accepted executable name*, not as a capability; `dart` runs any Dart source in the workspace (ADR-0001).
- "sub-tool" / "子 tool" — resolved: a named operation executed as a **Job** with a structured **`result`** (ADR-0003), not a second execution path and not a DSH plugin; the first member is `arb-edit`, which retired the standalone `flutter-arb-edit` skill.
- "validation" for an ARB instruction — resolved: two different things with two different answers. Schema checks are a **400** at submit time; anchor/range problems happen in the **Plan phase** and fail the job with zero files written.

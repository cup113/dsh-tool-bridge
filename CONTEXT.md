# tool-bridge

A session-scoped, loopback-only server that runs the Flutter/Dart toolchain, a
Node toolchain, a small git verb set, and sub-tools such as `arb-edit` on behalf
of a confined DSH agent, so the agent pays one `danger-full-access` approval per
session instead of one per command. This file fixes the vocabulary; `docs/adr/`
records the decisions that are expensive to reverse.

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
The set of executables (`flutter`, `dart`, `git`, `pnpm`, and the **Script binaries**) and the git/pnpm verbs the bridge accepts.
_Avoid_: sandbox, security boundary, whitelist, permission system

**Guardrail**:
What the allowlist actually is: a bound on *recovery cost and surprise* for a fallible caller, not on privilege — `dart run <file>.dart` already executes arbitrary code with the bridge's access.
_Avoid_: protection, isolation, containment

**Pinned cwd**:
The one working directory fixed at boot; every job runs there and no request can change it.
_Avoid_: workspace root (the cwd is usually the workspace, but that is a coincidence, not the definition)

**Format pin**:
The dart executable fixed at boot by `--dart-format` that `dart format` **Jobs** run instead of the PATH one, so a session formats with the version a project's CI formats with — formatting with a newer local dart is what turns CI's `--set-exit-if-changed` check red.
_Avoid_: per-request exe, SDK override, toolchain pin (too broad: `dart analyze`/`test`/`pub` deliberately keep the PATH toolchain)

**Script binary**:
One of the project's own Node tools (`vite`, `vitest`, `svelte-check`, `svelte-kit`, `tsc`) that the bridge accepts by name and resolves inside the **Pinned cwd**'s `node_modules` by reading the package's `bin` field — never through the `.cmd` wrapper, which would put `cmd.exe` in the middle of an argv that is supposed to have no shell.
_Avoid_: local binary, npx tool, node_modules/.bin (that is the wrapper, which is exactly what is bypassed)

**`pnpm` surface**:
The named `pnpm` verbs the bridge accepts (`install`, `add`, `run`, `exec`, `why`, …), with the cwd-retargeting flags refused and `exec` narrowed to a **Script binary** — because `exec` also runs anything on `PATH`.
_Avoid_: package manager access, npm passthrough

**Uncommitted scope**:
The `/run` field `scope: "uncommitted"`: the **Pinned cwd**'s uncommitted `.dart` files (staged, unstaged and untracked; deleted and ignored excluded), read once at submit time. `dart format` receives them as trailing paths — the **Expansion**; `analyze` and `fix` accept at most one directory, so there the same set narrows the returned log lines — the **Filter**.
_Avoid_: changed files (that is CI's commit range, not the working tree), diff scope, git scope

**Expansion**:
How the **Uncommitted scope** reaches `dart format`: the files are appended to the **Job**'s argv, so the formatter itself is narrowed — the local shape of CI's changed-files format check.
_Avoid_: injection, argv rewriting

**Filter**:
How the **Uncommitted scope** reaches `analyze` and `fix`: `analyze` takes at most one directory and `fix` takes no path at all, so no argv can name a file set and the scope narrows the *returned* log lines instead; the exit code still describes the whole project.
_Avoid_: narrowing, subset run (it is not a run over a subset)

### Work

**Job**:
One accepted command plus its log file and digest; the unit `/run` returns and `/jobs` lists.
_Avoid_: task, run, invocation, process (a job may outlive or precede its process)

**Job status**:
`queued` → `running` → `done` | `failed` | `killed`.
_Avoid_: pending, success, error, cancelled

**Queue**:
The single-worker line **Queue-lane** **Jobs** wait in; at most one toolchain job runs at a time because concurrent Flutter runs corrupt `build/` and two Vite builds share `dist/`.
_Avoid_: pool, concurrency, workers

**Lane**:
Which of the two serialized worker lines a **Job** runs on: the **Queue** or the **Long lane**. Serialization is per lane, and `aheadOf` counts only the caller's own lane.
_Avoid_: channel, pool, thread (a lane is a serialization domain, not a resource)

**Long job**:
A **Job** expected to run until it is killed — `vite dev`/`preview`, `vitest`'s watch mode, a conventional `dev`/`start`/`serve`/`watch` script. It runs on the **Long lane**, because on the **Queue** it would starve every build behind it until somebody killed it.
_Avoid_: background job (nothing here is detached), daemon, server job

**Long lane**:
The second worker line, serialized among **Long jobs** only. The guess (`wants_long_lane`) covers the shapes that are certainly long; the `/run` field `long` overrides it either way, because the two error directions are not symmetric.
_Avoid_: dev lane, watch lane, second queue

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
The parsed view of a finished test job: `flavor`, `summary`, `counts`, `failures`. Absent for non-test jobs.
_Avoid_: result, report, analysis

**Flavor**:
Which test runner a **Digest** came from — `flutter` (`flutter test`/`dart test`) or `vitest`. It is what decides whether the **Known-failure registry** applies, and it comes from the reporter's own markers in the log when the argv cannot say (`pnpm run test`).
_Avoid_: runner, kind, framework (a `Sub-tool` job has a `kind`; this is about the log)

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

### UI walkthrough

**UI walkthrough**:
The model exercising a live UI with the browser tools — navigate, snapshot,
click, type, screenshot, watch — while the **Bridge** runs the **App under
test**, and reporting what it saw as artifacts. It is the exploratory half of
UI testing; the repeatable half is a script-driven E2E run, which is an
ordinary **Job**.
_Avoid_: E2E test (that is the script-driven run), browser automation, UI test

**App under test**:
The running application a **UI walkthrough** drives — normally a **Long job**
(`vite dev`, `vite preview`) on the **Bridge**, in the **Pinned cwd**. Its
lifecycle is the Bridge's, because starting it is what needs the boot
**Escalation** (Vite's `net use` probe dies inside the file sandbox).
_Avoid_: target app, SUT, dev server (that names the command, not the role)

**Driving**:
The other half of a **UI walkthrough**: navigate, snapshot, click, type,
screenshot, record. It belongs to the browser MCP server, which is outside the
Bridge entirely — so it is not a **Job**, not a **Lane**, and has no log, no
**Digest** and no status-page row.
_Avoid_: browser job, browser session (the Bridge holds neither)

**Browser tool**:
One of the model-facing tools the browser MCP server publishes
(`mcp__ui__browser_click`, `mcp__ui__browser_take_screenshot`, …). A screenshot
arrives as an image block in the tool result, and the same file read with the
harness's image tool is the other half of **Sight**.
_Avoid_: browser command, browser endpoint, tool call (too broad)

**Sight**:
How a **UI walkthrough** observes the page, in two interchangeable channels: the
image block a screenshot **Browser tool** returns, and the same screenshot file
read with the harness's image tool. Neither is privileged — the harness could
already read a local image, so image transport is a convenience (one tool call
instead of a file plus a read), never the reason for the split. What is not
optional is that a walkthrough must not report having seen a page it only has a
path to.
_Avoid_: vision, sight fallback, screenshot workaround

**Resident row**:
The profile patch entry that loads the browser MCP server into every session of
a profile — the accepted shape (ADR-0005), as opposed to a per-launch overlay.
What is resident is the *tool schemas*, which every request pays for; no browser
process exists until a **Browser tool** opens one.
_Avoid_: always-on plugin, permanent MCP, daemon

**Artifact copy-back**:
Moving a browser artifact — video, trace, PDF — from the row's fixed output
directory into the session workspace, so it can be handed to the human
(`present`). The output directory is outside every workspace on purpose.
_Avoid_: download, export, attachment

### Investigation

**Baseline attribution**:
Deciding whether a failing test was already failing before the caller's change — the question "is this failure mine?".
_Avoid_: regression bisect, blame

**Known-failure registry**:
The optional `<cwd>/.toolbridge/known-failures.json` that answers **Baseline attribution** from data instead of memory: an entry claims a failure by test name or regex, optionally narrowed by suite (`file`) and `platform`, and carries a `kind` and a `reason`.
_Avoid_: ignore list, suppression (an entry explains a failure, it never hides one), baseline file

**Baseline report**:
The digest field carrying the split — `source`, the `known`/`new` counts over **distinct tests**, `failed` (the authoritative **Counts** number they must reconcile with), `tests`/`events` (distinct tests vs `[E]` lines), `unparsed`, and `newFailures`, the complete ordered list of the failures the registry did **not** claim. It rides with the log view, so `/jobs` shows only the `summary` suffix.
_Avoid_: report (that is a sub-tool's `result`), diff, regression list

**Backup-and-restore**:
The sanctioned baseline-attribution recipe: copy the dirty files to a scratch directory inside the workspace, `git restore -- <paths>`, run the job, copy the files back.
_Avoid_: stash (a different, deliberately absent mechanism), revert

## Relationships

- One **Bridge** serves one session and owns one **Queue**, one **Long lane** and one **Pinned cwd**.
- A **Format pin** is boot-scoped like the **Pinned cwd**: no request can retarget either.
- An **Uncommitted scope** is computed once, at submit time; an empty one is refused, because `dart format` with no paths rewrites the whole tree.
- A **Known-failure registry** is read per **Job** from the **Pinned cwd**; with no registry a **Digest** is exactly what it was before the feature.
- A **Baseline report** names the new failures; the `summary` suffix only counts them, so "which ones" is never read off the one-liner.
- A **Sub-tool** is a **Job**: it queues, logs and is killed like any other, and its **`result`** is what a **Digest** cannot express.
- A **Sub-tool** runs in the **Pinned cwd** like everything else; its body carries no `cwd`.
- A **Bridge** is started by exactly one **Escalation**; every job after that costs none, so the **Escalation count** is normally 1.
- A **Job** has one **Job status**, one log, one **Lane**, and — for a test run — one **Digest**.
- A **Long job** runs on the **Long lane**, so it is never counted by `aheadOf` for a **Queue** job; a **Queue** job is never blocked by it.
- A **Script binary** is resolved in the **Pinned cwd** and runs under `node`; `pnpm exec` accepts one of those names and nothing else.
- A **Digest** holds one **Counts** and one **Failure inventory**; the **`Failing tests:` block** may supply paths to the inventory but never its order or completeness.
- A **Flavor** decides whether the **Known-failure registry** applies to a **Digest**; it is read from the argv when that is enough and from the log when it is not.
- A **Tail** and an optional **Log filter** shape a response, not a job: the raw log is never rewritten.
- The **Allowlist** is a **Guardrail**; it is not a privilege boundary, because `dart` reaches arbitrary code.

- A **UI walkthrough** drives an **App under test**: **Running** it is the Bridge's (a **Long job** in the **Pinned cwd**), **Driving** it is the browser MCP's, and the split is ADR-0005.
- A **Browser tool** costs no **Escalation** and creates no **Job**: the browser MCP is spawned by the harness, holds none of the boot approval, and appears in no **Lane**.
- A **UI walkthrough** produces artifacts, not a **Digest**; its finding becomes repeatable by being written as a script-driven E2E run through `/run`.
- A screenshot reaches the model through either half of **Sight**; the second half is not a degraded path but an ordinary one, and only the claim to have seen a page may not rest on a path.
- A **Resident row** is composed at boot; no request in the bridge surface can load, retarget or disable it.

## Example dialogue

> **Dev:** "The feedback calls `git restore` the last escalation hole. So allowing it closes a privilege leak?"
> **Maintainer:** "No — nothing leaks. The allowlist never confined privilege; `dart run` already executes anything. What the refusal cost us was an **escalation count** of two per session instead of one, so the fix is about recovery cost, not security."
> **Dev:** "Then why not allow `git restore .` too? It's path-scoped by definition."
> **Maintainer:** "Because **destructive** means irreversible *and* unnamed. `restore .` throws away every uncommitted file in one call, which is exactly the class we keep out; `restore -- lib/a.dart` names what it destroys. That's the whole **pathspec guard**."
> **Dev:** "And the failure list — the reporter prints a `Failing tests:` block, why not parse that?"
> **Maintainer:** "That's a truncated digest: four entries, alphabetical, and `-r failures-only` doesn't print it at all. The **failure inventory** is the `[E]` lines; the block only lends a path."
> **Dev:** "If a fix looks wrong, can I run the test at the parent commit to check?"
> **Maintainer:** "For your own uncommitted work, use **backup-and-restore** — copy, `git restore -- <paths>`, run, copy back. For a *different* commit there is no entry; the **Pinned cwd** is deliberate (ADR-0002)."
> **Dev:** "CI says my files are unformatted and `dart format` disagrees. So I format with CI's older dart?"
> **Maintainer:** "With a **Format pin**: one boot flag, and `dart format` jobs run that SDK while everything else keeps the local one. The pin is boot-scoped like the **Pinned cwd**, so a session cannot quietly format with the wrong dart."
> **Dev:** "Then `scope: uncommitted` on `dart analyze` analyzes only my files?"
> **Maintainer:** "It cannot — the analyzer takes a directory, not a file list. That request is a **Filter**: your files' lines come back, but the exit code still describes the whole project. Only `dart format` takes an **Expansion**."
> **Dev:** "I need `vite dev` running to look at the page while I fix a test. Add it to the queue?"
> **Maintainer:** "Not the **Queue** — a dev server never exits, so every build behind it would wait on a process that is working exactly as intended. It is a **Long job**, on the **Long lane**, and `pnpm run dev` is guessed onto it."
> **Dev:** "Then `pnpm exec` is the way to run anything else, since pnpm falls back to PATH?"
> **Maintainer:** "That fallback is the problem, not the feature — measured, `pnpm exec cmd /c echo hi` works. `exec` takes a **Script binary** name and nothing else; anything else is a 403 naming `pnpm run`."
> **Dev:** "And `pnpm run test` — does that get the known-failure split?"
> **Maintainer:** "Yes, and that is why a **Digest** has a **Flavor** read from the log: the argv `pnpm run test` says nothing about vitest, but the reporter's own markers do."
> **Dev:** "The walkthrough found a button no user can reach. So the browser becomes a **Job** on the **Queue**, and I drive it from there?"
> **Maintainer:** "No — a browser is not a **Job**. It has no log, no **Digest** and no **Lane**, and the Bridge never holds UI state (ADR-0005). The Bridge runs the **App under test**; the browser MCP does the **Driving**, as **Browser tools**, and your finding becomes repeatable by being written as a script-driven run through `/run`."
> **Dev:** "Then the same for a Flutter app?"
> **Maintainer:** "You can *look* at a Flutter web build and click it by coordinates — a canvas has no DOM to snapshot. On the desktop there is nothing to inject input with outside the test bindings, so that half stays `integration_test` through `/run`, which was never blocked."
> **Dev:** "And when the screenshot does not come back as an image?"
> **Maintainer:** "Then read the file yourself — that is the other half of **Sight**, not a lesser one. The harness could already read a local image, which is exactly why the split is argued on the tool surface and not on pictures. The one rule is the claim: a walkthrough never reports having seen a page it only has a path to."

## Flagged ambiguities

- "escalation hole" / "提权口" was used for *a command that costs an extra approval* — resolved: that is an **escalation count**, not a privilege leak; the allowlist is a **Guardrail** (ADR-0001).
- "destructive git" was used to mean *history rewriting* — resolved: **destructive** = irreversible **and** not confined to named paths, which is why `restore .` is refused but `restore -- <path>` is allowed.
- "the `Failing tests:` block is the failure list" — resolved: it is a **truncated digest** (≤4 entries, sorted by path, absent under `failures-only`); the **Failure inventory** is the `[E]` lines.
- `maxLines` (from the field feedback) and the existing `tail` are the same knob — resolved: one name, **Tail**.
- "the token lives only in memory" — resolved: the bridge never writes it to a file, but auto-open puts it in the browser's address bar and history; say "never written to a file", not "memory only".
- "arbitrary command execution is absent" (README) — resolved: it is absent as *an accepted executable name*, not as a capability; `dart` runs any Dart source in the workspace (ADR-0001).
- "sub-tool" / "子 tool" — resolved: a named operation executed as a **Job** with a structured **`result`** (ADR-0003), not a second execution path and not a DSH plugin; the first member is `arb-edit`, which retired the standalone `flutter-arb-edit` skill.
- "validation" for an ARB instruction — resolved: two different things with two different answers. Schema checks are a **400** at submit time; anchor/range problems happen in the **Plan phase** and fail the job with zero files written.
- "scope: uncommitted for analyze" — resolved: it is a **Filter**, not an **Expansion**. `dart analyze` accepts at most one directory, so the run still covers the whole project and only the returned lines are narrowed; a pre-existing issue in an untouched file still fails the exit code.
- "changed files" was used for the **Uncommitted scope** — resolved: they are different sets. CI compares two commits (untracked files cannot exist there); the scope reads the working tree, untracked files included.
- "the summary says which failures are new" — resolved: it never does. The suffix counts known/new; **which** is `baseline.newFailures`, and a **Known-failure registry** that cannot be read claims nothing rather than counting everything as known.
- "long-running job" / "background job" — resolved: a **Long job** on the **Long lane**. Nothing is detached from the bridge: it is still a **Job** with a log and a kill, and it is still serialized — just not against builds.
- "`pnpm exec` is safe because pnpm only runs installed packages" — measured false: `pnpm exec node --version` and `pnpm exec cmd /c echo hi` both work, because pnpm falls back to `PATH`. That is why the **`pnpm` surface** narrows `exec` to a **Script binary** and refuses `-c/--shell-mode`.
- "the sandbox denies `vite` because of a file" — resolved: the sandbox denies **pipes**. `spawn`/`exec`/`fork` with piped stdio throw `EPERM` (no named pipes), while `inherit`, a file fd, `worker_threads` and loopback TCP all work; that single mechanism explains Vite's `net use` probe, vitest's default forks pool and esbuild's service spawn (ADR-0004).
- "killing a job is just `taskkill`" — resolved: it is not, under this sandbox. `taskkill /F /T` answers "access denied" while the target is alive, so the fallback to the owned process handle is part of the **Long job** feature rather than a detail: without it a killed dev server kept running *and* held its lane.
- "让模型操纵浏览器进行测试" / "let the model test the UI" — resolved: two different capabilities. A **UI walkthrough** is exploratory live driving, and that is the one that was missing; a script-driven E2E run is a **Job** that already works through `/run` (`pnpm run <e2e script>`, `flutter test integration_test -d windows`). Only the first needed building (ADR-0005).
- "the browser runs in the bridge" — resolved: false by construction. The browser is a normal user process spawned by the harness, holding none of the Bridge's boot **Escalation**; the **Allowlist** — a **Guardrail**, not a boundary — does not reach it, and nothing in the bridge surface can retarget it.
- "an always-on MCP server" — resolved: what is permanent is the **Resident row** and therefore the *tool schemas*, not a browser. No server process is spawned until a **Browser tool** is called, and the accepted cost is tool definitions on every request of every session of that profile (ADR-0005).
- "the walkthrough proves the UI works" — resolved: it does not, by itself. A **UI walkthrough** is exploratory and produces artifacts and findings; only a script-driven E2E run produces a **Digest** with **Counts** and a **Failure inventory** that CI can repeat.

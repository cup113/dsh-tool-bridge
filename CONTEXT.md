# tool-bridge

A DSH plugin whose model-facing tools run the Flutter/Dart toolchain, a Node
toolchain, a small git verb set and the ARB edit in-process for the conversation
that called them — `bridge_run` and `bridge_arb_edit`, switched on or off per
conversation from a row of switches above the input card, with a sidebar panel
showing what the toolchain is doing. It is loaded into a profile, so it holds exactly what the
harness process holds and has no port, token or status page of its own. This
file fixes the vocabulary; `docs/adr/` records the decisions that are expensive to
reverse.

## Language

### The plugin and its halves

**Tool bridge**:
The plugin itself — the two model-facing tools, the switch pair that turns each
half on for one conversation, and the sidebar panel — loaded into a profile like
any other plugin; it is not a process, and there is no port, token or status page
anywhere in it.
_Avoid_: bridge server, toolhub daemon, proxy, gateway

**Engine**:
The in-process part that owns the lanes, the job ledger and the job logs; it is
what "the bridge" used to name, and it is reached from the **Toolchain half**'s
tools and from the sidebar panel's route.
_Avoid_: core, backend, runtime

**Toolchain half**:
The half of the plugin that runs commands: `bridge_run` and `bridge_arb_edit`,
the two model-facing tools.
_Avoid_: bridge half, cmd half, tool list

**Browser half**:
The half of the plugin that gives a conversation eyes and hands: a Playwright MCP
connection, mounted per conversation over stdio.
_Avoid_: browser plugin, playwright half, UI half

**Switch**:
The per-conversation on/off control for one half, rendered as a labelled control
on a full-width row directly above the composer card — the dock seat the harness
itself uses for "entries above the input"; its state is durable per session, so a
resumed conversation keeps it, and turning one off removes the toolchain's
schemas from that conversation's prompts or closes the browser connection.
A Switch states **intent**, which is not the same as the fact it asks for: the
browser half can be switched on with no connection behind it, so the row also
reports the fact when the two disagree — starting, or failed with a reason.
_Avoid_: setting, preference, flag, toggle-feature, header control

**Scoped mount**:
Loading the MCP client into a scope minted for one agent, so its tools and its
server process belong to that conversation alone and unwind with it; this
replaced the **Resident row**.
_Avoid_: resident row, global MCP, shared browser

**Working directory**:
The directory a job runs in: the calling session's `cwd`, fixed at submit time,
which no request can retarget.
_Avoid_: workspace root, session root

**Lane**:
Which of the two serialized worker lines a **Job** runs on — the **Queue** or the
**Long lane** — for the **Working directory** it was submitted in; serialization
is per lane, and `aheadOf` counts only the caller's own lane.
_Avoid_: channel, pool, thread (a lane is a serialization domain, not a resource)

**Job ledger**:
The engine's own record of what it has run — argv, resolved argv, lane, place in
line, status, digest, log path; the sidebar reads it and the model reads the tool
result.
_Avoid_: job table, history, roster (that is the harness's `ctx.jobs`)

**Lane depth**:
How many unfinished jobs one lane of one directory holds, the running one
included; it is what `aheadOf` reports for one job and what the panel shows for
both lanes.
_Avoid_: queue length, backlog, pending count

**Format pin**:
The dart executable matching the version a project's CI formats with, which
`dart format` **Jobs** run instead of the PATH one — formatting with a newer local
dart is what turns CI's `--set-exit-if-changed` check red; it is **plugin
configuration**, not a request field.
_Avoid_: per-request exe, SDK override, toolchain pin (too broad: `dart analyze`/`test`/`pub` deliberately keep the PATH toolchain)

### The command surface and its cost

**Allowlist**:
The set of executables (`flutter`, `dart`, `git`, the **Package managers**, `npx`,
and the **Script binaries**) and the git/package-manager verbs the **Toolchain
half** accepts.
_Avoid_: sandbox, security boundary, whitelist, permission system

**Guardrail**:
What the allowlist actually is: a bound on *recovery cost and surprise* for a
fallible caller, not on privilege — `dart run <file>.dart` already executes
arbitrary code with the harness process's own access.
_Avoid_: protection, isolation, containment

**Package manager**:
`pnpm` or `npm` — the tool a project's own lockfile and docs name; the **Toolchain
half** knows the *name* and never detects or enforces which one a project uses, so
a fork carrying either lockfile is driven by naming the manager its upstream uses.
_Avoid_: node package manager, PM, npm (that names one member, not the concept)

**Package-manager surface**:
The named verbs a **Package manager** accepts (`install`, `add`, `run`, `exec`,
`why`, …), with the cwd-retargeting flags refused and `exec` narrowed to a
**Script binary** — because `exec` also runs anything on `PATH`. The verb set is
per manager, because the tools differ in fact: npm has `ci`, pnpm does not, and
npm's `ls` lists packages where pnpm's lists scripts.
_Avoid_: package manager access, npm passthrough (the two are peers, not one surface)

**Exec form**:
The shape that runs a **Script binary** through a **Package manager**: `pnpm
exec`, `npm exec`, or `npx`. `npx` is one of these and not a manager of its own —
it *is* `npm exec` with the package named implicitly — so it has no verbs and
inherits the same narrowing.
_Avoid_: npx runner, exec command, package runner

**Run shorthand**:
npm's own abbreviation of a script: `npm test` and `npm start`, normalised to
`npm run test`/`npm run start` during validation, so the **Long lane** guess, the
job JSON and the **Digest** all read one argv. Only those two names, because they
are the only two npm abbreviates.
_Avoid_: alias, script shortcut, implicit run (it is not a verb of its own)

**Script binary**:
One of the project's own Node tools (`vite`, `vitest`, `svelte-check`, `svelte-kit`,
`tsc`) that the **Toolchain half** accepts by name and resolves inside the **Working
directory**'s `node_modules` by reading the package's `bin` field — never through
the `.cmd` wrapper, which would put `cmd.exe` in the middle of an argv that is
supposed to have no shell.
_Avoid_: local binary, npx tool, node_modules/.bin (that is the wrapper, which is exactly what is bypassed)

**Uncommitted scope**:
The `scope: "uncommitted"` value: the **Working directory**'s uncommitted `.dart`
files (staged, unstaged and untracked; deleted and ignored excluded), read once at
submit time. `dart format` receives them as trailing paths — the **Expansion**;
`analyze` and `fix` accept at most one directory, so there the same set narrows
the returned log lines — the **Filter**.
_Avoid_: changed files (that is CI's commit range, not the working tree), diff scope, git scope

**Expansion**:
How the **Uncommitted scope** reaches `dart format`: the files are appended to the
**Job**'s argv, so the formatter itself is narrowed — the local shape of CI's
changed-files format check.
_Avoid_: injection, argv rewriting

**Filter**:
How the **Uncommitted scope** reaches `analyze` and `fix`: `analyze` takes at most
one directory and `fix` takes no path at all, so no argv can name a file set and
the scope narrows the *returned* log lines instead; the exit code still describes
the whole project.
_Avoid_: narrowing, subset run (it is not a run over a subset)

### Work

**Job**:
A `ctx.jobs` job owned by the calling session, kind `bridge`; the harness's own
job runtime owns its identity, its output ring, its kill and its completion
notice, and `job_output`/`job_kill` are how the model reads and stops it.
_Avoid_: task, run, invocation, process

**Job status**:
`queued` → `running` → `done` | `failed` | `killed`.
_Avoid_: pending, success, error, cancelled

**Queue**:
A single-worker line **Queue-lane** **Jobs** wait in, one per **Working
directory**; at most one toolchain job runs at a time there because concurrent
Flutter runs corrupt `build/` and two Vite builds share `dist/`.
_Avoid_: pool, concurrency, workers

**Long job**:
A **Job** expected to run until it is killed — `vite dev`/`preview`, `vitest`'s
watch mode, a conventional `dev`/`start`/`serve`/`watch` script. It runs on the
**Long lane**, because on the **Queue** it would starve every build behind it until
somebody killed it.
_Avoid_: background job (nothing here is detached), daemon, server job

**Long lane**:
The second worker line, serialized among **Long jobs** only. The guess
(`wantsLongLane`) covers the shapes that are certainly long; the `long` field on
`bridge_run` overrides it either way, because the two error directions are not
symmetric.
_Avoid_: dev lane, watch lane, second queue

**Tree sweep**:
`taskkill /T /F` on a **Job**'s root, ending the descendants a single-process kill
would leave behind — `flutter test`'s `flutter_tester.exe` children, a forked
vitest worker, esbuild's service. It runs *before* the **Owned kill**, because it
walks the parent-child chain and resolves that pid only when the helper runs; a
root ended first leaves it nothing to walk. It is available because the plugin
runs in the host process, outside the file sandbox, which is the same property
that lets a **Job** write into `build/` (ADR-0008).
_Avoid_: tree kill (that is the umbrella; the sweep is the helper), `taskkill`
(the executable, not the step), process group (that is the POSIX idea the sweep
deliberately does not implement)

**Owned kill**:
`child.kill()` on the process a run itself started — the fallback that ends the
direct child when the **Tree sweep** is refused, missing or slow, and the only
kill there is for a pid-less child. ADR-0004's finding, still standing: a kill
that is merely a fresh process asking for access can be refused while the target
is alive.
_Avoid_: hard kill, fallback kill

**Plan phase**:
The stage that computes every target file's new content before any file is
written, so a semantic error (a missing anchor) leaves the whole set untouched.
_Avoid_: validation (that is the schema check at submit time), preview

**`result`**:
The structured outcome of a `bridge_arb_edit` job: which files were edited, which
keys were inserted or deleted, the gen-l10n exit code, and any untranslated
messages.
_Avoid_: output, report, digest (a Digest belongs to a test run)

**Digest**:
The parsed view of a finished test job: `flavor`, `summary`, `counts`,
`failures`. Absent for non-test jobs.
_Avoid_: result, report, analysis

**Flavor**:
Which test runner a **Digest** came from — `flutter` (`flutter test`/`dart test`)
or `vitest`; it is set by the log parser that recognised its runner, so it
survives an argv that cannot say (`pnpm run test`), and it is what tells two
digests apart by the runner that wrote them.
_Avoid_: runner, kind, framework (a job is a `cmd` or an `arb-edit`; this is about the log)

**Counts**:
`passed`/`skipped`/`failed` read from the last `+N ~S -K:` progress line; the
authoritative total.
_Avoid_: totals, stats, "the numbers in the summary"

**Failure inventory**:
The per-test failure list taken from `[E]` progress lines, in run order, with a
suite path filled in from the block when one is available.
_Avoid_: failure list (ambiguous — see the block), errors

**`Failing tests:` block**:
The reporter's own end-of-run summary: at most four entries, sorted by path, then
`... and N more`. A truncated digest, *not* the inventory.
_Avoid_: failure inventory, failure list, "the fixed format"

**Tail**:
How many log lines a tool result returns — `bridge_run` defaults to 200, capped at
5000, `0` for none.
_Avoid_: maxLines, limit, count, head

**Log filter** (`grep`):
An optional regex that selects which log lines are eligible; `tail` then caps the
number returned. The result's `log` object reports `matched`, `returned`,
`scannedLines` and `truncated` so "no matches" never reads as "no output".
_Avoid_: search, filter, pattern match

### Git surface

**Pathspec guard**:
The rule that `restore` accepts only literal, relative, non-wildcard paths — no
`.`, `..`, `:` magic, glob, absolute path, or `--pathspec-from-file`.
_Avoid_: path validation, path check

**Destructive (git)**:
Irreversible **and** not confined to paths the caller just named. `reset --hard` is
destructive; `restore .` is destructive; `restore -- lib/a.dart` is not.
_Avoid_: history-rewriting (too narrow — `restore .` rewrites no history and is still destructive)

**Inline message**:
A commit message passed as the `message` field, which the **Toolchain half** folds
into argv as `-m <text>`. No file is ever created for it.
_Avoid_: commit body, message file, `-F` file

### UI walkthrough

**UI walkthrough**:
The model exercising a live UI with the browser tools — navigate, snapshot, click,
type, screenshot, watch — while the **Toolchain half** runs the **App under test**,
and reporting what it saw as artifacts. It is the exploratory half of UI testing;
the repeatable half is a script-driven E2E run, which is an ordinary **Job**.
_Avoid_: E2E test (that is the script-driven run), browser automation, UI test

**App under test**:
The running application a **UI walkthrough** drives — normally a **Long job**
(`vite dev`, `vite preview`) in the **Working directory**. Its lifecycle is the
conversation's: it is started through `bridge_run`, so it does not outlive the job,
and it is killed with `job_kill`.
_Avoid_: target app, SUT, dev server (that names the command, not the role)

**Driving**:
The other half of a **UI walkthrough**: navigate, snapshot, click, type,
screenshot, record. It belongs to the **Browser half** — a **Scoped mount** — so it
is not a **Job**, not a **Lane**, and has no log, no **Digest** and no panel row.
_Avoid_: browser job, browser session (the toolchain half holds neither)

**Browser tool**:
One of the model-facing tools the mounted browser server publishes
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

**Artifact copy-back**:
Moving a browser artifact — video, trace, PDF — from the mount's configured output
directory into the session workspace, so it can be handed to the human (`present`).
The output directory is outside every workspace on purpose.
_Avoid_: download, export, attachment

### Investigation

**Baseline attribution**:
Deciding whether a failing test was already failing before the caller's change —
the question "is this failure mine?".
_Avoid_: regression bisect, blame

**Known-failure registry**:
The optional `<cwd>/.toolbridge/known-failures.json` that answers **Baseline
attribution** from data instead of memory: an entry claims a failure by test name
or regex, optionally narrowed by suite (`file`) and `platform`, and carries a
`kind` and a `reason`.
_Avoid_: ignore list, suppression (an entry explains a failure, it never hides one), baseline file

**Baseline report**:
The digest field carrying the split — `source`, the `known`/`new` counts over
**distinct tests**, `failed` (the authoritative **Counts** number they must
reconcile with), `tests`/`events` (distinct tests vs `[E]` lines), `unparsed`, and
`newFailures`, the complete ordered list of the failures the registry did **not**
claim. It rides with the log view, so the model reads it through the tool result.
_Avoid_: report (that is `bridge_arb_edit`'s `result`), diff, regression list

**Backup-and-restore**:
The sanctioned baseline-attribution recipe: copy the dirty files to a scratch
directory inside the workspace, `git restore -- <paths>`, run the job, copy the
files back.
_Avoid_: stash (a different, deliberately absent mechanism), revert

### No longer terms

**Escalation** and **Escalation count** are gone: there is no boot approval to
spend, because there is no per-call confinement. Nothing confines a `bridge_run`
job — the plugin runs inside the harness process — so the count had nothing left
to measure; the trust decision is now installing the plugin, and the **Guardrail**
is what survives from the concept.

**Token**, **Status page** and **Boot self-check** were properties of the server
process: the model's own `bridge_run` result carries the job and the log, the
sidebar panel shows the lane depth and the running job, and a command the
**Allowlist** refuses is answered at submit time rather than discovered at boot.

**Watchdog** / `--watch-parent` is gone: the harness's jobs registry installs the
Workspace archive admission, so archiving a conversation stops its **Jobs** — a
lifetime the plugin does not have to watch.

**Sub-tool** is gone as a category: after the refactor `arb-edit` is simply a
second tool, `bridge_arb_edit`. The reason it exists as a **Job** — an atomic
operation whose steps include a toolchain call, which no argv can express — is
kept under that term.

**Resident row** is gone: replaced by the **Scoped mount**.

## Relationships

- One **Tool bridge** is one plugin: the **Toolchain half** is two tools registered once for the process, the **Browser half** exists only as one **Scoped mount** per switched-on conversation, and both are per-conversation choices.
- A tool call is a **Job** owned by the calling session: `bridge_run` and `bridge_arb_edit` both submit through the same **Engine**, which starts a `ctx.jobs` job of kind `bridge`.
- A lane pair is keyed by **Working directory**, not by session: two conversations on one directory share one **Queue** and one **Long lane**, which is what stops two Flutter builds from sharing a `build/` directory.
- An **Engine** serves whatever **Tool bridge** is loaded and keeps one **Job ledger** and one log directory for it.
- A **Switch** decides what a conversation sees: the toolchain switch removes or restores the two tools' schemas on that conversation's own scope, and the browser switch mints or disposes the **Scoped mount** whose tools and process are that conversation's.
- A **Scoped mount** belongs to one conversation: its scope is minted for one agent, so its tools and its MCP server process exist only while that switch is on and unwind with the conversation.
- **Archiving a conversation stops its jobs**: a **Job** is owned by the calling session, and the jobs registry's Workspace archive admission ends every job an archived conversation owns.
- A **Digest** holds one **Counts** and one **Failure inventory**; the **`Failing tests:` block** may supply a path to the inventory but never its order or completeness.
- The **Allowlist** is a **Guardrail**, not a privilege boundary: it bounds what a fallible caller can lose work to, and `dart` already reaches arbitrary code in the harness process.
- A **Format pin** is configuration, not a request field: `dart format` **Jobs** route to the pinned exe, every other `dart`/`flutter` job keeps the PATH SDK, and no argument can retarget either.
- The **Working directory** is fixed at submit time from the calling session's `cwd`; a **Job** carries it, so nothing about a job's **Lane** can move it.
- An **Uncommitted scope** is computed once, at submit time; an empty one is refused, because `dart format` with no paths rewrites the whole tree.
- A **Job** has one **Job status**, one log, one **Lane**, and — for a test run — one **Digest**.
- A **Long job** runs on the **Long lane**, so it is never counted by `aheadOf` for a **Queue** job; a **Queue** job is never blocked by it.
- `bridge_arb_edit` is a **Job**: it queues, logs and is killed like any other, its `argv` is a display line, and its **`result`** is what a **Digest** cannot express.
- `bridge_arb_edit` runs in the **Working directory**; its body carries no `cwd`, and a missing anchor fails the **Plan phase** with zero files touched.
- A **Script binary** is resolved in the **Working directory** and runs under `node`; an **Exec form** accepts one of those names and nothing else.
- A **Package manager** is chosen by the caller; a **Run shorthand** is normalised to `run <script>` before the **Long lane** guess, the job JSON and the **Digest** read the argv, so a shorthand is never a second surface.
- The two **Package managers** share one retargeting guard but not one verb set; a lockfile is advisory, so naming the manager is the caller's call and the other manager's lockfile may be written by mistake.
- A **Known-failure registry** is read per **Job** from the **Working directory**; with no registry there is no **Baseline report** at all.
- A **Baseline report** names the new failures; the `summary` suffix only counts them, so "which ones" is never read off the one-liner.
- A **Flavor** comes from the log parser that recognised its runner, and it is what tells a vitest **Digest** from a Flutter one when the argv cannot say.
- A **Tail** and an optional **Log filter** shape a tool result, not a job: the raw log is never rewritten.
- **Lane depth** is what `aheadOf` reports for one **Job** and what the panel reads for both lanes of one directory.
- A **UI walkthrough** drives an **App under test**: running it is the **Toolchain half**'s (a **Long job** in the **Working directory**), driving it is the **Browser half**'s, and the split is ADR-0005.
- A **Browser tool** creates no **Job** and appears in no **Lane**: it belongs to the **Scoped mount**, which is optional and whose tools are absent from every conversation that did not switch it on.
- A **UI walkthrough** produces artifacts, not a **Digest**; its finding becomes repeatable by being written as a script-driven test run through `bridge_run`.
- A screenshot reaches the model through either half of **Sight**; the second half is not a degraded path but an ordinary one, and only the claim to have seen a page may not rest on a path.

## Example dialogue

> **Dev:** "Since the plugin runs in the harness, it escapes the sandbox — so the file sandbox does not apply to my `bridge_run` calls any more?"
> **Maintainer:** "It does not apply to them, and nothing escapes. DSH's file sandbox is applied per call, and a `bridge_run` job is not a confined call to break out of: the plugin already holds whatever the harness process holds, so the command simply runs. What the **Allowlist** buys is not access — it is **recovery cost and surprise**, and it stays a **Guardrail** (ADR-0001)."
> **Dev:** "Then `dart run` is still reachable, and `git restore .` is still refused? That seems inconsistent."
> **Maintainer:** "It is consistent once the rule is *unnamed* rather than *privileged*. `restore .` destroys every uncommitted file in one call and names none of them; `restore -- lib/a.dart` names what it destroys. A refusal is only ever argued as 'nobody can lose work to this'."
> **Dev:** "I turned the toolchain off to save tokens, but I can still see `bridge_run` in the tool list. So a **switch** is a UI preference?"
> **Maintainer:** "It is not a preference, and it is not cosmetic. The toolchain switch hides those schemas from that conversation's prompt; the browser switch is bigger than hiding — it mints the scope, starts the MCP server, and closes both when you turn it off. Neither is stored as a view hint: both are written durably per session, which is why a resumed conversation comes back the way you left it."
> **Dev:** "Two of my conversations are on the same project. Why is a build in this one waiting on a build in the other? They are separate sessions."
> **Maintainer:** "Because a **Lane** is keyed by **Working directory**, not by session. The retired server had one process and one queue per session, so two sessions could run two Flutter builds over the same `build/` — a corruption the single-process plugin removes by construction. The cost is exactly what you just saw: a long build in one conversation delays the other conversation's build on that directory."
> **Dev:** "And where did the **escalation** go? I am not approving anything at boot now."
> **Maintainer:** "There is nothing per-call left to approve: the plugin runs inside the harness process, so no command of yours is ever outside the sandbox to climb back into. The trust decision moved — it is installing the plugin into the profile, once, and choosing which conversations carry each half. Is that a security regression? No, it is the same decision at a coarser grain, and the **Guardrail** is unchanged."
> **Dev:** "Where should I approve it, then — is there a status page that asks?"
> **Maintainer:** "There is no **Status page** and no **Token** any more. The model reads its own `bridge_run` result, and the sidebar panel shows the lane depth, the running job and its log — for the conversation you are looking at, without a tab that goes stale or a token in an address bar."
> **Dev:** "And if I close the tab on a dev server I started — `vite dev` is still running, isn't it?"
> **Maintainer:** "It is a **Job** like the rest, on the **Long lane**, and it ends with its owner: **archiving a conversation stops its jobs**, and `job_kill <id>` stops it right now. The panel shows the **Lane depth** of its directory and then that job's log — a job row, not a browser session."
> **Dev:** "Then the browser is still resident — a **Resident row** in the profile?"
> **Maintainer:** "No. That row is gone; what replaced it is a **Scoped mount**. Nothing loads and no schema is paid until a conversation switches the **browser half** on, and when it does the MCP client is loaded into a scope minted for that one agent — its tools, its server process, and its disposal all belong to that conversation."
> **Dev:** "My `bridge_run` call timed out at 600 seconds. So the job died?"
> **Maintainer:** "It did not. A timed-out call returns the **Job** as it stands — `queued` or `running`, with its **Lane depth** — and nothing is killed. Read it on with `job_output <id>`; `background: true` submits without waiting at all, and a completion notice wakes you when it settles."
> **Dev:** "Then `wait: false` is the field I want?"
> **Maintainer:** "That field is gone with the server. `bridge_run` waits unless you pass `background: true`, and `timeoutSec` bounds that wait — never the job."
> **Dev:** "I want `dart format` to use CI's dart. Is there a request field for that?"
> **Maintainer:** "There is no request field, and that is the point: the **Format pin** is **plugin configuration** now, so one profile setting gives every conversation the same formatter. Only `dart format` routes to it; `dart analyze` keeps the PATH SDK, because its verdict also depends on the Flutter framework version resolved through the package config, which a formatter pin cannot align."
> **Dev:** "And `scope: uncommitted` on `dart analyze` analyzes only my files?"
> **Maintainer:** "It cannot — the analyzer takes a directory, not a file list. That request is a **Filter**: your files' lines come back, but the exit code still describes the whole project. Only `dart format` takes an **Expansion**."
> **Dev:** "The ARB edit is still a **sub-tool**, so it is a different path than `bridge_run`?"
> **Maintainer:** "`arb-edit` is simply the second tool — `bridge_arb_edit`. It is a **Job** on the same **Queue**: it queues behind a running build, it is killed by the same id, and its **`result`** is what a **Digest** cannot express."
> **Dev:** "And `pnpm run test` — does that get the known-failure split?"
> **Maintainer:** "Yes, and that is why a **Digest** has a **Flavor** read from the log: the argv `pnpm run test` says nothing about vitest, but the reporter's own markers do."
> **Dev:** "The walkthrough found a button no user can reach. So the browser becomes a **Job** on the **Queue**, and I drive it from there?"
> **Maintainer:** "No — a browser is not a **Job**. It has no log, no **Digest** and no **Lane**, and the **Toolchain half** never holds UI state (ADR-0005). It runs the **App under test**; the **Scoped mount** does the **Driving**, as **Browser tools**, and your finding becomes repeatable by being written as a script-driven run through `bridge_run`."
> **Dev:** "And when the screenshot does not come back as an image?"
> **Maintainer:** "Then read the file yourself — that is the other half of **Sight**, not a lesser one. The harness could already read a local image, which is exactly why the split is argued on the tool surface and not on pictures. The one rule is the claim: a walkthrough never reports having seen a page it only has a path to."

## Flagged ambiguities

- "the **bridge**" / "**Bridge**" was used for *the running server process* — resolved: that sense died with the server. The name is now the **Tool bridge**, the plugin; what used to be called "the bridge" doing work is the **Engine** inside it.
- "the bridge runs X" — resolved: name the half. Command work belongs to the **Toolchain half** (`bridge_run`, `bridge_arb_edit`); page work belongs to the **Browser half** (the **Scoped mount**).
- "tool" / "which tool" — resolved: a *model-facing tool* is `bridge_run` or `bridge_arb_edit` (or one of the mounted `mcp__ui__browser_*` names); an *accepted executable* is an entry in the **Allowlist**. Only the first is a **Switch** subject.
- "toggle" / "switches" (as the code spells them) and the header control — resolved: one name, **Switch**; the store behind it is where its durability lives, not a second concept. The control moved out of the conversation header's action strip, where it competed for width on a phone, onto its own row above the composer card.
- "the switch is on, so the browser is there" — resolved: no. A **Switch** carries intent; the connection is a fact. The row says so when they disagree (`browser starting…`, or `browser failed: <reason>` in red), because a switch showing on over an absent browser is worse than no switch at all.
- "the engine's queue" / "the bridge's queue" — resolved: there are as many lane pairs as there are working directories, and the **Job ledger** is the engine's own, while the *roster* the model reads is `ctx.jobs`'.
- "a resume loses my switches" — resolved: it does not. The switch state is durable per session under the plugin's state directory; a conversation that is not in that document falls back to the configured defaults, which is what lets a default change apply to conversations nobody switched.
- "the tool bridge server" / "**Tool bridge** as the process I start" — resolved: there is no server, no port and no token. The plugin is loaded into a profile; the panel is a same-origin route plus a sidebar tab.
- "escalation hole" / "提权口" was used for *a command that costs an extra approval* — resolved: there is no per-call approval at all now, so no such hole exists; the refusals of the **Allowlist** are a **Guardrail** (ADR-0001).
- "where did the escalation go?" — resolved: to install time. The trust decision is installing the plugin and switching a half on for a conversation, not approving one command; switching the toolchain half off removes the tools' schemas, not their access.
- "the **switch** is just a UI setting" — resolved: it is not. The toolchain switch adds or lifts a restriction on that conversation's tool scope, and the browser switch loads and disposes an MCP client with its own process.
- "the **Resident row** is still there, just renamed" — resolved: no. A row was composed at boot for every session of a profile; a **Scoped mount** is minted per conversation when its **Switch** is on, and nothing — no schema, no server — exists for a conversation that did not ask.
- "the browser is resident again, because the mount is loaded once" — resolved: it is loaded once *per conversation that switched it on*, and unwinds with that conversation; no other conversation sees its tools or pays for them.
- "the **Working directory** is still boot-scoped" — resolved: it is submit-scoped. It is the calling session's `cwd` fixed at submit time, so a job runs in the directory its session was in; the invariant that no request can retarget it survives (ADR-0002), the boot-scoped-ness does not.
- "`wait: false` sends a job to the background" — resolved: no such field. A job is either awaited inside the call or submitted with `background: true`; the harness's `job_output`, `job_kill` and
completion notices are the same either way.
- "a timed-out `bridge_run` killed my job" — resolved: it did not. Expiry returns the **Job** as it stands (`queued`/`running`, with `aheadOf`) and nothing is killed; read it on with `job_output`.
- "a browser tool is a **Job** because the plugin hosts it" — resolved: it is not. It creates no **Job**, appears in no **Lane**, has no log and no **Digest**; it belongs to the **Scoped mount**.
- "destructive git" was used to mean *history rewriting* — resolved: **destructive** = irreversible **and** not confined to named paths, which is why `restore .` is refused but `restore -- <path>` is allowed.
- "the `Failing tests:` block is the failure list" — resolved: it is a **truncated digest** (≤4 entries, sorted by path, absent under `failures-only`); the **Failure inventory** is the `[E]` lines.
- `maxLines` (from the field feedback) and the existing `tail` are the same knob — resolved: one name, **Tail**.
- "arbitrary command execution is absent" (README) — resolved: it is absent as *an accepted executable name*, not as a capability; `dart` runs any Dart source in the workspace (ADR-0001).
- "sub-tool" / "子 tool" — resolved: **retired as a category**; `arb-edit` is the second tool, `bridge_arb_edit`, and the naming survives only as legacy text. It is a **Job** with a structured **`result`** (ADR-0003), not a second execution path and not a DSH plugin.
- "validation" for an ARB instruction — resolved: two different things with two different answers. Schema checks are a refusal at submit time; anchor/range problems happen in the **Plan phase** and fail the job with zero files written.
- "`scope: uncommitted` for analyze" — resolved: it is a **Filter**, not an **Expansion**. `dart analyze` accepts at most one directory, so the run still covers the whole project and only the returned lines are narrowed; a pre-existing issue in an untouched file still fails the exit code.
- "changed files" was used for the **Uncommitted scope** — resolved: they are different sets. CI compares two commits (untracked files cannot exist there); the scope reads the working tree, untracked files included.
- "the summary says which failures are new" — resolved: it never does. The suffix counts known/new; **which** is `baseline.newFailures`, and a **Known-failure registry** that cannot be read claims nothing rather than counting everything as known.
- "long-running job" / "background job" — resolved: a **Long job** on the **Long lane**. Nothing is detached: it is still a **Job** with a log and a kill, and it is still serialized — just not against builds.
- "`pnpm exec` is safe because pnpm only runs installed packages" — measured false: `pnpm exec node --version` and `pnpm exec cmd /c echo hi` both work, because pnpm falls back to `PATH`. That is why the **Package-manager surface** narrows `exec` to a **Script binary** and refuses `-c/--shell-mode`.
- "no npm, no npx" (README and SKILL.md) — resolved: both are accepted now, as a **Package manager** and an **Exec form** (ADR-0006). The old exclusion was drawn around our own usage rather than a measured difference: npm dies inside the sandbox for the same named-pipe reason pnpm does.
- "the tool knows which package manager the project uses" — resolved: it does not. The lockfile is advisory and the caller names the **Package manager**; nothing detects or enforces it, so `npm install` in a pnpm repository is allowed and writes a lockfile the project did not ask for.
- "`npm exec` and `npx` are different things" — resolved: `npx` *is* `npm exec` with the package named implicitly, so both are **Exec forms** with the same narrowing; the difference is only that `npx` names the tool as its first argument.
- "npm/npx were deliberate non-goals" — resolved: that stood only while no project needed them. Both are accepted now; what stays a non-goal is the *unnarrowed* form — `npx <anything>`, `npm link`/`publish`/`config`, and any cwd-retargeting flag.
- "the sandbox denies `vite` because of a file" — resolved: the sandbox denies **pipes**. `spawn`/`exec`/`fork` with piped stdio throw `EPERM` (no named pipes), while `inherit`, a file fd, `worker_threads` and loopback TCP all work; that single mechanism explains Vite's `net use` probe, vitest's default forks pool and esbuild's service spawn (ADR-0004).
- "killing a job is just `taskkill`" — resolved: it is both, in a fixed order, and the order is the mechanism (ADR-0008). The **tree sweep** (`taskkill /T /F`, resolved to `%SystemRoot%\System32`) runs first, because it walks the parent-child chain from the root and resolves that pid only when the helper runs — a root ended first leaves the walk nothing to walk, measured as `taskkill exited 128: process not found` with every descendant missed. The **owned handle** then ends the process the run started, and is what makes the kill survive a sweep that is refused, missing or slow: this half is ADR-0004's finding, taken under the retired server's own sandbox, and it still stands. Without the sweep a killed `flutter test` left `flutter_tester.exe` children holding `build\native_assets\windows\sqlite3.dll` mapped for over an hour, and every later run in that project died deleting it.
- "让模型操纵浏览器进行测试" / "let the model test the UI" — resolved: two different capabilities. A **UI walkthrough** is exploratory live driving, and that is the one the plugin supplies through its browser half; a script-driven E2E run is a **Job** that already works through `bridge_run` (`pnpm run <e2e script>`, `flutter test integration_test -d windows`).
- "the browser runs in the toolchain half" — resolved: false by construction. The browser is an MCP server spawned over stdio by the **Scoped mount**, and the **Allowlist** — a **Guardrail**, not a boundary — does not reach it.
- "an always-on MCP server" — resolved: there is none. No server process and no schema exists until a conversation's **Switch** mounts one, and that mount is disposed with the switch or the conversation.
- "the walkthrough proves the UI works" — resolved: it does not, by itself. A **UI walkthrough** is exploratory and produces artifacts and findings; only a script-driven E2E run produces a **Digest** with **Counts** and a **Failure inventory** that CI can repeat.

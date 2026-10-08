# dsh-tool-bridge

[![CI](https://github.com/cup113/dsh-tool-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/cup113/dsh-tool-bridge)

A **DSH plugin** that gives a file-sandboxed session the toolchain its sandbox
denies — `flutter`/`dart`, the project's own Node tools, a guard-railed `git`,
`pnpm`/`npm` — as two native tools, one switch per conversation, and a sidebar
panel. The browser half of a UI walkthrough (`@playwright/mcp`) is mounted the
same way: per conversation, for the conversations that ask.

It is the successor of a Python HTTP server that did the same job beside the
harness. `docs/adr/0007-the-plugin-is-the-bridge.md` records why the plugin is
not just the nicer shape but the *correct* one, and what did not survive the
move.

## Why any of this is needed

Inside a `workspace-write` sandbox the Flutter/Dart toolchain cannot run at all
— it fails writing the SDK lockfile — every `git` write is denied because the
git directory lives outside the workspace, and a Node toolchain dies on
`spawn EPERM`: the sandbox cannot create the named pipes libuv uses for child
stdio, which is what takes down `vite` (its Windows `net use` probe), `vitest`'s
default forks pool and `esbuild`
(`docs/vite-vitest-sandbox-findings.md` records the measurements).

The sandbox is applied **per capability call**: `ctx.sandbox.confine()` wraps the
argv a consumer is about to spawn. The harness process itself is not confined,
and neither are its children — so this plugin, running in that process, starts
the toolchain directly, and nothing has to be approved per session because
nothing is confined per session. That is the whole mechanism, and it is also the
whole trust story: see **Installing it is the trust decision** below.

## What you get

**Two tools.** `bridge_run` runs one command and comes back with a job:
`status`, `exitCode`, `durationSec`, the log tail, and — for a test run — the
digest (`summary`, `counts`, the complete `failures` inventory) plus a
`baseline` split against the project's `.toolbridge/known-failures.json`, whose
`newFailures` names the failures your change introduced. `bridge_arb_edit` edits
Flutter ARB localization files and runs `flutter gen-l10n` as one atomic
operation, planning every file before writing any.

Background work needs no third tool: every run is a `ctx.jobs` job, so the
harness's own `job_output`, `job_list` and `job_kill` read and stop it, it
appears in the harness's job roster, and a finished background job wakes its
conversation with a completion notice.

**Two switches, per conversation.** *Toolchain* (default on) and *Browser*
(default off), as a row of labelled switches directly above the input box — the
harness's own seat for entries above the composer card, so on a phone they get a
row of their own instead of a fight with the conversation header. Turning a
switch off removes that half's tool schemas from the conversation's prompts — for
the browser half it also closes the MCP server, so a conversation that never looks
at a page pays nothing for the ability to. State is durable per session: a resumed
conversation keeps what it had. A switch shows *intent*, and the row says so when
the fact differs — `browser starting…`, or the reason in red when the mount
failed. The icon at the row's end opens the panel in the sidebar.

**A sidebar panel** showing the conversation's working directory, both lanes'
depth, the formatter pin, the browser's flags, every job with its digest
summary, and the selected job's log — the thing the old server opened a browser
tab for, without the token in the address bar and without a page that goes stale.
It answers for the conversation it is opened beside, whether it came from the
row's icon or from the sidebar's own guide.

## Install

```powershell
dsh plugin --profile <profile> add <absolute path to this checkout>
```

Then restart the harness once. The plugin declares its own bundle layer
(`dsh.bundle.patch`), so `plugin add` composes it; there is no profile patch row
to hand-edit.

**Install it by path (or from git), not with `link:`.** `@deepseek-ai/*` are
peer dependencies, and inside a profile they resolve to the harness's own single
copies through `~/.dsh/profiles/node_modules`. A `link:` install resolves them
from this checkout instead, which puts a *second physical copy* of packages like
`@deepseek-ai/dsh-tools` in the process — the failure that looks like every tool
call dying with `Cannot read properties of undefined (reading 'prepare')`, and
whose message never names the plugin. Verify after installing:

```powershell
Test-Path "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\@deepseek-ai\dsh-tools"   # must be False
```

### Configure it

Configuration lives in the plugin's config schema, so a machine-specific value is
a patch override in the profile — and a patch replaces the targeted row's whole
`config`, so restate every key you keep:

```yaml
- id: toolbridge
  config:
    dartFormatExe: C:/Tools/dart-3.12.2/bin/dart.exe
    defaults:
      bridge: true
      browser: false
    playwright:
      browser: msedge
      caps: vision,devtools
      outputDir: C:/Users/me/AppData/Local/dsh-pw-mcp
      toolCallTimeoutMs: 120000
```

| Field | Default | Meaning |
|---|---|---|
| `stateDir` | `$DSH_HOME/toolbridge` | Where the plugin keeps the per-session switch record and the job logs |
| `defaults.bridge` | `true` | Whether a new conversation starts with the toolchain tools |
| `defaults.browser` | `false` | Whether a new conversation starts with Playwright MCP mounted |
| `dartFormatExe` | — | The formatter pin: the `dart.exe` CI formats with (see below) |
| `playwright.browser` | `msedge` | The browser channel; `msedge` drives the Edge Windows already ships, so no download |
| `playwright.caps` | `vision,devtools` | Playwright MCP capabilities: `vision` adds the coordinate mouse tools a canvas needs, `devtools` the recorders. Measured: 44 tools with both, ~25 for core alone |
| `playwright.outputDir` | — | Where video, trace and PDF land — outside any workspace on purpose, for the human |
| `playwright.toolCallTimeoutMs` | `120000` | Per-call MCP timeout; a screenshot or a stopped video can exceed the 60 s default |
| `defaultTimeoutSec` | `600` | How long a foreground `bridge_run` waits inside the call before handing the job back still running |

## Using it

`bridge_run` is the front door. The accepted names are `flutter`, `dart`, `git`,
`pnpm`, `npm`, `npx`, and the project's own `vite`/`vitest`/`svelte-check`/
`svelte-kit`/`tsc`, resolved out of the job's working directory by reading the
package's `bin` field — never through a `.cmd` wrapper, which would put
`cmd.exe` in the middle of an argv that is supposed to have no shell.

**Refusals are deliberate, and they are the only bound left** (ADR-0001). `dart`
takes any subcommand, so `dart run <file>.dart` executes arbitrary code with this
plugin's access; what the narrow surface buys is *recovery cost and surprise* for
a fallible caller. Refused on that reasoning: `git push`, `reset --hard`,
rebase, `clean`, `stash`, `checkout`/`switch`, `git restore .` (a pathspec guard:
literal, relative, non-wildcard paths only), the cwd-retargeting flags on either
package manager, and an exec form (`pnpm exec`, `npm exec`, `npx`) whose target
is not one of the project's own script binaries — measured, they also run
anything on `PATH`, and `npx` fetches what it cannot find.

**Long jobs get their own lane.** A command that runs until killed — `vite dev`,
`vitest` in watch mode, a `dev`/`start`/`serve`/`watch`/`storybook` script, or
`long: true` — is serialized against other long jobs instead of against the
builds, because a dev server on the queue lane starves everything behind it. The
guess exists because the two error directions are not symmetric; the flag
overrides it either way.

**Lanes are keyed by working directory.** Concurrent Flutter runs corrupt
`build/` and two Vite builds share `dist/`, so all runs in one directory are
serialized — across conversations too. The cost is honest: a long build in one
conversation delays a build in another conversation on the same directory, which
is what already happened within one conversation.

**Formatting the way CI formats.** `dart format` output changes between SDK
releases, so formatting with a newer local dart is what turns CI's
`dart format --set-exit-if-changed` check red. Point `dartFormatExe` at the
standalone dart whose version matches the Flutter version the project's workflow
pins, and **only** `dart format` uses it — `dart analyze` deliberately keeps the
local SDK, because its verdict also depends on the Flutter framework version
resolved through the package config, which a formatter pin cannot align.

**Scoping to your uncommitted files.** `scope: "uncommitted"` reads the working
tree once, at submit time, and narrows the command to its uncommitted `.dart`
files. For `dart format` that is an **Expansion** — the files are appended to
argv, so the formatter itself is narrowed, which is CI's changed-files check run
locally. For `analyze`/`fix` no argv can name a file list (an analyzer takes at
most one directory), so the same set narrows the returned lines instead and the
exit code still covers the whole project: a **Filter**. Nothing uncommitted is a
refusal, not a whole-tree format.

**Timeouts never kill.** `timeoutSec` bounds how long the *call* waits for queue
time plus run time; when it expires the job is unchanged and still running. Read
it on with `job_output <id>`, stop it with `job_kill <id>`.

## The browser half, and looking at the UI

The split ADR-0005 drew is unchanged: **this plugin runs the app under test, the
browser drives it.** Starting the app needs the toolchain (a Vite dev server
dies inside the file sandbox), and driving is `@playwright/mcp` — reached as
`mcp__ui__browser_*` tools. What changed is that the MCP client is no longer a
resident profile row: turn the conversation's *Browser* switch on and the plugin
mounts it into a scope minted for that conversation; turn it off (or end the
conversation) and the connection and its server process go away.

The loop: `bridge_run {cmd: "vite", args: ["dev"], long: true, background: true}`
→ read the bound URL from the job's log → `mcp__ui__browser_navigate`,
`browser_snapshot` (the accessibility tree as text — cheap, and the source of the
element refs) → act by ref → `browser_console_messages` when the screen is blank
→ screenshot or video as the artifact. Sight arrives two ways, an image block in
the tool result or the same file read with the harness's image tool; neither is
privileged, and the one rule is the claim — never report having seen a page you
only have a path to. Make the finding repeatable by writing it as a script-driven
run through `bridge_run`.

## Installing it is the trust decision

**This plugin is not a sandbox and not a privilege boundary.** Its children run
with the harness's own access, unconfined, with no per-session approval — so the
decision that used to be a `danger-full-access` escalation is now the decision to
install it into a profile (ADR-0001, amended). That is a real trade: the refusal
list described above is the only bound on what a conversation can do, and it
bounds surprise and recovery cost rather than privilege.

What is unchanged: `git push` is absent (a GitHub token must never live in a
long-running process), history rewriting is absent, whole-worktree wipes are
absent, and the callers are your own agent sessions on your own machine.
Everything the plugin does per conversation is in the switch the human can see
and turn off.

## Requirements

- **Windows** — CI-verified, and the platform the resolution logic is written
  for. The retired server carried a POSIX fallback nobody had exercised; this
  port states the platform instead of carrying an untested claim.
- **Node 22+** for the plugin, and `node` on `PATH` for a script binary.
- `flutter`/`dart`, `git`, and whichever package manager your project names.
- A harness whose `@deepseek-ai/*` line matches the peers in `package.json`
  (currently `0.2.0-rc.2`). They are pinned on purpose: the plugin builds against
  the types of one harness line.

## Development

```powershell
pnpm install
pnpm typecheck      # host, client and test programs
pnpm build          # both halves: lib/index.js and lib/client.js
pnpm test           # vitest
```

The engine under `src/engine/` is pure logic ported from the retired server with
its test suite — the digest parsers, the known-failure split, the command
surface, the ARB editor, the resolvers. Its specs read the same fixtures the
Python suite did (`tests/fixtures/`), and the ports were checked against the
Python outcomes: `validate.ts` has a 135-case parity digest whose
Python-vs-TypeScript output hashes identical.

Two sandbox facts shape the loop, both measured:

- **Run the suite through the toolchain bridge, not directly,** in a confined
  session: `vitest` loads its config through esbuild's service, which spawns with
  piped stdio and dies with `spawn EPERM` under the sandbox. Outside a sandbox,
  or through the plugin's own `bridge_run`, it runs normally.
- **`--pool=threads`** keeps vitest portable between the two: its default forks
  pool uses an IPC pipe, and pipes are what the sandbox forbids.

## Where the rest lives

- `CONTEXT.md` — the vocabulary the code and the docs are written in: tool
  bridge, engine, the two halves, switch, scoped mount, job ledger, lane depth,
  working directory, guardrail, digest, format pin, uncommitted scope, sight —
  plus the terms this refactor retired and why.
- `docs/adr/` — the decisions: the allowlist is a guardrail (0001, amended for the
  trust decision); the working directory is fixed (0002); a sub-tool is a job
  (0003, amended); the Node surface and the long lane (0004); the browser belongs
  to Playwright MCP, now mounted per conversation (0005, amended); npm is a
  package manager on the same terms (0006); **the plugin is the bridge** (0007).
- `docs/vite-vitest-sandbox-findings.md` — the measurements behind the Node
  surface: which commands the sandbox kills, with what error, and why.
- `src/engine/` — the pure logic and the reason each refusal exists.
- `src/host/` — the plugin half: tools, lanes, the job ledger, the switches,
  the scoped browser mount, the sidebar's transport.
- `src/client/` — the browser half: the switch row above the composer and the sidebar panel.

## Deliberately absent

`git push`; git history rewriting (`reset --hard`, `rebase`); whole-worktree
wipes (`clean`, `git restore .`); `stash`; `checkout`/`switch`; a per-request
`cwd` (the working directory is the session's, ADR-0002) and per-request
worktrees; the unnarrowed package-manager forms (`pnpm dlx`,
`npm link`/`unlink`/`publish`/`config`/`store`) and an exec-form target that is
not a project script binary; guessing a project's package manager from its
lockfile (the lockfile is advisory, the caller names the manager); any raw `node`
or `python` executable name (the guardrail is a list of names, ADR-0001); a
per-request formatter override (the pin is configuration); UI driving inside the
plugin — the browser is Playwright MCP's, mounted per conversation (ADR-0005).

## Licence

MIT — see [`LICENSE`](LICENSE).

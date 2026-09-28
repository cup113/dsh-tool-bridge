# dsh-tool-bridge

A session-scoped, loopback-only toolchain server for DSH sandboxed sessions.
It is started once per session with a `danger-full-access` escalation and then
runs `flutter`/`dart` (any subcommand), a guard-railed `git` verb set and its
sub-tools on the agent's behalf over HTTP, so the confined agent does not pay an
approval per command. It also serializes jobs (concurrent Flutter runs fight
over `build/`), captures UTF-8 logs, filters them server-side, digests
`flutter test` results, and can kill a hung job's whole process tree.

Two knobs keep a local run comparable with CI's: `--dart-format` routes `dart
format` jobs to the dart a project's CI formats with (a newer local SDK formats
differently, which turns CI's format check red), and `"scope":
"uncommitted"` on `/run` narrows a command to the working tree's uncommitted
`.dart` files — the set CI format-checks. A test job also reads the project's
optional `.toolbridge/known-failures.json` and splits its failures into known
and new, so a red local run can be read instead of re-diagnosed.

Sub-tools are named operations that run as jobs. The first is
`POST /tools/arb-edit`: it applies ARB localization edits, runs `flutter
gen-l10n` and reports the untranslated-messages-file — the sequence the
standalone `flutter-arb-edit` skill used to own, which needed a second
escalation because `gen-l10n` cannot run under the sandbox (ADR-0003).

## Run

```powershell
python -u D:\Projects\dsh-tool-bridge\scripts\toolhub_server.py `
  --cwd "<session workspace>" --watch-parent
```

Started plainly it fails its boot self-check on purpose (the sandbox denies the
SDK lockfile write); that failure is the evidence for retrying the same command
with `danger-full-access`. See the skill for the API and the client snippets.

To format with the dart a project's CI pins — the boot prints the version it
will use, and `/health` reports it as `dartFormatExe`:

```powershell
python -u D:\Projects\dsh-tool-bridge\scripts\toolhub_server.py `
  --cwd "D:\Projects\kelivo" --watch-parent `
  --dart-format D:\Tools\dart-3.12.2\bin\dart.exe
```

At boot it opens the tokenised status page in the default browser: this thing is
normally launched by an agent as a background job that never exits, so the URL
printed at startup is exactly the line a human cannot find. Pass `--no-open` on
a headless box or in automation; the printed `TOOLHUB STATUS` URL is the
fallback.

## Where the rest lives

- Domain vocabulary: `CONTEXT.md` — the terms the code and the skill are written
  in, plus the ambiguities that were resolved to get there.
- Decision records: `docs/adr/` — the decisions that are expensive to
  reverse (the allowlist is a guardrail rather than a privilege boundary; the
  working directory is pinned, so there is no per-job cwd or baseline worktree;
  sub-tools are queue jobs with structured results).
- Skill entry, what DSH discovers and deploys: `~/.dsh/skills/tool-bridge/SKILL.md`.
- `scripts/toolhub_server.py` is the canonical program; edits here are what run.
  `scripts/arb_edit_lib.py` is the ARB edit logic behind the `arb-edit`
  sub-tool — it was ported from the retired `flutter-arb-edit` skill, and this
  module is now the only copy of it.
- Self-tests: `python tests/test_toolhub.py` (stdlib `unittest`; they cover the
  git guards, the log filter, the test-log digest and the `arb-edit` sub-tool).

`CONTEXT.md`, `docs/` and `tests/` stay in this repository on purpose:
`scripts/sync_to_skills.py` excludes them, so the globally deployed skill carries
only `SKILL.md` and the server.

## Deliberately absent

- `git push` (the GitHub token must never live in a long-running process), git
  history rewriting (`reset --hard`, `rebase`), whole-worktree wipes (`clean`,
  `git restore .`), `stash`, and `checkout`/`switch` in every form.
- An accepted executable name for arbitrary commands. The bridge is *not* a
  security boundary — `dart` runs any subcommand, so `dart run <file>.dart`
  reaches arbitrary code with the access the boot escalation granted (ADR-0001).
- Per-job `cwd` and worktree-per-baseline entries (ADR-0002), detached mode
  across sessions, and build-cache copying between worktrees (CMake/ninja state
  is path-keyed, while the genuinely expensive caches — pub cache, SDK
  artifacts — are already machine-global).
- A queue-aware early return from `/run`: `wait:false` already expresses it, and
  returning `queued` immediately whenever the queue is non-empty would force
  polling for the common case.
- A per-request formatter or SDK override, and a scope for anything but `dart
  format` (an **Expansion**), `dart`/`flutter` `analyze` and `fix` (a
  **Filter**). The pin is boot-scoped, like the pinned cwd; a request that could
  retarget the toolchain would just be a slower way to format with the wrong
  dart.

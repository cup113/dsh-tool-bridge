# dsh-tool-bridge

[![CI](https://github.com/cup113/dsh-tool-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/cup113/dsh-tool-bridge/actions/workflows/ci.yml)

A session-scoped, loopback-only toolchain server for **file-sandboxed agent
sessions**. It is started once with one elevated approval and then runs
`flutter`/`dart` (any subcommand), a guard-railed `git` verb set and a couple of
sub-tools on the agent's behalf over HTTP — so the confined agent pays **one
approval per session instead of one per command**.

The friction it removes is specific. Inside a `workspace-write` sandbox (DSH is
the harness this was written for) the Flutter/Dart toolchain cannot run at all —
it fails writing the SDK lockfile — and every `git` write is denied, because the
git directory lives outside the workspace. An agent that wants to build, test or
commit therefore needs a fresh elevation per command. This server *is* that
elevation, spent once; every call after it is an ordinary confined HTTP request.

Along the way it also serializes jobs (concurrent Flutter runs fight over
`build/`), captures UTF-8 logs regardless of the console code page, filters them
server-side, digests `flutter test` results into counts and a failure inventory,
keeps a job's process tree killable, and can line a local run up with what CI
actually checks.

## Read this before running it

**It is not a sandbox, and it is not a privilege boundary.** It holds, for its
whole lifetime, the access your boot approval granted.

- `dart` accepts any subcommand, so `dart run <file>.dart` executes arbitrary
  code with that access. What the allowlist buys is *recovery cost and surprise*
  for a fallible caller — a refused command is one you cannot lose work to — not
  privilege (ADR-0001).
- It binds `127.0.0.1` on an ephemeral port, and every route but `/health`
  requires a bearer token. The token is never written to a file by the bridge: it
  is printed to the job output that started it, and — when the status page opens
  — it also lands in your browser's address bar and history, on the same machine
  and for the same user who reads that output.
- Deliberately absent: `git push` (a GitHub token must never live in a
  long-running process), history rewriting, whole-worktree wipes, `stash`, and
  `checkout`/`switch` in every form.
- The callers are your own agent sessions on your own machine. If that is not
  your trust model, this is the wrong tool.

## Requirements

- **Windows** — CI-verified. The code carries a POSIX fallback that nobody has
  exercised, so treat elsewhere as untested rather than supported.
- **Python 3.11+** for the server: standard library only, no dependencies.
- `flutter`/`dart` and `git` on `PATH` for the jobs that use them.

## Install

```powershell
git clone https://github.com/cup113/dsh-tool-bridge
cd dsh-tool-bridge
```

Then either read `SKILL.md` yourself, or deploy it where a DSH session discovers
skills — the one step that needs an escalation, because it writes outside your
workspace:

```powershell
python scripts/sync_to_skills.py --dest "$env:USERPROFILE\.dsh\skills\tool-bridge"
```

`--dest` defaults to exactly that path. Note the deliberate split: the repository
is `dsh-tool-bridge`, the skill it deploys is `tool-bridge`.

## Quickstart

```powershell
# 1. Start it. Run it plainly first: under the sandbox the boot self-check fails
#    visibly on the SDK lockfile, and that failure is the grounded reason to
#    retry the very same command with wider permissions.
python -u <repo>\scripts\toolhub_server.py --cwd "<project>" --watch-parent

# Elevated, the same command prints:
#   TOOLHUB SELFTEST OK in 0.8s version=Flutter ...
#   TOOLHUB READY port=60549 pid=16288 cwd=... logdir=...
#   TOOLHUB TOKEN <token>
#   TOOLHUB STATUS http://127.0.0.1:60549/?token=<token>
```

```powershell
# 2. Drive it — confined, no escalation from here on.
$port=60549; $tok='<token>'; $h=@{Authorization="Bearer $tok";'Content-Type'='application/json'}
$body=@{cmd='flutter';args=@('test','test/features');wait=$true;timeoutSec=900}|ConvertTo-Json -Compress
$r = Invoke-RestMethod "http://127.0.0.1:$port/run" -Method Post -Headers $h -Body $body
"$($r.status) exit=$($r.exitCode) $($r.summary)"
$r.failures   # the complete failure inventory, in run order
$r.tail       # the last 200 log lines, UTF-8
```

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness + `tools` + `dartFormatExe` (the formatter pin, or null); no token |
| GET | `/?token=…` | human status page: job list + live log tail (opened at boot) |
| POST | `/run` | `{"cmd","args","message","scope","wait","timeoutSec","grep","tail"}` → job |
| POST | `/tools/arb-edit` | ARB localization edits plus `flutter gen-l10n`, with a structured `result` |
| GET | `/jobs` · `/jobs/<id>?tail=N&grep=P` · `/jobs/<id>/log` | job list · one job with a log view · the raw log |
| POST | `/jobs/<id>/kill` · `/stop` | kill that job's process tree · kill children and exit |

`SKILL.md` is the full reference: request shapes, the PowerShell traps that make a
call look like a 404, caller-timeout nesting, and what every digest field means.

## Three things worth knowing

**Pin the formatter to CI's dart.** `dart format` output changes between SDK
releases, so formatting with a newer local dart is what turns CI's
`dart format --set-exit-if-changed` check red. `--dart-format <dart.exe>` routes
`dart format` jobs to the SDK a project's CI pins, verifies it at boot and
reports it as `/health.dartFormatExe`. Everything else keeps the `PATH`
toolchain on purpose: `dart analyze` also depends on the Flutter framework
version resolved through the package config, which a formatter pin cannot align.

```powershell
python -u <repo>\scripts\toolhub_server.py --cwd "<project>" --watch-parent `
  --dart-format C:\Tools\dart-3.12.2\bin\dart.exe
```

**Scope a command to your uncommitted files.** `"scope": "uncommitted"` reads the
working tree with `git status --porcelain -z` and narrows the command to the
`.dart` files that are not committed yet. `dart format` receives them as trailing
paths — CI's changed-files check, run locally — while `analyze` and `fix` accept
at most one directory, so there the scope filters the returned lines instead. An
empty set is a 400, because `dart format` with no paths rewrites the whole tree.

**Ask "is this failure mine?" from data.** A project can record the failures that
were already red before your change in `.toolbridge/known-failures.json`
(platform-specific, flaky, not-yours-yet). A test job then annotates each claimed
failure with `known`, reports `baseline.newFailures` — the complete, ordered list
of the new ones — and appends the split to `summary`
(`77 failed (74 known, 3 new)`). The split counts distinct tests rather than
progress lines, so it can never contradict the count it sits next to, and a
registry that cannot be read claims nothing and says so.

## Where the rest lives

- `SKILL.md` — the agent-facing reference: start, drive, timeouts, the ARB
  sub-tool, the test digest and the known-failure registry.
- `CONTEXT.md` — the vocabulary the code and the skill are written in (bridge,
  escalation, guardrail, digest, format pin, uncommitted scope), plus the
  ambiguities that were resolved to get there.
- `docs/adr/` — the decisions that are expensive to reverse: the allowlist is a
  guardrail rather than a privilege boundary; the working directory is pinned, so
  there is no per-job `cwd` or baseline worktree; sub-tools are queue jobs with
  structured results.
- `scripts/toolhub_server.py` — the canonical program; edits here are what run.
  `scripts/arb_edit_lib.py` is the ARB edit logic behind the `arb-edit` sub-tool.
- `scripts/sync_to_skills.py` — deploys `SKILL.md` plus `scripts/` as a skill, and
  deliberately leaves `CONTEXT.md`, `docs/` and `tests/` in the repository.

## Development

```powershell
python -m pip install -r requirements-dev.txt
python tests/test_toolhub.py        # 98 tests, standard-library unittest
ruff check . ; ruff format --check .
pyright scripts tests
```

CI runs the same three things on `windows-latest`, against Python 3.11 / 3.13 /
3.14.

## Why not a DSH plugin?

DSH plugins run *inside* the harness process: Node/ESM packages installed with
`dsh plugin add`, loaded through the harness's own bundle and slot machinery. This
does the opposite — it runs *beside* the harness, as an ordinary background
process, precisely because its job is to touch the very toolchain the harness's
file sandbox denies, and it must not be subject to that sandbox itself. That is
why it ships as a skill plus a script rather than as a plugin package.

## Deliberately absent

- `git push` (the GitHub token must never live in a long-running process), git
  history rewriting (`reset --hard`, `rebase`), whole-worktree wipes (`clean`,
  `git restore .`), `stash`, and `checkout`/`switch` in every form.
- An accepted executable name for arbitrary commands — see the security model
  above; `dart` already reaches arbitrary code.
- Per-job `cwd` and worktree-per-baseline entries (ADR-0002), detached mode across
  sessions, and build-cache copying between worktrees (CMake/ninja state is
  path-keyed, while the genuinely expensive caches — pub cache, SDK artifacts —
  are already machine-global).
- A queue-aware early return from `/run`: `wait:false` already expresses it, and
  returning `queued` whenever the queue is non-empty would force polling for the
  common case.
- A per-request formatter or SDK override, and a scope for anything but
  `dart format` (an expansion), `dart`/`flutter` `analyze` and `fix` (a filter).
  The pin is boot-scoped, like the pinned cwd; a request that could retarget the
  toolchain would only be a slower way to format with the wrong dart.

## Licence

MIT — see [`LICENSE`](LICENSE).

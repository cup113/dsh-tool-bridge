---
name: tool-bridge
description: Use in a sandboxed DSH session whenever a Flutter/Dart toolchain command (pub get, format, analyze, test, build), a Node toolchain command (pnpm install/run, vite build or dev, vitest, svelte-check, tsc), a git write (add, commit, restore), or a Flutter ARB localization edit is needed. Starts one elevated, loopback-only server per session so the confined agent can run the toolchain over HTTP instead of paying a one-shot danger-full-access escalation per command.
---

<what-to-do>

Source of truth: this repository (a git checkout anywhere on disk). DSH discovers
and loads the deployed copy at `~\.dsh\skills\tool-bridge`, so below `<skill>`
means that deployed directory. Edit the repository, then deploy with
`python scripts/sync_to_skills.py` — it copies `SKILL.md` and `scripts/`, and
deliberately skips `CONTEXT.md`, `docs/` and `tests/` so the global skill carries
no documentation. The repository's `CONTEXT.md` (vocabulary) and `docs/adr/`
(decisions) are worth reading from the repo when a rule here looks arbitrary.

Use this whenever a toolchain command would otherwise need a one-shot
`danger-full-access` escalation. In the DSH file sandbox (`workspace-write`),
Flutter/Dart tooling cannot run at all (it fails writing the SDK lockfile, or
hangs), every git write is denied because the git dir lives outside the
workspace, and a Node toolchain dies on `spawn EPERM` — the sandbox cannot create
the named pipes libuv uses for child stdio, which is what takes down `vite`'s
Windows `net use` probe, `vitest`'s default forks pool and `esbuild`. This server
is started **once** per session with that escalation and
does the work from then on; every client call below is an ordinary confined
command.

## 1. Start it (this is the only step that needs escalation)

Attempt the start plainly first:

```powershell
python -u <skill>/scripts/toolhub_server.py --cwd "<session workspace>" --watch-parent
```

Run it with `run_in_background: true`. Under the sandbox the boot self-check
fails fast and visibly:

```
TOOLHUB SELFTEST FAILED reason=exit-1 output=Flutter failed to open a file at "...\bin\cache\lockfile" ...
```

That failure is the ground for retrying **the exact same command** with
`sandbox_permissions: danger-full-access`. Elevated, the same boot prints:

```
TOOLHUB SELFTEST OK in 0.7s version=Flutter 3.47.0 • channel stable ...
TOOLHUB READY port=60549 pid=16288 cwd=... logdir=...
TOOLHUB TOKEN <per-session token>
TOOLHUB STATUS http://127.0.0.1:60549/?token=<per-session token>
```

Read port and token with `job_output`. Never write them to a file: they live in
the harness's job output and in server memory only.

**The boot opens the status page in the default browser** — that tab is the
human's progress view, and it is why the `STATUS` line never has to be hunted
for: this server runs as a background job that by design does not exit, so a
line printed at boot scrolls out of view, and the port is random. Opening the
page is best-effort and never delays or fails the boot (`TOOLHUB OPEN ...` says
whether it worked); `--no-open` suppresses it on a headless box or under
scripted tests, and `TOOLHUB STATUS` stays the fallback either way. Reporting
that URL to the human in a reply is fine — it is already in the job output this
skill tells you to read — but it still must not be written to a file.

Optional startup work (queued before the socket opens), e.g. to warm a build
while the agent does something else:

```powershell
python -u <skill>/scripts/toolhub_server.py --cwd "<ws>" --watch-parent `
  --run "flutter pub get" --run "flutter build windows --debug"
```

## 2. Drive it (confined; no escalation)

```powershell
$port=60549; $tok='<token>'; $h=@{Authorization="Bearer $tok";'Content-Type'='application/json'}
function Invoke-Run([string]$exe,[string[]]$cmdArgs,[int]$timeout=900){
  $body=@{cmd=$exe;args=$cmdArgs;wait=$true;timeoutSec=$timeout}|ConvertTo-Json -Compress
  Invoke-RestMethod "http://127.0.0.1:$port/run" -Method Post -Headers $h -Body $body -TimeoutSec ($timeout+30)
}
$r = Invoke-Run 'flutter' @('test','test/core/services/sync')
"$($r.status) exit=$($r.exitCode) $($r.durationSec)s $($r.summary)"
$r.failures   # [{"file","name","didNotComplete"}] — complete, in run order
$r.tail       # last 200 log lines, UTF-8
```

Filter the log server-side instead of pulling noise back and grepping it by
hand — `grep` selects lines, `tail` caps how many are returned:

```powershell
$body=@{cmd='flutter';args=@('test','test/features');wait=$true;timeoutSec=900;
  grep='\[E\]|Failing tests|Expected|Actual';tail=80}|ConvertTo-Json -Compress
$r = Invoke-RestMethod "http://127.0.0.1:$port/run" -Method Post -Headers $h -Body $body -TimeoutSec 1000
$r.log        # {grep, matched, returned, scannedLines, truncated}
$r.tail       # the last 80 matching lines
```

**Two PowerShell traps in these helpers**, both of which produce a misleading
`{"error":"not found"}`-style answer rather than an error:

- **Never name a parameter `$args`** — it is a reserved automatic variable, and
  the argument list silently arrives empty.
- **Never interpolate a variable directly before `?`** — `".../jobs/$id?tail=5"`
  is parsed as a variable named `id?tail`, mangling the URL into a 404. Use a
  subexpression: `".../jobs/$($id)?tail=5"`.

## 3. Format the way CI formats (and scope a command to your changes)

`dart format` output changes between dart releases, and CI format-checks with
**the dart bundled in the Flutter version its workflow pins**. So files
formatted by a newer local SDK fail CI's `--set-exit-if-changed` check even
though nothing looks unformatted locally. Two knobs close that gap.

**Pin the formatter** — a start flag, so `dart format` jobs run the dart CI
uses while every other command keeps the local SDK:

```powershell
python -u <skill>\scripts\toolhub_server.py --cwd "<project>" --watch-parent `
  --dart-format C:\Tools\dart-3.12.2\bin\dart.exe
```

- Only **`dart format`** routes to the pin. `dart analyze`/`test`/`pub` and
  every `flutter` command deliberately keep the locally installed SDK.
- **Why `analyze` is not pinned too**: its verdict depends on the SDK's analyzer
  *and* on the Flutter framework version resolved through the package config
  (locally 3.47.x, on CI whatever the workflow pins). A pin would align the
  analyzer and leave the framework wrong, so a local/CI `analyze` disagreement
  is usually a framework-version story — pinning cannot fix it, a second Flutter
  install would. `dart format` has no such coupling: its behaviour *is* the SDK's
  bundled formatter, which is why the pin is exact there.
- The boot prints the version it will format with
  (`TOOLHUB DART-FORMAT OK version=Dart SDK version: 3.12.2 ...`) and refuses to
  start when the pin cannot run; `GET /health` reports it as `dartFormatExe`;
  the job's `resolvedArgv` is what actually ran.
- **Finding the version to pin**: take the `dart_sdk_version` of the Flutter
  version in the project's workflow (`.github/workflows/*.yml`, e.g.
  `FLUTTER_VERSION: '3.44.6'` → dart **3.12.2**). A *standalone* dart SDK is
  enough — `dart format` does not need Flutter — so download
  `dartsdk-windows-x64-release.zip` from
  `https://storage.googleapis.com/dart-archive/channels/stable/release/<version>/sdk/`
  and unpack it to `C:\Tools\dart-<version>`. One download serves every session
  afterwards. (Where the SDK actually lives is your choice — the flag takes any
  path. The *version* is not a choice: it comes from the project's CI.)

**Scope to your uncommitted files** — `"scope": "uncommitted"` on `/run`:

```powershell
# exactly what CI's changed-files format check does, run locally:
$body=@{cmd='dart';args=@('format','--output=none','--set-exit-if-changed');
  scope='uncommitted'}|ConvertTo-Json -Compress
$r = Invoke-RestMethod "http://127.0.0.1:$port/run" -Method Post -Headers $h -Body $body
$r.argv        # dart format --output=none --set-exit-if-changed <your files...>
$r.exitCode    # 0 means CI's format check would pass
```

- The set comes from `git status` in the pinned cwd, read once at submit time:
  staged, unstaged and untracked `.dart` files; deleted and ignored ones
  excluded. (CI compares two commits and never sees untracked files — this is
  the working tree.)
- `dart format` receives the files as trailing paths, so the formatter itself is
  narrowed. `dart analyze` takes at most one *directory* and `dart fix` takes no
  path at all, so there the same scope narrows the **returned lines** instead:
  your files' diagnostics come back (`$r.log.matched`), while `exitCode` still
  describes the whole project — a pre-existing issue in an untouched file still
  fails the run.
- **Nothing uncommitted is a 400**, on purpose: `dart format` with no paths
  rewrites the entire tree, which is the opposite of scoping.
- `scope` and `grep` are both log filters and cannot be combined; a command
  that cannot be scoped (`git`, `dart test`, ...) is a 403.
- The two knobs compose: a scoped `dart format` runs the **pinned** dart on your
  changed files.

## 4. Caller timeouts (the queue is not free)

`wait:true` blocks for **queue time plus run time**, and `timeoutSec` bounds that
whole wait — not just the execution. When it expires the server returns the job
as it stands (`status: "queued"` or `"running"`, plus `aheadOf`) and lets it keep
running; nothing is killed.

So the budgets must nest:

- **HTTP client timeout > `timeoutSec`.** In the helper above that is
  `-TimeoutSec ($timeout+30)`.
- **Harness tool timeout > HTTP client timeout.** A pwsh tool call defaults to
  about 120 s, which `timeoutSec=900` can never reach: the call dies first and
  the job becomes unreachable **until you look it up**, which is the next point.
- For anything that may exceed ~100 s, either pass an explicit `timeoutMs` with
  generous slack, or use `wait:false` and poll:

```powershell
$body=@{cmd='dart';args=@('analyze','lib','test');wait=$false}|ConvertTo-Json -Compress
$job = Invoke-RestMethod "http://127.0.0.1:$port/run" -Method Post -Headers $h -Body $body
"queued behind $($job.aheadOf)"
$j = Invoke-RestMethod "http://127.0.0.1:$port/jobs/$($job.id)?tail=20" -Headers $h
```

**Recovery after a caller-side timeout**: the job survives, so fetch it by id
with `GET /jobs/<id>?tail=N&grep=P` — including the digest, since the failure
inventory rides with the log view. `/jobs` lists everything with `summary` and
`counts` but no logs or failure lists, so it stays cheap to read.

## 5. Edit ARB localization files (sub-tool)

`flutter gen-l10n` cannot run confined, which used to make an ARB edit cost a
second escalation. It is a bridge **sub-tool** now: the edit, the gen-l10n run
and the untranslated-messages check all happen in the pinned cwd, on the same
single worker that serializes builds.

```powershell
$instr = @{ groups = @(
  @{ insertAfter = 'chatMessageWidgetSpeak'; newFields = @(
     @{ key = 'lanSyncSectionTitle'; value = @{
          'app_en.arb'      = 'LAN Sync'
          'app_zh.arb'      = '局域网同步'
          'app_zh_Hans.arb' = '局域网同步'
          'app_zh_Hant.arb' = '區域網路同步' } } ) } ) }
$body = @{ groups = $instr.groups; wait = $true; timeoutSec = 300 } |
        ConvertTo-Json -Depth 10 -Compress
$r = Invoke-RestMethod "http://127.0.0.1:$port/tools/arb-edit" -Method Post `
       -Headers $h -Body $body -TimeoutSec 400
$r.result.edited        # files written
$r.result.changes       # per file: inserted / deleted key names
$r.result.genL10n       # {"exitCode": 0}
$r.result.untranslated  # null, or {file, lines, content} — a warning, not a failure
```

- **Check the anchors first**: add `dryRun = $true`. The reply lists exactly what
  would change and nothing is written.
- The body is UTF-8 JSON, so CJK values need no console code-page games, and no
  instruction file is ever created.
- **There is no `cwd` field** — the bridge pins the project directory at boot, so
  a `cwd` in the body is a `400`. Edit another project by starting a bridge with
  `--cwd <project>` (a second bridge is fine; it is one escalation, and only if
  the toolchain needs one at all).
- `$r.result.genL10n.exitCode != 0` means the edits **were** written and gen-l10n
  then failed: read `$r.tail`, fix the ARB, and re-post.
- The schema and the pitfalls are under "Sub-tool: arb-edit" in the reference
  below. Run `/health` first if you are unsure whether the deployed bridge has
  this sub-tool: it reports `tools`.

## 6. Node toolchain: pnpm, vite, vitest, svelte-check

`pnpm` is accepted by verb (`install`, `i`, `add`, `remove`, `update`, `rebuild`,
`dedupe`, `run`, `exec`, `why`, `list`, `outdated`, `audit`, `licenses`), and the
project's own tools are commands of their own:

```powershell
$r = Invoke-Run 'pnpm' @('install')                       # also runs the build scripts
$r = Invoke-Run 'vitest' @('run','--pool=threads')        # digest + known-failure split
$r = Invoke-Run 'vite' @('build')
$r = Invoke-Run 'svelte-check' @('--tsconfig','./tsconfig.json')
$r = Invoke-Run 'tsc' @('--noEmit')                       # inside the project
```

What the surface is, and why:

- **The accepted names are `vite`, `vitest`, `svelte-check`, `svelte-kit`, `tsc`**
  plus `pnpm` (`/health.commands` lists them). Each is resolved inside the pinned
  cwd's `node_modules` by reading the package's `bin` field — so `tsc` finds
  `typescript`, `svelte-kit` finds `@sveltejs/kit` — and runs under `node`.
  Never through `.bin/*.CMD`: that is a shell wrapper, and running it would put
  `cmd.exe` back in the middle of an argv that is supposed to have no shell.
  A tool that is not installed is a job failure naming the missing
  `node_modules/<pkg>/package.json`, so run `pnpm install` first.
- **A script binary must be run from the pinned cwd.** It is looked up in
  `<cwd>/node_modules` and nowhere else, so a bridge pinned at the wrong
  directory fails loudly rather than running a different project's vite.
- **`--pool=threads` is the flag to remember for vitest.** Vitest's default
  `forks` pool uses an IPC pipe, and pipes are exactly what the sandbox forbids
  (`spawn EPERM`), so the default pool fails *in a confined session*; the threads
  pool works. Under the bridge it does not matter — but keeping it makes a
  command portable between the two, and it is what makes a confined run possible
  at all.
- **`pnpm exec` takes only those five names.** Measured, `pnpm exec node
  --version` and `pnpm exec cmd /c echo hi` both work because pnpm falls back to
  `PATH`; accepting that would be general command execution behind an
  allowlisted verb. Everything else is a `403` that names `pnpm run <script>`.
  `-c`/`--shell-mode` is refused with it.
- **The cwd-retargeting flags are refused** on every verb: `-C`, `--dir`,
  `--prefix`, `-w`, `--workspace-root`, `-g`, `--global`. The pinned cwd is an
  ADR-0002 invariant, and `-g` leaves the project entirely. `pnpm dlx`,
  `publish`, `config`, `setup` and `store` are absent by omission.

### Long jobs: dev servers and watch mode

A job that is expected to run **until you kill it** goes to its own lane, so it
cannot starve the builds behind it:

```powershell
# guessed onto the long lane, and it KEEPS RUNNING: wait returns, the job does not
$body=@{cmd='vite';args=@('dev','--port','5199');long=$true;wait=$true;timeoutSec=60}|ConvertTo-Json -Compress
$r = Invoke-RestMethod "http://127.0.0.1:$port/run" -Method Post -Headers $h -Body $body -TimeoutSec 120
$r.status     # "running" — read the log, then kill it when done
$r.resolvedArgv
$r.tail       # "ready in 557 ms", the URL it bound, ...

# stop it when you are finished with it
Invoke-RestMethod "http://127.0.0.1:$port/jobs/$($r.id)/kill" -Method Post -Headers $h
```

- **Inferred**: `vite dev`/`serve`/`preview`, bare `vite`, `vitest` without
  `run`/`--run`, and `pnpm run <script>` for a script named
  `dev`/`start`/`serve`/`watch`/`storybook`. `--help`/`--version` probes are
  excluded.
- **`long: true` overrides the guess either way** — pass it when a script has an
  unusual name, or `long: false` when a long-looking name is actually one-shot.
  The guess exists because the two error directions are not symmetric: a dev
  server left on the queue lane starves every build behind it, while a one-shot
  job put on the long lane merely occupies that lane until it exits.
- A long job still has a log, a `summary`, `aheadOf` and a kill like any other
  job; the job JSON just adds `"long": true`, and the status page marks it.
- Killing works even where `taskkill` is refused (it is, in this sandbox): the
  bridge falls back to terminating the process it spawned, and logs
  `TOOLHUB KILL` when it does.

## 7. Stop it

`POST /stop` when work is done (`Invoke-RestMethod ".../stop" -Method Post
-Headers $h`). If it is left running, the parent watchdog ends it when the
session does; a stale server is never a correctness problem because the next
session binds a new random port.

</what-to-do>

<supporting-info>

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness + `tools` (the sub-tools this bridge supports) + `commands` (the accepted executables) + `dartFormatExe` (the formatter pin, or null); no token |
| GET | `/?token=…` | human status page: job list + live log tail (browser-friendly; opened automatically at boot) |
| POST | `/run` | `{"cmd","args","message","scope","long","wait","timeoutSec","grep","tail"}` → job; `wait:true` blocks until done |
| POST | `/tools/arb-edit` | `{"groups","dryRun","wait","timeoutSec","grep","tail"}` → job with a structured `result` |
| GET | `/jobs` | all jobs, newest last (no logs, no failure lists) |
| GET | `/jobs/<id>?tail=N&grep=P` | one job + last N log lines (default 200), or the last N lines matching the `P` regex |
| GET | `/jobs/<id>/log` | full raw log (UTF-8) |
| POST | `/jobs/<id>/kill` | kill that job's process tree |
| POST | `/stop` | kill children and exit |

All but `/health` require `Authorization: Bearer <token>` (the status page may
pass `?token=` instead, since a browser cannot set headers).

Job JSON: `id, kind (cmd|tool), argv, resolvedArgv, status
(queued|running|done|failed|killed), scope, exitCode, startedAt, finishedAt,
durationSec, summary, counts, error, result, logPath`, plus `tail`, `log`,
`failures` and `baseline` whenever the response carries a log view.

### Sub-tool: arb-edit

`POST /tools/arb-edit` applies ARB edits, runs `flutter gen-l10n` and reports the
untranslated-messages-file. It is a Job like any other (ADR-0003): it queues
behind a running build, it is killed by `/jobs/<id>/kill`, and its log is the
raw combined output of the edit report plus gen-l10n. `argv` is a display line
(`["tool:arb-edit", "2 group(s)"]`); `resolvedArgv` is the gen-l10n launch that
actually ran.

Request body:

```json
{
  "dryRun": false,
  "groups": [
    {
      "insertAfter": "someExistingKey",
      "deleteFrom": "firstKeyToDelete",
      "deleteTo": "lastKeyToDelete",
      "newFields": [
        {
          "key": "newKeyName",
          "value": {
            "app_en.arb": "English Value",
            "app_zh.arb": "中文值",
            "app_zh_Hans.arb": "简体中文值",
            "app_zh_Hant.arb": "繁體中文值"
          }
        }
      ]
    }
  ]
}
```

- **`groups`** (required): one or more edit groups, applied in order.
  - **`insertAfter`**: the key to insert after, or `__END__` for the end of the
    file. Required when `newFields` is non-empty. If the anchor owns an `@key`
    metadata block, the new entries go after the block, so it stays attached.
  - **`deleteFrom` / `deleteTo`**: an **inclusive** key range to delete first;
    both or neither. An `@key` block following `deleteTo` is deleted with it.
    The range applies to every file the group touches, so a key that only some
    files have fails the whole plan (nothing written) — name the files
    explicitly with `newFields` when the key is not universal.
  - **`newFields`**: `key` plus a map of ARB file name → translated string.
    Only the named files are touched. **Omit `newFields` entirely** (or send an
    empty list) for a pure delete: that applies to every `app_*.arb` in the
    configured arb-dir. A group with neither `newFields` nor a
    `deleteFrom`/`deleteTo` range is refused — it would do no work while
    rewriting every ARB file and running gen-l10n for nothing.
  - Keys starting with `@` are refused: gen-l10n generates `@key` metadata from
    the template ARB file, and a hand-written string value is not a Map.
- **`dryRun`**: plan only — no file is written and gen-l10n does not run.

`result`:

```json
{
  "dryRun": false,
  "edited": ["app_en.arb", "app_zh.arb"],
  "skipped": [{"file": "app_xx.arb", "reason": "not found"}],
  "changes": [{"file": "app_en.arb", "inserts": ["newKeyName"], "deletes": []}],
  "genL10n": {"exitCode": 0},
  "untranslated": {"file": "desiredFileName.txt", "lines": 3, "content": "..."}
}
```

- Line endings are preserved per file (CRLF stays CRLF) and values are written
  as raw UTF-8, never `\uXXXX`-escaped.
- **Plan before write**: every target file is planned in memory first, so a
  missing anchor means `status: "failed"` with `error` naming the file and key,
  and **zero** files touched.
- `genL10n.exitCode != 0` fails the job but the edits stand; `edited` and
  `changes` still say what was written, so fix the ARB and re-post.
- `untranslated` is non-null only when the configured
  `untranslated-messages-file` exists with real content — a warning, never a
  failure. A missing or `{}` file counts as no untranslated messages.
- `skipped` lists ARB files named in a value map that do not exist on disk;
  they are not created.
- ARB files are only edited; the generated Dart is gen-l10n's business.

### Reading a job's output

- **`tail`** — the log lines returned: `/run` defaults to 200, `/jobs/<id>` to
  200, both capped at 5000 and both accepting `0`.
- **`grep`** — an optional case-sensitive Python regex; only matching lines are
  eligible, and `tail` then caps how many are returned. An invalid pattern is a
  `400`. With `grep` the whole log is scanned (without it, only the last 256 KiB
  is read), and the response's **`log`** object reports `matched`, `returned`,
  `scannedLines` and `truncated` — so `matched: 0` is "no such line", never
  "no output".
- The raw log is never rewritten; `/jobs/<id>/log` and the status page stay
  unfiltered.

### Reading a test result

`summary` is the one-line digest (`83 passed, 4 failed`); `counts` is
`{passed, skipped, failed}` from the last progress line; `failures` is the
**complete** failure inventory in run order:

```json
[{"file": "C:/ws/test/desktop/alpha_test.dart", "name": "alpha refuses a bad key", "didNotComplete": false}]
```

The same fields come back for a **vitest** run — `vitest run` and
`pnpm exec vitest run` are recognised by their argv, and `pnpm run test` by the
reporter's own markers in the log, because the script name is the project's word
for it. What differs:

- `file`/`name` are split on vitest's ` > `: `FAIL  src/App.test.ts > add > fails
  on purpose` becomes `file: "src/App.test.ts"`, `name: "add > fails on purpose"`
  (the full test name, which is what a registry entry matches on).
- A suite that never loaded has no `FAIL <path> > ...` line, only the
  `Failed Suites` section, and its summary line reads `Tests  no tests`. Those
  are counted into `counts.failed` and reported as `loading <path>`, the same
  shape the flutter digest uses — so one registry rule claims it on either runner.
- `summary` reaching you at all proves the run finished: vitest writes its
  `Tests` line last, so a killed run reports `see log` with whatever inventory it
  had.

Where a **flutter** digest comes from matters when it looks thin:

- `failures` is built from the `[E]` progress lines, **not** from the reporter's
  `Failing tests:` block: that block lists at most four entries (then
  `... and N more`) sorted by path, so a failure of yours can be evicted by
  alphabet. The block is used only to lend a suite path to an entry that has
  none — `file` is `null` for a single-file run, where the reporter prints no
  path at all.
- `counts.failed` is authoritative; if it exceeds `len(failures)`, the log was
  written by a reporter whose failure lines this parser does not recognise.
- Under `-r json` or `-r silent` there are no progress lines: `failures` is `[]`
  and `summary` is `see log`. A load/compile failure appears as an entry whose
  `name` starts with `loading `.
- No terminal marker (`All tests passed!` / `Some tests failed.`) means the run
  was killed or truncated, and `summary` stays `see log` rather than claiming a
  count that is only "so far".

**Two reporter flags are worth knowing about** (both are `flutter test` flags,
so they go in `args`):

- `--reporter=failures-only` — one line per failure, no per-test progress lines.
  The counts, `[E]` lines and `summary` survive; the `Failing tests:` block does
  not (by design, above). It still echoes test `print()` output, which is where
  repeated warnings come from.
- `--file-reporter=json:<path-relative-to-cwd>` — an additional machine-readable
  JSONL result file. Because it is written by the job in the pinned cwd, it lands
  inside the workspace and the confined agent can read it directly with the
  normal file tools; use it when you need ids, timings, or a second opinion on
  the inventory.

### "Is this failure mine?" — the known-failure registry

A project can write down the failures that were **already red before your
change** (platform-specific, flaky, not-yours-yet) in
`<project>/.toolbridge/known-failures.json`. Every test job then reports the
split, so a red local run can be read instead of re-diagnosed:

```json
{
  "entries": [
    {
      "file": "test/utils/sandbox_path_resolver_test.dart",
      "match": "^SandboxPathResolver\\.",
      "kind": "platform",
      "platform": "windows",
      "reason": "path separator: expected '/' actual '\\'"
    },
    {
      "name": "concurrent sends persist a single user/assistant pair",
      "kind": "flaky",
      "reason": "tearDown races the temp-file lock"
    }
  ]
}
```

- Each entry needs **exactly one** of `name` (exact test name) or `match` (a
  regex searched in it). Optional: `file` narrows it to one suite (a relative
  path; the reporter's absolute, mixed-separator path is normalised), `platform`
  (`windows`/`posix`) keeps a Windows-only family from silencing CI's Linux run,
  and `kind` (`platform`/`flaky`/`environment`/`defect`/`unclassified`) plus
  `reason` ride into the response. The first matching entry wins. A failure whose
  path the reporter did not print (a single-file run) cannot match a
  `file`-scoped entry — it stays new rather than being attributed to the wrong
  suite.
- The digest answers in three places, and **only one of them names the new
  failures**:

  | field | what it gives you |
  |---|---|
  | `failures[i].known` | `{kind, reason}` when the registry claimed that failure; **absent = new** |
  | `baseline.newFailures` | **the complete, ordered list of the new ones** — read this to act |
  | `summary` | the glance: `83 passed, 4 failed (3 known, 1 new)` |

  So the `summary` suffix tells you *whether* to look; `baseline.newFailures`
  tells you *which*. No summary ever names individual tests — never report
  "which failed" from the one-liner alone.
- `baseline.source` is the registry path. A file that exists but cannot be read
  sets `baseline.error` and **claims nothing**: every parsed failure counts as
  new and no split appears in `summary` (a regression must never hide behind a
  broken file). No file at all means the feature is off and `baseline` is
  `null`.
- The split counts **distinct tests**, not progress lines: a test that fails in
  its body *and* in its `tearDown` prints two `[E]` lines while `counts.failed`
  counts it once (`baseline.tests` vs `baseline.events`). `baseline.failed` is
  that authoritative count and `baseline.unparsed` is the part of it the
  inventory never named; the `summary` suffix appears only when
  `known + new + unparsed == failed`. When the two cannot be reconciled the
  one-liner stays plain on purpose — a summary that contradicts its own first
  number is worse than no hint.
- The registry is read per job from the pinned cwd, so adding an entry needs no
  restart. It lives in the project, so it can be committed and shared.

## Git and pnpm: what it will and will not run

- `flutter` and `dart`: any subcommand, any arguments.
- `pnpm`: the named verbs in section 6 — no `dlx`, no `publish`, no `config`,
  no `store`, and no cwd-retargeting flag. `exec` takes a project script binary.
- the project's own `vite`, `vitest`, `svelte-check`, `svelte-kit`, `tsc`.
- `git`: only `status`, `diff`, `log`, `add`, `commit`, `branch`, `restore` —
  and `branch` refuses `-d/-D/--delete/-m/-M/--move`.
- Nothing else: no `npm`, no `npx`, no raw `node`, no `python`. **No `git push`**
  (the GitHub token must never live in a long-running process — keep using the
  documented inline-token recipe), no
  `reset`/`clean`/`checkout`/`switch`/`stash` in any form. A `checkout` refusal
  names its substitute: `git restore -- <path>`.
- **`restore` is path-scoped on purpose.** It accepts only literal, relative,
  non-wildcard paths — no `.`, no `..`, no `:` pathspec magic, no `*.dart`, no
  absolute path, no `--pathspec-from-file` — plus the flags `--staged`/`-S`,
  `--worktree`/`-W` and `--quiet`/`-q`. So `git restore -- <paths>` is the way to
  undo a formatter's spill-over, and the whole-worktree wipe is out of reach.
  Typical uses:
  - discard worktree edits to named files: `git restore -- lib/a.dart lib/b.dart`
  - also unstage them (index and worktree back to HEAD): `git restore -S -W -- lib/a.dart`
  - unstage only: `git restore --staged -- lib/a.dart`
  Files that are *untracked* cannot be restored — `clean` is deliberately absent,
  so remove them yourself.
- **`commit` needs a message**, either inline (below) or via
  `-m/--message/-F/--file/-C/--reuse-message`. A bare `git commit` is refused
  instead of failing inside git with an editor error.

### Committing with an inline message

Pass `message` on `/run` and never write a message file:

```powershell
$body=@{cmd='git';args=@('commit','--amend');message="slice 2: 中文 subject`n`nbody"}|ConvertTo-Json -Compress
$r = Invoke-RestMethod "http://127.0.0.1:$port/run" -Method Post -Headers $h -Body $body
```

The server folds it into argv as `-m <text>`, which is why the message travels as
UTF-8 through JSON rather than through pwsh's file writing, and why no file ever
exists for a later `git add -A` to sweep into the commit. `message` is accepted
only with `commit`, is refused beside another message flag, and must be a
non-empty string; a non-string is a `400`, the rest are `403`. It is echoed in
the job JSON (the human's status page shows it) and is subject to the ~32 KB
Windows command-line limit.

Arguments always travel as an argv list to `subprocess.Popen` — there is no
shell anywhere. On Windows `flutter`/`dart` are `.bat` wrappers that
CreateProcess cannot execute, so the server launches the SDK's own
`dart.exe` (+ `flutter_tools.snapshot`) directly, which is also what keeps
`cmd.exe` and its parsing rules out of the path; `resolvedArgv` shows what
actually ran. A `dart format` job under a formatter pin launches the pinned
`dart.exe` instead, and no request can retarget that (section 3). Git jobs run
with `GIT_TERMINAL_PROMPT=0`, so nothing can block on
a credential or signing prompt that this process has no terminal to answer.

Jobs run **one at a time per lane**: concurrent Flutter invocations fight
over `build/` (a locked `build/native_assets/windows/sqlite3.dll` has already
broken a run). `POST /run` therefore queues behind whatever is running **on its
own lane**, and the response reports `aheadOf` — how many unfinished jobs are in
front of yours on that lane, counting the one that is currently running. A long
job on the other lane is not counted, because it is not in your way.

## Baseline attribution: "is this failure mine?"

To re-run a test without your uncommitted changes, use only what the bridge
already allows — writes inside the workspace are permitted, so:

1. Copy the dirty files somewhere inside the workspace, e.g.
   `mkdir .baseline-backup` then copy each modified file there.
2. `git restore -- <those paths>` to put the committed versions back.
3. Run the job again through the bridge.
4. Copy your files back from `.baseline-backup` and delete the scratch directory.

For a *different commit* (not just your dirty tree) there is no entry: the
working directory is pinned at boot and `--source`, `stash`, `checkout` and
worktrees are all deliberately absent (see the repository's ADR-0002 for why, and
what would have to change).

## Why a server instead of per-command escalation

- One approval per session instead of one per command.
- Serialization, so parallel toolchain runs cannot corrupt build state.
- Sub-tools, so a multi-step operation that must call the toolchain (an ARB edit
  plus `gen-l10n`) is one request with one structured answer instead of a second
  escalation.
- UTF-8 logs regardless of the console code page (GBK would otherwise mangle
  CJK output, and even crash a print of `flutter --version`, whose version line
  contains `•`).
- Server-side log filtering, so a ten-minute suite's noise does not have to be
  pulled into the agent's context and grepped by hand.
- Process control: a hung `flutter_tester`/`dart` can be killed by id, with its
  whole tree — and a dev server, which is *supposed* to be running, is killed the
  same way without the tree-kill having to work.
- Two lanes, so a `vite dev` that is waiting to be killed cannot starve the builds
  and test runs behind it.

It does **not** make compiles faster: Flutter has no build daemon, so each job
is still a fresh process. The wins are friction, correctness and observability.

## Security model

- Binds `127.0.0.1` only, on an ephemeral port.
- Random 32-char token, constant-time compared; the token is never written to a
  file by the bridge. It does exist outside server memory in two places: the
  harness's job output (which is how the agent reads it) and, when auto-open
  works, the default browser's address bar and history — the same machine and the
  same user who already reads the job output, and the page needs the token to
  poll `/jobs` at all.
- **The command surface is a guardrail, not a sandbox.** `dart` takes any
  subcommand, so `dart run <file>.dart` executes arbitrary code with the access
  granted at boot; nothing here confines a determined caller. What the narrow
  surface buys is *recovery cost and surprise* for a fallible one: every refused
  command is one nobody can lose work to. Refusals are therefore argued as "this
  can destroy unnamed work", not as "this escalates privilege".
- `pnpm install` runs the project's dependency build scripts and `pnpm run` runs
  whatever a `package.json` says, with that same access — the Node surface widens
  *what a legitimate build does*, not what is reachable. `pnpm exec` is the case
  where that reasoning would break, which is why it is narrowed to a project
  script binary rather than trusted: measured, it also runs things on `PATH`.
- The real trust decision is the boot approval: the process holds that access for
  its lifetime, which is why the escalation is requested once, explicitly, and
  why the human gets the status page at boot.

## Troubleshooting

- **Connection refused** → the server exited (or was never started). Read the
  job output; restart it.
- **No browser tab appeared** → look for `TOOLHUB OPEN`: `no-browser-answered`
  means there is no usable default browser (headless box, or `BROWSER` pointing
  at a console browser), `reason=...` carries the exception. The server is
  unaffected — use the `TOOLHUB STATUS` URL, or pass `--no-open` if you did not
  want the tab.
- **Every restart opens another tab** → expected: the port and token are
  per-process, so a new tab is a new live view and the older ones go stale. Do
  not "fix" it by disabling auto-open; tell the human which tab is current.
- **`401 missing or bad token`** → wrong/missing token, or the peer was
  unpaired. Re-read the `TOOLHUB TOKEN` line.
- **My call timed out but the job kept going** → expected, and recoverable: the
  job is not killed. Fetch `GET /jobs/<id>?tail=N&grep=P`. Next time budget the
  nested timeouts as in section 4, or use `wait:false`.
- **`grep is not a valid regex`** → the pattern is a Python regex; escape it
  (`\[E\]`, not `[E]`).
- **CI fails `--set-exit-if-changed` on files that `dart format` locally leaves
  alone** → the local dart is newer than the one CI formats with. Start the
  bridge with `--dart-format <the SDK CI pins>` (section 3) and re-check;
  `GET /health` says whether the running bridge has a pin, and the job's
  `resolvedArgv` shows which dart actually ran.
- **`403 scope is not supported for ...`** → only `dart format` takes a scope as
  trailing paths, and only `dart`/`flutter` `analyze` and `fix` take it as an
  output filter. `git`, `dart test` and the rest cannot be scoped.
- **`400 no uncommitted .dart files to scope this command to`** → nothing in the
  working tree is an uncommitted Dart file. Deliberate: running `dart format`
  with no paths would rewrite the whole tree, so an empty scope is refused
  rather than silently widened.
- **`400 git status failed ...` / `git status timed out`** → the pinned cwd is
  not a git repository (or git is not on PATH). The uncommitted scope needs one;
  drop `scope` to run the command anyway.
- **`400 pass either grep or scope, not both`** → both narrow the returned log
  lines; combine them yourself or pick one.
- **`404 no such tool: arb-edit`** → the deployed bridge predates the sub-tool.
  Check `GET /health` for `tools`, then redeploy: `python scripts/sync_to_skills.py`.
- **`400 'cwd' is not accepted`** → the bridge pins the working directory at boot
  (ADR-0002). Drop the field, or start a bridge with `--cwd <project>`.
- **arb-edit job failed with `PLAN FAILED`** → nothing was written. The message
  names the file and the key: an anchor is missing from that file, or its
  `deleteFrom`/`deleteTo` is not there. Run the same body with `dryRun` after
  fixing it.
- **arb-edit job failed with `genL10n.exitCode != 0`** → the edits *were*
  written; read `$r.tail`, fix the ARB, re-post.
- **`git commit needs a message`** → pass the inline `message` field, or one of
  `-m/--message/-F/--file/-C/--reuse-message`. A bare `git commit` has no editor
  to open.
- **`git restore` refused** → the pathspec is not a literal relative path (`.`,
  `..`, a glob, an absolute path, `:` magic), or the flag is not one of
  `--staged/--worktree/--quiet`. Pass explicit file paths after `--`.
- **`failures` is empty but the run failed** → the reporter printed no `[E]`
  lines (e.g. `-r json`/`-r silent`), or the log was truncated. Read `counts`
  and the tail.
- **`baseline.error` is set and no split appears in `summary`** → the registry
  file exists but is malformed: bad JSON, an entry with neither or both of
  `name`/`match`, an unknown `kind`/`platform`, or an invalid regex. The message
  names the entry (`entries[3] ...`). Until it is fixed, every failure counts as
  new.
- **The registry never seems to match** → check `platform` (a `windows` entry is
  ignored elsewhere), `file` (a relative path inside the project), and whether a
  `name` is the *full* test name as the reporter prints it (`failures[i].name`
  shows it verbatim — copy from there, or use `match`).
- **Job stuck in `queued`** → something ahead of it is still running **on the
  same lane**; check `GET /jobs` and kill it if it is a hang. A job waiting behind
  a `long` job (a dev server) is normal and will not start until that one is
  killed.
- **`403 pnpm flag not allowed: '-C'`** (or `--prefix`, `-g`, `-w`) → the flag
  would run outside the pinned cwd, which no request can change (ADR-0002). Start
  a bridge with the right `--cwd`, or drop the flag.
- **`403 pnpm exec target not allowed: 'node'`** → `pnpm exec` runs anything it
  finds on `PATH`, so only the project's own script binaries are accepted. Run a
  package script with `pnpm run <script>` instead.
- **`node is not on PATH`** → the bridge needs `node` to launch a script binary;
  install Node or put it on `PATH` for the process that starts the bridge.
- **`vite is not installed in <cwd>: ... is missing`** → the pinned cwd has no
  `node_modules/<pkg>`. Run `pnpm install` first, or check that the bridge was
  started with the project's own directory.
- **`vite`/`vitest` fails with `spawn EPERM`** → the sandbox, not the project. It
  denies the *named pipes* libuv needs for child stdio, which is what Vite's
  Windows `net use` probe and vitest's default forks pool use. Two traps:
  - Running it in the confined session instead of through the bridge: use the
    bridge, and for vitest add `--pool=threads`.
  - **Running it through a bridge that was itself started confined.** A bridge
    booted under `workspace-write` (typically because `--selfcheck` was skipped)
    gives *its own* children file stdio, so `pnpm install`, `svelte-check` and
    `tsc` work — but Vite's probe runs inside the vite process, where the sandbox
    still applies. Measured: confined bridge → `vite build` exit 1 with
    `spawn EPERM`; elevated bridge → exit 0 and `dist/` written. So start the
    bridge normally and let its self-check fail, then retry it elevated.
  - Vite 7 and earlier cannot be rescued even outside the bridge (esbuild must
    spawn a binary); see the repository's `docs/vite-vitest-sandbox-findings.md`.
- **`--watch-parent` prints "parent pid already gone at boot"** → the watchdog
  disabled itself (it never kills a server whose parent it cannot see). The
  server still works; stop it with `POST /stop`.
- **stdin-based watch does not exist on purpose**: a DSH background job's stdin
  is already closed at spawn, so an EOF check would kill the server instantly.
  That is why the watchdog polls the parent pid instead.
- **`flutter` fails with `...\bin\bin\cache\lockfile`** → `FLUTTER_ROOT` was set
  to the `bin` directory instead of its parent; flutter_tools appends
  `bin/cache` itself.
- **Leftover `.tmp` peer files** in a repo's sync dir are harmless: readers
  ignore anything not ending in `.json`.
- **Confined (`workspace-write`) `--no-selfcheck` boot dies with
  `PermissionError: ...\Temp\dsh-*\toolhub-*\...log`** → the default job-log
  directory is `tempfile.mkdtemp()`, which the sandbox denies. That is a
  property of running it unelevated, not of the toolchain, and it is why the
  real start is the elevated one. To smoke-test the HTTP surface inside the
  sandbox, pass `--log-dir` pointing into the workspace.
- **Smoke-testing the git surface confined works** against a scratch repository
  inside the workspace (`git init`, then drive `/run`): the workspace's own
  `.git` is inside the sandbox's writable area, so commits and `restore`
  succeed while `git push` and the destructive verbs are still refused. Cleaning
  that scratch repository up afterwards needs git's read-only loose objects made
  writable first (`os.chmod(path, stat.S_IWRITE)` before unlinking); a plain
  `rmtree` fails with `PermissionError: [WinError 5]`.

## Non-goals (deliberate)

`git push`, git history rewriting (`reset --hard`, `rebase`), whole-worktree
wipes (`clean`, `git restore .`), `stash`, `checkout`/`switch`, per-job `cwd`
and worktree-per-baseline entries, detached/persistent mode across sessions,
arbitrary command execution *by name* (the bridge is not a privilege boundary —
see the security model), `pnpm dlx`/`publish`/`config`/`store`, `pnpm exec` for
anything but a project script binary, a per-request formatter or SDK override (the
pin is boot-scoped, like the cwd) and a scope for any command but `dart format`, `dart
analyze`/`fix` and `flutter analyze`/`fix`, copying build caches between
worktrees (CMake/ninja
state is path-keyed, so copying forces a full reconfigure while the genuinely
expensive caches — pub cache, SDK artifacts — are already machine-global), and a
queue-aware early return from `/run` (`wait:false` already expresses it, and
returning `queued` whenever the queue is non-empty would force polling for the
common case).

## Deploying changes to this skill

Edit the repository, then:

```powershell
python scripts\sync_to_skills.py
```

Run it from the repository and expect one `danger-full-access` escalation: it
writes `~\.dsh\skills\tool-bridge`, which `workspace-write` denies. It copies
`SKILL.md` and `scripts/`, excludes `CONTEXT.md`/`docs/`/`tests/`, and prunes
anything in the deployed directory that the repository no longer has — including
a previously deployed `README.md`, which is no longer part of the skill.

</supporting-info>

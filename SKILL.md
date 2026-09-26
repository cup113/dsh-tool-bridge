---
name: tool-bridge
description: Use in a sandboxed DSH session whenever a Flutter/Dart toolchain command (pub get, format, analyze, test, build) or a git write (add, commit) is needed. Starts one elevated, loopback-only server per session so the confined agent can run the toolchain over HTTP instead of paying a one-shot danger-full-access escalation per command.
---

<what-to-do>

Source of truth: `D:\Projects\dsh-tool-bridge` (a git repository). DSH discovers
and loads the deployed copy at `~\.dsh\skills\tool-bridge`, so below `<skill>`
means that deployed directory. Edit the repository, then deploy with
`python scripts/sync_to_skills.py` — it copies everything except `.git`.

Use this whenever a toolchain command would otherwise need a one-shot
`danger-full-access` escalation. In the DSH file sandbox (`workspace-write`),
Flutter/Dart tooling cannot run at all (it fails writing the SDK lockfile, or
hangs), and every git write is denied because the git dir lives outside the
workspace. This server is started **once** per session with that escalation and
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
TOOLHUB TOKEN 2SV0dcqLovVR4FSntAjkau_cy7OdGE5b
TOOLHUB STATUS http://127.0.0.1:60549/?token=2SV0dcqLovVR4FSntAjkau_cy7OdGE5b
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
$r.tail      # last 200 log lines, UTF-8
```

**Two PowerShell traps in these helpers**, both of which produce a misleading
`{"error":"not found"}`-style answer rather than an error:

- **Never name a parameter `$args`** — it is a reserved automatic variable, and
  the argument list silently arrives empty.
- **Never interpolate a variable directly before `?`** — `".../jobs/$id?tail=5"`
  is parsed as a variable named `id?tail`, mangling the URL into a 404. Use a
  subexpression: `".../jobs/$($id)?tail=5"`.

## 3. Stop it

`POST /stop` when work is done (`Invoke-RestMethod ".../stop" -Method Post
-Headers $h`). If it is left running, the parent watchdog ends it when the
session does; a stale server is never a correctness problem because the next
session binds a new random port.

</what-to-do>

<supporting-info>

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness; no token |
| GET | `/?token=…` | human status page: job list + live log tail (browser-friendly; opened automatically at boot) |
| POST | `/run` | `{"cmd","args","wait","timeoutSec"}` → job; `wait:true` blocks until done |
| GET | `/jobs` | all jobs, newest last |
| GET | `/jobs/<id>?tail=N` | one job + last N log lines (default 200) |
| GET | `/jobs/<id>/log` | full raw log (UTF-8) |
| POST | `/jobs/<id>/kill` | kill that job's process tree |
| POST | `/stop` | kill children and exit |

All but `/health` require `Authorization: Bearer <token>` (the status page may
pass `?token=` instead, since a browser cannot set headers).

Job JSON: `id, argv, resolvedArgv, status (queued|running|done|failed|killed),
exitCode, startedAt, finishedAt, durationSec, summary, error, logPath, tail`.

`summary` is parsed for `flutter test` (`33 passed`, `32 passed, 1 failed`) —
the quick answer that a ten-minute suite otherwise buries in the tail.

## What it will and will not run

- `flutter` and `dart`: any subcommand, any arguments.
- `git`: only `status`, `diff`, `log`, `add`, `commit`, `branch` — and
  `branch` refuses `-d/-D/--delete/-m/-M/--move`.
- Nothing else. **No `git push`** (the GitHub token must never live in a
  long-running process — keep using the documented inline-token recipe), no
  `reset`/`clean`/`checkout`/`restore`, no arbitrary executables.

Arguments always travel as an argv list to `subprocess.Popen` — there is no
shell anywhere. On Windows `flutter`/`dart` are `.bat` wrappers that
CreateProcess cannot execute, so the server launches the SDK's own
`dart.exe` (+ `flutter_tools.snapshot`) directly, which is also what keeps
`cmd.exe` and its parsing rules out of the path; `resolvedArgv` shows what
actually ran.

Jobs run **one at a time** on purpose: concurrent Flutter invocations fight
over `build/` (a locked `build/native_assets/windows/sqlite3.dll` has already
broken a run). `POST /run` therefore queues behind whatever is running, and the
response reports `aheadOf` — how many unfinished jobs are in front of yours,
counting the one that is currently running.

## Why a server instead of per-command escalation

- One approval per session instead of one per command.
- Serialization, so parallel toolchain runs cannot corrupt build state.
- UTF-8 logs regardless of the console code page (GBK would otherwise mangle
  CJK output, and even crash a print of `flutter --version`, whose version line
  contains `•`).
- Process control: a hung `flutter_tester`/`dart` can be killed by id, with its
  whole tree.

It does **not** make compiles faster: Flutter has no build daemon, so each job
is still a fresh process. The wins are friction, correctness and observability.

## Security model

- Binds `127.0.0.1` only, on an ephemeral port.
- Random 32-char token, constant-time compared; the token exists only in the
  harness's job output and server memory.
- Auto-open is the one place the token leaves memory on purpose: it lands in the
  default browser's address bar and history. That is the same machine and the
  same user who already reads the job output, and the page needs the token to
  poll `/jobs` at all.
- Command allowlist (above) enforced in Python, argv-list execution, `cwd`
  pinned at startup.
- The process itself runs with full access for its lifetime — that trust is the
  one-time approval, which is why the command surface stays narrow.

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
- **Job stuck in `queued`** → something ahead of it is still running; check
  `GET /jobs` and kill it if it is a hang.
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

## Non-goals (deliberate)

Detached/persistent mode across sessions, git push, destructive git, arbitrary
command execution, copying build caches between worktrees (CMake/ninja state is
path-keyed, so copying forces a full reconfigure while the genuinely expensive
caches — pub cache, SDK artifacts — are already machine-global), and switching
`cwd` away from the directory it was started in.

</supporting-info>

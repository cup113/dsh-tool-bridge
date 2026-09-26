#!/usr/bin/env python3
"""tool-bridge: a session-scoped, loopback-only toolchain server.

Why this exists
---------------
Inside the DSH file sandbox (``workspace-write``), Flutter/Dart tooling hangs and
git writes are denied, so every command costs a one-shot ``danger-full-access``
escalation. This server is started **once** per session with that escalation and
then executes the toolchain on the agent's behalf, answering over HTTP on a
random loopback port. The agent's HTTP calls run in the confined sandbox and cost
nothing.

What it is not
--------------
It is not a shell. Only ``flutter``/``dart`` (any subcommand) and a small,
non-destructive ``git`` verb set are accepted, always as an argv list (never a
shell string), always in the working directory pinned at startup. ``git push``
is deliberately absent: the GitHub token must never live in a long-running
process.

Lifecycle
---------
Session-scoped by design: the agent starts it with ``run_in_background`` and it
dies with the session. ``--watch-parent`` (opt-in) polls the process that
started it and, when that disappears, kills its children and exits — so a killed
job cannot leave an orphaned ``flutter``/``dart`` writing into ``build/``.
(``--watch-parent`` exists because stdin is useless here: a DSH background job's
stdin is already closed at spawn, so an EOF check exits instantly.)

Boot self-check
---------------
With the default ``--selfcheck``, the server runs ``flutter --version`` before
binding. Under the sandbox that hangs, and the server exits non-zero printing
``SELFTEST FAILED`` — which is the *grounded* reason to retry the same start
command with wider permissions (escalation must never be speculative). Elevated,
the self-check passes and the ``READY`` line follows.

API (all but /health need ``Authorization: Bearer <token>``)
-----------------------------------------------------------
- ``GET  /health``                -> {"ok": true}
- ``GET  /``                      -> human status page (token in the query string)
- ``POST /run``                   -> {"cmd","args","wait","timeoutSec"} -> job
- ``GET  /jobs``                  -> [job]
- ``GET  /jobs/<id>?tail=N``      -> job + last N log lines
- ``GET  /jobs/<id>/log``         -> raw log text (whole file; use ?tail= to trim)
- ``POST /jobs/<id>/kill``        -> kill the process tree
- ``POST /stop``                  -> kill children and exit
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

IS_WINDOWS = os.name == "nt"
CREATE_NO_WINDOW = 0x08000000 if IS_WINDOWS else 0

# How much of a job's log is scanned for a tail, and the default tail length.
TAIL_SCAN_BYTES = 256 * 1024
DEFAULT_TAIL_LINES = 200

ALLOWED_EXES = {"flutter", "dart", "git"}

# git verbs this server will run. Everything else (reset, checkout, clean,
# restore, push, config, rebase, ...) is refused by omission.
GIT_VERBS = {"status", "diff", "log", "add", "commit", "branch"}

# Per-verb flags that turn a safe verb destructive.
GIT_BLOCKED_FLAGS = {
    "branch": {"-d", "-D", "--delete", "-m", "-M", "--move"},
    "commit": set(),
    "add": set(),
    "status": set(),
    "diff": set(),
    "log": set(),
}


def eprint(*parts: object) -> None:
    """Lifecycle lines on stdout (the harness reads them), errors on stderr.

    Written as UTF-8 *bytes* on purpose: the console code page here is GBK, and
    the toolchain prints characters it cannot encode (flutter's version line
    carries U+2022), which would otherwise kill the boot with
    UnicodeEncodeError — the exact class of problem this server exists to
    remove.
    """
    text = " ".join(str(part) for part in parts)
    stream = sys.stderr if text.startswith("ERROR") else sys.stdout
    data = (text + "\n").encode("utf-8", errors="replace")
    buffer = getattr(stream, "buffer", None)
    if buffer is None:
        stream.write(text + "\n")
        stream.flush()
        return
    buffer.write(data)
    buffer.flush()


class Job:
    """One queued/running/finished command."""

    def __init__(self, argv: list[str], cwd: str, log_path: str) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.argv = argv
        self.cwd = cwd
        self.log_path = log_path
        self.status = "queued"  # queued|running|done|failed|killed
        self.exit_code: int | None = None
        self.resolved: list[str] | None = None
        self.started_at: float | None = None
        self.finished_at: float | None = None
        self.error: str | None = None
        self.summary: str | None = None
        self._process: subprocess.Popen[bytes] | None = None
        self._lock = threading.Lock()

    def set_process(self, process: subprocess.Popen[bytes]) -> None:
        with self._lock:
            self._process = process

    def process(self) -> subprocess.Popen[bytes] | None:
        with self._lock:
            return self._process

    def kill(self) -> bool:
        """Kills the process tree. Returns whether a kill was issued.

        The status is set to `killed` *before* taskkill runs: the worker's
        `process.wait()` returns as soon as the process dies and would otherwise
        classify the job from the kill's own exit code.
        """
        with self._lock:
            if self.status not in ("queued", "running"):
                return False
            self.status = "killed"
        process = self.process()
        if process is None or process.poll() is not None:
            return False
        try:
            if IS_WINDOWS:
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(process.pid)],
                    capture_output=True,
                    creationflags=CREATE_NO_WINDOW,
                    check=False,
                )
            else:
                process.kill()
        except Exception as error:  # noqa: BLE001 - kill must never raise
            eprint(f"ERROR kill failed for {self.id}: {error}")
        return True

    def to_json(self, tail_lines: int | None = None) -> dict[str, object]:
        payload: dict[str, object] = {
            "id": self.id,
            "argv": self.argv,
            "resolvedArgv": self.resolved,
            "status": self.status,
            "exitCode": self.exit_code,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "durationSec": (
                None
                if self.started_at is None
                else round((self.finished_at or time.time()) - self.started_at, 2)
            ),
            "summary": self.summary,
            "error": self.error,
            "logPath": self.log_path,
        }
        if tail_lines is not None:
            payload["tail"] = read_tail(self.log_path, tail_lines)
        return payload


def read_tail(path: str, lines: int) -> str:
    """Last ``lines`` lines of a log file, read from the end (bounded memory)."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return ""
    with open(path, "rb") as handle:
        handle.seek(max(0, size - TAIL_SCAN_BYTES))
        data = handle.read()
    text = data.decode("utf-8", errors="replace")
    split = text.splitlines()
    if size > TAIL_SCAN_BYTES and len(split) > 1:
        # The first line may be a fragment of a longer one that was cut off.
        split = split[1:]
    return "\n".join(split[-lines:])


def parse_summary(argv: list[str], log_path: str) -> str | None:
    """A one-line digest for `flutter test`, else None.

    The raw exit code says pass/fail; this says *how much* passed, which is what
    a reader actually wants from a ten-minute suite.
    """
    if len(argv) < 2 or os.path.basename(argv[0]).split(".")[0] != "flutter":
        return None
    if argv[1] != "test":
        return None
    text = read_tail(log_path, 400)
    if "All tests passed!" in text:
        match = re.findall(r"\+(\d+)(?:\s+~\d+)?(?:\s+-(\d+))?:", text)
        if match:
            passed, failed = match[-1]
            return f"{passed} passed" + (f", {failed} failed" if failed else "")
        return "all tests passed"
    match = re.findall(r"\+(\d+)(?:\s+~\d+)?\s+-(\d+):", text)
    if match:
        passed, failed = match[-1]
        return f"{passed} passed, {failed} failed"
    return "see log"


class ToolHub:
    """Queue, worker thread and job registry."""

    def __init__(self, cwd: str, log_dir: str) -> None:
        self.cwd = cwd
        self.log_dir = log_dir
        self.jobs: dict[str, Job] = {}
        self.order: list[str] = []
        self._queue: queue.Queue[Job] = queue.Queue()
        self._lock = threading.Lock()
        self._current: Job | None = None
        self._stopping = threading.Event()
        self._worker = threading.Thread(target=self._work, daemon=True)
        self._worker.start()

    # ---- submission ----

    def submit(self, cmd: str, args: list[str]) -> Job:
        argv = [cmd, *args]
        validate(argv)
        with self._lock:
            job = Job(argv, self.cwd, os.path.join(self.log_dir, "pending.log"))
            job.log_path = os.path.join(self.log_dir, f"{job.id}.log")
            # index order: newest last
            self.jobs[job.id] = job
            self.order.append(job.id)
        open(job.log_path, "wb").close()
        self._queue.put(job)
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self.jobs.get(job_id)

    def list_jobs(self) -> list[Job]:
        with self._lock:
            return [self.jobs[job_id] for job_id in self.order]

    def current(self) -> Job | None:
        return self._current

    def ahead_of(self, job_id: str) -> int:
        """How many unfinished jobs sit ahead of this one.

        Counts the running job too, not just queued ones: jobs are serialized,
        so "the thing blocking me" is usually the one already running, and
        reporting 0 there reads as "nothing in the way".
        """
        with self._lock:
            ordered = [self.jobs[entry] for entry in self.order]
        pending = 0
        for candidate in ordered:
            if candidate.id == job_id:
                break
            if candidate.status in ("queued", "running"):
                pending += 1
        return pending

    # ---- execution ----

    def _work(self) -> None:
        while not self._stopping.is_set():
            try:
                job = self._queue.get(timeout=0.2)
            except queue.Empty:
                continue
            if self._stopping.is_set():
                return
            self._run(job)

    def _run(self, job: Job) -> None:
        self._current = job
        job.status = "running"
        job.started_at = time.time()
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        try:
            launch, extra_env = resolve_launch(job.argv)
        except FileNotFoundError as error:
            job.status = "failed"
            job.exit_code = 127
            job.error = str(error)
            with open(job.log_path, "ab") as sink:
                sink.write((job.error + "\n").encode("utf-8"))
            job.finished_at = time.time()
            self._current = None
            return
        job.resolved = launch
        env.update(extra_env)
        try:
            # One job at a time on purpose: concurrent flutter invocations fight
            # over build/ (we have seen a locked sqlite3.dll break a run).
            with open(job.log_path, "wb") as sink:
                process = subprocess.Popen(  # noqa: S603 - argv list, no shell
                    launch,
                    cwd=job.cwd,
                    stdout=sink,
                    stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL,
                    env=env,
                    creationflags=CREATE_NO_WINDOW,
                )
                job.set_process(process)
                exit_code = process.wait()
            job.exit_code = exit_code
            if job.status != "killed":
                job.status = "done" if exit_code == 0 else "failed"
            job.summary = parse_summary(job.argv, job.log_path)
        except FileNotFoundError:
            job.status = "failed"
            job.exit_code = 127
            job.error = f"executable not found: {job.argv[0]}"
            with open(job.log_path, "ab") as sink:
                sink.write((job.error + "\n").encode("utf-8"))
        except Exception as error:  # noqa: BLE001 - a job error must not kill the worker
            job.status = "failed"
            job.exit_code = 1
            job.error = str(error)
        finally:
            job.finished_at = time.time()
            self._current = None

    # ---- shutdown ----

    def stop(self) -> None:
        self._stopping.set()
        current = self._current
        if current is not None:
            current.kill()
        for job in self.list_jobs():
            if job.status in ("queued", "running"):
                job.kill()
                if job.status == "queued":
                    job.status = "killed"


def resolve_launch(argv: list[str]) -> tuple[list[str], dict[str, str]]:
    """Turns an allowlisted command into a real executable invocation.

    On Windows `flutter` and `dart` are `.bat` wrappers, which CreateProcess
    cannot execute and which would drag `cmd.exe` — and its parsing rules — into
    the middle of an argv that is supposed to have no shell. Both wrappers only
    launch the SDK's own `dart.exe` (with the flutter_tools snapshot for
    `flutter`), so that is what we call directly.

    Returns the argv to launch plus environment additions.
    """
    exe = shutil.which(argv[0])
    if exe is None:
        raise FileNotFoundError(f"executable not found on PATH: {argv[0]}")
    if IS_WINDOWS and exe.lower().endswith((".bat", ".cmd")):
        # exe is `<FLUTTER_ROOT>/bin/flutter.bat` (or dart.bat); the SDK cache
        # hangs off the same `bin`, while FLUTTER_ROOT is its parent —
        # flutter_tools appends `bin/cache` to FLUTTER_ROOT itself.
        flutter_bin = os.path.dirname(exe)
        flutter_root = os.path.dirname(flutter_bin)
        dart_exe = os.path.join(
            flutter_bin, "cache", "dart-sdk", "bin", "dart.exe"
        )
        if not os.path.exists(dart_exe):
            raise FileNotFoundError(
                f"{exe} is a wrapper but its SDK dart.exe is missing: {dart_exe}"
            )
        if os.path.basename(exe).lower().startswith("flutter"):
            snapshot = os.path.join(
                flutter_bin, "cache", "flutter_tools.snapshot"
            )
            if not os.path.exists(snapshot):
                raise FileNotFoundError(
                    f"flutter_tools.snapshot missing: {snapshot}"
                )
            return (
                [dart_exe, snapshot, *argv[1:]],
                {"FLUTTER_ROOT": flutter_root},
            )
        return ([dart_exe, *argv[1:]], {"FLUTTER_ROOT": flutter_root})
    return ([exe, *argv[1:]], {})


def validate(argv: list[str]) -> None:
    """Refuses anything outside the documented surface. Raises ValueError."""
    exe = os.path.basename(argv[0]).lower()
    if exe.endswith(".bat") or exe.endswith(".exe") or exe.endswith(".cmd"):
        exe = exe.rsplit(".", 1)[0]
    if exe not in ALLOWED_EXES:
        raise ValueError(
            f"command not allowed: {argv[0]!r} (allowed: {sorted(ALLOWED_EXES)})"
        )
    if exe == "git":
        args = argv[1:]
        if not args:
            raise ValueError("git needs a verb")
        verb = args[0]
        if verb.startswith("-"):
            # `git --version` and friends carry no repository risk, but keep the
            # surface honest: only the documented verbs.
            raise ValueError(f"git verb not allowed: {verb!r}")
        if verb not in GIT_VERBS:
            raise ValueError(
                f"git verb not allowed: {verb!r} (allowed: {sorted(GIT_VERBS)})"
            )
        blocked = GIT_BLOCKED_FLAGS.get(verb, set())
        for arg in args[1:]:
            if arg in blocked:
                raise ValueError(f"git {verb} flag not allowed: {arg!r}")


def make_handler(hub: ToolHub, token: str, status_url: str):
    class Handler(BaseHTTPRequestHandler):
        server_version = "toolhub/1.0"
        protocol_version = "HTTP/1.1"

        # ---- plumbing ----

        def log_message(self, fmt: str, *args: object) -> None:
            # The harness reads stdout for lifecycle lines only; per-request
            # noise would drown them.
            return

        def _send(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, status: int, payload: object) -> None:
            self._send(
                status,
                json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                "application/json; charset=utf-8",
            )

        def _error(self, status: int, message: str) -> None:
            self._json(status, {"error": message})

        def _authorized(self) -> bool:
            header = self.headers.get("Authorization", "")
            if header.startswith("Bearer "):
                return secrets.compare_digest(header[7:], token)
            # The status page runs in a browser, which cannot set headers.
            query = self.path.split("?", 1)[1] if "?" in self.path else ""
            for part in query.split("&"):
                if part.startswith("token="):
                    return secrets.compare_digest(part[6:], token)
            return False

        def _body(self) -> dict[str, object]:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                return {}
            raw = self.rfile.read(length)
            try:
                parsed = json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError as error:
                raise ValueError(f"bad json: {error}") from error
            if not isinstance(parsed, dict):
                raise ValueError("body must be a JSON object")
            return parsed

        # ---- routes ----

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            path = self.path.split("?", 1)[0]
            if path == "/health":
                self._json(200, {"ok": True})
                return
            if path == "/":
                if not self._authorized():
                    self._error(401, "missing or bad token")
                    return
                self._send(
                    200,
                    status_page(token).encode("utf-8"),
                    "text/html; charset=utf-8",
                )
                return
            if not self._authorized():
                self._error(401, "missing or bad token")
                return
            if path == "/jobs":
                self._json(
                    200,
                    [job.to_json() for job in hub.list_jobs()],
                )
                return
            match = re.fullmatch(r"/jobs/([0-9a-f]+)", path)
            if match:
                job = hub.get(match.group(1))
                if job is None:
                    self._error(404, "no such job")
                    return
                tail = DEFAULT_TAIL_LINES
                query = self.path.split("?", 1)[1] if "?" in self.path else ""
                for part in query.split("&"):
                    if part.startswith("tail="):
                        try:
                            tail = max(0, min(5000, int(part[5:])))
                        except ValueError:
                            pass
                self._json(200, job.to_json(tail_lines=tail))
                return
            match = re.fullmatch(r"/jobs/([0-9a-f]+)/log", path)
            if match:
                job = hub.get(match.group(1))
                if job is None:
                    self._error(404, "no such job")
                    return
                try:
                    with open(job.log_path, "rb") as handle:
                        data = handle.read()
                except OSError:
                    data = b""
                self._send(200, data, "text/plain; charset=utf-8")
                return
            self._error(404, "not found")

        def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            path = self.path.split("?", 1)[0]
            if not self._authorized():
                self._error(401, "missing or bad token")
                return
            if path == "/run":
                try:
                    body = self._body()
                except ValueError as error:
                    self._error(400, str(error))
                    return
                cmd = body.get("cmd")
                args = body.get("args", [])
                if not isinstance(cmd, str) or not cmd:
                    self._error(400, "cmd must be a non-empty string")
                    return
                if not isinstance(args, list) or any(
                    not isinstance(item, str) for item in args
                ):
                    self._error(400, "args must be a list of strings")
                    return
                try:
                    job = hub.submit(cmd, list(args))
                except ValueError as error:
                    self._error(403, str(error))
                    return
                if body.get("wait"):
                    timeout = body.get("timeoutSec")
                    deadline = (
                        time.time() + float(timeout)
                        if isinstance(timeout, (int, float)) and timeout
                        else None
                    )
                    while job.status in ("queued", "running"):
                        if deadline is not None and time.time() > deadline:
                            break
                        time.sleep(0.2)
                self._json(
                    200,
                    {
                        **job.to_json(tail_lines=DEFAULT_TAIL_LINES),
                        "aheadOf": hub.ahead_of(job.id),
                    },
                )
                return
            match = re.fullmatch(r"/jobs/([0-9a-f]+)/kill", path)
            if match:
                job = hub.get(match.group(1))
                if job is None:
                    self._error(404, "no such job")
                    return
                killed = job.kill()
                self._json(200, {"killed": killed, "job": job.to_json()})
                return
            if path == "/stop":
                self._json(200, {"stopping": True})
                threading.Thread(target=stop_soon, daemon=True).start()
                return
            self._error(404, "not found")

    return Handler


def stop_soon() -> None:
    time.sleep(0.2)
    # os._exit, not SystemExit: raising in a handler thread would only end that
    # thread and leave the server running.
    os._exit(0)


def status_page(token: str) -> str:
    """Self-contained page: job list plus the running job's live log tail."""
    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>tool-bridge</title>
<style>
 body {{ font: 13px/1.5 ui-monospace, Consolas, monospace; margin: 0;
        background: #14161a; color: #d6dae0; }}
 header {{ padding: 10px 14px; background: #1c2028; border-bottom: 1px solid #2a2f38;
           display: flex; gap: 12px; align-items: baseline; }}
 h1 {{ font-size: 14px; margin: 0; }}
 .muted {{ color: #7d8794; }}
 table {{ border-collapse: collapse; width: 100%; }}
 td, th {{ padding: 5px 10px; text-align: left; border-bottom: 1px solid #23272f;
           white-space: nowrap; }}
 th {{ color: #7d8794; font-weight: 600; }}
 tr.running {{ background: #1b2733; }}
 tr.failed td:first-child, tr.killed td:first-child {{ color: #ff8f8f; }}
 tr.done td:first-child {{ color: #8fd18f; }}
 pre {{ margin: 0; padding: 12px 14px; height: 45vh; overflow: auto;
        background: #0f1115; border-top: 1px solid #2a2f38; }}
 .wrap {{ padding: 0; }}
</style></head>
<body>
<header><h1>tool-bridge</h1>
  <span class="muted" id="cwd"></span>
  <span class="muted" id="state"></span></header>
<div class="wrap"><table><thead><tr>
  <th>status</th><th>exit</th><th>time</th><th>command</th><th>summary</th>
</tr></thead><tbody id="rows"></tbody></table></div>
<pre id="log">waiting for output...</pre>
<script>
const TOKEN = {json.dumps(token)};
const auth = {{ headers: {{ 'Authorization': 'Bearer ' + TOKEN }} }};
let selected = null;
async function tick() {{
  try {{
    const jobs = await (await fetch('/jobs', auth)).json();
    if (!jobs.length) {{ document.getElementById('state').textContent = 'idle'; }}
    const rows = jobs.slice(-40).reverse().map(j => {{
      const secs = j.durationSec == null ? '-' : j.durationSec + 's';
      return `<tr class="${{j.status}}" data-id="${{j.id}}">
        <td>${{j.status}}</td><td>${{j.exitCode ?? ''}}</td><td>${{secs}}</td>
        <td>${{j.argv.map(a => a.replace(/</g,'&lt;')).join(' ')}}</td>
        <td class="muted">${{j.summary ?? ''}}</td></tr>`;
    }}).join('');
    document.getElementById('rows').innerHTML = rows;
    const running = jobs.find(j => j.status === 'running');
    if (running) {{ selected = running.id; document.getElementById('state').textContent = 'running'; }}
    if (!selected && jobs.length) selected = jobs[jobs.length - 1].id;
    if (selected) {{
      const job = await (await fetch('/jobs/' + selected + '?tail=400', auth)).json();
      document.getElementById('log').textContent = job.tail || '(no output yet)';
      const box = document.getElementById('log');
      if (box.dataset.autoscroll !== '0') box.scrollTop = box.scrollHeight;
    }}
  }} catch (e) {{
    document.getElementById('state').textContent = 'server unreachable';
  }}
}}
document.getElementById('log').addEventListener('scroll', (e) => {{
  const box = e.target;
  box.dataset.autoscroll = (box.scrollHeight - box.scrollTop - box.clientHeight < 40) ? '1' : '0';
}});
tick(); setInterval(tick, 1500);
</script></body></html>
"""


def selfcheck(timeout: float) -> bool:
    """Runs `flutter --version` so a sandboxed boot fails *visibly*."""
    eprint(f"TOOLHUB SELFTEST start cmd='flutter --version' timeout={timeout:g}s")
    started = time.time()
    try:
        launch, extra_env = resolve_launch(["flutter", "--version"])
    except FileNotFoundError as error:
        eprint(f"TOOLHUB SELFTEST FAILED reason=not-found detail={error}")
        return False
    env = dict(os.environ)
    env.update(extra_env)
    try:
        completed = subprocess.run(  # noqa: S603 - argv list, no shell
            launch,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            env=env,
            creationflags=CREATE_NO_WINDOW,
        )
    except subprocess.TimeoutExpired:
        eprint(
            "TOOLHUB SELFTEST FAILED reason=timeout "
            f"after={time.time() - started:.1f}s cmd='flutter --version'"
        )
        eprint(
            "TOOLHUB HINT the toolchain cannot run here: retry this exact start "
            "command with danger-full-access"
        )
        return False
    except FileNotFoundError:
        eprint("TOOLHUB SELFTEST FAILED reason=flutter-not-found")
        return False
    if completed.returncode != 0:
        eprint(
            f"TOOLHUB SELFTEST FAILED reason=exit-{completed.returncode} "
            f"output={(completed.stdout or completed.stderr or '').strip()[:400]}"
        )
        return False
    first_line = (completed.stdout or "").strip().splitlines()
    eprint(
        "TOOLHUB SELFTEST OK "
        f"in {time.time() - started:.1f}s "
        f"version={first_line[0] if first_line else 'unknown'}"
    )
    return True


def parent_alive(pid: int) -> bool:
    """Whether a process is still running, without signalling it.

    Note for Windows: `os.kill(pid, 0)` is *not* a liveness probe there — it
    terminates the process. WaitForSingleObject on a SYNCHRONIZE handle is the
    correct check.
    """
    if IS_WINDOWS:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        handle = kernel32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if not handle:
            return False
        try:
            # WAIT_OBJECT_0 (0) = signalled = exited; WAIT_TIMEOUT (258) = alive.
            return kernel32.WaitForSingleObject(handle, 0) != 0
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def watch_parent(hub: "ToolHub", pid: int) -> None:
    """Kills children and exits when the process that started us disappears.

    A force-killed parent gives a Windows child no signal, so a leaked
    `flutter`/`dart` could keep writing into `build/` after the session ended.
    Polling the parent's liveness is the portable way to notice — an EOF on
    stdin is *not*: a DSH background job's stdin is already closed at spawn, so
    that check fires immediately and kills the server it was meant to protect.
    """
    if not parent_alive(pid):
        eprint(
            f"TOOLHUB WATCH-PARENT parent pid={pid} already gone at boot; "
            "watchdog disabled"
        )
        return
    while True:
        time.sleep(2.0)
        if not parent_alive(pid):
            eprint(f"TOOLHUB PARENT-GONE parent pid={pid} exited; killing children")
            hub.stop()
            os._exit(0)


def main() -> int:
    # Keep every text stream UTF-8 regardless of the console code page.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass
    parser = argparse.ArgumentParser(description="session-scoped toolchain server")
    parser.add_argument("--cwd", default=os.getcwd(), help="working directory to pin")
    parser.add_argument("--port", type=int, default=0, help="0 = random free port")
    parser.add_argument("--token", default=None, help="fixed token (tests only)")
    parser.add_argument(
        "--selfcheck",
        action="store_true",
        default=True,
        help="run `flutter --version` before binding (default)",
    )
    parser.add_argument(
        "--no-selfcheck",
        dest="selfcheck",
        action="store_false",
        help="skip the boot toolchain check",
    )
    parser.add_argument(
        "--selfcheck-timeout",
        type=float,
        default=90.0,
        help="seconds before the boot check is called a hang",
    )
    parser.add_argument(
        "--run",
        action="append",
        default=[],
        metavar="CMD",
        help="command to queue at startup, e.g. --run 'flutter pub get'",
    )
    parser.add_argument(
        "--watch-parent",
        action="store_true",
        help=(
            "exit (killing children) when the process that started this server "
            "disappears; use when started as a session-scoped background job"
        ),
    )
    parser.add_argument(
        "--log-dir",
        default=None,
        help="directory for job logs (default: a fresh temp dir)",
    )
    args = parser.parse_args()

    cwd = os.path.abspath(args.cwd)
    if not os.path.isdir(cwd):
        eprint(f"ERROR --cwd is not a directory: {cwd}")
        return 2
    if args.selfcheck and not selfcheck(args.selfcheck_timeout):
        return 1

    log_dir = args.log_dir or tempfile.mkdtemp(prefix="toolhub-")
    os.makedirs(log_dir, exist_ok=True)
    token = args.token or secrets.token_urlsafe(24)
    hub = ToolHub(cwd=cwd, log_dir=log_dir)

    # Startup tasks ("start it and kick off a build"): queued before the socket
    # opens, so a client sees them as already-pending work.
    for raw in args.run:
        parts = raw.split()
        if not parts:
            continue
        try:
            job = hub.submit(parts[0], parts[1:])
            eprint(f"TOOLHUB QUEUED startup job={job.id} cmd={raw}")
        except ValueError as error:
            eprint(f"ERROR startup job rejected: {error}")
            return 2

    handler = make_handler(hub, token, "")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    server.daemon_threads = True
    port = server.server_address[1]
    eprint(
        f"TOOLHUB READY port={port} pid={os.getpid()} cwd={cwd} logdir={log_dir}"
    )
    eprint(f"TOOLHUB TOKEN {token}")
    eprint(f"TOOLHUB STATUS http://127.0.0.1:{port}/?token={token}")

    if args.watch_parent:
        threading.Thread(
            target=watch_parent,
            args=(hub, os.getppid()),
            daemon=True,
        ).start()
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        hub.stop()
        server.server_close()
        eprint("TOOLHUB STOPPED")
    return 0


if __name__ == "__main__":
    sys.exit(main())

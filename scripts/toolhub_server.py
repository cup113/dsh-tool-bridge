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
It is not a shell, and it is not a privilege boundary: `dart` runs any
subcommand, so `dart run <file>.dart` already executes arbitrary code with the
access this process was granted. The narrow surface buys *recovery cost and
surprise* — a refused command is one you cannot lose work to — not privilege.
Only ``flutter``/``dart`` (any subcommand) and a small, guard-railed ``git``
verb set are accepted, always as an argv list (never a shell string) and always
in the working directory pinned at startup. ``git push`` is deliberately absent:
the GitHub token must never live in a long-running process.

Lifecycle
---------
Session-scoped by design: the agent starts it with ``run_in_background`` and it
dies with the session. ``--watch-parent`` (opt-in) polls the process that
started it and, when that disappears, kills its children and exits — so a killed
job cannot leave an orphaned ``flutter``/``dart`` writing into ``build/``.
(``--watch-parent`` exists because stdin is useless here: a DSH background job's
stdin is already closed at spawn, so an EOF check exits instantly.)

Progress for a human
--------------------
At boot the server opens the tokenised status page in the default browser
(``--no-open`` to suppress). The server is normally launched by an agent as a
background job, so the ``STATUS`` line is the one thing the human needs and the
one thing that is hard to find: it scrolls out of view in a job that by design
never exits, and the port is random. Opening the page removes that discovery
step; the ``STATUS`` line stays as the durable record and the fallback for a
headless box, and opening is best-effort — it never delays or fails the boot.

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
- ``POST /run``                   -> {"cmd","args","message","scope","wait",
                                     "timeoutSec","grep","tail"} -> job
- ``GET  /jobs``                  -> [job]
- ``GET  /jobs/<id>?tail=N&grep=P`` -> job + last N log lines (or the last N
                                     lines matching the P regex)
- ``GET  /jobs/<id>/log``         -> raw log text (whole file; use ?tail= to trim)
- ``POST /jobs/<id>/kill``        -> kill the process tree
- ``POST /tools/<name>``          -> a sub-tool job; currently ``arb-edit``,
                                     whose body is the ARB instruction JSON and
                                     whose job carries a structured ``result``
- ``POST /stop``                  -> kill children and exit

Sub-tools
---------
A sub-tool is a named operation the bridge executes as a Job (ADR-0003): it
waits in the same queue, writes the same kind of log, is killed the same way,
and answers ``wait``/``timeoutSec``/``tail``/``grep`` exactly like ``/run``.
Only its body differs — instead of an argv it takes the instruction JSON, and
instead of a test digest its job carries a structured ``result``. The first
member is ``arb-edit`` (see ``arb_edit_lib``), which is why the retired
``flutter-arb-edit`` skill no longer needs its own elevated step: ``flutter
gen-l10n`` now runs in the pinned cwd, on the one worker, through the same
``resolve_launch`` that keeps ``cmd.exe`` out of the path.

Formatter pin and uncommitted scope
-----------------------------------
``--dart-format <path-to-dart.exe>`` routes **`dart format` jobs only** to that
executable, so a session can format with the dart the project's CI pins while
every other command keeps the locally installed SDK (``dart
analyze``/``test``/``pub`` must match the local Flutter, not CI). The pin is
checked at boot (``<exe> --version``) and reported by ``/health`` as
``dartFormatExe``; a job's ``resolvedArgv`` shows what actually ran.

``"scope": "uncommitted"`` on ``/run`` narrows a command to the working tree's
uncommitted ``.dart`` files, read in the pinned cwd with ``git status
--porcelain -z`` (staged, unstaged and untracked; deleted and ignored
excluded). ``dart format`` receives them as trailing file paths — exactly the
set CI format-checks. ``dart analyze`` takes at most one directory and ``dart
fix`` takes no path at all, so there the scope filters the returned log lines to
those files instead, while the exit code still covers the whole project. An empty
set is a 400: ``dart format`` with no paths would rewrite the whole tree.

Known-failure registry
----------------------
An optional ``<cwd>/.toolbridge/known-failures.json`` records the failures that
were already red before the caller's change — platform-specific, flaky, or
merely not theirs yet. A test job's digest then annotates every matching failure
with ``known``, appends the split to ``summary`` (``4 failed (3 known, 1 new)``)
and reports ``baseline.newFailures``: the complete, ordered list of the ones that
are *new*, which is the answer a caller has to act on. Without the file nothing
changes; a registry that cannot be read says so in ``baseline.error`` rather
than looking like "everything is new" or "everything is known".
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
import urllib.parse
import uuid
import webbrowser
from collections import deque
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import TypedDict

# Sub-tool libraries ship next to this file — in the repository and in the
# deployed skill alike — so that directory has to be importable before they can
# be imported. Done before the import below on purpose (it is not stdlib).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import arb_edit_lib

IS_WINDOWS = os.name == "nt"
CREATE_NO_WINDOW = 0x08000000 if IS_WINDOWS else 0

# How much of a job's log is scanned for a tail, and the default tail length.
TAIL_SCAN_BYTES = 256 * 1024
DEFAULT_TAIL_LINES = 200
MAX_TAIL_LINES = 5000

ALLOWED_EXES = {"flutter", "dart", "git"}

# The registered sub-tools (ADR-0003). A sub-tool is a named operation executed
# as a Job — it queues behind builds like everything else and reports a
# structured `result` instead of a test digest.
TOOL_NAMES = ("arb-edit",)

# Request fields the sub-tool route owns, exactly like `/run` does. Everything
# else in the body belongs to the sub-tool's own instruction, so these must be
# stripped before the instruction is validated — otherwise `wait` reads as an
# unknown instruction field and the documented request shape is a 400.
TOOL_TRANSPORT_FIELDS = frozenset({"wait", "timeoutSec", "grep", "tail"})

# git verbs this server will run. Everything else (reset, clean, checkout,
# switch, stash, push, config, rebase, ...) is refused by omission.
GIT_VERBS = {"status", "diff", "log", "add", "commit", "branch", "restore"}

# Per-verb flags that turn a safe verb destructive.
GIT_BLOCKED_FLAGS = {
    "branch": {"-d", "-D", "--delete", "-m", "-M", "--move"},
    "commit": set(),
    "add": set(),
    "status": set(),
    "diff": set(),
    "log": set(),
}

# Verbs whose flag surface is an allow list rather than a deny list.
#
# `restore` is the one allowed verb that can irrecoverably discard uncommitted
# work, so both directions of its blast radius have to be bounded: which flags,
# and which pathspecs. The deny list above cannot express that (there is no
# short list of dangerous flags — the dangerous thing is the default), so the
# guard is inverted for this verb. Everything absent here — `--source`,
# `--pathspec-from-file`, `-p/--patch`, `--recurse-submodules`, `-m/--merge`,
# `--overlay` — is refused by omission.
GIT_ALLOWED_FLAGS = {
    "restore": {"-S", "--staged", "-W", "--worktree", "-q", "--quiet"},
}

# Characters that make a pathspec a pattern instead of a path. `restore`
# refuses them: the point of allowing restore is "undo these named files", and
# `git restore .` (or `test/**`) is the whole-worktree wipe the bridge exists to
# keep out of reach.
PATHSPEC_WILDCARDS = set("*?[]")

# Arguments that carry a commit message, so an inline `message` field cannot
# silently fight with one of them.
MESSAGE_SOURCE_FLAGS = {
    "-m",
    "--message",
    "-F",
    "--file",
    "-C",
    "--reuse-message",
    "-c",
    "--reedit-message",
    "--fixup",
    "--squash",
    "--no-edit",
}

# The one scope a `/run` body may name today: the working tree's uncommitted
# files. The name is deliberately the caller's word for it, not a git term.
SCOPE_UNCOMMITTED = "uncommitted"

# Verbs a scope may be applied to, split by *how*: `dart format` takes any
# number of trailing paths, so the files are appended to argv and the tool
# itself is narrowed. `dart analyze` takes at most one directory and `dart fix`
# takes no path at all (their `flutter` wrappers likewise — verified against
# `dart fix --help` / `dart analyze --help`), so no argv can express "these
# files" — there the scope narrows the *reported* lines instead, and the exit
# code still covers the whole project. Everything else (`dart test`, `git ...`,
# sub-tools) is refused: a scope that silently did nothing would be worse than
# no scope at all.
SCOPE_EXPAND_VERBS = {"format"}
SCOPE_FILTER_VERBS = {"analyze", "fix"}
SCOPE_COMMANDS = {"dart", "flutter"}

# Endings a scoped command cares about. The scope is a Dart-tooling scope, so
# a changed README or ARB file is not a target.
SCOPE_FILE_SUFFIX = ".dart"

# How long `git status` may take before the scope is refused. It runs at submit
# time, so a slow answer costs a request rather than a queued job.
GIT_STATUS_TIMEOUT = 20.0

# The known-failure registry: an optional per-project file the test digest reads
# so that "is this failure mine?" is answered by data instead of by memory
# (CONTEXT.md calls this baseline attribution). Absent file, absent behaviour.
KNOWN_FAILURES_RELPATH = ".toolbridge/known-failures.json"
KNOWN_FAILURES_MAX_BYTES = 512 * 1024

# Platforms an entry may be gated to. The bridge only knows one distinction
# locally — Windows or not — and that is the one that matters: CI runs Linux,
# where a Windows-only family is expected to pass.
KNOWN_PLATFORMS = {"windows", "posix"}

# Assessment families an entry may carry, borrowed from the hand-written
# registry this replaces (cuplivo's docs/known-pre-existing-test-failures-windows.md):
# `platform` (fails on this OS only), `flaky` (intermittent), `environment`
# (setup/machine), `defect` (a real pre-existing bug, in nobody's change) and
# `unclassified` (recorded, not yet understood).
KNOWN_KINDS = {"platform", "flaky", "environment", "defect", "unclassified"}


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
    """One queued/running/finished command or sub-tool call."""

    def __init__(
        self,
        argv: list[str],
        cwd: str,
        log_path: str,
        runner: Callable[[Job], None] | None = None,
        scope: str | None = None,
    ) -> None:
        self.id = uuid.uuid4().hex[:12]
        # For a sub-tool job this is the display argv the status page shows;
        # nothing spawns it (the runner decides what to run).
        self.argv = argv
        self.cwd = cwd
        self.log_path = log_path
        # A runner means "sub-tool": the worker calls it instead of spawning
        # argv, which is what keeps a sub-tool on the one-job-at-a-time queue.
        self.runner = runner
        # The scope the request asked for, kept for observability: `argv` shows
        # the expansion, this says where those paths came from.
        self.scope = scope
        self.status = "queued"  # queued|running|done|failed|killed
        self.exit_code: int | None = None
        self.resolved: list[str] | None = None
        self.started_at: float | None = None
        self.finished_at: float | None = None
        self.error: str | None = None
        self.summary: str | None = None
        self.counts: TestCounts | None = None
        self.failures: list[TestFailure] = []
        # The structured outcome of a sub-tool; None for a command job.
        self.result: dict[str, object] | None = None
        # The known-failure split of a test run; None without a registry.
        self.baseline: BaselineReport | None = None
        self._process: subprocess.Popen[bytes] | None = None
        self._lock = threading.Lock()

    @property
    def kind(self) -> str:
        """`tool` for a sub-tool job, `cmd` for an argv job."""
        return "tool" if self.runner is not None else "cmd"

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

    def to_json(
        self,
        tail_lines: int | None = None,
        grep: re.Pattern[str] | None = None,
    ) -> dict[str, object]:
        payload: dict[str, object] = {
            "id": self.id,
            "kind": self.kind,
            "argv": self.argv,
            "resolvedArgv": self.resolved,
            "status": self.status,
            "scope": self.scope,
            "exitCode": self.exit_code,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "durationSec": (
                None
                if self.started_at is None
                else round((self.finished_at or time.time()) - self.started_at, 2)
            ),
            "summary": self.summary,
            "counts": self.counts,
            "error": self.error,
            "result": self.result,
            "logPath": self.log_path,
        }
        if tail_lines is not None:
            text, log_meta = read_filtered(self.log_path, grep, tail_lines)
            payload["tail"] = text
            payload["log"] = log_meta
            # The failure inventory rides with the log view: it is a list, and
            # the `/jobs` overview (which carries no log) would otherwise repeat
            # every failure of every job. The baseline split is the same shape.
            payload["failures"] = self.failures
            payload["baseline"] = self.baseline
        return payload


def read_tail(path: str, lines: int) -> str:
    """Last ``lines`` lines of a log file, read from the end (bounded memory)."""
    if lines <= 0:
        return ""
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


def read_filtered(
    path: str, grep: re.Pattern[str] | None, lines: int
) -> tuple[str, dict[str, object]]:
    """The log tail, optionally keeping only lines a regex matches.

    Without ``grep`` this is the historical bounded end-of-file read and the
    metadata is empty. With ``grep`` the *whole* file is streamed once, because
    a 256 KiB window would answer "no matches" for a failure sitting earlier in
    the file — a filter that lies is worse than no filter. Only the last
    ``lines`` matches are kept (bounded memory) while every match is counted, so
    the caller can tell "none" from "not all of them".
    """
    if grep is None:
        return read_tail(path, lines), {
            "grep": None,
            "matched": None,
            "returned": None,
            "scannedLines": None,
            "truncated": False,
        }
    kept: deque[str] = deque(maxlen=max(0, lines))
    matched = 0
    scanned = 0
    try:
        # Text mode with universal newlines: a `compact` reporter log separates
        # progress lines with a bare CR, which byte-wise iteration would treat
        # as one enormous line.
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            for raw in handle:
                scanned += 1
                line = raw.rstrip("\n")
                if grep.search(line):
                    matched += 1
                    if lines > 0:
                        kept.append(line)
    except OSError:
        pass
    returned = len(kept)
    return "\n".join(kept), {
        "grep": grep.pattern,
        "matched": matched,
        "returned": returned,
        "scannedLines": scanned,
        "truncated": matched > returned,
    }


def one(values: list[str] | None) -> str | None:
    """The first value of a query parameter, if it was given at all."""
    return values[0] if values else None


def parse_log_query(grep: object, tail: object) -> tuple[int, re.Pattern[str] | None]:
    """Validates the ``grep``/``tail`` log knobs. Raises ValueError.

    Accepts the same two values from a JSON body (int) and from a query string
    (str), so both routes share one interpretation.
    """
    pattern: re.Pattern[str] | None = None
    if grep is not None:
        if not isinstance(grep, str):
            raise ValueError("grep must be a string")
        if not grep:
            raise ValueError("grep must not be empty")
        try:
            pattern = re.compile(grep)
        except re.error as error:
            raise ValueError(f"grep is not a valid regex: {error}") from error
    if tail is None:
        lines = DEFAULT_TAIL_LINES
    elif isinstance(tail, bool):
        raise ValueError("tail must be an integer")
    elif isinstance(tail, int):
        lines = tail
    elif isinstance(tail, str) and tail.strip().lstrip("-").isdigit():
        lines = int(tail)
    else:
        raise ValueError("tail must be an integer")
    return max(0, min(MAX_TAIL_LINES, lines)), pattern


# A `package:test` progress line: "00:25 +67 ~2 -4: <description>".
TEST_COUNTS_RE = re.compile(r"^\d\d:\d\d \+(\d+)(?: ~(\d+))?(?: -(\d+))?: ")
# A failing test's progress line, with the `[E]` marker the reporters append.
TEST_FAILURE_RE = re.compile(
    r"^\d\d:\d\d \+\d+(?: ~\d+)?(?: -\d+)?: (?P<name>.+?)"
    r"(?P<unfinished> - did not complete)? \[E\]$"
)
TEST_BLOCK_HEADER = "Failing tests:"
TEST_BLOCK_MORE_RE = re.compile(r"^\.\.\. and (\d+) more$")
TEST_DID_NOT_COMPLETE = " (did not complete)"
TEST_TERMINAL_MARKERS = (
    "All tests passed!",
    "All other tests passed!",
    "All tests skipped.",
    "Some tests failed.",
)


class KnownMatch(TypedDict):
    """Why a failure is not the caller's: the registry entry that claimed it."""

    kind: str
    reason: str | None


class ReportedFailure(TypedDict):
    """One failing (or unfinished) test, exactly as the progress lines report it."""

    file: str | None
    name: str
    didNotComplete: bool


class TestFailure(ReportedFailure, total=False):
    """A reported failure plus the registry's verdict, when one applied.

    ``known`` is the per-failure half of the digest's answer: its presence means
    "this was already red before your change", and its absence means the failure
    is new — which is also why it must never be spelled ``false``.
    """

    known: KnownMatch


class TestCounts(TypedDict):
    """The counts on the last `+passed ~skipped -failed:` progress line."""

    passed: int
    skipped: int
    failed: int


class TestLogDigest(TypedDict):
    """The result of `analyze_test_log`."""

    summary: str | None
    counts: TestCounts | None
    failures: list[TestFailure]


def is_test_run(argv: list[str]) -> bool:
    """Whether argv is a `flutter test` / `dart test` invocation."""
    if len(argv) < 2:
        return False
    return command_name(argv[0]) in ("flutter", "dart") and argv[1] == "test"


def split_path_and_name(text: str) -> tuple[str | None, str]:
    """Splits a reporter `path: name` description, if it really has a path.

    A single-file run prints no path at all (`printPath` is on only when more
    than one test file was selected) and a test name may contain a colon, so the
    head has to *look* like a path: end in `.dart` or contain a separator.
    """
    head, sep, tail = text.partition(": ")
    if sep and ("/" in head or "\\" in head or head.endswith(".dart")):
        return head, tail
    return None, text


def split_block_entry(text: str) -> TestFailure:
    """One `path: name` line of the `Failing tests:` block."""
    finished = not text.endswith(TEST_DID_NOT_COMPLETE)
    if not finished:
        text = text[: -len(TEST_DID_NOT_COMPLETE)]
    file, name = split_path_and_name(text)
    return {"file": file, "name": name, "didNotComplete": not finished}


def attach_paths(
    failures: list[TestFailure], block: list[TestFailure]
) -> list[TestFailure]:
    """Lends block paths to path-less failures, then appends block orphans.

    Order and completeness stay the `[E]` lines' (run order, uncapped); the
    block only ever supplies a missing file. An entry the block reports but the
    progress lines missed is appended rather than dropped.
    """
    used: set[int] = set()
    for entry in failures:
        for index, candidate in enumerate(block):
            if index in used or candidate["name"] != entry["name"]:
                continue
            used.add(index)
            if entry["file"] is None:
                entry["file"] = candidate["file"]
            entry["didNotComplete"] = bool(
                entry["didNotComplete"] or candidate["didNotComplete"]
            )
            break
    for index, candidate in enumerate(block):
        if index not in used:
            failures.append(TestFailure(**candidate))
    return failures


def summarize_test_run(counts: TestCounts | None, terminal: bool) -> str:
    """The one-line digest, kept deliberately close to the old wording.

    A missing terminal marker means the run was killed or truncated mid-suite;
    "+N so far" would read as a finished suite, so that case stays opaque.
    """
    if counts is None:
        return "all tests passed" if terminal else "see log"
    passed = counts["passed"]
    failed = counts["failed"]
    skipped = counts["skipped"]
    if failed:
        return f"{passed} passed, {failed} failed"
    if not terminal:
        return "see log"
    return f"{passed} passed" + (f", {skipped} skipped" if skipped else "")


def analyze_test_log(argv: list[str], log_path: str) -> TestLogDigest:
    """Digest for `flutter test` / `dart test`, else an empty result.

    The authoritative count comes from the last `+passed ~skipped -failed:`
    progress line. The failure inventory comes from the `[E]` progress lines
    rather than from the `Failing tests:` block, because that block lists at
    most four entries and then "... and N more" (test_core caps it and sorts by
    path, so a failure can be evicted by alphabet) — and the `failures-only`
    reporter never writes it at all. The block is still read, but only to lend a
    suite path to an entry that has none.

    Returns {"summary", "counts", "failures"} where summary is the one-line
    digest (None when this was not a test run), counts is
    {"passed","skipped","failed"} from the last progress line, and failures is
    [{"file","name","didNotComplete"}] in run order.
    """
    result: TestLogDigest = {"summary": None, "counts": None, "failures": []}
    if not is_test_run(argv):
        return result
    failures: list[TestFailure] = []
    block: list[TestFailure] = []
    counts: TestCounts | None = None
    terminal = False
    in_block = False
    try:
        with open(log_path, "r", encoding="utf-8", errors="replace") as handle:
            for raw in handle:
                line = raw.rstrip("\n")
                if in_block:
                    stripped = line.strip()
                    if TEST_BLOCK_MORE_RE.match(stripped):
                        in_block = False
                        continue
                    if line.startswith("  ") and stripped:
                        block.append(split_block_entry(stripped))
                        continue
                    in_block = False
                if line == TEST_BLOCK_HEADER:
                    in_block = True
                    continue
                match = TEST_FAILURE_RE.match(line)
                if match:
                    file, name = split_path_and_name(match.group("name"))
                    failures.append(
                        {
                            "file": file,
                            "name": name,
                            "didNotComplete": bool(match.group("unfinished")),
                        }
                    )
                    # No `continue`: the same line carries the running counts,
                    # and on a killed run it may be the last one there is.
                match = TEST_COUNTS_RE.match(line)
                if match:
                    counts = {
                        "passed": int(match.group(1)),
                        "skipped": int(match.group(2) or 0),
                        "failed": int(match.group(3) or 0),
                    }
                # Checked last and without `continue`: the terminal markers ride
                # on the very progress lines that carry the final counts.
                if any(marker in line for marker in TEST_TERMINAL_MARKERS):
                    terminal = True
    except OSError:
        return result

    result["failures"] = attach_paths(failures, block)
    result["counts"] = counts
    result["summary"] = summarize_test_run(counts, terminal)
    return result


# ---------------------------------------------------------------------------
# Known-failure registry (baseline attribution)
# ---------------------------------------------------------------------------


class KnownEntry(TypedDict):
    """One registry entry, normalised and ready to match."""

    file: str | None
    name: str | None
    pattern: re.Pattern[str] | None
    kind: str
    platform: str | None
    reason: str | None


class Registry(TypedDict):
    """A loaded registry: where it lives, what it holds, why it may be empty."""

    path: str
    exists: bool
    entries: list[KnownEntry]
    error: str | None


class BaselineReport(TypedDict):
    """The digest's answer to "is this failure mine?".

    ``known``/``new`` count **distinct tests**, which is the unit ``failed``
    states; ``events`` is how many ``[E]`` lines carried them, and ``unparsed``
    is the part of ``failed`` the inventory never named. ``known + new +
    unparsed == failed`` whenever the inventory is reconcilable with the
    authoritative count, which is exactly when ``summary`` may carry the split.
    """

    source: str
    known: int
    new: int
    failed: int | None
    tests: int
    events: int
    unparsed: int
    newFailures: list[TestFailure]
    error: str | None


def current_platform() -> str:
    """`windows` or `posix` — the only platform distinction the bridge knows."""
    return "windows" if IS_WINDOWS else "posix"


def parse_known_failures(raw: object) -> list[KnownEntry]:
    """Validates a registry document. Raises ValueError naming the entry.

    Every entry needs exactly one of `name` (the test name, exact) or `match` (a
    regex searched in it), and may narrow further with `file`, `platform`,
    `kind` and `reason`. Validation is strict on purpose: a typo that silently
    matched nothing would make a known failure look new — which is the one
    direction this feature must never fail in.
    """
    if not isinstance(raw, dict):
        raise ValueError("registry must be a JSON object")
    entries = raw.get("entries")
    if not isinstance(entries, list):
        raise ValueError("registry needs an 'entries' list")
    parsed: list[KnownEntry] = []
    for index, entry in enumerate(entries):
        where = f"entries[{index}]"
        if not isinstance(entry, dict):
            raise ValueError(f"{where} must be an object")
        name = entry.get("name")
        source = entry.get("match")
        if (name is None) == (source is None):
            raise ValueError(f"{where} needs exactly one of 'name' or 'match'")
        if name is not None and not isinstance(name, str):
            raise ValueError(f"{where}.name must be a string")
        pattern: re.Pattern[str] | None = None
        if source is not None:
            if not isinstance(source, str):
                raise ValueError(f"{where}.match must be a string")
            try:
                pattern = re.compile(source)
            except re.error as error:
                raise ValueError(
                    f"{where}.match is not a valid regex: {error}"
                ) from error
        file_name = entry.get("file")
        if file_name is not None and not isinstance(file_name, str):
            raise ValueError(f"{where}.file must be a string")
        kind = entry.get("kind", "unclassified")
        if kind not in KNOWN_KINDS:
            raise ValueError(f"{where}.kind must be one of {sorted(KNOWN_KINDS)}")
        platform = entry.get("platform")
        if platform is not None and platform not in KNOWN_PLATFORMS:
            raise ValueError(
                f"{where}.platform must be one of {sorted(KNOWN_PLATFORMS)}"
            )
        reason = entry.get("reason")
        if reason is not None and not isinstance(reason, str):
            raise ValueError(f"{where}.reason must be a string")
        parsed.append(
            {
                "file": file_name,
                "name": name,
                "pattern": pattern,
                "kind": kind,
                "platform": platform,
                "reason": reason,
            }
        )
    return parsed


def load_known_failures(cwd: str) -> Registry:
    """Reads ``<cwd>/.toolbridge/known-failures.json``. Never raises.

    A registry that cannot be read comes back with ``entries == []`` and an
    ``error``, and the digest repeats that verbatim. The reason is the failure
    mode this whole feature is about: "everything is new" and "everything is
    known" must never look alike, so a broken file must announce itself instead
    of quietly claiming nothing.
    """
    path = os.path.join(cwd, *KNOWN_FAILURES_RELPATH.split("/"))
    registry: Registry = {
        "path": KNOWN_FAILURES_RELPATH,
        "exists": False,
        "entries": [],
        "error": None,
    }
    if not os.path.isfile(path):
        return registry
    registry["exists"] = True
    try:
        if os.path.getsize(path) > KNOWN_FAILURES_MAX_BYTES:
            raise ValueError(
                f"registry is larger than {KNOWN_FAILURES_MAX_BYTES} bytes"
            )
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            raw = json.load(handle)
        registry["entries"] = parse_known_failures(raw)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        registry["error"] = str(error)
    return registry


def path_matches(actual: str | None, expected: str) -> bool:
    """Whether a failure's reported path is the registry's relative path.

    The reporter prints an absolute path, and on Windows often one with mixed
    separators (that mixedness is itself a whole family of Windows-only
    failures), so this is a segment-boundary suffix test over normalised
    slashes — case-insensitive on Windows, because that is what the filesystem
    is.
    """
    if not actual:
        return False
    reported = actual.replace("\\", "/")
    wanted = expected.replace("\\", "/").lstrip("/")
    if IS_WINDOWS:
        reported, wanted = reported.lower(), wanted.lower()
    return reported == wanted or reported.endswith("/" + wanted)


def known_entry_for(
    entries: list[KnownEntry], failure: TestFailure
) -> KnownEntry | None:
    """The first entry that claims this failure, or None. Entries are ordered.

    A `file`-scoped entry never claims a failure the reporter printed without a
    path (a single-file run): the alternative would be attributing an unknown
    failure to whichever suite happened to be named in the registry — the one
    direction this feature must not fail in.
    """
    name = failure.get("name") or ""
    platform = current_platform()
    for entry in entries:
        if entry["platform"] is not None and entry["platform"] != platform:
            continue
        if entry["file"] is not None and not path_matches(
            failure.get("file"), entry["file"]
        ):
            continue
        if entry["name"] is not None:
            if name == entry["name"]:
                return entry
            continue
        pattern = entry["pattern"]
        if pattern is not None and pattern.search(name):
            return entry
    return None


def baseline_report(
    failures: list[TestFailure],
    counts: TestCounts | None,
    registry: Registry,
) -> BaselineReport | None:
    """Splits a run's failures into known and new. None when there is no registry.

    ``failures`` is annotated **in place** with ``known``, because one entry has
    to be readable on its own. The list that says *which* failures are new is
    ``newFailures``; ``summary`` only carries the counts. A caller that has to
    act on a regression must read the list — the one-liner is a glance, not the
    answer.

    The split counts **distinct tests** (``file`` + ``name``), not ``[E]``
    events: a test that fails in its body *and* in its tearDown prints two
    progress lines, while the authoritative ``counts.failed`` counts it once.
    Counting events would make the split disagree with the very number the
    summary leads with — observed on a real 6105-test run, where 79 ``[E]`` lines
    covered 77 failing tests. Every event is still annotated; only the tally
    deduplicates.
    """
    if not registry["exists"]:
        return None
    report: BaselineReport = {
        "source": registry["path"],
        "known": 0,
        "new": 0,
        "failed": counts["failed"] if counts is not None else None,
        "tests": 0,
        "events": len(failures),
        "unparsed": 0,
        "newFailures": [],
        "error": registry["error"],
    }
    entries = registry["entries"] if registry["error"] is None else []
    new_failures: list[TestFailure] = []
    counted: set[tuple[str | None, str]] = set()
    known = 0
    for failure in failures:
        entry = known_entry_for(entries, failure)
        if entry is not None:
            failure["known"] = {"kind": entry["kind"], "reason": entry["reason"]}
        key = (failure.get("file"), failure.get("name") or "")
        if key in counted:
            continue  # the same test's second event: annotated, not re-counted
        counted.add(key)
        if entry is None:
            new_failures.append(failure)
            continue
        known += 1
    report["known"] = known
    report["new"] = len(new_failures)
    report["tests"] = len(counted)
    report["newFailures"] = new_failures
    if counts is not None:
        # `counts.failed` is authoritative while the inventory can be shorter
        # (a reporter whose failure lines this parser does not recognise), so
        # the gap is named instead of letting the split look complete.
        report["unparsed"] = max(0, counts["failed"] - len(counted))
    return report


def summarize_with_baseline(
    summary: str | None, report: BaselineReport | None
) -> str | None:
    """`83 passed, 4 failed` + ` (3 known, 1 new)` when a registry applies.

    Only a summary that reports failures is annotated: "see log" means the run
    was killed or the reporter was unrecognised, and its whole point is to not
    claim a count. And the suffix is withheld when the split cannot be
    reconciled with the count the summary already states (an inventory naming
    more tests than `counts.failed`) — a one-liner that contradicts itself in the
    same breath is worse than no hint at all.
    """
    if summary is None or report is None or report["error"] is not None:
        return summary
    if "failed" not in summary:
        return summary
    failed = report["failed"]
    if failed is None or report["tests"] > failed:
        return summary
    known = report["known"]
    new = report["new"]
    unparsed = report["unparsed"]
    if known + new + unparsed == 0:
        return summary
    parts = [f"{known} known", f"{new} new"]
    if unparsed:
        parts.append(f"{unparsed} unparsed")
    return f"{summary} ({', '.join(parts)})"


# ---------------------------------------------------------------------------
# Sub-tools
# ---------------------------------------------------------------------------


def make_job_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """The environment every spawned job gets.

    UTF-8 regardless of the console code page, and no git credential or signing
    prompt: this process has no terminal to answer one, so a prompt would cost
    the whole job.
    """
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env["GIT_TERMINAL_PROMPT"] = "0"
    if extra:
        env.update(extra)
    return env


def make_arb_edit_runner(
    instructions: dict[str, object],
    cwd: str,
    launch_fn: Callable[[list[str]], tuple[list[str], dict[str, str]]] | None = None,
    spawn: Callable[..., subprocess.Popen[bytes]] = subprocess.Popen,
) -> Callable[[Job], None]:
    """The worker-side body of an `arb-edit` job.

    Order matters and is the whole point of the sub-tool: plan every file
    before writing any, so an anchor missing from one file of the set leaves
    the others byte-identical; then write; then run ``flutter gen-l10n`` through
    ``resolve_launch`` (the SDK's own ``dart.exe``, so no ``.bat``/``cmd.exe``
    parsing rides along) inside the single-worker queue, because gen-l10n writes
    generated files into the project and must serialize against builds; then
    read the untranslated-messages-file, which is a warning and not a failure.

    ``launch_fn``/``spawn`` are injectable so the tests never start Flutter;
    ``launch_fn=None`` means ``resolve_launch``, looked up when the job runs
    (the definition lives further down this module).
    """

    def runner(job: Job) -> None:
        resolve = launch_fn or resolve_launch
        normalized = arb_edit_lib.validate_instructions(instructions)
        groups = normalized["groups"]
        dry_run = bool(normalized["dryRun"])
        with open(job.log_path, "ab") as sink:

            def say(line: str) -> None:
                sink.write((line + "\n").encode("utf-8"))
                sink.flush()

            say(f"tool=arb-edit groups={len(groups)} dryRun={dry_run}")
            if job.status == "killed":
                return
            try:
                plan = arb_edit_lib.plan_arb_edits(Path(cwd), instructions)
            except ValueError as error:
                say(f"PLAN FAILED {error}")
                job.error = str(error)
                job.exit_code = 1
                job.status = "failed"
                return
            result: dict[str, object] = {
                "dryRun": dry_run,
                "edited": [],
                "skipped": plan["skipped"],
                "changes": [
                    {
                        "file": entry["name"],
                        "inserts": entry["inserts"],
                        "deletes": entry["deletes"],
                    }
                    for entry in plan["files"]
                ],
                "genL10n": None,
                "untranslated": None,
            }
            if dry_run:
                # The plan phase is the whole job: nothing is written and
                # gen-l10n does not run, which is what makes this usable to
                # check anchors before mutating a project.
                job.result = result
                job.exit_code = 0
                job.status = "done"
                say(f"DRY RUN {len(plan['files'])} file(s) would be edited.")
                return
            if job.status == "killed":
                return
            result["edited"] = arb_edit_lib.apply_arb_edits(plan)
            for name in result["edited"]:
                say(f"Edited {name}")
            say(f"{len(result['edited'])} ARB file(s) edited.")
            if job.status == "killed":
                # Killed between phases: the edits stand, and gen-l10n is not
                # started at all.
                job.result = result
                return
            say("Running flutter gen-l10n...")
            try:
                launch, extra_env = resolve(["flutter", "gen-l10n"])
            except FileNotFoundError as error:
                job.error = str(error)
                job.exit_code = 127
                job.status = "failed"
                job.result = result
                return
            job.resolved = launch
            process = spawn(
                launch,
                cwd=cwd,
                stdout=sink,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                env=make_job_env(extra_env),
                creationflags=CREATE_NO_WINDOW,
            )
            job.set_process(process)
            exit_code = process.wait()
            job.exit_code = exit_code
            result["genL10n"] = {"exitCode": exit_code}
            result["untranslated"] = arb_edit_lib.read_untranslated(
                plan["untranslated_file"]
            )
            job.result = result
            if job.status != "killed":
                job.status = "done" if exit_code == 0 else "failed"
            untranslated = result["untranslated"]
            if isinstance(untranslated, dict):
                say(
                    "WARNING untranslated-messages-file has "
                    f"{untranslated['lines']} line(s) of untranslated messages."
                )

    return runner


def make_tool_runner(
    name: str, body: dict[str, object], cwd: str
) -> Callable[[Job], None]:
    """The runner for a registered sub-tool. Raises KeyError if unknown."""
    if name == "arb-edit":
        return make_arb_edit_runner(body, cwd)
    raise KeyError(name)


def tool_display_argv(name: str, instruction: dict[str, object]) -> list[str]:
    """What the status page shows for a sub-tool job."""
    if name == "arb-edit":
        groups = instruction.get("groups")
        count = len(groups) if isinstance(groups, list) else 0
        display = [f"tool:{name}", f"{count} group(s)"]
        if instruction.get("dryRun"):
            display.append("--dry-run")
        return display
    return [f"tool:{name}"]


def split_tool_body(body: dict[str, object]) -> dict[str, object]:
    """The sub-tool instruction inside a request body.

    The route's transport knobs (`wait`, `timeoutSec`, `grep`, `tail`) are the
    bridge's, not the sub-tool's, so they are removed before the instruction
    schema is checked — `/run` makes the same distinction between a command's
    argv and the knobs that shape the response.
    """
    return {
        key: value
        for key, value in body.items()
        if key not in TOOL_TRANSPORT_FIELDS
    }


class ToolHub:
    """Queue, worker thread and job registry."""

    def __init__(
        self,
        cwd: str,
        log_dir: str,
        dart_format_exe: str | None = None,
        uncommitted_files_fn: Callable[[str], list[str]] | None = None,
    ) -> None:
        self.cwd = cwd
        self.log_dir = log_dir
        # The boot-scoped formatter pin and the scope's file source, both fixed
        # for the life of the bridge: a request cannot retarget either, which is
        # the same shape as the pinned cwd (ADR-0002).
        self.dart_format_exe = dart_format_exe
        self._uncommitted_files = uncommitted_files_fn or uncommitted_dart_files
        self.jobs: dict[str, Job] = {}
        self.order: list[str] = []
        self._queue: queue.Queue[Job] = queue.Queue()
        self._lock = threading.Lock()
        self._current: Job | None = None
        self._stopping = threading.Event()
        self._worker = threading.Thread(target=self._work, daemon=True)
        self._worker.start()

    # ---- submission ----

    def submit(
        self,
        cmd: str,
        args: list[str],
        message: str | None = None,
        scope: str | None = None,
    ) -> Job:
        argv = build_argv(cmd, args, message)
        validate(argv)
        return self._enqueue(
            Job(
                argv,
                self.cwd,
                os.path.join(self.log_dir, "pending.log"),
                scope=scope,
            )
        )

    def uncommitted_files(self) -> list[str]:
        """The uncommitted `.dart` files a `scope` request narrows to.

        Raises ValueError when git cannot answer (not a repository, no git on
        PATH, a timeout), so the route can refuse the request instead of queueing
        a job whose scope is silently empty.
        """
        return self._uncommitted_files(self.cwd)

    def submit_tool(
        self,
        name: str,
        display_argv: list[str],
        runner: Callable[[Job], None],
    ) -> Job:
        """Queues a sub-tool job. Raises KeyError for an unregistered name."""
        if name not in TOOL_NAMES:
            raise KeyError(name)
        return self._enqueue(
            Job(
                display_argv,
                self.cwd,
                os.path.join(self.log_dir, "pending.log"),
                runner=runner,
            )
        )

    def _enqueue(self, job: Job) -> Job:
        """Registers a job, creates its log and hands it to the worker."""
        with self._lock:
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
        try:
            if job.runner is None:
                self._run_command(job)
            else:
                # Sub-tools run here, on the worker thread, for the same reason
                # commands are serialized: gen-l10n writes into the project.
                job.runner(job)
        except Exception as error:  # noqa: BLE001 - a job error must not kill the worker
            job.status = "failed"
            if job.exit_code is None:
                job.exit_code = 1
            job.error = str(error)
        finally:
            job.finished_at = time.time()
            self._current = None

    def _run_command(self, job: Job) -> None:
        env = make_job_env()
        try:
            launch, extra_env = resolve_launch(job.argv, self.dart_format_exe)
        except FileNotFoundError as error:
            job.status = "failed"
            job.exit_code = 127
            job.error = str(error)
            with open(job.log_path, "ab") as sink:
                sink.write((job.error + "\n").encode("utf-8"))
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
            digest = analyze_test_log(job.argv, job.log_path)
            job.summary = digest["summary"]
            job.counts = digest["counts"]
            job.failures = digest["failures"]
            if is_test_run(job.argv):
                # Read now, from the pinned cwd: the registry describes the
                # project as it is at run time, and its absence is simply
                # "nothing changes".
                registry = load_known_failures(job.cwd)
                report = baseline_report(job.failures, digest["counts"], registry)
                job.baseline = report
                job.summary = summarize_with_baseline(job.summary, report)
        except FileNotFoundError:
            job.status = "failed"
            job.exit_code = 127
            job.error = f"executable not found: {job.argv[0]}"
            with open(job.log_path, "ab") as sink:
                sink.write((job.error + "\n").encode("utf-8"))

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


def dart_format_target(argv: list[str], pin: str | None) -> str | None:
    """The pinned dart executable for a `dart format` job, else None.

    Routing keys on `format` being the *first* argument after `dart` — the shape
    CI uses (`dart format --output=none --set-exit-if-changed <files>`) and the
    only one a scoped job produces. Everything else keeps the PATH toolchain on
    purpose: `dart analyze`/`test`/`pub` and every `flutter` command must match
    the Flutter SDK installed here, not CI's.
    """
    if pin is None or len(argv) < 2:
        return None
    if command_name(argv[0]) != "dart" or argv[1] != "format":
        return None
    return pin


def resolve_launch(
    argv: list[str], dart_format_exe: str | None = None
) -> tuple[list[str], dict[str, str]]:
    """Turns an allowlisted command into a real executable invocation.

    On Windows `flutter` and `dart` are `.bat` wrappers, which CreateProcess
    cannot execute and which would drag `cmd.exe` — and its parsing rules — into
    the middle of an argv that is supposed to have no shell. Both wrappers only
    launch the SDK's own `dart.exe` (with the flutter_tools snapshot for
    `flutter`), so that is what we call directly.

    ``dart_format_exe`` is the boot-time **format pin**: when it is set, a `dart
    format` job launches *that* executable instead. It is an explicit path to a
    real `dart.exe` (a standalone SDK, not a wrapper), so it needs neither the
    `.bat` dance nor `FLUTTER_ROOT` — and it is checked here rather than trusted,
    because a pin that has gone missing must fail the job loudly rather than fall
    back to the formatter the pin exists to avoid.

    Returns the argv to launch plus environment additions. Raises
    FileNotFoundError.
    """
    pin = dart_format_target(argv, dart_format_exe)
    if pin is not None:
        if not os.path.isfile(pin):
            raise FileNotFoundError(f"pinned dart format executable is missing: {pin}")
        return ([pin, *argv[1:]], {})
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


def command_name(cmd: str) -> str:
    """The bare tool name behind a path or a Windows wrapper suffix."""
    exe = os.path.basename(cmd).lower()
    if exe.endswith((".bat", ".exe", ".cmd")):
        exe = exe.rsplit(".", 1)[0]
    return exe


def validate(argv: list[str]) -> None:
    """Refuses anything outside the documented surface. Raises ValueError."""
    exe = command_name(argv[0])
    if exe not in ALLOWED_EXES:
        raise ValueError(
            f"command not allowed: {argv[0]!r} (allowed: {sorted(ALLOWED_EXES)})"
        )
    if exe != "git":
        return
    args = argv[1:]
    if not args:
        raise ValueError("git needs a verb")
    verb = args[0]
    if verb.startswith("-"):
        # `git --version` and friends carry no repository risk, but keep the
        # surface honest: only the documented verbs.
        raise ValueError(f"git verb not allowed: {verb!r}")
    if verb not in GIT_VERBS:
        raise ValueError(verb_refusal(verb))
    body = args[1:]
    allowed = GIT_ALLOWED_FLAGS.get(verb)
    if allowed is not None:
        validate_restore(body, allowed)
        return
    blocked = GIT_BLOCKED_FLAGS.get(verb, set())
    for arg in body:
        if arg in blocked:
            raise ValueError(f"git {verb} flag not allowed: {arg!r}")
    if verb == "commit" and not has_message_source(body):
        raise ValueError(
            "git commit needs a message: pass the inline 'message' field to "
            "/run, or one of -m/--message/-F/--file/-C/--reuse-message"
        )


def verb_refusal(verb: str) -> str:
    """The refusal for an unknown git verb, with the substitute when there is one."""
    message = f"git verb not allowed: {verb!r} (allowed: {sorted(GIT_VERBS)})"
    if verb in ("checkout", "switch"):
        message += (
            " — to discard worktree changes to named paths, use 'git restore -- <path>'"
        )
    return message


def flag_allowed(token: str, allowed: set[str]) -> bool:
    """Whether a flag token sets only allow-listed flags.

    `--no-X` is the same surface as `--X` (so it is canonicalised), and a short
    cluster like `-SW`/`-SWq` sets each letter, so each one must be allowed.
    """
    if token.startswith("--"):
        return "--" + token[2:].removeprefix("no-") in allowed
    if len(token) > 2:
        return all("-" + char in allowed for char in token[1:])
    return token in allowed


def guard_restore_pathspec(spec: str) -> None:
    """Refuses any pathspec that is not a literal path inside the worktree.

    `git restore` discards uncommitted work irrecoverably, so the only shape
    this bridge accepts is "these named files, please": no pathspec magic, no
    globs, no absolute paths, no `..`, and no bare `.` (which is the whole
    worktree). Raises ValueError.
    """
    if not spec:
        raise ValueError("git restore pathspec must not be empty")
    if spec.startswith(":"):
        raise ValueError(f"git restore pathspec magic is not allowed: {spec!r}")
    if os.path.isabs(spec) or os.path.splitdrive(spec)[0]:
        raise ValueError(f"git restore pathspec must be relative: {spec!r}")
    if spec[0] in "/\\":
        # `os.path.isabs` is False for a rooted path on Windows; git would
        # still resolve it against the drive, so refuse it explicitly.
        raise ValueError(f"git restore pathspec must be relative: {spec!r}")
    wildcard = sorted(set(spec) & PATHSPEC_WILDCARDS)
    if wildcard:
        raise ValueError(
            "git restore pathspec must name files, not a pattern: "
            f"{spec!r} contains {''.join(wildcard)!r}"
        )
    parts = [part for part in re.split(r"[\\/]", spec) if part not in ("", ".")]
    if not parts or ".." in parts:
        raise ValueError(
            "git restore pathspec must name files inside the working "
            f"directory: {spec!r}"
        )


def validate_restore(args: list[str], allowed: set[str]) -> None:
    """The `restore` surface: an allow-listed flag set and literal pathspecs."""
    pathspecs: list[str] = []
    after_separator = False
    for token in args:
        if after_separator:
            pathspecs.append(token)
            continue
        if token == "--":
            after_separator = True
            continue
        if token.startswith("-"):
            if not flag_allowed(token, allowed):
                raise ValueError(f"git restore flag not allowed: {token!r}")
            continue
        pathspecs.append(token)
    if not pathspecs:
        raise ValueError(
            "git restore needs at least one explicit path, e.g."
            " git restore -- lib/main.dart"
        )
    for spec in pathspecs:
        guard_restore_pathspec(spec)


def has_message_source(args: list[str]) -> bool:
    """Whether a `git commit` argv already carries a message."""
    for token in args:
        head = token.split("=", 1)[0]
        if head in MESSAGE_SOURCE_FLAGS:
            return True
    return False


def build_argv(cmd: str, args: list[str], message: str | None) -> list[str]:
    """Assembles the argv, folding an inline commit message in as `-m <text>`.

    `-m` rather than a temp file or stdin: no file exists for a later
    `git add -A` to sweep up (the incident this closes), nothing to clean up,
    and no pipe to deadlock on. The message therefore travels as argv — UTF-8
    through JSON, never through a shell or a pwsh `Set-Content`. Raises
    ValueError.
    """
    if message is None:
        return [cmd, *args]
    if not isinstance(message, str):
        raise ValueError("'message' must be a string")
    if not message.strip():
        raise ValueError("'message' must not be empty")
    if command_name(cmd) != "git" or not args or args[0] != "commit":
        raise ValueError("'message' is only valid for git commit")
    body = args[1:]
    for token in body:
        if token.split("=", 1)[0] in MESSAGE_SOURCE_FLAGS:
            raise ValueError(
                f"pass the commit message either inline or as {token!r}, not both"
            )
    return [cmd, "commit", "-m", message, *body]


# ---------------------------------------------------------------------------
# Uncommitted scope
# ---------------------------------------------------------------------------


def parse_porcelain(data: str) -> list[str]:
    """The paths of files that are uncommitted in `git status --porcelain -z`.

    The `-z` form is the one to parse: records are NUL-separated and paths are
    never quoted, so a CJK filename arrives as itself instead of as a
    `\\NNN`-escaped string (verified against git on Windows). A record is
    ``XY <path>``; for a rename or copy the **destination comes first** and the
    source path rides in the following bare record, which is skipped.

    Deleted and ignored entries are dropped — the question a scope answers is
    "which files can be formatted or analyzed right now", and neither can.
    """
    paths: list[str] = []
    records = data.split("\0")
    index = 0
    while index < len(records):
        record = records[index]
        index += 1
        if len(record) < 4:
            continue
        status, path = record[:2], record[3:]
        if status == "??":
            paths.append(path)
            continue
        if status == "!!":
            continue
        if status[0] in ("R", "C"):
            index += 1  # the source path, not what is on disk now
        if "D" in status or not path:
            continue
        paths.append(path)
    return paths


def run_git_status(cwd: str) -> str:
    """`git status --porcelain -z --untracked-files=all` in the pinned cwd.

    ``--no-optional-locks`` keeps it from refreshing the index: this runs while
    the single worker may be running a `git` job of its own, and fighting over
    `index.lock` would turn a read into a spurious failure. Raises ValueError
    with git's own message.
    """
    try:
        completed = subprocess.run(  # noqa: S603 - argv list, no shell
            [
                "git",
                "--no-optional-locks",
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
            ],
            cwd=cwd,
            capture_output=True,
            stdin=subprocess.DEVNULL,
            timeout=GIT_STATUS_TIMEOUT,
            env=make_job_env(),
            creationflags=CREATE_NO_WINDOW,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise ValueError(
            f"git status timed out after {GIT_STATUS_TIMEOUT:g}s"
        ) from error
    except OSError as error:
        raise ValueError(f"git status could not run: {error}") from error
    if completed.returncode != 0:
        detail = (completed.stderr or b"").decode("utf-8", "replace").strip()
        raise ValueError(
            f"git status failed (exit {completed.returncode}): {detail or 'no detail'}"
        )
    return completed.stdout.decode("utf-8", "replace")


def uncommitted_dart_files(
    cwd: str, run_git: Callable[[str], str] | None = None
) -> list[str]:
    """The uncommitted `.dart` files under ``cwd``, sorted and deduplicated.

    Staged, unstaged and untracked alike: "uncommitted" is the caller's word for
    everything that is not in HEAD yet. Raises ValueError when git cannot answer.
    """
    status = (run_git or run_git_status)(cwd)
    wanted = {
        path for path in parse_porcelain(status) if path.endswith(SCOPE_FILE_SUFFIX)
    }
    return sorted(wanted)


def scope_mode(cmd: str, args: list[str]) -> str | None:
    """How a scope applies to this command: `expand`, `filter`, or None.

    None means the command cannot be scoped at all and the route must refuse it,
    rather than queue a job whose scope quietly did nothing.
    """
    if command_name(cmd) not in SCOPE_COMMANDS or not args:
        return None
    verb = args[0]
    if verb in SCOPE_FILTER_VERBS:
        return "filter"
    if command_name(cmd) == "dart" and verb in SCOPE_EXPAND_VERBS:
        return "expand"
    return None


def scope_refusal(cmd: str, args: list[str]) -> str:
    """Why this command cannot take an uncommitted scope, and what can."""
    verb = args[0] if args else ""
    return (
        f"scope is not supported for {cmd} {verb}".rstrip()
        + " (scoped: dart format — it expands to the uncommitted files;"
        " dart/flutter analyze and fix — they filter their output to them)"
    )


def path_filter_regex(paths: list[str]) -> re.Pattern[str]:
    """A regex matching any of ``paths``, for filtering a tool's log lines.

    Escaped, because a path is data: `.` must not match anything, and the
    forward slashes git reports are exactly the form the analyzer prints.
    """
    return re.compile("|".join(re.escape(path) for path in paths))


def make_handler(hub: ToolHub, token: str, status_url: str):
    class Handler(BaseHTTPRequestHandler):
        server_version = "toolhub/1.1"
        protocol_version = "HTTP/1.1"

        # ---- plumbing ----

        def log_message(self, format: str, *args: object) -> None:
            # The harness reads stdout for lifecycle lines only; per-request
            # noise would drown them. (The parameter is named `format` because
            # that is `BaseHTTPRequestHandler`'s own name for it.)
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

        def _discard_body(self) -> None:
            """Reads and drops a body the handler is not going to parse.

            An early return that answers before the body is consumed (a 401, or
            the 404 for an unknown tool) leaves unread bytes in the socket, and
            Windows answers that by resetting the connection — the caller sees
            a connection abort instead of the error it is owed. Only call this
            where the body has *not* been read: reading it twice would block
            forever on bytes that are already gone.
            """
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                return
            try:
                self.rfile.read(length)
            except OSError:
                pass

        def _await_and_send(
            self,
            job: Job,
            body: dict[str, object],
            tail: int,
            grep: re.Pattern[str] | None,
        ) -> None:
            """Shared tail of `/run` and `/tools/<name>`: wait, then answer.

            `wait` blocks for queue time *plus* run time, bounded by
            `timeoutSec`; when that expires the job keeps running and is
            fetched later by id. Same contract for both routes on purpose — a
            sub-tool is a job, so nothing about this changes for one.
            """
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
                    **job.to_json(tail_lines=tail, grep=grep),
                    "aheadOf": hub.ahead_of(job.id),
                },
            )

        # ---- routes ----

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            path = self.path.split("?", 1)[0]
            if path == "/health":
                # `tools` is the capability probe a client uses before calling a
                # sub-tool route: a bridge deployed before this one answers with
                # just {"ok": true}. `dartFormatExe` says whether this session's
                # `dart format` jobs are pinned to another SDK (and which one).
                self._json(
                    200,
                    {
                        "ok": True,
                        "tools": list(TOOL_NAMES),
                        "dartFormatExe": hub.dart_format_exe,
                    },
                )
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
                query = urllib.parse.parse_qs(
                    self.path.split("?", 1)[1] if "?" in self.path else ""
                )
                try:
                    tail, grep = parse_log_query(
                        one(query.get("grep")), one(query.get("tail"))
                    )
                except ValueError as error:
                    self._error(400, str(error))
                    return
                self._json(200, job.to_json(tail_lines=tail, grep=grep))
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
                self._discard_body()
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
                message = body.get("message")
                if message is not None and not isinstance(message, str):
                    self._error(400, "message must be a string")
                    return
                scope = body.get("scope")
                if scope is not None and not isinstance(scope, str):
                    self._error(400, "scope must be a string")
                    return
                try:
                    tail, grep = parse_log_query(body.get("grep"), body.get("tail"))
                except ValueError as error:
                    self._error(400, str(error))
                    return
                if scope is not None:
                    if scope != SCOPE_UNCOMMITTED:
                        self._error(
                            400,
                            f"unknown scope: {scope!r} "
                            f"(supported: {SCOPE_UNCOMMITTED})",
                        )
                        return
                    if grep is not None:
                        # Both are log filters with different owners; combining
                        # them would need a lookahead pattern whose semantics
                        # nobody could read off the response.
                        self._error(400, "pass either grep or scope, not both")
                        return
                    mode = scope_mode(cmd, list(args))
                    if mode is None:
                        self._error(403, scope_refusal(cmd, list(args)))
                        return
                    try:
                        # Computed here, at submit time, so "nothing uncommitted"
                        # costs a 400 instead of a queued job that formats the
                        # whole tree (which is what `dart format` with no paths
                        # does).
                        files = hub.uncommitted_files()
                    except ValueError as error:
                        self._error(400, str(error))
                        return
                    if not files:
                        self._error(
                            400,
                            "no uncommitted .dart files to scope this command to",
                        )
                        return
                    if mode == "expand":
                        args = [*args, *files]
                    else:
                        grep = path_filter_regex(files)
                try:
                    job = hub.submit(cmd, list(args), message=message, scope=scope)
                except ValueError as error:
                    self._error(403, str(error))
                    return
                self._await_and_send(job, body, tail, grep)
                return
            match = re.fullmatch(r"/tools/([a-z0-9][a-z0-9-]*)", path)
            if match:
                name = match.group(1)
                if name not in TOOL_NAMES:
                    self._discard_body()
                    self._error(
                        404,
                        f"no such tool: {name} "
                        f"(available: {', '.join(TOOL_NAMES)})",
                    )
                    return
                try:
                    body = self._body()
                except ValueError as error:
                    self._error(400, str(error))
                    return
                instruction = split_tool_body(body)
                try:
                    # The route's 400 layer: everything checkable without the
                    # filesystem, so a schema typo never costs a queued job.
                    arb_edit_lib.validate_instructions(instruction)
                except ValueError as error:
                    self._error(400, str(error))
                    return
                try:
                    tail, grep = parse_log_query(body.get("grep"), body.get("tail"))
                except ValueError as error:
                    self._error(400, str(error))
                    return
                job = hub.submit_tool(
                    name,
                    tool_display_argv(name, instruction),
                    make_tool_runner(name, instruction, hub.cwd),
                )
                self._await_and_send(job, body, tail, grep)
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


def open_status_page(url: str) -> None:
    """Best-effort: put the live status page in front of the human.

    The ``STATUS`` line is the durable record, but the common case is an agent
    launching this as a background job: the line scrolls out of view in a job
    that never exits, and the browser needs the random port *and* the token, so
    "read the log and paste it" is the step worth deleting.

    Never raises and never blocks the boot: a headless box, a locked-down
    default browser or a ShellExecute refusal must all degrade to the STATUS
    line rather than cost the session its toolchain server.
    """
    try:
        opened = webbrowser.open(url, new=2)
    except Exception as error:  # noqa: BLE001 - opening is a convenience
        eprint(f"TOOLHUB OPEN FAILED reason={error!r} url={redacted(url)}")
        return
    if opened:
        eprint(f"TOOLHUB OPEN opened in the default browser url={redacted(url)}")
    else:
        eprint(
            "TOOLHUB OPEN FAILED reason=no-browser-answered "
            f"url={redacted(url)}"
        )


def open_soon(url: str, delay: float = 0.3) -> None:
    """Opens the status page off the boot path, once the socket is serving.

    The listener is already bound (and its backlog accepts) before this thread
    starts, but the delay keeps the very first page load from racing
    ``serve_forever`` — a human looking at "server unreachable" on the tab that
    was just opened for them would be worse than not opening it at all.
    """
    time.sleep(delay)
    open_status_page(url)


def redacted(url: str) -> str:
    """The status URL with the token masked, for log lines and error text."""
    return re.sub(r"token=[^&\s]+", "token=***", url)


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
    env["GIT_TERMINAL_PROMPT"] = "0"
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


def format_pin_check(exe: str, timeout: float) -> bool:
    """Runs ``<exe> --version`` so a misaimed formatter pin fails *at boot*.

    The pin exists to make local formatting match CI's dart, and the whole
    failure mode it prevents is silent: a pin pointed at the wrong SDK produces
    plausible output and a red CI run. So the boot prints the version it is
    going to format with, and refuses to start when it cannot read one.
    """
    eprint(f"TOOLHUB DART-FORMAT CHECK exe={exe}")
    try:
        completed = subprocess.run(  # noqa: S603 - argv list, no shell
            [exe, "--version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            env=make_job_env(),
            creationflags=CREATE_NO_WINDOW,
            check=False,
        )
    except subprocess.TimeoutExpired:
        eprint(
            f"TOOLHUB DART-FORMAT FAILED reason=timeout after={timeout:g}s exe={exe}"
        )
        return False
    except OSError as error:
        eprint(f"TOOLHUB DART-FORMAT FAILED reason={error!r} exe={exe}")
        return False
    output = ((completed.stdout or "") + (completed.stderr or "")).strip()
    first_line = output.splitlines()[0] if output else "unknown"
    if completed.returncode != 0:
        eprint(
            f"TOOLHUB DART-FORMAT FAILED reason=exit-{completed.returncode} "
            f"exe={exe} output={output[:400]}"
        )
        return False
    eprint(f"TOOLHUB DART-FORMAT OK exe={exe} version={first_line}")
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
        help=(
            "run the boot toolchain checks before binding: `flutter --version`, "
            "plus `<exe> --version` for --dart-format when it is set (default)"
        ),
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
        "--open",
        dest="open_browser",
        action="store_true",
        default=True,
        help=(
            "open the tokenised status page in the default browser at boot "
            "(default; this is how a human following an agent-launched server "
            "finds the random port)"
        ),
    )
    parser.add_argument(
        "--no-open",
        dest="open_browser",
        action="store_false",
        help="do not open a browser: headless boxes, automation, scripted tests",
    )
    parser.add_argument(
        "--log-dir",
        default=None,
        help="directory for job logs (default: a fresh temp dir)",
    )
    parser.add_argument(
        "--dart-format",
        dest="dart_format_exe",
        default=None,
        metavar="PATH",
        help=(
            "dart executable (dart.exe) used for `dart format` jobs — pin the "
            "SDK whose version the project's CI formats with; every other "
            "command keeps the PATH toolchain"
        ),
    )
    args = parser.parse_args()

    cwd = os.path.abspath(args.cwd)
    if not os.path.isdir(cwd):
        eprint(f"ERROR --cwd is not a directory: {cwd}")
        return 2
    if args.dart_format_exe is not None:
        # A pin that is not there is a usage error, not a job that fails later:
        # the point of the flag is that `dart format` cannot pick the wrong dart.
        args.dart_format_exe = os.path.abspath(args.dart_format_exe)
        if not os.path.isfile(args.dart_format_exe):
            parser.error(f"--dart-format is not a file: {args.dart_format_exe}")
    if args.selfcheck and not selfcheck(args.selfcheck_timeout):
        return 1
    if (
        args.dart_format_exe is not None
        and args.selfcheck
        and not format_pin_check(args.dart_format_exe, args.selfcheck_timeout)
    ):
        return 1

    log_dir = args.log_dir or tempfile.mkdtemp(prefix="toolhub-")
    os.makedirs(log_dir, exist_ok=True)
    token = args.token or secrets.token_urlsafe(24)
    hub = ToolHub(cwd=cwd, log_dir=log_dir, dart_format_exe=args.dart_format_exe)

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
    status_url = f"http://127.0.0.1:{port}/?token={token}"
    eprint(
        f"TOOLHUB READY port={port} pid={os.getpid()} cwd={cwd} logdir={log_dir}"
    )
    eprint(f"TOOLHUB TOKEN {token}")
    eprint(f"TOOLHUB STATUS {status_url}")

    if args.watch_parent:
        threading.Thread(
            target=watch_parent,
            args=(hub, os.getppid()),
            daemon=True,
        ).start()
    if args.open_browser:
        threading.Thread(target=open_soon, args=(status_url,), daemon=True).start()
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

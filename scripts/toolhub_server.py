#!/usr/bin/env python3
"""tool-bridge: a session-scoped, loopback-only toolchain server.

Why this exists
---------------
Inside the DSH file sandbox (``workspace-write``), the Flutter/Dart toolchain
hangs, git writes are denied, and a Node toolchain dies on `spawn EPERM`: the
sandbox cannot create the named pipes libuv uses for child stdio, so Vite's
Windows `net use` probe, `vitest`'s default forks pool, and `esbuild` (which
Vite 7 and earlier bundle) all fail there. This server is started **once** per
session with a single ``danger-full-access`` escalation and then executes the
toolchain on the agent's behalf, answering over HTTP on a random loopback port.
The agent's HTTP calls run in the confined sandbox and cost nothing.

What it is not
--------------
It is not a shell, and it is not a privilege boundary: `dart` runs any
subcommand, so `dart run <file>.dart` already executes arbitrary code with the
access this process was granted. The narrow surface buys *recovery cost and
surprise* — a refused command is one you cannot lose work to — not privilege.
Only ``flutter``/``dart`` (any subcommand), a small guard-railed ``git`` verb set,
a named ``pnpm`` verb set, and the project's own script binaries (``vite``,
``vitest``, ``svelte-check``, ``svelte-kit``, ``tsc``) are accepted, always as an
argv list (never a shell string) and always in the working directory pinned at
startup. ``git push`` is deliberately absent: the GitHub token must never live in
a long-running process. So is `pnpm dlx`, and so is `pnpm exec` for anything but
a script binary — measured, it runs whatever it finds on PATH.

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
- ``POST /run``                   -> {"cmd","args","message","scope","long",
                                     "wait","timeoutSec","grep","tail"} -> job
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

Node toolchain
--------------
A package manager is accepted on the same terms whichever one a project uses —
`pnpm`, or `npm` for a fork whose upstream tooling is npm (ADR-0006) — running a
named verb set (`install`, `add`, `run`, `exec`, `why`, ...; `dlx`, `publish`,
`config`, `store` and `link`/`unlink` are absent on purpose) with its
cwd-retargeting flags refused. A project's own tools run directly: ``vite``,
``vitest``, ``svelte-check``, ``svelte-kit`` and ``tsc`` are resolved out of
``<cwd>/node_modules`` by reading the package's ``bin`` field, so they work on
Windows without letting a `.cmd` wrapper pull `cmd.exe` into an argv that is
supposed to have no shell. The exec forms — `pnpm exec`, `npm exec` and `npx` —
accept only one of those names, because they also run anything on PATH, and npx
fetches what it cannot find.

Two runners feed the digest: `flutter test`/`dart test`, and vitest (recognised
by its argv, or — for `pnpm run <script>`/`npm run <script>`, whose script name
is the project's own word for it — by the reporter's own markers in the log).
Both get the same known-failure split.

Long jobs
---------
A job that is expected to run until it is killed — `vite dev`/`preview`,
`vitest`'s watch mode, or a conventional `dev`/`start`/`serve`/`watch` script —
goes to its own lane instead of the queue, because a serialized queue would hold
every build behind it until somebody killed it. `"long": true` on ``/run`` says
so explicitly; the lane is otherwise inferred, and the two error directions are
not symmetric (a long job on the queue starves the session; a one-shot job on the
long lane merely occupies it until it exits).
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

# The project's own Node tools, run straight out of `<pinned cwd>/node_modules`.
# They are named here rather than reached through `pnpm exec` because that is
# what the actual commands look like (`vitest run --pool=threads`), and because
# `pnpm exec` — see below — will run anything it finds.
SCRIPT_BINARIES = {"vite", "vitest", "svelte-check", "svelte-kit", "tsc"}

# Command name -> the package that provides it, when they differ. Everything
# else is looked up under its own name.
SCRIPT_BINARY_PACKAGES = {"tsc": "typescript", "svelte-kit": "@sveltejs/kit"}

# What the bridge accepts, by executable name. `flutter` and `dart` take any
# subcommand; `git` is verb-guarded; a package manager (see PACKAGE_MANAGERS) is
# verb-guarded; a script binary is resolved inside the pinned cwd.
ALLOWED_EXES = {
    "flutter",
    "dart",
    "git",
    "npm",
    "npx",
    "pnpm",
} | SCRIPT_BINARIES

# The package managers the bridge runs. Both are here on the same terms — the
# bridge does not detect which one a project uses (the lockfile is advisory, and
# a fork may carry either), so the caller names the one its project actually
# resolves to. ADR-0006 records why the second one was admitted.
PACKAGE_MANAGERS = {"npm", "pnpm"}

# `npx` is accepted, but as an exec form rather than a verb-guarded manager: it
# *is* `npm exec` with the package argument implied. See validate_exec.
PACKAGE_MANAGER_RUNNERS = PACKAGE_MANAGERS | {"npx"}

# How a package manager's JavaScript entry point is found behind its Windows
# wrapper, as paths relative to the wrapper's own directory. `npm.cmd` ships
# next to `node_modules/npm`; a standalone pnpm ships `pnpm.exe` (used as it is)
# or a wrapper beside its package. The general fallback is
# `node_entry_from_shim`, which reads the wrapper itself — needed for a
# corepack-managed install, whose wrapper names its own path.
PACKAGE_MANAGER_ENTRIES: dict[str, tuple[tuple[str, ...], ...]] = {
    "npm": (
        ("node_modules", "npm", "bin", "npm-cli.js"),
        ("node_modules", "npm", "bin", "npm-cli.cjs"),
    ),
    "npx": (
        ("node_modules", "npm", "bin", "npx-cli.js"),
        ("node_modules", "npm", "bin", "npx-cli.cjs"),
    ),
    "pnpm": (
        ("node_modules", "pnpm", "bin", "pnpm.mjs"),
        ("node_modules", "pnpm", "bin", "pnpm.cjs"),
    ),
}

# Node's own npm ships *inside* the Node installation, next to `node.exe`, so its
# wrapper directory has no `node_modules/npm` of its own to probe. Measured on
# nvm4w: `%USERPROFILE%\nvm4w\nodejs\npm.CMD` is the wrapper and the entry is
# `%USERPROFILE%\nvm4w\nodejs\node_modules\npm\bin\npm-cli.js` — the same layout,
# one directory down, reachable through `node.exe`. Without this the layout probe
# finds nothing and only the shim reader can answer, which is the weaker of the
# two mechanisms.
NODE_INSTALL_ENTRIES: tuple[tuple[str, ...], ...] = (
    ("node_modules", "npm", "bin", "npm-cli.js"),
    ("node_modules", "npm", "bin", "npm-cli.cjs"),
)

# pnpm verbs this server will run, for a vite+svelte workflow: install a tree
# (including the dependency build scripts a *confined* install silently skips),
# run the project's own scripts, change dependencies and inspect the result.
# Excluded by omission: `dlx` (fetches and runs an arbitrary package), `publish`,
# `config`/`setup`/`self-update` (they write machine state outside the project),
# `store` (machine-global) and `link`/`unlink` (a global symlink farm, i.e. the
# same machine state by another route).
PNPM_VERBS = {
    "install",
    "i",
    "add",
    "remove",
    "rm",
    "uninstall",
    "update",
    "up",
    "upgrade",
    "rebuild",
    "dedupe",
    "run",
    "run-script",
    "exec",
    "why",
    "list",
    "ls",
    "outdated",
    "audit",
    "licenses",
}

# The npm peer of PNPM_VERBS, for a project whose upstream tooling is npm — the
# case ADR-0006 was written for. Same reasoning about omissions, with two npm
# spellings of it:
#
# - `ci` is here and is the *strict* install: it resolves only from
#   `package-lock.json` and never rewrites it, so it is the safe verb when the
#   lockfile must not move. `install` is the one that may update it.
# - `link`/`unlink`/`publish`/`config`/`init`/`pack`/`prune`/`owner`/`team`/
#   `token`/`doctor`/`cache` are absent by omission for the reasons above.
# - `test` and `start` are npm's bare-script shorthands and are normalised to
#   `run test` / `run start` at submit time (NPM_RUN_SHORTHANDS), so the long-lane
#   guess and the digest read the same argv every other script gets.
#
# Note that `ls` is *not* pnpm's `ls`: npm lists installed packages, pnpm lists
# scripts. The verb is shared; the meaning is the manager's.
NPM_VERBS = {
    "install",
    "i",
    "ci",
    "add",
    "remove",
    "rm",
    "uninstall",
    "update",
    "up",
    "upgrade",
    "rebuild",
    "dedupe",
    "run",
    "run-script",
    "exec",
    "why",
    "explain",
    "list",
    "ls",
    "outdated",
    "audit",
    "licenses",
}

# npm's bare-script shorthands: `npm test` and `npm start` mean `npm run test`
# and `npm run start`, and nothing else may be abbreviated — `npm build` is not
# a thing npm understands, so accepting it would invent a surface.
NPM_RUN_SHORTHANDS = {"test", "start"}

# Per-manager verb sets, so a refusal can name the list the caller actually
# asked about.
PACKAGE_MANAGER_VERBS: dict[str, set[str]] = {
    "npm": NPM_VERBS,
    "pnpm": PNPM_VERBS,
}

# Flags that retarget one of the bridge's two boot-scoped anchors — the pinned
# cwd (ADR-0002), and "this project, not this machine". `-C`/`--dir`/`--prefix`
# move the working directory, `-w`/`--workspace-root`/`--workspace` move it up to
# a workspace root or sideways to a workspace package that may lie outside the
# pinned cwd, and `-g`/`--global` leaves the project entirely. None is
# destructive; each just means "run somewhere this session was never pointed
# at", which is the shape the git pathspec guard refuses too.
#
# The same table serves both managers on purpose, and the two spellings of `-w`
# are why: pnpm's `-w` is `--workspace-root`, npm's is `--workspace <name>`
# (which is pnpm's `--workspace`, a name neither manager's short flag covers).
# One flag, three retargets, one refusal.
PACKAGE_MANAGER_BLOCKED_FLAGS = {
    "-C",
    "--dir",
    "--prefix",
    "-w",
    "--workspace-root",
    "--workspace",
    "-g",
    "--global",
}

# `--location` is the one blocked flag whose *value* decides: npm's
# `--location=global` targets the machine-wide prefix, while `--location=project`
# stays in the project. A name-only entry cannot express that, so it is checked
# by value in flag_refusal.
PACKAGE_MANAGER_LOCATION_FLAG = "--location"
PACKAGE_MANAGER_GLOBAL_LOCATIONS = {"global", "user"}

# Why the exec forms are narrowed rather than banned:
#
# `pnpm exec`/`npm exec`/`npx` look in node_modules/.bin *and then on PATH*:
# measured, `pnpm exec node --version` and `pnpm exec cmd /c echo hi` both work,
# and npx additionally *fetches* a package it cannot find. Left alone that is
# general command execution behind an allowlisted verb, which is the one thing
# the allowlist exists to prevent — so the exec target has to be a script binary,
# `--package`/`-p` (fetch this tarball) stays out, and shell mode stays out.
EXEC_BLOCKED_FLAGS = {"-c", "--shell-mode", "-p", "--package"}

# The long job lane. A serialized queue is the right shape for compiles and test
# runs, and the wrong one for a process that never exits: `vite dev` would hold
# the only worker until somebody killed it, starving every build and test behind
# it. Jobs on this lane are serialized among themselves instead.
LANE_QUEUE = "queue"
LANE_LONG = "long"

# Script names a project conventionally gives a server or a watcher. Detection
# cannot be exact for `pnpm run <script>` (the name is the project's choice), and
# the two error directions are not symmetric: a long job on the queue lane
# starves everything until it is killed, while a one-shot job on the long lane
# merely occupies it until it exits.
LONG_SCRIPTS = {"dev", "start", "serve", "watch", "storybook"}

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
# registry that motivated this feature — a per-project Markdown table of the
# failures a Windows machine was already red on:
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


def terminate_process(process: subprocess.Popen[bytes]) -> None:
    """Terminates a process with the handle this bridge already owns.

    `TerminateProcess` on an owned handle needs no new access, which is what makes
    this both the fallback when `taskkill` is refused and the only way to stop a
    process whose job was killed while it was still being spawned.
    """
    try:
        process.kill()
    except Exception as error:  # noqa: BLE001 - a kill must never raise
        eprint(f"ERROR terminate failed: {error}")


class Job:
    """One queued/running/finished command or sub-tool call."""

    def __init__(
        self,
        argv: list[str],
        cwd: str,
        log_path: str,
        runner: Callable[[Job], None] | None = None,
        scope: str | None = None,
        long: bool = False,
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
        # Which lane the job runs on. A long job is one expected to run until it
        # is killed; it is serialized against other long jobs instead of against
        # the queue, so a dev server cannot starve every build behind it.
        self.long = long
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

    def begin_running(self) -> bool:
        """Claims the job for its worker, or refuses if it was already killed.

        One critical section, shared with :meth:`kill`, because the two decisions
        must not interleave: a plain `status = "running"` overwrote a kill that
        landed just before it, and the process then ran while the status said it
        was alive — so nothing ever terminated it. For a dev server that is a
        process nobody can address *and* a lane that never moves again.
        """
        with self._lock:
            if self.status == "killed":
                return False
            self.status = "running"
            self.started_at = time.time()
            return True

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

        On Windows `taskkill /T` is the only thing that reaches the *tree*, but it
        is a fresh process asking for access it can be refused — under the DSH
        sandbox it fails with "access denied" while the target is alive and well.
        A refused tree kill must not leave a dev server running with nobody
        tracking it, so the handle this process already owns terminates the
        process directly. Children (esbuild's service, a forked test runner) are
        not reached that way; they exit with their parent's collapsed stdio, and
        the job's status is what the caller sees either way.
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
                completed = subprocess.run(  # noqa: S603 - argv list, no shell
                    ["taskkill", "/F", "/T", "/PID", str(process.pid)],
                    capture_output=True,
                    creationflags=CREATE_NO_WINDOW,
                    check=False,
                )
                if completed.returncode != 0:
                    eprint(
                        f"TOOLHUB KILL taskkill refused rc={completed.returncode} "
                        f"job={self.id}; terminating the process directly"
                    )
                    terminate_process(process)
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
            "long": self.long,
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
    """The result of `analyze_test_log`.

    ``flavor`` names the runner the digest came from (``flutter`` for
    `flutter test`/`dart test`, ``vitest`` for a vitest run) and is None for
    everything else — it is what decides whether the known-failure registry
    applies, since a *passing* run also has a digest.
    """

    flavor: str | None
    summary: str | None
    counts: TestCounts | None
    failures: list[TestFailure]


def empty_digest() -> TestLogDigest:
    """No digest: not a test run, or a runner this bridge does not read."""
    return {"flavor": None, "summary": None, "counts": None, "failures": []}


def is_test_run(argv: list[str]) -> bool:
    """Whether argv is a `flutter test` / `dart test` invocation."""
    if len(argv) < 2:
        return False
    return command_name(argv[0]) in ("flutter", "dart") and argv[1] == "test"


def exec_target(argv: list[str]) -> tuple[str, list[str]] | None:
    """Peel an exec form: the script binary it runs, and its own arguments.

    `pnpm exec vitest run`, `npm exec vitest run` and `npx vitest run` all mean
    "run the project's vitest", so they are one shape with three spellings.
    Returns None for anything else, including an exec form with no target.
    """
    if not argv:
        return None
    name = command_name(argv[0])
    if name == "npx":
        rest = argv[1:]
    elif name in PACKAGE_MANAGERS and len(argv) > 1 and argv[1] == "exec":
        rest = argv[2:]
    else:
        return None
    positional = [token for token in rest if token != "--"]
    if not positional or positional[0].startswith("-"):
        return None
    return command_name(positional[0]), positional[1:]


def is_vitest_run(argv: list[str]) -> bool:
    """Whether argv certainly runs vitest — the binary, or an exec form of it.

    `pnpm run test` (and `npm run test`, or the `npm test` shorthand) also runs
    vitest and cannot be told from the argv, which is what `might_run_vitest`
    plus the log sniff are for.
    """
    if not argv:
        return False
    if command_name(argv[0]) == "vitest":
        return True
    peeled = exec_target(argv)
    return peeled is not None and peeled[0] == "vitest"


def might_run_vitest(argv: list[str]) -> bool:
    """Whether argv *could* be a vitest run without naming it.

    Only a gate for the content sniff, so a `git log` or `dart analyze` job
    never opens its log looking for a reporter it cannot have.
    """
    return bool(argv) and command_name(argv[0]) in (
        PACKAGE_MANAGER_RUNNERS | {"vitest"}
    )


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


def parse_flutter_log(log_path: str) -> TestLogDigest:
    """Digest for a `flutter test` / `dart test` log.

    The authoritative count comes from the last `+passed ~skipped -failed:`
    progress line. The failure inventory comes from the `[E]` progress lines
    rather than from the `Failing tests:` block, because that block lists at
    most four entries and then "... and N more" (test_core caps it and sorts by
    path, so a failure can be evicted by alphabet) — and the `failures-only`
    reporter never writes it at all. The block is still read, but only to lend a
    suite path to an entry that has none.

    Returns {"summary", "counts", "failures"} where summary is the one-line
    digest, counts is {"passed","skipped","failed"} from the last progress line,
    and failures is [{"file","name","didNotComplete"}] in run order.
    """
    result = empty_digest()
    result["flavor"] = "flutter"
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


# --- vitest -----------------------------------------------------------------
# vitest 5's default reporter, as a job log gets it (no TTY, so no colour). The
# end-of-run summary is both the authoritative count and the only proof the run
# finished — there is no flutter-style "Some tests failed." marker:
#
#        Test Files  1 failed | 1 passed (2)
#             Tests  1 failed | 3 passed (4)
#
# A run killed mid-suite prints neither, which is why `counts is None` stays
# "see log". Anchoring on `Tests`/`Test Files` **followed by two spaces** is also
# what keeps jest's `Tests: 1 failed, 2 passed, 3 total` out.
VITEST_TESTS_LINE_RE = re.compile(r"^ *Tests {2,}(?P<body>\S.*)$")
VITEST_FILES_LINE_RE = re.compile(r"^ *Test Files {2,}(?P<body>\S.*)$")
# "1 failed | 3 passed | 1 skipped (4)".
VITEST_COUNT_RE = re.compile(r"(\d+) (failed|passed|skipped|todo)")
VITEST_TOTAL_RE = re.compile(r"\((\d+)\)\s*$")
# The separator bar is U+23AF repeated, and the `⎯⎯ Failed Tests 1 [1/1]⎯` form
# carries a counter before its closing bar, so only the head is matched.
VITEST_SECTION_RE = re.compile(
    r"^[^\w\s]{2,} (?P<name>Failed Tests|Failed Suites|Unhandled Errors) (?P<count>\d+) "
)
VITEST_FAIL_RE = re.compile(r"^ *FAIL {2,}(?P<rest>\S.*)$")
VITEST_NO_TESTS = "no tests"
# A suite that never loaded is reported the way the flutter digest reports a
# compile failure — a failure whose name starts with "loading " — so one
# registry rule can claim it on either runner.
VITEST_LOAD_PREFIX = "loading "


def looks_like_vitest(log_path: str) -> bool:
    """Whether a log carries the vitest reporter's own markers.

    Needed because `pnpm run test` says nothing about vitest in its argv, and the
    known-failure split has to apply to exactly the runs that have a digest.
    """
    try:
        with open(log_path, "r", encoding="utf-8", errors="replace") as handle:
            for raw in handle:
                line = raw.rstrip("\n")
                if (
                    VITEST_TESTS_LINE_RE.match(line)
                    or VITEST_FILES_LINE_RE.match(line)
                    or VITEST_SECTION_RE.match(line)
                ):
                    return True
    except OSError:
        return False
    return False


def split_vitest_failure(rest: str) -> tuple[str | None, str]:
    """`src/App.test.ts > add > fails on purpose` -> (path, `add > fails ...`).

    The default reporter names a failure as `<path> > <suite> > <name>`, so the
    suite path is what precedes the *first* separator and the rest is the test's
    full name — which is what a known-failure entry matches on.
    """
    head, sep, tail = rest.partition(" > ")
    if sep and tail:
        return head.strip(), tail.strip()
    return None, rest


def parse_vitest_counts(body: str) -> TestCounts:
    """The body of a `Tests  ...` summary line as counts.

    `skipped` is preferred from the trailing total rather than from the
    `skipped` token alone, so a `todo` test lands in the same "not run" bucket
    instead of disappearing from the numbers.
    """
    if VITEST_NO_TESTS in body:
        return {"passed": 0, "skipped": 0, "failed": 0}
    counts: TestCounts = {"passed": 0, "skipped": 0, "failed": 0}
    for number, kind in VITEST_COUNT_RE.findall(body):
        if kind == "failed":
            counts["failed"] += int(number)
        elif kind == "passed":
            counts["passed"] += int(number)
        else:
            counts["skipped"] += int(number)
    total = VITEST_TOTAL_RE.search(body)
    if total is not None:
        unaccounted = int(total.group(1)) - counts["passed"] - counts["failed"]
        if unaccounted >= 0:
            counts["skipped"] = unaccounted
    return counts


def parse_vitest_log(log_path: str) -> TestLogDigest:
    """Digest for a vitest run.

    Counts come from the `Tests` summary line, with the failing **suites** of the
    `Failed Suites` section folded into `failed`: a file that cannot be imported
    runs no tests at all, so its summary line reads `Tests  no tests` while the
    run is red — a digest reporting "0 passed" there would be worse than none.
    The inventory is the `FAIL` lines, complete and in run order; unlike
    `flutter test`'s `Failing tests:` block, the reporter caps nothing.
    """
    result = empty_digest()
    result["flavor"] = "vitest"
    failures: list[TestFailure] = []
    counts: TestCounts | None = None
    suites_failed = 0
    in_suites = False
    try:
        with open(log_path, "r", encoding="utf-8", errors="replace") as handle:
            for raw in handle:
                line = raw.rstrip("\n")
                section = VITEST_SECTION_RE.match(line)
                if section:
                    # Which section a FAIL line sits in is what separates "this
                    # suite did not load" from "this test failed".
                    in_suites = section.group("name") == "Failed Suites"
                    if in_suites:
                        suites_failed = int(section.group("count"))
                    continue
                fail = VITEST_FAIL_RE.match(line)
                if fail:
                    rest = fail.group("rest").strip()
                    if in_suites:
                        # `FAIL  src/broken.test.ts [ src/broken.test.ts ]`
                        file = rest.split(" [ ", 1)[0].strip()
                        failures.append(
                            {
                                "file": file,
                                "name": VITEST_LOAD_PREFIX + file,
                                "didNotComplete": False,
                            }
                        )
                    else:
                        file, name = split_vitest_failure(rest)
                        failures.append(
                            {"file": file, "name": name, "didNotComplete": False}
                        )
                    continue
                tests = VITEST_TESTS_LINE_RE.match(line)
                if tests:
                    counts = parse_vitest_counts(tests.group("body"))
    except OSError:
        return result

    if counts is not None and suites_failed:
        counts["failed"] += suites_failed
    result["failures"] = failures
    result["counts"] = counts
    # The summary line is the run's last output, so seeing it *is* reaching the
    # end: a killed vitest run never writes one.
    result["summary"] = summarize_test_run(counts, counts is not None)
    return result


def analyze_test_log(argv: list[str], log_path: str) -> TestLogDigest:
    """The digest for a job, whichever runner produced its log.

    Two runners are read — `flutter test`/`dart test`, and vitest. What a command
    *is* decides the parser, except for `run <script>`: the script name is the
    project's own word for what it runs, so there the log content is the only
    evidence. Anything else has no digest at all.
    """
    if is_test_run(argv):
        return parse_flutter_log(log_path)
    if is_vitest_run(argv) or (might_run_vitest(argv) and looks_like_vitest(log_path)):
        return parse_vitest_log(log_path)
    return empty_digest()


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
        key: value for key, value in body.items() if key not in TOOL_TRANSPORT_FIELDS
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
        # One worker per lane, one job at a time within a lane. Compiles and test
        # runs must not overlap (they fight over `build/`, `dist/` and the
        # package manager's store), while a long job — a dev server — must not
        # hold the queue while it waits to be killed.
        self._queues: dict[str, queue.Queue[Job]] = {
            LANE_QUEUE: queue.Queue(),
            LANE_LONG: queue.Queue(),
        }
        self._lock = threading.Lock()
        self._current: dict[str, Job | None] = {LANE_QUEUE: None, LANE_LONG: None}
        self._stopping = threading.Event()
        self._workers = [
            threading.Thread(target=self._work, args=(lane,), daemon=True)
            for lane in (LANE_QUEUE, LANE_LONG)
        ]
        for worker in self._workers:
            worker.start()

    # ---- submission ----

    def submit(
        self,
        cmd: str,
        args: list[str],
        message: str | None = None,
        scope: str | None = None,
        long: bool | None = None,
    ) -> Job:
        """Queues a command. `long` defaults to what the command looks like."""
        argv = build_argv(cmd, args, message)
        # Before validation, so the normalised form is what the guess, the job
        # JSON and the digest all read (ADR-0006: npm's bare-script shorthands).
        shorthand_to_run(argv)
        validate(argv)
        if long is None:
            long = wants_long_lane(cmd, list(args))
        return self._enqueue(
            Job(
                argv,
                self.cwd,
                os.path.join(self.log_dir, "pending.log"),
                scope=scope,
                long=long,
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
        """Registers a job, creates its log and hands it to its lane's worker."""
        with self._lock:
            job.log_path = os.path.join(self.log_dir, f"{job.id}.log")
            # index order: newest last
            self.jobs[job.id] = job
            self.order.append(job.id)
        open(job.log_path, "wb").close()
        self._queues[LANE_LONG if job.long else LANE_QUEUE].put(job)
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self.jobs.get(job_id)

    def list_jobs(self) -> list[Job]:
        with self._lock:
            return [self.jobs[job_id] for job_id in self.order]

    def current(self) -> Job | None:
        """The job running on the queue lane, if any (the long lane has its own)."""
        return self._current[LANE_QUEUE]

    def ahead_of(self, job_id: str) -> int:
        """How many unfinished jobs sit ahead of this one **on its own lane**.

        Counts the running job too, not just queued ones: jobs are serialized, so
        "the thing blocking me" is usually the one already running, and reporting
        0 there reads as "nothing in the way". Jobs on the other lane are not in
        the way at all, so a build sitting behind a dev server would be a lie.
        """
        job = self.get(job_id)
        if job is None:
            return 0
        with self._lock:
            ordered = [self.jobs[entry] for entry in self.order]
        pending = 0
        for candidate in ordered:
            if candidate.id == job_id:
                break
            if candidate.long == job.long and candidate.status in ("queued", "running"):
                pending += 1
        return pending

    # ---- execution ----

    def _work(self, lane: str) -> None:
        work = self._queues[lane]
        while not self._stopping.is_set():
            try:
                job = work.get(timeout=0.2)
            except queue.Empty:
                continue
            if self._stopping.is_set():
                return
            self._run(job, lane)

    def _run(self, job: Job, lane: str) -> None:
        if not job.begin_running():
            # Killed while it was still queued: there was no process to kill, so
            # the status is the only record of the caller's decision. Running it
            # now would contradict the answer `POST /jobs/<id>/kill` already gave
            # — and for a dev server that means a process nobody is tracking.
            job.started_at = job.finished_at = time.time()
            return
        self._current[lane] = job
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
            self._current[lane] = None

    def _run_command(self, job: Job) -> None:
        env = make_job_env()
        try:
            launch, extra_env = resolve_launch(
                job.argv, self.dart_format_exe, cwd=job.cwd
            )
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
            # One job at a time per lane on purpose: concurrent flutter
            # invocations fight over build/ (we have seen a locked sqlite3.dll
            # break a run), and two vite builds share `dist/` and `node_modules`.
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
                if job.status == "killed":
                    # `kill()` ran in the window between "running" and this line,
                    # when there was no handle for it to reach: the caller was
                    # told the job is killed, so the process it just spawned must
                    # not outlive that answer — a dev server nobody can address
                    # would also hold this lane forever.
                    terminate_process(process)
                exit_code = process.wait()
            job.exit_code = exit_code
            # The digest is computed *before* the terminal status is published: a
            # caller that waits on `status` is entitled to find `summary`,
            # `counts`, `failures` and `baseline` already attached, and the other
            # order let `wait:true` return a job that was `done` with a null
            # summary — a race a client cannot distinguish from a broken parser.
            digest = analyze_test_log(job.argv, job.log_path)
            job.summary = digest["summary"]
            job.counts = digest["counts"]
            job.failures = digest["failures"]
            if digest["flavor"] is not None:
                # Read now, from the pinned cwd: the registry describes the
                # project as it is at run time, and its absence is simply
                # "nothing changes". Gated on the digest's flavor, not on the
                # runner's name, so `pnpm run test` gets the same split.
                registry = load_known_failures(job.cwd)
                report = baseline_report(job.failures, digest["counts"], registry)
                job.baseline = report
                job.summary = summarize_with_baseline(job.summary, report)
            if job.status != "killed":
                job.status = "done" if exit_code == 0 else "failed"
        except FileNotFoundError:
            job.status = "failed"
            job.exit_code = 127
            job.error = f"executable not found: {job.argv[0]}"
            with open(job.log_path, "ab") as sink:
                sink.write((job.error + "\n").encode("utf-8"))

    # ---- shutdown ----

    def stop(self) -> None:
        self._stopping.set()
        for current in self._current.values():
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


def wants_long_lane(cmd: str, args: list[str]) -> bool:
    """Whether a command is expected to run until someone kills it.

    Peeling an exec form first, the shapes that are certainly long are vite's dev
    server and vitest's watch mode; a `run <script>` cannot be known (the name is
    the project's), so the conventional server/watcher names in ``LONG_SCRIPTS``
    count too. Both error directions argue for guessing: a long job left on the
    queue lane starves every build behind it until it is killed, while a one-shot
    job put on the long lane merely occupies that lane until it exits.
    `--help`/`--version` are excluded so a probe never lands there at all.

    `npm test`/`npm start` reach here already normalised to `run test`/`run
    start` by ``validate``, which is why the shorthand needs no case of its own.
    """
    parts = list(args)
    exe = command_name(cmd)
    if exe in PACKAGE_MANAGERS:
        verb = parts[0] if parts else ""
        rest = parts[1:]
        if verb == "exec":
            peeled = exec_target([cmd, *args])
            if peeled is None:
                return False
            exe, parts = peeled
        elif verb in ("run", "run-script"):
            script = next((token for token in rest if not token.startswith("-")), None)
            return script in LONG_SCRIPTS
        else:
            return False
    elif exe == "npx":
        peeled = exec_target([cmd, *args])
        if peeled is None:
            return False
        exe, parts = peeled
    if any(token in ("--help", "-h", "--version", "-v") for token in parts):
        return False
    positional = [token for token in parts if not token.startswith("-")]
    if exe == "vite":
        # Bare `vite` is the dev server; `preview` serves until it is stopped.
        return not positional or positional[0] in ("dev", "serve", "preview")
    if exe == "vitest":
        # `vitest` alone watches; `run`/`--run` is the one-shot form.
        return "run" not in positional and "--run" not in parts
    return False


def resolve_launch(
    argv: list[str],
    dart_format_exe: str | None = None,
    cwd: str | None = None,
) -> tuple[list[str], dict[str, str]]:
    """Turns an allowlisted command into a real executable invocation.

    On Windows `flutter` and `dart` are `.bat` wrappers, which CreateProcess
    cannot execute and which would drag `cmd.exe` — and its parsing rules — into
    the middle of an argv that is supposed to have no shell. Both wrappers only
    launch the SDK's own `dart.exe` (with the flutter_tools snapshot for
    `flutter`), so that is what we call directly. `pnpm` is the same problem with
    a different shape (see ``resolve_pnpm``), and a project-local script binary
    is reached the same way (see ``resolve_script_binary``).

    ``dart_format_exe`` is the boot-time **format pin**: when it is set, a `dart
    format` job launches *that* executable instead. It is an explicit path to a
    real `dart.exe` (a standalone SDK, not a wrapper), so it needs neither the
    `.bat` dance nor `FLUTTER_ROOT` — and it is checked here rather than trusted,
    because a pin that has gone missing must fail the job loudly rather than fall
    back to the formatter the pin exists to avoid.

    ``cwd`` is the pinned working directory, and only a script binary needs it:
    that is where its package is installed. It is a defaulted argument rather
    than a required one because `flutter`/`dart`/`git`/`pnpm` resolve globally;
    every job passes ``job.cwd``.

    Returns the argv to launch plus environment additions. Raises
    FileNotFoundError.
    """
    pin = dart_format_target(argv, dart_format_exe)
    if pin is not None:
        if not os.path.isfile(pin):
            raise FileNotFoundError(f"pinned dart format executable is missing: {pin}")
        return ([pin, *argv[1:]], {})
    name = command_name(argv[0])
    if name in SCRIPT_BINARIES:
        target = resolve_script_binary(cwd or os.getcwd(), name)
        return ([node_exe(), target, *argv[1:]], {})
    if name in PACKAGE_MANAGER_RUNNERS:
        return ([*resolve_package_manager(name), *argv[1:]], {})
    exe = shutil.which(argv[0])
    if exe is None:
        raise FileNotFoundError(f"executable not found on PATH: {argv[0]}")
    if IS_WINDOWS and exe.lower().endswith((".bat", ".cmd")):
        # exe is `<FLUTTER_ROOT>/bin/flutter.bat` (or dart.bat); the SDK cache
        # hangs off the same `bin`, while FLUTTER_ROOT is its parent —
        # flutter_tools appends `bin/cache` to FLUTTER_ROOT itself.
        flutter_bin = os.path.dirname(exe)
        flutter_root = os.path.dirname(flutter_bin)
        dart_exe = os.path.join(flutter_bin, "cache", "dart-sdk", "bin", "dart.exe")
        if not os.path.exists(dart_exe):
            raise FileNotFoundError(
                f"{exe} is a wrapper but its SDK dart.exe is missing: {dart_exe}"
            )
        if os.path.basename(exe).lower().startswith("flutter"):
            snapshot = os.path.join(flutter_bin, "cache", "flutter_tools.snapshot")
            if not os.path.exists(snapshot):
                raise FileNotFoundError(f"flutter_tools.snapshot missing: {snapshot}")
            return (
                [dart_exe, snapshot, *argv[1:]],
                {"FLUTTER_ROOT": flutter_root},
            )
        return ([dart_exe, *argv[1:]], {"FLUTTER_ROOT": flutter_root})
    return ([exe, *argv[1:]], {})


def node_exe() -> str:
    """The Node interpreter a script binary runs under."""
    exe = shutil.which("node")
    if exe is None:
        raise FileNotFoundError(
            "node is not on PATH — the bridge needs it to run a project's own "
            "vite/vitest/svelte-check/tsc"
        )
    return exe


def resolve_script_binary(cwd: str, name: str) -> str:
    """The JavaScript entry point of a project-local script binary.

    Not `node_modules/.bin/<name>.CMD`: that is a shell wrapper, which
    CreateProcess cannot execute — running it would drag `cmd.exe` into the
    middle of an argv that is supposed to have no shell, the same reason
    `flutter.bat` is unpacked. The wrapper's body names exactly this target
    (`node "%~dp0\\..\\vite\\bin\\vite.js"`), so the package's own `bin` field is
    read instead, which also follows pnpm's `node_modules/<pkg>` symlink into the
    virtual store.

    Raises FileNotFoundError when the package is not installed in the pinned cwd,
    or when its `bin` field points outside the package.
    """
    package = SCRIPT_BINARY_PACKAGES.get(name, name)
    package_dir = os.path.join(cwd, "node_modules", *package.split("/"))
    manifest = os.path.join(package_dir, "package.json")
    if not os.path.isfile(manifest):
        raise FileNotFoundError(
            f"{name} is not installed in {cwd}: {manifest} is missing "
            "(install the project's dependencies first)"
        )
    try:
        with open(manifest, "r", encoding="utf-8", errors="replace") as handle:
            document = json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        raise FileNotFoundError(f"cannot read {manifest}: {error}") from error
    entry = document.get("bin")
    if isinstance(entry, dict):
        entry = entry.get(name)
    if not isinstance(entry, str) or not entry:
        raise FileNotFoundError(f"{package} declares no `bin` entry for {name!r}")
    root = os.path.realpath(package_dir)
    target = os.path.realpath(os.path.join(package_dir, entry))
    if target != root and not target.startswith(root + os.sep):
        raise FileNotFoundError(f"{name} points outside its package: {entry!r}")
    if not os.path.isfile(target):
        raise FileNotFoundError(f"{name} entry point is missing: {target}")
    return target


def resolve_package_manager(name: str) -> list[str]:
    """How to launch a package manager as a real executable.

    On Windows `npm`, `npx` and `pnpm` on PATH are `.cmd` wrappers, which
    CreateProcess cannot execute. A standalone pnpm ships `pnpm.exe` and is used
    as it is; otherwise the wrapper's JavaScript entry is located — first by the
    layout the tool's own install uses (`PACKAGE_MANAGER_ENTRIES`), then by
    reading the wrapper itself, because a corepack-managed install names its own
    path. Raises FileNotFoundError.
    """
    exe = shutil.which(name)
    if exe is None:
        raise FileNotFoundError(
            f"{name} is not on PATH — install it, or run the project's scripts "
            "with its own package manager"
        )
    if exe.lower().endswith(".exe"):
        return [exe]
    base = os.path.dirname(exe)
    for parts in PACKAGE_MANAGER_ENTRIES.get(name, ()):
        candidate = os.path.join(base, *parts)
        if os.path.isfile(candidate):
            return [node_exe(), candidate]
    # Node's own npm and npx live one directory down, beside `node.exe`. Scoped
    # to those two on purpose: pnpm is never bundled with Node, and probing the
    # Node installation for it would answer with *npm's* entry whenever `which`
    # is pointed elsewhere (which is exactly how the pnpm tests fake a wrapper).
    if name in ("npm", "npx"):
        node = shutil.which("node")
        if node is not None:
            node_dir = os.path.dirname(node)
            suffix = "npx-cli" if name == "npx" else "npm-cli"
            for parts in NODE_INSTALL_ENTRIES:
                candidate = os.path.join(node_dir, *parts)
                if suffix in os.path.basename(candidate) and os.path.isfile(candidate):
                    return [node_exe(), candidate]
    entry = node_entry_from_shim(exe)
    if entry is not None:
        return [node_exe(), entry]
    raise FileNotFoundError(
        f"cannot find {name}'s JavaScript entry point behind the wrapper {exe}"
    )


def resolve_pnpm() -> list[str]:
    """`resolve_package_manager("pnpm")`, kept as its own name for callers."""
    return resolve_package_manager("pnpm")


def node_entry_from_shim(shim: str) -> str | None:
    """The JS entry a `.cmd` wrapper launches, read out of the wrapper itself.

    Needed for a corepack-managed install, whose wrapper names its own path, so
    the layout probe beside it cannot find the package.

    Written with plain string work rather than a regular expression on purpose.
    Two attempts at a pattern both failed on the same trap: `\\r\\n` inside a
    character class means the literal letters `r` and `n` in a raw string, and
    the real newline characters only in a non-raw one, so the pattern silently
    refused to match `node_modules` and read nothing at all. Splitting on the
    separators has no such hidden state.

    Two details decide whether this works on a real wrapper:

    - **Batch path variables are not paths.** Node's own `npm.cmd` writes
      `"%~dp0\\node_modules\\npm\\bin\\npm-cli.js"`, and `%~dp0` expands to the
      wrapper's directory *with* a trailing separator, while pnpm's wrapper
      writes `"%dp0%\\node_modules\\pnpm\\bin\\pnpm.mjs"` and leaves the
      separator to the surrounding text. Either way the variable is dropped and
      the remainder resolved against the wrapper's directory.
    - **The last candidate that *exists* wins**, not the last one mentioned. A
      wrapper may name several — `npm.cmd` names `npm-prefix.js` (a helper it
      shells out to first) and `npm-cli.js` (the entry it runs) — so existence,
      not position, is what separates them.
    """
    try:
        with open(shim, "r", encoding="utf-8", errors="replace") as handle:
            text = handle.read()
    except OSError:
        return None
    base = os.path.dirname(shim)
    paths: list[list[str]] = []
    for token in text.replace("\r\n", "\n").replace('"', "\n").split("\n"):
        if not token.lower().strip().endswith((".mjs", ".cjs", ".js")):
            continue
        cleaned = token.strip()
        if cleaned.upper().startswith("SET"):
            cleaned = cleaned[3:].strip()
        if "=" in cleaned:
            # `SET "NPM_CLI_JS=%~dp0\..."`: the name is not part of the path.
            _, _, cleaned = cleaned.partition("=")
        for variable in ("%~dp0", "%dp0%", "%CD%"):
            # `%~dp0` carries its own trailing separator; `%dp0%` does not.
            if cleaned.startswith(variable):
                cleaned = cleaned[len(variable) :].lstrip("\\/")
                break
        if "=" in cleaned:
            # Still an assignment, so not a path.
            continue
        parts = [part for part in cleaned.replace("/", "\\").split("\\") if part]
        if len(parts) >= 2:
            paths.append(parts)
    # Every wrapper this has to read names its entry `<tool>-cli.<ext>` — npm's
    # `npm-cli.js`, npx's `npx-cli.js`, corepack's `corepack.js` (no suffix, so
    # the fallback covers it) — while the helpers beside them do not
    # (`npm-prefix.js`). That name is the reliable signal; position is not,
    # because a wrapper may name the entry and then, later, a helper it also
    # calls. Among equally good candidates the last one wins, since a wrapper's
    # final assignment is the one its last invocation uses.
    preferred = [parts for parts in paths if "-cli." in parts[-1]]
    for parts in reversed(preferred or paths):
        resolved = os.path.join(base, *parts)
        if os.path.isfile(resolved):
            return resolved
    return None


def command_name(cmd: str) -> str:
    """The bare tool name behind a path or a Windows wrapper suffix."""
    exe = os.path.basename(cmd).lower()
    if exe.endswith((".bat", ".exe", ".cmd")):
        exe = exe.rsplit(".", 1)[0]
    return exe


def validate(argv: list[str]) -> None:
    """Refuses anything outside the documented surface. Raises ValueError.

    May *normalise* ``argv`` in place — `npm test` becomes `npm run test` — so
    the caller must treat the list it passed as possibly rewritten. One caller
    holds the spawned argv (``ToolHub.submit``), which is what makes the rewrite
    visible everywhere downstream: the job JSON, the long-lane guess and the
    digest all read the normalised form rather than the caller's typing.
    """
    shorthand_to_run(argv)
    exe = command_name(argv[0])
    if exe not in ALLOWED_EXES:
        raise ValueError(
            f"command not allowed: {argv[0]!r} (allowed: {sorted(ALLOWED_EXES)})"
        )
    if exe == "git":
        validate_git(argv[1:])
    elif exe in PACKAGE_MANAGERS:
        validate_package_manager(exe, argv[1:])
    elif exe == "npx":
        validate_npx(argv[1:])


def validate_git(args: list[str]) -> None:
    """The `git` surface: named verbs, per-verb flag guards, a message rule."""
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


def shorthand_to_run(argv: list[str]) -> None:
    """Rewrites `npm test` / `npm start` into `npm run test` / `npm run start`.

    Done to the argv list in place, before validation and before the long-lane
    guess, so the shorthand is not a second surface: everything downstream reads
    the same `run <script>` argv every other script gets. `test` and `start` are
    the only two names npm itself abbreviates — `npm build` is not a thing — so
    nothing else is accepted as one.
    """
    if len(argv) < 2 or command_name(argv[0]) != "npm":
        return
    if argv[1] in NPM_RUN_SHORTHANDS:
        argv[:] = [argv[0], "run", *argv[1:]]


def blocked_flag(token: str, blocked: set[str]) -> str | None:
    """The blocked flag a token sets, if any.

    Handles the three shapes a flag travels in: `--dir x`, `--dir=x` and a short
    one attached to its value (`-Cx`), which is why a short blocked flag is
    matched as a prefix rather than by equality.
    """
    head = token.split("=", 1)[0]
    if head in blocked:
        return head
    for short in blocked:
        if (
            short.startswith("-")
            and not short.startswith("--")
            and token.startswith(short)
            and len(token) > len(short)
        ):
            return short
    return None


def flag_refusal(manager: str, flag: str) -> str:
    """Why a retargeting flag is refused, and what the caller meant by it."""
    where = "the pinned working directory" if manager == "pnpm" else "the pinned cwd"
    return (
        f"{manager} flag not allowed: {flag!r} — it would run outside {where} "
        "(as a different directory, a workspace root, a workspace package, or the "
        "machine's global prefix); the bridge pins one cwd per session and no "
        "request can retarget it"
    )


def location_refusal(manager: str, value: str) -> str:
    """Why `--location=<global>` is refused while `--location=project` is not."""
    return (
        f"{manager} flag not allowed: '--location={value}' — it selects the "
        "machine's global prefix, which is outside the pinned project; "
        "'--location=project' is accepted"
    )


def location_value(token: str) -> str | None:
    """The value of a `--location` token, in either of its shapes.

    npm writes it as `--location=global` or as the two tokens
    `--location global`, so both have to be read to refuse the global one.
    """
    if token == PACKAGE_MANAGER_LOCATION_FLAG:
        return ""
    head, sep, tail = token.partition("=")
    if sep and head == PACKAGE_MANAGER_LOCATION_FLAG:
        return tail
    return None


def check_retargeting(manager: str, tokens: list[str], extra: set[str]) -> None:
    """Refuses a retargeting flag anywhere in a remaining-argv list.

    Stops at the `--` that ends the manager's own surface: everything after it
    belongs to the script or binary being run, where a token spelled like a
    manager flag means something else entirely.
    """
    for index, token in enumerate(tokens):
        if token == "--":
            return
        if not token.startswith("-"):
            continue
        hit = blocked_flag(token, PACKAGE_MANAGER_BLOCKED_FLAGS | extra)
        if hit is not None:
            raise ValueError(flag_refusal(manager, hit))
        value = location_value(token)
        if value is None:
            continue
        if not value:
            following = tokens[index + 1] if index + 1 < len(tokens) else ""
            value = following if not following.startswith("-") else ""
        if value in PACKAGE_MANAGER_GLOBAL_LOCATIONS:
            raise ValueError(location_refusal(manager, value))


def validate_package_manager(manager: str, args: list[str]) -> None:
    """The package-manager surface: named verbs, no retargeting, `exec` guarded.

    The verb list is an allow list (unlike `flutter`/`dart`, which take any
    subcommand) because the interesting question for a package manager is what
    it is allowed to touch, and the answer differs per verb — and, for `ls`,
    per manager.

    ``args`` is the *same list object* ``validate`` was handed (it is
    ``argv[1:]``), so a shorthand rewrite here is visible to the caller.
    """
    if not args:
        raise ValueError(f"{manager} needs a verb")
    verb = args[0]
    hit = blocked_flag(verb, PACKAGE_MANAGER_BLOCKED_FLAGS)
    if hit is not None:
        raise ValueError(flag_refusal(manager, hit))
    if verb.startswith("-"):
        raise ValueError(f"{manager} needs a verb before flags: {verb!r}")
    verbs = PACKAGE_MANAGER_VERBS[manager]
    if verb not in verbs:
        raise ValueError(
            f"{manager} verb not allowed: {verb!r} (allowed: {sorted(verbs)})"
        )
    if verb == "exec":
        validate_exec(manager, args[1:])
        return
    check_retargeting(manager, args[1:], set())


def validate_npx(args: list[str]) -> None:
    """`npx` is an exec form, not a manager: it runs, it does not install.

    `npx` **is** `npm exec` with the package named implicitly, so it gets the
    exec narrowing and none of the verbs — there is no `npx install` to allow.
    """
    validate_exec("npx", args)


def validate_exec(manager: str, args: list[str]) -> None:
    """`npm exec`/`npx`/`pnpm exec` may run a project script binary, nothing else.

    Measured: the exec forms reach `node --version` and `cmd /c echo hi` because
    they fall back to PATH, and npx fetches what it cannot find. Allowed as-is
    that would hand out general command execution behind an allowlisted name —
    the one thing this list exists to prevent (ADR-0001) — so the target has to
    be a bare script binary name. Anything else is a 403 naming the run verb.
    """
    target: str | None = None
    for token in args:
        if token == "--":
            continue
        if token.startswith("-"):
            check_retargeting(manager, [token], EXEC_BLOCKED_FLAGS)
            continue
        target = token
        break
    if target is None:
        raise ValueError(
            f"{manager} needs a script binary to run, e.g. {manager} vitest run"
        )
    if target not in SCRIPT_BINARIES:
        substitute = (
            "npm run <script>" if manager in ("npm", "npx") else "pnpm run <script>"
        )
        raise ValueError(
            f"{manager} exec target not allowed: {target!r} "
            f"(allowed: {sorted(SCRIPT_BINARIES)}) — it runs anything it finds, "
            "including things on PATH (and npx fetches what it cannot find), so "
            "only the project's own tools are accepted; run a package script "
            f"with '{substitute}' instead"
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
        server_version = "toolhub/1.2"
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
                        "commands": sorted(ALLOWED_EXES),
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
                long_running = body.get("long")
                if long_running is not None and not isinstance(long_running, bool):
                    self._error(400, "long must be a boolean")
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
                    job = hub.submit(
                        cmd,
                        list(args),
                        message=message,
                        scope=scope,
                        long=long_running,
                    )
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
                        f"no such tool: {name} (available: {', '.join(TOOL_NAMES)})",
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
        eprint(f"TOOLHUB OPEN FAILED reason=no-browser-answered url={redacted(url)}")


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
        <td>${{j.long ? '<span class="muted">long </span>' : ''}}${{j.argv.map(a => a.replace(/</g,'&lt;')).join(' ')}}</td>
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
            check=False,
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


def watch_parent(hub: ToolHub, pid: int) -> None:
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
    eprint(f"TOOLHUB READY port={port} pid={os.getpid()} cwd={cwd} logdir={log_dir}")
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

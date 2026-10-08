# The Node toolchain is a named surface, and long jobs get their own lane

**Status**: accepted (the package-manager half of this surface was widened by
[ADR-0006](./0006-npm-on-the-same-terms-as-pnpm.md), which admits `npm` and
`npx` on the same terms; every measurement recorded below still holds)

Two separate problems turned up together when the bridge grew a Vite/Svelte
surface, and they are recorded together because the second is only visible
through the first.

**The surface.** The sandbox does not merely deny writes for a Node toolchain, it
denies *pipes*: `spawn`/`exec`/`fork` with piped stdio throw `EPERM` because the
sandbox cannot create the named pipe libuv needs, while `inherit`, a file fd,
`worker_threads` and loopback TCP all work. That is why `vite` dies in its Windows
`net use` probe, `vitest` dies in its default forks pool, and `esbuild` (Vite 7
and earlier) dies spawning its service binary — measured command by command in
`docs/vite-vitest-sandbox-findings.md`. So the accepted names are the project's
own tools (`vite`, `vitest`, `svelte-check`, `svelte-kit`, `tsc`), resolved out of
the pinned cwd's `node_modules` by reading the package's `bin` field, plus a
verb-guarded `pnpm`. `pnpm exec` is accepted only for those names.

**The lane.** A serialized queue is right for compiles and test runs and wrong for
a process that never exits: `vite dev` would hold the only worker until somebody
killed it, so every build behind it waits on a server that is working as intended.
Long jobs therefore run on a second lane, serialized among themselves.

## Considered options

- **A `node` executable in the allowlist, with the tool reached by script path.**
  The smallest surface, and it makes `pnpm` unnecessary. Rejected: it fails the
  actual command shape (`vitest run --pool=threads` is what a caller types and
  what a CI workflow records), and a raw `node` makes the *argv* the trust
  boundary — `node -e`, `node -p`, and any `.mjs` in the tree — which is a wider
  and less legible surface than naming five binaries.
- **`pnpm` alone, everything through `pnpm run <script>`.** Fewest names.
  Rejected: it forces every project to declare a script before the bridge can run
  anything, and it cannot express vitest's `--pool=threads` without `--`, so the
  one flag that makes vitest work under a sandbox would be the hardest to pass.
- **`pnpm exec` as a general escape hatch.** Convenient, and measured to run
  `node --version` and `cmd /c echo hi` because pnpm falls back to `PATH`.
  Rejected: that is general command execution behind an allowlisted verb, the one
  thing the list exists to prevent (ADR-0001) — not because it grants privilege
  the bridge did not have, but because a refusal is the only thing standing
  between a fallible caller and `pnpm exec rm`.
- **Per-job `cwd`, so one bridge could serve several projects.** Same shape as
  the worktree proposal in ADR-0002, rejected for the same reason.
- **Guess the lane from the command, with no `long` flag.** Rejected: `pnpm run
  <script>` cannot be known (the name is the project's), and a wrong guess in one
  direction starves the session while a wrong guess in the other merely occupies
  the long lane. So the guess exists for the shapes that are certain (`vite dev`,
  `vitest` without `run`) and the flag overrides it either way.
- **A dev server as a bridge *sub-tool*.** It is not one: a sub-tool is a
  structured operation that finishes (ADR-0003), while this is a command whose
  expected outcome is "still running".

## Consequences

- The cwd-retargeting flags (`-C`, `--dir`, `--prefix`, `-w`, `-g`) are refused
  on every `pnpm` verb: retargeting the working directory is the one invariant
  ADR-0002 keeps, and `-g` leaves the project entirely.
- Job JSON gains `long`; `aheadOf` counts only jobs **on the caller's own lane**,
  because a build sitting behind a dev server is not in the way at all.
- The known-failure registry is keyed off the *digest's flavor* rather than the
  runner's name, so `pnpm run test` — whose argv says nothing about vitest — gets
  the same split, decided by the reporter's own markers in the log.
- Killing had to be fixed, and the fix is not cosmetic: `taskkill /F /T` is a
  fresh process asking for access, and under this sandbox it answers
  "access denied" (rc 1) while the target is alive, so the tree kill did nothing
  and the lane never moved again. The handle `Popen` already owns terminates the
  process instead — and the same fallback covers the window where a job is killed
  after it is marked running but before that handle exists. A refused kill is now
  reported as `TOOLHUB KILL`, never silent. **Superseded in part by
  [ADR-0008](./0008-a-kill-ends-the-whole-tree.md)**: the measurement above is
  about the *retired server*, which was itself a sandboxed process. The plugin
  runs in the host process instead, so `taskkill /T` is no longer refused, and it
  is now the primary kill — with the owned handle kept, exactly as this ADR
  established, as the fallback for when the sweep is refused, missing or slow.
- Vite 7 and earlier stay unusable *inside* the sandbox even with a `net use`
  shim, because esbuild must spawn a binary and that spawn cannot be stubbed. That
  is the bridge's reason to exist for those projects, not a gap to engineer
  around.

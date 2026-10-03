# Vite + Svelte toolchain inside the DSH sandbox — what fails, and why

Measured 2026-02 on Windows, DSH file policy `workspace-write`, in a minimal
Vite + Svelte project created inside the session workspace
(`.sandbox-probe/`: svelte 5.57.1, vite 8.3.2 and 7.3.6, vitest 5.0.3,
esbuild 0.28.2, node 24.19.0, pnpm 11.22.0). Every result below is an observed
exit status, not an inference.

This is decision input for "should the bridge grow a Node toolchain surface?"
(`CONTEXT.md` vocabulary; ADR-0001 says the allowlist is a guardrail).

## The mechanism

The sandbox cannot create the **named pipes libuv uses for child stdio**, so a
Node child process with piped stdio fails, and the failure mode differs by API:

| Node API | confined result |
|---|---|
| `spawnSync(cmd, args, {stdio: 'pipe'})` | returns `{error: EPERM}` |
| `spawn(cmd, args, {stdio: 'pipe'})` | **throws synchronously** `EPERM` |
| `exec(...)` / `execFile(...)` | **throws synchronously** `EPERM` |
| `fork(...)` (IPC channel is a pipe) | **throws synchronously** `EPERM` |
| `stdio: 'inherit'` / `'ignore'` / a real file fd | works |
| `worker_threads` | works |
| `net.createServer().listen(0, '127.0.0.1')` | works |
| Node's `child_process` driven from **Python** `subprocess` | works (anonymous pipes) |

The synchronous throw is what makes this expensive: `child_process.exec("net use", cb)`
never reaches its callback, so the callee's error path (`if (error) return`) is
dead code and the exception surfaces far from its cause.

Two other sandbox facts matter as much as pipes:

- **Writes outside the session workspace are denied** (`EPERM`). This is what
  kills `npm`: its cache lives in `%LOCALAPPDATA%\npm-cache`. pnpm survives
  because its store resolves to `<project>/.pnpm-store/v11` — inside the
  writable area.
- **Network is allowed** (registry fetches work; a confined process can also
  accept loopback connections).

## Observed command matrix

Run in a workspace-local vite+svelte project, cwd = project root. "polluted" is
deliberately not a column: everything below writes only inside the workspace.

| command | confined | first fatal cause |
|---|---|---|
| `pnpm install` (build scripts ignored, pnpm 11 default) | ✅ exit 0 | — (store lands in `<project>/.pnpm-store/v11`) |
| `pnpm install` with `allowBuilds: {esbuild: true}` | ❌ exit 1 | `EPERM` spawning the postinstall with pipes |
| `pnpm run <s>` / `pnpm exec <bin>` while a tree has ignored build scripts | ❌ exit 1 | pnpm 11 deps-status check refuses; `--config.verify-deps-before-run=false` clears it |
| `npm view` / `npm install` / `npx` | ❌ `EPERM` | cache under `%LOCALAPPDATA%\npm-cache` |
| `node node_modules/typescript/bin/tsc --noEmit` | ✅ exit 0 | — |
| `node node_modules/svelte-check/bin/svelte-check` | ✅ exit 0 | — (prints a soft `failed to load config from vite.config.ts`, steals no exit code) |
| `esbuild` JS API (`transformSync`) | ❌ `EPERM` | esbuild **always** spawns its binary with pipes |
| `vite build` (vite 8) | ❌ exit 1 | `optimizeSafeRealPathSync` → `exec("net use")` |
| `vite build` (vite 8) + `net use` shim | ✅ exit 0, `dist/` written | — |
| `vite dev` (vite 8) + shim | ✅ ready in 557 ms | bound `[::1]:5199`; served `/`, compiled `/src/App.svelte`, pre-bundled deps into `node_modules/.vite/deps` |
| `vite build` (vite 7.3.6) | ❌ exit 1 | esbuild, during config bundling |
| `vite build` (vite 7.3.6) + `net use` shim | ❌ exit 1 | still esbuild (`esbuild/lib/main.js ensureServiceIsRunning`) |
| `vitest run` (vitest 5, default `forks` pool) | ❌ exit 1 | tinypool forks → IPC pipe |
| `vitest run --pool=threads` + `net use` shim | ✅ ran both files | the deliberately failing assertion failed, the passing one passed |
| `vitest run --pool=threads`, no shim | ❌ | dies earlier, loading the vite config |

Two version-dependent facts do most of the work:

- **vite ≤7 is doubly blocked**: esbuild's spawn (unfixable in the sandbox — the
  binary must run) *and* the `net use` probe. `grep` of the installed
  `vite@7.3.6/dist/node/chunks/config.js:2230` shows the same
  `exec("net use", ...)` call as vite 8's `chunks/node.js:2481`.
- **vite 8 (rolldown) has no esbuild at all**, so the `net use` probe is its
  only blocker.

## Through the bridge (measured end to end)

The bridge spawns its children with **a log file** as stdout, not a pipe, so it
does not itself hit the EPERM wall. That makes one thing easy to get wrong, so it
was measured directly: **a bridge started confined is not enough for Vite.**

| command, run through a bridge booted… | confined (`--no-selfcheck`) | elevated |
|---|---|---|
| `pnpm install` | ✅ exit 0 (19.5 s) | ✅ exit 0 |
| `svelte-check`, `tsc --noEmit` | ✅ exit 0 | ✅ exit 0 |
| `vite build` | ❌ exit 1, `spawn EPERM` | ✅ exit 0, `dist/` written |
| `vitest run --pool=threads` | ❌ exit 1, config load fails | ✅ digest: `1 passed, 2 failed (1 known, 1 new)` |
| `vite dev` (long job) | — | ✅ `running`, served HTTP 200, killed on request |

The reason is where the probe lives: the bridge hands *its own* child a file
descriptor, but Vite's `net use` call runs **inside the vite process**, where the
sandbox still applies. So for Vite the elevation is load-bearing, exactly as it
is for Flutter — the bridge's job is to spend it once per session, not to avoid
it. (A confined bridge is still useful for `pnpm`/`svelte-check`/`tsc`, which is
why `--no-selfcheck` smoke tests are worth having.)

Also confirmed against the running bridge, on a real project: the launch
resolution works (`resolvedArgv` shows `node …/pnpm/bin/pnpm.mjs` and
`node …/node_modules/vitest/vitest.mjs`, never a `.cmd` wrapper), the digest and
known-failure split work for both `vitest run` and `pnpm run test` (whose flavor
is decided from the log), a long job stays `running` while the queue took a
`vite build` in 0.49 s with `aheadOf: 0`, and killing that server freed its port
with no leftover process.

## The `net use` shim (vite 8 only)

Vite runs `child_process.exec("net use")` once on Windows to map network drives
to volume letters. It is a *probe*, not a functional dependency: if it reports no
mapped drives, Vite falls back to `fs.realpathSync.native`. Answering it locally
is enough for the whole vite 8 pipeline:

```js
// cp-stub.cjs — loaded with NODE_OPTIONS=--require <abs path>
const cp = require('node:child_process');
const realExec = cp.exec;
cp.exec = function (cmd, opts, cb) {
  if (cmd === 'net use') {
    if (typeof opts === 'function') { cb = opts; }
    if (cb) process.nextTick(() => cb(null, '', ''));
    return { on() { return this; }, kill() {}, unref() {}, pid: 0 };
  }
  return realExec.apply(this, arguments);
};
```

Then, confined:

```powershell
$env:NODE_OPTIONS='--require <abs>\cp-stub.cjs'
node node_modules\vite\bin\vite.js build
node node_modules\vitest\vitest.mjs run --pool=threads
```

Honest limits: it monkey-patches `child_process.exec` in the project's process
(everything but `net use` delegates, so a plugin that shells out fails loudly
instead of silently), it needs a per-invocation `NODE_OPTIONS`, and **it cannot
rescue vite ≤7** because esbuild's spawn is not stubbable.

## Launch mechanics, if the bridge takes this on

The bridge's existing trick for Windows `.bat` wrappers generalises exactly:
resolve the shim to `node` + the real JS entry.

- `pnpm` → `node C:\Users\jason\nvm4w\nodejs\node_modules\pnpm\bin\pnpm.mjs`
  (pnpm on PATH is `pnpm.ps1`/`pnpm.cmd`; CreateProcess cannot run either).
- a script binary → `node <pinned cwd>\node_modules\<pkg>\<bin>`, i.e. the same
  target the `node_modules/.bin/<name>.CMD` shim names
  (`vite` → `bin/vite.js`, `vitest` → `vitest.mjs`, `svelte-check` → `bin/svelte-check`).

Open questions an elevated (bridge) surface must answer that a confined one does
not: the **serial queue** versus a dev server that never exits; whether the
flutter-shaped **Digest** parser grows a vitest reporter (its counts and failure
lines share nothing with `flutter test`); and that `pnpm install` run elevated
uses the user's normal store, while a confined install uses
`<project>/.pnpm-store` — the two must not be mixed in one `node_modules`.

# npm is a package manager here too, on the same terms as pnpm

**Status**: accepted

The bridge grew a Node surface with `pnpm` as its only package manager
(ADR-0004). That exclusion was circumstantial, not architectural: the project
that motivated the surface used pnpm, and `npm` was never given a reason as
strong as "the sandbox denies pipes". It has one now. A repository that is
**forked and kept in step with an upstream that uses npm** cannot be driven
through the bridge at all — `npm install` and `npm run test` are refused by
name — so the session either pays an escalation per npm command or does without
the digest, the lanes and the pinned cwd that the rest of the surface exists for.

So `npm` is admitted as a peer of `pnpm`, and `npx` as the exec form beside it,
subject to the same guards. What makes this safe enough to accept is that npm
fails inside the sandbox for the *same measured reason* pnpm does — the named
pipes libuv needs for child stdio
(`docs/vite-vitest-sandbox-findings.md`) — so the bridge's reason to exist for
one is exactly its reason for the other. The old sentence "no `npm`, no `npx`"
was a boundary drawn around our own usage, not a property of npm.

Two things are admitted only in their narrowed form:

- **`npx` is an exec form, not a manager.** It *is* `npm exec` with the package
  named implicitly, so it gets the exec narrowing and none of the verbs —
  `npx install` is refused the way `npx cowsay` is — and `--package`/`-p`, which
  fetches a package to run, is refused with `pnpm dlx`'s reason.
- **`npm test` and `npm start`** are npm's own bare-script shorthands and are
  normalised to `npm run test` / `npm run start` at submit time, so the
  long-lane guess, the job JSON and the digest all read one argv rather than
  two. Only those two names: `npm build` is not something npm understands, and
  inventing it would be a surface npm does not have.

## Considered options

- **Replace `pnpm` with `npm`.** One package manager, one verb table, no
  duplication. Rejected: it removes working capability from every project that
  already uses pnpm — including the one the surface was measured against — and
  deletes tested code paths to serve a new case.
- **Refuse `npx` and accept only `npm exec`.** A smaller accepted-name set, and
  the refusal could name `npm exec` as the substitute. Rejected: `npx` is what
  npm's own documentation and every tutorial use, so the cost is a round trip per
  occurrence in exchange for one fewer name, and the narrowing is identical.
- **A separate, narrower verb set for npm** (`install`/`ci`/`run`/`exec` only).
  Rejected: two verb tables for one concept invite the reader to assume a
  difference exists where none does. The two sets differ only where the tools
  differ in fact — npm has `ci`, pnpm does not; npm's `ls` lists packages where
  pnpm's lists scripts.
- **Detect the project's package manager from its lockfile at boot** and refuse
  the other. Rejected: it makes the surface project-scoped instead of
  session-scoped, and it introduces a failure mode for the case that motivated
  the change — a fork that carries both `package-lock.json` and
  `pnpm-lock.yaml`. The lockfile stays advisory and the caller chooses, which is
  the same posture the bridge takes toward every other project convention.
- **`npm link`/`npm unlink`,** for symmetry with the verb list. Rejected for the
  reason `dlx`, `config` and `store` are absent: both write a machine-global
  symlink farm outside the pinned project.

## Consequences

- **One guard, two managers.** The retargeting refuses are a single table:
  `-C`/`--dir`, `--prefix`, `-w`, `--workspace-root`, `--workspace`,
  `-g`/`--global`. `-w` is why it is one table and not two — pnpm's `-w` means
  `--workspace-root`, npm's means `--workspace <name>`, and pnpm's `--workspace`
  was missing from the original list. `--location` is the one flag judged by its
  *value*: `=global`/`=user` target the machine prefix, `=project` does not.
- **A project's lockfile may be written by the manager it does not use.** Nothing
  stops `npm install` in a pnpm repository, and a `package-lock.json` appears.
  That is the caller's call, deliberately; `npm ci` is the strict install that
  cannot rewrite the lockfile, and it is accepted for exactly that reason.
- **Resolving npm needed a third mechanism.** `npm` and `npx` on Windows are
  `.cmd` wrappers, and Node ships npm *inside itself*, one directory below the
  wrapper, so the `node_modules`-beside-the-wrapper probe pnpm uses finds
  nothing. The resolver now also probes beside `node.exe`, and the shim reader
  had to learn two things it never handled: `%~dp0` is a batch variable rather
  than a path, and `SET "NAME=%~dp0\..."` puts an assignment in front of the
  path. Measured: before that, no real npm or npx wrapper on this machine could
  be read by the shim reader at all, and only the probe was keeping them working.
- The shim reader prefers a candidate named `<tool>-cli.<ext>`, because a
  wrapper may name a helper *after* the entry it runs. Existence alone does not
  separate them, and neither does position.
- **The test fixtures had to stop leaking the machine's toolchain.** Patching
  `which("npm")` alone left the Node-install probe answering with the real
  Node's npm, so three launcher tests passed without touching their own fixture.
  Pinning `which("node")` too is what makes them prove anything.

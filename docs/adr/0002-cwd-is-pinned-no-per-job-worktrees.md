# The working directory is pinned; there is no per-job cwd or baseline worktree

**Status**: accepted

Every job runs in the directory the bridge was started with, and no request can
change it. The obvious next feature — "run one command in a temporary worktree
checked out at another commit", for answering *was this test already failing
before my change?* — is therefore deliberately absent, because it would require a
per-job `cwd` and a new git verb, carve an exception into the one invariant that
makes the bridge predictable, and add a worktree lifecycle (locks, per-worktree
`build/`, a `pub get` per baseline) to answer a question that per-path restore
already answers for the common case.

## Considered options

- **Per-job `cwd` restricted to descendants of the pinned directory, plus
  `git worktree add/remove`.** The full capability. Deferred: new lifecycle and
  a weakened invariant, for a question that comes up rarely.
- **Allow `git worktree` verbs and let the caller manage lifecycle.** Smaller,
  still breaks the one-directory rule, and leaves stale worktrees and held locks
  for a human to clean up.
- **Allow `git restore --source=<rev>` (path-scoped baselines).** Nearly free and
  currently refused with the rest of `--source`; it answers "the parent commit's
  version of *these files*" but not "a coherent tree at that commit" (a changed
  `pubspec.yaml` needs its own `pub get`), so it would be a half-answer that
  looks like a whole one.

## Consequences

- The sanctioned baseline experiment is **backup-and-restore**: copy the dirty
  files to a scratch directory inside the workspace (writes there are already
  permitted), `git restore -- <paths>`, run the job, copy the files back. It uses
  only what the bridge already allows, and it answers the question for
  *uncommitted* work — which is what a failing slice usually is.
- DSH already runs sessions inside per-session git worktrees
  (`~/.dsh/worktrees/<id>/<project>`), so worktree-per-isolation is a platform
  facility, not something the bridge should grow a second copy of.
- Revisit this when baseline attribution *of a different commit* recurs as a real
  cost — that is the trigger, not the existence of the idea.

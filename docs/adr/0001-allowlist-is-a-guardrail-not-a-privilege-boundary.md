# The allowlist is a guardrail, not a privilege boundary

**Status**: accepted

The bridge accepts only `flutter`, `dart` and six git verbs, and the temptation is
to read that as a security boundary and tighten it further. It is not: `dart`
takes any subcommand, so `dart run <file>.dart` executes arbitrary code with the
access the plugin runs with, and a hostile caller never needed
`git reset --hard`. What the narrow surface actually buys is a bound on
*recovery cost and surprise* for a fallible but well-intentioned caller — a
command the bridge refuses is one nobody can lose work to.

## Consequences

- Refusals are argued in terms of recovery cost and surprise, not in terms of
  privilege. `git restore -- <path>` discards uncommitted work irrecoverably and
  is allowed anyway, because the caller named what it destroys; `restore .` is
  refused for the same reason it would be refused by a careful human.
- Documentation must stop implying containment. `README.md` said "arbitrary
  command execution" was *deliberately absent*; what is absent is an *accepted
  executable name* for it. The bridge is not a sandbox, and DSH's sandbox is not
  a session-wide cage either: it is applied per capability call, so it confines
  the harness's own file and shell work rather than the process the plugin runs
  in.
- The real trust decision is **installing the plugin into a profile**, not the
  verb list and no longer any per-session approval. The sandbox wraps one argv at
  a time: `ctx.sandbox.confine()` takes the exact argv a *consumer* — the shell
  tools — is about to spawn, and hands back the argv to spawn in its place, with
  the policy carried per call. The harness process itself is therefore never
  confined, and neither are its children, which is why a plugin's `flutter`,
  `dart` and `git` children run at all. The escalation did not disappear by being
  circumvented: the thing it was asked for no longer exists, because nothing is
  confined per session.
- What that trades is worth stating plainly. The model can run the toolchain in a
  conversation with no approval at all, so the refusal list is the *only*
  remaining bound — and it is still a guardrail in the sense above: a bound on
  recovery cost and surprise, not on reachability. In place of the per-session
  click there is one deliberate human act, recorded in the profile's
  configuration, and it is removing the plugin from that profile — not a
  request — that removes the capability
  ([ADR-0007](./0007-the-plugin-is-the-bridge.md)).
- A future proposal to "harden" the surface (narrow `dart` to a verb allow list,
  refuse `dart run`) must show what work it would make impossible, because it
  buys no security.

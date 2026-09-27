# The allowlist is a guardrail, not a privilege boundary

**Status**: accepted

The bridge accepts only `flutter`, `dart` and six git verbs, and the temptation is
to read that as a security boundary and tighten it further. It is not: `dart`
takes any subcommand, so `dart run <file>.dart` executes arbitrary code with the
access the bridge was granted at boot, and a hostile caller never needed
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
  executable name* for it. The bridge is not a sandbox, and DSH's file sandbox is
  what confines the session.
- The real trust decision is the boot approval, not the verb list: once the
  process is elevated, it holds that access for its lifetime. That is why the
  escalation is asked for once, explicitly, and why the human is shown the
  status page at boot.
- A future proposal to "harden" the surface (narrow `dart` to a verb allow list,
  refuse `dart run`) must show what work it would make impossible, because it
  buys no security.

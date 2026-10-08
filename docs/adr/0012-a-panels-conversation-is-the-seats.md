# A panel's conversation is the seat's, not the opener's

**Status**: accepted

Two ways into the tool-bridge panel, one of which showed nothing. Clicking the
icon on the composer row gave a working panel; opening the same page from the
right sidebar — the guide's own capsule for this type — gave `Jobs (0)` for a
conversation that had run four jobs, `Lanes 0/0`, and `no working directory yet`.
Every time, at every point in the session.

It was not a display bug and not a host bug. Measured against the running
daemon, the host answered both questions correctly:

```
GET /toolbridge/api/state?sessionId=<the conversation>   → sessionId: …, jobs: 4
GET /toolbridge/api/state?sessionId=                      → sessionId: null, jobs: []
```

The panel had asked the second question. It read its conversation off the tab's
navigation parameters (`useTabInfo().tab.navigation.params.sessionId`), and a
page opened from the sidebar's own guide carries none: `GuideBody` picks a
capsule and calls `tab.actions.openTab(kind, { replaceTab: true })`, and
`defaultSeed` seeds a pane with a kind alone. The composer row was the only
opener that passed a parameter, because it was the only one that *could* — the
dock's `inject` hands it the session. So the panel fell back to
`fetchState(sessionId ?? '')`, the host's `/state` read that empty id as "the
conversation on screen, whichever it is", found no single live session to name,
and returned the panel's view of nothing. A well-formed empty panel is what the
user saw.

The parameter existed for a reason that was itself the mistake: `SidebarRight`
could not tell a tab body which conversation it was in, so the opener had to
carry it. That is not true of a session-scoped slot, and the same
misunderstanding put the "only live session" guess in the host.

## Decision

**A tab body's conversation comes from its own seat, and the route never guesses
one.**

Three parts, and each removes a way for the panel to be about nothing:

- **The body is handed its session.** `sidebar.right.pane.tab` is scoped
  `session`, so the framework resolves the scope and passes its key to the
  entry's `inject` factory — the same shape the shipped sidebar types use
  (`ui-sidebar-files`' `filesFace(sessionId, actions)`). The registration now
  hands it straight through, and the panel reads `sessionId` off its props.
  What the scope resolves is the pane the tab is drawn in: `SidebarRight` wraps
  every pane's body in `SessionProvider session={view.reference}`, and
  `ui-session`'s standard binding materializes `key: binding.sessionId` with
  `props: { sessionId }`. A strict session slot rendered without a binding is a
  `SlotAssemblyError`, not an empty id, so a mounted panel always has one.
- **The open carries no conversation.** `openPanel` calls
  `openTab(PANEL_KIND)`; the type declares no navigation parameters, and the
  composer row's opener no longer takes a session it does not need. There is no
  second source to disagree with the first — the pane is authoritative, and a tab
  cannot move between sessions anyway (the drag boundary checks the owning
  seat's `data-sidebar-right-session`).
- **`/state` requires the id.** An empty `sessionId` is a 400, exactly as
  `/toggle` has always refused one, and `SessionSwitches.state` lost its
  `soleLiveSession()` fallback and its nullable `sessionId`. If the browser half
  ever asks "no conversation" again, the panel says so; it does not get an empty
  job list that reads like "nothing has run".

## Considered options

- **Fall back to the sole live session on the host** (the shipped state, before
  the client fix). Rejected: it *was* the silent answer. It is right only when
  exactly one session is live, and the panel reached it precisely in the case
  where the client had no idea which conversation it was in.
- **Keep the parameter as a fallback beside `props.sessionId`.** Rejected: two
  sources for one fact, one of which is absent exactly when it is needed, and
  then a cache/restore path where the two can disagree (a tab record survives in
  per-session storage; a navigation parameter is captured at open time).
- **Read the pane's session off the DOM** (`[data-sidebar-right-session]`, which
  the shell does keep on the pane's owner element). Rejected: the framework
  already hands the body the same value through the scope, and reading layout
  attributes from a component is a dependency on markup that is not a contract.
- **Let the host infer the conversation** from the job ledger or the directory.
  Rejected: it would show another conversation's jobs whenever two ran in one
  directory — the panel is per conversation, and lanes, not jobs, are what one
  directory shares.
- **Give the tab type a `multiple`/param-bearing opener for the guide entry** so
  the guide could pass a session. Rejected: the guide's capsule is not a
  privileged opener, and a type that works only from one of its doors is the bug
  restated.

## Consequences

- Both entry points show the same panel, and so does a pane restored from
  storage or by undo: the conversation is the pane's, which is what was restored.
- `/state` without a session id is a `bad-request`; `PanelState.sessionId` is a
  string, never `null`. The plugin no longer has a code path that answers about a
  conversation nobody named.
- A body that needs its conversation now has one documented way to get it
  (`inject: (sessionId) => …`), which is also the way the panel row above the
  composer gets it.
- The residual gap is stated rather than implied: the seat's session is proven
  from the shell's own source (`runInject` pushes `binding.key`; `SessionView`
  binds the pane's reference) and from the sources of this repo — a click on the
  guide capsule in a live browser is the end-to-end check, and the reviewer's
  own click is what closes it.

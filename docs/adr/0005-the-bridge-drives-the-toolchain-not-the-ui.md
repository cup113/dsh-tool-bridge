# The bridge drives the toolchain, not the UI

**Status**: accepted

A model asked to verify a UI it just built needs to *look at it and click it* —
to catch the entry point nobody can reach and the screen that is merely ugly,
not just the assertion that returns false. That is a live, stateful
conversation with a rendered page, and it is the one shape the bridge's models
cannot express: a **Job** is a command plus a log that ends (ADR-0003), a
**Long job** is a command whose expected outcome is "still running"
(ADR-0004), and a **Sub-tool** is a structured operation that finishes. A
browser that is navigated, clicked and screenshotted across many turns is none
of the three, and forcing it into the queue would buy serialization the
browser does not need.

So the driving is deliberately **not** a bridge capability. The browser belongs
to `@playwright/mcp`, reached as native harness tools through
`@deepseek-ai/dsh-mcp-client` (tools named `mcp__ui__browser_*`), and the
bridge keeps doing what only it can: running the **App under test** — the
`vite dev` long job whose `net use` probe dies inside the file sandbox — in the
**Pinned cwd**, with the single boot **Escalation**. The walkthrough splits
along the line the bridge already draws: **Running** is the bridge's, **Driving**
is the browser's.

What decides it is the tool surface, not the pictures. Sight was never the
missing piece — the harness already reads a local image file as an image — so a
screenshot arriving as a durable image block instead of a file plus a read
(evidence: `dsh-mcp-client/lib/index.js` admits and stores MCP image blocks;
`README.md`: "Images are supported when the current model accepts image input")
is a *convenience*, one tool call instead of two, and nothing more. The
capability is the rest of the surface: an accessibility snapshot with stable
element refs, auto-waiting on every action, and first-class form, upload,
dialog, console, network and video tools. Writing that against CDP by hand is
the work this decision declines to do.

## Considered options

- **A CDP client inside the bridge** (`websockets`-less: a hand-rolled RFC 6455
  client plus the Page/DOM/Runtime/Input/Accessibility domains, ~1k lines in
  `scripts/`, keeping the stdlib-only invariant). Rejected: it is the largest
  surface in the repository to reimplement the least interesting half of a
  maintained tool — no auto-waiting, no selector engine, no accessibility
  snapshot format — and every observation it produces is still a file the model
  has to read. Its one real advantage, zero resident token cost, is bought more
  cheaply below.
- **A per-launch overlay** (`dsh --profile web --patch browser-mcp.profile-row.yml`).
  This works — `--patch` is a repeatable launcher flag that composes one extra
  overlay for that boot only, and `dsh-mcp-client` declares no `dsh.bundle`, so
  an install without a row loads nothing. Rejected on the caller's constraint,
  not on the mechanism: it makes "test a UI today" a different start command,
  and a capability that needs its own ritual is one the model will not reach
  for. The resident cost is accepted instead (below).
- **A dedicated `ui-test` profile.** Same objection in a stronger form: it
  moves the token cost off everyday sessions but adds a "start the right
  profile" habit, and the browser tools would then be absent exactly in the
  session where the model just wrote the UI and wants to check it.
- **Bridge-owned browser sub-tools** (`/tools/browser-click`, ...). Rejected:
  it is the CDP client above plus a **Job** the browser session is not — the
  queue and the digest would both be wrong about it, and the state would have
  to live in the server that ADR-0002 keeps deliberately cwd-pinned and
  stateless between jobs.
- **Flutter desktop live driving.** Rejected as unavailable, not as unwanted:
  `flutter_driver` is superseded by `integration_test` (Flutter's own
  migration guide), which is script-driven, and outside the test bindings the
  Dart VM service offers a screenshot extension but **no input injection** — a
  desktop app could be watched and not clicked. `integration_test` itself needs
  no bridge change: `flutter test integration_test -d windows` is an ordinary
  `/run` job, and `kelivo`/`cuplivo` already carry `integration_test/`.
- **Making script-driven E2E the deliverable.** Not rejected — it already
  works (`pnpm run <e2e script>`, `flutter test integration_test`) and stays
  the way a walkthrough's finding is turned into a regression test. It is
  simply not the missing capability: writing a spec and reading a digest is a
  **Job**, and it was never blocked.

## Consequences

- **A resident cost is now part of the profile.** Every session of the profile
  that carries the row pays the tool schemas of playwright-mcp's core set plus
  the enabled capabilities (vision, devtools) on every request — the
  `dsh-mcp-client` README states this explicitly ("Tool definitions add tokens
  to every model request"). Measured against the real server: **44 tools** with
  `--caps=vision,devtools`, roughly 25 for core alone. The prefix is stable
  while the discovered set is unchanged, so KV-cache reuse survives; dropping a
  capability from `browser-mcp.profile-row.yml` is the knob if the cost bites.
- **The plugin is pinned to the harness's own version, deliberately.** The
  registry's default tag for `@deepseek-ai/dsh-mcp-client` is **`0.0.1-rc.1`** —
  an older line whose peers (`@deepseek-ai/dsh-tools ^0.0.1-rc.1`) do not match a
  0.1.x harness and which contains no image-admission code at all — so a bare
  `dsh plugin add @deepseek-ai/dsh-mcp-client` installs a plugin that cannot do
  the one thing this decision depends on, silently. The row's install line pins
  the harness's version (`dsh --version`) instead. Measured on the same run: the
  `msedge` channel launches with no browser download, and
  navigate → snapshot → click-by-ref → screenshot works end to end.
- **The browser is not a Job, a Lane or a Sub-tool.** It has no log, no digest,
  no `aheadOf` and no status-page row, and it must not grow one: `/jobs` is the
  bridge's ledger of commands, and a browser session in it would be a category
  error. Its lifecycle is the harness's — it dies when the harness restarts,
  exactly like the bridge dies with the session (`--watch-parent`).
- **Artifacts leave the workspace on purpose.** Video, traces and PDFs are
  written to the row's `--output-dir`, outside any session workspace, because
  they are files for the human and are copied in deliberately before
  presentation. A screenshot may travel as an image block instead of a file,
  which saves a step and decides nothing — the harness reads a local image
  either way. The copy-back is the model's step, taught in SKILL.md §7.
- **The setup is a hand-maintained profile row.** Because `dsh-mcp-client`
  declares no `dsh.bundle`, `dsh plugin add` installs the package and nothing
  more; the insert list in `docs/browser-mcp.profile-row.yml` is what loads it,
  and the patch semantics make a wrong shape fail with a warning rather than an
  error — so the row is versioned in this repository and verified with
  `--dump-config`.
- **Sight arrives two ways, and neither is privileged.** A screenshot is an
  image block in the tool result when the model admits images, and otherwise the
  same file in the output directory read with the harness's image tool — which
  the harness could already do before any of this. The rule that survives is
  about the claim, not the channel: a walkthrough must never report having seen
  a page it only has a path to.
- **Flutter is documentation, not code.** SKILL.md carries what is true today:
  the `integration_test` recipe through `/run`, the experimental
  flutter-web-plus-vision note (a canvas has no DOM; coordinate clicks are the
  only pointer), and the reason desktop live driving is out.

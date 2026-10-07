# The plugin is the bridge

**Status**: accepted

The toolchain server became a plugin, and every property that made the server
necessary is now a property of where the work runs. The old answer was not merely
inconvenient, it was wrong in fact. `README.md` argued the bridge had to run
*beside* the harness, "precisely because it must not be subject to that sandbox
itself", and it did not have to: DSH's sandbox is applied **per capability
call** — `ctx.sandbox.confine()` takes the exact argv a *consumer* (the shell
tools) is about to spawn and hands back the argv to spawn in its place, with the
policy carried per call — so the harness process itself is never confined and
neither are its children. A plugin's `flutter`, `dart` and `git` children run
unconfined for exactly the reason the server's did.

That dissolves the HTTP layer rather than moving it. The socket, the bearer
token, the status page, the parent watchdog, the boot self-check and the
per-command JSON templates existed for one purpose: reaching work that was
already outside the sandbox from a process that was inside it. With the work in
the same process, there is nothing to reach — and the price of reaching it had
been paid on every call, in tokens, by a skill that taught the model to read a
port and a token out of job output, build a JSON body and nest three timeouts.
The two tools the plugin registers replace `/run` and `/tools/arb-edit`
outright; what is worth recording is what replaced everything around them.

## Considered options

- **Keep the server and have the plugin call it.** The smallest change to a
  working system, and the tools would be native from the model's side. Rejected:
  it keeps an entire transport — socket, token, port, watchdog, status page —
  for a boundary that is not there, and it keeps charging the model the tokens it
  costs to be taught that transport.
- **Run the toolchain through the harness's own shell tools with a wider mode.**
  No new code at all. Rejected: that is the per-command escalation this whole
  repository exists to remove, and the caller cannot grant it to itself.
- **A separate unconfined engine process the plugin drives over a pipe.** Keeps
  the engine out of the harness's lifetime, which is the one thing in-process
  work gives up. Rejected: it reintroduces the transport, the lifecycle and the
  watchdog it was meant to avoid, and the two properties that carry the work
  here — the job is owned by the calling session, and the archive admission stops
  it — exist only in-process.

## Consequences

- **`ctx.jobs` replaces the job ledger, the output ring and the kill path.** A
  job is a registry job of `kind: 'bridge'`, so the roster, the retained output
  and the kill are the registry's ideas rather than the server's: the engine
  keeps its own UTF-8 log file beside them, and one `job_kill` by the same id
  reaches the same process the retired `/jobs/<id>/kill` did.
- **The harness's own job roster, its `job_output`/`job_list`/`job_kill` tools
  and its completion notices replace the status page.** The notices are the part
  the status page never had: a background job that settles wakes the conversation
  that owns it, instead of waiting to be polled.
- **The jobs registry's Workspace archive admission replaces the parent watchdog
  (`--watch-parent`).** Archiving a conversation stops that conversation's jobs
  — a bound the watchdog could never express, because it watched a *process*, not
  a conversation, and a process that outlived its session had nobody left to read
  its log or stop it.
- **The plugin's lifecycle replaces `/stop`.** Unloading the plugin, or ending
  the harness, takes the engine, its lanes and its children with it; there is no
  separate process to remember to close.
- **Lanes are keyed by working directory, not by session.** The retired server
  was one bridge per session, so two conversations on one project held two
  independent queues and could run two Flutter builds over one `build/`
  directory — the corruption the queue exists to prevent, reintroduced by the
  process boundary. One harness now owns one lane set, keyed by directory, so
  that cannot happen. The cost is stated rather than hidden: a long build in one
  conversation delays a build in another conversation on the same directory,
  exactly as it already delays a build in its own.
- **Install is the trust decision.** With no per-session approval there is no
  per-session trust step left, and this ADR does not pretend otherwise:
  installing the plugin into a profile is the one deliberate human act, recorded
  in that profile's configuration, and after it the model can run the toolchain
  in a conversation with no approval at all. What bounds that is the refusal
  list — a guardrail about recovery cost and surprise, never a privilege boundary
  ([ADR-0001](./0001-allowlist-is-a-guardrail-not-a-privilege-boundary.md)) — and
  the fact that removing the plugin from the profile removes the capability.
- **What deliberately did not come across.** The POSIX fallback nobody had
  exercised: Windows is the supported platform now, stated as such rather than
  carried as untested code. The branches the old surface never reached: their
  subject was the transport, and it is gone with it. And the token, port and
  watchdog machinery, for the same reason — nothing needs a loopback socket once
  the caller is in the same process.
- **Honest limits.** An in-process engine dies with the harness, so a background
  job is not a thing that outlives `dsh`; the old server could *in principle*
  have been left running — it died with its parent only because `--watch-parent`
  asked it to — at the cost of an orphan holding the elevated access with nobody
  left to read it. That is a real thing given up, and it is given up on purpose. The
  other limit is coupling: the plugin's peers are the harness packages it loads,
  pinned at the harness version it was built against, so a harness upgrade is a
  rebuild and reinstall of the plugin rather than a swap of a package that talked
  over HTTP and therefore cared much less about the version on the other side.

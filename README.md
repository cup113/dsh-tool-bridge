# dsh-tool-bridge

A session-scoped, loopback-only toolchain server for DSH sandboxed sessions.
It is started once per session with a `danger-full-access` escalation and then
runs `flutter`/`dart` (any subcommand) and a restricted `git` verb set on the
agent's behalf over HTTP, so the confined agent does not pay an approval per
command. It also serializes jobs (concurrent Flutter runs fight over `build/`),
captures UTF-8 logs, and can kill a hung job's whole process tree.

## Run

```powershell
python -u D:\Projects\dsh-tool-bridge\scripts\toolhub_server.py `
  --cwd "<session workspace>" --watch-parent
```

Started plainly it fails its boot self-check on purpose (the sandbox denies the
SDK lockfile write); that failure is the evidence for retrying the same command
with `danger-full-access`. See the skill for the API and the client snippets.

## Where the rest lives

- Skill entry (what DSH discovers, with the API reference and troubleshooting):
  `~/.dsh/skills/tool-bridge/SKILL.md`
- This file's `scripts/toolhub_server.py` is the canonical program; edits here
  are what run. The skill entry holds no code.

## Deliberately absent

`git push` (no GitHub token in a long-running process), destructive git, and
arbitrary command execution. There is no detached mode and no build-cache
copying between worktrees (CMake/ninja state is path-keyed; the expensive caches
are already machine-global).

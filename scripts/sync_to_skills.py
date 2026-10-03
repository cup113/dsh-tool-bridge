"""Deploys this project to the DSH skill root (SKILL.md and the scripts only).

The repository is the source of truth; DSH discovers and loads the copy under
~/.dsh/skills/<skill-name>/SKILL.md, where <skill-name> comes from this
project's SKILL.md frontmatter (not from the repository directory name — the two
differ on purpose here: the repo is `dsh-tool-bridge`, the skill is
`tool-bridge`). Run this after changing anything:

    python scripts/sync_to_skills.py             # deploy
    python scripts/sync_to_skills.py --dry-run   # show what would change

The payload is an **allow list**, not a list of exclusions: `SKILL.md` plus
`scripts/`. That direction matters, because the failure modes are not symmetric.
A deny list silently deploys whatever nobody thought to exclude — it had been
shipping `.gitignore`, `LICENSE`, `ruff.toml`, `.github/` and `__pycache__/*.pyc`
into the skill, and a scratch tree that happened to sit in the repository would
have gone with them, at any size. An allow list can only ever ship too little,
and a file the skill needs but does not get fails loudly the moment the server
starts. The deployed tree is also pruned to the payload, so removing a file here
removes its deployed copy.
"""

from __future__ import annotations

import argparse
import filecmp
import os
import re
import shutil
import sys

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The whole payload: files at the repository root, plus everything under these
# directories. Nothing else in the repository is deployed.
PAYLOAD_FILES = {"SKILL.md"}
PAYLOAD_DIRS = {"scripts"}

# Compiled artefacts are never deployed, even inside the payload.
EXCLUDE_DIRS = {"__pycache__"}
EXCLUDE_SUFFIXES = (".pyc", ".pyo")

# The destination is not a repository, and is never treated as one.
PRUNE_SKIP_DIRS = {".git"}


def skill_name(root: str) -> str:
    """The `name:` of SKILL.md frontmatter — the directory DSH will look in."""
    try:
        text = open(os.path.join(root, "SKILL.md"), encoding="utf-8").read()
    except OSError:
        return os.path.basename(root)
    match = re.search(r"^name:\s*(.+)$", text, re.MULTILINE)
    if match:
        name = match.group(1).strip().strip("\"'")
        if name:
            return name
    return os.path.basename(root)


def project_files(root: str) -> dict[str, str]:
    """The payload: `{relative path: absolute path}`, nothing else."""
    found: dict[str, str] = {}
    for name in sorted(PAYLOAD_FILES):
        full = os.path.join(root, name)
        if os.path.isfile(full):
            found[name] = full
    for top in sorted(PAYLOAD_DIRS):
        base_dir = os.path.join(root, top)
        if not os.path.isdir(base_dir):
            continue
        for base, dirs, names in os.walk(base_dir):
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
            for name in names:
                if name.endswith(EXCLUDE_SUFFIXES):
                    continue
                full = os.path.join(base, name)
                found[os.path.relpath(full, root)] = full
    return found


def prune_empty_dirs(dest: str, dry_run: bool) -> None:
    """Removes directories that the prune emptied, deepest first.

    Without this a deployment that used to carry `.github/workflows/` would keep
    the empty directories behind, which reads as "still deployed".

    The emptiness test is `os.listdir`, not the walk's own `dirs` list: that list
    is captured before this function removes anything, so a parent whose only
    child was just deleted still looks occupied to the walk. The filesystem is the
    only authority on what is left.
    """
    for base, _dirs, _names in os.walk(dest, topdown=False):
        if base == dest or os.path.basename(base) in PRUNE_SKIP_DIRS:
            continue
        try:
            if os.listdir(base):
                continue
        except OSError:
            continue
        if not dry_run:
            os.rmdir(base)


def main() -> int:
    parser = argparse.ArgumentParser(description="deploy to the DSH skill root")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--dest", default=None)
    args = parser.parse_args()
    dest = os.path.abspath(
        args.dest
        or os.path.join(os.path.expanduser("~"), ".dsh", "skills", skill_name(PROJECT))
    )

    files = project_files(PROJECT)
    copied: list[str] = []
    unchanged: list[str] = []
    for rel, src in sorted(files.items()):
        target = os.path.join(dest, rel)
        if os.path.exists(target) and filecmp.cmp(src, target, shallow=False):
            unchanged.append(rel)
            continue
        if not args.dry_run:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copy2(src, target)
        copied.append(rel)

    # Prune anything the payload does not contain — this is what removes a file
    # the project has since dropped, or one a previous deny list let through.
    removed: list[str] = []
    for base, dirs, names in os.walk(dest):
        dirs[:] = [d for d in dirs if d not in PRUNE_SKIP_DIRS]
        for name in names:
            full = os.path.join(base, name)
            rel = os.path.relpath(full, dest)
            if rel in files:
                continue
            if not args.dry_run:
                os.remove(full)
            removed.append(rel)
    prune_empty_dirs(dest, args.dry_run)

    for rel in copied:
        print(f"    copied  {rel}")
    for rel in removed:
        print(f"   removed  {rel}")
    print(
        f"-> {dest}  (copied {len(copied)}, unchanged {len(unchanged)}, "
        f"removed {len(removed)})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

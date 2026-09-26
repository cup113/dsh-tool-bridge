"""Deploys this project to the DSH skill root (everything except .git).

The repository is the source of truth; DSH discovers and loads the copy under
~/.dsh/skills/<skill-name>/SKILL.md, where <skill-name> comes from this
project's SKILL.md frontmatter (not from the repository directory name — the two
differ on purpose here: the repo is `dsh-tool-bridge`, the skill is
`tool-bridge`). Run this after changing anything:

    python scripts/sync_to_skills.py             # deploy
    python scripts/sync_to_skills.py --dry-run   # show what would change
"""

from __future__ import annotations

import argparse
import filecmp
import io
import os
import re
import shutil
import sys

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXCLUDE_DIRS = {".git", "__pycache__", ".idea", ".vscode"}
EXCLUDE_SUFFIXES = (".pyc", ".pyo")


def skill_name(root: str) -> str:
    """The `name:` of SKILL.md frontmatter — the directory DSH will look in."""
    try:
        text = io.open(os.path.join(root, "SKILL.md"), encoding="utf-8").read()
    except OSError:
        return os.path.basename(root)
    match = re.search(r"^name:\s*(.+)$", text, re.MULTILINE)
    if match:
        name = match.group(1).strip().strip("\"'")
        if name:
            return name
    return os.path.basename(root)


def excluded(rel: str) -> bool:
    if any(part in EXCLUDE_DIRS for part in rel.split(os.sep)):
        return True
    return rel.endswith(EXCLUDE_SUFFIXES)


def project_files(root: str) -> dict[str, str]:
    found: dict[str, str] = {}
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for name in files:
            full = os.path.join(base, name)
            rel = os.path.relpath(full, root)
            if not excluded(rel):
                found[rel] = full
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description="deploy to the DSH skill root")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--dest", default=None)
    args = parser.parse_args()
    dest = os.path.abspath(
        args.dest or os.path.join(os.path.expanduser("~"), ".dsh", "skills", skill_name(PROJECT))
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

    # Prune anything the project no longer has. .git is never touched: the
    # deployment is not a repository.
    removed: list[str] = []
    for base, dirs, names in os.walk(dest):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for name in names:
            full = os.path.join(base, name)
            rel = os.path.relpath(full, dest)
            if rel in files:
                continue
            if not args.dry_run:
                os.remove(full)
            removed.append(rel)

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

#!/usr/bin/env python3
"""ARB edit logic for the tool-bridge `arb-edit` sub-tool.

Provenance: the line surgery below is a port of the old standalone
`flutter-arb-edit` skill's `arb_edit.py` (now retired). What changed on the way
in, and why:

- The core is a pure ``bytes -> bytes`` transformation (``apply_file_groups``),
  so the tests need no writable directory: line-ending preservation and CJK
  values are asserted by comparing bytes.
- Edits are planned for **every** target file before **any** file is written
  (``plan_arb_edits`` / ``apply_arb_edits``). The old script edited files one
  at a time and could abort halfway when a delete anchor was missing from a
  later file, leaving an inconsistent half-edited set; now a semantic error
  means zero files touched.
- Instruction validation is split from file access: ``validate_instructions``
  checks the schema only (the HTTP route answers it with a 400), while
  anchor/range errors surface during planning (the job fails, nothing written).

The wire schema is unchanged from the old skill: ``groups[]`` each with an
``insertAfter`` anchor (or ``__END__``), an optional inclusive
``deleteFrom``/``deleteTo`` pair, and ``newFields[]`` of
``{key, value: {arbFileName: text}}``. A group without ``newFields`` is a pure
delete and applies to every ``app_*.arb`` file in the configured arb-dir.
"""

# ValueError is this module's error channel on purpose: the HTTP route maps it
# to a 400 and the job runner to a failed job, so an invalid *type* in the
# instruction body is reported as a schema error rather than a Python-level
# TypeError. `build_argv` and the handler's `_body` in toolhub_server.py do the
# same thing for the same reason.
# ruff: noqa: TRY004

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, TypedDict

__all__ = [
    "ArbPlan",
    "FilePlan",
    "SkippedFile",
    "apply_arb_edits",
    "apply_file_groups",
    "delete_range",
    "detect_line_ending",
    "insert_after_key",
    "parse_l10n_yaml",
    "plan_arb_edits",
    "read_untranslated",
    "validate_instructions",
]

# The only top-level fields the instruction body may carry. `cwd` is rejected
# explicitly (with a better message) because the bridge pins the working
# directory at boot and no request may change it (ADR-0002).
ALLOWED_TOP_FIELDS = {"groups", "dryRun"}


class FilePlan(TypedDict):
    """One ARB file's planned new content plus a human-readable change list."""

    name: str
    path: Path
    new_bytes: bytes
    inserts: list[str]
    deletes: list[str]


class SkippedFile(TypedDict):
    """An ARB file named in a value map but absent from the arb-dir."""

    file: str
    reason: str


class ArbPlan(TypedDict):
    """The output of the plan phase: everything needed to apply, and nothing
    applied yet."""

    files: list[FilePlan]
    skipped: list[SkippedFile]
    # Resolved from l10n.yaml's untranslated-messages-file, relative to the
    # project root; read only after `flutter gen-l10n` has run.
    untranslated_file: Path | None


# ---------------------------------------------------------------------------
# Line-level helpers (ported; behaviour preserved)
# ---------------------------------------------------------------------------


def detect_line_ending(raw: bytes) -> str:
    """Return CRLF if the file uses it, otherwise LF."""
    if b"\r\n" in raw:
        return "\r\n"
    return "\n"


# Matches a top-level ARB key line like `  "someKey": "value",` — the key name
# is group 1. Also matches `  "@someKey": {` metadata openers.
_KEY_PATTERN = re.compile(r'^\s*"([^"]+)"\s*:')


def find_key_line(lines: list[str], key: str) -> int | None:
    """The 0-based index of the line that defines ``key``, else None."""
    for index, line in enumerate(lines):
        match = _KEY_PATTERN.match(line)
        if match and match.group(1) == key:
            return index
    return None


def find_closing_brace(lines: list[str]) -> int | None:
    """The line index of the closing ``}`` of the top-level JSON object."""
    for index in range(len(lines) - 1, -1, -1):
        stripped = lines[index].strip()
        if stripped == "}":
            return index
        if stripped:
            break
    return None


def _json_string_escape(text: str) -> str:
    """Escape a string for embedding in JSON (non-ASCII stays readable)."""
    return json.dumps(text, ensure_ascii=False)


def _line_indent(line: str) -> str:
    """The leading whitespace of ``line``."""
    match = re.match(r"^(\s*)", line)
    return match.group(1) if match else ""


def _next_non_blank_is_brace(lines: list[str], index: int) -> bool:
    """Whether the next non-blank line after ``index`` is the closing ``}``."""
    for line in lines[index + 1 :]:
        stripped = line.strip()
        if stripped == "":
            continue
        return stripped == "}"
    return False


def _brace_close_index(lines: list[str], start: int) -> int | None:
    """The line where brace depth, starting at ``start``, returns to 0.

    String literals are skipped so braces inside values (a description like
    ``See: {a:{b}}``) do not skew the count.
    """
    depth = 0
    in_string = False
    escape = False
    for index in range(start, len(lines)):
        for char in lines[index]:
            if in_string:
                if escape:
                    escape = False
                elif char == "\\":
                    escape = True
                elif char == '"':
                    in_string = False
            elif char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
        if depth == 0:
            return index
    return None


def _extend_to_include_metadata(lines: list[str], end: int) -> int:
    """If the line after ``end`` opens an ``@key`` block, extend ``end`` to the
    block's closing line, so metadata stays attached to its key."""
    index = end + 1
    while index < len(lines) and lines[index].strip() == "":
        index += 1
    if index >= len(lines):
        return end
    match = _KEY_PATTERN.match(lines[index])
    if match and match.group(1).startswith("@"):
        closing = _brace_close_index(lines, index)
        if closing is not None:
            return closing
    return end


def _strip_trailing_comma_if_last(lines: list[str]) -> None:
    """Drop the trailing comma of the last entry before ``}``, in place.

    Needed after a deletion removes the tail block: the formerly second-to-last
    entry (which carried a comma) becomes the last and would break the JSON.
    """
    brace_index = find_closing_brace(lines)
    if brace_index is None:
        return
    for index in range(brace_index - 1, -1, -1):
        stripped = lines[index].strip()
        if stripped == "":
            continue
        stripped = lines[index].rstrip()
        if stripped.endswith(","):
            lines[index] = stripped[:-1]
        return


def delete_range(
    lines: list[str], delete_from: str, delete_to: str
) -> tuple[list[str], list[str]]:
    """Delete the lines of ``delete_from`` .. ``delete_to`` (inclusive).

    An ``@key`` metadata block immediately following ``deleteTo`` is deleted
    with it, so placeholder metadata cannot be orphaned. Returns the new line
    list and the key names that were removed (for the change report).
    Raises ValueError.
    """
    start = find_key_line(lines, delete_from)
    end = find_key_line(lines, delete_to)
    if start is None:
        raise ValueError(f"deleteFrom key not found: {delete_from!r}")
    if end is None:
        raise ValueError(f"deleteTo key not found: {delete_to!r}")
    if start > end:
        raise ValueError(
            f"deleteFrom ({delete_from!r} at line {start + 1}) comes after "
            f"deleteTo ({delete_to!r} at line {end + 1})"
        )
    end = _extend_to_include_metadata(lines, end)
    # Report the keys the caller actually named — top-level entries only. A
    # deleted `@key` block carries nested keys of its own, and listing those
    # would read as if the caller had asked to delete them separately.
    indent = _line_indent(lines[start])
    removed_keys = [
        match.group(1)
        for line in lines[start : end + 1]
        if _line_indent(line) == indent and (match := _KEY_PATTERN.match(line))
    ]
    result = lines[:start] + lines[end + 1 :]
    _strip_trailing_comma_if_last(result)
    return result, removed_keys


def insert_after_key(
    lines: list[str],
    anchor_key: str,
    new_entries: list[tuple[str, str]],
) -> list[str]:
    """Insert ``(key, value)`` entries after ``anchor_key`` (or before the
    closing brace for ``__END__``).

    Trailing commas are kept valid in every position: the entry before the
    insertion point gains one, each new entry keeps one except the last when it
    ends up immediately before ``}``. When the anchor carries an ``@key``
    metadata block, the entries land *after* the block so it stays attached.
    Raises ValueError.
    """
    if anchor_key == "__END__":
        insert_index = find_closing_brace(lines)
        if insert_index is None:
            raise ValueError("could not find the closing brace of the ARB file")
        at_end = True
        indent = "  "
        # The former last entry is now followed by new entries, so it needs a
        # trailing comma (a metadata block's `},` already has one).
        prev_index = insert_index - 1
        while prev_index >= 0 and lines[prev_index].strip() == "":
            prev_index -= 1
        if prev_index >= 0:
            indent = _line_indent(lines[prev_index])
            if lines[prev_index].strip() != "{" and not lines[
                prev_index
            ].rstrip().endswith(","):
                lines[prev_index] = lines[prev_index].rstrip() + ","
        next_non_blank_is_brace = True
    else:
        anchor_index = find_key_line(lines, anchor_key)
        if anchor_index is None:
            raise ValueError(f"insertAfter key not found: {anchor_key!r}")
        indent = _line_indent(lines[anchor_index])
        insert_index = _extend_to_include_metadata(lines, anchor_index)
        entry = lines[insert_index].rstrip()
        if not entry.endswith(","):
            lines[insert_index] = entry + ","
        at_end = False
        next_non_blank_is_brace = _next_non_blank_is_brace(lines, insert_index)

    new_lines: list[str] = []
    for position, (key, value) in enumerate(new_entries):
        is_last_new = position == len(new_entries) - 1
        omit_comma = is_last_new and next_non_blank_is_brace
        line = f'{indent}"{key}": {_json_string_escape(value)}'
        if not omit_comma:
            line += ","
        new_lines.append(line)

    if at_end:
        return lines[:insert_index] + new_lines + lines[insert_index:]
    return lines[: insert_index + 1] + new_lines + lines[insert_index + 1 :]


# ---------------------------------------------------------------------------
# Instruction validation (schema only — no file access)
# ---------------------------------------------------------------------------


def validate_instructions(body: object) -> dict[str, Any]:
    """Checks the instruction schema and returns the normalized instructions.

    This is the route's 400 layer: everything checkable without touching the
    filesystem is checked here, so a typo never costs a queued job. Raises
    ValueError with a message that names the offending field.
    """
    if not isinstance(body, dict):
        raise ValueError("instruction body must be a JSON object")
    if "cwd" in body:
        raise ValueError(
            "'cwd' is not accepted: the bridge pins the working directory at "
            "boot (start a bridge with --cwd <project> to edit that project)"
        )
    unknown = sorted(set(body) - ALLOWED_TOP_FIELDS)
    if unknown:
        raise ValueError(
            f"unknown field(s): {', '.join(unknown)} "
            f"(allowed: {', '.join(sorted(ALLOWED_TOP_FIELDS))})"
        )
    dry_run = body.get("dryRun", False)
    if not isinstance(dry_run, bool):
        raise ValueError("'dryRun' must be a boolean")
    groups = body.get("groups")
    if not isinstance(groups, list) or not groups:
        raise ValueError("'groups' must be a non-empty list")
    for group_index, group in enumerate(groups):
        _validate_group(group_index, group)
    named = {
        arb_name
        for group in groups
        if isinstance(group, dict)
        for field in (group.get("newFields") or [])
        if isinstance(field, dict) and isinstance(field.get("value"), dict)
        for arb_name in field["value"]
    }
    if not named and not any(
        isinstance(group, dict) and not (group.get("newFields") or [])
        for group in groups
    ):
        raise ValueError("no ARB files referenced in newFields")
    return {"groups": groups, "dryRun": dry_run}


def _validate_group(group_index: int, group: object) -> None:
    """Schema checks for one group. Raises ValueError."""
    where = f"groups[{group_index}]"
    if not isinstance(group, dict):
        raise ValueError(f"{where} must be an object")
    fields = group.get("newFields") or []
    if not isinstance(fields, list):
        raise ValueError(f"{where}.newFields must be a list")
    delete_from = group.get("deleteFrom")
    delete_to = group.get("deleteTo")
    if (delete_from is None) != (delete_to is None):
        raise ValueError(f"{where}: deleteFrom and deleteTo must be provided together")
    for name in (delete_from, delete_to):
        if name is not None and (not isinstance(name, str) or not name):
            raise ValueError(f"{where}: deleteFrom/deleteTo must be non-empty strings")
    insert_after = group.get("insertAfter")
    if insert_after is not None and (
        not isinstance(insert_after, str) or not insert_after
    ):
        raise ValueError(f"{where}: insertAfter must be a non-empty string")
    if fields and insert_after is None:
        raise ValueError(
            f"{where}: insertAfter is required when newFields is given "
            "(use the key before the insertion point, or __END__)"
        )
    if not fields and delete_from is None:
        # Neither an insert nor a delete: a group like that does no work, and
        # treating it as a pure delete would silently rewrite every app_*.arb
        # file and run gen-l10n for nothing (the old script did exactly that).
        raise ValueError(
            f"{where}: a group needs newFields or a deleteFrom/deleteTo range"
        )
    for field_index, field in enumerate(fields):
        _validate_field(f"{where}.newFields[{field_index}]", field)


def _validate_field(where: str, field: object) -> None:
    """Schema checks for one newFields entry. Raises ValueError."""
    if not isinstance(field, dict):
        raise ValueError(f"{where} must be an object")
    key = field.get("key")
    if not isinstance(key, str) or not key:
        raise ValueError(f"{where}.key must be a non-empty string")
    if key.startswith("@"):
        raise ValueError(
            f"{where}.key must not start with '@': gen-l10n writes @key "
            "metadata itself, and a hand-written string value is not a Map"
        )
    value = field.get("value")
    if not isinstance(value, dict) or not value:
        raise ValueError(
            f"{where}.value must be a non-empty map of "
            "ARB file name -> translation string"
        )
    for arb_name, text in value.items():
        if not isinstance(arb_name, str) or not arb_name:
            raise ValueError(f"{where}.value keys must be ARB file names")
        if not isinstance(text, str):
            raise ValueError(f"{where}.value[{arb_name!r}] must be a string")


# ---------------------------------------------------------------------------
# l10n.yaml parsing (ported)
# ---------------------------------------------------------------------------


def parse_l10n_yaml(cwd: Path) -> dict[str, str]:
    """The project's ``l10n.yaml`` as key-value pairs. Raises ValueError."""
    l10n_path = cwd / "l10n.yaml"
    if not l10n_path.exists():
        raise ValueError(f"l10n.yaml not found at {l10n_path}")
    config: dict[str, str] = {}
    for line in l10n_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" in line:
            key, _, val = line.partition(":")
            config[key.strip()] = val.strip()
    return config


# ---------------------------------------------------------------------------
# Plan and apply
# ---------------------------------------------------------------------------


def _file_groups_for(
    groups: list[dict[str, Any]], arb_name: str
) -> list[dict[str, Any]]:
    """Adapts instruction groups to one ARB file.

    A group's delete part applies to every file being edited (the old skill's
    documented semantics), while only the fields whose value map names this
    file are inserted. Groups left with neither are dropped.
    """
    adapted: list[dict[str, Any]] = []
    for group in groups:
        fields = [
            {"key": field["key"], "value": field["value"][arb_name]}
            for field in (group.get("newFields") or [])
            if arb_name in field.get("value", {})
        ]
        has_delete = (
            group.get("deleteFrom") is not None and group.get("deleteTo") is not None
        )
        if not fields and not has_delete:
            continue
        adapted.append({**group, "newFields": fields})
    return adapted


def apply_file_groups(
    raw: bytes, file_groups: list[dict[str, Any]]
) -> tuple[bytes, dict[str, list[str]]]:
    """Applies adapted groups to one file's bytes; pure, no filesystem.

    Returns the new bytes and ``{"inserts": [...], "deletes": [...]}`` key
    names for the change report. Raises ValueError on a missing anchor or a
    bad delete range.
    """
    eol = detect_line_ending(raw)
    lines = raw.decode("utf-8").split(eol)
    inserts: list[str] = []
    deletes: list[str] = []
    for group in file_groups:
        delete_from = group.get("deleteFrom")
        delete_to = group.get("deleteTo")
        if delete_from and delete_to:
            lines, removed = delete_range(lines, delete_from, delete_to)
            deletes.extend(removed)
        fields = group.get("newFields") or []
        if fields:
            entries = [(field["key"], field["value"]) for field in fields]
            lines = insert_after_key(lines, group["insertAfter"], entries)
            inserts.extend(field["key"] for field in fields)
    return eol.join(lines).encode("utf-8"), {"inserts": inserts, "deletes": deletes}


def plan_arb_edits(cwd: Path, instructions: dict[str, Any]) -> ArbPlan:
    """Computes every file's new content before writing anything.

    A semantic error (an anchor missing from one file of the set, a delete
    range in the wrong order) raises here, so a failed plan leaves every file
    byte-identical — the property the old script lacked. Raises ValueError.
    """
    normalized = validate_instructions(instructions)
    config = parse_l10n_yaml(cwd)
    arb_dir = cwd / config.get("arb-dir", "lib/l10n")
    if not arb_dir.is_dir():
        raise ValueError(f"ARB directory not found: {arb_dir}")
    groups = normalized["groups"]

    named: set[str] = set()
    for group in groups:
        fields = group.get("newFields") or []
        if not fields:
            continue
        for field in fields:
            named.update(field["value"])
    if not named:
        # A pure-delete instruction (no newFields anywhere) targets every
        # app_*.arb file in the arb-dir, as the old skill did.
        named = {entry.name for entry in arb_dir.glob("app_*.arb")}

    files: list[FilePlan] = []
    skipped: list[SkippedFile] = []
    for arb_name in sorted(named):
        arb_path = arb_dir / arb_name
        if not arb_path.exists():
            skipped.append({"file": arb_name, "reason": "not found"})
            continue
        raw = arb_path.read_bytes()
        try:
            new_bytes, changes = apply_file_groups(
                raw, _file_groups_for(groups, arb_name)
            )
        except ValueError as error:
            # Name the file: the same instruction can be valid for one ARB file
            # and invalid for another, and "key not found" alone does not say
            # which one to look at.
            raise ValueError(f"{arb_name}: {error}") from error

        files.append(
            FilePlan(
                name=arb_name,
                path=arb_path,
                new_bytes=new_bytes,
                inserts=changes["inserts"],
                deletes=changes["deletes"],
            )
        )
    untranslated = config.get("untranslated-messages-file")
    return ArbPlan(
        files=files,
        skipped=skipped,
        untranslated_file=(cwd / untranslated) if untranslated else None,
    )


def apply_arb_edits(plan: ArbPlan) -> list[str]:
    """Writes the planned files. Returns the edited file names."""
    edited: list[str] = []
    for entry in plan["files"]:
        entry["path"].write_bytes(entry["new_bytes"])
        edited.append(entry["name"])
    return edited


def read_untranslated(path: Path | None) -> dict[str, object] | None:
    """The untranslated-messages-file, when it exists with real content.

    gen-l10n sometimes leaves an empty ``{}`` placeholder behind; that counts
    as "no untranslated messages", as does a missing file.
    """
    if path is None or not path.exists():
        return None
    content = path.read_text(encoding="utf-8").strip()
    if not content or content in ("{}", "[]"):
        return None
    return {
        "file": path.name,
        "lines": len(content.splitlines()),
        "content": content,
    }

"""Self-tests for the tool-bridge guards, log parsers and sub-tools.

Stdlib `unittest` on purpose: pytest needs temp-dir churn the DSH sandbox
denies. Run them directly, from the project root or anywhere else:

    python tests/test_toolhub.py

They read the fixtures under `tests/fixtures/` and write nothing, except the
`arb-edit` job tests, which copy the ARB fixture tree into
`tests/.tmp-arbtool/` and remove it again (a real edit has to land somewhere,
and the sandbox permits writes inside the workspace), plus two scratch
directories for the formatter-pin and scope tests (`.tmp-format-pin/`,
`.tmp-scope/`) — both removed by the tests that make them. The Node toolchain
tests use `.tmp-node/` (a fake npm-shaped tree for the launcher guards),
`.tmp-node-project/` (a project whose `vite` and `vitest` are fake Node scripts,
so the lanes and the digest are exercised by real processes) and
`.tmp-node-logs/` for job logs; all three are removed by the classes that make
them.
"""

from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import re
import shutil
import socket
import sys
import threading
import time
import types
import unittest
import urllib.error
import urllib.request
from collections.abc import Mapping
from typing import Any, ClassVar

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
FIXTURES = HERE / "fixtures"
ARB_FIXTURES = FIXTURES / "arb"
ARB_DIR = ARB_FIXTURES / "lib" / "l10n"
ARB_SCRATCH = HERE / ".tmp-arbtool"
ARB_LOG_SCRATCH = HERE / ".tmp-arbtool-logs"
# The formatter pin needs a real file to point at (`resolve_launch` checks), and
# a scoped `/run` job will spawn whatever `dart` resolves to, so its stray
# output has a scratch directory of its own.
PIN_SCRATCH = HERE / ".tmp-format-pin"
SCOPE_SCRATCH = HERE / ".tmp-scope"
SCOPE_LOG_SCRATCH = HERE / ".tmp-scope-logs"
# The known-failure registry tests write a registry into a scratch cwd and read
# it back exactly as a job does.
REGISTRY_SCRATCH = HERE / ".tmp-registry"


def load_server() -> types.ModuleType:
    """Imports `scripts/toolhub_server.py` without starting a server."""
    path = ROOT / "scripts" / "toolhub_server.py"
    spec = importlib.util.spec_from_file_location("toolhub_server", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["toolhub_server"] = module
    spec.loader.exec_module(module)
    return module


server = load_server()
arb = server.arb_edit_lib


def fixture(name: str) -> str:
    return str(FIXTURES / name)


class RestoreGuardTests(unittest.TestCase):
    """`git restore` is allowed only for literal paths inside the worktree."""

    ALLOWED = (
        ["git", "restore", "--", "lib/a.dart", "test/b_test.dart"],
        ["git", "restore", "lib/a.dart"],
        ["git", "restore", "-q", "lib/a.dart"],
        ["git", "restore", "--staged", "lib/a.dart"],
        ["git", "restore", "-S", "-W", "lib/a.dart"],
        ["git", "restore", "-SW", "lib/a.dart"],
        ["git", "restore", "--no-staged", "lib/a.dart"],
        ["git", "restore", "--", "test/desktop/-leading-dash.dart"],
    )

    # argv -> (required fragment of the refusal, canary token that must survive)
    REFUSED = (
        (["git", "restore"], "at least one explicit path", None),
        (["git", "restore", "--"], "at least one explicit path", None),
        (["git", "restore", "."], "must name files inside", None),
        (["git", "restore", "./"], "must name files inside", None),
        (
            ["git", "restore", "canary-parent/../lib/a.dart"],
            "canary-parent",
            "canary-parent",
        ),
        (["git", "restore", "canary-wild/*.dart"], "canary-wild", "canary-wild"),
        (["git", "restore", "canary-glob/**"], "canary-glob", "canary-glob"),
        (["git", "restore", "canary-q?.dart"], "canary-q", "canary-q"),
        (["git", "restore", ":canary-magic"], "canary-magic", "canary-magic"),
        (["git", "restore", ":/"], "pathspec magic", None),
        (["git", "restore", "D:/canary-abs/a.dart"], "canary-abs", "canary-abs"),
        (["git", "restore", "/canary-root/a.dart"], "must be relative", "canary-root"),
        (
            ["git", "restore", "--pathspec-from-file=canary-list.txt"],
            "canary-list",
            "canary-list",
        ),
        (["git", "restore", "--pathspec-file-nul", "lib/a.dart"], "not allowed", None),
        (["git", "restore", "-s", "HEAD~1", "lib/a.dart"], "not allowed", None),
        (["git", "restore", "--source=HEAD~1", "lib/a.dart"], "not allowed", None),
        (["git", "restore", "-p", "lib/a.dart"], "not allowed", None),
        (["git", "restore", "--recurse-submodules", "lib/a.dart"], "not allowed", None),
        (["git", "restore", "--merge", "lib/a.dart"], "not allowed", None),
        (["git", "restore", "--conflict=diff3", "lib/a.dart"], "not allowed", None),
    )

    def test_allowed_forms(self) -> None:
        for argv in self.ALLOWED:
            with self.subTest(argv=argv):
                server.validate(argv)

    def test_refused_forms(self) -> None:
        for argv, fragment, canary in self.REFUSED:
            with self.subTest(argv=argv):
                with self.assertRaises(ValueError) as caught:
                    server.validate(argv)
                message = str(caught.exception)
                self.assertIn(fragment, message)
                if canary is not None:
                    self.assertIn(canary, message)

    def test_destructive_verbs_stay_out(self) -> None:
        for verb in ("reset", "clean", "checkout", "switch", "stash", "push"):
            with self.subTest(verb=verb), self.assertRaises(ValueError):
                server.validate(["git", verb, "--", "lib/a.dart"])

    def test_checkout_refusal_names_the_substitute(self) -> None:
        with self.assertRaises(ValueError) as caught:
            server.validate(["git", "checkout", "--", "lib/a.dart"])
        self.assertIn("git restore --", str(caught.exception))

    def test_branch_delete_still_refused(self) -> None:
        with self.assertRaises(ValueError):
            server.validate(["git", "branch", "-D", "feature"])

    def test_allowlist_is_not_bypassed_by_a_glob(self) -> None:
        """The guard would be vacuous if a pattern slipped through."""
        with self.assertRaises(ValueError):
            server.validate(["git", "restore", "*"])


class CommitMessageTests(unittest.TestCase):
    """ "message" is folded in as argv, so no temp file ever exists."""

    def test_message_becomes_m(self) -> None:
        argv = server.build_argv("git", ["commit", "--amend"], "slice 2: 中文")
        self.assertEqual(argv, ["git", "commit", "-m", "slice 2: 中文", "--amend"])
        server.validate(argv)

    def test_message_may_be_multiline(self) -> None:
        body = "subject line\n\nbody paragraph"
        argv = server.build_argv("git", ["commit"], body)
        self.assertEqual(argv[3], body)

    def test_no_message_leaves_argv_alone(self) -> None:
        self.assertEqual(
            server.build_argv("git", ["commit", "-m", "x"], None),
            ["git", "commit", "-m", "x"],
        )

    def test_message_refused_without_commit(self) -> None:
        for args in (["status"], ["add", "-A"], ["", "commit"]):
            with self.subTest(args=args), self.assertRaises(ValueError):
                server.build_argv("git", args, "nope")
        with self.assertRaises(ValueError):
            server.build_argv("flutter", ["test"], "nope")

    def test_message_refused_beside_a_message_flag(self) -> None:
        for token in ("-m", "--message=x", "-F", "--file=msg.txt"):
            with self.subTest(token=token), self.assertRaises(ValueError):
                server.build_argv("git", ["commit", token], "inline")

    def test_empty_message_refused(self) -> None:
        for message in ("", "   ", "\n"):
            with self.subTest(message=message), self.assertRaises(ValueError):
                server.build_argv("git", ["commit"], message)

    def test_commit_without_any_message_is_refused(self) -> None:
        with self.assertRaises(ValueError) as caught:
            server.validate(["git", "commit"])
        self.assertIn("message", str(caught.exception))

    def test_commit_message_sources_still_allowed(self) -> None:
        for token in ("-m", "--message", "-F", "--file", "--reuse-message"):
            with self.subTest(token=token):
                server.validate(["git", "commit", token])


class LogQueryTests(unittest.TestCase):
    """`grep` selects, `tail` caps, and the metadata never lies."""

    def test_tail_zero_returns_nothing(self) -> None:
        self.assertEqual(server.read_tail(fixture("expanded_passed.txt"), 0), "")

    def test_tail_reads_the_end(self) -> None:
        text = server.read_tail(fixture("expanded_failed.txt"), 2)
        self.assertEqual(text.splitlines()[-1], "  ... and 2 more")

    def test_filter_keeps_the_last_matches_and_counts_all(self) -> None:
        pattern = re.compile(r"\[E\]")
        text, meta = server.read_filtered(fixture("expanded_failed.txt"), pattern, 2)
        self.assertEqual(meta["matched"], 6)
        self.assertEqual(meta["returned"], 2)
        self.assertTrue(meta["truncated"])
        self.assertGreater(meta["scannedLines"], 20)
        lines = text.splitlines()
        self.assertIn("epsilon syncs", lines[0])
        self.assertIn("zeta handles empty", lines[1])

    def test_filter_without_matches_is_explicit(self) -> None:
        text, meta = server.read_filtered(
            fixture("expanded_failed.txt"), re.compile("no-such-marker"), 80
        )
        self.assertEqual(text, "")
        self.assertEqual(meta["matched"], 0)
        self.assertEqual(meta["returned"], 0)
        self.assertFalse(meta["truncated"])

    def test_no_grep_keeps_the_plain_tail(self) -> None:
        text, meta = server.read_filtered(fixture("expanded_passed.txt"), None, 1)
        self.assertEqual(text, "00:20 +33 ~2: All tests passed!")
        self.assertIsNone(meta["grep"])
        self.assertIsNone(meta["matched"])

    def test_missing_log_is_not_an_error(self) -> None:
        text, meta = server.read_filtered(
            str(FIXTURES / "does-not-exist.log"), re.compile("x"), 5
        )
        self.assertEqual(text, "")
        self.assertEqual(meta["matched"], 0)

    def test_query_validation(self) -> None:
        self.assertEqual(server.parse_log_query(None, None)[0], 200)
        self.assertEqual(server.parse_log_query(None, "42")[0], 42)
        self.assertEqual(server.parse_log_query(None, 99999)[0], 5000)
        self.assertEqual(server.parse_log_query(None, -5)[0], 0)
        self.assertIsNotNone(server.parse_log_query(r"\[E\]", None)[1])
        for bad_grep in ("", "(", "[", 7):
            with self.subTest(grep=bad_grep), self.assertRaises(ValueError):
                server.parse_log_query(bad_grep, None)
        for bad_tail in (True, "many", 1.5, []):
            with self.subTest(tail=bad_tail), self.assertRaises(ValueError):
                server.parse_log_query(None, bad_tail)


class TestLogAnalyzerTests(unittest.TestCase):
    """`analyze_test_log`: counts authoritative, failures complete, run order."""

    FLUTTER_TEST: ClassVar[list[str]] = ["flutter", "test", "test/desktop"]

    def digest(self, name: str) -> Mapping[str, Any]:
        return server.analyze_test_log(self.FLUTTER_TEST, fixture(name))

    def test_counts_and_summary(self) -> None:
        digest = self.digest("expanded_failed.txt")
        self.assertEqual(digest["counts"], {"passed": 83, "skipped": 0, "failed": 6})
        self.assertEqual(digest["summary"], "83 passed, 6 failed")

    def test_failures_are_complete_and_in_run_order(self) -> None:
        digest = self.digest("expanded_failed.txt")
        failures = digest["failures"]
        self.assertEqual(len(failures), 6)
        self.assertEqual(
            [entry["name"] for entry in failures],
            [
                "alpha refuses a bad key",
                "bravo retries once",
                "gamma restores state",
                "delta dedupes",
                "epsilon syncs",
                "zeta handles empty",
            ],
        )

    def test_failures_the_block_evicted_are_still_reported(self) -> None:
        """The block shows four entries plus '... and 2 more'; we report all."""
        digest = self.digest("expanded_failed.txt")
        names = [entry["name"] for entry in digest["failures"]]
        self.assertIn("alpha refuses a bad key", names)
        self.assertIn("bravo retries once", names)

    def test_paths_come_from_the_progress_lines(self) -> None:
        digest = self.digest("expanded_failed.txt")
        self.assertEqual(
            digest["failures"][0]["file"],
            "C:/ws/test/desktop/alpha_test.dart",
        )

    def test_did_not_complete_is_flagged(self) -> None:
        digest = self.digest("expanded_failed.txt")
        flagged = [e["name"] for e in digest["failures"] if e["didNotComplete"]]
        self.assertEqual(flagged, ["epsilon syncs"])

    def test_failures_only_reporter_has_no_block_but_keeps_everything(self) -> None:
        digest = self.digest("failures_only_failed.txt")
        self.assertEqual(digest["counts"]["failed"], 2)
        self.assertEqual(digest["summary"], "12 passed, 2 failed")
        self.assertEqual(len(digest["failures"]), 2)
        self.assertTrue(all(e["file"] is None for e in digest["failures"]))

    def test_single_file_run_takes_paths_from_the_block(self) -> None:
        digest = self.digest("single_file_failed.txt")
        self.assertEqual(len(digest["failures"]), 1)
        self.assertEqual(
            digest["failures"][0]["file"], "C:/ws/test/unit/thing_test.dart"
        )
        self.assertEqual(digest["failures"][0]["name"], "my failing test")

    def test_load_failure_is_reported(self) -> None:
        digest = self.digest("load_failure.txt")
        self.assertEqual(digest["counts"], {"passed": 0, "skipped": 0, "failed": 1})
        self.assertEqual(
            digest["failures"][0]["name"],
            "loading C:/ws/test/broken_test.dart",
        )
        self.assertEqual(digest["failures"][0]["file"], "C:/ws/test/broken_test.dart")

    def test_passing_run_reports_skips(self) -> None:
        digest = self.digest("expanded_passed.txt")
        self.assertEqual(digest["summary"], "33 passed, 2 skipped")
        self.assertEqual(digest["failures"], [])

    def test_non_test_command_has_no_digest(self) -> None:
        digest = server.analyze_test_log(
            ["flutter", "analyze"], fixture("expanded_failed.txt")
        )
        self.assertIsNone(digest["summary"])
        self.assertIsNone(digest["counts"])
        self.assertEqual(digest["failures"], [])

    def test_dart_test_is_digested_too(self) -> None:
        digest = server.analyze_test_log(
            ["dart", "test"], fixture("expanded_failed.txt")
        )
        self.assertEqual(digest["summary"], "83 passed, 6 failed")

    def test_killed_run_does_not_claim_completion(self) -> None:
        """Counts without a terminal marker mean a truncated suite, not a pass."""
        digest = self.digest("killed_run.txt")
        self.assertEqual(digest["counts"], {"passed": 5, "skipped": 0, "failed": 0})
        self.assertEqual(digest["summary"], "see log")


def instruction(**overrides: Any) -> dict[str, Any]:
    """A minimal valid arb-edit instruction, for the schema tests."""
    base: dict[str, Any] = {
        "groups": [
            {
                "insertAfter": "firstKey",
                "newFields": [{"key": "newOne", "value": {"app_en.arb": "New one"}}],
            }
        ]
    }
    base.update(overrides)
    return base


class ArbInstructionValidationTests(unittest.TestCase):
    """The route's 400 layer: a schema typo never costs a queued job."""

    REFUSED = (
        ({"cwd": "D:/elsewhere", "groups": []}, "pins the working directory"),
        (instruction(dryrun=True), "unknown field"),
        (instruction(groups=None), "non-empty list"),
        (instruction(groups=[]), "non-empty list"),
        (instruction(groups=["nope"]), "must be an object"),
        (
            instruction(dryRun="yes"),
            "must be a boolean",
        ),
        (
            instruction(groups=[{"insertAfter": "a", "deleteFrom": "b"}]),
            "deleteFrom and deleteTo must be provided together",
        ),
        (
            instruction(
                groups=[{"insertAfter": "a", "deleteFrom": "", "deleteTo": "b"}]
            ),
            "non-empty strings",
        ),
        (
            instruction(
                groups=[{"newFields": [{"key": "k", "value": {"a.arb": "v"}}]}]
            ),
            "insertAfter is required",
        ),
        (
            instruction(groups=[{"insertAfter": "a"}]),
            "needs newFields or a deleteFrom/deleteTo range",
        ),
        (
            instruction(
                groups=[
                    {
                        "insertAfter": "a",
                        "newFields": [{"key": "", "value": {"a.arb": "v"}}],
                    }
                ]
            ),
            "key must be a non-empty string",
        ),
        (
            instruction(
                groups=[
                    {
                        "insertAfter": "a",
                        "newFields": [{"key": "@meta", "value": {"a.arb": "v"}}],
                    }
                ]
            ),
            "gen-l10n writes @key",
        ),
        (
            instruction(
                groups=[{"insertAfter": "a", "newFields": [{"key": "k", "value": {}}]}]
            ),
            "non-empty map",
        ),
        (
            instruction(
                groups=[
                    {
                        "insertAfter": "a",
                        "newFields": [{"key": "k", "value": {"a.arb": 7}}],
                    }
                ]
            ),
            "must be a string",
        ),
        (
            instruction(
                groups=[
                    {
                        "insertAfter": "a",
                        "newFields": [{"key": "k", "value": "not-a-map"}],
                    }
                ]
            ),
            "non-empty map",
        ),
        ({"dryRun": False}, "groups"),
    )

    def test_a_valid_instruction_is_normalized(self) -> None:
        normalized = arb.validate_instructions(instruction())
        self.assertFalse(normalized["dryRun"])
        self.assertEqual(len(normalized["groups"]), 1)

    def test_a_pure_delete_needs_no_insert_after(self) -> None:
        normalized = arb.validate_instructions(
            {"groups": [{"deleteFrom": "gone", "deleteTo": "gone"}]}
        )
        self.assertEqual(normalized["groups"][0]["deleteFrom"], "gone")

    def test_refused_bodies_name_their_field(self) -> None:
        for body, fragment in self.REFUSED:
            with self.subTest(body=body):
                with self.assertRaises(ValueError) as caught:
                    arb.validate_instructions(body)
                self.assertIn(fragment, str(caught.exception))

    def test_non_object_body_is_refused(self) -> None:
        for body in ([], "groups", 7, None):
            with self.subTest(body=body), self.assertRaises(ValueError):
                arb.validate_instructions(body)


class ArbEditLibTests(unittest.TestCase):
    """Line surgery: commas, @key blocks, EOL fidelity, CJK, plan purity."""

    def plan(self, instructions: dict[str, Any]) -> arb.ArbPlan:
        return arb.plan_arb_edits(ARB_FIXTURES, instructions)

    def planned(self, instructions: dict[str, Any]) -> dict[str, bytes]:
        return {
            entry["name"]: entry["new_bytes"]
            for entry in self.plan(instructions)["files"]
        }

    def test_insert_after_plain_key_keeps_the_json_valid(self) -> None:
        planned = self.planned(
            {
                "groups": [
                    {
                        "insertAfter": "firstKey",
                        "newFields": [
                            {
                                "key": "newOne",
                                "value": {
                                    "app_en.arb": "New one",
                                    "app_zh.arb": "新的一項",
                                },
                            }
                        ],
                    }
                ]
            }
        )
        english = planned["app_en.arb"].decode("utf-8")
        self.assertEqual(json.loads(english)["newOne"], "New one")
        self.assertIn('  "firstKey": "First",\n  "newOne": "New one",', english)
        self.assertEqual(
            json.loads(planned["app_zh.arb"].decode("utf-8"))["newOne"], "新的一項"
        )

    def test_insert_after_a_key_lands_after_its_metadata_block(self) -> None:
        planned = self.planned(
            {
                "groups": [
                    {
                        "insertAfter": "withMeta",
                        "newFields": [
                            {"key": "afterMeta", "value": {"app_en.arb": "x"}}
                        ],
                    }
                ]
            }
        )
        english = planned["app_en.arb"].decode("utf-8")
        # The @key block stays glued to its key: the new entry follows it.
        self.assertIn('  },\n  "afterMeta": "x",\n  "midKey"', english)
        self.assertEqual(json.loads(english)["afterMeta"], "x")

    def test_insert_at_end_gets_the_trailing_comma_right(self) -> None:
        planned = self.planned(
            {
                "groups": [
                    {
                        "insertAfter": "__END__",
                        "newFields": [{"key": "tailKey", "value": {"app_en.arb": "t"}}],
                    }
                ]
            }
        )
        english = planned["app_en.arb"].decode("utf-8")
        # The formerly last entry gains a comma; the new last one does not.
        self.assertIn('  "lastKey": "Last",\n  "tailKey": "t"\n}', english)
        self.assertEqual(json.loads(english)["tailKey"], "t")

    def test_replace_single_key_reports_both_halves(self) -> None:
        instructions = {
            "groups": [
                {
                    "insertAfter": "firstKey",
                    "deleteFrom": "midKey",
                    "deleteTo": "midKey",
                    "newFields": [{"key": "midKey", "value": {"app_en.arb": "Mid v2"}}],
                }
            ]
        }
        plan = self.plan(instructions)
        entry = plan["files"][0]
        self.assertEqual(entry["inserts"], ["midKey"])
        self.assertEqual(entry["deletes"], ["midKey"])
        parsed = json.loads(entry["new_bytes"].decode("utf-8"))
        self.assertEqual(parsed["midKey"], "Mid v2")
        self.assertEqual(
            list(parsed),
            ["firstKey", "midKey", "withMeta", "@withMeta", "lastKey"],
        )

    def test_delete_range_takes_the_metadata_block_along(self) -> None:
        planned = self.planned(
            {
                "groups": [
                    {
                        "insertAfter": "firstKey",
                        "deleteFrom": "withMeta",
                        "deleteTo": "midKey",
                        # Naming the files explicitly keeps the delete scoped to
                        # the two that carry the range (see the global-delete
                        # test below for what an empty newFields means).
                        "newFields": [
                            {
                                "key": "mergedKey",
                                "value": {
                                    "app_en.arb": "Merged",
                                    "app_zh.arb": "已合并",
                                },
                            }
                        ],
                    }
                ]
            }
        )
        english = planned["app_en.arb"].decode("utf-8")
        self.assertNotIn("@withMeta", english)
        self.assertNotIn("midKey", english)
        self.assertEqual(
            list(json.loads(english)), ["firstKey", "mergedKey", "lastKey"]
        )
        self.assertEqual(
            list(json.loads(planned["app_zh.arb"].decode("utf-8"))),
            ["firstKey", "mergedKey", "lastKey"],
        )

    def test_crlf_and_cjk_survive_an_edit(self) -> None:
        planned = self.planned(
            {
                "groups": [
                    {
                        "insertAfter": "firstKey",
                        "newFields": [
                            {"key": "cjkKey", "value": {"app_zh.arb": "中文值"}}
                        ],
                    }
                ]
            }
        )
        raw = planned["app_zh.arb"]
        self.assertIn(b"\r\n", raw)
        self.assertNotIn(b"\n", raw.replace(b"\r\n", b""))
        self.assertIn(b'"cjkKey": "\xe4\xb8\xad\xe6\x96\x87\xe5\x80\xbc"', raw)
        self.assertEqual(json.loads(raw.decode("utf-8"))["cjkKey"], "中文值")

    def test_lf_files_stay_lf(self) -> None:
        raw = self.planned(
            {
                "groups": [
                    {
                        "insertAfter": "firstKey",
                        "newFields": [{"key": "k", "value": {"app_en.arb": "v"}}],
                    }
                ]
            }
        )["app_en.arb"]
        self.assertNotIn(b"\r\n", raw)

    def test_plan_names_the_file_whose_anchor_is_missing(self) -> None:
        """The old script half-edited the set; the plan phase cannot."""
        with self.assertRaises(ValueError) as caught:
            self.plan(
                {
                    "groups": [
                        {
                            "insertAfter": "firstKey",
                            "deleteFrom": "midKey",
                            "deleteTo": "midKey",
                            "newFields": [
                                {
                                    "key": "k",
                                    "value": {
                                        "app_en.arb": "x",
                                        "app_zh_Hant.arb": "y",
                                    },
                                }
                            ],
                        }
                    ]
                }
            )
        message = str(caught.exception)
        self.assertIn("app_zh_Hant.arb", message)
        self.assertIn("midKey", message)

    def test_a_file_missing_from_the_arb_dir_is_skipped_not_fatal(self) -> None:
        plan = self.plan(
            {
                "groups": [
                    {
                        "insertAfter": "firstKey",
                        "newFields": [
                            {
                                "key": "k",
                                "value": {"app_en.arb": "x", "app_xx.arb": "y"},
                            }
                        ],
                    }
                ]
            }
        )
        self.assertEqual([entry["name"] for entry in plan["files"]], ["app_en.arb"])
        self.assertEqual(
            plan["skipped"], [{"file": "app_xx.arb", "reason": "not found"}]
        )

    def test_pure_delete_targets_every_app_arb_file(self) -> None:
        plan = self.plan(
            {"groups": [{"deleteFrom": "firstKey", "deleteTo": "firstKey"}]}
        )
        self.assertEqual(
            [entry["name"] for entry in plan["files"]],
            ["app_en.arb", "app_zh.arb", "app_zh_Hant.arb"],
        )
        for entry in plan["files"]:
            self.assertNotIn("firstKey", json.loads(entry["new_bytes"].decode("utf-8")))

    def test_a_global_delete_that_misses_one_file_fails_the_plan(self) -> None:
        """An empty newFields means every app_*.arb — so a key only some files
        have fails the plan instead of half-editing the set."""
        with self.assertRaises(ValueError) as caught:
            self.plan({"groups": [{"deleteFrom": "midKey", "deleteTo": "midKey"}]})
        self.assertIn("app_zh_Hant.arb", str(caught.exception))

    def test_plan_writes_nothing(self) -> None:
        before = {
            path.name: path.read_bytes() for path in sorted(ARB_DIR.glob("app_*.arb"))
        }
        self.plan(
            {
                "groups": [
                    {
                        "insertAfter": "firstKey",
                        "newFields": [{"key": "k", "value": {"app_en.arb": "x"}}],
                    }
                ]
            }
        )
        after = {
            path.name: path.read_bytes() for path in sorted(ARB_DIR.glob("app_*.arb"))
        }
        self.assertEqual(before, after)

    def test_missing_l10n_yaml_names_the_path(self) -> None:
        with self.assertRaises(ValueError) as caught:
            arb.plan_arb_edits(FIXTURES, instruction())
        self.assertIn("l10n.yaml not found", str(caught.exception))

    def test_untranslated_file_is_read_only_when_meaningful(self) -> None:
        meaningful = ARB_FIXTURES / "desiredFileName.txt"
        read = arb.read_untranslated(meaningful)
        self.assertIsNotNone(read)
        self.assertEqual(read["file"], "desiredFileName.txt")
        self.assertGreater(read["lines"], 0)
        self.assertIsNone(arb.read_untranslated(None))
        self.assertIsNone(arb.read_untranslated(ARB_FIXTURES / "no-such-file.txt"))


class FakeProcess:
    """Stands in for a spawned gen-l10n process."""

    pid = 4242

    def __init__(self, exit_code: int = 0) -> None:
        self._exit_code = exit_code

    def wait(self) -> int:
        return self._exit_code


class ArbToolJobTests(unittest.TestCase):
    """The runner: plan → apply → gen-l10n → untranslated, as a job."""

    def setUp(self) -> None:
        shutil.rmtree(ARB_SCRATCH, ignore_errors=True)
        shutil.copytree(ARB_FIXTURES, ARB_SCRATCH)

    def tearDown(self) -> None:
        shutil.rmtree(ARB_SCRATCH, ignore_errors=True)

    def tool_job(
        self, instructions: dict[str, Any], **overrides: Any
    ) -> tuple[Any, list[Any]]:
        """A job whose runner is the real one, with Flutter faked out."""
        spawned: list[Any] = []

        def fake_spawn(launch: list[str], **kwargs: Any) -> FakeProcess:
            spawned.append((launch, kwargs.get("cwd")))
            return FakeProcess(overrides.get("exit_code", 0))

        runner = server.make_arb_edit_runner(
            instructions,
            str(ARB_SCRATCH),
            launch_fn=lambda argv: (["stub-gen-l10n", *argv], {}),
            spawn=fake_spawn,
        )
        job = server.Job(["tool:arb-edit"], str(ARB_SCRATCH), os.devnull, runner=runner)
        return job, spawned

    def scratch_bytes(self, name: str) -> bytes:
        return (ARB_SCRATCH / "lib" / "l10n" / name).read_bytes()

    def test_full_run_edits_runs_gen_l10n_and_reports(self) -> None:
        job, spawned = self.tool_job(
            {
                "groups": [
                    {
                        "insertAfter": "firstKey",
                        "newFields": [
                            {
                                "key": "newOne",
                                "value": {
                                    "app_en.arb": "New one",
                                    "app_zh.arb": "新的一項",
                                },
                            }
                        ],
                    },
                    {
                        "insertAfter": "firstKey",
                        "deleteFrom": "midKey",
                        "deleteTo": "midKey",
                        "newFields": [],
                    },
                ]
            }
        )
        job.runner(job)

        self.assertEqual(job.status, "done")
        self.assertEqual(job.exit_code, 0)
        self.assertEqual(job.kind, "tool")
        result = job.result
        assert result is not None
        self.assertEqual(result["edited"], ["app_en.arb", "app_zh.arb"])
        self.assertEqual(result["genL10n"], {"exitCode": 0})
        # app_zh_Hant.arb is not named in any value map, so it is untouched.
        self.assertNotIn("app_zh_Hant.arb", result["edited"])
        self.assertNotIn("midKey", self.scratch_bytes("app_en.arb").decode("utf-8"))
        self.assertEqual(
            json.loads(self.scratch_bytes("app_zh.arb").decode("utf-8"))["newOne"],
            "新的一項",
        )
        self.assertIn(b"\r\n", self.scratch_bytes("app_zh.arb"))
        # gen-l10n ran in the pinned cwd, once.
        self.assertEqual(len(spawned), 1)
        self.assertEqual(spawned[0][0][0], "stub-gen-l10n")
        self.assertEqual(spawned[0][1], str(ARB_SCRATCH))
        # The fixture's untranslated-messages-file is reported, not fatal.
        untranslated = result["untranslated"]
        assert isinstance(untranslated, dict)
        self.assertEqual(untranslated["file"], "desiredFileName.txt")
        self.assertGreater(untranslated["lines"], 0)

    def test_dry_run_writes_nothing_and_never_spawns(self) -> None:
        before = {
            name: self.scratch_bytes(name)
            for name in ("app_en.arb", "app_zh.arb", "app_zh_Hant.arb")
        }
        job, spawned = self.tool_job(
            {
                "dryRun": True,
                "groups": [
                    {
                        "insertAfter": "firstKey",
                        "newFields": [{"key": "newOne", "value": {"app_en.arb": "x"}}],
                    }
                ],
            }
        )
        job.runner(job)

        self.assertEqual(job.status, "done")
        result = job.result
        assert result is not None
        self.assertTrue(result["dryRun"])
        self.assertEqual(result["edited"], [])
        self.assertIsNone(result["genL10n"])
        self.assertEqual(
            result["changes"],
            [{"file": "app_en.arb", "inserts": ["newOne"], "deletes": []}],
        )
        self.assertEqual(spawned, [])
        after = {name: self.scratch_bytes(name) for name in before}
        self.assertEqual(before, after)

    def test_gen_l10n_failure_fails_the_job_but_reports_the_edits(self) -> None:
        job, _ = self.tool_job(
            {
                "groups": [
                    {
                        "insertAfter": "firstKey",
                        "newFields": [{"key": "newOne", "value": {"app_en.arb": "x"}}],
                    }
                ]
            },
            exit_code=3,
        )
        job.runner(job)

        self.assertEqual(job.status, "failed")
        self.assertEqual(job.exit_code, 3)
        result = job.result
        assert result is not None
        # The edits stand and are reported: the caller fixes them and re-runs.
        self.assertEqual(result["edited"], ["app_en.arb"])
        self.assertEqual(result["genL10n"], {"exitCode": 3})
        self.assertIn("newOne", self.scratch_bytes("app_en.arb").decode("utf-8"))

    def test_a_failed_plan_leaves_every_file_untouched(self) -> None:
        before = {
            name: self.scratch_bytes(name)
            for name in ("app_en.arb", "app_zh.arb", "app_zh_Hant.arb")
        }
        job, spawned = self.tool_job(
            {
                "groups": [
                    {
                        "insertAfter": "firstKey",
                        "deleteFrom": "midKey",
                        "deleteTo": "midKey",
                        "newFields": [
                            {
                                "key": "k",
                                "value": {"app_en.arb": "x", "app_zh_Hant.arb": "y"},
                            }
                        ],
                    }
                ]
            }
        )
        job.runner(job)

        self.assertEqual(job.status, "failed")
        self.assertEqual(job.exit_code, 1)
        assert job.error is not None
        self.assertIn("app_zh_Hant.arb", job.error)
        self.assertIn("midKey", job.error)
        self.assertIsNone(job.result)
        self.assertEqual(spawned, [])
        after = {name: self.scratch_bytes(name) for name in before}
        self.assertEqual(before, after)

    def test_a_killed_job_does_no_work(self) -> None:
        before = self.scratch_bytes("app_en.arb")
        job, spawned = self.tool_job(
            {
                "groups": [
                    {
                        "insertAfter": "firstKey",
                        "newFields": [{"key": "k", "value": {"app_en.arb": "x"}}],
                    }
                ]
            }
        )
        job.status = "killed"
        job.runner(job)

        self.assertEqual(job.status, "killed")
        self.assertEqual(spawned, [])
        self.assertEqual(self.scratch_bytes("app_en.arb"), before)

    def test_unknown_tool_is_rejected(self) -> None:
        with self.assertRaises(KeyError):
            server.make_tool_runner("nope", {}, str(ARB_SCRATCH))
        self.assertEqual(server.TOOL_NAMES, ("arb-edit",))

    def test_display_argv_is_what_the_status_page_shows(self) -> None:
        self.assertEqual(
            server.tool_display_argv("arb-edit", instruction()),
            ["tool:arb-edit", "1 group(s)"],
        )
        self.assertEqual(
            server.tool_display_argv("arb-edit", instruction(dryRun=True)),
            ["tool:arb-edit", "1 group(s)", "--dry-run"],
        )

    def test_job_json_carries_kind_and_result(self) -> None:
        command = server.Job(["flutter", "test"], ".", os.devnull)
        self.assertEqual(command.kind, "cmd")
        self.assertIsNone(command.to_json()["result"])
        tool = server.Job(["tool:arb-edit"], ".", os.devnull, runner=lambda job: None)
        tool.result = {"edited": []}
        self.assertEqual(tool.kind, "tool")
        self.assertEqual(tool.to_json()["result"], {"edited": []})


def http_call(
    port: int,
    token: str,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    auth: bool = True,
) -> tuple[int, Any]:
    """One request against a test server: `(status, decoded json)`.

    An HTTP error is a normal answer here, not a test failure — the refusal
    codes are the thing being pinned.
    """
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method)
    if auth:
        request.add_header("Authorization", f"Bearer {token}")
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, data, timeout=30) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        # An HTTPError carries a socket too; leaving it to the garbage collector
        # prints a ResourceWarning from inside the test run.
        try:
            return error.code, json.loads(error.read().decode("utf-8"))
        finally:
            error.close()


class ArbToolRouteTests(unittest.TestCase):
    """The HTTP surface: auth, the 400 layer, and a dry-run job end to end.

    The route is where the transport knobs meet the instruction schema, and two
    defects lived exactly here: a body that went unread on an early return reset
    the connection instead of delivering the error, and `wait` was rejected as an
    unknown *instruction* field. Both are cheaper to catch here than in a
    session.
    """

    TOKEN = "route-test-token"
    # A pin is a plain boot-time path; `/health` only reports it, so a fake one
    # is enough to show the wiring without needing an SDK installed.
    PIN = r"C:\pinned\dart.exe"

    @classmethod
    def setUpClass(cls) -> None:
        shutil.rmtree(ARB_LOG_SCRATCH, ignore_errors=True)
        ARB_LOG_SCRATCH.mkdir(parents=True)
        cls.hub = server.ToolHub(
            cwd=str(ARB_FIXTURES),
            log_dir=str(ARB_LOG_SCRATCH),
            dart_format_exe=cls.PIN,
        )
        cls.httpd = server.ThreadingHTTPServer(
            ("127.0.0.1", 0), server.make_handler(cls.hub, cls.TOKEN, "")
        )
        cls.httpd.daemon_threads = True
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.hub.stop()
        shutil.rmtree(ARB_LOG_SCRATCH, ignore_errors=True)

    def call(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        auth: bool = True,
    ) -> tuple[int, Any]:
        return http_call(self.port, self.TOKEN, method, path, body, auth)

    def fixture_bytes(self) -> dict[str, bytes]:
        return {path.name: path.read_bytes() for path in sorted(ARB_DIR.glob("*.arb"))}

    def test_health_reports_the_registered_tools(self) -> None:
        status, payload = self.call("GET", "/health", auth=False)
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["tools"], ["arb-edit"])
        # The formatter pin is a capability too: a client checks it here rather
        # than parsing the boot output it never saw.
        self.assertEqual(payload["dartFormatExe"], self.PIN)

    def test_unknown_tool_is_404_even_with_a_body(self) -> None:
        status, payload = self.call("POST", "/tools/nope", {"groups": []})
        self.assertEqual(status, 404)
        self.assertIn("no such tool", payload["error"])

    def test_a_body_that_is_still_arriving_still_gets_its_401(self) -> None:
        """The reply must not be sent before the request body is consumed.

        A response sent while a body is still inbound makes Windows reset the
        connection, so the caller sees an abort and no error at all — which is
        how the absent-token case behaved before `_discard_body`. The body is
        sent in two halves with a pause, which reproduces that deterministically
        (a single-shot request only races, and passes either way).
        """
        total = 200
        body = b"x" * total
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=10)
        try:
            sock.sendall(
                (
                    "POST /tools/arb-edit HTTP/1.1\r\n"
                    f"Host: 127.0.0.1:{self.port}\r\n"
                    "Content-Type: application/json\r\n"
                    f"Content-Length: {total}\r\n"
                    "Connection: close\r\n\r\n"
                ).encode()
                + body[:50]
            )
            time.sleep(0.3)
            sock.sendall(body[50:])
            received = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                received += chunk
        finally:
            sock.close()
        self.assertTrue(received, "the server reset the connection instead of replying")
        self.assertIn(b"401", received.split(b"\r\n", 1)[0])
        self.assertIn(b"token", received)

    def test_transport_knobs_are_not_instruction_fields(self) -> None:
        """`wait`/`grep`/`tail`/`timeoutSec` shape the response, not the edit."""
        self.assertEqual(
            server.split_tool_body(
                {"groups": [], "wait": True, "timeoutSec": 5, "grep": "x", "tail": 9}
            ),
            {"groups": []},
        )

    def test_a_cwd_in_the_body_is_refused(self) -> None:
        status, payload = self.call(
            "POST", "/tools/arb-edit", {"cwd": "D:/elsewhere", "groups": []}
        )
        self.assertEqual(status, 400)
        self.assertIn("pins the working directory", payload["error"])

    def test_a_schema_error_is_a_400_and_queues_nothing(self) -> None:
        before = len(self.hub.list_jobs())
        status, payload = self.call("POST", "/tools/arb-edit", {"groups": [{}]})
        self.assertEqual(status, 400)
        self.assertIn("groups[0]", payload["error"])
        self.assertEqual(len(self.hub.list_jobs()), before)

    def test_dry_run_over_http_reports_changes_and_writes_nothing(self) -> None:
        before = self.fixture_bytes()
        status, job = self.call(
            "POST",
            "/tools/arb-edit",
            {
                "dryRun": True,
                "wait": True,
                "groups": [
                    {
                        "insertAfter": "firstKey",
                        "newFields": [
                            {
                                "key": "routeKey",
                                "value": {
                                    "app_en.arb": "Routed",
                                    "app_zh.arb": "已路由",
                                },
                            }
                        ],
                    }
                ],
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(job["kind"], "tool")
        self.assertEqual(job["status"], "done")
        self.assertEqual(job["exitCode"], 0)
        self.assertEqual(job["argv"], ["tool:arb-edit", "1 group(s)", "--dry-run"])
        self.assertEqual(
            job["result"]["changes"],
            [
                {"file": "app_en.arb", "inserts": ["routeKey"], "deletes": []},
                {"file": "app_zh.arb", "inserts": ["routeKey"], "deletes": []},
            ],
        )
        self.assertEqual(job["result"]["edited"], [])
        self.assertEqual(self.fixture_bytes(), before)

        # A finished sub-tool is an ordinary job: listed, and with a log.
        listed = self.call("GET", "/jobs")[1]
        self.assertIn(job["id"], [entry["id"] for entry in listed])
        _, fetched = self.call("GET", f"/jobs/{job['id']}?tail=20")
        self.assertIn("DRY RUN", fetched["tail"])
        self.assertEqual(fetched["result"], job["result"])


class DartFormatPinTests(unittest.TestCase):
    """`dart format` jobs run the pinned SDK; nothing else does.

    The pin exists because CI's dart and the locally installed one format
    differently, so formatting here with the local one is exactly what turns
    CI's `dart format --set-exit-if-changed` check red.
    """

    PIN = r"D:\pinned\dart.exe"

    def test_only_dart_format_routes(self) -> None:
        for argv in (
            ["dart", "format"],
            ["dart", "format", "lib"],
            ["dart", "format", "--output=none", "--set-exit-if-changed", "lib/a.dart"],
            [r"D:\flutter\bin\dart.bat", "format", "lib"],
            ["dart.exe", "format"],
        ):
            with self.subTest(argv=argv):
                self.assertEqual(server.dart_format_target(argv, self.PIN), self.PIN)
        for argv in (
            ["dart"],
            ["dart", "analyze", "lib"],
            ["dart", "test"],
            ["dart", "pub", "get"],
            ["dart", "run", "tool/generate.dart"],
            ["dart", "--version"],
            ["flutter", "format", "lib"],
            ["git", "status"],
        ):
            with self.subTest(argv=argv):
                self.assertIsNone(server.dart_format_target(argv, self.PIN))

    def test_without_a_pin_nothing_routes(self) -> None:
        self.assertIsNone(server.dart_format_target(["dart", "format"], None))

    def test_resolve_launch_swaps_in_the_pin(self) -> None:
        shutil.rmtree(PIN_SCRATCH, ignore_errors=True)
        PIN_SCRATCH.mkdir(parents=True)
        self.addCleanup(shutil.rmtree, PIN_SCRATCH, True)
        fake = PIN_SCRATCH / "dart.exe"
        fake.write_bytes(b"")
        launch, extra_env = server.resolve_launch(
            ["dart", "format", "--output=none", "lib/a.dart"], str(fake)
        )
        self.assertEqual(launch, [str(fake), "format", "--output=none", "lib/a.dart"])
        # A standalone dart is a real executable: no `.bat` unwrapping, and no
        # FLUTTER_ROOT to add.
        self.assertEqual(extra_env, {})

    def test_a_missing_pin_fails_loudly(self) -> None:
        """Falling back to the PATH dart would be the bug the pin prevents."""
        gone = str(PIN_SCRATCH / "gone.exe")
        with self.assertRaises(FileNotFoundError) as caught:
            server.resolve_launch(["dart", "format", "lib"], gone)
        self.assertIn("pinned dart format executable is missing", str(caught.exception))


class UncommittedScopeTests(unittest.TestCase):
    """What `scope: "uncommitted"` selects, and how it applies per verb."""

    # Captured from `git status --porcelain=v1 -z --untracked-files=all` in a
    # scratch repo holding a modified, a deleted, a renamed, an untracked, an
    # ignored and a staged file. The rename record is the fact worth pinning:
    # the destination comes *first* and the source path follows as its own bare
    # record (verified against git on Windows).
    PORCELAIN = (
        " M a.dart\0 D c.dart\0R  renamed.dart\0b.dart\0?? untracked.dart\0"
        "!! ignored.dart\0A  staged.dart\0"
    )

    def test_porcelain_selects_what_exists_and_is_uncommitted(self) -> None:
        self.assertEqual(
            server.parse_porcelain(self.PORCELAIN),
            ["a.dart", "renamed.dart", "untracked.dart", "staged.dart"],
        )

    def test_paths_are_never_quoted_or_escaped(self) -> None:
        """`-z` hands over a CJK path as itself, not as \\NNN escapes."""
        self.assertEqual(
            server.parse_porcelain("?? lib/中文 名字.dart\0"), ["lib/中文 名字.dart"]
        )

    def test_only_dart_files_are_scoped(self) -> None:
        self.assertEqual(
            server.uncommitted_dart_files("unused", run_git=lambda cwd: self.PORCELAIN),
            ["a.dart", "renamed.dart", "staged.dart", "untracked.dart"],
        )

    def test_git_cannot_answer_is_refused(self) -> None:
        """A directory git cannot run in is an error, never an empty scope."""
        missing = str(HERE / ".tmp-scope-not-here")
        with self.assertRaises(ValueError):
            server.uncommitted_dart_files(missing)

    def test_scope_mode_per_verb(self) -> None:
        self.assertEqual(server.scope_mode("dart", ["format", "lib"]), "expand")
        for cmd, verb in (
            ("dart", "analyze"),
            ("flutter", "analyze"),
            ("dart", "fix"),
            ("flutter", "fix"),
        ):
            with self.subTest(cmd=cmd, verb=verb):
                self.assertEqual(server.scope_mode(cmd, [verb]), "filter")
        for cmd, verb in (
            ("dart", "test"),
            ("flutter", "test"),
            ("dart", "pub"),
            ("git", "status"),
        ):
            with self.subTest(cmd=cmd, verb=verb):
                self.assertIsNone(server.scope_mode(cmd, [verb]))
        self.assertIsNone(server.scope_mode("dart", []))

    def test_filter_regex_matches_paths_not_prefixes(self) -> None:
        pattern = server.path_filter_regex(["lib/a.dart", "test/b_test.dart"])
        self.assertIsNotNone(pattern.search("   info • unused • lib/a.dart:3:1"))
        self.assertIsNone(pattern.search("   info • unused • lib/ab.dart:3:1"))

    def test_job_json_carries_the_scope(self) -> None:
        scoped = server.Job(
            ["dart", "format", "a.dart"], ".", os.devnull, scope="uncommitted"
        )
        self.assertEqual(scoped.to_json()["scope"], "uncommitted")
        plain = server.Job(["dart", "format"], ".", os.devnull)
        self.assertIsNone(plain.to_json()["scope"])


class ScopeRouteTests(unittest.TestCase):
    """`scope` on `/run`: refusals at submit time, expansion on the job.

    The file list is injected, so nothing here depends on git or on the repo's
    own state — the contract being pinned is the transport: what is refused,
    what the queued argv looks like, and that a refusal queues nothing.
    """

    TOKEN = "scope-test-token"
    FILES: ClassVar[list[str]] = ["lib/scoped_a.dart", "lib/scoped_b.dart"]

    @classmethod
    def setUpClass(cls) -> None:
        shutil.rmtree(SCOPE_LOG_SCRATCH, ignore_errors=True)
        shutil.rmtree(SCOPE_SCRATCH, ignore_errors=True)
        SCOPE_LOG_SCRATCH.mkdir(parents=True)
        SCOPE_SCRATCH.mkdir()
        cls.files: list[str] = list(cls.FILES)
        cls.git_error: str | None = None

        def fake_uncommitted(cwd: str) -> list[str]:
            if cls.git_error is not None:
                raise ValueError(cls.git_error)
            return list(cls.files)

        cls.hub = server.ToolHub(
            cwd=str(SCOPE_SCRATCH),
            log_dir=str(SCOPE_LOG_SCRATCH),
            uncommitted_files_fn=fake_uncommitted,
        )
        cls.httpd = server.ThreadingHTTPServer(
            ("127.0.0.1", 0), server.make_handler(cls.hub, cls.TOKEN, "")
        )
        cls.httpd.daemon_threads = True
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.hub.stop()
        shutil.rmtree(SCOPE_LOG_SCRATCH, ignore_errors=True)
        shutil.rmtree(SCOPE_SCRATCH, ignore_errors=True)

    def setUp(self) -> None:
        type(self).files = list(self.FILES)
        type(self).git_error = None

    def call(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        auth: bool = True,
    ) -> tuple[int, Any]:
        return http_call(self.port, self.TOKEN, method, path, body, auth)

    def test_dart_format_gets_the_files_appended(self) -> None:
        status, job = self.call(
            "POST",
            "/run",
            {
                "cmd": "dart",
                "args": ["format", "--output=none"],
                "scope": "uncommitted",
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(job["scope"], "uncommitted")
        self.assertEqual(job["argv"], ["dart", "format", "--output=none", *self.FILES])

    def test_analyze_keeps_its_argv_and_filters_the_log(self) -> None:
        status, job = self.call(
            "POST",
            "/run",
            {"cmd": "dart", "args": ["analyze", "lib"], "scope": "uncommitted"},
        )
        self.assertEqual(status, 200)
        # The analyzer accepts a directory, never a file list: argv is untouched
        # and the narrowing happens on the returned lines.
        self.assertEqual(job["argv"], ["dart", "analyze", "lib"])
        self.assertIn("lib/scoped_a\\.dart", job["log"]["grep"])

    def test_unknown_scope_is_a_400(self) -> None:
        before = len(self.hub.list_jobs())
        status, payload = self.call(
            "POST",
            "/run",
            {"cmd": "dart", "args": ["format"], "scope": "staged"},
        )
        self.assertEqual(status, 400)
        self.assertIn("unknown scope", payload["error"])
        self.assertEqual(len(self.hub.list_jobs()), before)

    def test_scope_must_be_a_string(self) -> None:
        status, payload = self.call(
            "POST", "/run", {"cmd": "dart", "args": ["format"], "scope": 7}
        )
        self.assertEqual(status, 400)
        self.assertIn("scope must be a string", payload["error"])

    def test_scope_with_grep_is_a_400(self) -> None:
        status, payload = self.call(
            "POST",
            "/run",
            {
                "cmd": "dart",
                "args": ["format"],
                "scope": "uncommitted",
                "grep": "lib/",
            },
        )
        self.assertEqual(status, 400)
        self.assertIn("either grep or scope", payload["error"])

    def test_an_unscopable_command_is_a_403(self) -> None:
        before = len(self.hub.list_jobs())
        for cmd, args in (
            ("git", ["status"]),
            ("dart", ["test"]),
            ("flutter", ["test"]),
        ):
            with self.subTest(cmd=cmd, args=args):
                status, payload = self.call(
                    "POST",
                    "/run",
                    {"cmd": cmd, "args": args, "scope": "uncommitted"},
                )
                self.assertEqual(status, 403)
                self.assertIn("scope is not supported", payload["error"])
        self.assertEqual(len(self.hub.list_jobs()), before)

    def test_an_empty_uncommitted_set_is_a_400(self) -> None:
        """`dart format` with no paths rewrites the whole tree — never do that."""
        type(self).files = []
        before = len(self.hub.list_jobs())
        status, payload = self.call(
            "POST",
            "/run",
            {
                "cmd": "dart",
                "args": ["format", "--output=none"],
                "scope": "uncommitted",
            },
        )
        self.assertEqual(status, 400)
        self.assertIn("no uncommitted .dart files", payload["error"])
        self.assertEqual(len(self.hub.list_jobs()), before)

    def test_a_git_failure_is_a_400(self) -> None:
        failure = "git status failed (exit 128): fatal: not a git repository"
        type(self).git_error = failure
        before = len(self.hub.list_jobs())
        status, payload = self.call(
            "POST", "/run", {"cmd": "dart", "args": ["format"], "scope": "uncommitted"}
        )
        self.assertEqual(status, 400)
        self.assertIn("not a git repository", payload["error"])
        self.assertEqual(len(self.hub.list_jobs()), before)


class KnownFailureRegistryTests(unittest.TestCase):
    """The known-failure registry: what it claims, and how the digest reads it.

    The registry answers "is this failure mine?" for a project that has already
    written its pre-existing failures down (platform-specific, flaky, ...). The
    two directions must stay distinguishable: a matched failure is annotated and
    lands in the split's `known` count, an unmatched one is *named* in
    `newFailures`, and a registry that cannot be read claims neither.
    """

    FLUTTER_TEST: ClassVar[list[str]] = ["flutter", "test", "test/desktop"]

    def setUp(self) -> None:
        shutil.rmtree(REGISTRY_SCRATCH, ignore_errors=True)
        REGISTRY_SCRATCH.mkdir(parents=True)

    def tearDown(self) -> None:
        shutil.rmtree(REGISTRY_SCRATCH, ignore_errors=True)

    def write_registry(self, document: object) -> None:
        """Writes the registry, raw when a string (for malformed-document tests)."""
        target = REGISTRY_SCRATCH / ".toolbridge"
        target.mkdir(parents=True, exist_ok=True)
        text = document if isinstance(document, str) else json.dumps(document)
        (target / "known-failures.json").write_text(text, encoding="utf-8")

    def digest(self, name: str = "expanded_failed.txt") -> Mapping[str, Any]:
        return server.analyze_test_log(self.FLUTTER_TEST, fixture(name))

    def split(self, document: object, log: str = "expanded_failed.txt") -> Any:
        """The whole pipeline: log → digest → registry → annotated split."""
        self.write_registry(document)
        digest = self.digest(log)
        registry = server.load_known_failures(str(REGISTRY_SCRATCH))
        report = server.baseline_report(digest["failures"], digest["counts"], registry)
        assert report is not None
        return (
            digest,
            registry,
            report,
            server.summarize_with_baseline(digest["summary"], report),
        )

    def test_without_a_registry_nothing_changes(self) -> None:
        digest = self.digest()
        registry = server.load_known_failures(str(REGISTRY_SCRATCH))
        self.assertFalse(registry["exists"])
        self.assertIsNone(
            server.baseline_report(digest["failures"], digest["counts"], registry)
        )
        self.assertEqual(
            server.summarize_with_baseline(digest["summary"], None),
            "83 passed, 6 failed",
        )

    def test_entries_claim_failures_by_name_and_by_regex(self) -> None:
        digest, _, report, summary = self.split(
            {
                "entries": [
                    {
                        "name": "alpha refuses a bad key",
                        "kind": "platform",
                        "platform": server.current_platform(),
                        "reason": "Windows-only: path separator",
                    },
                    {"match": r"^(bravo|delta) ", "kind": "flaky", "reason": "timing"},
                ]
            }
        )
        self.assertEqual(report["known"], 3)
        self.assertEqual(report["new"], 3)
        self.assertEqual(
            [entry["name"] for entry in report["newFailures"]],
            ["gamma restores state", "epsilon syncs", "zeta handles empty"],
        )
        self.assertEqual(
            digest["failures"][0]["known"],
            {"kind": "platform", "reason": "Windows-only: path separator"},
        )
        self.assertNotIn("known", digest["failures"][2])
        self.assertEqual(summary, "83 passed, 6 failed (3 known, 3 new)")

    def test_platform_gating_skips_the_other_os(self) -> None:
        """A Windows-only entry must not silence a failure on CI's Linux."""
        other = "posix" if server.IS_WINDOWS else "windows"
        _, _, elsewhere, _ = self.split(
            {"entries": [{"name": "alpha refuses a bad key", "platform": other}]}
        )
        self.assertEqual(elsewhere["known"], 0)
        self.assertEqual(elsewhere["newFailures"][0]["name"], "alpha refuses a bad key")
        _, _, here, _ = self.split(
            {
                "entries": [
                    {
                        "name": "alpha refuses a bad key",
                        "platform": server.current_platform(),
                        "kind": "platform",
                    }
                ]
            }
        )
        self.assertEqual(here["known"], 1)

    def test_file_narrows_an_entry_to_one_suite(self) -> None:
        _, _, right, _ = self.split(
            {
                "entries": [
                    {
                        "file": "test/desktop/alpha_test.dart",
                        "name": "alpha refuses a bad key",
                    }
                ]
            }
        )
        self.assertEqual(right["known"], 1)
        _, _, wrong, _ = self.split(
            {
                "entries": [
                    {
                        "file": "test/other/alpha_test.dart",
                        "name": "alpha refuses a bad key",
                    }
                ]
            }
        )
        self.assertEqual(wrong["known"], 0)

    def test_a_windows_style_reported_path_still_matches(self) -> None:
        """The reporter's absolute, mixed-separator path is normalised, not typed."""
        entries = server.parse_known_failures(
            {"entries": [{"file": "test/desktop/alpha_test.dart", "name": "alpha x"}]}
        )
        failure: dict[str, Any] = {
            "file": r"C:\WS\test\desktop\alpha_test.dart",
            "name": "alpha x",
            "didNotComplete": False,
        }
        self.assertIsNotNone(server.known_entry_for(entries, failure))
        failure["file"] = r"C:\WS\test\other\alpha_test.dart"
        self.assertIsNone(server.known_entry_for(entries, failure))

    def test_the_first_matching_entry_wins(self) -> None:
        _, _, report, _ = self.split(
            {
                "entries": [
                    {"match": "alpha", "kind": "flaky", "reason": "first"},
                    {"match": "alpha", "kind": "platform", "reason": "second"},
                ]
            }
        )
        self.assertEqual(report["known"], 1)
        self.assertEqual(report["newFailures"][0]["name"], "bravo retries once")

    def test_a_shorter_inventory_is_reported_as_unparsed(self) -> None:
        """`counts.failed` is authoritative; the split must not look complete."""
        self.write_registry({"entries": [{"name": "alpha refuses a bad key"}]})
        digest = self.digest()
        registry = server.load_known_failures(str(REGISTRY_SCRATCH))
        report = server.baseline_report(
            digest["failures"][:4], digest["counts"], registry
        )
        assert report is not None
        self.assertEqual(report["unparsed"], 2)
        self.assertEqual(
            server.summarize_with_baseline(digest["summary"], report),
            "83 passed, 6 failed (1 known, 3 new, 2 unparsed)",
        )

    def test_a_broken_registry_claims_nothing_and_says_so(self) -> None:
        self.write_registry("{ not json")
        digest = self.digest()
        registry = server.load_known_failures(str(REGISTRY_SCRATCH))
        self.assertTrue(registry["exists"])
        self.assertIsNotNone(registry["error"])
        report = server.baseline_report(digest["failures"], digest["counts"], registry)
        assert report is not None
        self.assertEqual(report["known"], 0)
        self.assertEqual(report["new"], 6)
        self.assertEqual(report["error"], registry["error"])
        self.assertNotIn("known", digest["failures"][0])
        # No split is claimed in the summary either: the one-liner must not read
        # as "all known" when the registry never loaded.
        self.assertEqual(
            server.summarize_with_baseline(digest["summary"], report),
            "83 passed, 6 failed",
        )

    def test_schema_errors_name_the_entry(self) -> None:
        cases: tuple[tuple[object, str], ...] = (
            ("[]", "must be a JSON object"),
            ({"entries": {}}, "needs an 'entries' list"),
            ({"entries": [7]}, "entries[0] must be an object"),
            ({"entries": [{}]}, "needs exactly one of 'name' or 'match'"),
            ({"entries": [{"name": "x", "match": "y"}]}, "exactly one"),
            ({"entries": [{"name": "x", "kind": "mystery"}]}, "kind must be one of"),
            ({"entries": [{"name": "x", "platform": "linux"}]}, "platform must be"),
            ({"entries": [{"match": "([", "kind": "flaky"}]}, "not a valid regex"),
            ({"entries": [{"name": "x", "reason": 5}]}, "reason must be a string"),
            ({"entries": [{"name": 5}]}, "name must be a string"),
        )
        for document, expected in cases:
            with self.subTest(document=document):
                self.write_registry(document)
                registry = server.load_known_failures(str(REGISTRY_SCRATCH))
                self.assertIn(expected, registry["error"] or "")

    def test_a_passing_run_is_never_annotated(self) -> None:
        _, _, report, summary = self.split(
            {"entries": [{"match": ".*"}]}, log="expanded_passed.txt"
        )
        self.assertEqual(report["known"], 0)
        self.assertEqual(summary, "33 passed, 2 skipped")

    def test_a_test_that_reports_twice_is_counted_once(self) -> None:
        """A failure in the body *and* in tearDown prints two `[E]` lines.

        Observed on a real run: 79 `[E]` lines covered 77 failing tests, which
        made a naive split contradict the count the summary leads with.
        """
        self.write_registry({"entries": [{"name": "alpha refuses a bad key"}]})
        digest = self.digest()
        alpha = next(
            e for e in digest["failures"] if e["name"] == "alpha refuses a bad key"
        )
        failures = [*digest["failures"], dict(alpha)]
        registry = server.load_known_failures(str(REGISTRY_SCRATCH))
        report = server.baseline_report(failures, digest["counts"], registry)
        assert report is not None
        self.assertEqual(report["events"], 7)
        self.assertEqual(report["tests"], 6)
        self.assertEqual(report["failed"], 6)
        self.assertEqual(report["known"], 1)
        self.assertEqual(report["new"], 5)
        self.assertEqual(report["unparsed"], 0)
        # Every event is annotated, the duplicate included: an event that lost
        # its `known` would read as new.
        self.assertTrue(all("known" in e for e in failures[:1] + [failures[-1]]))
        self.assertEqual(
            server.summarize_with_baseline(digest["summary"], report),
            "83 passed, 6 failed (1 known, 5 new)",
        )

    def test_an_unreconcilable_inventory_keeps_the_summary_plain(self) -> None:
        """More named tests than `counts.failed` states: claim no split at all."""
        self.write_registry({"entries": [{"name": "alpha refuses a bad key"}]})
        digest = self.digest()
        registry = server.load_known_failures(str(REGISTRY_SCRATCH))
        report = server.baseline_report(
            digest["failures"],
            {"passed": 83, "skipped": 0, "failed": 3},
            registry,
        )
        assert report is not None
        self.assertEqual(report["tests"], 6)
        self.assertEqual(report["failed"], 3)
        self.assertEqual(report["unparsed"], 0)
        self.assertEqual(
            server.summarize_with_baseline(digest["summary"], report),
            "83 passed, 6 failed",
        )

    def test_the_baseline_rides_with_the_log_view_only(self) -> None:
        job = server.Job(["flutter", "test"], ".", os.devnull)
        job.baseline = {
            "source": ".toolbridge/known-failures.json",
            "known": 1,
            "new": 0,
            "unparsed": 0,
            "newFailures": [],
            "error": None,
        }
        self.assertNotIn("baseline", job.to_json())
        self.assertIn("baseline", job.to_json(tail_lines=5))


# ---------------------------------------------------------------------------
# Node toolchain: the pnpm surface, script binaries, the vitest digest, lanes
# ---------------------------------------------------------------------------

# A scratch npm-shaped tree for the launcher tests, a scratch project for the
# jobs that really spawn Node, and the log directory both share.
NODE_SCRATCH = HERE / ".tmp-node"
NODE_PROJECT = HERE / ".tmp-node-project"
NODE_LOG_SCRATCH = HERE / ".tmp-node-logs"

# What a fake project's own tools print and do. The server stays up (a pending
# timer keeps Node alive) because that is what "long job" means; the suite prints
# a real passing vitest report and exits, so the digest is exercised end to end.
FAKE_SERVER = "console.log('dev server up');\nsetTimeout(() => {}, 600000);\n"
FAKE_SUITE = (
    "console.log('');\n"
    "console.log(' RUN  v5.0.3 C:/ws');\n"
    "console.log('');\n"
    "console.log(' Test Files  1 passed (1)');\n"
    "console.log('      Tests  2 passed (2)');\n"
)


def write_package(
    root: pathlib.Path,
    package: str,
    bin_field: object,
    entry: str | None,
    source: str = "// fake\n",
) -> pathlib.Path:
    """A fake installed package, laid out the way pnpm leaves it.

    `entry` is created inside the package directory; None skips creating it,
    which is how a `bin` field pointing outside the package is set up.
    """
    package_dir = root.joinpath("node_modules", *package.split("/"))
    package_dir.mkdir(parents=True, exist_ok=True)
    (package_dir / "package.json").write_text(
        json.dumps({"name": package, "bin": bin_field}), encoding="utf-8"
    )
    if entry is None:
        return package_dir
    target = package_dir / entry
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(source, encoding="utf-8")
    return target


def build_fake_project(root: pathlib.Path) -> None:
    """A project whose own `vite` and `vitest` are fake Node scripts.

    Written in place rather than recreated: two test classes share this tree, and
    a just-killed Node process can still hold a handle on it for a moment, which
    a `rmtree` + `mkdir` pair would turn into a spurious failure.
    """
    root.mkdir(parents=True, exist_ok=True)
    write_package(root, "vite", {"vite": "bin/vite.js"}, "bin/vite.js", FAKE_SERVER)
    write_package(root, "vitest", "./vitest.mjs", "vitest.mjs", FAKE_SUITE)


def remove_tree(path: pathlib.Path, attempts: int = 10) -> None:
    """Removes a scratch tree, waiting out a process that is still dying.

    A just-killed Node process can hold a handle on its script's directory for a
    moment, which makes `rmtree` fail with `PermissionError` on Windows — and
    `ignore_errors=True` would then leave the tree behind for the next run to
    trip over.
    """
    for attempt in range(attempts):
        try:
            shutil.rmtree(path)
            return
        except FileNotFoundError:
            return
        except OSError:
            if attempt == attempts - 1:
                raise
            time.sleep(0.2)


class PatchedWhich:
    """`shutil.which` as a lookup table, restored on exit.

    `resolve_pnpm` has to be shown working against the wrapper layouts found in
    the wild (nvm4w, corepack), which means pointing the lookup at scratch files
    instead of the machine's own pnpm.
    """

    def __init__(self, mapping: dict[str, str | None]) -> None:
        self.mapping = mapping
        self.saved: Any = None

    def __enter__(self) -> PatchedWhich:
        self.saved = server.shutil.which

        def fake_which(name: str) -> str | None:
            if name in self.mapping:
                return self.mapping[name]
            return self.saved(name)

        server.shutil.which = fake_which
        return self

    def __exit__(self, *exc: object) -> bool:
        server.shutil.which = self.saved
        return False


class PnpmSurfaceTests(unittest.TestCase):
    """`pnpm` is verb-guarded, and `exec` is not a general command runner."""

    ALLOWED: ClassVar[list[list[str]]] = [
        ["pnpm", "install"],
        ["pnpm", "install", "--no-frozen-lockfile"],
        ["pnpm", "add", "-D", "svelte"],
        ["pnpm", "update"],
        ["pnpm", "run", "build"],
        ["pnpm", "run", "dev", "--", "--host"],
        ["pnpm", "exec", "vitest", "run", "--pool=threads"],
        ["pnpm", "exec", "--", "vitest", "run"],
        ["pnpm", "why", "svelte"],
    ]

    REFUSED: ClassVar[list[list[str]]] = [
        ["pnpm"],
        ["pnpm", "--version"],
        ["pnpm", "publish"],
        ["pnpm", "dlx", "create-svelte"],
        ["pnpm", "store", "prune"],
        ["pnpm", "-C", "elsewhere", "run", "build"],
        ["pnpm", "install", "--prefix", "elsewhere"],
        ["pnpm", "install", "-g", "typescript"],
        ["pnpm", "run", "build", "-w"],
        ["pnpm", "exec", "node", "--version"],
        ["pnpm", "exec", "cmd", "/c", "echo hi"],
        ["pnpm", "exec", "./node_modules/.bin/vitest", "run"],
        ["pnpm", "exec", "-c", "vitest run"],
        ["pnpm", "exec"],
    ]

    def test_allowed_forms(self) -> None:
        for argv in self.ALLOWED:
            with self.subTest(argv=argv):
                server.validate(argv)

    def test_refused_forms(self) -> None:
        for argv in self.REFUSED:
            with self.subTest(argv=argv):
                with self.assertRaises(ValueError):
                    server.validate(argv)

    def test_a_retargeting_flag_says_what_it_would_have_done(self) -> None:
        """The refusal has to read as "run somewhere else", not as a typo."""
        for argv in (
            ["pnpm", "-C", "elsewhere", "install"],
            ["pnpm", "install", "--prefix=elsewhere"],
            ["pnpm", "install", "-g", "typescript"],
        ):
            with self.subTest(argv=argv):
                with self.assertRaises(ValueError) as caught:
                    server.validate(argv)
                self.assertIn("pinned", str(caught.exception))

    def test_an_exec_target_outside_the_tool_set_names_the_substitute(self) -> None:
        with self.assertRaises(ValueError) as caught:
            server.validate(["pnpm", "exec", "node", "-e", "1"])
        self.assertIn("pnpm run", str(caught.exception))

    def test_the_script_binaries_are_commands_of_their_own(self) -> None:
        for name in sorted(server.SCRIPT_BINARIES):
            with self.subTest(name=name):
                server.validate([name, "--version"])

    def test_an_unknown_command_lists_what_is_allowed(self) -> None:
        with self.assertRaises(ValueError) as caught:
            server.validate(["npm", "install"])
        message = str(caught.exception)
        self.assertIn("pnpm", message)
        self.assertIn("vitest", message)


class ScriptBinaryLaunchTests(unittest.TestCase):
    """A script binary runs as `node <pkg>/<bin>`, out of the pinned cwd."""

    @classmethod
    def setUpClass(cls) -> None:
        NODE_SCRATCH.mkdir(parents=True, exist_ok=True)

    @classmethod
    def tearDownClass(cls) -> None:
        remove_tree(NODE_SCRATCH)

    def setUp(self) -> None:
        remove_tree(NODE_SCRATCH / "node_modules")

    def test_bin_declared_as_an_object(self) -> None:
        target = write_package(
            NODE_SCRATCH, "vite", {"vite": "bin/vite.js"}, "bin/vite.js"
        )
        launch, extra_env = server.resolve_launch(
            ["vite", "build"], cwd=str(NODE_SCRATCH)
        )
        self.assertEqual(launch, [server.node_exe(), str(target), "build"])
        self.assertEqual(extra_env, {})

    def test_bin_declared_as_a_string(self) -> None:
        target = write_package(NODE_SCRATCH, "vitest", "./vitest.mjs", "vitest.mjs")
        launch, _ = server.resolve_launch(["vitest", "run"], cwd=str(NODE_SCRATCH))
        self.assertEqual(launch[1], str(target))

    def test_a_command_whose_package_is_named_differently(self) -> None:
        target = write_package(
            NODE_SCRATCH,
            "typescript",
            {"tsc": "./bin/tsc", "tsserver": "./bin/tsserver"},
            "bin/tsc",
        )
        launch, _ = server.resolve_launch(["tsc", "--noEmit"], cwd=str(NODE_SCRATCH))
        self.assertEqual(launch[1], str(target))

    def test_a_scoped_package(self) -> None:
        target = write_package(
            NODE_SCRATCH, "@sveltejs/kit", {"svelte-kit": "src/cli.js"}, "src/cli.js"
        )
        launch, _ = server.resolve_launch(["svelte-kit", "sync"], cwd=str(NODE_SCRATCH))
        self.assertEqual(launch[1], str(target))

    def test_a_package_that_is_not_installed_names_its_manifest(self) -> None:
        with self.assertRaises(FileNotFoundError) as caught:
            server.resolve_launch(["vite", "build"], cwd=str(NODE_SCRATCH))
        self.assertIn("node_modules", str(caught.exception))

    def test_a_bin_entry_escaping_its_package_is_refused(self) -> None:
        write_package(NODE_SCRATCH, "vite", {"vite": "../../../outside.js"}, None)
        with self.assertRaises(FileNotFoundError) as caught:
            server.resolve_launch(["vite", "build"], cwd=str(NODE_SCRATCH))
        self.assertIn("outside its package", str(caught.exception))

    def test_the_pinned_cwd_is_what_is_searched(self) -> None:
        """A package next to *this* test file must not be picked up."""
        write_package(NODE_SCRATCH, "vite", {"vite": "bin/vite.js"}, "bin/vite.js")
        with self.assertRaises(FileNotFoundError):
            server.resolve_launch(["vite", "build"], cwd=str(HERE))


class PnpmLaunchTests(unittest.TestCase):
    """`pnpm` on PATH is a wrapper, so its JavaScript entry is launched."""

    @classmethod
    def setUpClass(cls) -> None:
        NODE_SCRATCH.mkdir(parents=True, exist_ok=True)
        nvm = NODE_SCRATCH / "nvm4w"
        cls.entry = nvm / "node_modules" / "pnpm" / "bin" / "pnpm.mjs"
        cls.entry.parent.mkdir(parents=True)
        cls.entry.write_text("// pnpm\n", encoding="utf-8")
        cls.wrapper = nvm / "pnpm.CMD"
        cls.wrapper.write_text(
            "@ECHO off\n"
            'endLocal & "%_prog%"  "%dp0%\\node_modules\\pnpm\\bin\\pnpm.mjs" %*\n',
            encoding="utf-8",
        )
        # A corepack-managed install keeps pnpm elsewhere: only the wrapper names
        # the entry point, which is what the shim reader is for.
        corepack = NODE_SCRATCH / "corepack"
        cls.corepack_entry = corepack / "node_modules" / "corepack" / "dist" / "pnpm.js"
        cls.corepack_entry.parent.mkdir(parents=True)
        cls.corepack_entry.write_text("// corepack pnpm\n", encoding="utf-8")
        cls.corepack_wrapper = corepack / "pnpm.CMD"
        cls.corepack_wrapper.write_text(
            '@ECHO off\nnode "%dp0%\\node_modules\\corepack\\dist\\pnpm.js" %*\n',
            encoding="utf-8",
        )
        cls.standalone = NODE_SCRATCH / "standalone" / "pnpm.exe"
        cls.standalone.parent.mkdir(parents=True)
        cls.standalone.write_text("", encoding="utf-8")

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(NODE_SCRATCH, ignore_errors=True)

    def test_the_usual_layout(self) -> None:
        with PatchedWhich({"pnpm": str(self.wrapper)}):
            self.assertEqual(
                server.resolve_pnpm(), [server.node_exe(), str(self.entry)]
            )

    def test_a_wrapper_that_only_names_its_own_entry(self) -> None:
        with PatchedWhich({"pnpm": str(self.corepack_wrapper)}):
            self.assertEqual(
                server.resolve_pnpm(), [server.node_exe(), str(self.corepack_entry)]
            )

    def test_a_standalone_pnpm_exe_is_used_as_it_is(self) -> None:
        with PatchedWhich({"pnpm": str(self.standalone)}):
            self.assertEqual(server.resolve_pnpm(), [str(self.standalone)])

    def test_no_pnpm_on_path(self) -> None:
        with PatchedWhich({"pnpm": None}):
            with self.assertRaises(FileNotFoundError):
                server.resolve_pnpm()

    def test_a_wrapper_with_no_findable_entry(self) -> None:
        orphan = NODE_SCRATCH / "orphan" / "pnpm.CMD"
        orphan.parent.mkdir(parents=True)
        orphan.write_text("@ECHO off\necho nothing to see\n", encoding="utf-8")
        with PatchedWhich({"pnpm": str(orphan)}):
            with self.assertRaises(FileNotFoundError):
                server.resolve_pnpm()

    def test_the_job_launches_node_plus_the_entry(self) -> None:
        with PatchedWhich({"pnpm": str(self.wrapper)}):
            launch, _ = server.resolve_launch(["pnpm", "run", "build"])
            self.assertEqual(
                launch, [server.node_exe(), str(self.entry), "run", "build"]
            )


class VitestDigestTests(unittest.TestCase):
    """The vitest reporter, read the way the flutter reporter already was."""

    VITEST: ClassVar[list[str]] = ["vitest", "run"]

    @classmethod
    def setUpClass(cls) -> None:
        NODE_LOG_SCRATCH.mkdir(parents=True, exist_ok=True)

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(NODE_LOG_SCRATCH, ignore_errors=True)

    def digest(self, name: str, argv: list[str] | None = None) -> Mapping[str, Any]:
        return server.analyze_test_log(argv or self.VITEST, fixture(name))

    def scratch_log(self, name: str, text: str) -> str:
        path = NODE_LOG_SCRATCH / name
        path.write_text(text, encoding="utf-8")
        return str(path)

    def test_counts_summary_and_flavor(self) -> None:
        digest = self.digest("vitest_two_files_failed.txt")
        self.assertEqual(digest["flavor"], "vitest")
        self.assertEqual(digest["counts"], {"passed": 3, "skipped": 0, "failed": 1})
        self.assertEqual(digest["summary"], "3 passed, 1 failed")

    def test_the_failure_inventory_carries_the_suite_and_the_full_name(self) -> None:
        digest = self.digest("vitest_two_files_failed.txt")
        self.assertEqual(
            digest["failures"],
            [
                {
                    "file": "src/App.test.ts",
                    "name": "add > fails on purpose",
                    "didNotComplete": False,
                }
            ],
        )

    def test_a_passing_run_has_counts_and_no_failures(self) -> None:
        digest = self.digest("vitest_passing.txt")
        self.assertEqual(digest["counts"], {"passed": 2, "skipped": 0, "failed": 0})
        self.assertEqual(digest["summary"], "2 passed")
        self.assertEqual(digest["failures"], [])

    def test_a_suite_that_never_loaded_counts_as_a_failure(self) -> None:
        """`Tests  no tests` with a red run: the suite failure is the failure."""
        digest = self.digest("vitest_load_failure.txt")
        self.assertEqual(digest["counts"], {"passed": 0, "skipped": 0, "failed": 1})
        self.assertEqual(digest["summary"], "0 passed, 1 failed")
        self.assertEqual(
            digest["failures"],
            [
                {
                    "file": "src/Broken.test.ts",
                    "name": "loading src/Broken.test.ts",
                    "didNotComplete": False,
                }
            ],
        )

    def test_pnpm_run_test_is_recognised_from_the_log(self) -> None:
        """The script name is the project's word for it, so content decides."""
        digest = server.analyze_test_log(
            ["pnpm", "run", "test"], fixture("vitest_two_files_failed.txt")
        )
        self.assertEqual(digest["flavor"], "vitest")
        self.assertEqual(digest["summary"], "3 passed, 1 failed")

    def test_a_pnpm_job_with_a_foreign_log_has_no_digest(self) -> None:
        digest = server.analyze_test_log(
            ["pnpm", "run", "build"], fixture("expanded_failed.txt")
        )
        self.assertIsNone(digest["flavor"])
        self.assertIsNone(digest["summary"])

    def test_a_killed_run_keeps_the_inventory_but_claims_no_counts(self) -> None:
        log = self.scratch_log(
            "killed.txt",
            "\n RUN  v5.0.3 C:/ws\n\n"
            " ❯ src/App.test.ts (2 tests | 1 failed) 6ms\n\n"
            "⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯\n\n"
            " FAIL  src/App.test.ts > add > fails on purpose\n"
            "AssertionError: expected 3 to be 4\n",
        )
        digest = server.analyze_test_log(self.VITEST, log)
        self.assertIsNone(digest["counts"])
        self.assertEqual(digest["summary"], "see log")
        self.assertEqual(len(digest["failures"]), 1)

    def test_an_absolute_reported_path_is_kept(self) -> None:
        log = self.scratch_log(
            "absolute.txt",
            " FAIL  C:/ws/src/App.test.ts > add > fails on purpose\n"
            "      Tests  1 failed (1)\n",
        )
        digest = server.analyze_test_log(self.VITEST, log)
        self.assertEqual(digest["failures"][0]["file"], "C:/ws/src/App.test.ts")
        self.assertEqual(digest["failures"][0]["name"], "add > fails on purpose")
        self.assertEqual(digest["summary"], "0 passed, 1 failed")

    def test_skipped_and_todo_are_both_not_run(self) -> None:
        """`skipped` comes from the total, so a `todo` does not vanish."""
        log = self.scratch_log(
            "counts.txt", "      Tests  2 passed | 1 failed | 1 todo (4)\n"
        )
        digest = server.analyze_test_log(self.VITEST, log)
        self.assertEqual(digest["counts"], {"passed": 2, "skipped": 1, "failed": 1})

    def test_a_flutter_digest_still_says_so(self) -> None:
        digest = server.analyze_test_log(
            ["flutter", "test"], fixture("expanded_failed.txt")
        )
        self.assertEqual(digest["flavor"], "flutter")

    def test_the_registry_split_applies_to_a_vitest_run(self) -> None:
        digest = self.digest("vitest_two_files_failed.txt")
        registry: Any = {
            "path": ".toolbridge/known-failures.json",
            "exists": True,
            "entries": server.parse_known_failures(
                {
                    "entries": [
                        {"match": "^add > fails", "kind": "flaky", "reason": "races"}
                    ]
                }
            ),
            "error": None,
        }
        report = server.baseline_report(digest["failures"], digest["counts"], registry)
        self.assertEqual((report["known"], report["new"]), (1, 0))
        self.assertEqual(
            server.summarize_with_baseline(digest["summary"], report),
            "3 passed, 1 failed (1 known, 0 new)",
        )


class KillFallbackProcess:
    """A process handle that records whether it was terminated directly."""

    pid = 31337

    def __init__(self) -> None:
        self.killed = False
        self.exited = False

    def poll(self) -> int | None:
        return 1 if self.exited else None

    def kill(self) -> None:
        self.killed = True
        self.exited = True


class PatchedRun:
    """`subprocess.run` replaced by one canned result, restored on exit."""

    def __init__(self, returncode: int) -> None:
        self.returncode = returncode
        self.calls: list[list[str]] = []
        self.saved: Any = None

    def __enter__(self) -> PatchedRun:
        self.saved = server.subprocess.run

        def fake_run(argv: list[str], **kwargs: Any) -> Any:
            self.calls.append(list(argv))
            return types.SimpleNamespace(
                returncode=self.returncode, stdout=b"", stderr=b""
            )

        server.subprocess.run = fake_run
        return self

    def __exit__(self, *exc: object) -> bool:
        server.subprocess.run = self.saved
        return False


class KillFallbackTests(unittest.TestCase):
    """A refused `taskkill` must not leave a dev server running unattended.

    Measured in the DSH sandbox: `taskkill /F /T` answers `access denied` (rc 1)
    while the process is alive, so the tree kill silently did nothing and the
    worker stayed in `process.wait()` — the lane never moved again. The handle
    the bridge already owns is the fallback.
    """

    def job_with(self, process: KillFallbackProcess) -> Any:
        job = server.Job(["vite", "dev"], ".", os.devnull)
        job.status = "running"
        job.set_process(process)
        return job

    def test_a_refused_tree_kill_still_terminates_the_process(self) -> None:
        process = KillFallbackProcess()
        job = self.job_with(process)
        with PatchedRun(1) as run:
            self.assertTrue(job.kill())
        self.assertTrue(process.killed)
        self.assertEqual(job.status, "killed")
        if server.IS_WINDOWS:
            self.assertEqual(run.calls[0][0], "taskkill")

    def test_a_tree_kill_that_worked_is_left_alone(self) -> None:
        if not server.IS_WINDOWS:
            self.skipTest("taskkill is the Windows path")
        process = KillFallbackProcess()
        job = self.job_with(process)
        with PatchedRun(0):
            self.assertTrue(job.kill())
        self.assertFalse(process.killed)
        self.assertEqual(job.status, "killed")

    def test_a_process_that_already_exited_is_not_killed(self) -> None:
        process = KillFallbackProcess()
        process.exited = True
        job = self.job_with(process)
        with PatchedRun(0):
            self.assertFalse(job.kill())
        self.assertFalse(process.killed)

    def test_a_queued_job_has_no_process_but_is_still_cancelled(self) -> None:
        job = server.Job(["vite", "dev"], ".", os.devnull)
        self.assertFalse(job.kill())
        self.assertEqual(job.status, "killed")

    def test_a_kill_just_before_the_worker_claims_the_job_is_not_overwritten(
        self,
    ) -> None:
        """The kill and the worker's claim share one critical section.

        This was a real flake: `_run` marked the job running *after* checking for
        a kill, so a kill landing in between was overwritten — the process ran
        anyway, nothing terminated it, and its lane never moved again. The unit
        that must not interleave is `begin_running` against `kill`.
        """
        job = server.Job(["vite", "dev"], ".", os.devnull)
        self.assertFalse(job.kill())
        self.assertFalse(job.begin_running(), "a killed job must not claim its lane")
        self.assertEqual(job.status, "killed")

    def test_the_claim_sets_the_clock_and_holds_otherwise(self) -> None:
        job = server.Job(["vite", "build"], ".", os.devnull)
        self.assertTrue(job.begin_running())
        self.assertEqual(job.status, "running")
        self.assertIsNotNone(job.started_at)
        # A second claim is not the worker's business, and a kill still lands.
        self.assertTrue(job.begin_running())
        self.assertTrue(job.kill() is False or job.status == "killed")
        self.assertEqual(job.status, "killed")


class LongLaneDetectionTests(unittest.TestCase):
    """Which commands are expected to run until they are killed."""

    LONG: ClassVar[list[tuple[str, list[str]]]] = [
        ("vite", []),
        ("vite", ["dev"]),
        ("vite", ["serve"]),
        ("vite", ["preview"]),
        ("vite", ["dev", "--port", "5199"]),
        ("vitest", []),
        ("vitest", ["--pool=threads"]),
        ("vitest", ["watch"]),
        ("pnpm", ["run", "dev"]),
        ("pnpm", ["run", "start", "--", "--host"]),
        ("pnpm", ["exec", "vite", "dev"]),
        ("pnpm", ["exec", "vitest"]),
    ]

    SHORT: ClassVar[list[tuple[str, list[str]]]] = [
        ("vite", ["build"]),
        ("vite", ["--version"]),
        ("vite", ["optimize"]),
        ("vitest", ["run"]),
        ("vitest", ["--run"]),
        ("vitest", ["run", "--pool=threads"]),
        ("vitest", ["--version"]),
        ("pnpm", ["install"]),
        ("pnpm", ["run", "build"]),
        ("pnpm", ["run", "test"]),
        ("pnpm", ["exec", "vitest", "run"]),
        ("svelte-check", ["--tsconfig", "./tsconfig.json"]),
        ("flutter", ["test"]),
    ]

    def test_long_shapes(self) -> None:
        for cmd, args in self.LONG:
            with self.subTest(cmd=cmd, args=args):
                self.assertTrue(server.wants_long_lane(cmd, args))

    def test_short_shapes(self) -> None:
        for cmd, args in self.SHORT:
            with self.subTest(cmd=cmd, args=args):
                self.assertFalse(server.wants_long_lane(cmd, args))


class LongLaneTests(unittest.TestCase):
    """A job that never exits must not hold up the queue.

    Real Node processes, because the thing being pinned is a scheduling
    guarantee, not a shape: the queue lane has to finish a job while a server
    sits on the long lane.
    """

    @classmethod
    def setUpClass(cls) -> None:
        build_fake_project(NODE_PROJECT)
        NODE_LOG_SCRATCH.mkdir(parents=True, exist_ok=True)
        cls.hub = server.ToolHub(cwd=str(NODE_PROJECT), log_dir=str(NODE_LOG_SCRATCH))

    @classmethod
    def tearDownClass(cls) -> None:
        cls.hub.stop()
        remove_tree(NODE_PROJECT)
        remove_tree(NODE_LOG_SCRATCH)

    def tearDown(self) -> None:
        """Leave no job running, so one failed assertion cannot cascade.

        Without this a leaked dev server holds the long lane for every test that
        follows, and a single failure reads as three unrelated ones.

        Two conditions, not one: no job may be `queued`/`running` (the public
        truth), **and** every lane must have finished its turn — `_current` is
        cleared in the worker's `finally`, a moment after the status flips. That
        second wait is what catches a job killed while its process was still being
        spawned: its status is already `killed`, but the worker has not yet run
        the guard that terminates the process, and the runner exiting at that
        moment would leave the process behind.
        """
        for job in self.hub.list_jobs():
            if job.status in ("queued", "running"):
                job.kill()
        deadline = time.time() + 15.0
        while time.time() < deadline:
            busy = any(
                job.status in ("queued", "running") for job in self.hub.list_jobs()
            )
            lanes_busy = any(
                current is not None for current in self.hub._current.values()
            )
            if not busy and not lanes_busy:
                return
            time.sleep(0.1)
        stuck = [
            f"{job.id} {job.status} {job.argv}"
            for job in self.hub.list_jobs()
            if job.status in ("queued", "running")
        ]
        self.fail(f"the hub did not settle after tearDown: {stuck}")

    def wait_for(self, job: Any, statuses: set[str], timeout: float = 30.0) -> str:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if job.status in statuses:
                return str(job.status)
            time.sleep(0.1)
        return str(job.status)

    def test_a_server_does_not_starve_the_queue(self) -> None:
        running = self.hub.submit("vite", ["dev"])
        self.assertTrue(running.long)
        self.assertEqual(self.wait_for(running, {"running"}), "running")

        queued = self.hub.submit("vite", ["preview"])
        short = self.hub.submit("vitest", ["run"])

        # The long lane does not count as "in the way" for a queued build...
        self.assertEqual(self.hub.ahead_of(short.id), 0)
        # ...while a second long job waits behind the running server.
        self.assertEqual(self.hub.ahead_of(queued.id), 1)

        self.assertEqual(self.wait_for(short, {"done", "failed"}), "done")
        self.assertEqual(short.exit_code, 0)
        # The fake suite prints a real vitest report, so the digest ran too.
        self.assertEqual(short.summary, "2 passed")
        self.assertEqual(short.counts, {"passed": 2, "skipped": 0, "failed": 0})
        self.assertEqual(running.status, "running")
        self.assertEqual(queued.status, "queued")

        self.assertTrue(running.kill())
        self.assertEqual(self.wait_for(running, {"killed"}), "killed")
        self.assertEqual(self.wait_for(queued, {"running"}), "running")
        self.assertTrue(queued.kill())

    def kill_and_prove_the_lane_frees(self, job: Any) -> None:
        """Kill a running job and prove its lane actually moved on.

        `kill()`'s return value is deliberately **not** asserted: `False` means
        "there was no process handle to kill", which is a legitimate answer in the
        window between a job being marked running and its process existing — the
        spawn guard is what stops it there. What must hold is the outcome, and the
        only honest proof is the lane accepting the next job.
        """
        job.kill()
        self.assertEqual(self.wait_for(job, {"done", "failed", "killed"}), "killed")
        probe = self.hub.submit("vite", ["serve"])
        self.assertEqual(self.wait_for(probe, {"running"}), "running")
        probe.kill()

    def test_an_explicit_flag_beats_the_guess(self) -> None:
        forced_short = self.hub.submit("vitest", [], long=False)
        self.assertFalse(forced_short.long)
        self.assertEqual(self.wait_for(forced_short, {"done", "failed"}), "done")
        forced_long = self.hub.submit("vitest", ["run"], long=True)
        self.assertTrue(forced_long.long)
        self.assertEqual(self.wait_for(forced_long, {"done", "failed"}), "done")

    def test_killing_a_queued_job_keeps_it_from_starting(self) -> None:
        """A queued job has no process, so its status is the whole decision."""
        blocker = self.hub.submit("vite", ["dev"])
        self.assertEqual(self.wait_for(blocker, {"running"}), "running")
        queued = self.hub.submit("vite", ["preview"])
        self.assertEqual(queued.status, "queued")

        self.assertFalse(queued.kill())
        self.assertEqual(queued.status, "killed")
        # The probe this submits is the next job on the lane, so reaching
        # "running" proves the killed job was skipped rather than started.
        self.kill_and_prove_the_lane_frees(blocker)
        self.assertEqual(queued.status, "killed")
        self.assertIsNone(queued.resolved)
        self.assertIsNotNone(queued.finished_at)

    def test_a_kill_that_lands_during_the_spawn_still_stops_the_process(self) -> None:
        """`kill()` before the handle exists must not leave a server behind.

        The window is real, not theoretical: `_run_command` marks the job running,
        resolves the launch and only then hands `Popen`'s result to `kill()`'s
        reach. A kill inside it finds no process — and a dev server that outlives
        the "killed" answer also holds this lane forever. `resolve_launch` is
        where the kill is injected, because that is exactly the gap.
        """
        original = server.resolve_launch
        holder: list[Any] = []

        def racing(argv: list[str], *args: Any, **kwargs: Any) -> Any:
            launch = original(argv, *args, **kwargs)
            if holder:
                holder.pop().kill()
            return launch

        # `setattr`, not `server.resolve_launch = ...`: the server is imported into
        # this process as a module object, and only its attributes are typed.
        setattr(server, "resolve_launch", racing)
        try:
            job = self.hub.submit("vite", ["dev"])
            holder.append(job)
            self.assertEqual(self.wait_for(job, {"killed"}), "killed")
        finally:
            setattr(server, "resolve_launch", original)

        # The lane is what proves it: it only moves on once that process is gone,
        # and a leftover one would also make the next long job wait forever.
        probe = self.hub.submit("vite", ["serve"])
        self.assertEqual(self.wait_for(probe, {"running"}), "running")
        probe.kill()


class LongFlagRouteTests(unittest.TestCase):
    """`long` on `/run`: the flag, the guess, and the 400 for a non-boolean."""

    TOKEN = "node-route-token"

    @classmethod
    def setUpClass(cls) -> None:
        build_fake_project(NODE_PROJECT)
        NODE_LOG_SCRATCH.mkdir(parents=True, exist_ok=True)
        cls.hub = server.ToolHub(cwd=str(NODE_PROJECT), log_dir=str(NODE_LOG_SCRATCH))
        cls.httpd = server.ThreadingHTTPServer(
            ("127.0.0.1", 0), server.make_handler(cls.hub, cls.TOKEN, "")
        )
        cls.httpd.daemon_threads = True
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.hub.stop()
        remove_tree(NODE_PROJECT)
        remove_tree(NODE_LOG_SCRATCH)

    def test_a_dev_server_is_guessed_onto_the_long_lane(self) -> None:
        status, job = http_call(
            self.port, self.TOKEN, "POST", "/run", {"cmd": "vite", "args": ["dev"]}
        )
        self.assertEqual(status, 200)
        self.assertTrue(job["long"])
        self.hub.get(job["id"]).kill()  # type: ignore[union-attr]

    def test_the_flag_can_override_the_guess_either_way(self) -> None:
        status, job = http_call(
            self.port,
            self.TOKEN,
            "POST",
            "/run",
            {"cmd": "vitest", "args": [], "long": False},
        )
        self.assertEqual(status, 200)
        self.assertFalse(job["long"])
        status, job = http_call(
            self.port,
            self.TOKEN,
            "POST",
            "/run",
            {"cmd": "vitest", "args": ["run"], "long": True, "wait": True},
        )
        self.assertEqual(status, 200)
        self.assertTrue(job["long"])

    def test_a_non_boolean_long_is_a_400(self) -> None:
        status, body = http_call(
            self.port,
            self.TOKEN,
            "POST",
            "/run",
            {"cmd": "vite", "args": ["build"], "long": "yes"},
        )
        self.assertEqual(status, 400)
        self.assertIn("long", body["error"])

    def test_health_reports_the_command_surface(self) -> None:
        status, body = http_call(self.port, self.TOKEN, "GET", "/health")
        self.assertEqual(status, 200)
        for name in ("flutter", "dart", "git", "pnpm", "vite", "vitest"):
            self.assertIn(name, body["commands"])


class DeployPayloadTests(unittest.TestCase):
    """`sync_to_skills` deploys an allow list, not "everything minus a list".

    This guard was written because it had already failed: the deployer used to
    copy the whole repository minus a few names, which shipped `.gitignore`,
    `LICENSE`, `ruff.toml`, `.github/` and `__pycache__/*.pyc` into the skill —
    and would have shipped a scratch tree sitting in the repository, at whatever
    size it happened to have.
    """

    @classmethod
    def setUpClass(cls) -> None:
        path = ROOT / "scripts" / "sync_to_skills.py"
        spec = importlib.util.spec_from_file_location("sync_to_skills", path)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules["sync_to_skills"] = module
        spec.loader.exec_module(module)
        cls.deploy = module

    def payload(self, root: pathlib.Path) -> set[str]:
        """The deployer's payload, with separators normalised for comparison."""
        return {rel.replace("\\", "/") for rel in self.deploy.project_files(str(root))}

    def make_repo(self, name: str) -> pathlib.Path:
        root = NODE_SCRATCH / name
        shutil.rmtree(root, ignore_errors=True)
        (root / "scripts").mkdir(parents=True)
        (root / "SKILL.md").write_text(
            "---\nname: fake-skill\n---\n\nbody\n", encoding="utf-8"
        )
        (root / "scripts" / "toolhub_server.py").write_text(
            "# server\n", encoding="utf-8"
        )
        (root / "scripts" / "arb_edit_lib.py").write_text("# lib\n", encoding="utf-8")
        return root

    def tearDown(self) -> None:
        shutil.rmtree(NODE_SCRATCH, ignore_errors=True)

    def test_the_payload_is_skill_md_plus_scripts(self) -> None:
        root = self.make_repo("payload")
        self.assertEqual(
            self.payload(root),
            {"SKILL.md", "scripts/toolhub_server.py", "scripts/arb_edit_lib.py"},
        )

    def test_repository_plumbing_is_not_deployed(self) -> None:
        root = self.make_repo("plumbing")
        for name in (".gitignore", "LICENSE", "README.md", "CONTEXT.md", "ruff.toml"):
            (root / name).write_text("x\n", encoding="utf-8")
        (root / ".github" / "workflows").mkdir(parents=True)
        (root / ".github" / "workflows" / "ci.yml").write_text(
            "on: push\n", encoding="utf-8"
        )
        (root / "docs" / "adr").mkdir(parents=True)
        (root / "docs" / "adr" / "0001.md").write_text("decision\n", encoding="utf-8")
        files = self.payload(root)
        for leaked in (
            ".gitignore",
            "LICENSE",
            "README.md",
            "CONTEXT.md",
            "ruff.toml",
            ".github/workflows/ci.yml",
            "docs/adr/0001.md",
        ):
            self.assertNotIn(leaked, files)

    def test_a_stray_tree_of_any_kind_is_not_deployed(self) -> None:
        """The failure that motivated the allow list: scratch that nobody excluded."""
        root = self.make_repo("stray")
        scratch = root / ".sandbox-probe" / "app" / "node_modules" / "vite"
        scratch.mkdir(parents=True)
        (scratch / "package.json").write_text("{}\n", encoding="utf-8")
        (root / ".pnpm-store").mkdir()
        (root / ".pnpm-store" / "blob").write_text("x\n", encoding="utf-8")
        self.assertEqual(
            self.payload(root),
            {"SKILL.md", "scripts/toolhub_server.py", "scripts/arb_edit_lib.py"},
        )

    def test_compiled_artefacts_are_skipped_inside_the_payload(self) -> None:
        root = self.make_repo("compiled")
        cache = root / "scripts" / "__pycache__"
        cache.mkdir()
        (cache / "toolhub_server.cpython-314.pyc").write_bytes(b"\x00")
        (root / "scripts" / "stale.pyc").write_bytes(b"\x00")
        self.assertEqual(
            self.payload(root),
            {"SKILL.md", "scripts/toolhub_server.py", "scripts/arb_edit_lib.py"},
        )

    def test_the_skill_name_comes_from_the_frontmatter(self) -> None:
        """The repo is `dsh-tool-bridge`; the skill it deploys is `tool-bridge`."""
        self.assertEqual(self.deploy.skill_name(str(ROOT)), "tool-bridge")

    def test_a_deploy_prunes_what_the_payload_no_longer_has(self) -> None:
        self.make_repo("prune")
        dest = NODE_SCRATCH / "prune-dest"
        dest.mkdir()
        # What a previous deny-list deployment left behind, plus a stale payload
        # file: `main()` deploys *this* repository, so anything else here is a
        # leftover that the prune has to take away.
        (dest / "LICENSE").write_text("old\n", encoding="utf-8")
        (dest / ".github" / "workflows").mkdir(parents=True)
        (dest / ".github" / "workflows" / "ci.yml").write_text(
            "old\n", encoding="utf-8"
        )
        (dest / "scripts" / "__pycache__").mkdir(parents=True)
        (dest / "scripts" / "__pycache__" / "x.pyc").write_bytes(b"\x00")
        (dest / "scripts" / "retired_helper.py").write_text("old\n", encoding="utf-8")
        argv = sys.argv
        sys.argv = ["sync_to_skills.py", "--dest", str(dest)]
        try:
            self.assertEqual(self.deploy.main(), 0)
        finally:
            sys.argv = argv
        left = sorted(
            str(path.relative_to(dest)).replace("\\", "/")
            for path in dest.rglob("*")
            if path.is_file()
        )
        # The destination is exactly the payload — no more, no less.
        self.assertEqual(left, sorted(self.payload(ROOT)))
        self.assertNotIn("scripts/retired_helper.py", left)
        # Emptying a directory must not leave the directory itself behind.
        self.assertFalse((dest / ".github").exists())
        self.assertFalse((dest / "scripts" / "__pycache__").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)

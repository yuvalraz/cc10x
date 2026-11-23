#!/usr/bin/env python3
"""Static checks for templates/build-board.html, the read-only cc10x build board page.

No framework and no browser: reads the page source and asserts the db query,
the visible states, the absence of HTML sinks and write calls, and the shape
of the embedded #demo samples (each with exactly the 19 IF-2 snapshot keys).

Run:  python3 test_cc10x_board_page.py    (exit 0 = pass)
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

PAGE = Path(__file__).resolve().parents[1] / "templates" / "build-board.html"

# IF-2 snapshot schema, pinned verbatim from the plan's Shared Interfaces.
IF2_KEYS = (
    "wf", "type", "repo", "branch", "session_tag", "request", "phases",
    "fix_cycles", "finish_fix_cycles", "cursor", "pending_gate", "breaker",
    "deferred", "plan_file", "design_file", "status", "created_at",
    "updated_at", "synced_at",
)
NULLABLE_KEYS = (
    "type", "repo", "branch", "session_tag", "request", "cursor",
    "pending_gate", "breaker", "plan_file", "design_file", "created_at",
    "updated_at",
)
REQUIRED_TEXT = (
    'collection("builds")',
    'orderBy("updated_at", "desc")',
    "limit(500)",
    "onSnapshot(",
    'claude.use("db")',
    "board unavailable",
    "no cc10x workflows yet",
    "showing the 500 most recently updated workflows",
    "<title>cc10x builds</title>",
    "aria-selected",
    "prefers-color-scheme: dark",
    "prefers-reduced-motion",
    'location.hash === "#demo"',
)
FORBIDDEN_TEXT = (
    "innerHTML", "outerHTML", "insertAdjacentHTML", "document.write",
    ".set(", ".update(", ".delete(", "<script src", "<link", "claude.db",
)


def is_sparse(doc: dict) -> bool:
    return (
        all(doc[k] is None for k in NULLABLE_KEYS)
        and doc["phases"] == []
        and doc["fix_cycles"] == 0
        and doc["finish_fix_cycles"] == 0
        and all(v == 0 for v in doc["deferred"].values())
        and isinstance(doc["wf"], str)
        and isinstance(doc["status"], str)
    )


def page_static(path: Path) -> list[str]:
    errors: list[str] = []
    try:
        text = path.read_bytes().decode("utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return [f"page unreadable as UTF-8: {exc}"]
    errors += [f"missing: {t}" for t in REQUIRED_TEXT if t not in text]
    errors += [f"forbidden: {t}" for t in FORBIDDEN_TEXT if t in text]
    # Every onSnapshot call passes an error callback, so a terminal error is shown, not swallowed.
    if re.search(r"onSnapshot\(\s*[A-Za-z_$][\w$]*\s*\)", text):
        errors.append("onSnapshot without an error callback")
    m = re.search(r'<script type="application/json" id="demo-data">(.*?)</script>', text, re.S)
    if not m:
        return errors + ["demo-data block missing"]
    try:
        samples = json.loads(m.group(1))
    except json.JSONDecodeError as exc:
        return errors + [f"demo-data is not JSON: {exc}"]
    if not (isinstance(samples, list) and len(samples) == 6 and all(isinstance(s, dict) for s in samples)):
        return errors + ["demo-data is not a list of 6 objects"]
    for s in samples:
        if sorted(s) != sorted(IF2_KEYS):
            errors.append(f"sample {s.get('wf')!r} keys differ from IF-2: {sorted(set(s) ^ set(IF2_KEYS))}")
    statuses = sorted(s.get("status") for s in samples)
    if not {"running", "waiting", "done", "failed"} <= set(statuses):
        errors.append(f"samples miss a status: {statuses}")
    if not any(s.get("status") == "waiting" and s.get("pending_gate") for s in samples):
        errors.append("no waiting sample with a gate")
    if not any(s.get("breaker") == "ask" for s in samples):
        errors.append("no breaker ask sample")
    if not errors and sum(is_sparse(s) for s in samples) != 1:
        errors.append("expected exactly one sparse sample")
    return errors


CASES = (page_static,)


def main() -> int:
    ok = True
    for fn in CASES:
        errors = fn(PAGE)
        print(f"[{fn.__name__}] {'PASS' if not errors else 'FAIL'}")
        for e in errors:
            print(f"  - {e}")
        ok &= not errors
    print("ALL PASS" if ok else "FAILURES PRESENT")
    return 0 if ok else 1


def test_board_page_suite():
    assert main() == 0


if __name__ == "__main__":
    sys.exit(main())

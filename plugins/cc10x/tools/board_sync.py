"""Turn a cc10x workflow artifact into the build board snapshot (IF-1, IF-2).

  board_sync.py --check                      -> BOARD: <url> | BOARD: off
  board_sync.py <artifact> [--session-tag T] -> BOARD: off | BOARD: unchanged |
      BOARD_DOC: builds <wf> <snapshot path> [if_version=<n>]

The snapshot goes to <state root>/board/<wf>.json. The tool only reads the
artifact and its events log; it never writes either, and it deletes nothing.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from cc10x_hooklib import SAFE_WORKFLOW_ID, board_config, git_checkout_root  # noqa: E402

FINISH_PHASE = "build-finish"

# IF-3 ticket rule, defined identically in clutch tools/ops_sync/ops_sync.py.
SLUG_RE = re.compile(r"(?<![A-Za-z0-9])([A-Za-z]{2,6})-([0-9]{1,6})(?![A-Za-z0-9])")
TEXT_RE = re.compile(r"(?<![A-Za-z0-9])([A-Z]{2,6})-([0-9]{1,6})(?![A-Za-z0-9])")
NOT_TICKETS = ("CVE", "GPT", "HTTP", "ISO", "PEP", "RFC", "SHA", "UTF")


def _str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _list(value: Any) -> list:
    return value if isinstance(value, list) else []


def _marker(entry: Any) -> str | None:
    """A status_history entry's event: a dict's string `event`, or the entry when a string."""
    return _str(entry.get("event")) if isinstance(entry, dict) else _str(entry)


def ticket_of(slugs: list, texts: list) -> str | None:
    """The first ticket in the slugs (any case), then in the texts (upper case only)."""
    for values, pattern in ((slugs, SLUG_RE), (texts, TEXT_RE)):
        for value in values:
            if not isinstance(value, str):
                continue
            for m in pattern.finditer(value):
                prefix = m.group(1).upper()
                if prefix not in NOT_TICKETS:
                    return f"{prefix}-{m.group(2)}"
    return None


def snapshot(artifact: dict, events: list[dict]) -> dict:
    """Every IF-2 key except repo, branch, ticket, session_tag and synced_at."""
    phase_dicts = [p for p in _list(artifact.get("normalized_phases")) if isinstance(p, dict)]
    ids = [_str(p.get("phase_id")) or _str(p.get("id")) for p in phase_dicts]
    known = {i for i in ids if i}
    phase_status = artifact.get("phase_status")

    finish = [0, 0]  # history, events
    other = [0, 0]
    per_phase: dict[str, list[int]] = {i: [0, 0] for i in known}
    for entry in _list(artifact.get("remediation_history")):
        if not isinstance(entry, dict):
            continue
        if entry.get("phase") == FINISH_PHASE:
            finish[0] += 1
            continue
        other[0] += 1
        pid, phase = entry.get("phase_id"), entry.get("phase")
        if isinstance(pid, str) and pid != "N/A" and pid in known:
            per_phase[pid][0] += 1
        elif isinstance(phase, str) and phase in known:
            per_phase[phase][0] += 1
    for event in events:
        if event.get("event") != "remediation_created":
            continue
        if event.get("phase") == FINISH_PHASE:
            finish[1] += 1
            continue
        other[1] += 1
        details = event.get("details")
        pid = details.get("phase_id") if isinstance(details, dict) else None
        if isinstance(pid, str) and pid in known:
            per_phase[pid][1] += 1

    phases = []
    for pid in ids:
        status = _str(phase_status.get(pid)) if isinstance(phase_status, dict) and pid else None
        cycles = max(per_phase[pid]) if pid in per_phase else 0
        phases.append({"id": pid, "status": status, "fix_cycles": cycles})

    history = _list(artifact.get("status_history"))
    pending_gate = artifact.get("pending_gate")
    breaker = None
    if pending_gate == "phase_blocked" and history:
        breaker = {"breaker_ask": "ask", "breaker_stop": "stop"}.get(_marker(history[-1]))

    deferred = {"medium": 0, "low": 0, "minor": 0, "other": 0}
    for finding in _list(artifact.get("deferred_findings")):
        severity = finding.get("severity") if isinstance(finding, dict) else None
        bucket = severity.lower() if isinstance(severity, str) else "other"
        deferred[bucket if bucket in deferred else "other"] += 1

    markers = {_marker(e) for e in history} | {_str(e.get("event")) for e in events}
    cursor = _str(artifact.get("phase_cursor"))
    finalized = cursor == "memory-finalize" and isinstance(phase_status, dict) and phase_status.get(cursor) == "completed"
    if "workflow_failed" in markers:
        status = "failed"
    elif {"memory_finalized", "workflow_completed"} & markers or finalized:
        status = "done"
    elif pending_gate:
        status = "waiting"
    else:
        status = "running"

    request = _str(artifact.get("user_request"))
    return {
        "wf": _str(artifact.get("workflow_uuid")) or _str(artifact.get("workflow_id")) or None,
        "type": _str(artifact.get("workflow_type")),
        "request": request[:160] if request is not None else None,
        "phases": phases,
        "fix_cycles": max(other),
        "finish_fix_cycles": max(finish),
        "cursor": cursor,
        "pending_gate": _str(pending_gate),
        "breaker": breaker,
        "deferred": deferred,
        "plan_file": _str(artifact.get("plan_file")),
        "design_file": _str(artifact.get("design_file")),
        "status": status,
        "created_at": _str(artifact.get("created_at")),
        "updated_at": _str(artifact.get("updated_at")),
    }


def _read_events(artifact_path: Path) -> list[dict]:
    # Same path hooklib reads: the artifact file's stem, not the workflow id.
    log = artifact_path.with_name(f"{artifact_path.stem}.events.jsonl")
    try:
        text = log.read_bytes().decode("utf-8", errors="ignore")
    except OSError:
        return []
    events = []
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except (ValueError, RecursionError):
            continue
        if isinstance(record, dict):
            events.append(record)
    return events


def _branch(root: Path | None) -> str | None:
    if root is None:
        return None
    try:
        r = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    out = r.stdout.strip()
    return out if r.returncode == 0 and out else None


def _doc_path(value: str | None, root: Path | None) -> str | None:
    """An absolute path goes out relative to the checkout root, else as its basename."""
    if value is None or not os.path.isabs(value):
        return value
    try:
        return str(Path(value).relative_to(root)) if root is not None else Path(value).name
    except ValueError:
        return Path(value).name


def _is_on(capabilities: Any) -> bool:
    caps = capabilities if isinstance(capabilities, dict) else {}
    failed = caps.get("board_push_failed")
    if isinstance(failed, str) and failed:
        return False
    pinned = caps.get("board_url")
    return (isinstance(pinned, str) and bool(pinned)) or board_config()[0] is not None


def _if_version(capabilities: Any) -> str:
    v = capabilities.get("board_version") if isinstance(capabilities, dict) else None
    ok = isinstance(v, int) and not isinstance(v, bool) and v >= 0
    return f" if_version={v}" if ok else ""


def _fail(reason: str) -> int:
    print(f"board_sync: {reason}", file=sys.stderr)
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write the build board snapshot for one workflow artifact.")
    parser.add_argument("artifact", nargs="?", help="path to .cc10x/workflows/<wf>.json")
    parser.add_argument("--check", action="store_true", help="print BOARD: <url> or BOARD: off and exit")
    parser.add_argument("--session-tag", default=None, help="session tag recorded in the snapshot")
    args = parser.parse_args(argv)

    if args.check:
        url, reason = board_config()
        if reason:
            print(f"board_sync: {reason}", file=sys.stderr)
        print(f"BOARD: {url or 'off'}")
        return 0
    if not args.artifact:
        return _fail("an artifact path or --check is required")

    artifact_path = Path(args.artifact).resolve()
    try:
        artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError) as exc:
        return _fail(f"artifact unreadable ({type(exc).__name__})")
    if not isinstance(artifact, dict):
        return _fail("artifact is not a JSON object")
    capabilities = artifact.get("capabilities")
    if not _is_on(capabilities):
        print("BOARD: off")
        return 0

    snap = snapshot(artifact, _read_events(artifact_path))
    wf = snap["wf"] or artifact_path.stem
    if not isinstance(wf, str) or not SAFE_WORKFLOW_ID.fullmatch(wf):
        return _fail("unsafe workflow id")
    state = artifact_path.parent.parent
    root = git_checkout_root(artifact_path.parent)
    branch = _branch(root)
    doc = {
        "wf": wf,
        "type": snap["type"],
        "repo": root.name if root is not None else state.parent.name,
        "branch": branch,
        "ticket": ticket_of([branch], [_str(artifact.get("user_request"))]),
        "session_tag": args.session_tag,
        **{k: v for k, v in snap.items() if k not in ("wf", "type")},
        "plan_file": _doc_path(snap["plan_file"], root),
        "design_file": _doc_path(snap["design_file"], root),
        "synced_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    target = state / "board" / f"{wf}.json"
    if any(c.isspace() for c in str(target)):
        # BOARD_DOC is split on spaces, so such a path would be ambiguous
        return _fail("snapshot path contains whitespace")
    try:
        previous = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError):
        previous = None
    if isinstance(previous, dict) and {k: v for k, v in previous.items() if k != "synced_at"} == {
        k: v for k, v in doc.items() if k != "synced_at"
    }:
        print("BOARD: unchanged")
        return 0

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.parent / f".{wf}.tmp"  # one fixed name: a retry overwrites a failed write's leftover
        tmp.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, target)
    except (OSError, ValueError, TypeError, RecursionError) as exc:
        return _fail(f"snapshot not written ({type(exc).__name__})")
    print(f"BOARD_DOC: builds {wf} {target}{_if_version(capabilities)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

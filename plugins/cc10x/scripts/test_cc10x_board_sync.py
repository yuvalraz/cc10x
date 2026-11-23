from __future__ import annotations

# board_sync.py (IF-1, IF-2): artifact -> .cc10x/board/<wf>.json plus one stdout line.
# Runs on bare python3 (`python3 test_cc10x_board_sync.py`) and under pytest.
# Two seams: the CLI as a subprocess (real files in a temp state root, HOME and
# CC10X_BOARD_URL set per case) and snapshot() for the counting and status tables.

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
PLUGIN_ROOT = SCRIPTS_DIR.parent
TOOL = PLUGIN_ROOT / "tools" / "board_sync.py"
FIXTURES = PLUGIN_ROOT / "tests" / "fixtures"
URL = "https://claude.ai/board/test"
WF = "wf-20261123T000000Z-board-test"

# IF-2, pinned here on purpose (not imported from the tool).
IF2_KEYS = [
    "wf", "type", "repo", "branch", "session_tag", "request", "phases",
    "fix_cycles", "finish_fix_cycles", "cursor", "pending_gate", "breaker",
    "deferred", "plan_file", "design_file", "status", "created_at",
    "updated_at", "synced_at",
]
MAIN_ONLY_KEYS = {"repo", "branch", "session_tag", "synced_at"}


def load_tool():
    spec = importlib.util.spec_from_file_location("board_sync_under_test", TOOL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def base_artifact(**overrides) -> dict:
    artifact = {
        "workflow_uuid": WF,
        "workflow_id": WF,
        "workflow_type": "build",
        "user_request": "add a build board",
        "phase_cursor": "P1",
        "pending_gate": None,
        "normalized_phases": [{"phase_id": "P1"}, {"phase_id": "P2"}],
        "phase_status": {"P1": "in_progress", "P2": "pending"},
        "remediation_history": [],
        "status_history": [{"event": "workflow_started"}],
        "deferred_findings": [],
        "plan_file": "docs/plans/p.md",
        "design_file": None,
        "created_at": "2026-11-23T00:00:00Z",
        "updated_at": "2026-11-23T00:01:00Z",
        "capabilities": {},
    }
    artifact.update(overrides)
    return artifact


def write_state(tmp: Path, artifact, stem: str = WF, events: list | None = None) -> Path:
    wfdir = tmp / "proj" / ".cc10x" / "workflows"
    wfdir.mkdir(parents=True, exist_ok=True)
    path = wfdir / f"{stem}.json"
    path.write_text(artifact if isinstance(artifact, str) else json.dumps(artifact), encoding="utf-8")
    if events is not None:
        lines = [e if isinstance(e, str) else json.dumps(e) for e in events]
        (wfdir / f"{stem}.events.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def board_dir(tmp: Path) -> Path:
    return tmp / "proj" / ".cc10x" / "board"


def run_cli(tmp: Path, *args, url: str | None = URL, board_json: str | None = None, path_env: str | None = None):
    home = tmp / "home"
    (home / ".cc10x").mkdir(parents=True, exist_ok=True)
    if board_json is not None:
        (home / ".cc10x" / "board.json").write_text(board_json, encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if k != "CC10X_BOARD_URL"}
    env["HOME"] = str(home)
    if url is not None:
        env["CC10X_BOARD_URL"] = url
    if path_env is not None:
        env["PATH"] = path_env
    return subprocess.run(
        [sys.executable, str(TOOL), *map(str, args)],
        capture_output=True, text=True, env=env, timeout=60,
    )


def read_doc(stdout: str) -> tuple[str, Path, str | None]:
    """Parse a BOARD_DOC line per IF-1: (wf, path, if_version or None)."""
    assert stdout.endswith("\n") and stdout.count("\n") == 1, repr(stdout)
    line = stdout.rstrip("\n")
    assert line.startswith("BOARD_DOC: builds "), repr(line)
    tokens = line[len("BOARD_DOC: builds "):].split(" ")
    version = None
    if re.fullmatch(r"if_version=[0-9]+", tokens[-1]):
        version = tokens.pop()[len("if_version="):]
    return tokens[0], Path(" ".join(tokens[1:])), version


def load_snapshot(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


# ---- CLI seam -------------------------------------------------------------


def check_on(tmp: Path) -> None:
    r = run_cli(tmp, "--check")
    assert (r.returncode, r.stdout, r.stderr) == (0, f"BOARD: {URL}\n", ""), r


def check_off(tmp: Path) -> None:
    r = run_cli(tmp, "--check", url=None)
    assert (r.returncode, r.stdout, r.stderr) == (0, "BOARD: off\n", ""), r


def check_rejected(tmp: Path) -> None:
    r = run_cli(tmp, "--check", url=None, board_json="{not json")
    assert (r.returncode, r.stdout) == (0, "BOARD: off\n"), r
    assert r.stderr.startswith("board_sync: ") and r.stderr.count("\n") == 1, repr(r.stderr)


def off_writes_nothing(tmp: Path) -> None:
    path = write_state(tmp, base_artifact())
    r = run_cli(tmp, path, url=None)
    assert (r.returncode, r.stdout, r.stderr) == (0, "BOARD: off\n", ""), r
    assert not board_dir(tmp).exists()
    # a rejected board.json is loud only under --check
    r = run_cli(tmp, path, url=None, board_json="[]")
    assert (r.returncode, r.stdout, r.stderr) == (0, "BOARD: off\n", ""), r
    assert not board_dir(tmp).exists()


def failed_push_off(tmp: Path) -> None:
    path = write_state(tmp, base_artifact(capabilities={"board_url": URL, "board_push_failed": "set refused"}))
    r = run_cli(tmp, path)
    assert (r.returncode, r.stdout, r.stderr) == (0, "BOARD: off\n", ""), r
    assert not board_dir(tmp).exists()


def pinned_url_on(tmp: Path) -> None:
    path = write_state(tmp, base_artifact(capabilities={"board_url": "https://claude.ai/pinned"}))
    r = run_cli(tmp, path, url=None)
    assert r.returncode == 0 and r.stderr == "", r
    wf, snap, _ = read_doc(r.stdout)
    assert wf == WF and snap.is_file()
    # an empty pinned URL does not count
    path = write_state(tmp, base_artifact(capabilities={"board_url": ""}), stem="wf-empty-pin")
    r = run_cli(tmp, path, url=None)
    assert r.stdout == "BOARD: off\n", r


def artifact_untouched(tmp: Path) -> None:
    events = [{"event": "workflow_started"}, {"event": "phase_started", "details": {"phase_id": "P1"}}]
    a = write_state(tmp, base_artifact(), events=events)
    b = write_state(tmp, base_artifact(workflow_uuid="wf-b", capabilities={"board_push_failed": "x"}), stem="wf-b", events=events)
    files = [a, a.with_name(f"{a.stem}.events.jsonl"), b, b.with_name(f"{b.stem}.events.jsonl")]
    before = [f.read_bytes() for f in files]
    outputs = [run_cli(tmp, a).stdout, run_cli(tmp, a).stdout, run_cli(tmp, a, url=None).stdout, run_cli(tmp, b).stdout]
    assert outputs[0].startswith("BOARD_DOC: ") and outputs[1:] == ["BOARD: unchanged\n", "BOARD: off\n", "BOARD: off\n"], outputs
    assert [f.read_bytes() for f in files] == before


def events_path(tmp: Path) -> None:
    stem = "wf-file-stem"
    path = write_state(tmp, base_artifact(workflow_uuid="wf-other"), stem=stem, events=[{"event": "workflow_failed"}])
    # a decoy log named after the workflow_uuid must not be read
    (path.parent / "wf-other.events.jsonl").write_text(json.dumps({"event": "memory_finalized"}) + "\n", encoding="utf-8")
    r = run_cli(tmp, path)
    wf, snap, _ = read_doc(r.stdout)
    assert wf == "wf-other" and snap.name == "wf-other.json", r.stdout
    assert load_snapshot(snap)["status"] == "failed"


def pushed_line(tmp: Path) -> None:
    path = write_state(tmp, base_artifact())
    r = run_cli(tmp, path, "--session-tag", "s1")
    expected = board_dir(tmp).resolve() / f"{WF}.json"
    assert (r.returncode, r.stderr) == (0, ""), r
    assert r.stdout == f"BOARD_DOC: builds {WF} {expected}\n", r.stdout
    snap = load_snapshot(expected)
    assert list(snap) == IF2_KEYS and len(snap) == 19, list(snap)
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", snap["synced_at"]), snap["synced_at"]
    assert snap["session_tag"] == "s1" and snap["wf"] == WF and snap["type"] == "build"
    assert snap["phases"] == [
        {"id": "P1", "status": "in_progress", "fix_cycles": 0},
        {"id": "P2", "status": "pending", "fix_cycles": 0},
    ], snap["phases"]
    assert snap["status"] == "running" and snap["breaker"] is None
    assert snap["deferred"] == {"medium": 0, "low": 0, "minor": 0, "other": 0}
    # no --session-tag: null
    other = write_state(tmp, base_artifact(workflow_uuid="wf-untagged"), stem="wf-untagged")
    _, snap_path, _ = read_doc(run_cli(tmp, other).stdout)
    assert load_snapshot(snap_path)["session_tag"] is None


def snapshot_location(tmp: Path) -> None:
    path = write_state(tmp, base_artifact())
    listing = sorted(p.name for p in path.parent.iterdir())
    _, snap, _ = read_doc(run_cli(tmp, path).stdout)
    assert snap.parent == board_dir(tmp).resolve(), snap
    assert sorted(p.name for p in path.parent.iterdir()) == listing


def if_version_token(tmp: Path) -> None:
    cases = [(3, "3"), (0, "0"), (True, None), ("3", None), (-1, None), (2.0, None)]
    for i, (value, token) in enumerate(cases):
        sub = tmp / f"c{i}"
        path = write_state(sub, base_artifact(capabilities={"board_version": value}))
        _, _, got = read_doc(run_cli(sub, path).stdout)
        assert got == token, (value, got)
    sub = tmp / "list"
    path = write_state(sub, base_artifact(capabilities=["board_version", 3]))
    _, _, got = read_doc(run_cli(sub, path).stdout)
    assert got is None


def unchanged_rules(tmp: Path) -> None:
    path = write_state(tmp, base_artifact())
    _, snap, _ = read_doc(run_cli(tmp, path).stdout)
    data, mtime = snap.read_bytes(), snap.stat().st_mtime_ns
    r = run_cli(tmp, path)
    assert r.stdout == "BOARD: unchanged\n", r
    assert snap.read_bytes() == data and snap.stat().st_mtime_ns == mtime
    write_state(tmp, base_artifact(pending_gate="phase_blocked"))
    r = run_cli(tmp, path)
    read_doc(r.stdout)
    assert load_snapshot(snap)["pending_gate"] == "phase_blocked"
    snap.write_text("{broken", encoding="utf-8")
    r = run_cli(tmp, path)
    read_doc(r.stdout)
    assert load_snapshot(snap)["pending_gate"] == "phase_blocked"


def fixtures_sweep(tmp: Path) -> None:
    fixtures = sorted(FIXTURES.glob("*.json"))
    assert len(fixtures) == 35, len(fixtures)
    for fx in fixtures:
        artifact = json.loads(fx.read_text(encoding="utf-8"))["starting_artifact"]
        stem = f"wf-fixture-{fx.stem}"
        # bad events-log lines are skipped, not fatal
        path = write_state(tmp, artifact, stem=stem, events=["not json", "[1, 2]", "", json.dumps({"event": "phase_started"})])
        r = run_cli(tmp, path)
        assert r.returncode == 0 and r.stderr == "", (fx.name, r)
        _, snap, _ = read_doc(r.stdout)
        assert list(load_snapshot(snap)) == IF2_KEYS, fx.name


def bad_artifact(tmp: Path) -> None:
    for i, text in enumerate(["not json", "[1]", json.dumps(base_artifact(workflow_uuid="../x"))]):
        sub = tmp / f"c{i}"
        path = write_state(sub, text)
        r = run_cli(sub, path)
        assert r.returncode == 1 and r.stdout == "", (text, r)
        assert r.stderr.startswith("board_sync: ") and r.stderr.count("\n") == 1, repr(r.stderr)
        assert not board_dir(sub).exists() and not (sub / "proj" / "x.json").exists()
    r = run_cli(tmp, tmp / "missing.json")
    assert r.returncode == 1 and r.stdout == "" and r.stderr.startswith("board_sync: "), r


def no_git_repo(tmp: Path) -> None:
    path = write_state(tmp, base_artifact())
    snap = load_snapshot(read_doc(run_cli(tmp, path).stdout)[1])
    assert (snap["repo"], snap["branch"]) == ("proj", None), snap
    # a checkout whose git binary is missing: repo from the checkout, branch null
    sub = tmp / "nogit"
    path = write_state(sub, base_artifact())
    (sub / "proj" / ".git").mkdir()
    snap = load_snapshot(read_doc(run_cli(sub, path, path_env="/nonexistent").stdout)[1])
    assert (snap["repo"], snap["branch"]) == ("proj", None), snap
    git = shutil.which("git")
    if git:
        sub = tmp / "real"
        path = write_state(sub, base_artifact())
        repo = sub / "proj"
        for cmd in (["init", "-q"], ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "x"], ["checkout", "-q", "-b", "board-test"]):
            subprocess.run([git, "-C", str(repo), *cmd], check=True, capture_output=True)
        snap = load_snapshot(read_doc(run_cli(sub, path).stdout)[1])
        assert (snap["repo"], snap["branch"]) == ("proj", "board-test"), snap


def atomic_write(tmp: Path) -> None:
    src = TOOL.read_text(encoding="utf-8")
    assert "os.replace(" in src, "snapshot must be written via a temp file plus os.replace"


def no_delete_path(tmp: Path) -> None:
    src = TOOL.read_text(encoding="utf-8")
    found = [t for t in ("unlink(", "rmtree", "os.remove", "os.rmdir") if t in src]
    assert not found, found


def help_runs(tmp: Path) -> None:
    r = run_cli(tmp, "--help")
    assert r.returncode == 0 and "--check" in r.stdout and "Traceback" not in r.stderr, r


# ---- snapshot() seam -------------------------------------------------------


def unit_keys(tmp: Path) -> None:
    snap = load_tool().snapshot(base_artifact(), [])
    assert set(snap) == set(IF2_KEYS) - MAIN_ONLY_KEYS, sorted(snap)


def real_shape_counts(tmp: Path) -> None:
    artifact = base_artifact(
        normalized_phases=[{"phase_id": "P1"}, {"phase_id": "P2"}, {"id": "P3"}, "not a dict"],
        phase_status="weird",
        remediation_history=[
            {"phase_id": "P1", "phase": "build-implement", "cycle": 1},
            {"phase_id": "N/A", "phase": "P2", "cycle_number": 2},
            {"phase": "build-implement"},
            {},
            {"phase_id": "P9", "phase": "build-implement"},
            "not a dict",
        ],
    )
    events = [
        {"event": "remediation_created", "phase": "build-implement", "details": {"phase_id": "P1"}},
        {"event": "remediation_created", "phase": "build-implement", "details": {"phase_id": "P1"}},
        {"event": "phase_started", "details": {"phase_id": "P2"}},
    ]
    snap = load_tool().snapshot(artifact, events)
    assert snap["phases"] == [
        {"id": "P1", "status": None, "fix_cycles": 2},
        {"id": "P2", "status": None, "fix_cycles": 1},
        {"id": "P3", "status": None, "fix_cycles": 0},
    ], snap["phases"]
    assert (snap["fix_cycles"], snap["finish_fix_cycles"]) == (5, 0), snap
    snap = load_tool().snapshot(base_artifact(normalized_phases="nope", remediation_history="nope"), [])
    assert (snap["phases"], snap["fix_cycles"]) == ([], 0), snap


def finish_rounds(tmp: Path) -> None:
    tool = load_tool()
    artifact = base_artifact(remediation_history=[{"phase": "build-finish", "phase_id": "P2"}, {"phase_id": "P2"}])
    events = [{"event": "remediation_created", "phase": "build-finish", "details": {"phase_id": "P2"}}]
    snap = tool.snapshot(artifact, events)
    assert snap["finish_fix_cycles"] == 1 and snap["fix_cycles"] == 1, snap
    assert snap["phases"][1] == {"id": "P2", "status": "pending", "fix_cycles": 1}, snap["phases"]
    artifact = base_artifact(
        normalized_phases=[],
        remediation_history=[{"phase": "build-implement"}, {"phase": "build-implement"}, {"phase": "build-finish"}],
    )
    snap = tool.snapshot(artifact, [])
    assert (snap["phases"], snap["fix_cycles"], snap["finish_fix_cycles"]) == ([], 2, 1), snap


def breaker_states(tmp: Path) -> None:
    tool = load_tool()
    cases = [
        ("phase_blocked", {"event": "breaker_ask"}, "ask"),
        ("phase_blocked", {"event": "breaker_stop"}, "stop"),
        ("phase_blocked", "something", None),
        ("phase_blocked", "breaker_stop", "stop"),
        (None, {"event": "breaker_ask"}, None),
    ]
    for gate, last, expected in cases:
        snap = tool.snapshot(base_artifact(pending_gate=gate, status_history=[{"event": "x"}, last]), [])
        assert snap["breaker"] == expected, (gate, last, snap["breaker"])
    assert tool.snapshot(base_artifact(pending_gate="phase_blocked", status_history=[]), [])["breaker"] is None


def status_states(tmp: Path) -> None:
    tool = load_tool()
    assert tool.snapshot(base_artifact(), [])["status"] == "running"
    assert tool.snapshot(base_artifact(pending_gate="phase_blocked"), [])["status"] == "waiting"
    assert tool.snapshot(base_artifact(), [{"event": "memory_finalized"}])["status"] == "done"
    assert tool.snapshot(base_artifact(), [{"event": "memory_finalized"}, {"event": "workflow_failed"}])["status"] == "failed"
    assert tool.snapshot(base_artifact(status_history=["workflow_failed"]), [])["status"] == "failed"
    assert tool.snapshot(base_artifact(status_history=[{"event": "workflow_completed"}]), [])["status"] == "done"
    done = base_artifact(phase_cursor="memory-finalize", phase_status={"memory-finalize": "completed"})
    assert tool.snapshot(done, [])["status"] == "done"
    not_done = base_artifact(phase_cursor="memory-finalize", phase_status={"memory-finalize": "in_progress"})
    assert tool.snapshot(not_done, [])["status"] == "running"


def deferred_buckets(tmp: Path) -> None:
    findings = [{"severity": "medium"}, {"severity": "LOW"}, {"severity": "minor"}, {"severity": "high"}, "x"]
    snap = load_tool().snapshot(base_artifact(deferred_findings=findings), [])
    assert snap["deferred"] == {"medium": 1, "low": 1, "minor": 1, "other": 2}, snap["deferred"]


def request_truncated(tmp: Path) -> None:
    tool = load_tool()
    assert tool.snapshot(base_artifact(user_request="a" * 300), [])["request"] == "a" * 160
    assert tool.snapshot(base_artifact(user_request=["x"]), [])["request"] is None


CASES = [
    check_on, check_off, check_rejected, off_writes_nothing, failed_push_off,
    pinned_url_on, artifact_untouched, events_path, pushed_line, snapshot_location,
    if_version_token, unchanged_rules, fixtures_sweep, bad_artifact, no_git_repo,
    atomic_write, no_delete_path, help_runs, unit_keys, real_shape_counts,
    finish_rounds, breaker_states, status_states, deferred_buckets, request_truncated,
]


def main() -> int:
    failed = 0
    for fn in CASES:
        with tempfile.TemporaryDirectory() as tmp:
            try:
                fn(Path(tmp).resolve())
                print(f"PASS {fn.__name__}")
            except Exception as exc:  # report every case, not only the first failure
                failed += 1
                print(f"FAIL {fn.__name__}: {type(exc).__name__}: {exc}")
    print(f"{len(CASES) - failed}/{len(CASES)} passed")
    return 1 if failed else 0


def test_board_sync_suite() -> None:
    assert main() == 0


if __name__ == "__main__":
    sys.exit(main())

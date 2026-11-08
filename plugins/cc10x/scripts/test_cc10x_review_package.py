#!/usr/bin/env python3
"""Self-contained test for tools/review_package.py's --repo / CC10X_REPO_DIR.

No framework: builds two throwaway git repos (A = process cwd, B = a sibling)
and asserts the review package targets the right one — including that the
DEFAULT still targets cwd (regression guard), so the new knob is purely additive.

Lives in scripts/ because the repo's .gitignore tracks .py only under scripts/.
Run:  python3 test_cc10x_review_package.py    (exit 0 = pass)
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "tools" / "review_package.py"


def run_git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    )


def rev(repo: Path, ref: str = "HEAD") -> str:
    return subprocess.run(
        ["git", "-C", str(repo), "rev-parse", ref],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def make_repo(repo: Path, marker: str) -> tuple[str, str]:
    """Two commits; the second adds <marker>.txt so we can identify the repo in the diff."""
    repo.mkdir(parents=True, exist_ok=True)
    run_git(repo, "init", "-q")
    run_git(repo, "config", "user.email", "t@example.com")
    run_git(repo, "config", "user.name", "tester")
    # repo-specific base content so the two repos' base shas never collide
    # (identical commits made in the same second would hash equal).
    (repo / "README.md").write_text(f"base for {marker}\n")
    run_git(repo, "add", "-A")
    run_git(repo, "commit", "-q", "-m", "base")
    base = rev(repo)
    (repo / f"{marker}.txt").write_text(f"change in {marker}\n")
    run_git(repo, "add", "-A")
    run_git(repo, "commit", "-q", "-m", f"feat: add {marker}")
    return base, rev(repo)


def run_script(
    cwd: Path, env_repo: str | None, args: list[str]
) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env.pop("CC10X_REPO_DIR", None)
    if env_repo:
        env["CC10X_REPO_DIR"] = env_repo
    env["CLAUDE_PROJECT_DIR"] = str(cwd)  # pin output dir so we can find the package
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        cwd=str(cwd),
        env=env,
        capture_output=True,
        text=True,
    )


def wrote_path(stdout: str) -> str | None:
    m = re.search(r"wrote (\S+):", stdout)
    return m.group(1) if m else None


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        a, b = Path(tmp) / "repoA", Path(tmp) / "repoB"
        base_a, head_a = make_repo(a, "A_FILE")
        base_b, head_b = make_repo(b, "B_FILE")
        ok = True

        # [1] default (cwd=A, no knob) -> diffs A
        r = run_script(a, None, [base_a, head_a])
        p = wrote_path(r.stdout)
        c1 = r.returncode == 0 and p and "A_FILE" in Path(p).read_text()
        print(
            f"[1] default targets cwd repo A: {'PASS' if c1 else 'FAIL'} (rc={r.returncode})"
        )
        ok &= bool(c1)

        # [2] CC10X_REPO_DIR=B (cwd=A) -> diffs B (B's shas only resolve in B)
        r = run_script(a, str(b), [base_b, head_b])
        p = wrote_path(r.stdout)
        c2 = r.returncode == 0 and p and "B_FILE" in Path(p).read_text()
        print(
            f"[2] CC10X_REPO_DIR=B diffs B from cwd A: {'PASS' if c2 else 'FAIL'} (rc={r.returncode})"
        )
        ok &= bool(c2)

        # [3] regression guard: default truly = cwd -> B's shas DON'T resolve in A -> bad BASE (rc 2)
        r = run_script(a, None, [base_b, head_b])
        c3 = r.returncode == 2 and "bad BASE" in r.stderr
        print(
            f"[3] default does NOT leak to B (rc2 bad BASE): {'PASS' if c3 else 'FAIL'} (rc={r.returncode})"
        )
        ok &= bool(c3)

        # [4] --repo flag overrides (cwd=A, no env)
        r = run_script(a, None, ["--repo", str(b), base_b, head_b])
        p = wrote_path(r.stdout)
        c4 = r.returncode == 0 and p and "B_FILE" in Path(p).read_text()
        print(
            f"[4] --repo B flag overrides: {'PASS' if c4 else 'FAIL'} (rc={r.returncode})"
        )
        ok &= bool(c4)

        # [5] BASE vs the working tree: an uncommitted tracked change and a new
        # untracked file are in the package; .cc10x/ is not listed.
        (a / "README.md").write_text("UNCOMMITTED_EDIT\n")
        (a / "NEW_UNTRACKED.txt").write_text("new\n")
        r = run_script(a, None, [base_a, "HEAD"])
        p = wrote_path(r.stdout)
        text = Path(p).read_text() if p else ""
        untracked = text.split("## Untracked files", 1)[-1] if "## Untracked files" in text else ""
        c5 = (
            r.returncode == 0
            and "UNCOMMITTED_EDIT" in text
            and "A_FILE" in text
            and "NEW_UNTRACKED.txt" in untracked
            and ".cc10x" not in untracked
        )
        print(f"[5] uncommitted + untracked work is in the package: {'PASS' if c5 else 'FAIL'} (rc={r.returncode})")
        ok &= bool(c5)

        # [6] BASE == HEAD with a dirty tree is reviewable, not an error
        r = run_script(a, None, [head_a, "HEAD"])
        p = wrote_path(r.stdout)
        c6 = r.returncode == 0 and p and "UNCOMMITTED_EDIT" in Path(p).read_text()
        print(f"[6] BASE==HEAD with a dirty tree packages the tree: {'PASS' if c6 else 'FAIL'} (rc={r.returncode})")
        ok &= bool(c6)

        # [7] BASE == HEAD with a clean tree: nothing to review -> rc 2
        r = run_script(b, None, [head_b, "HEAD"])
        c7 = r.returncode == 2 and "nothing to review" in r.stderr
        print(f"[7] clean tree at BASE: rc 2 nothing to review: {'PASS' if c7 else 'FAIL'} (rc={r.returncode})")
        ok &= bool(c7)

    print("ALL PASS" if ok else "FAILURES PRESENT")
    return 0 if ok else 1


def test_review_package_suite():
    assert main() == 0


if __name__ == "__main__":
    sys.exit(main())

from __future__ import annotations

# board_config() (IF-0): the one never-raising reader of the build board config.
# Runs on bare python3 (`python3 test_cc10x_board_config.py`) and under pytest.
# Each case gets a fresh temp HOME and its own CC10X_BOARD_URL, restored after.

import json
import os
import sys
import tempfile
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
_UNSET = object()


def load_hooklib():
    if str(SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(SCRIPTS_DIR))
    import cc10x_hooklib

    return cc10x_hooklib


def run_board_config(home: Path | None, env_url: object = _UNSET) -> tuple[str | None, str | None]:
    saved = {k: os.environ.get(k) for k in ("HOME", "CC10X_BOARD_URL")}
    try:
        if home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = str(home)
        if env_url is _UNSET:
            os.environ.pop("CC10X_BOARD_URL", None)
        else:
            os.environ["CC10X_BOARD_URL"] = str(env_url)
        return load_hooklib().board_config()
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def write_board_json(home: Path, text: str) -> None:
    (home / ".cc10x").mkdir(parents=True, exist_ok=True)
    (home / ".cc10x" / "board.json").write_text(text, encoding="utf-8")


def assert_rejected(result: tuple[str | None, str | None], value: str) -> None:
    url, reason = result
    assert url is None, result
    assert isinstance(reason, str) and reason, result
    assert "\n" not in reason and len(reason) < 200, reason
    if value.strip():
        assert value.strip() not in reason, reason


def env_url(home: Path) -> None:
    assert run_board_config(home, "https://claude.ai/x") == ("https://claude.ai/x", None)
    assert run_board_config(home, "  https://claude.ai/x\n") == ("https://claude.ai/x", None)


def env_empty_wins(home: Path) -> None:
    write_board_json(home, json.dumps({"url": "https://claude.ai/file"}))
    assert run_board_config(home, "") == (None, None)
    assert run_board_config(home, "   ") == (None, None)


def env_rejected(home: Path) -> None:
    bad = [
        "http://x",
        "https://a\nb",
        "https://a\tb",
        "https://a b",
        "https://a\x7fb",
        "https://aéb",
        "https://" + "a" * (2049 - len("https://")),
        "https://",
        "ftp://claude.ai/secret-token",
    ]
    for value in bad:
        assert_rejected(run_board_config(home, value), value)
    # exactly 2048 characters is still valid
    ok = "https://" + "a" * (2048 - len("https://"))
    assert run_board_config(home, ok) == (ok, None)
    # an invalid env decides alone, even with a valid file
    write_board_json(home, json.dumps({"url": "https://claude.ai/file"}))
    assert_rejected(run_board_config(home, "http://secret-host/token"), "http://secret-host/token")


def file_url(home: Path) -> None:
    write_board_json(home, json.dumps({"url": "https://claude.ai/x"}))
    assert run_board_config(home) == ("https://claude.ai/x", None)


def file_missing(home: Path) -> None:
    assert run_board_config(home) == (None, None)


def no_home(home: Path) -> None:
    write_board_json(home, json.dumps({"url": "https://claude.ai/x"}))
    assert run_board_config(None) == (None, None)


def file_rejected(home: Path) -> None:
    for text in ["{not json", "[]", json.dumps({"url": 5}), json.dumps({"url": "http://x"}), json.dumps({"url": "https://a\nb"}), json.dumps({})]:
        write_board_json(home, text)
        value = "http://x" if "http://x" in text else ""
        assert_rejected(run_board_config(home), value)
    (home / ".cc10x" / "board.json").unlink()
    (home / ".cc10x" / "board.json").mkdir()
    assert_rejected(run_board_config(home), "")


CASES = [env_url, env_empty_wins, env_rejected, file_url, file_missing, no_home, file_rejected]


def main() -> int:
    failed = 0
    for fn in CASES:
        with tempfile.TemporaryDirectory() as tmp:
            try:
                fn(Path(tmp))
                print(f"PASS {fn.__name__}")
            except Exception as exc:  # report every case, not only the first failure
                failed += 1
                print(f"FAIL {fn.__name__}: {type(exc).__name__}: {exc}")
    print(f"{len(CASES) - failed}/{len(CASES)} passed")
    return 1 if failed else 0


def test_board_config_suite() -> None:
    assert main() == 0


if __name__ == "__main__":
    sys.exit(main())

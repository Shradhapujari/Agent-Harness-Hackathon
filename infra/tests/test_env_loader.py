"""`scripts/lib/env.sh` has to parse `.env` the way node's --env-file does.

The controller reads the file through node; `make up`, `make down` and
`make smoke` read it through this shell function. A loader that disagrees about
quoting or trailing comments puts the stack on one port and the run on another,
which is the divergence it was added to close (Qodo, PR #20).

The expectations below were read off node itself, and `test_matches_node`
re-checks them against the real parser whenever node is on the box.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
LOADER = ROOT / "scripts" / "lib" / "env.sh"

SAMPLE = "\n".join([
    "PLAIN=one",
    "export EXPORTED=two",
    'QUOTED="three"',
    "SINGLE='four'",
    "TRAILING=five   ",
    "HASH=six # comment",
    "BARE=seven#nospace",
    'IN_QUOTES="has # hash"',
    "LEADING=  eight",
    "EMPTY=",
    "EQUALS=a=b=c",
    "# a comment line",
    "",
    "  export SPACED=nine",
    "",
])

EXPECTED = {
    "PLAIN": "one",
    "EXPORTED": "two",
    "QUOTED": "three",
    "SINGLE": "four",
    "TRAILING": "five",
    "HASH": "six",
    "BARE": "seven",
    "IN_QUOTES": "has # hash",
    "LEADING": "eight",
    "EMPTY": "",
    "EQUALS": "a=b=c",
    "SPACED": "nine",
}


def _shell(env_file: Path, keys: list[str], preset: dict[str, str] | None = None) -> dict[str, str]:
    """What the shell loader exports, as `{key: value}` for keys it set."""
    script = f'. "{LOADER}"\nhush_load_env "{env_file}"\n'
    for key in keys:
        script += f'if [ -n "${{{key}+set}}" ]; then printf "%s\\t%s\\n" "{key}" "${{{key}}}"; fi\n'
    result = subprocess.run(
        ["bash", "-c", script], capture_output=True, text=True, check=True,
        env={"PATH": "/usr/bin:/bin", **(preset or {})},
    )
    out = {}
    for line in result.stdout.splitlines():
        key, _, value = line.partition("\t")
        out[key] = value
    return out


def _node(env_file: Path, keys: list[str]) -> dict[str, str]:
    program = (
        "const out={};"
        f"for (const k of {json.dumps(keys)}) "
        "if (process.env[k] !== undefined) out[k] = process.env[k];"
        "console.log(JSON.stringify(out));"
    )
    result = subprocess.run(
        ["node", f"--env-file={env_file}", "-e", program],
        capture_output=True, text=True, check=True,
    )
    parsed: dict[str, str] = json.loads(result.stdout)
    return parsed


@pytest.fixture
def env_file(tmp_path: Path) -> Path:
    path = tmp_path / ".env"
    path.write_text(SAMPLE, encoding="utf-8")
    return path


def test_parses_every_form_node_accepts(env_file: Path) -> None:
    assert _shell(env_file, list(EXPECTED)) == EXPECTED


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_matches_node(env_file: Path) -> None:
    keys = list(EXPECTED)
    assert _shell(env_file, keys) == _node(env_file, keys)


def test_an_exported_variable_wins(env_file: Path) -> None:
    """`HUSH_KUBERNETES_PORT=8002 make up` has to override the file."""
    result = _shell(env_file, ["PLAIN"], preset={"PLAIN": "from-the-shell"})
    assert result == {"PLAIN": "from-the-shell"}


def test_crlf_line_endings(tmp_path: Path) -> None:
    path = tmp_path / ".env"
    path.write_bytes(b"PLAIN=one\r\nQUOTED=\"two\"\r\n")
    assert _shell(path, ["PLAIN", "QUOTED"]) == {"PLAIN": "one", "QUOTED": "two"}


def test_skips_a_quote_that_spans_lines_instead_of_guessing(tmp_path: Path) -> None:
    """node reads these as one multi-line value; this refuses rather than differ."""
    path = tmp_path / ".env"
    path.write_text('OPEN="unclosed\nAFTER=kept\n', encoding="utf-8")
    assert _shell(path, ["OPEN", "AFTER"]) == {"AFTER": "kept"}


def test_a_missing_file_is_not_an_error(tmp_path: Path) -> None:
    assert _shell(tmp_path / "absent", ["PLAIN"]) == {}

"""`hush-mcp <server>` — the entry point the run scripts and the demo use."""
from __future__ import annotations

from typing import Any

import pytest

from hush_mcp import cli


def test_each_named_server_runs_on_its_own_port(monkeypatch: pytest.MonkeyPatch) -> None:
    started: list[tuple[str, int]] = []
    monkeypatch.setattr(cli, "run_server", lambda server, port: started.append((server.name, port)))
    for name in cli.SERVERS:
        assert cli.main([name]) == 0
    assert started == [
        ("alertmanager", 9101),
        ("redfish", 9102),
        ("kubernetes", 9103),
        ("prometheus", 9104),
        ("netbox", 9105),
    ]


def test_an_unknown_server_is_rejected_before_anything_starts(monkeypatch: pytest.MonkeyPatch) -> None:
    def explode(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("must not start a server")

    monkeypatch.setattr(cli, "run_server", explode)
    with pytest.raises(SystemExit) as exit_info:
        cli.main(["postgres"])
    assert exit_info.value.code == 2


def test_the_server_argument_is_required() -> None:
    with pytest.raises(SystemExit):
        cli.main([])

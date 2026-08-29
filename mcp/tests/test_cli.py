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


def test_every_tool_takes_a_run_id_so_logs_line_up_with_harness_traces() -> None:
    """Person B's prompts pass `run_id`; the MCP SDK drops arguments a tool
    does not declare, so it has to be a real parameter on every tool."""
    import asyncio
    import importlib

    for name in cli.SERVERS:
        module = importlib.import_module(f"hush_mcp.{name}")
        tools = asyncio.run(module.mcp.list_tools())
        assert tools, f"{name} exposes no tools"
        for tool in tools:
            properties = tool.input_schema.get("properties", {})
            assert "run_id" in properties, f"{name}.{tool.name} has no run_id parameter"
            assert "run_id" not in tool.input_schema.get("required", [])

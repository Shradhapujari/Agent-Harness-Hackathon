"""`hush-mcp <server>` — run one of the data-center MCP servers over streamable-http."""
from __future__ import annotations

import argparse
import importlib
from collections.abc import Sequence

from hush_mcp.common import run_server

#: Server name → module. Each runs on its own port (specs/graph.md §5).
SERVERS = ("alertmanager", "redfish", "kubernetes", "prometheus", "netbox")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="hush-mcp", description="Run a Hush MCP server.")
    parser.add_argument("server", choices=SERVERS, help="which layer of the data center to expose")
    args = parser.parse_args(argv)
    module = importlib.import_module(f"hush_mcp.{args.server}")
    run_server(module.mcp, module.PORT)
    return 0

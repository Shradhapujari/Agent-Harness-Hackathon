"""List the tools an MCP server exposes. Used by scripts/smoke.sh.

    uv run python scripts/mcp_tools.py http://127.0.0.1:9101/mcp
"""
from __future__ import annotations

import asyncio
import sys

from mcp import Client


async def _tools(url: str) -> list[str]:
    async with Client(url) as client:
        result = await client.list_tools()
    return [tool.name for tool in result.tools]


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: mcp_tools.py <streamable-http url>", file=sys.stderr)
        return 2
    try:
        names = asyncio.run(_tools(sys.argv[1]))
    except Exception as exc:  # noqa: BLE001 - the caller only needs pass/fail
        print(f"error: {type(exc).__name__}", file=sys.stderr)
        return 1
    print(" ".join(names))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

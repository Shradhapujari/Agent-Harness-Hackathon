"""`hush-chaos crac|hang|clear|status` — drive the demo failures from one command."""
from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from typing import Any

from hush_chaos import cluster, scenarios
from hush_chaos.clients import AmClient, BmcClient


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="hush-chaos", description="Break the simulated data center.")
    commands = parser.add_subparsers(dest="command", required=True)

    crac = commands.add_parser("crac", help="scenario A: CRAC failure cooks rack R4")
    crac.add_argument(
        "--lead-s",
        type=float,
        default=scenarios.HARDWARE_LEAD_S,
        help="seconds to wait for the hardware alerts before posting the symptoms",
    )

    hang = commands.add_parser("hang", help="scenario B: one host wedges, its BMC keeps answering")
    hang.add_argument("--node", default="hush-worker", help="kind node to freeze")
    hang.add_argument("--system", default="R4-N04", help="BMC id of the machine that node runs on")
    hang.add_argument(
        "--lead-s",
        type=float,
        default=scenarios.HARDWARE_LEAD_S,
        help="seconds to wait for HostHung before posting the symptoms",
    )

    commands.add_parser("clear", help="undo everything: chaos off, machines on, nodes thawed")
    commands.add_parser("status", help="firing alerts by layer, plus the fleet's state")
    return parser


def run(args: argparse.Namespace) -> dict[str, Any]:
    bmc, am = BmcClient(), AmClient()
    if args.command == "crac":
        return scenarios.crac(bmc, am, cluster.node_map(), lead_s=args.lead_s)
    if args.command == "hang":
        return scenarios.hang(bmc, am, k8s_node=args.node, system=args.system, lead_s=args.lead_s)
    if args.command == "clear":
        return scenarios.clear(bmc, am, cluster.node_map())
    return scenarios.status(bmc, am)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        result = run(args)
    except (RuntimeError, ValueError) as exc:
        # A scenario that could not set the stage must not look like one that did.
        print(json.dumps({"command": args.command, "error": str(exc)}, indent=2), file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 1 if result.get("failed_nodes") else 0

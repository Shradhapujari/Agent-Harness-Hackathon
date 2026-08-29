# `mcp/` — the data center, as tools

Five MCP servers expose the simulated data center to the Hush agent. Each runs
as its own process on loopback, speaks `streamable-http`, and is registered in
the harness by URL. A3 ships the first two; A4 adds the rest.

| Server | URL | Tools |
|---|---|---|
| `alertmanager` | `http://127.0.0.1:9101/mcp` | `list_alerts`, `get_alert_groups`, `correlate_alerts`, `silence_alerts` |
| `redfish` | `http://127.0.0.1:9102/mcp` | `list_systems`, `get_system`, `get_thermal`, `get_power`, `get_sel`, `get_fleet_summary`, `reset_system` |

The tool signatures are the contract with Person B and live in
`specs/graph.md` §5. Changing one means changing that file in the same PR.

## Run

```bash
uv run hush-mcp alertmanager     # http://127.0.0.1:9101/mcp
uv run hush-mcp redfish          # http://127.0.0.1:9102/mcp
npx @modelcontextprotocol/inspector      # connect the URL, list tools
```

Endpoints come from the environment (`.env.example`): `HUSH_ALERTMANAGER_URL`,
`HUSH_BMC_URL`, `MOCK_BMC_USER`, `MOCK_BMC_PASSWORD`.

Always start these with `uv run`. This directory is named `mcp/`, so a Python
process that has the repository root on `sys.path` imports *it* instead of the
`mcp` SDK and dies with `No module named 'mcp.server'`. `uv run` does not put
the root on the path; `python -m` from the root does.

## How a tool answers

- **Never raises.** Any exception at the tool boundary becomes
  `{"error": {"code", "message"}}` (`common.guarded`), so a failed call costs
  the agent one turn rather than the run.
- **Side effects happen once.** `silence_alerts` and `reset_system` cache their
  result per `idempotency_key` (`common.idempotent`); a repeat call returns the
  first result with `replayed: true` and touches nothing. Failures are not
  cached, so a retry after an outage is a real retry.
- **Reads are projections.** `get_system` returns the five fields an action
  depends on, not a Redfish document — the storm is already big enough.

## Correlation

`correlate.py` is pure and has no I/O: alerts in, clusters out. It groups firing
alerts by rack inside a time window from the first alert, orders clusters by
size then by first appearance, and picks each cluster's leading alert as its
earliest, *lowest-layer* alert (facility < bmc < kubernetes/app) — the physical
cause fires before the consequences it produces. Alerts that start after the
window closes, and single alerts that carry no rack, are returned as noise.

Code decides the grouping; the model decides what kind of failure the leading
cluster represents. That split is why the tests in `tests/test_correlate.py` can
pin the behaviour against the two demo scenarios
(`tests/fixtures/alerts_crac.json`, `alerts_hang.json`).

## Tests

```bash
uv run pytest mcp -q
```

`test_redfish_tools.py` runs against the real `mock-bmc` app in-process, so the
projections are checked against the payloads the BMC actually serves rather than
against a second mock of it. `test_alertmanager.py` uses `httpx.MockTransport`
and pins the exact requests Alertmanager will receive.

## Deviations from `specs/roadmap.md` §A3

- The MCP Python SDK is 2.x, where `FastMCP` is `MCPServer` and the bind
  address moved from the constructor to `run()`. `common.make_server` /
  `common.run_server` wrap that difference.
- `kubernetes`, `pydantic` and `structlog` are not dependencies yet; A4 adds the
  Kubernetes client when the server that needs it lands.

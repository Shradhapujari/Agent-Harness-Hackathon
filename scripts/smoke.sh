#!/usr/bin/env bash
# Is the simulated data center actually up? One line per component, exit 1 on any miss.
#
# This is the check Person B runs before blaming the agent, so it covers both
# the services and the five MCP URLs the harness registers.
set -uo pipefail

cd "$(dirname "$0")/.."

# Same values the controller reads, so the stack and the run agree on ports.
# shellcheck source=scripts/lib/env.sh
. "scripts/lib/env.sh"
hush_load_env .env

BMC_URL="${HUSH_BMC_URL:-http://127.0.0.1:8100}"
PROM_URL="${HUSH_PROMETHEUS_URL:-http://127.0.0.1:9090}"
AM_URL="${HUSH_ALERTMANAGER_URL:-http://127.0.0.1:9093}"
NETBOX_URL="${HUSH_NETBOX_URL:-http://127.0.0.1:8000}"
KUBE_URL="${HUSH_KUBERNETES_URL:-http://127.0.0.1:8001}"
BMC_USER="${MOCK_BMC_USER:-root}"
BMC_PASSWORD="${MOCK_BMC_PASSWORD:-password0}"

failures=0
printf '%-14s %-34s %s\n' COMPONENT ENDPOINT RESULT

check_http() {  # name url [curl args...]
  local name="$1" url="$2"; shift 2
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@" "$url")"
  if [ "$code" = "200" ]; then
    printf '%-14s %-34s ok (200)\n' "$name" "$url"
  else
    printf '%-14s %-34s FAIL (%s)\n' "$name" "$url" "$code"
    failures=$((failures + 1))
  fi
}

check_mcp() {  # name url
  local name="$1" url="$2" tools count
  if ! tools="$(uv run python scripts/mcp_tools.py "$url" 2>/dev/null)"; then
    printf '%-14s %-34s FAIL (no tool list)\n' "$name" "$url"
    failures=$((failures + 1))
    return
  fi
  # A server that answers but exposes nothing is not a working server: the
  # harness would register it and then find no tool to call.
  count="$(wc -w <<<"$tools" | tr -d ' ')"
  if [ "$count" -eq 0 ]; then
    printf '%-14s %-34s FAIL (0 tools)\n' "$name" "$url"
    failures=$((failures + 1))
    return
  fi
  printf '%-14s %-34s ok (%s tools)\n' "$name" "$url" "$count"
}

check_http mock-bmc     "$BMC_URL/redfish/v1"   -u "$BMC_USER:$BMC_PASSWORD"
check_http prometheus   "$PROM_URL/-/ready"
check_http alertmanager "$AM_URL/-/ready"

# NetBox is optional: every NetBox tool falls back to infra/netbox/seed.json.
# A port that answers with something that is not NetBox is a different thing
# from a NetBox that is not up yet, and it is the one an operator has to act on:
# some other local service holds the port, so the blast radius in the approval
# gate quietly comes from the seed file (I3). curl reports 000 when nothing is
# listening at all.
netbox_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$NETBOX_URL/api/status/")"
case "$netbox_code" in
  200|403)
    printf '%-14s %-34s ok (%s)\n' netbox "$NETBOX_URL/api/status/" "$netbox_code" ;;
  000)
    printf '%-14s %-34s skipped (not up; fallback to seed.json)\n' \
      netbox "$NETBOX_URL/api/status/" ;;
  *)
    printf '%-14s %-34s WARN (%s: port held by another service; fallback to seed.json — move HUSH_NETBOX_PORT)\n' \
      netbox "$NETBOX_URL/api/status/" "$netbox_code" ;;
esac

# N8 polls this directly, so a stack that passes everything else and misses
# this one still escalates every run instead of recovering (I2).
check_http kubernetes   "$KUBE_URL/api/v1/nodes"

check_mcp alertmanager "http://127.0.0.1:9101/mcp"
check_mcp redfish      "http://127.0.0.1:9102/mcp"
check_mcp kubernetes   "http://127.0.0.1:9103/mcp"
check_mcp prometheus   "http://127.0.0.1:9104/mcp"
check_mcp netbox       "http://127.0.0.1:9105/mcp"

if [ "$failures" -gt 0 ]; then
  echo "$failures component(s) down" >&2
  exit 1
fi
echo "stack is up"

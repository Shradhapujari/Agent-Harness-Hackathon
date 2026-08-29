#!/usr/bin/env bash
# Stop the MCP servers started by scripts/mcp-up.sh.
#
# Waits for each process to actually exit: `make down && make up` would
# otherwise see a dying server still holding its port, skip starting a new one,
# and then fail the readiness check.
set -uo pipefail

cd "$(dirname "$0")/.."

for pidfile in runs/mcp-*.pid; do
  [ -e "$pidfile" ] || continue
  name="$(basename "$pidfile" .pid)"
  pid="$(cat "$pidfile")"
  if kill "$pid" 2>/dev/null; then
    for _ in $(seq 1 40); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null
      echo "  $name did not stop; killed (pid $pid)" >&2
    else
      echo "  stopped $name (pid $pid)"
    fi
  fi
  rm -f "$pidfile"
done

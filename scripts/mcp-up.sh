#!/usr/bin/env bash
# Start the five MCP servers in the background, one log file each.
#
# The harness registers them by URL, so they have to outlive the shell that
# started them: each runs under nohup with its pid in runs/mcp-<name>.pid, and
# a server that is already listening is left alone.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p runs

SERVERS=(alertmanager:9101 redfish:9102 kubernetes:9103 prometheus:9104 netbox:9105)

# Every decision below is "is this port already served?". Without lsof the
# answer is always no, and a second copy of each server would be started.
if ! command -v lsof >/dev/null 2>&1; then
  echo "lsof is required to tell which servers are already running" >&2
  exit 1
fi

listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

for entry in "${SERVERS[@]}"; do
  name="${entry%%:*}"
  port="${entry##*:}"
  if listening "$port"; then
    echo "  $name already listening on $port"
    continue
  fi
  nohup uv run hush-mcp "$name" > "runs/mcp-$name.log" 2>&1 &
  echo $! > "runs/mcp-$name.pid"
  echo "  $name started on $port (pid $!)"
done

# Give the last one a moment to bind so `make up && make smoke` does not race.
for entry in "${SERVERS[@]}"; do
  port="${entry##*:}"
  for _ in $(seq 1 30); do
    listening "$port" && break
    sleep 0.5
  done
  if ! listening "$port"; then
    echo "  ${entry%%:*} did not bind $port; see runs/mcp-${entry%%:*}.log" >&2
    exit 1
  fi
done

#!/usr/bin/env bash
# Stop the MCP servers and the Kubernetes proxy started by scripts/mcp-up.sh.
#
# Waits for each process to actually exit: `make down && make up` would
# otherwise see a dying server still holding its port, skip starting a new one,
# and then fail the readiness check.
set -uo pipefail

cd "$(dirname "$0")/.."

PORTS="9101 9102 9103 9104 9105 ${HUSH_KUBERNETES_PORT:-8001}"

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

# A pid file can go missing — a second `make down`, a cleaned runs/ — while the
# server is still holding its port, which would make the next `make up` skip it
# and then fail its own readiness check. Only ever kill our own servers: these
# are ordinary ports and something else on this laptop may be using one.
for port in $PORTS; do
  for pid in $(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null); do
    command_line="$(ps -o command= -p "$pid" 2>/dev/null)"
    case "$command_line" in
      *hush-mcp*|*"kubectl"*proxy*)
        kill "$pid" 2>/dev/null && echo "  stopped a server still holding $port (pid $pid)"
        ;;
      *)
        echo "  port $port is held by something that is not a Hush server (pid $pid); left alone" >&2
        ;;
    esac
  done
done

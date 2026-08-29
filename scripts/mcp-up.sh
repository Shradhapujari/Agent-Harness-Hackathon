#!/usr/bin/env bash
# Start the five MCP servers, plus the read-only Kubernetes proxy, in the
# background, one log file each.
#
# The harness registers the MCP servers by URL, so they have to outlive the
# shell that started them: each runs under nohup with its pid in
# runs/mcp-<name>.pid, and a server that is already listening is left alone.
#
# `kubectl proxy` is here rather than in the MCP list because nothing registers
# it: it is the plain Kubernetes read API that the controller polls directly in
# N8 (graph.md §3, "D: controller polls BMC/k8s/AM"). Without it every verify
# threw and every run escalated instead of recovering (I2).
set -euo pipefail

cd "$(dirname "$0")/.."

# Same values the controller reads, so the stack and the run agree on ports.
# shellcheck source=scripts/lib/env.sh
. "scripts/lib/env.sh"
hush_load_env .env
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

KUBE_PORT="${HUSH_KUBERNETES_PORT:-8001}"
KUBE_CONTEXT="${HUSH_KUBE_CONTEXT:-kind-hush}"
if listening "$KUBE_PORT"; then
  echo "  kubernetes proxy already listening on $KUBE_PORT"
elif ! command -v kubectl >/dev/null 2>&1; then
  echo "  kubectl not found; N8 verification will have no Kubernetes probe" >&2
else
  nohup kubectl --context "$KUBE_CONTEXT" proxy --port="$KUBE_PORT" \
    > "runs/mcp-kube-proxy.log" 2>&1 &
  echo $! > "runs/mcp-kube-proxy.pid"
  echo "  kubernetes proxy started on $KUBE_PORT (pid $!)"
  # Not fatal: the MCP servers are what `make up` promises, and a laptop with no
  # cluster still gets a working stack. Only N8's probe goes without.
  for _ in $(seq 1 20); do
    listening "$KUBE_PORT" && break
    sleep 0.5
  done
  listening "$KUBE_PORT" || \
    echo "  kubernetes proxy did not bind $KUBE_PORT; see runs/mcp-kube-proxy.log" >&2
fi

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

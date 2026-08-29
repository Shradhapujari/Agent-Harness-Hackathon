# Hush — one entry point for the simulated data center (Person A).
# Targets that touch infra/ and scripts/ land with A1/A2/A6; `test` works today.

COMPOSE := docker compose -f infra/docker-compose.yml
KIND_CLUSTER := hush
KIND_CONTEXT := kind-$(KIND_CLUSTER)
# Derived from the cluster config so the two cannot drift apart. The pattern is
# indentation-agnostic on purpose: YAML lets the sequence sit at any column, and
# a count of zero would make the readiness loop below pass on its first check.
KIND_NODES := $(shell grep -cE '^[[:space:]]*-[[:space:]]+role:[[:space:]]' infra/kind/cluster.yaml)

.PHONY: sync up down kind-up kind-down smoke test

sync:
	uv sync --all-packages

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down -v

# Every kubectl call is pinned to the kind context this target just created,
# so the demo workloads can never be applied to a real cluster that happens to
# be the current context.
kind-up:
	# Checked before the cluster is built: a config this cannot count would
	# otherwise abort after ~50s, leaving an orphaned cluster and no workloads.
	@test "$(KIND_NODES)" -ge 1 2>/dev/null || \
	  { echo "KIND_NODES=$(KIND_NODES): no roles parsed from infra/kind/cluster.yaml" >&2; exit 1; }
	kind create cluster --config infra/kind/cluster.yaml
	# Workers register after the control-plane reports Ready, and `kubectl wait
	# --all` only selects the nodes that exist when it starts — a worker still
	# registering is never waited on. Applying then leaves one topology domain,
	# the spread constraint is trivially satisfied, and all nine pods land on the
	# control-plane. So: wait for all $(KIND_NODES) node objects to appear first,
	# and only then for them to go Ready.
	@for i in $$(seq 1 60); do \
	  n=$$(kubectl --context $(KIND_CONTEXT) get nodes --no-headers 2>/dev/null | wc -l | tr -d ' '); \
	  if [ "$$n" -ge "$(KIND_NODES)" ]; then break; fi; \
	  if [ "$$i" -eq 60 ]; then echo "only $$n/$(KIND_NODES) nodes registered after 120s" >&2; exit 1; fi; \
	  sleep 2; \
	done
	kubectl --context $(KIND_CONTEXT) wait --for=condition=Ready nodes --all --timeout=120s
	kubectl --context $(KIND_CONTEXT) apply -f infra/kind/workloads.yaml
	kubectl --context $(KIND_CONTEXT) -n demo rollout status deploy --timeout=120s

kind-down:
	kind delete cluster --name $(KIND_CLUSTER)

smoke:
	./scripts/smoke.sh

# Lint, type-check and test every workspace package. mcp/ and chaos/ are
# still empty shells; they are in scope from day one so drift cannot hide.
test:
	uv run ruff check .
	uv run mypy mock-bmc/app mcp/hush_mcp chaos/hush_chaos
	uv run pytest -q

# Hush — one entry point for the simulated data center (Person A).
# Targets that touch infra/ and scripts/ land with A1/A2/A6; `test` works today.

COMPOSE := docker compose -f infra/docker-compose.yml
KIND_CLUSTER := hush

.PHONY: sync up down kind-up kind-down smoke test

sync:
	uv sync --all-packages

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down -v

kind-up:
	kind create cluster --config infra/kind/cluster.yaml
	kubectl apply -f infra/kind/workloads.yaml
	kubectl -n demo rollout status deploy --timeout=120s

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

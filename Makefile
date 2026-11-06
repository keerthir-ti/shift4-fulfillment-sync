# Run `make` to see what you can do. To run the project you only need Docker and make.

.DEFAULT_GOAL := help

WEB_PORT ?= 13000
CONNECTOR_PORT ?= 14030
TEMPORAL_UI_PORT ?= 18243
PROFILE ?= accelerated
SERVICE ?=
export WEB_PORT CONNECTOR_PORT TEMPORAL_UI_PORT PROFILE

# Some machines have Docker Desktop selected but not running. Fall back to the plain Docker engine.
ifndef DOCKER_CONTEXT
  ifneq ($(shell docker info >/dev/null 2>&1 && echo ok),ok)
    ifeq ($(shell DOCKER_CONTEXT=default docker info >/dev/null 2>&1 && echo ok),ok)
      export DOCKER_CONTEXT := default
    endif
  endif
endif

COMPOSE := docker compose

.PHONY: help check problem solution stop status logs health reset explain clean verify-docker test typecheck boundaries

help: ## Show this list
	@echo "Fulfillment sync: see an approved order wait for the warehouse, then see the fix."
	@echo ""
	@echo "Quick start:"
	@echo "  1. make problem    Approve an order, and watch it wait for the snapshot"
	@echo "  2. make solution   Approve an order, and watch it arrive through Temporal"
	@echo "  3. make stop       Stop everything"
	@echo ""
	@echo "All commands:"
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

check: ## Check that Docker is installed and running
	@docker compose version >/dev/null 2>&1 || (echo "Docker with Compose isn't installed. See https://docs.docker.com/get-docker/"; exit 1)
	@docker info >/dev/null 2>&1 || (echo "Docker isn't running. Start Docker, then try again."; exit 1)

problem: check ## Run today's path, with no Temporal
	FULFILLMENT_SYNC=off $(COMPOSE) up -d --build --wait --remove-orphans
	@echo ""
	@echo "Ready: http://127.0.0.1:$(WEB_PORT)"
	@echo "Create a draft and approve it. Oracle has the lines in seconds, but the warehouse waits for the snapshot."

solution: check ## Run with Temporal, the worker and the workflow on
	FULFILLMENT_SYNC=on $(COMPOSE) --profile sync up -d --build --wait
	@echo ""
	@echo "Ready: http://127.0.0.1:$(WEB_PORT)"
	@echo "Temporal UI: http://127.0.0.1:$(TEMPORAL_UI_PORT)"
	@echo "Create a draft and approve it. The order reaches the warehouse without waiting for the snapshot."

stop: ## Stop everything, and keep the data
	$(COMPOSE) --profile sync down

status: ## Show which containers are running and healthy
	$(COMPOSE) --profile sync ps

logs: ## Follow output. For one service: make logs SERVICE=oracle
	$(COMPOSE) --profile sync logs -f $(SERVICE)

health: ## Check that the app and simulators respond
	@curl -sf http://127.0.0.1:$(WEB_PORT)/api/health && echo || (echo "Not responding on port $(WEB_PORT). Run make problem or make solution first."; exit 1)

reset: ## Clear all orders and start the scenario again
	@curl -sf -X POST http://127.0.0.1:$(CONNECTOR_PORT)/lab/reset && echo || (echo "Not running. Run make problem or make solution first."; exit 1)

explain: ## Explain one order: make explain ORDER=<SourceTransactionNumber>
	@curl -sf "http://127.0.0.1:$(WEB_PORT)/api/order-delivery?orderKey=$(ORDER)" && echo || (echo "No answer. Is the app running, and did you set ORDER?"; exit 1)

clean: ## Remove the containers, the image and all simulator data
	$(COMPOSE) --profile sync down -v --rmi local

verify-docker: ## Prove both paths in a browser against the containers (also needs Node.js, pnpm and Chrome)
	$(MAKE) clean problem
	E2E_BASE_URL=http://127.0.0.1:$(WEB_PORT) pnpm exec playwright test tests/e2e/operator-flow.spec.ts
	$(MAKE) stop solution
	E2E_BASE_URL=http://127.0.0.1:$(WEB_PORT) E2E_FULFILLMENT_SYNC=on pnpm exec playwright test tests/e2e/order-delivery.spec.ts
	$(MAKE) stop

test: ## Run unit and integration tests (needs Node.js and pnpm)
	pnpm test

typecheck: ## Run the TypeScript checks (needs Node.js and pnpm)
	pnpm typecheck

boundaries: ## Check the workflow has no simulator dependency (needs Node.js and pnpm)
	pnpm check:boundaries

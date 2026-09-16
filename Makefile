# RemitBridge — top-level development tasks.
#
# This is a thin wrapper over the per-component commands, and it exists for one
# reason: `make check` mirrors what CI runs, so a green local run is a reliable
# predictor of a green build. Everything else here saves remembering which
# directory a command lives in.
#
# Targets are intentionally not chained into one "build everything": the
# components have genuinely different toolchains, and a failure should name the
# component rather than a monolithic script.

SHELL := bash
.DEFAULT_GOAL := help

CARGO ?= cargo
NPM ?= npm

# Component directories, in dependency order.
COMPONENTS := backend admin-web mobile scripts

.PHONY: help
help: ## Show this help
	@echo "RemitBridge targets:"
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------- setup ----

.PHONY: install
install: ## Install dependencies for every Node component
	@for dir in $(COMPONENTS); do \
		echo "==> $$dir"; \
		(cd $$dir && $(NPM) install) || exit 1; \
	done

.PHONY: wasm-target
wasm-target: ## Add the wasm32 target the contracts need
	# wasm32v1-none, not wasm32-unknown-unknown: see scripts/build-contracts.sh.
	rustup target add wasm32v1-none

# ------------------------------------------------------------ contracts ----

.PHONY: contracts
contracts: ## Format, lint and test the Soroban contracts
	cd contracts && $(CARGO) fmt --all --check
	cd contracts && $(CARGO) clippy --all-targets --all-features -- -D warnings
	cd contracts && $(CARGO) test --all-features

.PHONY: contracts-build
contracts-build: ## Build the four deployable Wasm artifacts
	cd scripts && $(NPM) run build:contracts

.PHONY: deploy-dry-run
deploy-dry-run: ## Walk the deploy and wiring path without submitting anything
	cd scripts && $(NPM) run deploy:dry-run

# ---------------------------------------------------------------- checks ----

.PHONY: typecheck
typecheck: ## Typecheck every Node component
	@fail=0; \
	for dir in $(COMPONENTS); do \
		echo "==> $$dir"; \
		(cd $$dir && $(NPM) run typecheck) || fail=1; \
	done; \
	exit $$fail

.PHONY: lint
lint: ## Lint every Node component
	@fail=0; \
	for dir in backend admin-web mobile; do \
		echo "==> $$dir"; \
		(cd $$dir && $(NPM) run lint) || fail=1; \
	done; \
	exit $$fail

.PHONY: test
test: ## Run the test suites for the contracts and every Node component
	@fail=0; \
	cd contracts && $(CARGO) test --all-features || fail=1; \
	for dir in backend admin-web mobile; do \
		echo "==> $$dir"; \
		(cd $$dir && $(NPM) test) || fail=1; \
	done; \
	exit $$fail

.PHONY: check
check: typecheck lint test ## Everything CI runs, in one command

.PHONY: audit
audit: ## Report dependency advisories for the Node components
	@for dir in $(COMPONENTS); do \
		echo "==> $$dir"; \
		(cd $$dir && $(NPM) audit || true); \
	done

# ------------------------------------------------------------ local dev ----

.PHONY: db-up
db-up: ## Start Postgres in the background
	docker compose up -d postgres

.PHONY: db-down
db-down: ## Stop the local Postgres
	docker compose down

.PHONY: db-migrate
db-migrate: ## Generate the Prisma client, apply the schema and seed
	cd backend && $(NPM) run prisma:generate
	cd backend && $(NPM) run prisma:migrate
	cd backend && $(NPM) run prisma:seed

.PHONY: dev-api
dev-api: ## Run the backend API with reload
	cd backend && $(NPM) run dev

.PHONY: dev-indexer
dev-indexer: ## Run the event indexer as its own process
	cd backend && $(NPM) run indexer

.PHONY: dev-admin
dev-admin: ## Run the operator console
	cd admin-web && $(NPM) run dev

.PHONY: dev-mobile
dev-mobile: ## Start the Expo dev server
	cd mobile && $(NPM) start

.PHONY: stack
stack: ## Bring up Postgres and the API in containers
	docker compose up --build

# --------------------------------------------------------------- hygiene ----

.PHONY: clean
clean: ## Remove build output and installed dependencies
	rm -rf contracts/target
	rm -rf backend/dist admin-web/.next
	@for dir in $(COMPONENTS); do rm -rf $$dir/node_modules; done
	@echo "Removed build output and node_modules. Contracts' Cargo cache is untouched."

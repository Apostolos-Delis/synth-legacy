.PHONY: help install test typecheck lint lint-fix build dev clean release check

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	bun install

test: ## Run all tests
	bun run test --timeout 10000

typecheck: ## Run TypeScript type checking
	bun run typecheck

lint: ## Run ESLint
	bun run lint

lint-fix: ## Run ESLint with auto-fix
	bun run lint:fix

check: typecheck lint test ## Run typecheck + lint + tests

build: ## Build ./dist/synth binary for current platform
	bun run build:binary

dev: ## Run CLI in dev mode
	bun run dev

clean: ## Remove build artifacts
	rm -rf dist

release: check ## Build release binaries for all platforms (after checks)
	bun run build:darwin-arm64
	bun run build:darwin-x64
	bun run build:linux-arm64
	bun run build:linux-x64
	@echo "\nRelease binaries in dist/"
	@ls -lh dist/synth-*

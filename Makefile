.PHONY: help setup dev build check test test-browser package db-migrate seed staff-create password-reset session-revoke provision deploy snapshot restore suspend resume destroy smoke-prod reset-local benchmark-auth ai-carry-forward
ENV ?=
NODE = node --disable-warning=ExperimentalWarning
TASK = $(NODE) scripts/run.mjs

help:
	@printf '%s\n' \
	  'make setup                      Install dependencies, migrate and seed local D1' \
	  'make dev ENV=local              Build and serve the local app' \
	  'make build ENV=local            Build frontend assets' \
	  'make package ENV=local          Dry-run the Worker build' \
	  'make check / test / test-browser Verify types, domain/API and browser behavior' \
	  'make db-migrate / seed ENV=...   Apply migrations or initialize demo data' \
	  'make staff-create / password-reset / session-revoke ENV=... Manage accounts' \
	  'make provision / deploy ENV=prod Prepare or publish the named Cloudflare app' \
	  'make snapshot ENV=... SNAPSHOT=... [MODE=demo] Export portable data' \
	  'make restore ENV=... SNAPSHOT=... Restore into a fresh target' \
	  'make suspend / resume / destroy ENV=prod  Manage the named deployment' \
	  'make smoke-prod ENV=prod         Check ordinary login with dedicated credentials' \
	  'make reset-local ENV=local RESET=local  Move old local data aside and reseed' \
	  'make benchmark-auth              Measure local Better Auth password verification' \
	  'make ai-carry-forward ENV=prod  Reconcile a restored AI spending ledger'

setup:
	npm ci --no-audit --no-fund
	$(TASK) setup local

dev build package db-migrate seed staff-create password-reset session-revoke provision deploy suspend resume destroy smoke-prod ai-carry-forward:
	$(TASK) $@ "$(ENV)"

snapshot restore:
	$(TASK) $@ "$(ENV)" "$(SNAPSHOT)" "$(MODE)"

reset-local:
	$(TASK) $@ "$(ENV)" "$(RESET)"

benchmark-auth:
	$(NODE) scripts/benchmark-auth.mjs

check:
	npm run check

test:
	npm test

test-browser:
	npm run test-browser

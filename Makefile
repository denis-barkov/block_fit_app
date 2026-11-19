.PHONY: seed-goals seed-proposals seed-update accounts-provision help setup dev build check test test-browser package db-migrate seed staff-create password-reset session-revoke provision deploy snapshot restore suspend resume destroy smoke-prod reset-local benchmark-auth ai-carry-forward
ENV ?=
NODE = node --disable-warning=ExperimentalWarning
TASK = $(NODE) scripts/run.mjs

help:
	@printf '%s\n' \
	  'make setup                      Install dependencies, migrate and seed local D1' \
	  'make dev ENV=local              Build and serve the local app' \
	  'make build ENV=local            Build frontend assets' \
	  'make package ENV=local          Dry-run the Worker build and package the Pages ingress' \
	  'make check / test / test-browser Verify types, domain/API and browser behavior' \
	  'make db-migrate / seed ENV=...   Apply migrations or initialize demo data' \
	  'make seed-goals ENV=local       Add illustrative saved goals and schedule estimates' \
	  'make seed-proposals ENV=local   Add illustrative pending proposals to the local demo' \
	  'make staff-create / password-reset / session-revoke ENV=... Manage accounts' \
	  'make seed-update ENV=... [APPLY=yes] Preview or apply the demo fixture update' \
	  'make accounts-provision ENV=... [ACCOUNTS=...] [APPLY=yes] Preview or apply named accounts' \
	  'make provision / deploy ENV=prod [DRY_RUN=yes] Prepare or publish Pages, Worker and D1' \
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

dev build package db-migrate seed seed-goals seed-proposals staff-create password-reset session-revoke suspend resume destroy smoke-prod ai-carry-forward:
	$(TASK) $@ "$(ENV)"

provision deploy:
	$(TASK) $@ "$(ENV)" "$(DRY_RUN)"

seed-update:
	$(TASK) $@ "$(ENV)" "$(APPLY)"

accounts-provision:
	$(TASK) $@ "$(ENV)" "$(ACCOUNTS)" "$(APPLY)"

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

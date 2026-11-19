# BlockFit NYC operations

## Back up and restore

A portable JSON snapshot carries application and migration versions. A private snapshot includes business records, account password hashes, and compact AI spending totals. It omits sessions, provider credentials, and cached AI responses. Version 0.1.0 adds the saved-location preference and a timestamped removal history. Private snapshots include the history. Earlier supported snapshots restore saved locations with the preference enabled. Treat the file as private data. Store it under the ignored `.blockfit/` directory or outside the checkout and use encrypted storage for retention or transfer. Resident travel adds one rolling quota row per resident who generates suggestions. Expired quota rows are pruned when reserving AI work. Restores clear transient resident quotas and suggestion cache entries while preserving shared daily attempts and total spending.

1. Stop or suspend user traffic and wait for in-flight writes before a private export. Locally, use `make suspend ENV=local`. Export with `make snapshot ENV=local SNAPSHOT=.blockfit/pilot-private.json`. Run `make resume ENV=local` if you want to reopen that source.
2. To share a clean demonstration dataset, run `make snapshot ENV=local MODE=demo SNAPSHOT=.blockfit/pilot-demo.json`. This builds the stock synthetic dataset in a temporary local database. It contains no accounts, sessions, private requests, or credentials carried over from the source.
3. Choose a directory that does not yet exist, for example `.blockfit/restore-qa`. Run `BLOCKFIT_STORE=.blockfit/restore-qa make restore ENV=local SNAPSHOT=.blockfit/pilot-demo.json`. The script migrates the fresh directory, imports the snapshot, checks record counts and foreign keys, and leaves the app suspended.
4. Use the same `BLOCKFIT_STORE` for subsequent commands. For a demo restore, create a fresh staff account with `make staff-create ENV=local` and self-register a resident after resume. Run `make resume ENV=local` then `make dev ENV=local` against that store. Verify inventory, role access, and the expected comparison. A private restore preserves the account password hashes and requires sign-in again.

For a Cloudflare restore, provision a separately named destination database before restoring. Keep the destination undeployed while importing, then deploy with a fresh `AUTH_SECRET` and chosen operator credentials. Resume when you have reviewed results. Keep the source and destination manifests and backups distinct. The `RETAIN` option in `make destroy ENV=prod` removes the Pages project and Worker while retaining D1. The `DELETE` option also removes the named D1 UUID.

## Production rollout

1. Set the target and recovery contact in `.env.prod`. Run `make provision ENV=prod DRY_RUN=yes` to check account ownership and names. Obtain the scoped Resource Tagging token if using Wrangler OAuth.
2. Once authorized, run `make provision ENV=prod`. Record the assigned Pages origin printed by the script. Run `make deploy ENV=prod DRY_RUN=yes` to build both artifacts, then `make deploy ENV=prod` to publish.
3. Seed illustrative data and provision accounts through the corresponding Make targets. Run `make smoke-prod ENV=prod` through the canonical Pages address. Check anonymous staff redirects, secure host-only session cookies, and the actual authentication CPU before sharing the demo.

## Production smoke test

Define one resident and one staff login with purpose `automated-test` in the target account definition. Use `.blockfit/local-smoke.env` or `.blockfit/prod-smoke.env` with mode 0600 for the protected test credentials. Set `RESIDENT_EMAIL`, `RESIDENT_PASSWORD`, `STAFF_EMAIL`, and `STAFF_PASSWORD` privately. Use unique credentials for production and keep the operator account-definition JSON free of passwords.

Run `make accounts-provision ENV=prod` to preview the named changes. Once authorized, use `APPLY=yes` and confirm the deployment name. Presentation credentials are prompted separately. Existing passwords stay in effect on a repeat run. Use the separate recovery or session-revocation command for intentional changes.

`make smoke-prod ENV=prod` signs in through the ordinary API, checks that both accounts have the automated-test purpose, and creates one scoped request only after checking the resident's data. The script verifies the isolated staff comparison, cleans up the run's request and any temporary location, and signs out. Existing test data and presentation inventory are preserved. Check actual authentication CPU against the target plan before opening the pilot. No plan changes happen in these workflows.

## Carry AI spend forward

On the old deployment, suspend access, wait for in-flight calls, and record the durable spent/reserved balance and the current UTC day’s dispatched attempts. A private restore retains at least the snapshot’s ledger total and day count. Every new or restored database starts with AI frozen. For a first-time authorized budget, use a verified zero floor and zero attempts. Check provider usage and account for any charges and attempts after the snapshot. Use `make ai-carry-forward ENV=prod` with the reconciled lifetime floor and UTC attempt count. Set the total budget to the authorized lifetime cap, which includes that prior spending. Enable live AI through the deployment configuration only after confirming a single active ledger for the authorized budget.

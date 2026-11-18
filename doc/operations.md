# BlockFit NYC operations

## Back up and restore

A portable JSON snapshot carries application and migration versions. A private snapshot includes business records, account password hashes, and compact AI spending totals. It omits sessions, provider credentials, and cached AI responses. Treat the file as private data. Store it under the ignored `.blockfit/` directory or outside the checkout and use encrypted storage for retention or transfer.

1. Stop or suspend user traffic and wait for in-flight writes before a private export. Locally, use `make suspend ENV=local`. Export with `make snapshot ENV=local SNAPSHOT=.blockfit/pilot-private.json`. Run `make resume ENV=local` if you want to reopen that source.
2. To share a clean demonstration dataset, run `make snapshot ENV=local MODE=demo SNAPSHOT=.blockfit/pilot-demo.json`. This builds the stock synthetic dataset in a temporary local database. It contains no accounts, sessions, private requests, or credentials carried over from the source.
3. Choose a directory that does not yet exist, for example `.blockfit/restore-qa`. Run `BLOCKFIT_STORE=.blockfit/restore-qa make restore ENV=local SNAPSHOT=.blockfit/pilot-demo.json`. The script migrates the fresh directory, imports the snapshot, checks record counts and foreign keys, and leaves the app suspended.
4. Use the same `BLOCKFIT_STORE` for subsequent commands. For a demo restore, create a fresh staff account with `make staff-create ENV=local` and self-register a resident after resume. Run `make resume ENV=local` then `make dev ENV=local` against that store. Verify inventory, role access, and the expected comparison. A private restore preserves the account password hashes and requires sign-in again.

For a Cloudflare restore, provision a separately named destination database before restoring. Keep the destination undeployed while importing, then deploy with a fresh `AUTH_SECRET` and chosen operator credentials. Resume when you have reviewed results. Keep the source and destination manifests and backups distinct. The `RETAIN` option in `make destroy ENV=prod` removes the Worker and retains D1. The `DELETE` option removes the named Worker and D1 UUID.

## Production smoke test

Prepare dedicated synthetic resident and staff logins. Use a staff account created by `make staff-create ENV=prod` and a separately self-registered resident. Keep them out of meaningful demand counts. Write `.blockfit/prod-smoke.env` with mode 0600 and fill `RESIDENT_EMAIL`, `RESIDENT_PASSWORD`, `STAFF_EMAIL`, and `STAFF_PASSWORD` privately. The smoke command signs in, verifies each role’s access, requests a comparison, and signs out. It creates no demand or inventory records and dispatches no AI calls. Check Cloudflare request errors and actual authentication CPU against the target plan before opening the pilot. No plan changes happen in these workflows.

## Carry AI spend forward

On the old deployment, suspend access, wait for in-flight calls, and record the durable spent/reserved balance and the current UTC day’s dispatched attempts. A private restore retains at least the snapshot’s ledger total and day count. Every new or restored database starts with AI frozen. For a first-time authorized budget, use a verified zero floor and zero attempts. Check provider usage and account for any charges and attempts after the snapshot. Use `make ai-carry-forward ENV=prod` with the reconciled lifetime floor and UTC attempt count. Set the total budget to the authorized lifetime cap, which includes that prior spending. Enable live AI through the deployment configuration only after confirming a single active ledger for the authorized budget.

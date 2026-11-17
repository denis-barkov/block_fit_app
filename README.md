# BlockFit NYC

**More outdoor fitness access from the available public investment budget.**

BlockFit NYC helps City staff compare candidate outdoor fitness investments using resident demand, existing equipment coverage, and transparent cost assumptions. Residents can find equipment and request what is missing nearby. The primary benefit is better-informed investment planning.

**Status:** pre-implementation MVP specification. Wireframes and a blueprint exist; the connected application and commands below still need implementation. Initial scope is a two-day build, a small NYC neighborhood pilot, and roughly one week of demonstration use. This is a project concept developed for an NYCEDC initiative, not an official City service or funding commitment.

## MVP experience

| Area | Initial capabilities |
| --- | --- |
| Public | Responsive equipment map/list, category filters, site details, source and verification status. Browse without signing in. Link to official maintenance reporting where appropriate. |
| Resident | Sign in to save one private location and request nearby equipment; optionally suggest a site. Edit, reconfirm, or withdraw requests. One active request per resident/category. |
| City workspace | Add/edit parks, equipment pins, and candidate sites. Compare coverage and costs under a budget, request an AI explanation, and export a comparison brief. |

Start with pull-up bars, parallel bars, and sit-up benches. Equipment can belong to a park or stand alone. Keep existing equipment separate from candidate installations. Use provisioned demonstration accounts and synthetic resident locations initially; enforce resident ownership and staff permissions server-side. A recorded request does not imply official acceptance or approval.

No photo uploads, repair queue, address-proof collection, walking routes, citywide optimization, or automated City submissions in this MVP. Minimal bundled design images are acceptable. Public pages never expose private resident locations.

## Planning model

- Apply a configurable straight-line radius, clearly labeled as approximate coverage rather than walking time. Use the same radius consistently within a comparison.
- Count distinct active requesters who lack existing usable equipment of the selected type and would gain coverage. Count overlapping coverage once when combining sites.
- Separate upfront purchase, installation, site preparation, and accessibility costs from maintenance and replacement. Compare equivalent service scopes over the same planning period, using undiscounted constant-dollar assumptions initially.
- Show upfront budget fit, newly covered requesters, and modeled lifecycle cost per newly covered requester. Zero coverage produces “N/A.” Unknown costs remain unknown; include source, low/base/high assumptions, and feasibility status.
- Request counts are participation evidence, not population-wide need or an equity measure. Comparisons support human review; they do not establish savings, ROI, land availability, or installation approval.

## Technology choices

| Technology | Role and reason |
| --- | --- |
| TypeScript, React, Vite | One language and a shared component application for all three experiences; fast local iteration. |
| Tailwind CSS | Responsive styling driven by shared design tokens. |
| Cloudflare Workers + Static Assets | Frontend and API in one deployment, without server maintenance. |
| Hono + Zod | Small API layer with explicit input validation. |
| Cloudflare D1 + SQL migrations | Persistent relational records and sessions, without a separate database service. |
| Better Auth | Authentication and session handling with D1 support. Benchmark secure authentication against the chosen runtime limits; never weaken password hashing to fit a limit. |
| MapLibre GL JS + OpenFreeMap | Interactive map and free basemap tiles; retain required attribution. |
| Selected Turf.js functions | Geographic distances and overlays; deterministic TypeScript handles coverage and economics. |
| OpenAI API, GPT-5.4 mini | Initial model for concise explanations grounded in supplied comparison results. Model is configurable. |
| Vitest + Playwright | Calculation/API tests and public, resident, and staff browser journeys. |
| Wrangler, maintained scripts, npm, Makefile | Local emulation, reproducible infrastructure operations, migrations, and deployment. Terraform is not part of the initial setup. |

Pin compatible dependency versions and commit the lockfile during implementation. Record the required Node.js version then. No paid map, geocoding, routing, email, or monitoring service is required. Start with site-name search and map-pin location selection; basemap tiles do not provide address search.

## Data and existing City workflows

Use a small attributed public snapshot and manually entered equipment. Store source, verification status, and date; a park listing alone does not confirm a particular piece of equipment. Keep synthetic demand and illustrative costs visibly labeled.

- [NYC Parks Properties](https://data.cityofnewyork.us/Recreation/Parks-Properties/enfh-gkve): park identifiers and geography; validate the selected export before importing. It does not establish installation feasibility.
- [NYC Parks](https://www.nycgovparks.org): reference information to supplement staff-entered records. Avoid copying Google Maps content into the database.
- [NYC311 park maintenance](https://portal.311.nyc.gov/article/?kanumber=KA-01060): external reporting route for applicable park issues, not an automatic submission integration.
- [Capital Projects Portal](https://capitalprojects.nycplanningdigital.com/about): public context staff can consult and link in an exported comparison.

The application supplements existing review processes through exportable evidence and public references. No restricted City API or agency integration is assumed.

## Configuration and environments

Shared application settings live in `config/`; reusable visual tokens live in `design/`. Exact values have one source. Environment configuration is resolved once and reused by application tooling and infrastructure scripts.

| File | Purpose | Tracked example |
| --- | --- | --- |
| `.env` | Shared deployment values, including project metadata | `.env.example` |
| `.env.local` | Local development overrides | `.env.local.example` |
| `.env.prod` | Live Cloudflare deployment settings | `.env.prod.example` |

Load root `.env`, then the explicitly selected environment layer. No deployed test environment is planned; tests run locally against isolated fixtures. Actual environment files are ignored by Git. Examples contain safe defaults and blank secrets/account-specific fields. Provision credentials separately; expose only explicitly public configuration to the browser.

Resource tags derive from resolved environment values:

| Tag | Value |
| --- | --- |
| `project-name` | `blockfit-nyc` |
| `environment` | `prod` for live resources; `local` for local configuration |
| `managed-by` | `script` |
| `service-part` | `infra` where supported |
| `funding` | `personal` |

Use resource names prefixed with `blockfit-nyc-<environment>`. Account/resource identifiers remain configurable so another deployment can coexist. Apply tags where supported; document exceptions. Tags organize ownership but do not isolate quotas or guarantee billing breakdowns. Track usage by the dedicated Worker and D1 database alongside account billing.

## Cost, AI, and retention controls

- Target zero incremental infrastructure cost within available free/included allowances. Cloudflare account quotas are shared with other apps. Check remaining allowances and runtime CPU limits before deployment; never upgrade plans automatically.
- Keep queries indexed and paginated, cache public inventory, and run comparisons on demand. No polling, scheduled imports, uploaded media storage, or separate monitoring platform.
- Use OpenAI only, through a dedicated project/key. Allow up to 150 generation attempts per day across the app, subject to a separately configured total demonstration spending ceiling. The ceiling must be explicitly set before AI is enabled; do not assume a budget from daily call counts.
- Enforce the total ceiling server-side by atomically reserving the maximum bounded call cost before dispatch, then reconciling usage. Include concurrent calls, billed reasoning tokens, and failures with uncertain usage. No automatic retries, paid tools, or model escalation. Keep the approved budget across restarts; recreating an instance does not authorize a fresh spending allowance.
- Cache explanations by comparison inputs, data revision, prompt version, and model. Send only public/synthetic or suitably aggregated non-identifying data. Use `store:false`; provider retention rules still apply. AI explains supplied results and missing assumptions; it does not invent valuations or perform authoritative calculations.
- AI is staff-triggered, never automatic per public visit. If disabled or exhausted, ordinary comparisons and exports still work. Automated tests use mocked AI responses.
- Retain only necessary application records, a bounded explanation cache, and compact usage totals. No full prompt histories. Native logs contain small safe error events; routine invocation logging, tracing, and debug payloads are disabled by default. Confirm actual logging behavior and free allowances during deployment.
- After the demonstration, suspend access and AI calls while retaining the database, or export and destroy the environment. Snapshots stay outside Git; encrypt private-data backups and keep sanitized demo snapshots separate.

## Development and lifecycle commands

**Planned interface, not yet executable.** Implementation must provide documented Makefile targets and update this section with verified setup instructions. Prerequisites are the pinned Node.js runtime, npm, Make, deployment credentials for Cloudflare, and a separate OpenAI key only when live AI is enabled.

| Target | Intended behavior |
| --- | --- |
| `make help` / `make setup` | Explain commands; install dependencies and prepare missing environment files without overwriting values. |
| `make dev ENV=local` | Run locally with local D1 and no production mutations. |
| `make check` / `make test` / `make test-browser` / `make build` | Static checks, automated tests, browser journeys, and build. |
| `make provision ENV=prod` / `make deploy ENV=prod` | Reconcile project resources and tags; build, migrate, and deploy through maintained scripts. |
| `make snapshot ENV=prod` | Export data/schema with application and schema version metadata. |
| `make restore ENV=prod SNAPSHOT=<path>` | Import into a fresh target and validate compatibility and records. |
| `make suspend ENV=prod` / `make resume ENV=prod` | Disable/re-enable app access without deleting retained data. |
| `make destroy ENV=prod` | Confirm the account and exact project resources, then remove them without affecting other applications. |

Infrastructure changes go through these maintained workflows. Read-only CLI diagnostics remain available. Verify rebuild and snapshot restoration into an isolated instance, including new account bindings and fresh secrets. Demo restores exclude active sessions; backups are not deleted with the environment. Restoring application data and preserving the AI spending ledger require separate, explicit handling.

## Project documents

Working conventions are in `AGENTS.md`. Initial blueprints, wireframes, and Mermaid files belong in `doc/intakes/`; focused current-state documentation belongs in `doc/`. Update this README as capabilities and setup become implemented or change.

Provider references: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 export/import](https://developers.cloudflare.com/d1/best-practices/import-export-data/), [resource tagging](https://developers.cloudflare.com/resource-tagging/), [logging pricing](https://developers.cloudflare.com/observability/pricing/), [OpenAI model](https://developers.openai.com/api/docs/models/gpt-5.4-mini), [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data), [OpenFreeMap](https://openfreemap.org/). Recheck provider limits before deployment.

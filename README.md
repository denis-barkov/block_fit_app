# BlockFit NYC

BlockFit NYC helps City staff compare outdoor fitness investments using resident requests, existing equipment coverage, and transparent cost assumptions. Residents can find equipment, check what is known about access, and request what is missing near a private location. Staff can maintain the inventory, model candidate sites under a budget, and export a comparison brief.

The 0.0.3 local beta uses a Forest Hills, Queens demonstration dataset with 81 synthetic request origins, 15 illustrative equipment records, and eight candidate sites. Demo verification and cost assumptions are simulated. BlockFit NYC is an NYCEDC project concept. A recorded request can inform planning discussion, and City approval and funding follow existing processes.

## Run locally

Use Node.js **24.22.3** (see `.node-version`), npm 11, and Make. The local app requires no Cloudflare credentials or OpenAI key.

```sh
make setup
make dev ENV=local
```

Open the loopback URL printed by Wrangler, normally `http://127.0.0.1:8787`. If that port is occupied, choose a free one in `.env.local` by changing `APP_ORIGIN` before restarting. Use the exact configured URL for session cookies and origin checks.

Setup applies the SQL migrations and creates the local dataset and two demonstration accounts. Open **`.blockfit/demo-accounts.json`** in a private local editor to retrieve the generated logins. The file is ignored by Git. Use **Sign in / Register** for the resident login or self-registration, or open **City staff sign in** at `/staff/login` with the staff demo credentials. The dedicated staff shell starts at `/staff`. **View public site** and **Return to City workspace** preserve the staff session. Keep synthetic coordinates in any demonstration. The default local database lives in `.blockfit/local-d1/` and survives restart.

| Command | Purpose |
| --- | --- |
| `make help` | List supported commands. |
| `make check` | Type-check application and test code. |
| `make test` | Run domain, API/D1, accounting and operations tests with isolated databases. |
| `npx playwright install --only-shell chromium` then `make test-browser` | Run isolated Chromium journeys using a loopback Worker and offline map fixtures. |
| `make build ENV=local` | Build static frontend assets in `dist/`. |
| `make package ENV=local` | Bundle the Worker in Wrangler dry-run mode and package the Pages ingress. |
| `make db-migrate ENV=local` / `make seed ENV=local` | Apply migrations or initialize an empty demo dataset. |
| `make seed-update ENV=local` | Preview the fixture replacement. Run again with `APPLY=yes` to apply it. |
| `make reset-local ENV=local RESET=local` | With the dev server stopped, move the old local store aside, then migrate and seed a fresh one. |
| `make benchmark-auth` | Measure Better Auth’s native scrypt password verification on the local Node host. |

## Product behavior

- **Public discovery.** Browse without login, filter by equipment type, search site names, and optionally place a reference pin for approximate straight-line sorting. Equipment has its own source, verification record, condition, and access status. The public map and lists label illustrative equipment and simulated verification. Sites flagged as NYC Parks-maintained link to [NYC311 park maintenance](https://portal.311.nyc.gov/article/?kanumber=KA-01060).
- **Resident requests.** Register with a display name, unverified email login, and a passphrase of at least 15 characters. Save one private map pin or enter coordinates in the pilot bounds. Review and record equipment requests, then edit, reconfirm, withdraw, or restore them. A database constraint allows one active request per account and equipment type. Changes to the saved origin move active requests together. A suggested installation site is separate from the request origin.
- **City workspace.** Staff can add, edit, and archive parks, equipment, and candidate sites. Choose equipment and assumptions, inspect already covered and unmet demand, then select candidates from the map or table. Compare individuals and combinations of up to three candidates. The table shows unique new coverage and how many requesters fall in overlapping radii. Run the comparison again after relevant changes. Briefs carry the comparison revision and exclude private origins, notes and identities.
- **Planning model.** The default is a 200 m straight-line radius and a 10-year horizon. Baseline coverage requires listed, verified, usable equipment with confirmed public access. The calculation counts overlapping requesters once. It shows upfront budget fit, undiscounted lifecycle cost, cost per newly covered requester, and low/base/high assumptions. Unknown costs stay unknown, and zero new coverage yields N/A for cost per requester. The highlight considers fully costed, suitable options with positive coverage within the base upfront budget. Suitability is an analytical screening status. Participation counts do not establish population-wide need, unique people, or installation feasibility.

Use [NYC Parks Properties](https://data.cityofnewyork.us/Recreation/Parks-Properties/enfh-gkve) for park references and the [Capital Projects Portal](https://capitalprojects.nycplanningdigital.com/about) for public project context. The demo has no imported Parks inventory. Use the optional public project link in candidate records to carry a reference into the brief.

## Technology and configuration

- TypeScript, React, Vite and Tailwind provide a responsive interface. MapLibre GL JS and OpenFreeMap supply the interactive basemap with attribution. Turf provides distance and radius geometry. Lists and coordinate fields remain available when the map fails.
- Hono and Zod serve same-origin APIs in a Cloudflare Worker with Static Assets. In production, Cloudflare Pages forwards the public origin to the private Worker through a service binding. D1 stores users, sessions, inventory, demand, and AI accounting. Better Auth handles credentials and sessions. Resident ownership and staff privileges are enforced in the Worker. Persistent D1 counters limit login, registration, and generation attempts.
- `config/` owns shared categories, bounds, policy and calculation defaults. `design/` owns visual tokens. Vitest and Playwright cover calculations, APIs, and browser journeys. npm, Wrangler, and maintained Make targets handle application operations.
- Start with `.env.example`, `.env.local.example`, and `.env.prod.example`. Setup creates missing files only and generates the local auth secret. The tooling loads root `.env`, then `.env.local` or `.env.prod` for the explicitly selected environment. Vite’s dotenv loading is disabled, and no private bindings are serialized into the frontend. Opt-in production CI injection can override only `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_TAG_API_TOKEN`, `AUTH_SECRET`, and `OPENAI_API_KEY` when `BLOCKFIT_CI_INJECT=true`. Wrangler receives resolved bindings and provider credentials. Production uses its secret storage.
- Recovery uses **Forgot password? → Contact us** with the configured `CONTACT_EMAIL`. No verification or reset email is sent. Operators independently verify ownership before resetting, since an unverified email claim does not prove identity. Use `make staff-create`, `make password-reset`, or `make session-revoke` with an explicit `ENV`. Passwords are entered at a hidden prompt. Reset revokes existing sessions.

### Demo updates and named accounts

For an existing 0.0.1 store, stop the local dev server, run `make db-migrate ENV=local`, then preview with `make seed-update ENV=local`. Apply with `make seed-update ENV=local APPLY=yes`. The workflow replaces the legacy demo demand and updates fixture-owned records. Manual records, resident submissions, and existing accounts are preserved. Fresh setup installs the expanded fixture automatically.

Copy [the account definition example](config/accounts.example.json) into `.blockfit/local-accounts.json` or `.blockfit/prod-accounts.json` and fill in the operator-approved logins, display names, roles, and purposes. Use `make accounts-provision ENV=local` to preview changes, then repeat with `APPLY=yes`. Use the explicit `ENV=prod` target only when authorized. Named presentation passwords are entered in a hidden terminal prompt. One dedicated automated-test resident and one staff account per target can use the protected smoke credentials described in the [operations guide](doc/operations.md).

Ordinary resident registration remains available. Staff provisioning requires operator access. Existing role or purpose conflicts require explicit resolution. Automated-test requests use their own comparison and revision scope. Test staff can read illustrative comparison inputs and export test briefs. Shared inventory mutations and AI generation require ordinary staff access.

## Cloudflare operations

The public demo is served at the Pages project’s assigned `pages.dev` URL. Set `PAGES_PROJECT_NAME` in `.env.prod` (the example requests `blockfit-demo`). Provisioning reads the assigned hostname and uses it as the canonical origin for Pages, the Worker, and Better Auth. An optional `APP_ORIGIN` pins the exact value. The Worker and D1 use `blockfit-nyc-prod[-suffix]` by default. Pages invokes the Worker through a private service binding. The Worker’s `workers.dev` route and version preview URLs are disabled. Pages preview and deployment aliases cannot enter the app. See the [deployment architecture](doc/architecture.md).

Set the Cloudflare account ID, recovery email, and auth secret in the ignored production environment. Wrangler’s existing OAuth login can manage Pages, Workers, and D1. Use an account-owned `CLOUDFLARE_TAG_API_TOKEN` with Resource Tagging read/write permissions when using OAuth. Alternatively, a scoped `CLOUDFLARE_API_TOKEN` can handle both deployment and tags. Store tokens privately. The protected manifest in `.blockfit/` records the account, Pages project, Worker, and D1 database. For a parallel deployment, select a unique Pages project name and deployment suffix.

Run `make provision ENV=prod DRY_RUN=yes` to check the target without creating cloud resources. After authorized provisioning and deployment, run the production smoke test and check actual Worker CPU before broader testing. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

| Command | Purpose |
| --- | --- |
| `make provision ENV=prod` | Reconcile the Pages project and D1 database, tag both, and apply migrations. Use `DRY_RUN=yes` for read-only target verification. |
| `make deploy ENV=prod` | Deploy the private Worker, verify its public routes are off, then deploy the Pages ingress. Use `DRY_RUN=yes` for target verification and packaging. |
| `make seed ENV=prod` / `make seed-update ENV=prod` | Initialize a demo fixture or preview a fixture update. Updates require `APPLY=yes` and target confirmation. |
| `make smoke-prod ENV=prod` | Check ordinary login, permissions, and comparison with dedicated test accounts, remove any smoke records, and sign out. |
| `make suspend ENV=prod` / `make resume ENV=prod` | Close or reopen the site and API while retaining D1. |
| `make snapshot ENV=prod SNAPSHOT=<private path>` | After suspension and draining in-flight writes, export portable data and compatibility metadata. |
| `make restore ENV=prod SNAPSHOT=<private path>` | Import into a separately named, fresh D1 target. Validate records before resume. |
| `make destroy ENV=prod` | Confirm the exact account, Pages project, Worker, D1 UUID, and data retention choice. Independent backups stay outside the target. |

The workflow uses the Cloudflare Resource Tagging API for Pages, Worker, and D1 metadata. Values come from the resolved configuration. Defaults are `project-name=blockfit-nyc`, `environment=prod`, `managed-by=script`, `service-part=infra`, and `funding=personal`. Tags help inventory resources. Track usage for the named Worker and D1 database alongside billing and shared account limits. Native Worker logging records compact errors with correlation IDs. Routine invocation logs and tracing are disabled. [Resource tagging](https://developers.cloudflare.com/resource-tagging/) · [Logging pricing](https://developers.cloudflare.com/observability/pricing/)

Local auth uses Better Auth's native scrypt parameters. Median native scrypt verification was about 37 ms of Node process CPU on the development machine. Median staff sign-in took about 39 ms wall time through local Workerd and D1. The Cloudflare Free Worker allowance is 10 ms CPU per request, so validate actual Workers CPU for sign-up, login and password change during authorized production testing. Deployment and live Cloudflare verification are pending for 0.0.3. [Workers CPU limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)

## Optional AI and portable data

The City workspace can request a cached OpenAI explanation of numeric aggregates. No individual locations or identities are sent. It uses `gpt-5.4-mini` by default, standard service tier, capped input and generated tokens, and `store:false`. Provider retention rules still apply. AI defaults to disabled in deployment configuration and the database ledger. Comparison and export work independently.

Set a separately authorized total budget, conservative standard-tier input and output pricing, a dedicated API key, and `AI_ENABLED=true` only for approved use. Budget and prices in the examples use microdollars, with prices per million tokens. The server counts input tokens, reserves the maximum call cost and a UTC daily slot atomically in D1, and reconciles known usage. The limit is 150 dispatches per UTC day. A failed request with unknown usage retains its reservation. The server has no automatic generation retries. Use mocked tests for local verification. [OpenAI model](https://developers.openai.com/api/docs/models/gpt-5.4-mini) · [Token counting](https://developers.openai.com/api/docs/guides/token-counting) · [Data controls](https://developers.openai.com/api/docs/guides/your-data)

See the [operations guide](doc/operations.md) for snapshot protection, fresh restoration, smoke credentials, and how to bring forward AI spending across deployments. `AGENTS.md` contains working conventions. `doc/intakes/` contains initial blueprints, process diagrams and wireframes. The [0.0.2 request](doc/requests/2026-11-18-0.0.2-staff-workspace-and-demo-data.md) records this update’s acceptance criteria.

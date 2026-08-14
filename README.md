# Program Cue

Program Cue is a pre-release conference programme operations platform. It is one React Router/TypeScript modular monolith on Cloudflare Workers, with D1 for relational state, R2 for private files, Queues for provider work and an event-scoped Durable Object for realtime invalidation.

The repository contains connected server-backed slices for event setup, submissions, evaluation and decisions, automatic speaker onboarding, resources/files, FullCalendar scheduling and publication, communications/calendars, Airtable and Accelevents integrations, operations, a permissioned AI assistant and a documented 33-path REST/webhook API. Published forms, resources, schedule content and communication templates keep immutable version snapshots; retryable provider work is recorded durably and claimed idempotently. Remaining boundaries are deployment of each new release candidate, unexercised live-provider paths and independent acceptance evidence rather than simulated success; see [implementation status](docs/IMPLEMENTATION_STATUS.md).

## Local development

Requirements: Node.js 22.18+ on the Node 22 line, or Node.js 24.11+, Python 3.9+ for migration validation, Chromium for the primary browser suite, and Playwright Firefox/WebKit for the full cross-browser smoke gate.

```bash
IBM_TELEMETRY_DISABLED=true npm install
cp .dev.vars.example .dev.vars
node -e "const { randomBytes } = require('node:crypto'); console.log('BETTER_AUTH_SECRET=' + randomBytes(48).toString('base64url')); console.log('ANONYMOUS_ITINERARY_SECRET=' + randomBytes(48).toString('base64url'))"
# Paste both independently generated values into .dev.vars.
npm run dev
```

The install command disables optional IBM Carbon package telemetry inherited through form-js.

The ignored `.dev.vars` file contains secrets and optional remote-provider
credentials only; runtime mode, URLs and local binding names stay canonical in
`wrangler.development.jsonc`. Local development selects Mailpit explicitly and
never sends through Resend. The app starts without Mailpit, but an action that
actually sends email fails honestly until the pinned capture service is running:

```bash
docker compose -f compose.mailpit.yaml up -d
```

Inspect captured messages and calendar attachments at `http://127.0.0.1:8025`.
There is no Resend fallback or simulated delivery. Demo/E2E verification codes
are shown as an explicit no-send fixture, and the E2E server creates a private,
ephemeral auth signing value rather than using a checked-in credential.

The development command applies the baseline migration to Wrangler's local D1
emulator and starts the application at `http://127.0.0.1:5173`. D1, R2, Queues
and Durable Objects are local. Backup Workflow bindings and the daily backup
cron exist only in production because D1 export requires remote Cloudflare
authority. Direct multipart upload, malware scanning, connected calendars,
external integrations and non-Workers-AI providers remain unavailable locally
until their optional `.dev.vars` credentials are supplied; they fail fast when
selected. Local demo cookies and mutation routes exist only in the explicit
development and demo profiles. Production evaluation uses the separately
access-code-gated fixed fixture described below and never enables `/demo`.

Useful routes:

- Evaluator guide and complete demo reset: `http://127.0.0.1:5173/demo`
- Command Centre: `http://127.0.0.1:5173/admin/command`
- Event Setup: `http://127.0.0.1:5173/admin/event`
- New blank event: `http://127.0.0.1:5173/admin/events/new`
- Submissions and forms: `http://127.0.0.1:5173/admin/submissions`
- Review administration: `http://127.0.0.1:5173/admin/review`
- Schedule: `http://127.0.0.1:5173/admin/schedule`
- Communications: `http://127.0.0.1:5173/admin/communications`
- Participant workspace: `http://127.0.0.1:5173/participant/dashboard`
- Public programme: `http://127.0.0.1:5173/public/programme/future-of-events-2027`
- Public speakers: `http://127.0.0.1:5173/public/programme/future-of-events-2027/speakers`
- Public agenda: `http://127.0.0.1:5173/public/programme/future-of-events-2027/agenda`
- Public schedule itinerary: `http://127.0.0.1:5173/public/programme/future-of-events-2027/schedule`
- Public Speaker Gallery: `http://127.0.0.1:5173/public/programme/future-of-events-2027/gallery`
- Public application: `http://127.0.0.1:5173/apply/form`
- API reference: `http://127.0.0.1:5173/api/docs`
- Design system: `http://127.0.0.1:5173/design/system`

The demo guide is public and task-oriented. A browser without a selected demo
identity remains anonymous on private routes. Its populated Jordan Lee and
Priya Shah journeys preserve useful filled-state review and speaker
walkthroughs, while exact SBEK personas Jordan Alvarez, Priya Raman, Marcus
Okafor and Sam Whitfield begin clean for evaluator-created cross-role state.
See [the SBEK evaluation runbook](docs/SBEK_EVALUATION.md) for the isolated
local harness workflow.

Event slugs are globally unique. Public programme and calendar-session links always include the event slug.

## Validation

```bash
npm run check
```

This runs configuration contracts, TypeScript and React Router type generation, fast Node rule tests, isolated workerd/D1/R2/Agent integration tests, one production build, migration/recovery/OpenAPI validation, and Playwright behavior/accessibility/visual coverage against freshly migrated local production Workers in desktop, focused 1280 × 720 laptop and mobile Chromium plus Firefox/WebKit smoke coverage. Independent core lanes run concurrently after type generation. The browser gate builds once, then distributes the unchanged suite across five isolated Worker/D1 shards and prints timing summaries for both phases.

The shards reserve five consecutive ports beginning at `5173`; their inspector ports are derived from the same base. When another worktree owns that range, choose another base, for example `PROGRAM_CUE_E2E_PORT=5180 npm run check`. Set `PROGRAM_CUE_E2E_SHARDS=1` to diagnose the complete suite serially, or use `npm run test:e2e:serial -- e2e/example.spec.ts` for a focused Playwright invocation. Successful local runs leave tracing off to avoid recording and discarding every browser interaction; set `PROGRAM_CUE_E2E_TRACE=1` when a diagnostic trace is worth the additional I/O. CI retains traces on failure.

Use the smaller commands while developing:

```bash
npm run check:focused
npm run check:core
npm run check:quick
npm run typecheck
npm test
npm run test:unit
npm run test:worker
npm run test:worker:runtime -- app/modules/example/example.test.ts
npm run test:changed
npm run test:related -- app/modules/example/example.server.ts
npm run test:config
npm run build
npm run test:e2e
npm run performance:local
```

`check:focused` uses the existing generated types and runs tests affected by
changes since the local `main` branch, including staged and unstaged changes.
Use `typecheck` instead when route types, Worker bindings or generated types
may have changed. `test:changed` selects tests from the Node, Workerd and Agents
projects using Vitest's changed-file graph;
`test:related` accepts one or more source paths explicitly. The
`test:worker:runtime` command makes a single Workerd file genuinely focusable
without also starting the separate Agents Durable Object project.

`check:quick` runs the complete core gate plus sharded desktop Chromium
behavior, excluding the representative visual inventory and cross-browser
smoke. It is an integration aid, not an ordinary completion gate. `test:unit`
runs deterministic Node-compatible rules without starting Workerd or applying
D1 migrations. `test:worker` runs the service, route and provider-boundary
suites against the Cloudflare runtime, followed by the Agents Durable Object
project.
`npm test` runs both projects; focused commands do not replace the complete
merge or release gate.

## Production configuration

The checked-in production profile targets `https://app.programcue.com` and is
wired to the provisioned D1 database, private R2 buckets, Queues and Turnstile
widget. `npm run deploy:check` passes for both the application and its dedicated
file-scanner companion. The application and scanner are deployed; required
runtime secrets remain outside Git and every release preflight verifies their
presence before upload. Exact accepted versions and remaining external
boundaries are recorded in [implementation status](docs/IMPLEMENTATION_STATUS.md).
A repository release candidate is not deployed evidence until its revision is
stamped, its migrations are applied and the ordinary preflight/deploy path
succeeds.

For headless Wrangler access in this workspace, keep the temporary deployment
token and account ID only in the ignored, mode-0600 `.env.cloudflare` file and
source that file explicitly before Wrangler commands. Do not put deployment
credentials in the root `.env`; Vite treats that file as application runtime
input during builds.

The production resource inventory is:

- WNAM D1 database `program-cue-db-wnam`
  (`ac812720-eefc-45d0-b6cf-0236ab8de8c8`). The former EEUR database is
  retained temporarily as a rollback source and is not a deployment target.
- Private R2 buckets `program-cue-files` and `program-cue-d1-backups`, plus R2
  S3 API credentials scoped to the files bucket.
- Queue `program-cue-operations` and dead-letter queue
  `program-cue-operations-dlq`.
- Durable Object classes `EventChannel` and `ProgramCueEventAgent`, Workers AI
  binding `AI`, and Workflow `program-cue-d1-backup`; Wrangler creates these
  from the checked-in bindings and migrations.
- File-scanner Worker `program-cue-file-scanner`, Workflow
  `program-cue-file-scans` and a four-slot EU-pinned pool of `standard-2`
  Cloudflare Containers running the pinned ClamAV 1.4 LTS image. Each container
  refreshes signatures before becoming healthy and scales to zero after fifteen
  idle minutes.
- A Resend sending domain and webhook, the provisioned Turnstile widget, and
  matching application/scanner credentials.
- Google and Microsoft OAuth applications for participant sign-in and calendar
  connections. Airtable and Accelevents credentials are entered per integration
  after deployment and encrypted with `INTEGRATION_CREDENTIALS_KEY`.

Provider setup for this production hostname uses these exact endpoints:

- Resend sender `Program Cue <auth@programcue.com>` and webhook
  `https://app.programcue.com/api/webhooks/resend`.
- Google redirect URIs `https://app.programcue.com/api/auth/callback/google`
  and `https://app.programcue.com/oauth/calendar/callback`.
- Microsoft redirect URIs
  `https://app.programcue.com/api/auth/callback/microsoft` and
  `https://app.programcue.com/oauth/calendar/callback`.
- File-scanner endpoint `https://scanner.programcue.com/v1/scans` and callback
  `https://app.programcue.com/api/webhooks/file-scanner`.
- R2 S3 Object Read & Write credentials scoped only to
  `program-cue-files`, and a separate durable D1 token scoped to the production
  database for scheduled logical exports. Do not reuse the temporary deployment
  token for either runtime credential.

Install the complete runtime secret inventory during initial provisioning and
update an individual secret only when it is deliberately rotated:

```bash
wrangler secret put BETTER_AUTH_SECRET
wrangler secret put ANONYMOUS_ITINERARY_SECRET
wrangler secret put RESEND_API_KEY
wrangler secret put RESEND_WEBHOOK_SECRET
wrangler secret put CALENDAR_CREDENTIALS_KEY
wrangler secret put GOOGLE_CALENDAR_CLIENT_ID
wrangler secret put GOOGLE_CALENDAR_CLIENT_SECRET
wrangler secret put MICROSOFT_CALENDAR_CLIENT_ID
wrangler secret put MICROSOFT_CALENDAR_CLIENT_SECRET
wrangler secret put GOOGLE_AUTH_CLIENT_ID
wrangler secret put GOOGLE_AUTH_CLIENT_SECRET
wrangler secret put MICROSOFT_AUTH_CLIENT_ID
wrangler secret put MICROSOFT_AUTH_CLIENT_SECRET
wrangler secret put INTEGRATION_CREDENTIALS_KEY
wrangler secret put WEBHOOK_CREDENTIALS_KEY
wrangler secret put TURNSTILE_SECRET_KEY
wrangler secret put FILE_SCANNER_API_TOKEN
wrangler secret put FILE_SCANNER_WEBHOOK_SECRET
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put D1_REST_API_TOKEN
wrangler secret put EVALUATION_ACCESS_CODE
wrangler secret put EVALUATION_SESSION_SECRET
```

Before each release, set `SOURCE_REVISION` to that candidate's 7-64 character
hexadecimal Git revision and verify the production URLs, sender and origin
allowlists in both Wrangler profiles. `RESOURCE_EMBED_ORIGINS` is a
comma-separated list of exact HTTPS origins; the current explicit value `none`
rejects every external resource embed. Apply migrations before deploying the
same stamped revision:

```bash
npm run db:migrate:remote
npm run deploy
```

The scanner is deployed separately with `npm run deploy:scanner`; the production
Worker, Workflow, Container application and `scanner.programcue.com` Custom
Domain were provisioned on 11 August 2026. Its temporary
deployment token requires account-level Workers Scripts Write and Containers
Edit plus the existing `programcue.com` Worker-route authority. Configure
`SCANNER_API_TOKEN` on the scanner with the exact value used for the
application's `FILE_SCANNER_API_TOKEN`; likewise, configure
`PROGRAM_CUE_CALLBACK_SECRET` with the application's
`FILE_SCANNER_WEBHOOK_SECRET`. Both pairs are independently random values of at
least 32 characters. The scanner endpoint persists an idempotent Workflow before
returning `202`, validates that the signed object URL belongs to the private
files bucket, and returns only an HMAC-signed verdict. A failed, expired or
ambiguous scan leaves the file quarantined.

The public website is deployed separately with `npm run deploy:site`. It is a
static-asset Worker in `site/` with no D1, R2, Queue, Durable Object or AI
binding: it publishes the home page, `/privacy` and `/terms` that Google's OAuth
verification reviewers must be able to read anonymously, so it deliberately
shares no authorisation or readiness path with the application. Deployment
requires the `programcue.com` and `www.programcue.com` Custom Domains to be
attached to `program-cue-site`; `www` answers a 301 to the apex host.
Plain-HTTP requests to either production hostname are also upgraded to the
secure apex URL.
`npm run deploy:site` runs `scripts/validate-site-config.mjs` first, which fails
the deploy on a lost Custom Domain, a data binding, a `noindex`, a broken
internal link or anchor, placeholder copy, a missing contact address, or a
privacy policy that no longer carries the declared Google scopes and the Limited
Use statement. Preview it locally with `npm run dev:site`; run its focused
desktop/mobile accessibility, containment and visual coverage with
`npm run test:site:e2e`. That suite uses port `8788` by default; set
`PROGRAM_CUE_SITE_E2E_PORT` when it is occupied. During `npm run check`, an
overridden `PROGRAM_CUE_E2E_PORT` automatically gives the site an isolated port
1,000 higher unless the site-specific value is set.
The production bootstrap is intentionally one-time and requires an empty,
migrated application database. It atomically creates the first Better Auth
person, organisation-wide owner membership and explicitly slugged initial event;
it does not install a permanent bootstrap endpoint. Ordinary email, Google and
Microsoft identity creation remains available after bootstrap, but signup alone
creates no organisation, event, membership or participant access. After
deployment, the bootstrap owner requests their first magic link at `/sign-in`.
Production is already bootstrapped; do not run this command there again. For a
new empty production database only, run it once after migrations:

```bash
npm run db:bootstrap:production -- \
  --owner-email owner@your-domain.example \
  --owner-name "Owner Name" \
  --organisation-name "Organisation Name" \
  --organisation-slug organisation-name \
  --event-name "Event Name" \
  --event-slug event-name \
  --timezone America/Toronto \
  --start-date 2027-05-20 \
  --end-date 2027-05-22 \
  --yes
```

`BETTER_AUTH_SECRET` and `ANONYMOUS_ITINERARY_SECRET` must contain at least
32 characters and must be independently generated. Missing, short or reused
values fail production readiness; anonymous itineraries never fall back to the
authentication secret.
The initial dedicated-secret release moves anonymous cookies and stored hashes
to `v2`; migration `0018` removes only legacy unversioned anonymous rows, while
signed-in and newly created `v2` itineraries remain intact.
Rotating `ANONYMOUS_ITINERARY_SECRET` is an intentional destructive reset while
the product is pre-release: existing anonymous cookies stop verifying and their
event-scoped database rows can no longer be found. Signed-in itineraries are
unaffected. Coordinate any required rotation with removal of the unreachable
anonymous rows; do not retain a previous-key compatibility fallback.
`CALENDAR_CREDENTIALS_KEY`, `INTEGRATION_CREDENTIALS_KEY` and
`WEBHOOK_CREDENTIALS_KEY` must each be an independently generated,
base64-encoded 32-byte AES-GCM key. Workers AI is the provisioned default;
`OPENAI_API_KEY` or `ANTHROPIC_API_KEY` is an additional Cloudflare secret only
when that provider is deliberately selected. `npm run deploy:secrets` queries
the configured Worker and fails if the complete required secret inventory is
missing. Production fixes `EMAIL_PROVIDER=resend`; runtime validation rejects
Mailpit and never falls back to local capture, demo identity, stale data or
simulated provider success.

`npm run deploy` runs configuration and remote secret preflights before build or
deployment. The application and scanner are live; deployment alone does not
prove a new migration, evaluator reset or external-provider outcome. Record
those separately as acceptance evidence.

### Production evaluation fixture

The final SBEK run uses the ordinary production deployment and provider paths
with `APP_ENV=production`, `DEMO_MODE=false` and the explicit
`EVALUATION_MODE=true` gate. Reviewers unlock `/evaluate` with a separately
configured access code, then select only fixed fixture identities. The signed
session is bound to the latest reset generation, restricted to the dedicated
fixture organisation and never falls through to an unrelated ordinary login.
Only the clean-applicant card has an explicit audited membership activation;
ordinary persona selection grants no membership and no provider success is
simulated.

The separately authenticated reset owns only the dedicated evaluation
organisation. It restores the canonical event, retires evaluator-created
events, clears their private R2 data, removes only safe fixture-created people
and fails on active work, retention, identity drift or cross-tenant state. The
temporary reset credentials and evaluator address bindings are removed after
seeding. After initial provisioning, the unlocked guide offers a typed,
rate-limited routine reset that reuses only the persisted fixture identities and
verified sender; it invalidates all saved evaluator sessions. The permanent
evaluation access and signing secrets remain installed only for the evaluation
period.

Secret installation, mode-`0600` environment handling, reset and cleanup
commands, exact personas and aliases, bounded evaluation exceptions, Codex/SBEK
setup and remaining external evidence are maintained in the
[SBEK evaluation runbook](docs/SBEK_EVALUATION.md). Follow that runbook for
every production evaluation; do not reconstruct the procedure from this
overview.

Backup and point-in-time recovery procedures are in
[docs/RECOVERY.md](docs/RECOVERY.md). The deployed daily D1-export Workflow has
one API-triggered production completion and exact-R2 restore acceptance; the
next autonomous post-fix cron remains outstanding. `npm run recovery:drill`
exercises a clean-room logical export and restore without touching development
or production data.

The repeatable local browser-budget method, isolated 10,000-record fixture and latest measurements are in [docs/PERFORMANCE.md](docs/PERFORMANCE.md). These local results do not replace deployed p75/RUM and production-like scale acceptance.

## Repository map

```text
app/routes/                 React Router pages and resource/API routes
app/modules/                Vertical-slice rules and D1/R2/provider services
app/platform/               Auth, database, API, operations and realtime infrastructure
workers/index.ts            Single Worker entry and React Router request handler
workers/communications-queue.ts
                            Email, notifications, calendars, integrations and webhook consumers
workers/event-channel.ts    Event-scoped Durable Object invalidation channel
workers/d1-backup-workflow.ts
                            Scheduled logical D1 export to private backup R2
scanner/                    Authenticated Workflow + ClamAV Container companion
site/                       Public website Worker for programcue.com (static, no data bindings)
migrations/                 Pre-release D1 baseline schema and constraints
public/styles.css           Program Cue design tokens and component styles
e2e/                        Browser behavior, accessibility and visual tests
docs/                       Decisions, security, design system, API and verified status
```

The canonical product scope is [the full implementation specification](sessionboard-replacement-full-scope-implementation-specification-with-competition-ux.md). The competition build also includes Speaker Network, a deliberately bounded extra-credit surface for cross-event speaker relationships and sourcing. General-purpose CRM, broad marketing automation, payments, multilingual expansion and a general-purpose CMS remain excluded.

## License

Copyright © 2026 Program Cue contributors. Program Cue is free software
licensed under the [GNU Affero General Public License version 3](LICENSE) only
(`AGPL-3.0-only`). The canonical source repository is
[GitHub](https://github.com/DeanStr/programcue).

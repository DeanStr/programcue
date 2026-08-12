# Program Cue

Program Cue is a pre-release conference programme operations platform. It is one React Router/TypeScript modular monolith on Cloudflare Workers, with D1 for relational state, R2 for private files, Queues for provider work and an event-scoped Durable Object for realtime invalidation.

The repository contains connected server-backed slices for event setup, submissions, evaluation and decisions, automatic speaker onboarding, resources/files, FullCalendar scheduling and publication, communications/calendars, Airtable and Accelevents integrations, operations, a permissioned AI assistant and a documented 32-path REST/webhook API. Published forms, resources, schedule content and communication templates keep immutable version snapshots; retryable provider work is recorded durably and claimed idempotently. The remaining boundaries are deployment, live-provider and independent acceptance evidence rather than simulated success; see [implementation status](docs/IMPLEMENTATION_STATUS.md).

## Local development

Requirements: Node.js 22.18+ on the Node 22 line, or Node.js 24.11+, Python 3.9+ for migration validation, Chromium for the primary browser suite, and Playwright Firefox/WebKit for the full cross-browser smoke gate.

```bash
IBM_TELEMETRY_DISABLED=true npm install
cp .dev.vars.example .dev.vars
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
# Paste the generated value into BETTER_AUTH_SECRET in .dev.vars.
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
selected. Demo identities and seed data exist only in the explicit development
and demo profiles.

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
- Public programme: `http://127.0.0.1:5173/public/programme/future-of-events-2025`
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
npm run check:core
npm run check:quick
npm run typecheck
npm test
npm run test:unit
npm run test:worker
npm run test:config
npm run build
npm run test:e2e
npm run performance:local
```

`check:quick` runs the complete core gate plus sharded desktop Chromium behavior, excluding the full visual inventory and cross-browser smoke. It is an iteration aid, not a release or user-facing completion gate. `test:unit` runs deterministic Node-compatible rules without starting Workerd or applying D1 migrations. `test:worker` runs the service, route and provider-boundary suites against the Cloudflare runtime. `npm test` runs both projects; no focused or quick command replaces the complete validation gate.

## Production configuration

The checked-in production profile targets `https://app.programcue.com` and is
wired to the provisioned D1 database, private R2 buckets, Queues and Turnstile
widget. `npm run deploy:check` passes for both the application and its dedicated
file-scanner companion. The application remains intentionally non-deployable
until the complete runtime secret inventory and production bootstrap values are
supplied.

For headless Wrangler access in this workspace, keep the temporary deployment
token and account ID only in the ignored, mode-0600 `.env.cloudflare` file and
source that file explicitly before Wrangler commands. Do not put deployment
credentials in the root `.env`; Vite treats that file as application runtime
input during builds.

The production resource inventory is:

- D1 database `program-cue-db` and its UUID.
- Private R2 buckets `program-cue-files` and `program-cue-d1-backups`, plus R2
  S3 API credentials scoped to the files bucket.
- Queue `program-cue-operations` and dead-letter queue
  `program-cue-operations-dlq`.
- Durable Object classes `EventChannel` and `ProgramCueEventAgent`, Workers AI
  binding `AI`, and Workflow `program-cue-d1-backup`; Wrangler creates these
  from the checked-in bindings and migrations.
- File-scanner Worker `program-cue-file-scanner`, Workflow
  `program-cue-file-scans` and one EU-pinned `standard-2` Cloudflare Container
  running the pinned ClamAV 1.4 LTS image. The container refreshes signatures
  before becoming healthy and scales to zero after two idle minutes.
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

Before each release, set `SOURCE_REVISION` to the deployed 7-64 character
hexadecimal Git revision and verify the production URLs, sender and origin
allowlists in both Wrangler profiles. `RESOURCE_EMBED_ORIGINS` is a
comma-separated list of exact HTTPS origins; the current explicit value `none`
rejects every external resource embed. Configure the complete release secret
inventory:

```bash
wrangler secret put BETTER_AUTH_SECRET
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

npm run db:migrate:remote
npm run db:bootstrap:production -- \\
  --owner-email owner@your-domain.example \\
  --owner-name "Owner Name" \\
  --organisation-name "Organisation Name" \\
  --organisation-slug organisation-name \\
  --event-name "Event Name" \\
  --event-slug event-name \\
  --timezone America/Toronto \\
  --start-date 2027-05-20 \\
  --end-date 2027-05-22 \\
  --yes
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

The production bootstrap is intentionally one-time and requires an empty,
migrated application database. It atomically creates the first Better Auth
person, organisation-wide owner membership and explicitly slugged initial event; it
does not enable public sign-up or install a permanent bootstrap endpoint. After
deployment, that owner requests their first magic link at `/sign-in`.

`BETTER_AUTH_SECRET` must contain at least 32 characters.
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
deployment. The scanner boundary is live, but a complete deployed application
environment has not been verified from this workspace.

Backup and point-in-time recovery procedures are in [docs/RECOVERY.md](docs/RECOVERY.md). Production configuration includes a fail-closed daily D1-export Workflow to a separate private R2 bucket; it is not evidence that a live backup has run. `npm run recovery:drill` exercises a clean-room logical export and restore without touching development or production data.

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
migrations/                 Pre-release D1 baseline schema and constraints
public/styles.css           Program Cue design tokens and component styles
e2e/                        Browser behavior, accessibility and visual tests
docs/                       Decisions, security, design system, API and verified status
```

The canonical product scope is [the full implementation specification](sessionboard-replacement-full-scope-implementation-specification-with-competition-ux.md). The competition build also includes Speaker Network, a deliberately bounded extra-credit surface for cross-event speaker relationships and sourcing. General-purpose CRM, broad marketing automation, payments, multilingual expansion and a general-purpose CMS remain excluded.

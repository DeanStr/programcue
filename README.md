# Program Cue

Program Cue is a pre-release conference programme operations platform. It is one React Router/TypeScript modular monolith on Cloudflare Workers, with D1 for relational state, R2 for private files, Queues for provider work and an event-scoped Durable Object for realtime invalidation.

The repository contains server-backed slices for event setup, submissions, evaluation and decisions, speaker workspaces, resources, schedule publication, the public programme, communications, operations and scoped REST APIs. Published forms, resource pages and communication templates keep version-scoped content and metadata; retryable provider work is recorded durably and claimed idempotently. It is not feature-complete against the full product specification. Provider and speaker-identity onboarding, automatic reminders, malware-scanner integration, abuse controls, Airtable/Accelevents, AI and several competition UX requirements remain; see [implementation status](docs/IMPLEMENTATION_STATUS.md).

## Local development

Requirements: Node.js 22+, Python 3.9+ for migration validation and Chromium for browser tests.

```bash
npm install
npm run dev
```

The development command applies the baseline migration to the local Wrangler D1 database and starts the application at `http://127.0.0.1:5173`. Demo identities and seed data are enabled only by `wrangler.demo.jsonc`.

Useful routes:

- Command Centre: `http://127.0.0.1:5173/admin/command`
- Event Setup: `http://127.0.0.1:5173/admin/event`
- Submissions and forms: `http://127.0.0.1:5173/admin/submissions`
- Review administration: `http://127.0.0.1:5173/admin/review`
- Schedule: `http://127.0.0.1:5173/admin/schedule`
- Communications: `http://127.0.0.1:5173/admin/communications`
- Speaker portal: `http://127.0.0.1:5173/speaker/dashboard`
- Public programme: `http://127.0.0.1:5173/public/programme/future-of-events-2025`
- Public application: `http://127.0.0.1:5173/apply/form`
- API reference: `http://127.0.0.1:5173/api/docs`
- Design system: `http://127.0.0.1:5173/design/system`

Event slugs are globally unique. Canonical public programme and calendar-session links include the event slug; the unscoped `/public/programme` route is only an environment-configured convenience alias.

## Validation

```bash
npm run check
```

This runs TypeScript and React Router type generation, fast Node rule tests, isolated workerd/D1/R2 integration tests, one production build, migration and OpenAPI validation, and Playwright behavior/accessibility/visual coverage against a freshly built local production Worker in Chromium.

Use the smaller commands while developing:

```bash
npm run check:core
npm run typecheck
npm test
npm run test:unit
npm run test:worker
npm run build
npm run test:e2e
```

`test:unit` runs deterministic Node-compatible rules without starting Workerd or applying D1 migrations. `test:worker` runs the service, route and provider-boundary suites against the Cloudflare runtime. `npm test` runs both projects; neither focused command replaces the complete validation gate.

## Production configuration

Create the D1, private R2, Queue and Durable Object resources, replace placeholder resource IDs and example origins in `wrangler.jsonc`, then configure the secrets needed by the enabled workflows:

```bash
wrangler secret put BETTER_AUTH_SECRET
wrangler secret put RESEND_API_KEY
wrangler secret put RESEND_WEBHOOK_SECRET
wrangler secret put CALENDAR_CREDENTIALS_KEY

npm run db:migrate:remote
npm run db:bootstrap:production -- \\
  --owner-email owner@your-domain.example \\
  --owner-name "Owner Name" \\
  --organisation-name "Organisation Name" \\
  --organisation-slug organisation-name \\
  --event-name "Event Name" \\
  --timezone America/Toronto \\
  --start-date 2027-05-20 \\
  --end-date 2027-05-22 \\
  --yes
npm run deploy
```

The production bootstrap is intentionally one-time and requires an empty,
migrated application database. It atomically creates the first Better Auth
person, organisation-wide owner membership and configured default event; it
does not enable public sign-up or install a permanent bootstrap endpoint. After
deployment, that owner requests their first magic link at `/sign-in`.

`BETTER_AUTH_SECRET` must contain at least 32 characters. `CALENDAR_CREDENTIALS_KEY` is required only for encrypted Google or Microsoft calendar credentials and must be a base64-encoded 32-byte AES-GCM key. Missing auth, queue, realtime or provider configuration fails explicitly; production never falls back to demo identity or simulated delivery.

The checked-in production configuration still contains placeholder resource identifiers and example URLs. `npm run deploy` intentionally fails its configuration preflight until they are replaced. A deployed production environment has not been verified from this workspace.

## Repository map

```text
app/routes/                 React Router pages and resource/API routes
app/modules/                Vertical-slice rules and D1/R2/provider services
app/platform/               Auth, database, API, operations and realtime infrastructure
workers/index.ts            Single Worker entry and React Router request handler
workers/communications-queue.ts
                            Email, submission/decision-notification and calendar consumers
workers/event-channel.ts    Event-scoped Durable Object invalidation channel
migrations/                 Pre-release D1 baseline schema and constraints
public/styles.css           Program Cue design tokens and component styles
e2e/                        Browser behavior, accessibility and visual tests
docs/                       Decisions, security, design system, API and verified status
```

The canonical product scope is [the full implementation specification](sessionboard-replacement-full-scope-implementation-specification-with-competition-ux.md). The product deliberately excludes a general CRM, broad marketing automation, payments, multilingual expansion and a general-purpose CMS.

# Program Cue

Program Cue is an interactive conference programme operations evaluator and a production-oriented Cloudflare foundation. It demonstrates the workflow from call-for-speakers applications through review, speaker onboarding, communications, scheduling, readiness, integrations, publication and attendee itinerary.

The evaluator is broad, but the full production product is not yet complete. Most browser workflows persist to `localStorage`; the Worker currently implements public programme/calendar delivery, task list/create, schedule publication and idempotent operation-ingestion boundaries. See [the verified implementation audit](docs/IMPLEMENTATION_STATUS.md) for the exact boundary.

This repository deliberately combines two layers without introducing a second service or compatibility framework:

1. **A zero-install interactive evaluator application** in `public/`. It runs immediately with canonical seeded data and durable browser-local demo state, so evaluators do not need provider accounts or cloud credentials.
2. **A fail-closed Cloudflare production boundary** in `workers/`, with the relational D1 schema in `migrations/`, authenticated API routes, public programme and calendar endpoints, idempotent operation ingestion, security headers, CORS rules, and explicit resource bindings.

The evaluator application is not a slideshow. Form editing, category routing, multiple drafts, direct sessions, review scoring, decisions, speaker tasks and resources, local file metadata, schedule views and conflict resolution, communications validation, programme exports, integration dry runs, assistant approvals, surface switching, and local reset are interactive. These interactions should not be confused with credentialed provider execution or server-backed multi-user workflows.

## Run the interactive application

```bash
cd program-cue
npm run dev
```

Open:

- Administrator: `http://127.0.0.1:4173/#admin/command`
- Reviewer: `http://127.0.0.1:4173/#admin/review`
- Form Builder: `http://127.0.0.1:4173/#admin/submissions/form`
- Schedule Planner: `http://127.0.0.1:4173/#admin/schedule`
- Speaker portal: `http://127.0.0.1:4173/#speaker/dashboard`
- Speaker resources: `http://127.0.0.1:4173/#speaker/resources`
- Public programme: `http://127.0.0.1:4173/#public/programme`
- Public application: `http://127.0.0.1:4173/#apply/form`
- Design system: `http://127.0.0.1:4173/#design/system`

The demo stores changes in `localStorage`. Use **Reset demo** in the administrator sidebar to restore the canonical event state.

Rendered screenshots are included in `docs/screenshots/`, and the design reference board is in `docs/designs/`.

## Validate everything

```bash
npm run check
```

In an environment with Python Playwright and Chromium installed, the complete check covers:

- JavaScript syntax for the application, seed, local server, and Worker;
- **22 domain and Worker tests**;
- **18 rendered product routes plus the iframe embed route**;
- **34 D1 tables and 2 append-only audit triggers**;
- **25 static product invariants**;
- **16 HTTP and security smoke checks**;
- a Playwright/Chromium browser workflow across all major routes, including common-laptop overflow checks.

`npm run check:core` runs all checks except the Playwright browser workflow. The suite intentionally verifies that private production routes reject missing or incorrect credentials and fail closed when required Cloudflare bindings are absent.

## Cloudflare deployment

The production target is a modular monolith on Cloudflare Workers. The evaluator build has no runtime package-install requirement; the intended production dependency set is recorded in `docs/production-package.example.json`.

```bash
# Install official tooling when preparing the real deployment.
npm install -D wrangler

wrangler d1 create program-cue-db
wrangler r2 bucket create program-cue-files
wrangler queues create program-cue-operations
wrangler queues create program-cue-operations-dlq

npm run db:migrate:remote
npm run deploy
```

Set secrets instead of committing them:

```bash
wrangler secret put INTERNAL_API_TOKEN
wrangler secret put BETTER_AUTH_SECRET
wrangler secret put RESEND_API_KEY
wrangler secret put GOOGLE_CALENDAR_CLIENT_SECRET
wrangler secret put MICROSOFT_CALENDAR_CLIENT_SECRET
wrangler secret put AIRTABLE_TOKEN
wrangler secret put ACCELEVENTS_TOKEN
```

External delivery and sync actions never silently report success. The evaluator interface generates explicit dry-run previews; the production Worker fails closed until the corresponding provider credential and binding are configured.

## Repository map

```text
public/                 Interactive evaluator SPA, canonical seed data and design system
workers/app.js          Cloudflare Worker API, assets, embed handling and queue consumer
migrations/             D1 relational schema, constraints, indexes and audit triggers
src/domain/             Tested scoring, scheduling, readiness and communication rules
server.mjs              Local evaluator and API-smoke server
scripts/                Route, migration, static, screenshot and browser validation
tests/                  Domain, Worker and HTTP/security tests
docs/                   Decisions, screenshots, implementation status, stack and security
```

## Scope boundary

Program Cue is purpose-built for programme management. It does not become a general CRM, marketing-automation system, payment product, multilingual platform, or general-purpose CMS. Rich content is constrained to forms, operational messages, speaker resources, and public programme content.

# Program Cue

Program Cue is a pre-release conference programme operations platform. It is one React Router/TypeScript modular monolith on Cloudflare Workers, with D1 for relational state, R2 for private files, Cloudflare Images for brand-image normalization, Queues for provider work and an event-scoped Durable Object for realtime invalidation.

The repository contains connected server-backed slices for event setup, submissions, evaluation and decisions, automatic speaker onboarding, resources/files, FullCalendar scheduling and publication, a bounded public event-site editor, communications/calendars, Airtable and Accelevents integrations, operations, a permissioned AI assistant and a documented 33-path REST/webhook API. Published forms, event sites, resources, schedule content and communication templates keep immutable version snapshots; retryable provider work is recorded durably and claimed idempotently. Remaining boundaries are deployment of each new release candidate, unexercised live-provider paths and independent acceptance evidence rather than simulated success; see [implementation status](docs/IMPLEMENTATION_STATUS.md).

## Local development

Requirements: Node.js 24.11+, Python 3.9+ for migration validation, Chromium for the primary browser suite, and Playwright Firefox/WebKit for the full cross-browser smoke gate.

```bash
npm install
cp .dev.vars.example .dev.vars
node -e "const { randomBytes } = require('node:crypto'); console.log('BETTER_AUTH_SECRET=' + randomBytes(48).toString('base64url')); console.log('ANONYMOUS_ITINERARY_SECRET=' + randomBytes(48).toString('base64url'))"
# Paste both independently generated values into .dev.vars.
npm run dev
```

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

The development command applies pending migrations to Wrangler's local D1
emulator and starts the application at `http://127.0.0.1:5173`. D1, R2, Images,
Queues and Durable Objects are local. Backup Workflow bindings and the daily
backup cron exist only in production because D1 export requires remote
Cloudflare authority. Direct multipart upload, malware scanning, connected calendars,
external integrations and non-Workers-AI providers remain unavailable locally
until their optional `.dev.vars` credentials are supplied; they fail fast when
selected. For isolated upload/scanner testing without provider credentials, run
`npm run smoke:files` or the model-driven `npm run regression:files` from `evals/`.
`npm run regression:all` also checks publication and captured local mail in the
same isolated runtime. These commands require Docker; see the evaluation guide
for the real ClamAV smoke and local transport boundaries. Local demo cookies and mutation routes exist only in the explicit
development and demo profiles. Production evaluation uses the separately
access-code-gated fixed fixture in the evaluation runbook and never enables `/demo`.

Start at [the demo guide](http://127.0.0.1:5173/demo) to select an identity or
reset the fixture. Without a selected identity, private routes remain anonymous.
The populated showcase journeys and clean SBEK personas are described in the
[evaluation guide](evals/README.md).

Other entry points:

- [Command Centre](http://127.0.0.1:5173/admin/command)
- [Participant workspace](http://127.0.0.1:5173/participant/dashboard)
- [Public programme](http://127.0.0.1:5173/public/programme/future-of-events-2027)
- [API reference](http://127.0.0.1:5173/api/docs)
- [Design system](http://127.0.0.1:5173/design/system)

## Validation

Follow [AGENTS.md](AGENTS.md) for the required scope of validation.

| Command | Use |
| --- | --- |
| `npm run check:focused` | Biome, existing generated TypeScript types and tests affected by changes since local `main`, including staged and unstaged edits. |
| `npm run typecheck` | Regenerate Worker/route types and typecheck when bindings or generated types change. |
| `npm run test:related -- app/modules/example/example.server.ts` | Tests related to a specific source file. |
| `npm run test:worker:runtime -- app/modules/example/example.test.ts` | One focused Workerd test file. |
| `npm run test:e2e:serial -- e2e/example.spec.ts` | Build and run a focused browser workflow. |
| `npm run check:core` | Cross-cutting changes: quality, types, runtime tests, build and configuration/schema/recovery/API contracts. |
| `npm run check` | Complete merge/release gate, including dependency audit, Chromium behavior/visual/accessibility coverage and Firefox/WebKit smoke tests. |

See [package.json](package.json) for all commands. `npm run quality` checks
formatting and lint; `npm run quality:fix` applies safe fixes. `npm run format`
**writes** formatted files. `check:quick` omits visual inventory, cross-browser
smoke and the production-shaped evaluation browser regression; it does not
replace the complete release gate.

The full browser gate uses five isolated Worker/D1 shards, reserving consecutive
ports from `5173`. Override with `PROGRAM_CUE_E2E_PORT=5180 npm run check` when
another worktree owns that range. `PROGRAM_CUE_E2E_SHARDS=1` selects serial
execution; `PROGRAM_CUE_E2E_TRACE=1` enables local diagnostic traces. CI retains
traces on failure. Public-site tests use port `8788`, overridable through
`PROGRAM_CUE_SITE_E2E_PORT`; the full gate derives an isolated site port from an
overridden application port unless the site-specific value is set.

## Deployment and documentation

`npm run deploy` runs the complete gate, preflights the clean checkout and
remote state, applies migrations, deploys the same tested build with the Git
revision and checks production health. Do not manually stamp `SOURCE_REVISION`
or apply migrations before this entry point. Follow the deployment runbook for
credentials, provisioning and the separate scanner/site releases.

| Document | Purpose |
| --- | --- |
| [Product specification](sessionboard-replacement-full-scope-implementation-specification-with-competition-ux.md) | Canonical scope and acceptance requirements. |
| [Implementation status](docs/IMPLEMENTATION_STATUS.md) | Verified source, test and deployment evidence, requirements traceability and remaining acceptance work. |
| [Decisions](docs/DECISIONS.md) | Durable product and engineering choices and their rationale. |
| [Deployment](docs/DEPLOYMENT.md) | Provisioning, application/scanner/site releases and credential rotation. |
| [Recovery](docs/RECOVERY.md) | Backup operation and incident restore procedures. |
| [Performance](docs/PERFORMANCE.md) | Repeatable local measurement method and interpretation. |
| [Application evaluations](evals/README.md) | AEK setup, isolated local smokes, upstream scoring policy and acceptance boundaries. |
| [User guide source](site/public/guide.html) | Published role-based product help; maintained separately from engineering docs. |
| [OpenAPI source](docs/openapi.yaml) | API contract; `npm run openapi:sync` updates the generated public JSON. |
| [Film production notes](video/README.md) | Preview, render, validate and publish the six-minute Remotion film. |

## Repository map

```text
app/routes/       React Router pages and resource/API routes
app/modules/      Domain rules and D1/R2/provider services
app/platform/     Auth, database, API, operations and realtime infrastructure
workers/          Application entry, Queue consumers, Durable Objects and backup Workflow
scanner/          Workflow and ClamAV Container companion
site/             Public website Worker and user guide
migrations/       Immutable deployed baseline and numbered forward migrations
app/styles/       Design tokens and bundled component styles
e2e/              Browser behavior, accessibility and visual tests
video/            Remotion film and its production assets
```

## License

Copyright © 2026 Program Cue contributors. Program Cue is free software
licensed under the [GNU Affero General Public License version 3](LICENSE) only
(`AGPL-3.0-only`). The canonical source repository is
[GitHub](https://github.com/DeanStr/programcue).

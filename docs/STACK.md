# Technology stack

## Runtime and application

- **TypeScript 5.9, React 19 and React Router 8 framework mode** provide SSR, path routes, route loaders/actions, resource routes and generated route types.
- **Vite 8 and the Cloudflare Vite plugin** run the same Worker application locally and build the production bundle.
- **Cloudflare Workers** are the single HTTP and Queue runtime. There is no legacy JavaScript Worker or second frontend path.
- **Cloudflare D1** is the transactional control plane and the domain-data authority unless an event explicitly selects Airtable. The baseline migration and Drizzle schema are validated together; services use tenant-scoped SQL and Better Auth uses the Drizzle adapter. Published forms, resources, schedule content/notes and communication templates keep their public metadata in immutable versions, not only on mutable parent rows.
- **Cloudflare R2** stores private file bytes under opaque event/target/version keys. Headless **Uppy core/AWS S3** uploads signed multipart parts directly to private R2, pauses and resumes against R2's server-listed parts, and uses a D1-authorized idempotent intent as the authority; completion validates the assembled object before scan dispatch and quarantine release.
- **Cloudflare Queues** execute communication, submission/decision notification, calendar, Accelevents and outbound-webhook operations after durable D1 intent is recorded. Bounded continuations, random-token leases, idempotency keys and compare-and-set completion protect retries and crash recovery. Unexpected messages are recorded as failed rather than simulated.
- **Cloudflare Durable Objects** provide event-scoped WebSocket invalidation and the private **Cloudflare Agents SDK** event assistant. D1 `event_changes` remains authoritative for UI freshness, with cursor polling at a maximum 30-second interval; assistant proposals and exact executions remain durable in D1.
- **Cloudflare Workflows** run the scheduled logical D1 export. The Workflow polls the D1 export API, streams the result to a separate private R2 bucket and records a checksum manifest; the production binding/cron is deliberately absent from local profiles.
- **Airtable** is an explicit per-event domain repository option. A managed typed schema, migration service, provider boundary, durable command/replay records and D1 control-plane projections cover the full programme workflow. Schema or credential failures stop the operation; there is no D1 domain-data fallback.

## Application libraries

- **Better Auth** provides D1-backed production sessions and five-minute hashed magic links. The shared email boundary selects Resend in production and Mailpit HTTP capture in the local demo/development profiles; neither provider falls back to the other.
- **Zod 4** validates route, API, domain and Queue inputs and registers schemas for deterministic OpenAPI generation.
- **bpmn-io form-js**, **React Hook Form** and Zod provide visual form authoring, strict schema adaptation and public runtime validation. Form-js is confined to a browser-only chunk; unsupported controls fail explicitly.
- **Radix Dialog**, **cmdk**, **react-hotkeys-hook**, **Lucide**, class-variance-authority, clsx and tailwind-merge support accessible application primitives and navigation.
- **TanStack Table 9** powers the server-paginated submissions operational grid: stable current-page selection, column visibility and density are client presentation state, while filtering, global newest-first order and pagination remain D1-backed URL state. **TanStack Virtual is not installed** because the real route renders at most 50 rows per server page; add it only after measurement identifies an unpaginated rendering bottleneck.
- **Sonner** supplies supplemental success/progress notifications and the task-completion undo shortcut. The inline status, form action and error remain in the document for accessible and no-JavaScript operation, and the notification expires at the server-issued undo boundary.
- **Tailwind CSS 4** supplies utilities alongside the established Program Cue CSS variables and component styles. `public/styles.css` remains the visual-token source of truth.
- **dnd-kit core** supplies pointer and keyboard schedule placement and movement.
- **FullCalendar React** supplies list, time-grid day and time-grid week planning. Pointer moves/resizes submit to the same schedule service as the keyboard/form alternatives.
- **Tiptap** supplies constrained resource-page authoring; server rendering allow-lists nodes, marks and HTTPS embeds.
- **React Email** renders previewed and queued email content. Optional email includes an HMAC-signed, expiring unsubscribe link with an explicit confirmation action; category preferences apply only to optional email, while event-wide provider complaint/suppression exclusions are rechecked for every email kind before delivery. Resend webhook events are stored idempotently and reduced by explicit precedence into a monotonic delivery status.
- **ical-generator** creates the public calendar feed with slug-bearing programme-session links; the calendar module separately creates stable-UID, sequence-serialized REQUEST/CANCEL invitations.
- **Scalar** renders the interactive OpenAPI reference from `public/openapi.json`.
- **Cloudflare Agents SDK** provides the private event assistant runtime. Program Cue's strict tool schemas and provider boundary support Workers AI, OpenAI Responses and Anthropic Messages without provider fallback.

Dependencies are added only for an active implementation. Uppy core/AWS S3 powers the current resumable upload transport without replacing Program Cue's interface. dnd-kit Sortable remains absent because the current schedule does not use it.

## Testing and contracts

- **Vitest projects** run deterministic Node-compatible rules without Worker startup, while the Cloudflare Workers project exercises service, route and provider boundaries against isolated workerd D1/R2 bindings.
- **Playwright** exercises the production-built Worker and assets, real routes, keyboard/focus behavior, responsive layouts and visual snapshots against a freshly reset, dedicated local Wrangler state directory. Chromium hosts the full behavior/visual/performance suites; Firefox and WebKit smoke projects cover the supported cross-browser boundary. **axe-core** supplies automated accessibility checks.
- **MSW** verifies outbound Resend, Mailpit, Google, Airtable and Accelevents request contracts without claiming live-provider success.
- **React Router type generation and TypeScript project references** validate browser, server and Worker code.
- **Migration validation** applies the pre-release baseline to SQLite and checks schema parity, indexes, tenant constraints, file-release/retention invariants, append-only audit and required event-policy provisioning.
- **OpenAPI validation** emits registry-backed Zod schemas, parses `docs/openapi.yaml` and requires exact synchronization with `public/openapi.json`; the current contract has 32 paths.

## Architecture

Program Cue is a modular monolith, not a set of microservices:

```text
React Router page or API resource route
        ↓ authenticated/event-scoped principal + validated input
vertical-slice application service
        ↓ durable transaction / explicit provider boundary
D1 control plane, selected D1/Airtable repository, private R2, Queue or provider
        ↓ committed event_changes cursor
Durable Object invalidation + authoritative D1 polling
```

Route handlers own HTTP concerns. Deterministic rules and state transitions live in `app/modules/`; shared authentication, APIs, operations, persistence and realtime infrastructure live in `app/platform/`. Public reads and automatic triggers use immutable version snapshots selected at a claimed publication boundary; mutable draft metadata cannot change the currently published behavior. Event repository authority is explicit and every private command remains organisation/event scoped. Retryable provider completions may update only the tokenized lease they claimed, and materialisers recheck operation eligibility at every durable write boundary. Event boundaries, form/task date-only values, schedule slots and attendee-facing times use the event timezone; UTC epoch values remain the stored instant. External work must fail explicitly when its binding, credentials or durable prerequisite is absent.

## External acceptance boundaries

- Turnstile, the Resend domain/owner magic-link path, tracked Resend delivered/bounced receipts, Google/Microsoft sign-in and calendar create/update/cancel lifecycles, browser/Uppy multipart signing and CORS, private-R2 clean/EICAR scanner verdicts, and a fresh scanner-error callback have production evidence. Airtable/Accelevents, a fresh error callback from those external providers and external AI-provider paths remain acceptance boundaries.
- The deployed backup Workflow code has written a checksum-manifested private-R2 object, retained logs are queryable and that exact object passed an isolated remote-D1 restore. The next autonomous post-fix cron, condition-specific alert delivery, trace continuity and measured RPO/RTO remain outstanding.
- The local performance harness and 10,000-record fixture are implemented. Deployed p75 RUM, production-like scale and cost evidence remain required.
- Automated Playwright/axe and visual coverage does not replace manual screen-reader, keyboard-only, contrast and zoom acceptance.
- Forge, a deployed evaluator URL and competition submission/walkthrough evidence are outside the repository implementation.

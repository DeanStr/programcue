# Technology stack

## Runtime and application

- **TypeScript 5.9, React 19 and React Router 8 framework mode** provide SSR, path routes, route loaders/actions, resource routes and generated route types.
- **Vite 8 and the Cloudflare Vite plugin** run the same Worker application locally and build the production bundle.
- **Cloudflare Workers** are the single HTTP and Queue runtime. There is no legacy JavaScript Worker or second frontend path.
- **Cloudflare D1** is the transactional source of truth. Validation confirms that the baseline migration and Drizzle schema describe the same 72 application tables and 66 named indexes, with two append-only audit triggers and one event-policy provisioning trigger; services use explicit tenant-scoped SQL, while Better Auth uses the Drizzle adapter. Published forms, resources and communication templates keep their public metadata with the immutable version, not only on the mutable parent row.
- **Cloudflare R2** stores private file bytes under opaque event/target/version keys. Current browser uploads are Worker-proxied multipart requests, not direct multipart uploads.
- **Cloudflare Queues** execute communication, submission/decision-notification and calendar operations after durable D1 intent is recorded. Recipient delivery and published-schedule fan-out advance through bounded, durable continuation passes; schedule publication captures the exact calendar target set in the same transaction as its parent operation. Provider work uses renewable, random-token D1 leases that expire after 60 seconds: expired `running` work can be reclaimed, an active lease returns the message for a 60-second delayed retry, and completion/failure writes require the current claim token. Decision and submission notification materialisation is also conditional on the operation remaining eligible, preventing a stale duplicate from reopening terminal work. Superseded calendar attempts terminate without overwriting newer intent. Only typed domain workflows create operations; the REST operations collection is read-only. Unexpected Queue messages are recorded as failed rather than simulated.
- **Cloudflare Durable Objects** provide event-scoped WebSocket invalidation. D1 `event_changes` remains authoritative, with cursor polling at a maximum 30-second interval.

## Application libraries

- **Better Auth** provides D1-backed production sessions and five-minute hashed magic links; Resend is the fail-closed mail boundary.
- **Zod** validates route, API, domain and queue inputs.
- **Radix Dialog**, **cmdk**, **react-hotkeys-hook**, **Lucide**, class-variance-authority, clsx and tailwind-merge support accessible application primitives and navigation.
- **Tailwind CSS 4** supplies utilities alongside the established Program Cue CSS variables and component styles. `public/styles.css` remains the visual-token source of truth.
- **dnd-kit core** supplies pointer and keyboard schedule placement and movement.
- **Tiptap** supplies constrained resource-page authoring; server rendering allow-lists nodes, marks and HTTPS embeds.
- **React Email** renders previewed and queued email content. Optional email includes an HMAC-signed, expiring unsubscribe link with an explicit confirmation action; category preferences apply only to optional email, while event-wide provider complaint/suppression exclusions are rechecked for every email kind before delivery. Resend webhook events are stored idempotently and reduced by explicit precedence into a monotonic delivery status.
- **ical-generator** creates the public calendar feed with slug-bearing programme-session links; the calendar module separately creates stable-UID, sequence-serialized REQUEST/CANCEL invitations.
- **Scalar** renders the interactive OpenAPI reference from `public/openapi.json`.

Dependencies are added only for an active implementation. FullCalendar, Uppy and dnd-kit Sortable were removed because the current schedule and upload flows do not use them.

## Testing and contracts

- **Vitest projects** run deterministic Node-compatible rules without Worker startup, while the Cloudflare Workers project exercises service, route and provider boundaries against isolated workerd D1/R2 bindings.
- **Playwright/Chromium** exercises the production-built Worker and assets, real routes, keyboard/focus behavior, responsive layouts and visual snapshots against a freshly reset, dedicated local Wrangler state directory.
- **React Router type generation and TypeScript project references** validate browser, server and Worker code.
- **Migration validation** applies the baseline to SQLite and checks 72 application tables, 66 named indexes, tenant constraints, file-release invariants, two append-only audit triggers and automatic schedule-policy provisioning.
- **OpenAPI validation** parses `docs/openapi.yaml` and requires exact synchronization with `public/openapi.json`.

## Architecture

Program Cue is a modular monolith, not a set of microservices:

```text
React Router page or API resource route
        ↓ authenticated/event-scoped principal + validated input
vertical-slice application service
        ↓ durable transaction / explicit provider boundary
D1, private R2, Queue or external provider
        ↓ committed event_changes cursor
Durable Object invalidation + authoritative D1 polling
```

Route handlers own HTTP concerns. Deterministic rules and state transitions live in `app/modules/`; shared authentication, APIs, operations, persistence and realtime infrastructure live in `app/platform/`. Public reads and automatic triggers use immutable version snapshots selected at a claimed publication boundary; mutable draft metadata cannot change the currently published behavior. Retryable provider completions may update only the tokenized lease they claimed, and notification materialisers recheck operation eligibility at every durable write boundary. Event boundaries, form/task date-only values, schedule slots and attendee-facing times use the event timezone; UTC epoch values remain the stored instant. External work must fail explicitly when its binding, credentials or durable prerequisite is absent.

## Boundaries not yet delivered

- Airtable and Accelevents adapters do not exist, so no runtime credentials for them are declared.
- There is no UI or OAuth callback that provisions verified sender profiles or encrypted Google/Microsoft calendar connections. Provider services and queue consumers exist, but those records currently require external provisioning.
- There is no configured malware-scanner adapter/callback, direct-to-R2 multipart upload, rate limiter or Turnstile integration.
- Cloudflare Workflows/scheduled reminder orchestration and scheduled sends are not implemented. Local provider tests use injected boundaries; the specified Mailpit/MSW harness is absent.
- AI/agent tools, general import/export and performance-budget evidence are not implemented.

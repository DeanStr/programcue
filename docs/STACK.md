# Technology stack

## Delivered evaluator and backend

- **Modern JavaScript modules and browser platform APIs** — zero-install evaluator application.
- **Cloudflare Worker runtime** — production API, assets, public embed and Queue boundary.
- **D1-compatible SQL migration** — 34-table relational model with constraints and audit triggers.
- **Web Components-free semantic HTML/CSS design system** — no opaque UI runtime in the evaluator package.
- **Playwright with Chromium** — full browser workflow and responsive checks.
- **Node test runner and SQLite validation** — fast domain, Worker and migration checks.

## Recommended production UI package

The production dependency manifest is recorded in `production-package.example.json`. The intended extraction remains one full-stack Worker application rather than a new service:

- **TypeScript, React, React Router framework mode and Vite** — typed route modules and one application bundle.
- **Cloudflare Vite plugin and Wrangler** — local development and Worker deployment.
- **Drizzle ORM with D1** — typed repository access and migrations.
- **Better Auth** — magic links, sessions, invitations and optional Google/Microsoft sign-in.
- **R2** — private headshots, slides, supporting material and generated exports.
- **Cloudflare Queues and scheduled Workers** — reminders, deliveries, imports and integrations.

## UI and interaction libraries

- **Tailwind CSS + shadcn/ui/Radix primitives** — Program Cue tokens and accessible controls.
- **TanStack Table / Query / Virtual** — operational tables, bounded polling and large-list performance.
- **React Hook Form + Zod** — form state and shared validation.
- **bpmn.io form-js** — constrained visual submission-form editing, wrapped by Program Cue versioning/routing.
- **Tiptap** — WYSIWYG editing for messages, resources and programme content; arbitrary raw HTML is not a normal field type.
- **Recharts** — readiness and operational charts, used only when a chart improves actionability.
- **dnd-kit** — accessible drag/reorder and schedule movement with keyboard equivalents.
- **FullCalendar standard plugins** — public/list/day/week views without premium resource-plugin dependence.
- **Uppy** — direct R2/S3-compatible uploads, progress and retry.
- **cmdk, react-hotkeys-hook and Sonner** — command palette, scoped shortcuts, feedback and honest undo.

## Communications and integrations

- **React Email + Resend** — transactional templates and delivery.
- **ical-generator** — stable iCalendar UIDs, updates and cancellations.
- **Google Calendar and Microsoft 365 adapters** — optional account-connected calendar operations.
- **OpenAPI 3.1** — public/admin API documentation.
- **AI SDK** — contextual assistant planning behind the same authorisation and approval gates as the UI.

## Operational principle

The evaluator application is dependency-free for reliable judging. External provider execution remains credentialed and fail-closed. The production package is an extraction of the proven interaction/domain contract, not a rewrite into microservices or a second backend.

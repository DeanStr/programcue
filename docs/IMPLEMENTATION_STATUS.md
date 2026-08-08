# Implementation status

Audit date: 8 August 2026 (UTC)

Source baseline: [Sessionboard replacement full-scope implementation specification](../sessionboard-replacement-full-scope-implementation-specification-with-competition-ux.md)

## Bottom line

The repository currently contains a strong, dependency-free evaluator prototype and a useful Cloudflare/D1 production foundation. It does **not** yet contain the full production product committed by the specification.

The browser application demonstrates much of the intended workflow with seeded records and durable `localStorage` state. The production Worker implements a smaller set of real API boundaries. Most evaluator actions do not call the Worker or D1, and external providers, real authentication, role enforcement, file storage, AI, Airtable and Accelevents are not implemented.

## Status terms

- **Working evaluator**: the interaction changes browser-local demo state and can be exercised without external services.
- **Production subset**: executable Worker/D1 behavior exists for the stated subset.
- **Schema only**: the relational shape exists, but application/service behavior is not wired to it.
- **Demonstration only**: the screen or result is seeded, fixed or simulated and does not execute the represented production operation.
- **Not implemented**: no executable implementation was found.

## What is working now

### Evaluator application

- Eighteen rendered routes plus the programme embed route.
- Event identity, date, timezone and room editing in browser-local state.
- Local administrator and speaker invitation records.
- Submission search/filter/export and direct-session creation.
- Call-for-speakers field creation/reordering, conditional display rules, category routing, speaker limits, local version publication and mobile preview.
- Public application drafts, multiple drafts, conditional fields, multiple speaker names, video URL capture and local submission creation.
- Split-pane review, weighted scoring, conflict declaration, review submission, decision readiness, accept/reject decisions and accepted-session handoff to the unscheduled tray.
- Room-board drag/drop and keyboard move alternative, local room/speaker/track/capacity validation, staged change, diff, undo and local publication; List, Day, Week, Track and Room view controls render.
- Speaker profile editing, local file metadata validation, A/V confirmation, resource acknowledgement and a sandboxed resource embed.
- Task search/filter/views, weighted readiness calculation, task creation, templates, CSV export, completion, bulk completion and undo.
- Email/SMS/Push/Calendar editors, rich-HTML sanitisation, fixed recipient arithmetic, preview/diff/confirm UI and a local queued-send record.
- Public programme search/filter/details, browser-local itinerary, iframe route and client-generated CSV, JSON, iCalendar and static HTML exports.
- Explicit local dry-run previews for integrations.
- A fixed assistant plan with approval that can stage the seeded schedule move and record a draft count.
- Visible navigation, command palette, shortcut help, focus trapping/restoration, reduced-motion CSS and demo reset.

### Production subset

- Cloudflare Worker routing for assets, API requests and a configurable iframe embed boundary.
- Public programme JSON and iCalendar endpoints backed by D1 outside demo mode.
- Authenticated task list/create endpoints.
- Schedule-publication endpoint that checks persisted blocking-conflict rows, changes schedule-version state and appends an audit event.
- Durable/idempotent operation ingestion before Queue delivery; the consumer records receipt.
- Fail-closed handling for missing bearer credentials, bindings and embed configuration.
- Private-origin CORS checks, cache rules, correlation IDs and baseline security headers.
- One D1 migration with 34 tables, indexes, constraints and two append-only audit triggers.
- Static OpenAPI 3.1 documents for the implemented endpoint subset.

## Requirement-area audit

| Area | Evaluator | Production | Current finding |
| --- | --- | --- | --- |
| Event administration | Working evaluator, partial scope | Schema only | Event/room edits and local invitation records work. There is no invitation delivery/acceptance, event creation/cloning, multi-event persistence or production membership service. |
| Authentication, tenancy and RBAC | Surface switcher only | Foundation only | Private routes use one shared internal bearer token. Better Auth, sessions, magic links/OAuth flows, CSRF, API-key scopes and per-user/per-event role enforcement are absent. |
| Form builder and versioning | Working evaluator, partial scope | Schema only | Fields, reorder, conditions, routing, settings and local publish work. There is no server CRUD/version service, immutable submitted-version workflow, reusable-template store or full rich-content editor. |
| Public applications and drafts | Working evaluator, partial scope | Schema only | Local drafts, co-speaker names, conditional validation and local submission work. Closing dates and password/account access are not enforced, email verification is seeded, form file input is not persisted, and there is no co-speaker claim/invite flow. |
| Submission/direct-session operations | Working evaluator, partial scope | Schema only | Search/filter/export, direct sessions and accept/reject handoff work locally. Import, tags, archive/restore, bulk operations and server-side state transitions are absent. |
| Evaluation | Working evaluator, partial scope | Schema only | Weighted scoring, recusal UI, rounds list, feedback separation and decision flow work locally. Teams/assignments are seeded, all reviews share one draft state, and moderation, locking, blinded review, round progression and multi-user enforcement are absent. AI review content is fixed text. |
| Speaker portal and onboarding | Working evaluator, partial scope | Schema only | Profile, file-selection checks, A/V confirmation, resources and acknowledgement work locally. Most portal navigation is a single dashboard, and there is no secure speaker claim, complete task workflow or server persistence. |
| Files and media | Demonstration only | Schema/config only | The evaluator stores filenames/metadata in `localStorage`; it does not upload file bytes. R2 is configured, but signed upload/download, object grants, signature validation, progress/retry, version retrieval and scan/quarantine processing are absent. |
| Tasks/readiness | Working evaluator, partial scope | Production subset | Local task operations and weighted readiness work; Worker list/create endpoints exist. Dependencies, relative due dates, reminders/escalations, comments, approval workflow, exception handling and a complete production task service are absent. |
| Communications/calendars | Demonstration only | Schema/queue foundation | Editors and a local validation gate work, but recipient cohorts and delivery results are fixed. Sending only adds a local queued record; Resend, SMS/push, ICS invitation lifecycle, Google/Microsoft OAuth, webhooks, retry/reconciliation and unsubscribe handling are absent. |
| Schedule | Working evaluator, partial scope | Production publication subset | Local drag/drop, validation, views, staging and undo work. Production schedule CRUD/move validation is absent; the publish endpoint trusts stored conflict rows instead of recalculating conflicts. There is no complete version history UI or calendar-update execution. |
| Operational dashboard/realtime | Demonstration only | Operation-ingestion foundation | Dashboard counts, readiness and job rows are fixed seed values. There is no live query, polling/invalidation connection, Durable Object channel or working unified job centre with retry/cancel. |
| Public programme/itinerary | Working evaluator, partial scope | Production subset | Search, filters, details, local favourites, exports, JSON, iCalendar and iframe route exist. Speaker gallery navigation, authenticated/shared itinerary, itinerary conflict checks, script widget and cross-origin resize protocol are absent. |
| Resources/wiki | Working evaluator, narrow sample | Not implemented | One hard-coded resource page, attachment labels, sandboxed `srcdoc` and acknowledgement work. Authoring, categories, targeting, publishing/versioning, real attachments and resource live preview are absent. |
| Airtable | Demonstration only | Not implemented | Provider selection and dry-run copy exist; there is no adapter, Airtable-backed event, batching/cache/backoff, migration or reconciliation implementation. |
| Accelevents | Demonstration only | Not implemented | Mapping/direction copy and a dry-run preview exist; there is no credentialed export, idempotent update or reconciliation run. |
| Agentic/AI interface | Demonstration only | Not implemented | Suggestions and plans are hard-coded. There is no model call, authorised tool layer, source inspection, permission decision or agent audit trail. |
| Command palette/global search | Working evaluator, partial scope | Not implemented | Keyboard navigation among a small static command list works. Record search, permission filtering, recent records, aliases, help results and confirmed consequential actions are absent. |
| Autosave/recovery | Working evaluator, narrow scope | Not implemented | Direct `localStorage` saves preserve demo state. Saving/offline/retry/restored states, debounced server writes, revision tokens, cross-tab conflict handling and logout cleanup are absent. |
| Preview/diff/confirm and undo | Working evaluator, partial scope | Not implemented as shared services | Several screens demonstrate the pattern; schedule and task undo work locally. Imports, migrations, integrations, decisions and background results do not have the complete shared workflow required by UX-004/UX-006. |
| API/webhooks | Production subset | Production subset | Six path families are documented/handled: health, public programme, public calendar, tasks, schedule publication and operation enqueueing. General CRUD, scoped API-key enforcement, cursor pagination, webhook registration/signatures/delivery history and interactive Scalar docs are absent. |
| Cloudflare deployment | Configuration/foundation | Configuration/foundation | Worker, D1, R2, Queue and Assets bindings are declared. Resource IDs and secrets are placeholders; no deployed environment or Durable Objects/Workflows/Turnstile behavior was verified. |
| Security/privacy/recovery | Partial baseline | Partial baseline | Security headers, private-route rejection, append-only audit-table protection and fail-closed bindings are tested. Full authz, upload security, rate limiting, retention/deletion/legal hold, backups/restores and provider webhook verification are not implemented. |
| Accessibility/performance | Partial baseline | Not verified in deployment | Semantic controls, focus styles, reduced motion and a 1280 px browser check exist. WCAG 2.2 AA review, 200% zoom, screen-reader/browser matrix, representative-scale performance budgets, Lighthouse/Web Vitals and recovery evidence are absent. |
| Competition delivery bonuses | Documentation/config only | Not verified | No evidence in this workspace proves a deployed evaluator site, Forge-hosted canonical repository, Airtable-backed golden path or performance report. |

## Requirement ID cross-reference

This mapping distinguishes browser-local interactions from production behavior. A screen, schema table or provider dry run does not by itself satisfy an end-to-end production requirement.

| Requirement IDs | Capability | Evidence | Verified status |
| --- | --- | --- | --- |
| OBJ-001–006 | End-to-end programme-management product | Evaluator SPA covers the main workflow; Worker covers a small subset | Partial evaluator; production incomplete |
| ADM-001–005 | Dashboard, settings, administrators and conventional UI | Command Centre, Event Setup, local invitations, `events`/`memberships` tables | Partial evaluator; schema only for roles |
| SUB-001–013 | Custom forms, conditions, routing, direct/manual sessions and speakers | Form Builder, direct-session modal, public application, form/submission schema | Partial evaluator; production services absent |
| SUB-014–020 | Deadlines, limits, drafts, access and confirmation | Local settings/drafts/limit checks and shareable application route | Partial; deadline/access/email verification not actually enforced end to end |
| SPK-001–008 | Speaker portal, profiles, files and onboarding | Dashboard/resources routes, local profile/file metadata/task state, schema | Partial evaluator; secure portal/storage absent |
| COM-001–006 | Templates, reminders, ad-hoc messaging and calendars | Four local editors, preview/confirm screen, communication tables/queue foundation | Demonstration only; provider execution absent |
| EVA-001–009 | Plans, teams, assignments, rounds, reviews and decisions | Review Workbench, domain score tests, local recusal/decision flow, schema | Partial evaluator; multi-user production workflow absent |
| SCH-001–007 | Scheduling, conflicts, views, programme and versioning | Local drag/drop/keyboard move, domain tests, five views, Worker publish endpoint | Partial evaluator plus publication subset |
| DSH-001–003 | Realtime readiness dashboard | Fixed Command Centre metrics and local Tasks & Readiness | Demonstration only; no realtime data path |
| NFR-001–005 | Speed, navigation, security, accessibility and reliability | Dependency-free app, CSS controls, security headers, tests | Partial baseline; measurable budgets and full NFR evidence absent |
| OPT-001 | Multi-round and AI-assisted review | Local round-list mutation and fixed advisory copy | Demonstration only |
| OPT-002 | Additional administrators | Local invitation record and membership schema | Partial evaluator; no invite acceptance/auth |
| OPT-003 | Higher product polish | Design system and substantial interaction surface | Partial; several UX acceptance signals remain unmet |
| OPT-004 | Adjacent operations | Some CSV exports, local bulk task completion, saved-view toasts and static activity | Partial; cloning/import/archive/webhooks/audit UI absent |
| OPT-005 | Elaborate task workflow | Task templates, impact/evidence fields and local bulk actions | Partial; dependencies/reminders/comments/escalation absent |
| OPT-006 | Agentic interface | Hard-coded plan/approval screen | Demonstration only |
| WVD-001 | Accelevents integration | Mapping copy and explicit dry-run preview | Not implemented beyond demonstration |
| WVD-002 | Resources/wiki | One fixed resource page with sandboxed embed and acknowledgement | Narrow evaluator sample; authoring/persistence absent |
| WVD-003 | Gallery and itinerary | Programme details and browser-local favourites | Partial; gallery, shareable itinerary and conflict warning absent |
| OUT-001–005 | Explicit exclusions | No general CRM, marketing automation, CMS, payments or multilingual expansion | Correctly excluded |
| CMP-001–013 | Competition delivery | Repository documentation and evaluator package | Deployment/submission/Forge evidence not present in workspace |
| TEC-001–009 | Technology and bonus choices | Cloudflare configs, D1 migration, OpenAPI subset, dry-run integration UI | Partial foundation; Airtable, Forge, deployed proof and full API absent |
| UX-001 | Permission-aware search/commands | Static command palette and shortcut | Partial |
| UX-002 | Actionable command centre | Fixed metrics and broad route links | Demonstration only; not record-derived |
| UX-003 | Split-pane review | Queue/detail/rubric, local autosave and submit-next | Strong evaluator subset; production/multi-draft isolation absent |
| UX-004 | Universal preview/diff/confirm | Form, communication, schedule and programme examples | Partial, not universal |
| UX-005 | Autosave/recovery feedback | Direct `localStorage` persistence | Partial local persistence; recovery/conflict semantics absent |
| UX-006 | Honest undo | Local schedule/task undo; send has no undo | Partial |
| UX-007 | Contextual AI | Fixed summaries/suggestions | Demonstration only |
| UX-008 | Evaluator demo mode | Seed state, surface switcher and reset | Partial; not role-authentic and no Airtable-backed event |
| UX-009 | Live previews | Form and communication previews, programme views | Partial; resources/session content coverage absent |
| UX-010 | Operation centre | Fixed Command Centre job table and operation-ingestion endpoint | Foundation only; no functional centre/retry UI |

## Validation evidence

Run during this audit:

```text
npm run check:core  PASS
22/22 domain and Worker tests
18 routes plus the embed route rendered
34 tables and 2 triggers validated
25 static invariants passed
16 HTTP/security smoke checks passed
```

`npm run check` does not currently pass in this workspace because Python cannot import `playwright`. The browser test script is present and covers substantial local workflows, but its results were not re-verified during this audit.

## Highest-priority remaining work

1. Replace the shared bearer boundary with real authentication, tenant isolation and server-enforced roles.
2. Connect the UI to D1-backed domain services for forms, submissions, reviews, decisions, speakers, tasks, schedules and publication.
3. Implement secure R2 upload/download plus validation, versioning and scan/quarantine state.
4. Implement the communication/calendar outbox and real provider adapters with status, retries and reconciliation.
5. Implement Airtable and Accelevents adapters or explicitly revise the full-scope commitment.
6. Replace fixed AI/demo output with permission-aware tools and auditable approval flows.
7. Complete realtime/background-operation behavior, API-key/webhook support and production observability.
8. Run the browser suite, accessibility review, performance budgets and deployment/recovery checks in a reproducible environment.

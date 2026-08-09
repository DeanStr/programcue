# Product and engineering decisions

This file records durable decisions. It does not imply that every decided capability is implemented; verified delivery status lives in `IMPLEMENTATION_STATUS.md`.

| Decision | Outcome |
|---|---|
| Product name | Program Cue |
| Product shape | One pre-release TypeScript modular monolith; no backward-compatibility layer without a real external consumer or deployed migration history |
| Frontend/runtime | React Router framework mode with SSR, loaders/actions, resource routes and path navigation on one Cloudflare Worker |
| Vertical-slice pattern | Route → server authorisation/validation → application service → D1/R2/Queue/provider |
| Visual direction | Retain the Program Cue design language, but prefer a clearer and more appealing UX over exact prototype or Sessionboard parity |
| Tenant model | One organisation with multiple events; private operational records and provider work are event-scoped |
| Roles | Owner, administrator, committee chair, evaluator, submitter and speaker; the server, not hidden UI, is the permission boundary |
| Admin navigation | Command Centre, Event Setup, Submissions, Review, Speakers, Resources, Schedule, Communications, Tasks, Programme, Integrations, Settings and Operations |
| Admin visual shell | Dark navigation with a light work canvas |
| Participant/public density | Comfortable light surfaces with mobile-responsive workflows |
| Canonical demo event | Future of Events 2025, 20–22 May 2025, Toronto; demo powers require the explicit demo Worker configuration |
| Primary repository | D1 relational state with a typed Drizzle schema; Airtable is optional future scope and never a silent fallback |
| Baseline migrations | Until a migration is deployed/shared as immutable, update the pre-release baseline directly; afterward add numbered migrations |
| Reference production slice | Event Setup established server authorisation, event scope, Zod validation, optimistic revisions and append-only audit evidence used by later slices |
| Time semantics | Store instants as UTC epoch values, but interpret event boundaries, date-only form/task deadlines and schedule slots in the event timezone; attendee-facing schedule times render in that timezone |
| Person model | Canonical person identity with submission, session, membership and speaker associations |
| Publication snapshots | Public behavior comes from immutable form, resource and communication versions, including identity/settings/audience/attachment metadata; mutable drafts do not alter the live version before a claimed publication boundary |
| Form publishing | Published form versions are immutable; later edits create a new draft, live public settings change only when it publishes, and existing applications retain their original schema snapshot |
| Resource publishing | Resource title/slug/category, audience, acknowledgement policy and attachments belong to a version; acknowledgement records identify the exact version read |
| Evaluation | Weighted criteria and explicit conflict declaration; owners/administrators hold decision authority, committee chairs require an explicit plan grant, and accepted released decisions create a session atomically and are final |
| Schedule conflicts | Event-boundary, room and speaker conflicts block publication by default; track and capacity handling follow the stored policy and are revalidated at publication |
| Public identity | Event slugs are globally unique; canonical programme, embed, API, feed and calendar-session links are event-slug-addressed |
| Published programme | Public UI/API/feed read only the latest published schedule version; anonymous itineraries are durable under a hashed browser token |
| File lifecycle | Private R2 objects use opaque keys and remain quarantined until a trusted clean result releases a version; no missing scanner may be treated as success |
| Communication safety | Versioned metadata/content and exact recipient queries use preview → confirm → durable D1 intent → exact send claim → provider reconciliation; cancellation competes with the send claim, Resend receipts reduce monotonically and missing sender, Queue or credentials block delivery |
| Calendar baseline | Stable iCalendar UIDs and sequence-aware REQUEST/CANCEL operations; one current attempt serializes rapid lifecycle changes and stale completions are superseded; email-ICS, Google and Microsoft provider boundaries are explicit, with no simulated success |
| Dashboard freshness | D1 `event_changes` is authoritative; an event-scoped Durable Object broadcasts post-commit WebSocket invalidations and clients retain a bounded polling fallback of at most 30 seconds |
| API authentication | Event-scoped, scope-limited API keys are stored only as hashes, revealed once, expirable and revocable |
| API contract | Versioned REST resources use structured errors/correlation IDs and synchronized OpenAPI YAML/JSON; public programme resources allow public CORS, private resources allow configured origins only |
| AI/agent actions | If implemented, they remain contextual proposals executed through the same permissions, preview, approval and audit boundaries; no unreviewed publish/send |
| Failure behaviour | Missing auth, bindings, provider configuration and blocking invariants fail explicitly; no hidden storage, credential, stale-data or provider fallback |
| Runtime modes | Only the checked production, demo, development and test mode pairs are accepted; contradictory or unknown `APP_ENV`/`DEMO_MODE` values fail before routing or Queue consumption, and unknown environments retain production-grade redaction and transport security |
| Browser mutation origin | Cookie-authenticated non-API mutations require an exact same-origin `Origin` header at the Worker boundary; API keys, signed webhooks and Better Auth keep their dedicated request protections |
| Excluded product scope | General CRM, general marketing automation, payments, multilingual expansion and a general-purpose CMS |

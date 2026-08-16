# Verified implementation status

Last verified: 2026-08-15.

This is the canonical implementation audit and requirements traceability record. The product specification remains authoritative for intended scope; this file records observed code, focused tests and local evidence only.

Status terms:

- **Production slice** — the real Worker path is authorised, validated and backed by D1/R2/Queue/provider boundaries. It does not imply that a production deployment or live provider was verified.
- **Production foundation** — shared runtime or infrastructure used by production slices.
- **Demonstration only** — explicitly environment-gated seed or simulation, never a production fallback.
- **External acceptance outstanding** — the in-repository path exists, but credentials, deployed resources or independent acceptance evidence are unavailable in this workspace.

## Phase 0–7 architecture milestone

| Phase                                      | Verified outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Remaining boundary                                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 0 — application foundation                 | One React Router/TypeScript Worker, Program Cue design system, Better Auth/D1 identity, explicit organisation/event roles, audited multi-event selection, blank event creation with explicit D1/Airtable authority, fail-closed Airtable activation/recovery and a table-driven role/tenant acceptance matrix. The production Worker, bindings, secrets, owner and initial event are deployed. A real Turnstile-protected Resend magic link was requested, delivered and consumed into an active owner session. Microsoft identities whose email claim is not provider-verified must complete that same email proof before an explicit, session-bound account link; direct sign-in never trusts the claim. Live Google and hardened Microsoft sign-in are verified.                                                                                                                            | Broader invited-user and participant authentication acceptance remains external.                                                   |
| 1 — submissions                            | Immutable form versions, the Program Cue-native visual editor/renderer, React Hook Form/Zod validation, conditional fields, intent-bound exact-replay anonymous/verified drafts, expiring co-speaker claims, public direct-session intake, server-paged TanStack submissions grid and durable confirmation work are connected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Submission-verification delivery and draft-ownership acceptance remain external.                                                   |
| 2 — evaluation                             | Teams/invitations, multi-round plans, mixed weighted rubrics, submission and session targets, assignments, anonymised review, D1 autosave/recovery, recusal, moderation/reopen, final decisions and atomic accepted-session creation are connected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Live invitation/decision delivery and evaluator acceptance are external.                                                           |
| 3 — participants/tasks/resources/files     | Submitters and speakers share one routed participant shell with Overview, Applications, Sessions, Tasks, Files, Resources and Profile. Applications aggregate owned and claimed proposals plus startable published forms. Route-owned mutations, session-labelled deliverables, versioned resources/acknowledgements, dependency-aware task plans, acceptance-time automatic onboarding, bulk preview/confirm, safe completion undo, event-owned file policy, Uppy direct R2 multipart resume, quarantine/scanner reconciliation and retention/legal hold are connected. A fail-closed ClamAV Container companion implements the deployed production scan contract; production browser multipart, clean-release, EICAR-quarantine and scanner-error/retry paths are verified.                                                                                                                  | Provider-side erasure acceptance remains external.                                                                                 |
| 4 — schedule/public programme              | Configured formats/durations/tracks/rooms/resources, breaks, authoritative conflicts, FullCalendar list/day/week editing, keyboard alternatives, pointer move/resize, unassign/undo, draft notes/session-content recovery, attributed editorial approval/restoration, immutable version snapshots, approval-gated publication and exact published public/API/calendar views are connected. An isolated production schedule was created, speaker-confirmed, published and rendered through the anonymous programme.                                                                                                                                                                                                                                                                                                                                                                             | Production performance remains external.                                                                                           |
| 5 — communications/calendars               | Versioned React Email templates, verified-sender provisioning, a revisioned D1 draft composer, same-row draft-to-delivery transition, content/source/sender-bound preview/confirm, scheduled sends, per-trigger-isolated automatic reminders/escalations, strict Resend or Mailpit selection, monotonic receipt reconciliation, account-bound Google/Microsoft OAuth and refresh, email-ICS/provider lifecycle and retryable Queue fan-out are connected. MSW contracts cover provider request boundaries. Production acceptance verified real Resend delivery/bounce reconciliation and Google/Microsoft invitation create/update/cancel through the durable Queue.                                                                                                                                                                                                                           | Broader recipient and provider-error acceptance remains external.                                                                  |
| 6 — operations/realtime/adjacent workflows | D1 readiness, command search, saved views, blank event creation, event clone, CSV import/export, bulk session/task changes, durable operations/items, retry/cancel/skip, an audit-guarded transactional outbound-webhook outbox with scheduled undispatched recovery, WebSocket invalidation and bounded polling are connected. Retained production logs, real-time Queue metrics and both Workers' observability settings have been inspected. Scanner-error, meaningful application/Queue error and D1 backup-error alerts are attached to an enabled email policy; isolated harmless exercises reached Cloudflare's firing state, but Cloudflare did not hand the real incidents to Notifications even though direct policy tests were recorded as dispatched. A 03:47 UTC R2 monitor converts a missing or inconsistent daily backup into the error event Cloudflare's log alerts require. | Autonomous monitor acceptance, working incident-to-notification delivery and broader production support exercises remain external. |
| 7 — API, integrations and agent            | Thirty-three deployed, documented REST paths expose published, participant and administration resources plus atomic idempotent commands and authenticated provider callbacks; registered Zod 4 command schemas are emitted deterministically into the synchronized OpenAPI YAML/JSON. Full-domain Airtable authority, confirmation-bound Accelevents preview/dry-run/export/retry/reconciliation CSV, and a Cloudflare Agents SDK assistant with contextual/standalone proposal approval are connected.                                                                                                                                                                                                                                                                                                                                                                                        | Live Airtable, Accelevents and model-provider acceptance remain external.                                                          |

The old static browser application, legacy JavaScript Worker delegation and `src/domain` compatibility path have been removed. All HTTP and Queue entry points use the current TypeScript Worker.

Pre-release hardening on 14 August 2026 replaced scanner URL-shape/bearer authority with a five-minute application-signed envelope that is verified before Workflow creation and bound through the signed callback. D1 public session, schedule and speaker pages now use SQL filtering, `limit + 1` reads, deterministic ordered JSON relations and keyset cursors instead of loading and hashing the complete programme. Queue batches use bounded concurrency of four; API-key `last_used_at` writes are limited to one per five minutes; event-channel D1/socket I/O no longer holds a global Durable Object block; and invitation/API-key audit-required mutations are conditional on their exact audit evidence. Release `9d1e276` is deployed, and the scanner HMAC, multipart, Queue, private-R2 proxy and callback path has live production evidence recorded below.

Private administration, review and contextual-AI document/data responses now
receive `Cache-Control: private, no-store` at the Worker response boundary. The
contextual action remains POST-only, while an accidental document GET renders
the standard application 405 boundary instead of exposing route-protocol data.
Focused browser coverage reloads Command Centre before asserting the actual
POST action request and the private cache policy; no deployed acceptance is
claimed.

## Public website

**Production foundation; deployed acceptance:** A separate
static-asset Worker serves the anonymous `programcue.com` home, privacy, terms
and not-found surfaces without application data bindings, cookies, scripts,
analytics or an authorisation dependency. The homepage presents the combined
sign-in/account-creation entry point, an explicitly illustrative programme
readiness workflow, outcome-led capabilities, operational trust boundaries and
the required Google integration disclosure. Configuration contracts cover both
Custom Domains, canonical routing, crawlability, social metadata, content and
anchor integrity, the declared Google scopes and Limited Use statement, and the
absence of production data bindings. Focused Playwright coverage exercises the
real Worker at desktop/mobile widths for reachability, keyboard skip navigation,
WCAG A/AA checks, 320-pixel containment and reviewed homepage/privacy visuals.
Release `303912c` is deployed as `program-cue-site` Worker version
`b2b428fb-f1ec-4fcf-ab33-829cd59eb4a4` with both production Custom Domains.
Live anonymous checks returned 200 for home, privacy, terms, robots and sitemap;
the not-found surface returned 404; `www` and plain HTTP canonicalised in one
301 to the secure apex URL; and HTML responses carried the checked CSP and
HSTS. Cloudflare's zone-level managed robots policy prepends content signals
that allow ordinary search indexing while reserving AI training, then preserves
the repository's allow-all and sitemap directives. The separate application
health boundary remained HTTP 200 with `no-store`; this release did not deploy
or bind application data. Google's external OAuth review remains provider-side.

Open identity creation is now connected through email magic links, Google and
Microsoft without changing authorisation. A brand-new identity is redirected to
a neutral no-access page; signup creates no organisation, event, membership or
participant relationship, and an unrelated authenticated identity remains
forbidden from private event routes. Focused Worker coverage consumes a real
hashed magic link for a previously unknown email, verifies the resulting person
and proves the no-membership boundary. Live production acceptance verified that
a brand-new Google identity reached the no-access page without workspace access;
fresh email-magic-link and Microsoft identity creation remain external.

Participant invitation boundaries now keep administrator-created speaker
memberships pending and expiring until acceptance, prevent unrelated identities
from being attached to direct sessions, defer public co-speaker materialisation
until claim, and keep that portal-access lifecycle separate from session-level
participation confirmation. Claimed/submitted relationships are explicitly
confirmed; administrator-created relationships remain pending until speaker
self-confirmation or an audited administrator acknowledgement of external
confirmation. Publication blocks and atomically rechecks unconfirmed scheduled
participation while allowing a confirmed speaker whose portal invitation remains
pending. Manual and direct-session invitation delivery intent is persisted
atomically and replays report its durable status; missing delivery configuration
fails before the participant mutation. Participant UI and REST profile writes now converge on one
compare-and-set mutation with shared validation, audit, webhook, realtime and
Airtable-authority behavior. Focused Worker and browser coverage verifies these
boundaries.

The speaker roster keeps expanded manual-entry and CSV-import controls above a
non-sticky roster header so those actions remain operable at the supported
desktop viewport. Every eligible roster row exposes its portal-access state and
an explicit Send or Resend portal invitation action; creating a prospect
remains provider-honest and sends nothing until that separate action is
confirmed.

The forms and submissions production slice also exposes the canonical
published-form URL for opening or copying, derives routing-attention states
from immutable submission evidence, preserves filtered queue context across
Previous/Next navigation, and links eligible submitted records to their
event-scoped Review row and immutable activity history.

The protected Track and Format questions project the complete ordered Event
Setup choices instead of retaining an independently editable option list.
Opening a stale builder draft synchronises those choices for explicit review
and save, while publication revalidates the exact ordered track identity/name
snapshot plus the exact session-format configuration at its compare-and-set
boundary. Focused Worker coverage changes both event configurations after a
published version, saves and publishes a new version, and verifies that the
public form receives the current choices while the older version remains
immutable.

The verified primary submitter can explicitly submit a newer proposal revision
while the original published form remains open and no review or decision work
exists. The mutation validates the immutable form version, uses submission
compare-and-set state, retains the previous submitted revision, atomically
updates the current submitted snapshot and routing, preserves existing speaker
and native-upload relationships, and permits only appended co-speakers backed
by durable invitation work. Assigned, reviewing and terminal proposals fail
closed. Focused Worker and Chromium application coverage exercise the applicant
reload and organiser-detail round trip.

The revision command binds actor, tenant, event, command scope, idempotency key
and request hash, and revalidates the exact submission and participant-speaker
snapshot inside its compare-and-set write. Its command row, current snapshot,
immutable revision, routing, audit, bounded result and every expected durable
invitation/webhook operation commit in one D1 batch with a completion assertion.
Exact or concurrent replay restores the recorded result and dispatches only
persisted, undispatched operations; changed input conflicts. Focused race
coverage proves a concurrent co-speaker claim persists while every stale
revision-side write rolls back.

Native browser validation on the applicant form now also produces an explicit
visible alert before focusing the first missing required field. Evaluation
administration projects the ordered submitted participant list with persisted
role labels, so co-presenter evidence is visible in the results queue rather
than only on the separate submission detail.

Evaluation administration also presents one round-scoped review-results table
containing proposal and session targets, with explicit type labels and one
aggregate-score sort. The target-specific queues remain focused on assignment
and decision work, and the current download is labelled as a proposal-results
CSV rather than claiming to export the combined table.

Task assignment rejects a second active task for the same target only when its
normalised title, description, task/evidence type, evidence configuration,
impact and resolved due date all match, including at the concurrent mutation
boundary. Differently defined work may reuse a title. Participant comments
require a stable browser intent whose exact replay converges on one comment,
audit and prepared webhook; changed content under the same intent fails.
Task-filter forms remount from their authoritative URL signature after
navigation, including truthful empty Overdue results.

Schedule placement errors identify the affected speaker and both clashing
session titles instead of reducing a rejected overlap to a transient conflict
count. The programme embed builder uses one labelled native output-format
selector for iframe and auto-resizing widget snippets, so its selected state
and generated code cannot diverge. Managed embed creation, configuration
updates and lifecycle transitions now persist their exact audit record first
and condition the domain mutation on that audit identity; focused Worker fault
injection verifies that suppressing any required audit leaves the embed absent
or unchanged.

### Production evaluation release-candidate evidence

The current repository revision expands the production-only `/evaluate` slice
without turning on local demo powers. Access remains rate-limited,
access-code-gated, fixed-person and bound to the latest completed reset
generation. Its signed cookie is a separate authentication realm that takes
precedence over unrelated Better Auth or applicant-cookie state while present
and limits private access to the dedicated fixture organisation. Ordinary role
selection grants no membership. Priya Raman's clean card now offers one
explicit audited account activation that creates only her fixed accepted
submitter membership for the canonical event, after which that fixed evaluation
identity is accepted on any active, non-password-protected form in the dedicated
fixture organisation. Identity lookup grants nothing; normal draft creation
creates that event's real submitter membership. `Activate account and choose
event` performs the same canonical activation, clears the current-event cookie
and lists only Priya's accepted or pending real same-organisation memberships;
invitation acceptance remains explicit. It leaves her durable email unverified,
creates no Better Auth state and claims neither verification email nor provider
delivery.

Exactly four documented SBEK aliases resolve to the corresponding seeded
routeable addresses only for a signed production-evaluation viewer inside an
active event owned by the dedicated fixture organisation. Successful workflow
messages disclose the entered and routed addresses. Exact aliases outside that
context, identity drift and all reserved/local-only production send destinations
fail before mutation; non-alias addresses retain normal validation. Marcus
remains only an in-scenario co-speaker alias/input and has no
selectable evaluator card or saved starting state. The signed activated clean
applicant can perform the accepted-submission co-speaker invitation while its
fixture email deliberately remains unverified; the ordinary participant route
continues to reject that same state until email is verified.

The exact canonical fixture's first anonymous personal-itinerary creation omits
Turnstile so the automated evaluator can exercise that path, but it still
consumes the ordinary hashed, D1-backed IP limit. No other event or production
action that ordinarily requires Turnstile receives that exception. Production's
wildcard `EMBED_FRAME_ANCESTORS` is applied only to published `/embed/*`
responses; private application responses retain `frame-ancestors 'self'`, and
resources framed inside Program Cue remain limited to exact
`RESOURCE_EMBED_ORIGINS` entries (`none` in the production profile).

The operator reset is organisation-scoped because optional evaluation scenarios
create events and contacts. It restores the canonical event, clears and
tombstones additional fixture-organisation events plus their private R2 data,
removes only safe auxiliary people created since the last completed reset, and
preserves event rows and append-only audits. Active external work, completed
retention, authentication/actor-audit state and cross-tenant or identity drift
fail before destructive cleanup. On first bootstrap, the shared seed may create
dedicated canonical fixture rows before the remaining cleanup preflight; that
bounded fixture-only mutation is not a completed reset. An atomic owner-token
lease serialises resets, fences every destructive phase and publishes the new
session generation only in the same D1 transaction that completes the owning
operation. Live overlap is rejected; failed and expired attempts remain
fail-closed while allowing a later operator reset to recover them.

The current release candidate also exposes a destructive, collapsed reset on
the unlocked `/evaluate` guide for starting a separate human or automated run.
It requires the canonical event name, consumes a dedicated D1/IP rate limit and
reuses the same fenced reset engine. Unlike initial operator provisioning, it
reads the four already-provisioned safe fixture addresses and exact verified
sender from D1 and never needs the deleted address bindings or full-access
Resend domain key. The reset claim is conditional on the initiating session's
already-validated fixture generation. Missing or drifted provisioning and a
concurrently superseded session fail before destructive work.
Completion audits the evaluator authority, invalidates every prior evaluator
cookie and returns the initiating browser to an unlocked gate-only role picker.

The seeded communications baseline now contains five published templates:
speaker task reminder, reviewer reminder, speaker welcome, submission
confirmation and proposal decision. Showcase tasks have due dates; task
reminders snapshot a due-date value in the event timezone and fail when that
required source value is absent. An `active_speakers` audience reads durable
event workflow status. The roster distinguishes non-sending prospect creation
from the separate durable portal-invitation action. Blank D1 event creation can
explicitly reuse a still-verified same-organisation sender after transactional
source revalidation; it does not copy templates or fabricate delivery.

Template assignment now binds the exact roster revision/status, full task
template/dependency material and prior assignment state before materialising one
target's complete prerequisite/root graph, dependency edges, assignment audit,
endpoint webhook delivery and operation job in one D1 batch. Guard failure rolls
back the complete target graph; exact replay reuses its audit, delivery and
operation. Bulk confirmation claims only its unchanged stored preview and
carries the same snapshots into each target batch. Targets remain independently
atomic, so a multi-target run may honestly finish `partially_failed`.

Bundled Priya Raman and Marcus Okafor portraits are presentation assets exposed
only through the canonical event's published programme projection and optional
application featured-speaker preview, under exact demo/evaluation runtime,
event and person allowlists. They are not authenticated profile/file state; any
non-deleted real headshot asset suppresses them, and they are not upload,
scanner or R2-release evidence. The expanded slice has focused repository and
browser evidence but has not been deployed or independently re-evaluated. Fresh
SBEK inbox/bounce capture and scheduled-reminder cron evidence remain external.
No 100% SBEK result is
claimed before deployment, one clean reset, a fresh complete ordered run and
the human checklist.

## Capability status

| Capability                             | Status                                                                     | Verified implementation and boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime and persistence                | Production foundation                                                      | D1 remains the transactional control plane. An event can explicitly select D1 or Airtable repository authority; the Airtable path proves schema and reversible record permissions before saving encrypted credentials, scopes provider reads to the current event/version and managed fields, migrates up to 250 changed managed records synchronously, and covers Event Setup (including track create/read/update), forms, submissions (including multi-track selections and routing teams), evaluation, sessions, schedule content/notes, tasks/onboarding and immutable published programme projections. Commands use durable exact-result intents and recovery; authoritative disconnects, published projection drift, schema divergence and missing credentials fail closed without a D1 data fallback. Live-provider latency and acceptance remain external.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Authentication, roles and events       | Production slice                                                           | Better Auth sessions, magic links, participant verification, administrator/evaluator invitations, explicit current-event cookies, audited switching, organisation-wide owner/admin grants, blank event creation and event-scoped chair/evaluator/submitter/speaker access are server-enforced. Invalid, ambiguous, revoked, expired and cross-organisation access is rejected. Event creation and cloning require an explicit D1 or Airtable choice and persist a durable D1 control-plane intent before provider work. Blank creation binds the loader-issued intent to the existing operation record, so exact retries return the same event/operation outcome, changed input is rejected and Airtable work is not repeated silently. Airtable creation leases fail expired still-owned work into explicit recovery without a provider retry; because expiry cannot cancel an outstanding provider request, that failure is fenced from another Airtable attempt and requires an explicit keep-on-D1 or discard outcome. Airtable-selected records remain inactive through provisioning, fail closed without changing authority, and can only become ordinary events after exact reconciliation or an explicit audited keep-on-D1 recovery; ordinary provider-failure retry requires credentials again, while discard preserves a hidden tombstone and releases the public slug. Demo identities remain unavailable in production. The explicit production-only evaluation mode adds an IP-rate-limited, access-code-gated `/evaluate` route and signed eight-hour sessions for fixed fixture identities. It cannot select arbitrary people, reset data or enable simulated providers; ordinary persona selection grants nothing, while the clean applicant has one explicit audited fixed-event submitter activation that does not verify email or claim delivery. Sessions carry the latest append-only fixture-reset audit generation, so another reset revokes existing evaluator cookies and a missing generation fails with reset-required unavailability. The fixed fixture, role journeys and access-code session boundary were browser-verified on 13 August 2026; the expanded activation/reset/alias changes were deployed and the reset completed on 14 August 2026. The bootstrapped owner completed a live Turnstile-protected Resend magic-link flow and established the configured 14-day production session. A first Microsoft sign-in with an unverified email claim fails closed, then offers an email-verified, authenticated and state-bound linking action; the callback must retain the same Microsoft email before the account can be linked, after which normal direct sign-in is allowed. Microsoft authorisation requests `form_post`; the callback validates the POST against unexpired OAuth state, encrypts it into a 90-second single-use D1 relay and moves the browser to a clean URL before Better Auth consumes the code. Direct query-string, malformed, expired and replayed Microsoft callbacks fail closed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Forms and submissions                  | Production slice                                                           | The native visual editor writes the normalized Program Cue schema directly, renders supported fields inline, and provides pointer drag creation/reordering with explicit keyboard alternatives. Published schema/settings are immutable, RHF/Zod validates public input, public draft starts/creates recover exact D1 intent without duplicating rows or replaying bearer cookies, drafts recover across offline/reload/tab conflicts, anonymous ownership transfers only after verification, and co-speaker links expire. The public CFP is event-led and exposes dates, venue, deadline, organiser context, an honest completion estimate and every question before identity capture; versioned invitation copy is organiser-controlled, the mobile apply action follows that invitation, programme navigation remains independent of the optional published-speaker showcase, and empty invitation fields add no editorial claims beyond stored event content. Its D1 landing read checks published-version integrity and reads at most eight published speaker identities and relevant headshots; Airtable preview cache misses still validate the complete authoritative provider projection before bounded cache hits are served. Per-version presentation controls and per-question examples are connected in the form builder, whose desktop workspace keeps field editing and the live applicant preview side by side. A verified applicant may import public name/biography from one exact Sessionize profile URL into an unsaved draft for review; tenant/IP/applicant production limits apply before fetching, while redirects, unsupported hosts, oversized/non-HTML responses and missing public profile data fail explicitly, and no provider login or private data is claimed. Application forms expose one-or-more tracks; direct-session forms expose one required programme track. Public and administrator intake persist authoritative track/team joins and immutable names, but deliberately leave routed submissions unassigned until review administration creates assignments. Administrator submission detail derives the immutable form name/version and each selected-track-to-review-team outcome from those records; manual team selections are labelled as overrides, and routing drift fails explicitly. Manual applications support multiple tracks, optional multiple-team override and only event-configured formats; administrator direct sessions require a track and an event-configured format.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Evaluation and decisions               | Production slice                                                           | Team administration, invitations, multiple rounds, rubrics, explicit assignment selection, review locks/revisions, moderation/reopen and decision authority are connected for submission and session targets. Every accepted decision must confirm one of the proposal's submitted tracks; its exact ID/name is retained in the effect snapshot and audit, and released acceptance atomically creates the session on that track plus the speaker graph and explicitly opted-in task templates with their scoped dependencies. Decision notification snapshots preserve rationale and only explicitly selected applicant-facing review feedback; private notes never enter the email source values.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Participants, tasks and resources      | Production slice                                                           | Stable Overview, Applications, Sessions, Tasks, Files, Resources and Profile routes share an authenticated submitter/speaker shell; server-backed route actions own profile, task and file mutations. Published forms remain directly startable, while Applications aggregates owned and claimed proposals and keeps closed or archived submissions readable from their immutable submitted snapshot. Verified draft ownership and successful co-speaker claims atomically create or reactivate accepted submitter entitlement; direct-session paths create or retain the applicable portal entitlement without treating portal access as programme participation consent. Session-targeted tasks identify the linked session while retaining comments and versioned private evidence. Optional event logo, welcome and support values brand both the authenticated participant workspace and the richer public application landing. Organisers open an event-scoped speaker detail route from the roster that reads linked sessions plus every stored file version with its scan and release state; released current versions use an event- and speaker-scoped private download that revalidates role, organisation, asset ownership, signature, clean scan, release and R2 ETag. Missing scan results remain explicit, and unresolved or cross-asset current-version references fail as integrity errors. The full-profile update contract requires every field and edits name, title, organisation, pronunciation, biography and profile status behind a compare-and-set revision, audit event and advertised `speaker.updated` webhook only while the canonical identity is exclusive to the current event; revoked memberships are excluded consistently from the read and atomic update guards. Shared identities remain person-owned, but their speaker detail now reads and atomically updates organiser-authored name/biography/title/organisation from the current organisation profile plus private logistics from the exact event profile, without touching the canonical person. The durable last-saved revision survives reload. Task evidence/dependencies/comments/overrides, exact bulk previews, safe five-minute undo, resource publication/attachments/acknowledgements and automatic reminders remain event-isolated. The minimum hotel and flight forms are typed structured task forms, not a single free-text placeholder. Resource embeds fail closed to deployment-approved exact HTTPS origins, an empty-capability iframe sandbox and the matching response CSP; unsupported URLs are rejected at save rather than downgraded or rendered.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Speaker Network                        | Optional competition production slice                                      | Organisation owners and administrators can search and filter a cross-event person directory, inspect event/session history, attach private notes and case-insensitive tags, save dynamic filtered segments, preview and confirm exact-column CSV imports, review same-name duplicates, and merge only unlinked network-only identities. Directory event/session totals and detail history consistently exclude inactive events. Speaker Network entry, event-roster manual entry and CSV import persist organiser-authored name, biography, organisation and job title in an organisation-scoped contact profile with provenance; a newly created canonical person contains only the neutral email identity, and Network merge enriches only the scoped primary profile. The event-roster command includes the contact/profile, membership, workflow and audit in one guarded D1 batch, preserves an existing participant-owned canonical profile and does not erase existing scoped optional enrichment when the roster form omits it. Migration `0019` moves only untouched identities bearing the deployed old manual command's exact creation provenance out of the canonical profile and fails rather than silently retaining global organiser data when an exact candidate cannot be migrated coherently; participant-updated and genuinely unprovable identities remain unchanged. Network projections, sourcing and outreach prefer the current organisation's enrichment while retaining canonical profile fallback for established speakers. Manual entry and CSV preview/confirmation reject an email that already belongs to a global person without a legitimate current-organisation contact, accepted membership, submission or session relationship; imports fail as a whole rather than silently skipping the blocked row. Merge separately revalidates identity ownership at its mutation boundary and preserves relationship history. A persistent five-stage speaker-sourcing board records compare-and-set moves, fit scores, rationale, timestamped transitions and notes. Adding a contact to an event reuses the canonical identity through the provider-aware speaker service while its admin roster label retains the organisation-scoped Network name. Bulk speaker invitations create an event-scoped durable communication draft and then use the existing exact-recipient preview and explicit delivery confirmation; no provider success is simulated. The underlying `0002_speaker_crm.sql` migration, `/admin/crm` routes and guarded ownership migration `0019` are deployed; the new authorised production mutation has not been exercised against a live organiser-created record. Participant adoption of organiser suggestions is deliberately deferred and no automatic canonical-profile merge occurs. General-purpose CRM remains excluded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Files and privacy                      | Production slice; partial deployed acceptance                              | Every event stores a required strict file policy with canonical upper bounds. Multipart initiation, resume/list-parts, completion and metadata commit revalidate current policy. Private R2 objects remain quarantined until an authenticated scanner result releases them. The companion scanner durably accepts exact jobs, restricts downloads to the private production bucket, refreshes ClamAV signatures before readiness, handles up to 1 GiB on disk and returns an HMAC-signed clean/infected/error verdict without logging signed URLs. A fixed four-slot container pool admits one scan per slot; ordinary capacity waits retain stable affinity, while each explicit durable retry advances deterministically to another slot without concurrent fan-out. Occupied slots keep Workflows waiting with capped durable backoff, while ClamAV readiness has an independent sub-eight-minute cold-start budget. Invalid jobs, object mismatches and unavailable duplicate Workflow states fail immediately. Scanner errors fail their Operation and may be retried only after the unchanged quarantined object is revalidated; each retry uses a distinct Workflow attempt and stale callbacks are rejected. Retention preview/typed confirmation, legal holds, bounded pseudonymisation, credential revocation, file erasure ordering and immutable completion evidence are connected. Production browser multipart, clean release, EICAR quarantine and a scanner-error retry on another slot passed through durable D1 intent, private R2, Queue, the scanner Workflow/Container and signed callback. Sustained live burst-capacity behavior and provider-side erasure acceptance remain outstanding.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Schedule and public programme          | Production slice                                                           | FullCalendar list/day/week views use the same D1 schedule service as keyboard and form alternatives. Moves, resize, unassign and short-lived undo revalidate event, room, speaker, track, capacity and required-resource rules. Deterministic auto-placement keeps every generated session within the event-local 07:00–22:00 working day, including exact-boundary and DST dates, and continues first-fit placement on later days when needed. Draft-only notes/content autosave to the active version; publication requires every scheduled source-public session to have a public, Approved content snapshot and rechecks that boundary atomically and at the D1 status transition. D1 also guards direct published-version recovery when entries are restored, entry reassignment, approval/visibility demotion, snapshot deletion and later source-visibility changes. A blocked draft leaves the last published programme unchanged. Airtable staging applies the same boundary before provider writes, and previously public advisory content is retained with explicit legacy-publication provenance rather than a fabricated reviewer. Public programme, embed, API, ICS and calendar fan-out read public content from the exact published schedule snapshot together with current published speaker identities, and stale publication fields never expose an inactive event or headshot. D1 API cursors bind to a persisted public-projection revision advanced by public-visible event changes rather than scanning event history on each page. Event setup, repository-authority changes, publication, public profile updates and headshot revocation commit their change sequence in the owning D1 batch; routes only broadcast that sequence, and completed idempotent retries do not rebroadcast old work. Repository tests cover event, schedule, session, person and headshot categories, including the real erasure path whose durable change commits with public revocation. The D1 integrity count, session speaker projection and speaker profile projection share one transactional batch, so a concurrent profile edit cannot mix revisions within a response. Before any representation is rendered, the published speaker graph validates exact ID/name pairing and bidirectional session links; malformed D1 or Airtable data fails explicitly. Publication also requires confirmed session participation rather than portal activation and rechecks it atomically. The public programme filters by search, day, track, format and room with a live result count; structured filters and text search keep session and speaker results coherent. Saved personal and shared itineraries expose an ICS export containing only the selected published sessions. The page-local embed builder configures published facets, selectively visible controls, event accent, density, height and speaker-directory visibility, previews the exact generated URL at desktop/mobile widths and copies sandboxed iframe or origin-checked auto-resizing widget code. Unsupported, malformed and stale embed values fail with a specific client error rather than falling back. Session rows, details, speaker profiles and saved itinerary cards preserve the mapping between each speaker and supplied title/organisation while omitting absent affiliation lines. The speaker profile panel reports its session count and rooms and restores focus to its opener when closed. Session lists group by event day under a heading that states the calendar date once and pins under the masthead while that day scrolls; rows carry the clock range, duration, track, format, room and a per-session itinerary toggle named for its session. Arbitrary valid event accents retain their exact decorative colour while deriving contrast-safe text and interaction-state colours. Narrow layouts keep filters, builder controls and descriptions contained and scannable, and reflow rather than drop content: room, track and format stay visible at every breakpoint, including the 320px reflow width where they were previously hidden below 760px. |
| Communications and calendars           | Production slices; core provider lifecycle accepted                        | Resend production delivery and Mailpit local capture share one strict provider contract with no fallback. Browser sends use revisioned, resumable D1 drafts; authoritative preview fingerprints and draft revision are revalidated while the same row transitions to scheduled/queued. Sender profiles/domains, scheduled/automatic work, severity-monotonic webhooks, suppression and retryable operations are connected. Calendar invitations stay bound to the creating provider/account until cancellation; Google/Microsoft OAuth uses encrypted tokens and compare-and-set refresh/failure handling. The production Resend domain/signed webhook and both Google/Microsoft applications are provisioned. A real authentication email was delivered and consumed; durable production test sends reconciled owner and controlled-delivery recipients to `delivered` and a controlled bounce to `bounced`. Live Google and Microsoft consent each persisted one connected D1 account, and both providers completed invitation create/update/cancel lifecycles. Broader recipient sets and a fresh provider-error callback remain external acceptance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Accelevents                            | Production slice; external provider acceptance outstanding                 | Encrypted connection verification, exact mapping/diff preview, explicit no-write dry run, required live confirmation fingerprint, request-bound idempotency and connection-revision snapshot, stable mappings, item retry/skip and a tenant-scoped terminal reconciliation CSV rendered from immutable stored run state are connected. Preview/provider drift and provider-contract gaps fail explicitly. No sandbox credential was available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| AI/agent interface                     | Production slice; external-provider acceptance outstanding                 | The private event Durable Object uses the Cloudflare Agents SDK. Standalone and contextual interfaces read authorised evidence; mutations are allow-listed proposals that require exact preview/approval and durable crash-safe execution. Reminder sends reuse the canonical Communications queue. Organisation owners select Workers AI, OpenAI Responses or Anthropic Messages with audited compare-and-set settings; the selected binding/credential fails fast and never falls back. Workers AI is restricted to Cloudflare-hosted DeepSeek V4 Flash 0731 and translates the shared transcript, function tools and schema requests to its Chat Completions contract; incomplete, refused, malformed and unsupported results fail before presentation. Migration `0023` replaces existing GPT-OSS selections and advances their settings revision. Responses and Messages stream readers cancel rejected provider bodies and always release their locks; malformed events, failed/incomplete terminal states and size violations cannot leave a partial result presented as valid, and the browser clears partial assistant text when its terminal stream contract fails. AI first-pass assessment retries retain immutable failure evidence, require explicit duplicate-charge acknowledgement, expose the running leaf of the durable retry chain with initiator and operation link, and immediately suppress the stale retry action with an honest starting state while its request is pending. Staged or expired running attempts expose an owning-workflow reconciliation action that persists the staged result or records an indeterminate failure without another provider request. A live schema-bound readiness summary is accepted on DeepSeek V4 Flash; live tool-loop, assessment and external-model credential acceptance remain outstanding.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| REST API and webhooks                  | Production slice                                                           | Thirty-three synchronized OpenAPI paths cover published programme families, participant self-service, private collection/item resources, authenticated provider callbacks and administration lifecycles for forms, memberships/invitations, sessions, decisions, tasks, resources, integrations/mappings, operations and evaluation/communication commands. API-key and participant writes persist atomic exact-replay results, side-effect recovery and audit evidence. Worker-level maintenance responses retain the normal structured error/correlation envelope for every `/api/v1/...` request while browser pages receive bounded text. Advertised outbound events are materialised with their domain audit in one D1 transaction, then dispatched post-commit with an explicit undispatched recovery marker. Registered Zod 4 command schemas emit synchronized OpenAPI component schemas deterministically.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Operations and adjacent administration | Production slice                                                           | Command Centre groups six initial setup conditions into four lifecycle phases derived directly from authoritative event, form, review, task, sender and schedule records, then removes the guide when setup is complete; no parallel checklist state exists. The Operation Centre exposes durable status, bounded progress, per-item results and eligible retry/cancel/skip for communications, calendar, Accelevents, Airtable recovery, imports/exports and assistant actions. Blank event creation, provider-aware event cloning, saved views, eight-kind command record search with server-side domain aliases and exact room/track/resource/operation destinations, plus preview/confirm bulk/import workflows use domain services rather than client-owned state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Security, observability and recovery   | Production foundation; partial deployed acceptance                         | Same-origin browser mutation enforcement, scoped hashed API keys, signed webhooks, public abuse rate limits/Turnstile verification, private files, publication boundaries, append-only audit and fail-closed provider configuration are implemented. Production HTTP, Queue, scheduler and health entry points validate the complete binding/secret inventory and reject placeholders before work; health also probes the D1 baseline without treating live third-party availability as local readiness. Anonymous itinerary signing and lookup use one independently required secret; missing, short or authentication-secret-reused values fail readiness and there is no authentication-secret fallback. Migration `0018` and the independently generated production secret are deployed; a live anonymous itinerary create/export/remove cycle produced exactly one VEVENT, and its exact empty test row was removed afterward. A validated `SOURCE_REVISION`, correlation IDs and bounded structured request/Queue/scheduler/provider/backup logs join local evidence. The D1-export Workflow requires an exact non-zero signed-export length and incrementally hashes/counts the same backpressured stream passed to private R2, without a tee branch; immutable-key recovery compares streams sequentially and explicitly cancels an unopened existing body when fresh-source validation fails. The deployed predecessor wrote an immutable checksum manifest to private backup R2, and that exact object passed an isolated remote D1 restore drill with every table count matching. The 14 and 15 August autonomous runs exposed a delayed-first-poll defect; deployed source `5109324` polls immediately and every second and surfaces Cloudflare's inner result error. Its separate 03:47 UTC monitor requires that day's exact manifest and matching SQL bytes in private R2, because live testing proved an absent log series cannot drive Cloudflare's `count < 1` alert. Retained logs are queryable, both Queues report zero-message/zero-byte backlogs, and three scoped error alerts are attached to enabled replacement email policy `ffbf6c4ec51c4c08b3f4c161ca93d871`. Direct tests of the original and replacement policies appear in Notification History as dispatched to the owner address. Real firing incidents `NCRGGQREN0`, `7321V7TT4B` and `QQ6DZGHEYW` produced no Notification History entry, including after canonical-UUID reassociation and policy replacement, so live alert delivery is a reproducible Cloudflare-side acceptance failure rather than verified email routing. The next autonomous cron/monitor, working incident delivery, point-in-time exercise and measured RPO/RTO remain external.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Demo and competition evidence          | Demonstration only / local evidence; production evaluator repository slice | The single rich fixture supplies local demo and production-evaluation data without enabling `/demo` in production. Populated showcase roles coexist with clean SBEK identities, five communication templates and due-dated tasks. Production `/evaluate` provides access-code-gated fixed-person journeys, direct proof links and one explicit fixed submitter activation; exact SBEK aliases route only within that signed fixture context. The production reset is confined to the dedicated fixture organisation, retires evaluator-created events and safe auxiliary people, preserves audits and fails on unsafe or external work. Bundled portraits are demo/evaluation presentation only. The expanded reset completed once in production with all temporary authority removed, and the current release preserves the gated evaluator journeys under the canonical `future-of-events-2027` slug. Fresh SBEK mailbox receipt, scheduled-reminder cron evidence, Forge submission and a completed SBEK/human run remain outstanding.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### Reference-board adoption evidence

- **Production slices; local evidence:** Event Setup persists venue address and
  HTTPS venue-map fields through D1, includes them in Airtable event
  configuration and event cloning, and clears them in the bounded reset. The
  deployed HTTPS programme-hero field remains a read-only legacy projection;
  Branding publication replaces it with the managed banner path and clears it.
  Public content revisions include venue and both legacy/managed presentation
  values so conditional embed/API reads cannot retain stale presentation.
- **Production slice; local evidence:** New review submissions require a
  persisted no-conflict attestation. Conflict declaration retains its existing
  recusal path. Pre-policy submitted or locked reviews remain explicitly
  unattested instead of receiving a fabricated migration timestamp. Reopening
  snapshots the prior attestation as revision evidence, clears the current
  value and requires conscious reaffirmation. Focused reviewer coverage
  verifies submission and reopen/resubmit behavior.
- **Frontend behavior:** Command Centre delivery health no longer synthesizes
  SMS, push or calendar support without delivery records and distinguishes
  provider acceptance from confirmed delivery; upcoming-session labels are
  bounded to the conflicts and session tasks actually queried. Speaker
  preparation treats an empty requirement set as satisfied and describes only
  stored profile status rather than claiming public-session visibility. Restored
  review notes derive their character count from the restored recovery payload.
  Event-local calendar dates drive task due-distance labels, including midnight
  boundaries.

The current repository candidate extends the Operations production slice with
an audited, actor-attributed acknowledgement for terminal failures that expose
neither retry nor cancel in the Operation Centre. Acknowledgement preserves the
failed operation and its error while removing only its active shell alert and
readiness blocker; actionable failures cannot use this path. The failed view
queries failure records directly, prioritises active alerts and exposes the
complete type-filtered history in explicit 50-row pages, so an old alert is not
hidden by newer successful work. Migration `0028` adds the acknowledgement
fields, bounded alert index and triggers requiring timestamp and actor together;
the read path also rejects inconsistent attribution instead of inventing an
actor name. The same transaction persists an operation invalidation cursor and
the route broadcasts it after commit, keeping concurrent views current while
preserving D1 polling when live delivery fails. Focused Worker coverage verifies
eligibility, tenant-scoped persistence, immutable failure status, audit evidence
and alert/readiness removal; the Chromium assistant workflow exercises the
confirmation and preserved archived error. This is repository evidence only
until the migration and candidate are deployed.

### Committee, delivery-health and speaker-link evidence

- **Production slice; deployed; repository acceptance:** Evaluation administration now
  distinguishes incomplete targets (`assignmentCount > 0` and completed reviews
  below assignments) from unassigned targets. The D1 committee thread is
  organisation/event/round/target scoped, audited and idempotent. Evaluators
  cannot read it until their exact non-recused, non-cancelled assignment and
  review are submitted, lose access when reopened, and cannot cross round or
  target boundaries; managers retain read-only access after archival. Focused
  Worker coverage verifies those boundaries. Repository evidence adds a
  newest-50 read boundary, strict keyset cursor and progressive earlier-message
  loading with Worker and Chromium coverage; that pagination change is not
  deployed. Migration `0020` and the earlier application release are deployed;
  a fresh production committee post was not performed. Reactions, mentions,
  editing, notifications and realtime chat are not implemented.
- **Production slice; repository evidence only:** The selected-round unified
  results view is now the chair workbench rather than a second committee board.
  It exposes Coverage, Decision-ready and Moderation presets, transparent
  recommendation distributions and score ranges, recusal/incomplete/split
  flags, expandable rubric responses and permitted comments, proposal decision
  history, direct assignment/moderation/decision actions and 25-row server
  pagination. Assignment count remains authoritative; no configurable review
  target or opaque disagreement score was introduced. Pacing history and bulk
  staged decisions remain deliberately unimplemented.
- **Production slice; deployed; repository acceptance:** Communications History exposes
  a default 90-day event summary, an explicit event-lifetime view, or
  selected-communication delivery health from current D1 delivery states. It
  explicitly rolls opened/clicked into Delivered, separates bounded latest
  recipient unsubscribes from recorded provider suppressions/complaints, pages
  selected recipients and links failures to their exact operation. Existing
  task due/overdue rules are unchanged. Focused Worker coverage verifies state
  bucketing, the bounded default, explicit lifetime selection and tenant/send
  scope; Chromium verifies the panel at the supported mobile width. Repository
  evidence also adds delivery-health covering indexes, direct scoped aggregates
  and fail-fast rejection of invalid periods and unaligned or out-of-range
  recipient offsets; those hardening changes are not deployed. No new provider
  receipt acceptance is claimed.
- **Production slice; deployed; repository acceptance:** Public speaker profiles use a
  server-resolved `?speaker=` deep link, absolute speaker canonical/unfurl
  metadata, Copy link, progressive Web Share and browser history. Invalid or
  unpublished speakers return 404, and unfurl images are omitted unless a
  released anonymously readable headshot exists. Focused Worker/unit coverage
  and the anonymous Chromium URL/history workflow are green. The release is
  deployed; no external social-crawler acceptance is claimed.

### Abstract workflow evidence

The current evaluation-mode worktree adds repository-level production slices
for event-roster CSV preview/confirmation, an event-specific speaker workflow
state, and identity-backed full personal-itinerary calendar export. The workflow
row is authoritative: migration and narrow membership/session triggers use
explicit system provenance without inventing a human updater, and roster reads
fail if linked speaker state is absent rather than deriving a status. CSV and
manual event-roster entry persist organiser enrichment in the current
organisation's contact profile without overwriting canonical person-owned data,
and apply the supplied
event workflow state on both new and existing roster rows, refuses unrelated
existing identities, sends no invitation implicitly and records an idempotent
audited import only after every row is linked. Migration
`0011_event_speaker_workflows.sql`, focused Worker
coverage and Chromium coverage are the intended evidence; no deployment or live
provider acceptance is claimed here.

Independent round dates, scorecards, blind-review settings and reviewer pools
are connected through event-scoped D1 services and the administrator UI.
An active or draft unassigned round can be edited, with stable criterion
identity and scorecard-version forks; only the confirmed final unused draft may
be deleted. A confirmed new-cycle command archives the prior plan as immutable
history and creates a clean active round whose editable rubric is copied from a
visibly identified latest round, while terminal submissions remain terminal and
are reviewable only with published archived-decision provenance.
Round assignment, reopening, conflict recusal and advancement revalidate
persisted windows and current-cycle scope at the mutation boundary. Reviewer
progress is round- and person-scoped; owners and administrators can prepare an
exact-recipient reminder through the existing Communications preview rather
than sending directly. Results support round-scoped stable sorting and an
audited, formula-safe, size-bounded CSV export. Blinded reviewer projections
omit participant identity, identifying references and attachments server-side.
One immutable provider-attributed AI first-pass score/rationale may be generated
for an exact round, rubric and submitted snapshot; a human override is stored
and audited separately, and missing/invalid provider behavior fails without a
simulated score. Responses providers now reject explicit non-completed statuses
before parsing output, and the bounded rationale has a response budget shared
by model reasoning and final output. A failed generation remains durable and is
never retried automatically; an explicit acknowledged retry creates a separately
idempotent, linked attempt and prevents another concurrent attempt for the same
target.
Focused Worker coverage exercises review advancement,
archived-cycle decisions, late co-speaker claim/profile/session/task propagation
and AI persistence/idempotency. The ABS-S2/S3 Chromium workflow exercises cycle
creation, round/rubric edit and deletion, reviewer pools/progress/reminder
draft preparation, result sorting/export, server-side blinding, an explicit
decision override and confirmed co-speaker invitation. On 14 August 2026, a
synthetic live Workers AI probe against the then-selected
`@cf/openai/gpt-oss-120b` contract returned `incomplete` with
`max_output_tokens` under an intentionally tiny budget and returned completed,
schema-valid assessment JSON under the corrected 4,000-token budget. The
application-path correction is deployed in release `481705c`. That evidence
belongs to the predecessor model. A later live schema-bound readiness request
accepts DeepSeek V4 Flash; a real DeepSeek assessment retry and the invited
person's claim remain provider/persona acceptance.

### Deterministic auto-placement evidence

The draft Schedule Planner exposes deterministic first-fit auto-placement with
an exact preview and explicit confirmation. Confirmation revalidates the
schedule, event, conflict-policy and session revisions, applies the accepted
placements atomically in D1 with durable idempotency, reports honest unplaced
reasons and leaves the schedule unpublished. Focused unit, Worker and Chromium
schedule tests verify this AIA-08 production slice.

## Audit and revision evidence

- **Production slice; deployed:** Audit writes
  now require explicit actor kind, ingress origin and metadata contract version
  across every runtime writer. Pre-contract rows remain readable as version 0
  but are labelled historical and cannot produce version-1 display summaries.
  Audit evidence is append-only and no longer cascades
  with organisation, event or person deletion; the documented normal lifecycle
  is archival until an explicit contractual purge workflow and retention period
  are approved. Activity uses `(created_at, id)` keyset pagination, an
  independently queried actor selector and filter/scope-bound cursors. Event
  administrators remain event-scoped; only accepted organisation-wide owners
  and administrators can select organisation scope. The UI receives only
  versioned, action-schema-validated display summaries rather than generic
  metadata values; known display actions with missing or malformed version-1
  facts are rejected at the database write boundary. Invalid filter lengths,
  filter values and internal reader bounds fail instead of being clamped,
  truncated or ignored. Migration, authorization, cursor and focused Worker tests
  are repository evidence. Migrations `0030_audit_contract_and_retention.sql`
  and `0031_contextual_revision_evidence.sql` are deployed; retention-policy
  acceptance is not claimed.
- **Production slice; deployed:** Submission
  administration shows an inline status timeline and retained submitted-save
  revisions. Chair review results show private saved-review history using the
  exact scorecard ID, version and criterion snapshot stored with each new
  revision; partial, duplicate or score/criterion-mismatched modern evidence
  fails the read, while legacy revisions remain explicitly without that
  evidence. Session
  content history computes compact adjacent-revision changes at read time.
  Speaker and organiser profile pages show read-only public-field revision
  evidence, including atomic released-headshot replacement and removal, while email,
  travel preferences and provider payloads are excluded. Restoration remains
  deliberately unavailable for public speaker profiles.

## Content management workstream evidence

- **Production slice (CNT-11/12):** Schedule-version content now has an
  attributed, append-only revision history. Every edit and status transition
  records the exact title, description, track, format, duration, visibility
  and resources. The reader computes compact changes against the adjacent
  retained revision without persisting a second diff representation. An
  administrator can inspect prior values and restore any retained revision as
  a new Draft without deleting later history.
- **Publication boundary (CNT-13):** Draft, In review, Approved and Changes
  requested remain explicit revision-checked editorial states. Editing or
  restoring returns only the draft content to Draft. Publication requires each
  scheduled source-public session's exact snapshot to be public and Approved;
  the preview links every blocker to review, and service, atomic D1 and Airtable
  staging boundaries fail fast on drift. A blocked draft leaves the previous
  published programme intact. Existing content published under the former
  advisory rule is retained with `legacy_publication` provenance and no
  fabricated human approver.
- **Central library (CNT-14):** The administrator Content & files route reads
  at most 50 event assets and their current versions per page. Retained version
  metadata is loaded only when its disclosure opens and remains bounded to 50
  versions per request. Individual and ZIP downloads
  require the current released, signature-valid, clean R2 object. ZIP export
  previews an exact bounded manifest, requires confirmation, revalidates each
  version and ETag, preflights R2 metadata before returning download headers,
  preserves duplicate filename extensions and conditionally opens and
  pull-streams only the current stored entry with response-cancellation
  through a dedicated binary resource route rather than a document action.
  A speaker-scoped task file is attributed to its linked session only when
  exactly one event session matches that speaker; ambiguous relationships stay
  visibly unassigned instead of selecting an arbitrary session.
- **Scope boundary:** This is session programme content and existing private
  file delivery, not a general-purpose CMS. Live R2/scanner acceptance remains
  external.

## Event branding workstream evidence

- **Production slice:** `/admin/branding` owns a server-backed event branding
  draft with compare-and-set revision, representative desktop/mobile previews
  for the application, participant workspace, programme and email, and one
  confirmed publication boundary. Publication atomically advances the event
  and public-projection revisions, records audit/change evidence and projects
  the existing event configuration to Airtable when Airtable is authoritative.
  Non-no-op mutations require a positive durable event-change sequence;
  missing change evidence reports an explicit committed warning. Event Setup
  rejects legacy-field attempts to bypass the branding publication boundary.
- **Managed brand assets:** Event administrators can upload bounded JPEG, PNG
  or WebP logos and banners. Program Cue checks the declared MIME against the
  byte signature, stores the bytes under an event-scoped private R2 key and
  records the exact ETag and byte size. Draft reads require
  event-administrator authority; anonymous asset routes resolve only the logo
  or banner referenced by the active event's published snapshot and revalidate
  that ETag. Migration `0029_event_branding_publication.sql` follows the
  deployed `0026`–`0028` sequence. A publication race returns a non-cacheable
  503 retry response rather than stale bytes or a false not-found result.
- **Published surfaces:** The published accent, logo, banner, welcome and
  support link reach the public application, participant workspace, programme,
  embeds and communication email. A deployed external logo or programme hero
  remains live only until the first managed Branding publication, which clears
  those retired authoring fields rather than silently preferring two sources.
  Program Cue attribution remains visible.
- **Scope boundary:** Organisation brand defaults, custom fonts, arbitrary CSS,
  per-event custom domains and white-label attribution removal remain not
  implemented. Replaced brand objects remain event-owned history until an
  explicit retention/deletion workflow is designed. Event cloning is blocked
  while brand images, a legacy programme hero or unpublished branding changes
  exist; private R2 asset copying is not implemented and is never silently
  omitted.

## Public programme gallery workstream evidence

- **Production slice (EMB-01/04/09/12/13/14):** The anonymous public programme now exposes the published D1/Airtable snapshot through the existing service at the sessions overview, `/speakers`, `/agenda`, `/schedule` and `/gallery` surfaces. Surface selection uses the matched React Router parameter, so framework `.data` revalidation URLs cannot be mistaken for a public surface and return a false 404. Sessions and chronological itinerary cards include complete public metadata; speakers are surname-ordered; gallery search and the keyboard-accessible detail panel use the same published speaker/session graph.
- **Data boundary:** Public D1 and Airtable projections require a published schedule version, public published sessions/relationships, public Approved content snapshots and published profiles. Approval provenance remains a database invariant and inconsistent state fails explicitly; the administrator UI never fabricates a missing approver. Missing, non-public or non-Approved content for a source-public session blocks publication, and Airtable staging applies the same boundary before provider writes. Headshot URLs still require released-clean current-version predicates. Only Priya Shah, Alex Morgan, Priya Raman and Marcus Okafor may use explicitly allowlisted bundled portraits on the canonical event, and only in local demo or production evaluation mode; any non-deleted real headshot asset suppresses that person's bundle. Anonymous itinerary rows use an event-specific HMAC of a signed, expiry-bound browser identifier, preventing database-level correlation across events and organisations while retaining one browser cookie. The portraits are presentation-only data, not participant upload infrastructure or an ordinary production fallback.
- **Accessibility evidence:** Description and biography expansion controls expose `aria-expanded`/`aria-controls`; the gallery card supports pointer and keyboard activation, has an explicit close control, preserves search state and returns focus to the opener. Agenda session details likewise expose an explicit close action and restore focus to the exact trigger. Itinerary calendar export reports that the browser download was requested instead of leaving activation silent. Focused unit, Worker and anonymous Chromium coverage verifies these behaviors.
- **Embed builder:** The page-local builder generates and previews sessions, speakers, agenda, schedule and gallery widgets from the same published snapshot. Session titles and speaker names remain the identifying minimum. The speaker-details field consistently controls rich speaker blocks, profile links and detail-panel activation across every surface; images, affiliations, biographies/pronunciation and linked sessions/counts remain independent subfields within that rich content, while speaker-directory visibility is a separate sessions-overview option. Generated iframe and auto-resizing widget snippets preserve the chosen surface and fields, while malformed values fail explicitly. The functioning sandbox retains same-origin semantics because an opaque-origin browser trial blocked the framework module graph; stronger isolation requires a dedicated embed origin rather than broad asset CORS.
- **Managed embed production slice:** Named D1 records add immutable stable slugs, compare-and-set configuration revisions, optional operator installation notes and audited draft/active/paused/revoked lifecycle controls without removing stateless snippets. The admin uses the existing exact preview and a plain before/after summary before activation or configuration changes. Public managed URLs read only the current published snapshot: draft/missing return 404, paused returns a branded non-cacheable 503 with `Retry-After`, revoked irreversibly returns non-cacheable 410, and active representation ETags include the configuration revision. Managed URLs reject query configuration and corrupt persisted JSON fails explicitly.
- **Scope boundary:** Automatic installation detection, deployment analytics, arbitrary CSS, XML output, a generic diff framework and participant upload infrastructure remain outside this workstream.

## Requirements traceability

| Requirement IDs           | Verified status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OBJ-001–006               | The connected local workflow covers application, evaluation, decisions, onboarding, scheduling, publication, communications and integrations. Replacement readiness still requires deployed/provider acceptance.                                                                                                                                                                                                                                                                                             |
| ADM-001–005               | Command Centre, blank D1/Airtable event creation, Event Setup, invitations, organisation/event grants, explicit switching and the route/role matrix are connected.                                                                                                                                                                                                                                                                                                                                           |
| CFP-001–009 / SUB-001–007 | Form authoring/publication, conditional schemas, anonymous and verified drafts, co-speaker claims, direct-session intake, admin grids and lifecycle commands are connected.                                                                                                                                                                                                                                                                                                                                  |
| EVA-001–009               | Teams, invitations, multi-round review, assignments, mixed rubrics, moderation/reopen, decisions and acceptance onboarding are connected.                                                                                                                                                                                                                                                                                                                                                                    |
| ABS-01/02/03/07           | Independent round configuration, round-scoped reviewer pools, numeric/dropdown/free-text criteria and round-level blind-review server enforcement are verified by focused Worker tests and the ABS-S2/S3 Chromium workflow; broader evaluation capabilities remain tracked under EVA-001–009.                                                                                                                                                                                                                |
| COM-001–006               | Email provider selection, sender provisioning, versioned templates, scheduled sends, automatic reminders, receipts/suppression and calendar OAuth/lifecycle are connected. Live Resend authentication delivery, tracked delivered/bounced receipts, both social sign-ins, both calendar-provider connections and both providers' invitation create/update/cancel lifecycles are verified.                                                                                                                    |
| SCH-001–007               | FullCalendar list/day/week planning, configuration, breaks/resources, resize/unassign/undo, content snapshots, publication conflicts and exact public/calendar reads are connected.                                                                                                                                                                                                                                                                                                                          |
| DSH-001–003               | Readiness, record-aware navigation/search, operation health, durable progress and event-scoped realtime invalidation are connected.                                                                                                                                                                                                                                                                                                                                                                          |
| NFR-001–005               | Typed builds, indexed server pagination, local performance harness, automated accessibility/cross-browser coverage, security controls, observability and recovery mechanics exist. Production RUM/scale, live recovery and manual accessibility acceptance remain outstanding.                                                                                                                                                                                                                               |
| OPT-001–006               | Multi-round evaluation, advanced task/resource flows, AI assistance, D1/Airtable event clone, import/export, saved views and higher-polish operational UI are connected.                                                                                                                                                                                                                                                                                                                                     |
| WVD-001–003               | Accelevents export/reconciliation, versioned resources/files and responsive public programme/itinerary slices are connected; live provider acceptance remains external.                                                                                                                                                                                                                                                                                                                                      |
| OUT-001–005               | General-purpose CRM, broad marketing automation, CMS, payments and multilingual expansion remain deliberately excluded. Speaker Network is an explicit, bounded SBEK extra-credit slice constrained to programme-speaker relationships, sourcing and event-specific invitations; it is not claimed as frozen base scope.                                                                                                                                                                                     |
| CMP-001–013               | Repository evidence exists. Forge, deployed evaluator URL, competition submission, reimbursement, judging and walkthrough evidence are external and unverified.                                                                                                                                                                                                                                                                                                                                              |
| TEC-001–009               | The Worker/D1/R2/Queue/Workflow/Durable Object architecture, multi-event isolation, 33-path API, generated OpenAPI component schemas, provider boundaries, observability and recovery code are deployed. Retained logs, zero-backlog Queue metrics, a live Workflow backup, isolated restore, three scoped alerts and repeated firing alert exercises are verified. Autonomous post-fix cron completion, Cloudflare's failed Workers-alert-to-Notifications handoff and measured RPO/RTO remain outstanding. |
| UX-001–010                | Command search/saved views, readiness drill-downs, review workspace, consequence previews, draft recovery, safe undo, contextual/standalone AI, demo walkthroughs, isolated authoring previews and the unified Operation Centre are connected. Manual assistive-technology acceptance remains external.                                                                                                                                                                                                      |

## Verification evidence

The reproducible gates are:

```bash
npm run check:core
npm run check
```

Application release `6db71bf` passed the complete core gate: 60 unit files with
335 tests, 161 Worker files with 1,277 tests, the Agents Durable Object test,
production builds, 54 configuration tests, migration parity at 95 application
tables, 107 indexes and 88 triggers, a 136,880-byte clean-room recovery drill,
synchronized OpenAPI at 33 paths and 459 internal references, and the scanner's
10 container tests. The five-shard application browser run passed 135 cases
with two intentional skips; one draft-recovery case encountered a parallel
IndexedDB deletion race, then passed in an unchanged focused serial rerun. The
unchanged public-site release retains its separately passing 14-case browser
gate. The scanner-only `c9e1287` release separately passed its focused scanner,
configuration, Worker and local production-container clean/EICAR checks.
Backup/monitor source `5109324` separately passed 23 focused Workflow tests,
generated typecheck and the complete core gate: 161 Worker files with 1,278
tests plus the unit, agent, build, configuration, schema, recovery and OpenAPI
checks. The full browser gate was not rerun because the correction changes only
the scheduled backup Worker path and its focused/core coverage.
Application source `a96147c` passed the complete release gate: 60 unit files
with 337 tests, 163 Worker files with 1,294 tests, the Agents Durable Object
test, production builds, 54 configuration tests, migration parity at 96
application tables, 109 indexes and 96 triggers, a 144,490-byte clean-room
recovery drill, synchronized OpenAPI at 33 paths and 459 internal references,
and the scanner's 10 container tests. The five-shard browser run passed 136
cases with two intentional skips after the known parallel IndexedDB
draft-database teardown race passed unchanged in a focused serial rerun.
Application candidate `24a4038` passed TypeScript, 61 unit files with 341
tests, 165 Worker files with 1,300 tests, the Agents Durable Object test, 55
configuration tests, migration parity at 97 application tables, 111 indexes
and 96 triggers, a 146,253-byte clean-room recovery drill, synchronized OpenAPI
at 33 paths and 459 internal references, and the scanner's 10 tests. Its
concurrent build lane exposed the missing Vite alias configuration introduced
by the independent-TypeScript-project refactor. Source `14b61ab` adds the
explicit absolute application alias and then passed generated TypeScript,
configuration tests and standalone client/SSR production builds; the full core
orchestrator was not rerun after that build-only correction.
Application candidate `009feb7` passed 61 unit files with 341 tests, generated
TypeScript, production builds, 55 configuration tests, migration parity at 97
application tables, 113 indexes and 97 triggers, a 149,671-byte clean-room
recovery drill, synchronized OpenAPI at 33 paths and 459 internal references,
and the scanner's 10 tests. Its Worker lane passed 164 files and 1,307 tests;
one large schedule workflow exceeded its five-second test timeout while another
worktree was concurrently CPU-bound, then passed unchanged in a focused rerun
under the normal timeout in 4.22 seconds. The Agents Durable Object test passed
separately. The production-discovered DeepSeek corrections through final source
`27a9941` passed generated TypeScript and all 14 focused provider-boundary tests.
The browser gate was not rerun because the correction changes only the
server-side DeepSeek reasoning parameter for schema-bound requests; the exact
production request was exercised instead.
Application candidate `0fa84a1` passed generated TypeScript, production builds,
61 unit files with 345 tests, 167 Worker files with 1,320 tests, the Agents
Durable Object test, 55 configuration tests, the scanner's 10 tests, recovery
and synchronized OpenAPI validation. Its core gate correctly rejected the two
new migrations that both used sequence `0026`; all other lanes passed. Final
source `0eac9fb` renumbers the operation-acknowledgement migration to `0028`,
after which migration validation passed at 97 application tables, 114 indexes
and 99 triggers. The full browser gate was not rerun; focused production role
smokes exercised every materially changed surface after deployment.
Application candidate `fb38329` passed the complete core gate: 61 unit files
with 345 tests, 168 Worker files with 1,327 tests, the Agents Durable Object
test, production builds, 55 configuration tests, migration parity at 98
application tables, 115 indexes and 99 triggers, a 153,130-byte clean-room
recovery drill, synchronized OpenAPI at 33 paths and 459 internal references,
and the scanner's 10 tests. Its focused desktop-Chromium branding workflow
passed draft editing, private logo/banner upload, representative preview,
confirmed publication and application, participant and programme projection.
The full browser gate was not rerun because this release used the focused
observable workflow plus the complete cross-cutting core gate.
Application candidate `ba06796` passed the complete core gate: 61 unit files
with 347 tests, 171 Worker files with 1,350 tests, the Agents Durable Object
test, production builds, 55 configuration tests, migration parity at 99
application tables, 119 indexes and 104 triggers, the 235-writer audit
provenance contract, a 161,302-byte clean-room recovery drill, synchronized
OpenAPI at 33 paths and 459 internal references, and the scanner's 10 tests.
Its focused desktop-Chromium evaluation run passed all five reviewer,
administration, chair-resume, waiting-state and invitation-handoff cases. The
production cutover exposed one evaluator-created decision draft whose deployed
preview predated two now-required fields. Migration
`0032_decision_draft_preview_contract.sql` explicitly adds the privacy-safe
legacy values without replacing existing evidence; its dedicated forward
migration case and complete migration validator passed. The complete core gate
was not repeated for that data-only correction; the affected production route
and persisted contract were exercised directly after migration.

## Deployment evidence

Application source `ba06796` is deployed at `app.programcue.com` as Worker
version `6a2dfbd6-3058-428f-8e46-b4373ee4190c`, and scanner source `c9e1287`
is deployed at `scanner.programcue.com`; release-stamp commits `c4993cd` and
`a5e1bab` record those sources. The current application version is at 100%
traffic. Migrations `0030_audit_contract_and_retention.sql` and
`0031_contextual_revision_evidence.sql` applied before the Worker cutover;
production-discovered migration `0032_decision_draft_preview_contract.sql`
then upgraded five legacy decision previews and is recorded in commit
`58d41d9`. The WNAM D1 ledger retains 32 migrations, `quick_check=ok`, and
foreign-key inspection returns no rows. The explicit audit provenance columns,
insert/display contracts, append-only guards, speaker-profile revision table
and indexes, and exact review-scorecard evidence columns are present. All
pre-contract audit rows retain explicit historical/version-0 labels. A fresh
evaluation organiser selection persisted a version-1 object with explicit
`system` actor kind and `internal` origin, and every retained decision preview
now has both required fields.
The separately deployed public website remains live at `programcue.com` and
`www.programcue.com`. Health returned source `ba06796`; sign-in, evaluation
access, the canonical published programme and the public programme API returned
HTTP 200. A fresh production evaluation organiser selection returned the
expected 303 boundaries; Evaluation administration, Operation Centre and
Submissions rendered their identifying content, and speaker detail returned
HTTP 200. The first Evaluation-administration smoke detected the legacy draft
contract failure with HTTP 500; after migration `0032`, the same route rendered
with HTTP 200. Earlier production evaluation identity selections rendered
organiser Command Centre and tasks, the reviewer workbench and speaker
dashboard with HTTP 200. Earlier
production Chromium acceptance of the same fixture rendered
the native Call for Speakers Form Builder with ten authored fields and all six
palette controls, while anonymous Chromium rendered and hydrated the published
application and programme without an application-owned console error. The
reset-only endpoint remains unavailable with HTTP 404.

The deployed contextual-AI response ceiling is 4,000 tokens. Program Cue
renders exact readiness snapshot values, blocker metadata and action links
natively, while malformed, incomplete, duplicate or unknown model output fails
instead of being presented. A live DeepSeek request correctly failed closed
after medium reasoning consumed that entire budget. Omitting the reasoning
parameter then produced one success followed by another 4,000-token failure,
proving that omission did not reliably disable provider-default reasoning.
Source `27a9941` sends the binding's explicit `null` reasoning value for
schema-bound output while retaining medium reasoning for open-ended/tool
requests. Three consecutive production evaluation-organiser requests returned
HTTP 200 in 10, 15 and 18 seconds and persisted three completed,
provider-attributed operations for
`@cf/deepseek-ai/deepseek-v4-flash-0731`. This accepts the deployed structured
readiness path, not every DeepSeek tool/assessment path or external model
credentials. The production deployment configuration and 23-secret preflights
passed.

Scanner-only source `c9e1287` is deployed with ClamAV 1.4.6 pinned by immutable
multi-architecture digest. A fresh production Chromium session completed the
actual participant Uppy workflow through resume lookup, signed multipart R2
upload and completion. The first bounded cold-start attempt produced a signed
error callback, kept the version quarantined and marked its durable Operation
failed. Explicit retry succeeded through the private-R2 proxy and a signed
clean callback before D1 released the file. The exact mutable test data and R2
object were removed; append-only audit evidence remains. Separate production
clean and EICAR probes verify clean release and malicious quarantine.

On 15 August at 07:15 UTC, the scanner alert detected a Cloudflare Containers
`ContainerState.update` internal alarm exception with reference
`makudm19k86ps0vtg3e3si22`. The scanner application remained active, its
affected slot was running in London, `/health` returned source `c9e1287`, and
the latest 20 scan Workflows were all complete. This is provider-platform
evidence rather than an application scan failure; recurrence or a failure to
resolve should be escalated to Cloudflare with that reference.

Live provider acceptance covers an owner Turnstile/Resend magic-link flow,
tracked Resend delivered and bounced receipts, Google and hardened Microsoft
sign-in, both calendar-provider connections and invitation create, update and
cancellation lifecycles. Airtable, Accelevents, external model providers,
broader recipient sets and fresh failure callbacks from those third-party
providers remain external acceptance boundaries.

The deployed D1 backup Workflow produced an immutable checksum-manifested
private-R2 export, and that exact object passed an isolated remote-D1 restore
with matching application-table counts, indexes and triggers, no foreign-key
violations and `quick_check=ok`. This was an API-triggered acceptance run. The
delayed-first-poll defect found by the next two autonomous runs is corrected,
and a later daily R2 monitor now converts missing or inconsistent backup
evidence into an alertable error. The next autonomous cron/monitor,
point-in-time recovery exercise and measured incident RPO/RTO remain
outstanding. Retained application/scanner logs and sampled traces are
queryable. Three scoped alerts are attached to an enabled email policy and
delivery exercises reached Cloudflare's firing state. Direct policy tests are
recorded as dispatched, but three real firing incidents produced no
Notification History entry; the Workers-alert-to-Notifications handoff remains
a Cloudflare-side acceptance failure.

## Remaining acceptance work

The repository now contains production-safe evaluation-fixture tooling plus an
explicit production-only evaluator access layer. When enabled, `/evaluate`
accepts a private access code and issues a signed short-lived session for only
the fixed fixture identities; ordinary membership authorisation and real
providers remain in force. Missing or weak access/signing configuration fails
runtime readiness, and identity/profile loss fails as fixture unavailability
rather than anonymous access. A separate temporary bearer secret can expose one
POST-only operator reset for the dedicated Future Events Association
organisation and event. The operation validates four distinct
non-reserved evaluator addresses, tenant/identity collisions, production D1,
R2 and Workers AI bindings, the selected Resend provider and Resend's live
verified-domain status through a temporary full-access key before destructive
cleanup. A first bootstrap may create dedicated canonical seed rows before that
remaining cleanup preflight; those fixture-only inserts are not a completed
reset. It then resets the full dedicated fixture-organisation scope: the
canonical event is restored, evaluator-created events are retired, their
event-scoped D1/R2 state is cleared, and credentials and outstanding
authentication tokens for every exposed fixture identity are revoked. The four
routed evaluator addresses remain deliberately unverified because `/evaluate`
provides the bounded evaluator access path; ordinary mailbox sign-in remains a
separate real-provider exercise. The completed reset configured the fixture
organisation for the then-selected Workers AI `@cf/openai/gpt-oss-120b`,
installed a verified sender and verified the exact result. Migration `0023`
moves that deployed selection to
`@cf/deepseek-ai/deepseek-v4-flash-0731`; future resets require the same exact
DeepSeek selection. This expanded organisation-scoped reset is deployed in source
`33932fe` and completed once in production on 14 August 2026. The reset reported
four clean scenario identities, one verified sender and the required Workers AI
configuration. All six reset-only Worker secrets were removed, the dedicated
full-access Resend key was revoked and proved invalid, and the reset endpoint
returned HTTP 404. No evaluator mailbox magic-link delivery is claimed.

1. Report the historical flagged calendar callback to Google Safe Browsing. Both provider connections, both social sign-ins, both invitation/update/cancellation lifecycles and the owner Resend magic-link path are complete. Any Google-requested verification remains provider-side.
2. Exercise a fresh third-party provider-error callback plus Airtable authority/recovery, Accelevents dry/live reconciliation and external model-provider paths. Browser/Uppy multipart, clean release, EICAR quarantine, scanner-error/retry and tracked Resend delivery/bounce reconciliation are complete.
3. Confirm the next autonomous D1 Workflow cron writes its daily backup and the 03:47 monitor verifies it; the corrected Workflow, exact-R2 restore, empty Queue/DLQ inspection, scanner-health alert, application/Queue alert, backup-error alert and firing exercises are complete. Escalate Cloudflare's reproducible failure to hand real Workers Observability incidents to Notifications, verify incident delivery after resolution, then measure incident RPO/RTO.
4. Collect deployed p75 RUM and production-like scale evidence; retained structured logs are queryable, while trace continuity still needs acceptance.
5. Complete manual screen-reader, keyboard-only and contrast/zoom acceptance; automated accessibility coverage is supporting evidence, not a substitute.
6. Supply the Forge repository, deployed evaluator URL, competition submission and recorded walkthrough evidence outside this workspace.
7. Complete security acceptance with a nonce/hash-based application content security policy and explicit third-party provider allow-list, a deployed penetration test, a dependency-policy gate, a secret-rotation exercise and a production access review.

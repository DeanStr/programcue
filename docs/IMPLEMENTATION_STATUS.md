# Verified implementation status

Last verified: 2026-08-21.

This is the canonical implementation audit and requirements traceability record. The product specification remains authoritative for intended scope; this file records observed code, focused tests, deployment evidence and bounded production acceptance.

Status terms:

- **Production slice** — the real Worker path is authorised, validated and backed by D1/R2/Queue/provider boundaries. It does not imply that a production deployment or live provider was verified.
- **Production foundation** — shared runtime or infrastructure used by production slices.
- **Demonstration only** — explicitly environment-gated seed or simulation, never a production fallback.
- **External acceptance outstanding** — the in-repository path exists, but credentials, deployed resources or independent acceptance evidence are unavailable in this workspace.

### Current application deployment

On 21 August 2026 the no-store production health endpoint reported exact source
`8a0c39ff268c9c78822111095f479313de7b6595`. That release-stamp commit has tested
source `3108d2d472f949528aadac7aefaf3783f107686c` as its parent and contains every
application migration through `0049_task_instance_configuration_snapshot.sql`.
The ordinary release path requires the remote migration ledger and deployed
schema to match that checkout before it deploys the unchanged build and verifies
the exact health revision. The deployment statements below are reconciled to
that release; they do not turn focused repository tests into fresh production
workflow or external-provider acceptance.

## Phase 0–7 architecture milestone

| Phase                                      | Verified outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Remaining boundary                                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 0 — application foundation                 | One React Router/TypeScript Worker, Program Cue design system, Better Auth/D1 identity, explicit organisation/event roles, audited multi-event selection, blank event creation with explicit D1/Airtable authority, fail-closed Airtable activation/recovery and a table-driven role/tenant acceptance matrix. The production Worker, bindings, secrets, owner and initial event are deployed. A real Turnstile-protected Resend magic link was requested, delivered and consumed into an active owner session. Microsoft identities whose email claim is not provider-verified must complete that same email proof before an explicit, session-bound account link; direct sign-in never trusts the claim. Live Google and hardened Microsoft sign-in are verified.                                                                                                                            | Broader invited-user and participant authentication acceptance remains external.                                                   |
| 1 — submissions                            | Immutable form versions, the Program Cue-native visual editor/renderer, React Hook Form/Zod validation, conditional fields, intent-bound exact-replay anonymous/verified drafts, expiring co-speaker claims, public direct-session intake, server-paged TanStack submissions grid and durable confirmation work are connected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Submission-verification delivery and draft-ownership acceptance remain external.                                                   |
| 2 — evaluation                             | Teams/invitations, multi-round plans, mixed weighted rubrics, per-round ordered reviewer recommendation choices with immutable review-history snapshots, submission and session targets, assignments, anonymised review, D1 autosave/recovery, recusal, moderation/reopen, final decisions and atomic accepted-session creation are connected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Live invitation/decision delivery and evaluator acceptance are external.                                                           |
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
POST action request and the private cache policy. The change is included in
production source `8a0c39f`; no fresh production acceptance of that exact route
boundary is claimed.

## Public website

**Production foundation; deployed acceptance for the pre-guide surfaces:** A
separate static-asset Worker serves the anonymous `programcue.com` home,
privacy, terms, product guide and not-found surfaces without application data
bindings, cookies, scripts, analytics or an authorisation dependency. The
homepage presents the combined sign-in/account-creation entry point, an
explicitly illustrative programme readiness workflow, outcome-led capabilities,
operational trust boundaries and the required Google integration disclosure.
The product guide at `/guide` is a static, task-oriented walkthrough. Role
entry pages cover evaluators and speakers/submitters; organiser chapters
cover accounts, event setup, applications, review, speakers, scheduling,
communications and operations. The 19 August 2026 copy matches current
product names and rules: Command Centre Programme setup in four phases,
per-round recommendation choices, visible assigned reviewers, required
conflict-of-interest answers, portal invitation versus session
confirmation, publication blocked by unconfirmed speakers, Track/Format
questions from Event settings, and public Programme, Timetable, itinerary
and event-website pages. It does
not read event data. Signing up is
described as login-only; a new conference workspace is requested through
support, after which organisation owners and administrators can create
further events. The administration command palette and the participant
workspace link to that public guide without replacing an event support URL. Configuration
contracts cover both Custom Domains, canonical routing, crawlability, social
metadata, content and anchor integrity, the declared Google scopes and Limited
Use statement, and the absence of production data bindings. Focused Playwright
coverage exercises the real Worker at desktop/mobile widths for reachability,
keyboard skip navigation, WCAG A/AA checks, 320-pixel containment and reviewed
homepage/privacy/guide visuals.
Release `303912c` is deployed as `program-cue-site` Worker version
`b2b428fb-f1ec-4fcf-ab33-829cd59eb4a4` with both production Custom Domains.
Live anonymous checks returned 200 for home, privacy, terms, robots and sitemap;
the not-found surface returned 404; `www` and plain HTTP canonicalised in one
301 to the secure apex URL; and HTML responses carried the checked CSP and
HSTS. Those live checks predate the product guide pages; deployed acceptance
for `/guide` and its articles is outstanding until the next `program-cue-site`
release. Cloudflare's zone-level managed robots policy prepends content signals
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

A focused Chromium regression now re-adds the confirmed Priya Shah fixture
with conflicting manual-entry profile values, reloads the roster, and verifies
that both her confirmed workflow status and participant-owned profile remain
unchanged.

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

Assigned tasks now persist their evidence mode and validated configuration
snapshot instead of joining mutable template configuration at read time.
Link-visit tasks require an organiser-configured, credential-free HTTPS
destination, render a safe external action and complete only after a separate
participant acknowledgement; participant-entered evidence URLs are removed.
The remote migration preflight blocks snapshot migration `0049` when legacy
link or file tasks remain ambiguous, requiring explicit remediation rather
than a compatibility fallback.
It checks active templates, referenced historical templates and anomalous
direct assignments; completing or waiving an instance does not clear the gate,
and it reports every affected ID for explicit reviewed repair or removal before
deployment.
Public submission redirects select the exact submitted application and present
a primary in-page management action. Confirmation intent snapshots an absolute,
credential-free, submission-ID-based management URL before Queue dispatch,
requiring HTTPS under production security while retaining HTTP local
development. Queue materialisation validates that exact durable route; the
applicant-authorised route returns non-cacheable denials, resolves the form's
current slug and sends a clean browser through existing verification. An exact
non-draft submission URL can load its saved form version after closure or
archival while the ordinary public form remains unavailable; verified ownership
is required and the immutable submitted answers render read-only. Delivery
includes the product-owned management link without re-reading mutable routing
data. Confirmation authoring hides and rejects custom buttons and previews the
fixed action. The participant workspace action
is server-gated to a compatible ordinary session and accepted event role.
Direct participant profile uploads are headshot-only. Session
deliverables are explicitly session-scoped task evidence, while reusable
participant documents are explicitly speaker-scoped; upload authorization
rejects absent or mismatched file-purpose configuration. The Files aggregate
labels deliverables from the exact task/session relationship without offering
an invalid participant erase control. Current session membership, rather than a
stored task owner, authorizes every participant task, comment, upload, evidence
history and download surface for session-targeted work; focused race coverage
also rechecks that relationship at the completion, comment and upload mutation
boundaries. Task evidence accepts MP4/WebM session
video against the event's video limit in browser validation, declaration and
multipart completion; other evidence retains the supporting-document limit.
Private task API reads return the validated immutable configuration written at
creation, and template assignment's exact-definition duplicate check includes
active direct/API-created tasks. Administrators retain explicitly labelled,
non-clickable visibility of legacy participant-submitted link evidence without
reintroducing that input into current completion behavior.
These changes and migration `0049_task_instance_configuration_snapshot.sql` are
included in production source `8a0c39f`; the focused tests remain the acceptance
evidence for the individual boundaries.

Schedule placement errors identify the affected speaker and both clashing
session titles instead of reducing a rejected overlap to a transient conflict
count. The programme embed builder uses one labelled native output-format
selector for iframe and auto-resizing widget snippets, so its selected state
and generated code cannot diverge. Managed embed creation, configuration
updates and lifecycle transitions now persist their exact audit record first
and condition the domain mutation on that audit identity; focused Worker fault
injection verifies that suppressing any required audit leaves the embed absent
or unchanged.

A later isolated high-signal test pass found and fixed production defects in
weighted 1–10 scoring, DST midnight schedule/close/due-date helpers, CFP
activation, recusal and email-based self-review assignment, hidden conditional review
attachments, private cache policy, applicant/itinerary host cookies, file-scan
queued retry, and accepted-speaker/task reminder audience filters. Follow-up
review of those uncommitted fixes kept Airtable repository connections connected
through retention recovery, bounded cached event-local exclusive-end bounds, restored
fail-closed published speaker-array parsing, required active speaker workflows
before task reminders, and kept no-recipient reminder days marked complete.
Applicant cookies now return an explicit Set-Cookie list rather than a newline
joined header. The changes are included in production source `8a0c39f`; evidence
for the individual boundaries remains the focused unit and Worker files.

Multipart allocation now treats retained file-erasure audit tombstones as used
logical asset generations even when evaluation reset or retention has removed
the corresponding `file_assets` row. Focused Worker coverage reproduces that
production failure boundary and verifies that the next generation receives its
own file version instead of returning an allocation HTTP 500. The fix is
included in production source `8a0c39f`; the focused Worker regression remains
its acceptance evidence.

### Production evaluation release evidence

A follow-up QA pass on the production `/evaluate` fixture tightened
role-specific 403 copy, kept the evaluation banner on root error pages, aligned
auto-place readiness with unpublished sessions on a published schedule, and
fixed participant draft attribution, apply-form example answers, task-evidence
PPT/PPTX acceptance, speaker-resource readiness and several stacking, wrapping
and readiness inconsistencies. Speaker preparation now counts required resource
acknowledgements as a fourth milestone. Those changes are included in production
source `8a0c39f`; their individual acceptance evidence remains local and
repository-backed unless a production exercise is recorded below.

The deployed production revision expands the production-only `/evaluate` slice
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

The isolated evaluation-public-application correction keeps that separate
authentication realm while allowing gate-only and non-applicant evaluator
sessions to reopen a valid form-scoped anonymous draft. Email proof upgrades
that draft to an applicant token bound to the current fixture-reset generation;
both the pending verification challenge and resulting token require that same
evaluation generation. Locking evaluation between requesting and redeeming a
code cannot convert the challenge into an ordinary applicant session, and
migration `0046_evaluation_verification_generation.sql` revokes the
unclassifiable pending challenges present at upgrade. The token does not
resolve without the evaluator session or after a reset.
Fixed applicant personas still take precedence on eligible forms, and selected
organiser/reviewer identities cannot leak Better Auth or ordinary applicant
state into the public application. Password-protected forms still require their
password. The application page explains that the selected persona applies only
to private workspaces and that the public application uses a separate applicant
session. Focused service tests cover anonymous reopen, fixed-person precedence,
ordinary-token suppression, form/expiry/reset boundaries and password
admission. Non-fixture verification fails before creating an applicant or
delivering a code. Worker route coverage exercises the exact start-cookie,
redirect and reopen path for gate-only and organiser sessions. A dedicated
production-shaped Chromium profile, run by the pull-request and complete
release browser gates, additionally unlocks `/evaluate` without choosing a
persona, follows the public application link, starts an anonymous draft and
lets the browser carry the issued cookies through the redirect before asserting
that the editor reopened. The same profile covers the Accepted speaker's
participant Applications link through starting and saving a blank anonymous
draft; save-only validation discards the empty speaker placeholder while final
submission continues to require a complete speaker. Its Siteverify fixture is
explicit and loopback-only;
it does not claim external-provider success. The path is included in production
source `8a0c39f`; no fresh production reset or browser acceptance is claimed for
this exact scenario.

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
external resources inside Program Cue are limited to typed YouTube, Vimeo and
Google Maps blocks selected through `RESOURCE_EMBED_PROVIDERS` (all three in the
production profile). Their exact `frame-src` origins and sandbox/permission
contracts are derived from code. Speakers receive inert click-to-load cards and
a permanent ordinary provider link; disabling a provider is enforced at save
and publication while already-published content degrades to an explanatory
link card. Google Maps uses place/search parameters and additionally requires a
restricted Maps Embed API key; arbitrary map share links are not accepted. The
production profile selects all three providers, but installing/restricting the
real Google credential and live-provider acceptance remain operator work; no
external-provider success is claimed here. Development and demonstration
profiles select only YouTube and Vimeo; opting into Maps without a valid key is
a configuration error rather than a degraded link-only mode. The browser-test
profile opts into Maps explicitly with an ephemeral test key.

The operator reset is organisation-scoped because optional evaluation scenarios
create events and contacts. It restores the canonical event, clears and
tombstones additional fixture-organisation events plus their private R2 data,
removes only otherwise-unreferenced auxiliary people, and preserves event rows
and append-only audits. Fixed SBEK people still fail closed on
cross-organisation drift. Every controlled-inbox invitation creates or reuses a
retained ordinary global identity, including when the invitation is never used;
reset removes its evaluation-organisation memberships and event relationships
without promising deletion of the person or matching global authentication
state. Creation time is not deletion authority. Reset audit metadata records
removed and retained
auxiliary-person counts plus the removed fixture-membership count without
personal identifiers. Active in-scope external work, completed retention or a
mutation that cannot be proved fixture-confined still fails before destructive
cleanup. On first bootstrap, the shared seed may create dedicated canonical
fixture rows before the remaining cleanup preflight; that bounded fixture-only
mutation is not a completed reset. An atomic owner-token lease serialises
resets, fences every destructive phase and publishes the new session generation
only in the same D1 transaction that completes the owning operation. Live
overlap is rejected; failed and expired attempts remain fail-closed while
allowing a later operator reset to recover them. Focused Worker coverage proves
that a controlled-inbox identity retains its global account, session, token,
audit and outside membership while losing fixture access, and that a second
reset succeeds. The unlocked `/evaluate` guide labels the deterministic Sam and
controlled-inbox paths separately, and production-shaped Chromium coverage
proves that Lock evaluation clears the evaluation realm in the same browser.
This revised reset contract is local repository evidence; it has not been
deployed or exercised with a fresh controlled inbox.

The deployed production application also exposes a destructive, collapsed reset on
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

The deployed release closes the remaining reproduced cross-surface defects.
Accepted decisions and their drafts now persist an explicit current session-format
mapping; migration `0033_decision_draft_session_format.sql` marks older legacy drafts for
explicit organiser reselection without inferring from their submitted label.
Decision release fails before mutation unless the recipient is production-
deliverable and the provider, verified sender and published decision template
are all ready. The production evaluation reset removes its demo-only sender and
verifies that exactly one applicable Resend sender remains. Released rejected
and waitlisted outcomes have a
confirmed, reasoned and audited reopen path;
accepted outcomes remain protected because they already own linked programme
and onboarding records. A failed schedule placement is presented as a rejected
preflight rather than contradicting the persisted open-conflict count. Overall
readiness cannot exceed completed setup-phase readiness. Saved CFP closing-date
changes identify the still-live published date and require republication.
Speaker-target tasks with an existing deadline support one-person extensions
with revision, reason, audit and webhook evidence; undated tasks fail rather
than silently acquiring a deadline. Direct-session entry points are exposed
from Programme and Schedule. CRM event handoff reports created/no-op results
without silently switching the current event, then offers an explicit
authorised switch that opens the exact target prospect. Content ZIP preview uses only explicit
session or submission relationships; speaker-task ownership alone remains
honestly Unassigned instead of guessing a session. Schedule publication
names the canonical public programme destination and exposes it as an action
after publication. Focused service and Chromium workflow coverage exercises
these boundaries locally.

The deployed release keeps the intentionally shared evaluation fixture and
closes five evaluator-audit defects. Its guide now derives Priya's
activation/draft/submission state and Sam's valid-or-expired invitation/
acceptance/assignment/review state from canonical D1 records, uses “Clean” only for an exact baseline,
updates each action destination and warns that a separate run should reset only
after confirming no overlapping evaluator is active. Submitted rubric content
retains full contrast while its controls remain disabled, administrator
layout-level access/context errors offer event selection as a usable recovery path, the
trusted same-origin admin embed preview no longer applies an ineffective
script-plus-same-origin sandbox while generated customer iframe code remains
sandboxed, and retention impact copy pluralises its asset count. The production
build, focused route tests and 17 affected Chromium workflows pass locally,
including an axe colour-contrast assertion on each submitted canonical review.
The added state-aware guide coverage exercises every requested phase. These
changes are included in production source `8a0c39f`; no fresh independent
evaluation of that exact revision is recorded.

A follow-up evaluator audit in this worktree also repairs the two seeded
evaluation submission-detail failures by restoring the immutable form name,
kind and public slug to the published version snapshot; both canonical detail
routes now load through the real administrator interface. Public Programme,
Timetable, gallery, application and API-reference landmarks are complete
and uniquely named, including the same-origin programme preview; embed mode no
longer mounts an irrelevant evaluation banner or duplicate toast live region.
At 320 pixels the full event name remains visible, compact programme links meet
the WCAG 2.2 target-size minimum, and Scalar exposes separate, visible 44-pixel
JSON and YAML download controls with light/dark contrast. The API-reference back
link returns to the active runtime's evaluation or demo guide, and to API
settings in ordinary production. Evaluation rate-limit errors state the
approximate retry time; invalid retry durations fail their explicit UI invariant
rather than being silently clamped. Scalar reconciliation tolerates incomplete
intermediate third-party markup and re-runs when its child text arrives, while
the settled browser contract still fails if required download labels disappear.
The focused repository gate passed
37 files/327 tests, and seven
Chromium accessibility workflows passed across representative phone, tablet,
desktop, dark-theme, landmark and embed cases. These changes are included in
production source `8a0c39f`; no fresh production reset is claimed for this
acceptance pass.

Bundled Priya Raman and Marcus Okafor portraits are presentation assets exposed
only through the canonical event's published programme projection and optional
application featured-speaker preview, under exact demo/evaluation runtime,
event and person allowlists. They are not authenticated profile/file state; any
non-deleted real headshot asset suppresses them, and they are not upload,
scanner or R2-release evidence. The expanded slice is included in production
source `8a0c39f` and has focused repository and browser evidence, but has not
been independently re-evaluated there. Fresh
SBEK inbox/bounce capture and scheduled-reminder cron evidence remain external.
No 100% SBEK result is claimed before one clean reset, a fresh complete ordered
run and the human checklist.

Pre-release reviewer-AI hardening now makes setting, requested, generated,
failed, interrupted and dismissed audit evidence atomic with the corresponding
domain or operation transition. Focused Workerd fault injection suppresses the
setting/request/generated/dismissed audits and operation completion and proves
that no partial setting, suggestion or completed operation survives. Generation
capacity is claimed transactionally with three assignment attempts and 100
organisation attempts per rolling 24 hours; failed and ambiguous attempts count
because provider cost may already exist without permanently disabling an
assignment. Review provenance uses one relationship from the review to its
suggestion, and D1 triggers reject contradictory
assignment, evaluator, revision, round, target, scorecard and lifecycle
relationships, and reopened immutable revisions retain the exact
suggestion/imported/confirmed criterion fields. Bulk import fills only
previously unanswered closed criteria, with server validation preserving saved
independent answers and requiring exact suggested values for recorded imports.
Expired-lease races converge only on terminal operations carrying the matching
audit. Missing database aggregate rows and provider model attribution now fail
explicitly rather than
defaulting to zero or the configured request model. Reviewer-AI audit families
are classified under Evaluation activity. The source is deployed in production
revision `ad9b752`; a fresh live reviewer-AI provider request remains separate
acceptance. Final validation on 16 August 2026 passed the complete
core gate (63 unit files/352 tests, 173 Workerd files/1,419 tests and the Agent
test), the 101-table/124-index/124-trigger migration and recovery contracts
(including a populated `0034` to `0036` forward upgrade), and
the new pull-request browser command (19 application tests across two isolated
Chromium shards plus 14 public-site desktop/mobile tests).

Validation-infrastructure hardening on 19 August 2026 moved the supported
runtime and both GitHub Actions workflows to Node 24.11+, made the hosted
pull-request browser job explicitly use one Worker/Chromium stack, and retained
Playwright results plus Wrangler logs for seven days after a browser-job
failure. Local verification passed the complete core gate and the compact
browser command with the CI shard setting (25 application tests against one
Worker plus 16 public-site desktop/mobile tests). A hosted CI result remains
outstanding until these uncommitted changes are committed and pushed.

An administrator workspace hierarchy pass on 20 August 2026 split Event
Settings into mounted Identity, Structure, Access and Data panels with one
shared save instrument; split Programme Publishing into programme records,
stateless embed configuration and managed-embed lifecycle panels; and added a
narrow-screen edit/preview switch to Branding while retaining its desktop split
view. Hash targets, server validation and invalid native controls reveal the
owning Event Settings panel before focus, and panel switches preserve unsaved
state. Local verification passed the focused quality/type/unit gate (20 changed
tests), 21 affected Chromium workflow tests and the four changed full-page
desktop/mobile visual baselines; the unchanged evaluation baseline also passed
alongside the desktop Programme capture.

## Capability status

| Capability                             | Status                                                                     | Verified implementation and boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime and persistence                | Production foundation                                                      | D1 remains the transactional control plane. An event can explicitly select D1 or Airtable repository authority; the Airtable path proves schema and reversible record permissions before saving encrypted credentials, scopes provider reads to the current event/version and managed fields, migrates up to 250 changed managed records synchronously, and covers Event Setup (including track create/read/update), forms, submissions (including multi-track selections and routing teams), evaluation, sessions, schedule content/notes, tasks/onboarding and immutable published programme projections. Commands use durable exact-result intents and recovery; authoritative disconnects, published projection drift, schema divergence and missing credentials fail closed without a D1 data fallback. Live-provider latency and acceptance remain external.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Authentication, roles and events       | Production slice                                                           | Better Auth sessions, magic links, participant verification, administrator/evaluator invitations, explicit current-event cookies, audited switching, organisation-wide owner/admin grants, blank event creation and event-scoped chair/evaluator/submitter/speaker access are server-enforced. Invalid, ambiguous, revoked, expired and cross-organisation access is rejected. Event creation and cloning require an explicit D1 or Airtable choice and persist a durable D1 control-plane intent before provider work. Blank creation binds the loader-issued intent to the existing operation record, so exact retries return the same event/operation outcome, changed input is rejected and Airtable work is not repeated silently. Airtable creation leases fail expired still-owned work into explicit recovery without a provider retry; because expiry cannot cancel an outstanding provider request, that failure is fenced from another Airtable attempt and requires an explicit keep-on-D1 or discard outcome. Airtable-selected records remain inactive through provisioning, fail closed without changing authority, and can only become ordinary events after exact reconciliation or an explicit audited keep-on-D1 recovery; ordinary provider-failure retry requires credentials again, while discard preserves a hidden tombstone and releases the public slug. Demo identities remain unavailable in production. The explicit production-only evaluation mode adds an IP-rate-limited, access-code-gated `/evaluate` route and signed eight-hour sessions for fixed fixture identities. It cannot select arbitrary people, reset data or enable simulated providers; ordinary persona selection grants nothing, while the clean applicant has one explicit audited fixed-event submitter activation that does not verify email or claim delivery. Sessions carry the latest append-only fixture-reset audit generation, so another reset revokes existing evaluator cookies and a missing generation fails with reset-required unavailability. The fixed fixture, role journeys and access-code session boundary were browser-verified on 13 August 2026; the expanded activation/reset/alias changes were deployed and the reset completed on 14 August 2026. The bootstrapped owner completed a live Turnstile-protected Resend magic-link flow and established the configured 14-day production session. A first Microsoft sign-in with an unverified email claim fails closed, then offers an email-verified, authenticated and state-bound linking action; the callback must retain the same Microsoft email before the account can be linked, after which normal direct sign-in is allowed. Microsoft authorisation requests `form_post`; the callback validates the POST against unexpired OAuth state, encrypts it into a 90-second single-use D1 relay and moves the browser to a clean URL before Better Auth consumes the code. Direct query-string, malformed, expired and replayed Microsoft callbacks fail closed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Forms and submissions                  | Production slice                                                           | The native visual editor writes strict schema v2 with ordered sections and mandatory field-to-section references, renders the same sections in its applicant preview and the real one-page application, and provides pointer drag creation/reordering with explicit keyboard alternatives. Unknown versions and invalid section graphs fail validation. A narrow schema-v1 reader preserves immutable historical versions; a mutable v1 draft is deterministically projected for editing but must be explicitly saved as v2 before publication, and historical JSON is never rewritten. Published schema/settings are immutable, RHF/Zod validates public input, public draft starts/creates recover exact D1 intent without duplicating rows or replaying bearer cookies, drafts recover across offline/reload/tab conflicts, anonymous ownership transfers only after verification, and co-speaker links expire. The public CFP is event-led and exposes dates, venue, deadline, organiser context, an honest completion estimate and every question before identity capture; versioned invitation copy is organiser-controlled, the mobile apply action follows that invitation, programme navigation remains independent of the optional published-speaker showcase, and empty invitation fields add no editorial claims beyond stored event content. Its D1 landing read checks published-version integrity and reads at most eight published speaker identities and relevant headshots; Airtable preview cache misses still validate the complete authoritative provider projection before bounded cache hits are served. Per-version presentation controls and per-question examples are connected in the form builder, whose desktop workspace keeps field editing and the live applicant preview side by side. A verified applicant may import public name/biography from one exact Sessionize profile URL into an unsaved draft for review; tenant/IP/applicant production limits apply before fetching, while redirects, unsupported hosts, oversized/non-HTML responses and missing public profile data fail explicitly, and no provider login or private data is claimed. Application forms expose one-or-more tracks; direct-session forms expose one required programme track. Public and administrator intake persist authoritative track/team joins and immutable names, but deliberately leave routed submissions unassigned until review administration creates assignments. Administrator submission detail derives the immutable form name/version and each selected-track-to-review-team outcome from those records; manual team selections are labelled as overrides, and routing drift fails explicitly. Manual applications support multiple tracks, optional multiple-team override and only event-configured formats; administrator direct sessions require a track and an event-configured format. Dedicated `/admin/submissions/new` and `/admin/sessions/new` routes preserve bounded creation origin through validation and duplicate review, then redirect with the exact created record ID.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Evaluation and decisions               | Production slice                                                           | Team administration, invitations, multiple rounds, rubrics, explicit assignment selection, review locks/revisions, moderation/reopen and decision authority are connected for submission and session targets. Every accepted decision must confirm one of the proposal's submitted tracks; its exact ID/name is retained in the effect snapshot and audit, and released acceptance atomically creates the session on that track plus the speaker graph and explicitly opted-in task templates with their scoped dependencies. Decision release now atomically materialises and links its exact notification operation, pinned communication and recipient delivery before Queue dispatch. Template version, sender profile, recipient snapshot, merge values, structured content, rendered subject and body hash are durable retry intent; the worker rechecks suppression/provider/sender readiness but does not reselect mutable intent. The chair detail exposes recipient delivery state and provider failure separately from queue acceptance without exposing the body. Decision notification snapshots preserve rationale and only explicitly selected applicant-facing review feedback; private notes never enter the email source values. Included reviewer feedback is rejected above 64,000 characters, and the durable notification JSON is rejected above 1 MB of UTF-8 so a valid chair action cannot fail at D1's 2 MB row limit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Participants, tasks and resources      | Production slice                                                           | Stable Overview, Applications, Sessions, Tasks, Files, Resources and Profile routes share an authenticated submitter/speaker shell; server-backed route actions own profile, task and file mutations. Published forms remain directly startable, while Applications aggregates owned and claimed proposals and keeps closed or archived submissions readable from their immutable submitted snapshot. Verified draft ownership and successful co-speaker claims atomically create or reactivate accepted submitter entitlement; direct-session paths create or retain the applicable portal entitlement without treating portal access as programme participation consent. Session-targeted tasks identify the linked session while retaining comments and versioned private evidence. Optional event logo, welcome and support values brand both the authenticated participant workspace and the richer public application landing. Organisers open an event-scoped speaker detail route from the roster that reads linked sessions plus every stored file version with its scan and release state; released current versions use an event- and speaker-scoped private download that revalidates role, organisation, asset ownership, signature, clean scan, release and R2 ETag. Missing scan results remain explicit, and unresolved or cross-asset current-version references fail as integrity errors. The full-profile update contract requires every field and edits name, title, organisation, pronunciation, biography and profile status behind a compare-and-set revision, audit event and advertised `speaker.updated` webhook only while the canonical identity is exclusive to the current event; revoked memberships are excluded consistently from the read and atomic update guards. Shared identities remain person-owned, but their speaker detail now reads and atomically updates organiser-authored name/biography/title/organisation from the current organisation profile plus private logistics from the exact event profile, without touching the canonical person. The durable last-saved revision survives reload. Task evidence/dependencies/comments/overrides, exact bulk previews, safe five-minute undo, resource publication/attachments/acknowledgements and automatic reminders remain event-isolated. Resource audiences distinguish accepted session relationships, including pending participation, from the explicit stricter `confirmed_speakers` scope; confirmation creates any newly applicable acknowledgement task. The minimum hotel and flight forms are typed structured task forms, not a single free-text placeholder. Resource embeds fail closed to deployment-approved exact HTTPS origins, an empty-capability iframe sandbox and the matching response CSP; unsupported URLs are rejected at save rather than downgraded or rendered.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Speaker Network                        | Optional competition production slice                                      | Organisation owners and administrators can search and filter a cross-event person directory, inspect event/session history, attach private notes and case-insensitive tags, save dynamic filtered segments, preview and confirm exact-column CSV imports, review same-name duplicates, and merge only unlinked network-only identities. Directory event/session totals and detail history consistently exclude inactive events. Speaker Network entry, event-roster manual entry and CSV import persist organiser-authored name, biography, organisation and job title in an organisation-scoped contact profile with provenance; a newly created canonical person contains only the neutral email identity, and Network merge enriches only the scoped primary profile. The event-roster command includes the contact/profile, membership, workflow and audit in one guarded D1 batch, preserves an existing participant-owned canonical profile and does not erase existing scoped optional enrichment when the roster form omits it. Migration `0019` moves only untouched identities bearing the deployed old manual command's exact creation provenance out of the canonical profile and fails rather than silently retaining global organiser data when an exact candidate cannot be migrated coherently; participant-updated and genuinely unprovable identities remain unchanged. Network projections, sourcing and outreach prefer the current organisation's enrichment while retaining canonical profile fallback for established speakers. Manual entry and CSV preview/confirmation reject an email that already belongs to a global person without a legitimate current-organisation contact, accepted membership, submission or session relationship; imports fail as a whole rather than silently skipping the blocked row. Merge separately revalidates identity ownership at its mutation boundary and preserves relationship history. A persistent five-stage speaker-sourcing board records compare-and-set moves, fit scores, rationale, timestamped transitions and notes. Adding a contact to an event reuses the canonical identity through the provider-aware speaker service while its admin roster label retains the organisation-scoped Network name. Bulk speaker invitations create an event-scoped durable communication draft and then use the existing exact-recipient preview and explicit delivery confirmation; no provider success is simulated. The underlying `0002_speaker_crm.sql` migration, `/admin/crm` routes and guarded ownership migration `0019` are deployed; the new authorised production mutation has not been exercised against a live organiser-created record. Participant adoption of organiser suggestions is deliberately deferred and no automatic canonical-profile merge occurs. General-purpose CRM remains excluded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Files and privacy                      | Production slice; partial deployed acceptance                              | Every event stores a required strict file policy with canonical upper bounds. Multipart initiation, resume/list-parts, completion and metadata commit revalidate current policy. Private R2 objects remain quarantined until an authenticated scanner result releases them. The companion scanner durably accepts exact jobs, restricts downloads to the private production bucket, refreshes ClamAV signatures before readiness, handles up to 1 GiB on disk and returns an HMAC-signed clean/infected/error verdict without logging signed URLs. A fixed four-slot container pool admits one scan per slot; ordinary capacity waits retain stable affinity, while each explicit durable retry advances deterministically to another slot without concurrent fan-out. Occupied slots keep Workflows waiting with capped durable backoff, while ClamAV readiness has an independent sub-eight-minute cold-start budget. Invalid jobs, object mismatches and unavailable duplicate Workflow states fail immediately. Scanner errors fail their Operation and may be retried only after the unchanged quarantined object is revalidated; each retry uses a distinct Workflow attempt and stale callbacks are rejected. Retention preview/typed confirmation, legal holds, bounded pseudonymisation, credential revocation, file erasure ordering and immutable completion evidence are connected. Production browser multipart, clean release, EICAR quarantine and a scanner-error retry on another slot passed through durable D1 intent, private R2, Queue, the scanner Workflow/Container and signed callback. Sustained live burst-capacity behavior and provider-side erasure acceptance remain outstanding.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Schedule and public programme          | Production slice                                                           | FullCalendar list/day/week views use the same D1 schedule service as keyboard and form alternatives. Moves, resize, unassign and short-lived undo revalidate event, room, speaker, track, capacity and required-resource rules. Deterministic auto-placement keeps every generated session within the event-local 07:00–22:00 working day, including exact-boundary and DST dates, and continues first-fit placement on later days when needed. Draft-only notes/content autosave to the active version; publication requires every scheduled public snapshot to be Approved (private or hidden snapshots may publish without approval) and rechecks that boundary atomically and at the D1 status transition. Live session visibility is copied from the published snapshot at publication; migration 0044 restores any pre-upgrade live/snapshot drift and invalidates the public projection. D1 also guards direct published-version recovery when entries are restored, entry reassignment, and any approval, visibility or deletion change to a snapshot on a published version. A blocked draft leaves the last published programme unchanged. Airtable staging applies the same exact-snapshot boundary before provider writes, and previously public advisory content is retained with explicit legacy-publication provenance rather than a fabricated reviewer. Public programme, embed, API, ICS and calendar fan-out read public content from the exact published schedule snapshot together with current published speaker identities, and stale publication fields never expose an inactive event or headshot. D1 API cursors bind to a persisted public-projection revision advanced by public-visible event changes rather than scanning event history on each page. Event setup, repository-authority changes, publication, public profile updates and headshot revocation commit their change sequence in the owning D1 batch; routes only broadcast that sequence, and completed idempotent retries do not rebroadcast old work. Repository tests cover event, schedule, session, person and headshot categories, including the real erasure path whose durable change commits with public revocation. The D1 integrity count, session speaker projection and speaker profile projection share one transactional batch, so a concurrent profile edit cannot mix revisions within a response. Before any representation is rendered, the published speaker graph validates exact ID/name pairing and bidirectional session links; malformed D1 or Airtable data fails explicitly. Publication also requires confirmed session participation rather than portal activation and rechecks it atomically. The public Programme filters by search, day, track, format and room with a live result count; structured filters and text search keep session and speaker results coherent. A distinct Timetable compares published sessions on time and room axes on wide screens and reflows them into chronological cards on narrow screens. Saved personal and shared itineraries expose an ICS export containing only the selected published sessions, and personal itinerary navigation appears after the first save rather than as an empty destination. The page-local embed builder configures published facets, selectively visible controls, event accent, density, height and speaker-directory visibility, previews the exact generated URL at desktop/mobile widths and copies sandboxed iframe or origin-checked auto-resizing widget code. Unsupported, malformed and stale embed values fail with a specific client error rather than falling back. Session rows, details, speaker profiles and saved itinerary cards preserve the mapping between each speaker and supplied title/organisation while omitting absent affiliation lines. The speaker profile panel reports its session count and rooms and restores focus to its opener when closed. Session lists group by event day under a heading that states the calendar date once and pins under the masthead while that day scrolls; rows carry the clock range, duration, track, format, room and a per-session itinerary toggle named for its session. Arbitrary valid event accents retain their exact decorative colour while deriving contrast-safe text and interaction-state colours. Narrow layouts keep filters, builder controls and descriptions contained and scannable, and reflow rather than drop content: room, track and format stay visible at every breakpoint, including the 320px reflow width where they were previously hidden below 760px. |
| Communications and calendars           | Production slices; core provider lifecycle accepted                        | Resend production delivery and Mailpit local capture share one strict provider contract with no fallback. Browser sends use revisioned, resumable D1 drafts; authoritative preview fingerprints and draft revision are revalidated while the same row transitions to scheduled/queued. Sender profiles/domains, scheduled/automatic work, severity-monotonic webhooks, suppression and retryable operations are connected. Calendar invitations stay bound to the creating provider/account until cancellation; Google/Microsoft OAuth uses encrypted tokens and compare-and-set refresh/failure handling. The production Resend domain/signed webhook and both Google/Microsoft applications are provisioned. A real authentication email was delivered and consumed; durable production test sends reconciled owner and controlled-delivery recipients to `delivered` and a controlled bounce to `bounced`. Live Google and Microsoft consent each persisted one connected D1 account, and both providers completed invitation create/update/cancel lifecycles. Broader recipient sets and a fresh provider-error callback remain external acceptance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Accelevents                            | Production slice; external provider acceptance outstanding                 | Encrypted connection verification, exact mapping/diff preview, explicit no-write dry run, required live confirmation fingerprint, request-bound idempotency and connection-revision snapshot, stable mappings, item retry/skip and a tenant-scoped terminal reconciliation CSV rendered from immutable stored run state are connected. Preview/provider drift and provider-contract gaps fail explicitly. No sandbox credential was available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| AI/agent interface                     | Production slice; external-provider acceptance outstanding                 | The private event Durable Object uses the Cloudflare Agents SDK. Standalone and contextual interfaces read authorised evidence; mutations are allow-listed proposals that require exact preview/approval and durable crash-safe execution. Reminder sends reuse the canonical Communications queue. Organisation owners select Workers AI, OpenAI Responses or Anthropic Messages with audited compare-and-set settings; the selected binding/credential fails fast and never falls back. Workers AI is restricted to Cloudflare-hosted DeepSeek V4 Flash 0731 and translates the shared transcript, function tools and schema requests to its Chat Completions contract; incomplete, refused, malformed and unsupported results fail before presentation. Migration `0023` replaces existing GPT-OSS selections and advances their settings revision. Responses and Messages stream readers cancel rejected provider bodies and always release their locks; malformed events, failed/incomplete terminal states and size violations cannot leave a partial result presented as valid, and the browser clears partial assistant text when its terminal stream contract fails. AI first-pass assessment retries retain immutable failure evidence, require explicit duplicate-charge acknowledgement, expose the running leaf of the durable retry chain with initiator and operation link, and immediately suppress the stale retry action with an honest starting state while its request is pending. Staged or expired running attempts expose an owning-workflow reconciliation action that persists the staged result or records an indeterminate failure without another provider request. A live schema-bound readiness summary is accepted on DeepSeek V4 Flash; live tool-loop, assessment and external-model credential acceptance remain outstanding.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| REST API and webhooks                  | Production slice                                                           | Thirty-three synchronized OpenAPI paths cover published programme families, participant self-service, private collection/item resources, authenticated provider callbacks and administration lifecycles for forms, memberships/invitations, sessions, decisions, tasks, resources, integrations/mappings, operations and evaluation/communication commands. API-key and participant writes persist atomic exact-replay results, side-effect recovery and audit evidence. Worker-level maintenance responses retain the normal structured error/correlation envelope for every `/api/v1/...` request while browser pages receive bounded text. Advertised outbound events are materialised with their domain audit in one D1 transaction, then dispatched post-commit with an explicit undispatched recovery marker. Registered Zod 4 command schemas emit synchronized OpenAPI component schemas deterministically.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Operations and adjacent administration | Production slice                                                           | Command Centre groups six initial setup conditions into four lifecycle phases derived directly from authoritative event, form, review, task, sender and schedule records, then removes the guide when setup is complete; no parallel checklist state exists. The Operation Centre exposes durable status, bounded progress, per-item results and eligible retry/cancel/skip for communications, calendar, Accelevents, Airtable recovery, imports/exports and assistant actions. Blank event creation, provider-aware event cloning, saved views, eight-kind command record search with server-side domain aliases and exact room/track/resource/operation destinations, plus preview/confirm bulk/import workflows use domain services rather than client-owned state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Security, observability and recovery   | Production foundation; partial deployed acceptance                         | Same-origin browser mutation enforcement, scoped hashed API keys, signed webhooks, public abuse rate limits/Turnstile verification, private files, publication boundaries, append-only audit and fail-closed provider configuration are implemented. Production HTTP, Queue, scheduler and health entry points validate the complete binding/secret inventory and reject placeholders before work; health also probes the D1 baseline without treating live third-party availability as local readiness. Anonymous itinerary signing and lookup use one independently required secret; missing, short or authentication-secret-reused values fail readiness and there is no authentication-secret fallback. Migration `0018` and the independently generated production secret are deployed; a live anonymous itinerary create/export/remove cycle produced exactly one VEVENT, and its exact empty test row was removed afterward. A validated `SOURCE_REVISION`, correlation IDs and bounded structured request/Queue/scheduler/provider/backup logs join local evidence. The D1-export Workflow requires an exact non-zero signed-export length and incrementally hashes/counts the same backpressured stream passed to private R2, without a tee branch; immutable-key recovery compares streams sequentially and explicitly cancels an unopened existing body when fresh-source validation fails. The deployed predecessor wrote an immutable checksum manifest to private backup R2, and that exact object passed an isolated remote D1 restore drill with every table count matching. The 14 and 15 August autonomous runs exposed a delayed-first-poll defect; deployed source `5109324` polls immediately and every second and surfaces Cloudflare's inner result error. Its separate 03:47 UTC monitor requires that day's exact manifest and matching SQL bytes in private R2, because live testing proved an absent log series cannot drive Cloudflare's `count < 1` alert. Retained logs are queryable, both Queues report zero-message/zero-byte backlogs, and three scoped error alerts are attached to enabled replacement email policy `ffbf6c4ec51c4c08b3f4c161ca93d871`. Direct tests of the original and replacement policies appear in Notification History as dispatched to the owner address. Real firing incidents `NCRGGQREN0`, `7321V7TT4B` and `QQ6DZGHEYW` produced no Notification History entry, including after canonical-UUID reassociation and policy replacement, so live alert delivery is a reproducible Cloudflare-side acceptance failure rather than verified email routing. The next autonomous cron/monitor, working incident delivery, point-in-time exercise and measured RPO/RTO remain external.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Demo and competition evidence          | Demonstration only / local evidence; production evaluator repository slice | The single rich fixture supplies local demo and production-evaluation data without enabling `/demo` in production. Populated showcase roles coexist with clean SBEK identities, five communication templates and due-dated tasks. Production `/evaluate` provides access-code-gated fixed-person journeys, direct proof links and one explicit fixed submitter activation; exact SBEK aliases route only within that signed fixture context. The production reset is confined to the dedicated fixture organisation, retires evaluator-created events and safe auxiliary people, preserves audits and fails on unsafe or external work. Bundled portraits are demo/evaluation presentation only. The expanded reset completed once in production with all temporary authority removed, and the current release preserves the gated evaluator journeys under the canonical `future-of-events-2027` slug. Fresh SBEK mailbox receipt, scheduled-reminder cron evidence, Forge submission and a completed SBEK/human run remain outstanding.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Review save and reopen now have repository
evidence that suppressed conditional writes fail inside their D1 batch and roll
back the whole domain transition. Focused fault injection independently removes
immutable revision, success-audit, reviewer-AI import and prepared-webhook
evidence and verifies that the prior review, assignment, submission, suggestion
state and persisted evidence remain unchanged. Reviewer-owned workbench commands write
`participant_ui`, authenticated JSON commands write `api`, and manager-only UI
commands write `admin_ui`; the origin is required at the service boundary rather
than defaulted from role. Prepared webhook audit evidence inherits the exact
actor and origin from its immutable source audit within the same batch;
standalone webhook calls without an API-key actor must explicitly declare
`admin_ui`, `participant_ui`, `public_form`, `api` or `internal`, and a missing
origin fails before endpoint discovery. Decision reopen now requires the same
kind of complete current-state guard for its notification graph: the linked
operation must be a one-recipient terminal graph. Pending work is cancelled
only while the parent job is still cancellable. A completed job keeps its
existing communication and delivery evidence, including later failed, bounced
or suppressed provider updates, and is reported as
`already_provider_accepted` with that delivery status. A NULL notification
link is accepted only with the exact closed
`decision.notification.legacy_unlinked` audit; any other missing operation
fails before supersession. The outcome is selected in the same D1 batch.
Fault injection that suppresses communication cancellation, delivery
cancellation or item skipping rolls the reopen back. The change is included
in production source `8a0c39f`; the fault-injection tests remain repository
acceptance evidence.

Priority 0 review hardening keeps the client autosave CAS token at the last
revision explicitly acknowledged by the current assignment's save request.
Retained or stale fetcher responses cannot advance that token or clear newer
criteria/comments, while the server still serialises saves and enforces its
compare-and-set boundary. Focused review Worker coverage and the desktop
Chromium review workflow cover save, reload and conflict-safe recovery. The
change is included in production source `8a0c39f`; the focused checks remain its
acceptance evidence.

### Cross-surface micro-UX evidence

The connected production interfaces now derive new event, public-form,
resource and managed-embed slugs until manual override, show the resulting
public path and check event-slug availability without weakening the server's
uniqueness boundary. Event creation, cloning and setup use coupled date ranges,
searchable stable city/IANA timezone labels, linked field errors and focused
error summaries. Existing and published identifiers remain unchanged.

Event Setup room creation now uses a dedicated server action backed by the
canonical compare-and-set `EventService.saveSetup` path. It persists the
validated room, rejects duplicate names and invalid capacity with field errors,
revalidates the canonical room list and exposes the room immediately to the
schedule workspace; track creation remains on the same canonical save path.

Application intake reports remaining required answers, labels required fields,
warns about repeated speaker email addresses and surfaces bounded-text counts.
Organisation-scoped person lookup is connected to organiser speaker entry while
remaining server-authorised and isolated. It returns exact event workflow state,
allows declined/withdrawn roster restoration and permits existing event speakers
to be selected while editing submissions. Form authoring uses label-derived
stable field IDs, protects referenced IDs behind an explicit override, rejects
case-insensitive duplicate choices, couples speaker limits and offers a
question-derived completion estimate. Profile editors guard unsaved changes and
normalise supported LinkedIn and X profile inputs before the existing server
mutation while unsupported values fail validation.

Task and communication composers progressively reveal only deadline/audience
controls that apply, provide natural-language or event-local scheduling
feedback and retain the existing server validation. Organisation owners can
persist an audited real postal address for new communication-template defaults;
the write revalidates active ownership, rejects stale revisions and rolls back
unless the update and audit complete together. Missing data remains explicit.
Task-template forms now enter through a typed normalisation boundary, so absent
text, date and offset values render as controlled empty strings and failed
submissions redisplay the same draft instead of passing `undefined` to inputs.
Optional HTTPS URLs accept blank values, reject malformed values with the exact
field copy `Enter a valid URL beginning with https://`, preserve the draft and
return focus to the invalid control. Event-selection links from reviewer,
speaker and administrator shells use a full document navigation, keeping the
first navigation after invitation acceptance on the authoritative event
loader. Focused Worker coverage records these P0 validation and navigation
contracts; manual assistive-technology acceptance remains external.
Schedule source search and public programme filters persist in the URL without
rerunning their loaders, while server-owned focus parameters still revalidate;
stale public facets are cleared with an explicit notice. Saved-view names
reflect active filters, and long content fields expose near-limit counts.
The application queue now derives authoritative event-wide status/team totals
separately from the matching count and numbered range. Filters, allow-listed
sort, optional columns, density and page have one strict URL-owned state; page
1 with no matches is valid, while malformed parameters and stale page numbers
fail explicitly. Record detail breadcrumbs and browser titles use existing
loader data instead of generic detail labels or an additional query.
Focused unit/Worker and browser coverage records these observable contracts;
manual assistive-technology acceptance remains external.

### Evaluation showcase fixture evidence

- **Production slice; local and production-reset acceptance:** the deterministic reset keeps
  clean SBEK identities separate from a showcase cohort containing two
  completed reviews with a 2.30-point score spread, one committee
  discussion, a published waitlist decision, one historical public
  speaker-profile snapshot, an active named schedule embed, a published public
  event-site snapshot (featured sessions and speakers, eight FAQ entries, all
  five optional pages — About, FAQ, Venue, Code of conduct and Sponsors —
  enabled with long-form bodies, seven text-only sponsors across three tiers
  without outbound URLs, matching published references, the fixture publication
  change, equal draft and published revisions) and
  canonical venue/map context. Reset completeness requires those records while
  still requiring zero prior SBEK submissions, assignments, speaker tasks and
  clean applicant activation.
  Focused Worker and Playwright coverage verifies the public-site showcase
  locally. A later `/demo` load does not restore deleted sponsors or stale
  featured references onto an already-edited site.
- **Production evaluator repository slice:** On 19 August 2026 the routine
  access-code-gated `/evaluate` reset completed under deployed revision
  `98f4f10a89c1e52cd1715799f2bfb985f98f4fc6`, rotated the evaluator-session
  generation and returned an unlocked picker with no selected persona. Its
  server-side completion check accepted the current showcase baseline,
  including the published public-site snapshot. A production browser check
  verified that the homepage does not duplicate the dedicated FAQ and that
  About, FAQ, Venue, Code of conduct and Sponsors all resolve with their seeded
  content. Production health reported the exact revision and the temporary
  operator reset endpoint remained unavailable with HTTP 404. Fresh
  `organizer`, `speaker` and `reviewer` browser states were then captured and
  restored successfully at `/admin/command`, `/apply/form` and `/events/select`;
  the speaker capture performed the documented fixed-account activation without
  claiming mailbox or provider delivery. The evaluator plan reports exactly
  those three personas as pre-authenticated.

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

The deployed production revision extends the Operations production slice with
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
confirmation and preserved archived error. Migration `0028` and the application
change are included in production source `8a0c39f`; no fresh production
acknowledgement was performed for this reconciliation.

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
  loading with Worker and Chromium coverage; that pagination change is included
  in production source `8a0c39f`. Migration `0020` and the earlier application release are deployed;
  a fresh production committee post was not performed. Reactions, mentions,
  editing, notifications and realtime chat are not implemented.
- **Production slice; deployed; repository acceptance:** The selected-round unified
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
  recipient offsets; those hardening changes are included in production source
  `8a0c39f`. No new provider
  receipt acceptance is claimed.
- **Production slice; deployed; repository acceptance:** Public speaker profiles use a
  server-resolved `?speaker=` deep link, absolute speaker canonical/unfurl
  metadata, Copy link, progressive Web Share and browser history. Invalid or
  unpublished speakers return 404, and unfurl images are omitted unless a
  released anonymously readable headshot exists. Focused Worker/unit coverage
  and the anonymous Chromium URL/history workflow are green. The release is
  deployed; no external social-crawler acceptance is claimed.

### Abstract workflow evidence

The deployed production application includes production slices
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
`0011_event_speaker_workflows.sql`, focused Worker coverage and Chromium coverage
are the acceptance evidence. The slice is included in production source
`8a0c39f`; no live provider acceptance is claimed here.

Independent round dates, scorecards, blind-review settings and reviewer pools
are connected through event-scoped D1 services and the administrator UI.
Each round also owns two to seven ordered reviewer recommendation choices with
stable IDs and configurable labels. The database and server make that list
immutable once an assignment exists; reviews and revisions snapshot the exact
IDs, labels and order. Reviewer workbench, chair breakdowns, API reads,
Airtable projection and CSV export use that evidence. Moderation and final
applicant decisions remain separate fixed consequential statuses and receive no
automatic mapping from reviewer choices.
An active or draft unassigned round can be edited, with stable criterion
identity and scorecard-version forks; only the confirmed final unused draft may
be deleted. A confirmed new-cycle command archives the prior plan as immutable
history and creates a clean active round whose editable rubric is copied from a
visibly identified latest round, while terminal submissions remain terminal and
are reviewable only with published archived-decision provenance.
Round assignment, reopening, conflict recusal and advancement revalidate
persisted windows and current-cycle scope at the mutation boundary. Reviewer
save, reopen, moderation and recusal batches guard their complete durable
postconditions inside D1; fault-injection coverage proves that suppressed
moderation, conflict, submission-transition or audit statements roll back prior
mutations. Confirmed moderation preserves terminal archived-cycle submission
status while advancing ordinary submitted/assigned/in-review work. Reviewer
progress is round- and person-scoped; owners and administrators can prepare an
exact-recipient reminder through the existing Communications preview rather
than sending directly. Results support round-scoped stable sorting and an
audited, formula-safe, size-bounded CSV export. Blinded reviewer projections
omit participant identity, identifying references and attachments server-side.
One immutable provider-attributed AI first-pass score/rationale may be generated
for an exact round, rubric and submitted snapshot. The artifact retains the
submitted revision ID/number, source-snapshot and model-input SHA-256 values,
prompt version, provider/model and generation time; request identity and the
final insert both bind the exact source snapshot. The unified chair result view
keeps the canonical human aggregate, immutable AI advisory and attributed human
assessment of that advisory separate, with an explicit statement that the human
assessment changes no aggregate/readiness behavior. Owner/administrator or a
committee chair with current plan decision authority may record that separately
audited assessment, with revision and authority rechecked transactionally.
Missing/invalid provider behavior fails without a simulated score. Separately,
an event-opt-in reviewer may request an immutable,
assignment-specific suggestion only after saving an initial draft. Suggestions
are bound to the reviewer, assignment revision, scorecard and source snapshot;
only closed criterion values can be imported through the ordinary autosave
workflow, free-text criteria receive rationale only, and every unchanged
imported value requires explicit server-validated confirmation at submission.
Suggestion provenance is stored on review revisions and the suggestion itself
never enters aggregates or exposes the administrator first-pass assessment.
The feature fails closed for Airtable-authoritative events, and a failed
or lease-expired provider generation requires explicit duplicate-risk
acknowledgement before another provider request.
Responses providers now reject explicit non-completed statuses
before parsing output, and the bounded rationale has a response budget shared
by model reasoning and final output. A failed generation remains durable and is
never retried automatically; an explicit acknowledged retry creates a separately
idempotent, linked attempt and prevents another concurrent attempt for the same
target. The pre-provider operation claim atomically revalidates the event's D1
repository and opt-in revision, reviewer pool, assignment status and revision,
round window, scorecard, immutable source snapshot and initial review draft. It
also rejects an active suggestion or unexpired generation for the assignment.
Unsafe failed-call acknowledgement remains visible after later draft revisions.
Focused Worker coverage exercises review advancement,
archived-cycle decisions, late co-speaker claim/profile/session/task propagation
and AI persistence/idempotency, including disablement, recusal and
different-revision provider-boundary races. The ABS-S2/S3 Chromium workflow exercises cycle
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
person's claim remain provider/persona acceptance. Focused Worker regressions
now prove exact AI source-snapshot persistence, rejection when that snapshot
changes during provider work, separate human-assessment audit/reload behavior,
transactional chair-authority revocation, decision-intent pinning across later
template/recipient/sender changes and send-time suppression. Decision-specific
database insert guards and Queue validation now fail before provider delivery
when the pinned render, sender or recipient evidence is incomplete. Existing
releases without that complete contract remain explicitly pre-migration rather
than receiving partial backfilled provenance; a migration-time audit marks that
closed historical set, and the database rejects new NULL-linked release audits.
Migration `0041` blocks on a legacy notification already crossing the provider
boundary, and cancels and audits queued or failed legacy notification work that
cannot satisfy the new pinned contract; the Queue acknowledges only an exact
migration-cancelled legacy
payload without sending it. The result loader likewise rejects
a broken new decision-to-operation-to-delivery chain instead of displaying it as
legacy or substituting placeholder evidence, while retained evidence follows
the immutable operation and communication relationships after audience/source
redaction. Exact selected review identities, revisions, statuses and feedback
are rechecked in the release CAS, and a suppressed notification graph statement
aborts the release transaction. A focused Chromium
workflow releases a decision, inspects its operation/communication/recipient
delivery evidence and proves that evidence persists after reload; no provider
delivery is inferred from Queue acceptance. A separate E2E-only, explicitly
no-provider-call fixture proves in Chromium that the canonical human aggregate,
immutable AI advisory and non-canonical human assessment remain distinct after
the assessment is saved and the page is reloaded.

### Schedule interaction performance evidence

Moves and resizes of already-scheduled draft entries now keep the proposed
position visible while the authoritative D1 rule check runs, roll back on a
rejected result and reconcile the returned entry, revision and warnings on
success. Successful moves no longer re-run the complete Schedule Planner
loader; new placements and consequential or stale-revision paths retain normal
revalidation. The placement mutation also omits the publication-wide quadratic
conflict projection because it performs the candidate conflict check directly;
publication still refreshes and rechecks the full authoritative preview before
opening. Focused unit, Worker and Chromium coverage verifies the optimistic
projection, durable placement response and absence of a post-move schedule
loader request. Production drag frame pacing and field latency remain external
acceptance evidence.

### Workspace interaction and scale performance evidence

The global document smooth-scroll rule has been removed because browser
focus/scroll handling delayed below-fold form controls before their request was
sent. Event Setup preserves its scroll position across a successful action, and
focused Chromium coverage verifies immediate document scrolling, same-page
success feedback, preserved position and durable reload. The persistent admin
shell now reads a bounded event summary, capability flags and notification
counts instead of loading the complete editable Event Setup aggregate on every
admin navigation.

The applications grid now selects the authorised, filtered page IDs before
computing speaker and routing projections for those rows. Migration `0048`
indexes immutable track-name selections used by the real category filter. The
scale fixture supplies valid form versions, immutable submitted snapshots and
10,000 persisted track selections, is applied before its dedicated Worker
starts, and keeps explicit event context for unsafe mutations. On 2026-08-20
the complete local scale profile passed: applications first-use 317.4 ms,
applications filter p95 295.7 ms, speaker first-use 280.6 ms, speaker filter p95
335.6 ms, Event Setup mutation p95 131 ms, schedule validation p95 203.8 ms,
event-change freshness p95 901 ms and local autosave feedback 826 ms.
Production p75 RUM, production-like D1/DO scale and field INP remain external
acceptance evidence.

### Deterministic auto-placement evidence

The draft Schedule Planner exposes deterministic first-fit auto-placement with
an exact preview and explicit confirmation. All proposed placements start
selected, and the organiser may apply any non-empty subset. Confirmation
recomputes and verifies the complete preview against the schedule, event,
conflict-policy and session revisions, validates and rechecks the selected
subset, includes its canonically ordered session IDs in the idempotency hash, and applies
only those placements atomically in D1. Deselected sessions remain unscheduled;
the result reports them separately from honest unplaced reasons and leaves the
schedule unpublished. Focused unit, Worker and Chromium schedule tests verify
this AIA-08 production slice.

Schedule publication now presents the material delta against the current live
version—added, removed, moved/resized and visibility-changed sessions—alongside
all currently known conflict, content-approval, speaker-confirmation and public
event-website/recording blockers. Description diffs compare the stored text
before applying the empty placeholder, and track diffs use the public track
label attendees will see. Private or hidden sessions are omitted from the
public-content list. Confirmation remains disabled while any blocker is
visible, and the authoritative mutation rechecks the exact schedule revision
and every invariant rather than trusting the preview. A leftover failed
publish result is not shown when the dialog reopens until this instance
submits again, and refreshing the preview after a revision conflict
clears that leftover error.

Auto-placement readiness uses the same deterministic planner as preview and
confirmation. Eligible sessions enable the action, while unavailable sessions
show per-session blockers such as missing duration, unpublished speakers,
unavailable rooms and conflicts. Focused Worker tests and desktop Chromium
coverage verify both the eligible flow and the explicit unpublished-speaker
blocker.

### Read-only schedule state evidence

Only a draft schedule version accepts placements, schedule notes and session
content. `scheduleEditLock` in `app/modules/schedule/schedule-edit-lock.ts` is
the single derivation of that state, replacing four separate inline checks that
could disagree about what "not a draft" meant.

**Reachable in this interface:** no version, `draft` and `published` only. The
workspace query selects `status IN ('draft','published')`
(`app/modules/schedule/schedule-workspace.server.ts`), so the remaining
statuses the `schedule_versions` CHECK constraint permits cannot currently
reach the planner: `publishing` is set and cleared inside the single atomic
publication batch, `archived` is only ever applied to a superseded version that
the query then skips, and no code path writes `failed` at all. The module still
maps those three because the rows exist in the domain and the `default:` branch
throws rather than inventing a caption, but their captions are unit-tested
domain coverage, not verified interface behaviour.

The state is stated in full exactly once, on a page-level bar that never
scrolls away in this fixed-height layout: which version froze the planner, what
is frozen — the board, schedule notes and session content — and the remedy. It
is titled "Schedule read-only" rather than "Read-only" because creating
sessions and breaks stays available on a published version and does not touch
it. Everywhere else carries only the fact the bar cannot: the board drops its
drag affordance while placed cards remain honestly enabled view controls,
frozen fields render inert, the collapsed inspector rail prefixes "Read-only",
and each frozen editor shows a one-line "Read-only" marker. The markers name
neither the version nor the remedy — repeating those
wrote the same two facts three times down a 320px column — but stay per panel
because the inspector body scrolls independently and the bar does scroll off at
mobile widths. The inspector head carries no marker at all; a further copy only
wrapped its heading and truncated the session name, and its close control is an
icon with an accessible name and tooltip for the same reason. Desktop Chromium
coverage verifies that the bar, the per-panel markers and the disabled notes
and session-content controls appear on a published version and clear on the
next draft, that a placed card remains keyboard-inspectable without claiming
to be disabled, and that the close control stays inside the clipped head. This
replaces the previous behaviour, where notes were disabled silently and the
session editor claimed "published" for every frozen status.

Disabled `.field`, `.select` and `.textarea` controls now render as inert
across every shell: sunken surface, secondary text, dashed border and a
refusing cursor. Buttons, checkboxes and radios already had a disabled
treatment, so a frozen text control was the only one that still looked
editable. The design-system reference documents the state beside the existing
read-only example, and the full responsive visual inventory is unchanged by
it — no reviewed surface captures a disabled text control in its baseline
state.

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
  restoring returns only the draft content to Draft; a 30-second placement undo
  is an exception that restores duration and editorial approval provenance.
  Publication requires each scheduled public snapshot to be Approved; private or
  hidden snapshots may publish without approval. Live visibility is copied from
  the published snapshot, and migration 0044 repairs pre-upgrade drift.
  Published-version snapshots may still receive descriptive-field updates, but
  approval, visibility and deletion are rejected regardless of visibility.
  The preview links hidden, unapproved and unconfirmed records, website
  dependencies and planner conflicts to their owning workflows, and service,
  atomic D1 and Airtable staging boundaries fail fast on drift. A blocked draft leaves the previous
  published programme intact. Existing content published under the former
  advisory rule is retained with `legacy_publication` provenance and no
  fabricated human approver.
- **Central library (CNT-14):** The administrator Content & files route reads
  at most 50 event assets and their current versions per page. Retained version
  metadata is loaded only when its disclosure opens and remains bounded to 50
  versions per request. Individual and ZIP downloads
  require the current released, signature-valid, clean R2 object. ZIP export
  previews an exact bounded manifest, requires confirmation, persists a durable
  idempotent operation before Queue dispatch, reports queued/processing/ready/
  failed status, revalidates each version and ETag in the worker, verifies the
  resulting archive in private R2 and exposes a scoped download only after the
  stored result is complete. It preserves duplicate filename extensions and
  conditionally opens and pull-streams only the current stored entry with
  response-cancellation through a dedicated binary resource route rather than a
  document action. Focused Worker coverage selects two current versions,
  processes the Queue payload, checks the ready status and inspects the ZIP
  bytes; missing queue/storage bindings fail explicitly. Stored archives live
  under the event cleanup prefix, expire after 24 hours, revalidate their
persisted source manifest and source ETags before every download, and are
revoked and deleted when a referenced file is erased. The worker renews its
claim while streaming and fences claim-specific objects on completion.
The Content URL retains a validated event-scoped ZIP operation so polling and
download recovery survive reload. Terminal cleanup records successful deletion,
uses a durable, reclaimable cleanup lease to exclude concurrent retry, and
retries only rows whose cleanup marker is still absent; the worker clears that
marker atomically when it claims a retry. File erasure retains an unexpired
worker claim and reports incomplete cleanup until the worker releases or its
lease expires, so later prefix cleanup cannot miss an interrupted write; generic
retry is also fenced during that active lease. An uninspectable event-scoped ZIP is conservatively
revoked and deleted during file erasure.
  A speaker-scoped task file is attributed to its linked session only when
  exactly one event session matches that speaker; ambiguous relationships stay
  visibly unassigned instead of selecting an arbitrary session.
- **Scope boundary:** This is session programme content and existing private
  file delivery, not a general-purpose CMS. Live R2/scanner acceptance remains
  external.

## Event branding workstream evidence

- **Production slice; schema deployment verified, live upload acceptance remains external:** `/admin/branding` owns a server-backed event branding
  draft with compare-and-set revision, representative desktop/mobile previews
  for the application, participant workspace, programme and email, and one
  confirmed publication boundary. Publication atomically advances the event
  and public-projection revisions, records audit/change evidence and projects
  the existing event configuration to Airtable when Airtable is authoritative.
  Success audit/change inserts require the exact committed domain post-state,
  so a suppressed mutation cannot leave success history. Non-no-op mutations
  require one audit and a positive durable event-change sequence; missing
  evidence after a committed mutation reports an explicit warning. Event Setup
  rejects legacy-field attempts to bypass the branding publication boundary.
- **Managed brand assets:** Event administrators can upload bounded JPEG, PNG
  or WebP logos and banners. Program Cue checks declared MIME and signature,
  requires a complete Cloudflare Images decode, enforces width, height and total
  pixel limits, removes animation and source metadata by producing a canonical
  WebP, and verifies the normalized result before storing it under an
  event-scoped private R2 key. D1 records its dimensions,
  normalizer version, ETag and normalized byte size. Draft reads require
  event-administrator authority; anonymous asset routes resolve only the logo
  or banner referenced by the active event's published snapshot and revalidate
  that ETag. Migration `0032_event_brand_asset_normalization.sql` added the
  fail-closed readiness and cleanup invariants after the deployed branding
  baseline. Production D1 records it as ledger row 33, applied on 16 August
  2026 at 03:35 UTC; the required columns, cleanup index and integrity triggers
  are present. No managed branding rows or event asset pointers currently
  exist, so this verifies schema deployment rather than a live upload/delivery
  journey. A publication race returns a non-cacheable 503 retry response rather
  than stale bytes or a false not-found result.
- **Published surfaces:** The published accent, logo, banner, welcome and
  support link reach the public application, participant workspace, programme,
  embeds and communication email. A deployed external logo or programme hero
  remains live only until the first managed Branding publication, which clears
  those retired authoring fields rather than silently preferring two sources.
  Program Cue attribution remains visible.
- **Asset lifecycle:** A live row is ready only after synchronous normalization;
  there is no scanner fallback or speculative asynchronous validation state.
  Assets unreferenced by both snapshots are tombstoned, then a scheduled worker
  removes R2 bytes and D1 rows while persisting cleanup failures for retry.
  Referenced assets cannot be retired or deleted, and event deletion fails until
  branding cleanup is drained. Migration
  `0032_event_brand_asset_normalization.sql` detaches and retires all old
  raw-byte rows rather than retaining an unsafe compatibility path.
- **URL validation and scope boundary:** Support URLs require credential-free
  HTTPS with a hostname. Organisation brand defaults, custom fonts, arbitrary
  CSS, per-event custom domains and white-label attribution removal remain not
  implemented. Event cloning is blocked while brand images, a legacy programme
  hero or unpublished branding changes exist; private R2 asset copying is not
  implemented and is never silently omitted.

## Public event-site workstream evidence

- **Production slice; deployed; local acceptance verified:**
  `/admin/site` is an owner/administrator-only, event-scoped editor backed by
  migration `0037_public_event_site.sql`. It has one compare-and-set draft and
  one immutable published snapshot, explicit preview and publication, and a
  unified branding/site/programme status view. The editor is a card of four
  switched panels — Homepage, Pages, Sponsors and Recordings — under a toolbar
  carrying the draft state and its single save control. The toolbar is sticky
  in the wide two-column workspace and static in the narrow switched layout, so
  it does not consume a large share of the phone viewport. The
  homepage panel is the homepage's own ordered section list, each row holding
  that section's visibility, position and editor. Saved sponsor and recording
  records are collapsed by default and open individually, and in the wide
  workspace the preview card is capped to the sticky viewport so its publish
  control stays on screen while the editor column scrolls. The migration and
  Drizzle schema
  add event-scoped site, published-reference, sponsor and recording tables with
  organisation/event foreign-key isolation. Audit and event-change evidence is
  conditional on the exact committed operation. The migration validates and
  applies locally and is included in production source `8a0c39f`. The release validator
  conditionally verifies its critical table columns, foreign-key definitions,
  indexes, trigger predicates and managed-embed theme migration once migration
  0037 appears in the remote ledger, rather than treating that ledger row alone
  as schema evidence. Migration `0039_featured_speaker_relationship_guards.sql`
  adds the matching last-relationship guards on `session_speakers` visibility
  changes and deletes; the release validator requires those triggers only after
  0039 is applied. Migration
  `0040_align_featured_speaker_session_guard.sql` aligned session hide with
  the then-weaker live speaker projection. Migration
  `0042_confirmed_public_speaker_eligibility.sql` unifies that live
  projection with publication: public speaker eligibility now requires a
  confirmed relationship, and the featured-speaker guards block hiding,
  deleting or unconfirming the final qualifying relationship. The migration
  refuses to apply while a published featured-speaker reference lacks that
  confirmed membership, and inserts an `event` change for any published
  programme that still has a public pending speaker so pre-cut cursors
  become stale. Confirming a public published-programme relationship writes
  the matching `person` change in the same guarded batch. Migration
  `0043_session_speaker_identity_immutable.sql` makes `session_speakers`
  `event_id` and `session_id` immutable, and allows `person_id` to change
  only for a participant-retention remap onto an archived
  `retained-participant-*` identity after featured-speaker references are
  withdrawn. The release validator requires that trigger after 0043 is
  applied.
  Approved public schedule content remains the separate `0021` immutable-
  publication invariant; the lightweight featured-ID reader does not
  reproduce that full snapshot-integrity query.
- **Independent event-home lifecycle:** A bounded site can publish before an
  agenda for CFP promotion. Introduction, venue, FAQ, sponsor and fixed-page
  content use the canonical event projection; featured speakers, featured
  sessions, statistics and post-event recordings fail publication validation
  until a programme exists. The main event route, fixed pages, metadata,
  revisioned social card and desktop/mobile preview all render this
  pre-programme state without fabricating a programme snapshot.
- **Bounded composition:** The homepage has exactly six fixed sections:
  introduction, featured speakers, featured sessions, published-programme
  statistics, venue/map and FAQ. Organisers can hide them and use keyboard-
  accessible Move up/Move down controls. Featured speaker/session selection is
  split into searchable available records and an explicitly ordered selected
  list with a visible 12-record limit; FAQ entries have the same keyboard
  ordering controls. Disabled fixed-page editors stay collapsed until opened
  or enabled. Desktop/mobile previews use the same
  renderer as the public homepage and can select any fixed page through the
  public page-content renderer; disabled pages are explicitly identified.
  About, FAQ, Venue, Code of Conduct and Sponsors are the only optional pages.
  Fixed-page bodies, FAQ answers and post-event introduction use a constrained
  Tiptap editor for subheadings, bullet lists, bold text and credential-free
  HTTPS links while preserving restricted Markdown as the validated and
  published storage contract, with no arbitrary HTML or routes. Fixed
  pages set that Markdown at their own reading measure and scale, with visible
  link affordances and body subheads one level below the page title; the
  Sponsors page groups entries into tier sections in the order the service
  reads them, which is by tier name. Enabled
  page navigation labels are case-insensitively unique and cannot reuse built-in
  destinations. Invalid or credentialed Markdown links fail draft validation
  and remain sanitized at render time as defense in depth.
- **Canonical data and publication integrity:** The visible event description,
  venue/address/map, published support URL and CFP action continue to come from
  Event Setup, Branding and the published form. The CFP projection applies the
  applicant workflow's closing-time and submission-limit rule: only an
  accepting form says “Apply to speak”, while a closed or full published form
  links honestly as “View call for speakers”. Public event/programme API
  responses and the pre-programme event home use ETag revalidation without a
  positive shared-cache freshness window, so closing, filling or manually
  changing a form cannot leave an accepting state fresh at the edge. Site publication
  snapshots editorial configuration and structured sponsors, not programme
  records. Featured IDs must resolve against the current published programme at
  site publication, are materialized only when visible, and are revalidated in
  both the schedule preflight and atomic schedule compare-and-set. A conflicting
  schedule stays unpublished rather than silently dropping homepage content.
  Event Setup locks the public slug after either site or programme publication,
  including at its atomic write boundary, so a pre-programme site launch cannot
  invalidate shared public URLs.
  Site publication also atomically rechecks canonical description/venue
  dependencies; public loaders repeat the checks, and Event Setup blocks removal
  of content required by the live site. Fixed editorial pages and generic event
  social cards load the published site and a D1 programme-version presence
  check; they do not materialize the full published programme or read Airtable.
  Featured IDs still fail closed against current D1 programme membership
  when those homepage sections are enabled. That membership check follows the
  public speaker projection (public confirmed relationship, published profile,
  published public session and content visibility). It does not reproduce
  `getPublished()`'s approved-content snapshot integrity query; approval
  remains enforced by migration `0021`. Fixed editorial page ETags combine the
  request resource, site content identity, site publication revision and the
  current D1 published-programme version identity, so a later programme
  publish cannot 304 stale nav or footer chrome. Generic social-card URLs
  remain site-revisioned because those images do not include programme chrome. Fixed-page loader representations omit the dynamic recording list,
  which they do not render; the programme homepage that can render recordings
  remains private and non-cacheable because it also carries visitor itinerary
  state. Invalid persisted snapshots or branding return a non-cacheable
  error; they do not disappear or receive a product-colour/placeholder fallback.
- **Replay and snapshot integrity:** Every public-site, sponsor and recording
  form submits a stable command UUID. Consequential command identities remain
  stable for the exact site or record generation across response loss,
  revalidation and reload. The existing D1 idempotency ledger binds each
  identity to the exact validated payload and durable result; exact replays converge
  without duplicate revisions, entities or audit rows, while changed-payload
  reuse conflicts. Every command has a final operation-specific D1 batch guard
  requiring its complete domain state, exact audit/change evidence, positive
  cursor and durable response; site publication additionally requires the exact
  featured-reference graph and next event projection revision, sponsor mutations
  require the parent's exact next draft revision, and recording
  publication/withdrawal require the next event projection revision.
  Fault-injection coverage independently suppresses audit,
  event-change, completion, featured-reference, parent-site and event-projection
  statements and verifies complete rollback. Site publication reads the site draft and ordered sponsors
  in one SQL snapshot before its revision compare-and-set. The confirmation
  names additions and removals rather than listing only the replacement's
  enabled content. Published-session status and public visibility are part of
  site publication, recording publication and recording-read eligibility; the
  baseline triggers block direct session changes that would invalidate a
  featured record or published recording, block demotion of a featured
  speaker profile, and block hiding a session or hiding or deleting a
  relationship when it is the last public confirmed published-programme
  membership for a featured speaker. A remaining public pending relationship
  is not sufficient. Direct SQL cannot hide, delete or unconfirm that final
  relationship while the person remains featured.
  Public loaders remain
  fail-closed instead of dropping referenced content.
- **Repository authority boundary:** Editorial site configuration, fixed pages
  and sponsors remain D1 control-plane workflow state for D1- or
  Airtable-authoritative events. Featured session/speaker references and
  post-event recordings require D1 programme authority until the existing
  Airtable immutable publication mapping carries a provider-bound eligibility
  manifest. The server rejects unsupported draft/publication writes before
  provider work and rechecks authority in the atomic mutation; the UI prevents
  new unsupported selections while allowing their removal even when absent from
  the current programme, provider-incompatible public snapshots fail closed, and published
  recordings retain an explicit withdrawal path. No D1 programme fallback is
  used for Airtable-authoritative events.
- **Promotion and post-event tools:** The organizer can copy the public URL,
  suggested announcement, escaped programme iframe and existing speaker share
  links, and can inspect the actual unfurl. Event and speaker social cards are
  rasterized from the authored SVG with resvg, then encoded as WebP by the
  required Images binding; the route returns an explicit 503 without Images or
  when rasterization or encoding fails. The local Images mock accepts SVG, so
  coverage also asserts that the binding receives PNG. Generic event cards use
  site revisioned URLs and do not read
  the programme snapshot; speaker cards still use programme/site revisioned
  URLs. External HTTPS
  recording drafts have a separate confirmed publication boundary, require a
  currently published session, and appear only after the first valid instant
  following the final event-local date and the session end. The configured IANA
  timezone, including zones that skip midnight during a transition, rather than
  the stored UTC calendar marker, defines that event boundary.
  Optional external captions and transcripts are linked beside the recording.
  Schedule publication preflight and its atomic guard prevent a published
  recording's session from disappearing silently. Withdrawal removes public
  access immediately while retaining the editable draft, even with unrelated
  unsaved site-editor changes. Disabled post-event
  mode does not serialize recording data. No upload, hosting, caption generation
  or rights-management success is claimed.
- **Themes and verification:** Public pages and managed embeds accept only
  light, dark or system. The closed public theme token set does not enable a
  global application dark mode; a dedicated axe case verifies the dark public
  programme contrast contract. Focused unit/Worker coverage verifies fixed
  composition, URL constraints, immutable snapshots, stale-write behavior,
  sponsor snapshots and edits, featured-record and recording schedule blocking,
  recording resources/timing, independent withdrawal and a real Images WebP
  render. Unsaved client configuration blocks navigation and tab closure.
  `e2e/public-site.spec.ts` asserts the reset-restored published showcase,
  replacement publication from that published state, and first-publish on a
  blank event. First publication now uses the same empty-baseline comparison as
  later publications. First-publish post-event editorial uses the same
  server recording projection as public pages. Website publication
  confirmation lists grouped changes without a record/change count.
  Coverage still includes discard confirmation, Event
  home/programme navigation,
  homepage/fixed-page desktop/mobile preview selection, ordered featured
  selection, FAQ ordering, featured-session detail links, 40-character labels
  without header overflow and conditional fixed-page caching. The shared header
  keeps primary destinations visible, groups programme variants and editorial
  pages inside Browse, and collapses fully at tablet width. Direct session-detail
  URLs are server-validated: a known session on the wrong public surface
  canonicalises to the sessions view and keeps the incoming query, including a
  shared-itinerary token, while duplicate, mixed, embedded or
  unavailable selections still fail explicitly. Session details reuse the
  speaker copy/share actions and offer Open session page only when the
  current URL is not already that session, keeping the incoming query
  including a shared-itinerary token. Later website publication
  summaries do not repeat theme, order, featured-record or enablement
  changes in the generic editorial line. Featured-record pickers cap the available list
  at 20. The homepage's glance panel is a dark event surface in the masthead's
  language; `programmeAccentPalette` derives separate inks for light paper, the
  dark `--accent-soft` fill and solid accent fills, and unit coverage checks
  representative pale, dark, mid-teal and rounding-boundary accents at 4.5:1.
  The published page measures the glance figures and labels against the
  resolved 28% accent stop under the first column, including the worst-case
  white accent, and parses Chromium's
  `color(srgb …)` mix rather than treating those channels as 0–255, and
  rejects a near-black false pass with an upper bound. It holds a
  floor under the homepage section headings so an unresolvable size token cannot
  silently collapse them to the inherited value, keeps featured speakers as a
  compact circular cast whose single-speaker wash hugs the card, makes the venue map
  a primary control, and keeps desktop light and dark homepage baselines.
  `/admin/site` passes
  the WCAG A/AA axe sweep at phone, tablet and desktop widths. The complete local
  core gate also passes, including TypeScript, production builds, the Agents
  Durable Object test, recovery, migration/contracts and synchronized OpenAPI
  validation.
- **Scope boundary:** Generic blocks, arbitrary HTML/CSS, nesting, custom
  domains, custom fonts, white-label removal, sponsor asset upload, media upload
  and media processing remain not implemented.

## Public programme gallery workstream evidence

- **Production slice (EMB-01/04/09/12/13/14/15):** The anonymous public programme exposes the published D1/Airtable snapshot through the existing service as Programme, `/speakers`, `/timetable`, `/schedule` and `/gallery`. Programme is the browse-and-filter list. Schedule has two explicit local views: Timetable is the time-by-room comparison and Day-by-day is the chronological, information-rich card presentation. The attendee header exposes one Schedule concept rather than five equal destinations, and My itinerary remains the visitor's saved subset, appearing only after a visitor saves a session or opens a shared itinerary. The retired `/agenda` and stateless embed URL permanently redirect to `/schedule` with their query intact; existing Agenda widgets and persisted managed Agenda configurations normalise to Schedule, while strict create/update input rejects the retired value. Existing `schedule` installations retain their chronological meaning and `timetable` owns the new grid identifier. Surface selection uses the matched React Router parameter, so framework `.data` revalidation URLs cannot be mistaken for a public surface and return a false 404. Sessions and chronological schedule cards include complete permitted public metadata; speakers are surname-ordered; gallery search and the keyboard-accessible detail panel use the same published speaker/session graph.
- **Data boundary:** Public D1 and Airtable projections require a published schedule version, public published sessions/relationships, public Approved content snapshots and published profiles. Approval provenance remains a database invariant and inconsistent state fails explicitly; the administrator UI never fabricates a missing approver. Missing snapshots still block publication. Public snapshots must be Approved; private or hidden snapshots may publish. Airtable staging applies the same exact-snapshot boundary before provider writes. Published-version snapshots cannot change approval or visibility and cannot be deleted. Headshot URLs still require released-clean current-version predicates. Only Priya Shah, Alex Morgan, Priya Raman and Marcus Okafor may use explicitly allowlisted bundled portraits on the canonical event, and only in local demo or production evaluation mode; any non-deleted real headshot asset suppresses that person's bundle. Anonymous itinerary rows use an event-specific HMAC of a signed, expiry-bound browser identifier, preventing database-level correlation across events and organisations while retaining one browser cookie. The portraits are presentation-only data, not participant upload infrastructure or an ordinary production fallback.
- **Accessibility evidence:** Description and biography expansion controls expose `aria-expanded`/`aria-controls`; the gallery card supports pointer and keyboard activation, has an explicit close control, preserves search state and returns focus to the opener. Programme session details likewise expose an explicit close action and restore focus to the exact trigger. Standalone Timetable session titles open a native modal containing the complete permitted session and speaker detail. Embedded Timetable titles instead open a labelled inline disclosure after the selected day, move focus to its close control so an auto-sized widget keeps it in the host viewport, close from the expanded title, button or Escape and restore focus to the exact title control. Filtering a selected session out clears that disclosure instead of reopening stale details when the filter is removed; the standalone view retains its explicit session-page action. Save controls and day controls retain keyboard access, and the mobile reflow avoids a pointer-only two-dimensional pan. Itinerary calendar export reports that the browser download was requested instead of leaving activation silent. Focused unit, Worker and anonymous Chromium coverage verifies these behaviors.
- **Session-link and filter evidence:** Canonical session-focus links use the validated session ID route, and changing session filters or search clears a pinned focus before navigation so the detail panel cannot contradict the visible result set. Focused unit and Chromium coverage verifies both transitions.
- **Embed builder:** The page-local builder generates and previews Programme, speakers, Timetable, Day-by-day Schedule and gallery widgets from the same published snapshot. Timetable and Day-by-day are grouped under Schedule with use-case guidance. Agenda is unavailable for new configuration; managed embed create/update input rejects it, while only persisted managed Agenda rows, stateless Agenda URLs and existing script installs with `data-surface="agenda"` normalise to Schedule. Session titles and speaker names remain the identifying minimum. The speaker-details field consistently controls rich speaker blocks, profile links and detail-panel activation across every surface; images, affiliations, biographies/pronunciation and linked sessions/counts remain independent subfields within that rich content, while speaker-directory visibility is a separate sessions-overview option. Generated iframe and auto-resizing widget snippets preserve the chosen surface and fields, while malformed values fail explicitly. Embedded Timetable details use an inline disclosure and expose no popup action; the functioning sandbox retains same-origin semantics because an opaque-origin browser trial blocked the framework module graph, while stronger isolation requires a dedicated embed origin rather than broad asset CORS.
- **Managed embed production slice:** Named D1 records add immutable stable slugs, compare-and-set configuration revisions, optional operator installation notes and audited draft/active/paused/revoked lifecycle controls without removing stateless snippets. The admin uses the existing exact preview and a plain before/after summary before activation or configuration changes. Public managed URLs read only the current published snapshot: draft/missing return 404, paused returns a branded non-cacheable 503 with `Retry-After`, revoked irreversibly returns non-cacheable 410, and active representation ETags include the configuration revision. Managed URLs reject query configuration and corrupt persisted JSON fails explicitly.
- **Scope boundary:** Automatic installation detection, deployment analytics, arbitrary CSS, XML output, a generic diff framework and participant upload infrastructure remain outside this workstream.

## Requirements traceability

| Requirement IDs           | Verified status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OBJ-001–006               | The connected local workflow covers application, evaluation, decisions, onboarding, scheduling, publication, communications and integrations. Replacement readiness still requires deployed/provider acceptance.                                                                                                                                                                                                                                                                                                                      |
| ADM-001–005               | Command Centre, blank D1/Airtable event creation, Event Setup, invitations, organisation/event grants, explicit switching and the route/role matrix are connected.                                                                                                                                                                                                                                                                                                                                                                    |
| CFP-001–009 / SUB-001–007 | Form authoring/publication, conditional schemas, anonymous and verified drafts, co-speaker claims, direct-session intake, admin grids and lifecycle commands are connected.                                                                                                                                                                                                                                                                                                                                                           |
| EVA-001–009               | Teams, invitations, multi-round review, assignments, mixed rubrics, moderation/reopen, decisions and acceptance onboarding are connected.                                                                                                                                                                                                                                                                                                                                                                                             |
| ABS-01/02/03/07           | Independent round configuration, round-scoped reviewer pools, numeric/dropdown/free-text criteria and round-level blind-review server enforcement are verified by focused Worker tests and the ABS-S2/S3 Chromium workflow; broader evaluation capabilities remain tracked under EVA-001–009.                                                                                                                                                                                                                                         |
| COM-001–006               | Email provider selection, sender provisioning, versioned templates, scheduled sends, automatic reminders, receipts/suppression and calendar OAuth/lifecycle are connected. Live Resend authentication delivery, tracked delivered/bounced receipts, both social sign-ins, both calendar-provider connections and both providers' invitation create/update/cancel lifecycles are verified.                                                                                                                                             |
| SCH-001–007               | FullCalendar list/day/week planning, configuration, breaks/resources, resize/unassign/undo, content snapshots, material publication diff/readiness, publication conflicts and exact public/calendar reads are connected.                                                                                                                                                                                                                                                                                                              |
| DSH-001–003               | Readiness, record-aware navigation/search, operation health, durable progress and event-scoped realtime invalidation are connected.                                                                                                                                                                                                                                                                                                                                                                                                   |
| NFR-001–005               | Typed builds, indexed server pagination, local performance harness, automated accessibility/cross-browser coverage, security controls, observability and recovery mechanics exist. Production RUM/scale, live recovery and manual accessibility acceptance remain outstanding.                                                                                                                                                                                                                                                        |
| OPT-001–006               | Multi-round evaluation, advanced task/resource flows, AI assistance, D1/Airtable event clone, import/export, saved views and higher-polish operational UI are connected.                                                                                                                                                                                                                                                                                                                                                              |
| WVD-001–003               | Accelevents export/reconciliation, versioned resources/files and responsive public programme/itinerary slices are connected; live provider acceptance remains external.                                                                                                                                                                                                                                                                                                                                                               |
| OUT-001–005               | General-purpose CRM, broad marketing automation, a generic CMS, payments and multilingual expansion remain deliberately excluded. The fixed-section public event site is a bounded editorial layer over canonical published data, not a generic CMS. Speaker Network is an explicit, bounded SBEK extra-credit slice constrained to programme-speaker relationships, sourcing and event-specific invitations; it is not claimed as frozen base scope.                                                                                 |
| CMP-001–013               | Repository evidence exists. Forge, deployed evaluator URL, competition submission, reimbursement, judging and walkthrough evidence are external and unverified.                                                                                                                                                                                                                                                                                                                                                                       |
| TEC-001–009               | The Worker/D1/R2/Queue/Workflow/Durable Object architecture, multi-event isolation, 33-path API, generated OpenAPI component schemas, provider boundaries, observability and recovery code are deployed. Retained logs, zero-backlog Queue metrics, a live Workflow backup, isolated restore, three scoped alerts and repeated firing alert exercises are verified. Autonomous post-fix cron completion, Cloudflare's failed Workers-alert-to-Notifications handoff and measured RPO/RTO remain outstanding.                          |
| UX-001–010                | Command search/saved views, readiness drill-downs, review workspace, consequence previews, draft recovery, safe undo, contextual/standalone AI, demo walkthroughs, isolated authoring previews and the unified Operation Centre are connected. Cross-surface smart defaults, progressive disclosure, linked validation summaries, organisation-scoped person lookup, near-limit counts, unsaved-change protection and URL-restored programme/schedule filters are connected. Manual assistive-technology acceptance remains external. |

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

On 21 August 2026 application health at `app.programcue.com` reported full
production source `8a0c39ff268c9c78822111095f479313de7b6595`; the latest
recorded scanner deployment evidence is source `c9e1287` at
`scanner.programcue.com`. Application source `8a0c39f` is the release-stamp child
of tested source `3108d2d` and includes the complete checked-in application
migration sequence through `0049_task_instance_configuration_snapshot.sql`.
This confirms deployment of the formerly candidate-only application paths and
migrations, but does not by itself claim a fresh production mutation or external
provider result for each path.
Migrations `0030_audit_contract_and_retention.sql` and
`0031_contextual_revision_evidence.sql` applied before the earlier Worker
cutover. Production-discovered migration
`0032_decision_draft_preview_contract.sql` then upgraded five legacy decision
previews, and `0032_event_brand_asset_normalization.sql` applied later as the
distinct ledger row 33. The WNAM D1 ledger retains both complete filenames;
`quick_check=ok` and foreign-key inspection returns no rows. The branding
columns, cleanup index and all integrity triggers are present. The explicit
audit provenance columns, insert/display contracts, append-only guards,
speaker-profile revision table and indexes, and exact review-scorecard evidence
columns are present. All pre-contract audit rows retain explicit
historical/version-0 labels. A fresh evaluation organiser selection persisted a
version-1 object with explicit `system` actor kind and `internal` origin, and
every retained decision preview now has both required fields.
The later release includes `0033_decision_draft_session_format.sql` and every
subsequent checked-in application migration through `0049`; their focused
migration and behavior checks remain the acceptance evidence unless a live
exercise is recorded separately.

Repository release-control hardening now preserves the two complete deployed
`0032` filenames while allowing only that exact historical numeric collision;
all future migration numbers remain unique. Checked-in GitHub workflows provide
an always-on core gate and a manually confirmed production path that runs the
complete browser gate, applies migrations, verifies the exact remote ledger and
required deployed schema, deploys the unchanged tested build and checks the reported
source revision. The manual deploy path uses that same entry point and reuses
its build, failing configuration, checkout, secret, immutable-ledger baseline,
schema or integrity preflights before applying remote migrations. Deployment
injects the clean checkout's full Git revision directly; no stamp-only commit is
required. Local `check:core` passed on 16
August 2026 with 62 unit files/352 tests, 171 Worker files/1,366 tests, the
Agent test, production build, 61 configuration tests, migration parity at 99
application tables, 120 indexes and 114 triggers, the 235-writer audit contract,
recovery drill, synchronized 33-path OpenAPI and scanner tests. A read-only
production preflight matched all 33 migration filenames, seven branding columns
and eleven branding indexes/triggers, with `quick_check=ok` and no foreign-key
violations.
GitHub branch protection and production-environment approval remain external
repository settings and are not claimed configured by these checked-in files.

The separately deployed public website remains live at `programcue.com` and
`www.programcue.com`. Current application health returned source `8a0c39f`; the earlier
release acceptance verified sign-in, evaluation access, the canonical
published programme and the public programme API at HTTP 200. A fresh
production evaluation organiser selection returned the expected 303
boundaries; Evaluation administration, Operation Centre and
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

Repository hardening now records organiser resource-upload cleanup as
`admin_ui` and participant task-evidence cleanup as `participant_ui`. Both
paths guard the exact discarded D1 state and audit identity in one batch before
the retryable post-commit R2 deletion; focused fault injection proves a
suppressed version or audit statement rolls the earlier mutations back.

On 15 August at 07:15 UTC, the scanner alert detected a Cloudflare Containers
`ContainerState.update` internal alarm exception with reference
`makudm19k86ps0vtg3e3si22`. The scanner application remained active, its
affected slot was running in London, `/health` returned source `c9e1287`, and
the latest 20 scan Workflows were all complete. This is provider-platform
evidence rather than an application scan failure; recurrence or a failure to
resolve should be escalated to Cloudflare with that reference.

On 17 August, account billing and live instance inspection found all four
`standard-2` scanner slots still running despite zero active scan operations and
no scan operation created after 13 August. Cloudflare recorded 549.33 GiB-hours
for the pool on 16 August, consistent with nearly continuous four-slot
allocation rather than file traffic. A zero-capacity cutover made every slot
inactive before scanner source `ae6133c` was deployed and four-slot on-demand
capacity restored. The ready application reports image digest
`sha256:87d8d269bf7c5ae98cd1501e71659033f7d4966e2c50b51599c70ad9b890ba20`;
all scanner slots remained inactive after rollout. That source exits a ready
container after one admitted scan, reduces the provider idle fallback to five
minutes and adds an independent in-process graceful-shutdown trigger after
forty minutes. Thirteen focused container tests, including a real local
HTTP-server shutdown, pass. A fresh post-cutover production upload completed
its scan on the first attempt: D1 recorded a clean verdict and release, while
the deterministic `scanner-slot-0` was observed running container version 12
in London and then inactive. All four bounded scanner slots were still inactive
in the delayed follow-up reading. The exact acceptance file was then permanently
erased through the participant UI and its D1 asset was tombstoned.

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
7. Complete security acceptance by removing ordinary inline styles, adding Trusted Types around intentional HTML sinks, and completing a deployed penetration test, secret-rotation exercise and production access review. A checked-in high/critical dependency audit, immutable-revision pull-request dependency review and weekly npm/GitHub Actions update policy are now present; their first hosted pull-request run remains acceptance evidence. Application scripts now use per-response nonces with inline script attributes disabled; typed third-party script/frame origins remain explicit. Deployment acceptance remains outstanding.

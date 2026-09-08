# Product and engineering decisions

This file records durable decisions. It does not imply that every decided capability is implemented; verified delivery status lives in `IMPLEMENTATION_STATUS.md`.

## Page announcements and section anchors — 8 September 2026

Route progress and page announcements compare the pathname and query string.
An anchor-only change stays within the page, including when Event Setup returns
validation errors to a section, and must not announce a new page title.

## Source quality tooling

Biome is the repository formatter and baseline JavaScript, TypeScript, JSX,
JSON and CSS linter. Its exact version is pinned, and the core and focused
validation gates run its non-mutating CI command. TypeScript remains the source
of truth for typechecking; Biome does not replace either TypeScript or the
observable behavior covered by Vitest and Playwright.

The initial configuration keeps Biome's recommended preset but explicitly
disables rules already violated by the pre-adoption source. Those exceptions
record migration debt rather than approval of the affected patterns. They are
to be removed in focused behavior-preserving batches with the relevant tests,
not hidden through broad per-file suppressions. Import organization is enabled
after its repository-wide baseline review. Non-null assertions are
prohibited in application production files; required values must instead be
narrowed by control flow or checked with an explicit fail-fast invariant.
Assertions in test and browser fixtures remain recorded migration debt for a
separate batch.
Generated build, Worker and route artifacts are excluded. The generated public
OpenAPI document and package lock retain their owning generators rather than
being rewritten by the formatter.

## Source quality boundaries — 6 September 2026

Every maintained TypeScript source, test and configuration file must belong to
one of the compiler programs. An inventory test checks the actual programs
against the working tree. Node/browser tooling and Worker contracts retain
separate environments; the OpenAPI emitter is checked with the Worker contracts
it imports and uses portable console output. Website release
validation and browser tests share a typed page inventory.

Submission finalization owns the single final D1 batch and subsequent dispatch;
its statement builders group the guarded transition, routing and direct-session
effects. Decision statement construction delegates accepted-session onboarding
and notification intent while keeping their ordering in the same atomic batch.
These extractions preserve the existing authority and revision predicates.

Speaker-detail panels receive the loaded record and explicit callbacks. The
page retains dirty-state reset, navigation blocking and confirmation ownership.
Public-programme pending text edits, URL acknowledgements, facets and clearing
share one filter hook; record selection and focus remain in the programme model.

Assistant transport results use runtime schemas as the source of their TypeScript
types. Person-command idempotency requires a result schema for every caller;
commands that encode a different stored shape also supply its schema and explicit
store/restore functions. Invalid durable results fail as server integrity errors,
preserve the completed record and never rerun the command. Validation does not
replace current-authority checks when restoring webhook secrets. Once execution
returns successfully, result validation, encoding or persistence failures retain
the processing claim. Retries can recover the canonical result or report an
in-progress command; they cannot release that claim and repeat the mutation.

## Documentation ownership

The README is the entry point for setup, common checks and document links.
The specification owns intended scope; this file owns durable choices and
rationale; the implementation audit owns dated validation, deployment and
acceptance evidence. Deployment, recovery, performance, evaluation and film
runbooks own repeatable procedures and link to evidence rather than copying it.
Generated OpenAPI JSON, font provenance/licences and the published user guide
remain because they serve runtime, redistribution or user-facing purposes.
Research is removed from active documentation after its adopted choices and
useful deferred hypotheses are preserved here; Git retains the original sources.

## End-user product documentation

End-user product help is published as static pages on `programcue.com/guide`,
on the existing public-site Worker. Role entry pages cover evaluators and
speakers or submitters. Organiser chapters follow the programme workflow.
It is not a separate documentation product, not a GitHub wiki, and not the
in-event speaker resources wiki. Signing up creates a login only; a first
conference workspace is provisioned for the team, after which organisation
owners and administrators can create further events. The signed-in
administration command palette and the participant workspace open that public
guide; they do not replace an event’s own support URL. Engineering status,
decisions and recovery remain in `docs/`. The interactive API reference
remains at `app.programcue.com/api/docs`.

## Licensing

Program Cue is released under the GNU Affero General Public License version 3
only (`AGPL-3.0-only`), without the automatic “or later” option. The licence
governs the repository source but does not itself grant trademark rights in the
Program Cue name or marks; bundled third-party works retain their own licences.
The public landing-page footer links to the canonical, publicly accessible
GitHub repository so remote users can obtain the source code.

## Modular monolith ownership boundaries

The public service and route entrypoints remain stable facades, but their
implementation is owned by focused collaborators: domain schema modules feed
one canonical Drizzle barrel; Airtable table specifications are grouped by the
same product domains; route modules delegate substantial server dispatch and
read-model projection; and provider/state-machine services separate read
models, durable recovery, archive/download, or published-asset work when those
concerns have independent invariants. These are direct modules, not a plugin or
generic handler framework. Domain authorization remains at the server service
boundary, and extracted collaborators continue to receive the exact authorised
viewer and organisation/event scope rather than reconstructing authority.

## Identity creation and access

Email magic links, Google and Microsoft may create an authenticated Program Cue
identity. Identity creation alone creates no organisation, event, membership or
participant relationship and therefore grants no private workspace access; a
signed-in unrelated identity receives a neutral no-access page. Organiser and
reviewer permissions still require an accepted membership, participant access
still requires a verified application, accepted relationship or invitation,
and invitation acceptance remains explicit. Published programme, gallery,
embed, API and calendar-feed surfaces remain anonymous.

A valid production-evaluation session is a separate authentication realm on
public application routes as well as private workspaces. A fixed clean/showcase
applicant persona takes precedence on eligible forms. Gate-only and
non-applicant evaluation sessions may resolve a valid form-scoped anonymous
draft and, after that draft's email proof, a verified applicant token issued
inside the same current fixture-reset generation. They never inherit Better
Auth or an ordinary applicant token. Password-protected forms retain their
normal password admission; an evaluator persona is not a password bypass.
Evaluation-bound verified tokens stop resolving when the evaluator session is
absent or its fixture generation changes. Outside the dedicated evaluation
fixture, an evaluator session may still use a form-scoped anonymous draft, but
email verification requires locking evaluation and fails before code delivery.
The dedicated evaluation browser harness may redirect Turnstile Siteverify only
when its explicit E2E fixture flag is present and the target is a credential-free
loopback HTTP URL. Every other runtime retains the fixed Cloudflare Siteverify
endpoint. Siteverify requests use manual redirect handling and reject every 3xx
response, so neither the production
nor fixture secret can be forwarded to another origin.
The production-only browser specification is excluded from ordinary demo and
quick Playwright projects and runs through this harness in the pull-request and
complete release browser gates after the shared production build is ready.

## Privileged and provider-credential security boundaries

Cookie-authenticated API-key and webhook mutations require a Better Auth
session created within the previous fifteen minutes. A stale owner or
administrator is sent through an explicit sign-in-again flow and returned to
the requested settings page. The social-sign-in action derives step-up mode
from the existing server-side session; no form field can downgrade it.
Privileged confirmation uses the one-time email link or Microsoft's supported
login prompt. Google remains available for
ordinary sign-in, but is intentionally absent from this step because its
documented account-selection and consent prompts do not prove a fresh
authentication event. Program Cue does not claim MFA assurance that the
supported paths do not all provide. Demo and evaluation identities remain
exempt because they are explicit non-production realms.

Calendar, integration and webhook credential encryption uses version-2 AES-GCM
envelopes with a non-secret identifier derived from the encryption key. Reads
accept the active key and at most one explicitly configured previous key; new
writes always use the active key. Runtime readiness requires every configured
active and previous provider key to be distinct from every other provider-key
slot. A bounded scheduled rewrapper uses
compare-and-set updates, runs every minute only during an explicit rotation
window and migrates legacy version-1 envelopes only in that staged window. The
recovery-capable code is deployed and old invocations are drained before an
operator activates the window with the previous key. A previous key is
operational transition state, not a silent or indefinite fallback.
Calendar envelopes carry a random, authenticated credential generation that a
rewrap preserves and a semantic token write replaces. If a token refresh loses
its first compare-and-set, an unchanged generation, expiry and status authorise
one second compare-and-set. This lets a pre-rotation Worker persist an
already-issued provider refresh token without decrypting the new-key envelope,
repeating the external exchange or overwriting a semantic credential change.
Webhook API idempotency fingerprints the high-entropy signing secret, not its
random-IV ciphertext, so a rewrap remains replayable while an actual secret
rotation still invalidates the earlier result. The rewrapper converts still-live
legacy ciphertext fingerprints before changing the envelope. The operational
rotation sequence, drain periods and removal checks are
maintained in the [deployment runbook](DEPLOYMENT.md#credentials-and-rotation).
Calendar version-2 additional authenticated data binds the organisation,
connection, provider and credential generation without changing the pre-release
schema. A first-time calendar account uses a stable connection identifier
derived from its unique person/provider/account tuple so concurrent callbacks
encrypt against the same identity before their upserts converge. Key-identified
OAuth state accepts the one explicit previous calendar key only for its
ten-minute callback lifetime.

Outbound webhook delivery resolves A and AAAA records through Cloudflare DNS
immediately before every request and rejects empty, mixed or exclusively
non-global answers. Every application Worker enables
`global_fetch_strictly_public`, so Cloudflare's outbound proxy also validates
the actual resolved destination on the public-Internet path when it connects;
the application-level DNS check is a fail-fast guard, not the atomic network
boundary. HTTPS, manual redirects, bounded response handling and the existing
endpoint authority re-read remain required. The supported
auto-resizing programme widget establishes its parent with an exact-origin,
exact-window and event-slug handshake; the embedded page sends resize messages
only to that origin. A hand-written fixed-height iframe receives no resize
messages unless it implements that handshake.

## Abstract management decisions

Blind review fails closed: only submitted fields explicitly marked with
`blindReviewVisibility: "content"` are returned to a blinded reviewer. Missing
or legacy metadata is treated as identifying, and title-derived references are
also removed by the server projection.

Each evaluation round owns its open/close window, blind-review setting,
round-scoped reviewer pool and exact scorecard identity/version. Persisted
dropdown options are ordered and non-empty; non-dropdown criteria cannot carry
options. Reusing a scorecard/version requires an exact rubric signature, while
changing a draft rubric creates a new scorecard identity/version.

Removing a round reviewer requires explicit confirmation and atomically cancels
that reviewer's unfinished assignments with a `reviewer_removed` reason. Such an
assignment may be reactivated only after the reviewer returns to the same pool;
other cancellation reasons are never revived. Migration
`0006_evaluation_round_depth.sql` backfills pools only from distinct existing
assignment reviewers, without a global-membership fallback.

An AI first-pass assessment is one immutable, provider-attributed score and
rationale for a submission in an exact round/scorecard revision. Its durable
request and artifact also retain the submitted revision ID/number, SHA-256 of
the exact submitted snapshot, SHA-256 of the exact model input contract and
prompt version. Reservation and final persistence compare the exact submitted
snapshot, so source drift cannot save an assessment. It is not a reviewer draft
and never changes a human review or the committee aggregate. The chair result
view presents the canonical human aggregate, immutable AI advisory and
attributed human assessment of that advisory as three independent facts; there
is no combined effective score. Owners and administrators may record the human
assessment, while a committee chair requires the active plan's explicit
decision authority. That authority and the assessment revision are rechecked
inside the update transaction. The human assessment is stored and audited
separately so the original model output, provider, model and response identity
remain visible. Invalid structured model
output, missing provider configuration and round/rubric drift fail without a
default or simulated score. Responses-compatible providers must return a
`completed` response; `incomplete`, failed or still-running statuses are rejected
before output parsing and retain the provider request identity and reason. The
generated rationale is bounded to 2,000 characters and receives a 4,000-token
response budget because reasoning and final output share that completion budget.
A failed provider attempt is never retried automatically. An administrator may
explicitly create one new attempt for the same current target only after
acknowledging that an indeterminate provider outcome may produce a duplicate
request or charge; the failed operation and its provider evidence remain
immutable and the new operation links back to it.
The evaluation UI resolves the leaf of that complete durable attempt chain, so
a running retry suppresses its failed parent and links to the exact operation;
the current navigation supplies an honest starting state before loader
revalidation. A completed leaf is represented by its required persisted
assessment rather than a second operation card. A running attempt with a staged
result or expired provider claim exposes an explicit owning-workflow
reconciliation action: it either persists that staged result or records the
indeterminate attempt as failed, and never dispatches another provider request.

An active or draft evaluation round remains configurable only until its first
assignment or AI assessment. Scorecard edits fork the next immutable version;
clearing a criterion removes it. Only the final unused draft round may be
deleted, after a confirmation bound to the exact plan, round and reviewer-pool
snapshot. Existing review history is never made editable to repair a later
evaluation scenario.

A new review cycle explicitly archives the current plan and rounds as immutable
history, then creates one fresh active round with no copied reviewer pool or
assignments. Terminal submissions may enter that fresh cycle only when their
published decision proves the terminal state came from an archived cycle; the
terminal submission status itself is not reopened. A released decision made
under the explicit no-review-evidence override snapshots the exact current plan
in its immutable effect preview, because it has no round from which to derive
that provenance. The decision commit atomically verifies that the snapshotted
plan is still the event's sole current plan, so a concurrent cycle change fails
instead of attaching already-stale provenance. Current-work queries and
mutations exclude archived assignments, reviews and pools, including submitted
reviewer history. Its
editable rubric is prefilled from the latest round and the interface names that
source; a plan without a source round is invalid and does not fall back to a
generic rubric.

Reviewer reminders reuse the ordinary Communications draft, preview and
confirmation workflow. Review administration prepares an exact manual-recipient
draft from a published ad-hoc template; it never sends directly. Abstract result
exports are same-origin, audited, round-scoped CSV operations with formula
neutralisation, durable intent identity and explicit source/output size limits.

Automated reminders use the same merge-field/audience compatibility invariant
as previews and confirmed sends. Trigger save and enablement reject an
incompatible published version, while an enabled trigger also prevents saving
or publishing an incompatible replacement version. Task-specific reminders
remain available for due and overdue task cohorts; the seeded generic
participant-action reminder uses only recipient and event fields so it can also
serve draft-applicant and pending-participation cohorts.

Submission routing attention and queue navigation are derived presentation,
not new workflow state. Automatic-route gaps and administrator overrides come
from the immutable form/routing snapshots already required by submission
detail. Previous/Next navigation retains the originating server-side filters
and ordering, while Review and activity handoffs link to the existing
authorised evaluation and audit surfaces. No parallel lifecycle timeline or
mutable queue record is introduced.

## Content management workstream decisions

| Decision | Outcome |
| --- | --- |
| Content history | Schedule-version content snapshots remain the current working record. Every change also appends an immutable attributed revision containing all fields needed for exact inspection and restoration; restoration from content history creates a new Draft revision and never rewrites history. A 30-second schedule placement undo is not content-history restoration: it reverses the last placement mutation by appending a restore revision that returns duration and the editorial approval provenance that placement invalidated. |
| Publication boundary | Confirming schedule publication makes the exact immutable schedule-version content snapshot authoritative for public, API, Airtable and calendar consumers. Its confirmation previews added, removed, moved/resized and visibility-changed sessions, plus snapshotted public content changes to title, description, track, format and duration, against the current published version. Speaker identities and live room labels remain current published values, not this snapshot. The confirmation stays open until publication succeeds or fails, and lists every known conflict, content, confirmation and public-site blocker with a link or planner reveal to the owning record. Every scheduled public snapshot must be Approved; missing snapshots still block publication. Private or hidden snapshots are publishable without approval. These checks run before provider work and are rechecked in the atomic D1 write. The preview is guidance over the current revision, not a substitute for final fail-closed revalidation. A blocked draft never replaces the last published programme. Editing or restoring content from history returns only the draft revision to Draft, so organisers may continue working without withdrawing approved live content. An exact 30-second placement undo is an exception: it appends a restore revision that returns duration and editorial approval provenance to the pre-placement state. Content already published under the former advisory policy is retained with explicit `legacy_publication` provenance and no fabricated human approver. D1 rejects invalid publication transitions, entry insertion or reassignment into a published version, any approval, visibility or deletion change to a snapshot on a published version, and making an unapproved scheduled session public. Recovery may restore an empty published version first, but must restore coherent approval provenance before its public entries. Airtable staging applies the same approval boundary before provider writes. |
| Central file library | The library is a tenant/event-scoped view over existing `file_assets`, `file_versions` and private R2 objects, not a second upload store. The initial read is limited to 50 assets and their current versions; retained history is loaded in separate 50-version pages. Downloads fail closed unless the selected version is current, released, signature-valid, scan-clean and ETag/size matched. ZIP export is bounded, previewed and explicitly confirmed; it preflights metadata before returning download headers, then conditionally opens and pull-streams only the current R2 body with cancellation. The confirmed binary download posts to a dedicated resource route so React Router never tries to deserialize ZIP bytes as document action data. |

ZIP generation is now a durable operation rather than a long-lived document
response. The confirmed manifest is persisted with an idempotency key before
Queue dispatch; the worker revalidates the exact current versions, writes the
archive to private R2, verifies its ETag and size, and records the result before
the UI exposes a download. Missing Queue or storage configuration, queue-send
failure and processing failure remain explicit operation failures.

Stored ZIP exports are scoped beneath the event's private R2 cleanup prefix,
use a claim-specific object key, expire 24 hours after completion, and are
revalidated against their persisted current-file manifest and source ETags on
every download. File erasure revokes matching exports before cleanup, and a
lost Queue claim cannot publish its temporary object; completion is fenced by
the claim token. Successful R2 cleanup records a terminal cleanup timestamp so
scheduled retries advance past already-cleaned failures while still retrying a
failed deletion. Cleanup first holds its own durable, five-minute reclaimable
lease, which prevents a generic operation retry from racing deletion or
inheriting a stale cleanup timestamp. File erasure retains an unexpired ZIP
worker claim, reports incomplete cleanup, and waits for the worker to release
or expire that claim before removing the whole prefix; the ZIP worker also
clears the marker while claiming work. Generic ZIP retry is unavailable during
that worker lease, including in its atomic update predicate. An
uninspectable event-scoped ZIP is revoked during file erasure because its
manifest cannot prove it excludes the erased file. The prior deterministic ZIP
result/key format was not deployed, so this pre-release slice stores and reads
only the current claim-token format. The Content URL retains a validated,
event-scoped ZIP operation ID so polling and a ready download survive reload.

## Public programme workstream decisions

**Public embed surfaces.** The embed URL and generated widget allow exactly five
published surfaces: programme sessions, speakers, timetable, day-by-day
schedule and gallery. One
strict allowlist controls optional supporting fields such as time, location,
track, format, descriptions, rich speaker details and linked sessions. Session
titles and speaker names remain the identifying minimum; disabling the
`speaker-details` field removes avatars, affiliations, profile links and
detail-panel activation without hiding those names. Speaker-directory
visibility is the separate sessions-overview `directory` choice. Iframe and
auto-resizing widget output share this stateless contract, unknown surfaces or
fields fail explicitly, and every surface continues to read only the current
immutable published programme snapshot. Managed embed records store only
validated presentation configuration and lifecycle state; arbitrary CSS and
parallel content stores are not introduced. The retired agenda surface is not
available for new embeds. Durable managed agenda embeds read as Schedule, and
already-shared stateless agenda URLs permanently redirect there without losing
their query. Existing script installs with `data-surface="agenda"` also
normalise to Schedule when the hosted widget runtime loads; strict create and
update input rejects Agenda and new generated snippets never emit it.

**Public homepage view state.** When an event has a published event site, the
root programme URL is Event home and does not render a local view switcher.
Programme is also a complete destination without a duplicative local switch.
The dedicated Schedule and Timetable routes share a `Timetable | Day-by-day`
switch, while speakers retain `Directory | Gallery`. Without a published event
site, the root remains the programme itself.

| Decision | Outcome |
| --- | --- |
| Public programme surfaces | Programme, speakers, Timetable, Day-by-day Schedule and Speaker Gallery are route-level views over one `PublishedProgramme` snapshot. Programme owns browsing and filtering. Schedule is one attendee concept with two explicit views: Timetable owns room-by-time comparison, while Day-by-day owns chronological, information-rich cards with session descriptions, full time and place, track/format, speaker affiliations and standalone save controls. Activating a Timetable session opens its permitted published details without replacing the timetable: standalone pages use a focus-restoring modal and retain an explicit session-page link, while embeds use a focus-managed inline disclosure so auto-sized widgets cannot centre details outside the host viewport. My itinerary remains the visitor's saved subset; its navigation and panel appear only after a visitor saves a session (or opens a shared itinerary). The gallery does not create a second speaker or schedule store, and all private reads retain event, publication, visibility and profile predicates. Optional speaker title, organisation and biography fields render only when present; attendee surfaces do not turn missing profile data into administrator-facing quality labels. Stable identifiers retain their historical meaning: `schedule` is chronological, `timetable` is the grid and retired `agenda` is compatibility-only. |
| Demo headshots | Only the canonical local-demo or production-evaluation event's published programme projection and optional application featured-speaker preview may use the four bundled raster assets for the four explicitly allowlisted fixture people (Priya Shah, Alex Morgan, Priya Raman and Marcus Okafor). They are not authenticated profile or file state. Any non-deleted real headshot asset, including an unreleased, quarantined or otherwise ineligible one, suppresses that person's bundle. Ordinary production requires a released clean R2 version and never treats participant-upload metadata as upload or scanner success. |
| Gallery accessibility | Gallery cards are keyboard-activatable controls; detail is an in-page dialog panel with an explicit close button, deterministic biography expansion and focus restoration to the opening card. Search state remains component-owned while the panel is open. |
| Speaker amplification | `?speaker=` is public speaker-detail state resolved server-side against the current published snapshot. Invalid or unpublished identities return 404. Opening and closing a profile changes browser history; Copy link is universal and Web Share is progressive enhancement. Canonical and unfurl URLs are absolute and speaker-specific. `og:image` is emitted only for a current anonymously readable released headshot, never for a bundled demo portrait or private file. Social OAuth and generated promotional images remain out of scope. |
| Event presentation | Venue address and HTTPS map URL remain Event Setup configuration rather than values inferred from venue name or city. The deployed HTTPS programme-hero URL remains a read-only published legacy projection until the first Branding publication; a managed Branding banner supersedes it and publication clears it. The venue rail renders only when address or map information adds detail beyond the masthead. |

Operational status language names only the evidence actually checked. Upcoming
sessions therefore report “Attention” for a blocking conflict or outstanding
high-impact session task, and otherwise “No blockers found”; they do not claim
the broader “On track” state. Delivery health lists only channels represented
by durable delivery records and never advertises unconnected transports. Its
“accepted or delivered” numerator includes provider-accepted `sent` records as
well as delivered/opened/clicked records; it does not relabel acceptance as
provider-confirmed delivery.

Reviewer conflict attestation is a durable prerequisite for new review
submissions. A null attestation on a review completed before this policy means
“not recorded under the prior policy”; migrations never fabricate a historical
affirmation or timestamp. Reopening a review preserves the prior timestamp in
the immutable reopen revision, clears it from the current review and requires
the reviewer to answer again before resubmitting.

## Participant invitation and profile ownership

Knowing an email address is neither participant consent nor programme
confirmation. Administrator-created speaker memberships remain pending for
seven days and grant no workspace or administration access until accepted.
Portal membership invitation/acceptance controls access only. Each
`SessionSpeaker` separately records session-specific participation independently
of portal membership: a
speaker's claimed/submitted relationship is confirmed from that direct action,
while an administrator-created direct-session relationship remains pending
until the speaker confirms in their workspace or an administrator explicitly
records external confirmation. The latter names the affected session, requires
an acknowledgement and appends audit evidence. Schedule publication fails while
any scheduled participation remains unconfirmed and rechecks that invariant in
the atomic publication write. Direct sessions still reject unrelated global
identities, manual applications require accepted event participants, and public
co-speakers are linked only when claimed.

Session participation has three explicit states: `pending`, `confirmed` and
`declined`. A participant may accept or decline only a pending invitation;
decline notes are optional, private and bounded to 500 characters. A confirmed
participant uses the event support channel to coordinate withdrawal because
that change may require public-programme and calendar work. An organiser may
reset a declined relationship to awaiting confirmation, but that reset sends
nothing. Every transition advances a relationship-scoped participation
revision. Commands compare that invitation-cycle revision so exact retries
converge while delayed requests from an earlier cycle and changed decline
reasons fail stale. Reset clears the decline timestamp and reason. Audit records
the transition and actor but never copies the free-text reason. Missing or
malformed D1 batch results are integrity failures; they are never interpreted
as a zero-row transition or a converged retry. The participant dashboard treats
both confirmation and decline as terminal responses, so a declined invitation
does not leave an impossible preparation action.

A declined relationship grants no access to that session's participant tasks,
comments, evidence, files or session-targeted resources and contributes no
session-task recipient if that audience is added later. Existing reminder
audiences resolve speaker-targeted tasks only, so declining one session does
not suppress unrelated speaker reminders. Shared session work remains active
while another pending or confirmed participant can act. Participant-facing
session work stops contributing readiness when none remains, but
`administrator_only` work remains readiness-relevant regardless of participant
eligibility because organisers may still need to close the session operationally.
The Tasks summary, Command Centre and upcoming-session risk calculation use that
readiness rule independently from participant accessibility. Declining one
session does not alter event membership, submitter access, another active
session or an event-wide speaker workflow. Generated resource-acknowledgement
tasks recheck the current published resource audience, so a task cannot outlive
the exact accepted/session audience that granted it while event-wide person,
role and speaker audiences remain independent. The same current-audience rule
applies to participant API task reads and task-reminder recipient cohorts, so an
inaccessible acknowledgement cannot leak through another delivery surface.
Participant dependency hydration applies the same authorization independently:
an inaccessible prerequisite exposes neither its identity, title nor state, but
retains one generic blocked prerequisite so the dependent task cannot appear
actionable when the participant has no way to complete its dependency. That
fail-closed state is rechecked in participant completion and file-evidence
submission writes, so completing or waiving the hidden prerequisite never makes
the dependent task participant-actionable or reveals its state.
Participant API file reads also reauthorize task-targeted assets against the
current task relationship; declining a session removes its evidence metadata as
well as the task itself while leaving independently owned files available.
API task creation repeats target and owner eligibility in the atomic insert;
when participation changes after preflight, the batch rolls back its task and
idempotency claim and reports a conflict instead of committing orphan work.

Participant collaboration and organiser support remain bounded rather than
becoming a configurable portal system. A participant's session view may name
other pending or confirmed participants on that same session and show their
role and response state. It never exposes their email address, private decline
reason or a declined relationship. Organisers may open a read-only participant
workspace preview assembled from the same participant-authorised portal,
application, task and resource projections. That preview does not impersonate
the participant, create a participant session or expose mutation/download
controls; the organiser remains visibly signed in under ordinary administrator
authority.

Organisers may author bounded structured questions for `short_form` task
templates using the existing typed task-form schema. Answers remain task
evidence and do not silently update participant profiles or session records.
This is deliberately not a second general form builder, portal-policy layer or
field-binding system.

An applicant may permanently discard only an owned, unsubmitted draft at its
exact revision. D1 persists that exact-revision discard intent and blocks
concurrent draft, co-speaker and new-upload mutations before any private native
upload is revoked or erased. The final D1 deletion requires that same durable
intent and succeeds only after every private version is erased; an anonymous
uploaded draft must first be transferred to a verified identity so file erasure
has an attributable owner. Browser recovery is retained until the server
confirms deletion, then cleared from the committed response rather than before
the request. Response-loss retries replay only the exact scoped discard audit
fact, including applicant identity, form and revision. The accepted
submitter membership is removed only when its `last_operation_id` proves that
a draft-creation fact granted it and no other owned application still needs it.
The submitted lifecycle remains withdrawal with immutable history, not
deletion. Draft discard preserves one redacted append-only audit fact and emits
no invented webhook event.

External active-participation consumers fail closed consistently. Accelevents
exports only confirmed speaker relationships. Calendar administration offers a
new request only for confirmed participation but retains an existing invitation
for explicit cancellation and history. RSVP reconciliation rechecks confirmed
participation before contacting the provider and again in its durable update,
so a concurrent decline cannot restore a confirmed invitation state. Private task API owner/target fallback
checks count only pending or confirmed relationships unless an independent
accepted event membership grants the speaker scope. AI draft session copy may
include pending participants but excludes declined relationships. AI task
proposal validation uses the same active-participation target and owner rules as
the task command, and AI task/reminder cohorts recheck the current published
resource audience before describing participant work.

Participant session corrections use one optional built-in task preset,
`session_details_review_v1`, rather than a participant-authored proposal
system. The task is explicitly shared at session level and presents the
canonical title, description, format, duration and track; a pending or confirmed
participant may complete it for the session, and `completed_by_person_id`
records who did so. Participant role is deliberately excluded because it varies
per relationship and would make shared evidence falsely personal. Completion
records and compare-and-sets both the displayed session revision and a
fingerprint of those displayed values. The authenticated participant task API
returns that canonical field set, revision and fingerprint before accepting the
same evidence on completion. Later edits are shown as a task-level
revision mismatch and do not imply approval by every linked participant or of
the new content; another review is an explicit organiser action. A completed
preset without canonical review evidence is corrupt and fails explicitly rather
than appearing to have no prior review. Administrators may waive or reopen this
task but cannot complete or approve it, because doing so would assert a
participant review without its revision-bound evidence. The session
page links only to that exact task's comments and focuses the message field. If
the preset is not assigned, it uses the configured participant support URL and
otherwise omits the correction action. Comments request a correction without
completing the task. Individual participation consent remains the separate
per-session Accept/Decline decision. The immutable preset marker and task shape,
not a generated template identifier, identify this workflow so cloned events
retain their correction link. An event may contain only one such preset;
duplicates or a preset whose required behavior has drifted fail explicitly.
Cancelled or archived sessions make this preset unavailable to participants and
exclude it from participant readiness without changing unrelated operational
session tasks. Participant-retention finalisation treats its descriptions,
evidence and complete comment thread as participant data. Actor identities are
remapped only when the task target, explicit owner or session relationship and
immutable `participant_ui` action evidence establish participant provenance;
file evidence recognises its distinct `task.file.submitted` action. An organiser
reply is therefore redacted without being misclassified as participant activity,
including when that organiser is also a speaker in the session; comment audits
record the actual administrator or participant UI origin. Unrelated organiser
session tasks remain operational records.
Cross-event identity classification includes those completion, evidence and
comment references so retention cannot anonymise an identity still used by
another event.
Participant API completion recovery attributes completed tasks through
`completed_by_person_id` and approval-required submissions through the exact
operation-derived evidence row, so both committed states can be replayed
without weakening actor isolation.

Manual and direct-session speaker invitations validate authentication, sender
and Queue readiness before the domain mutation. Their communication operation,
delivery and verification token are then persisted atomically with the pending
membership. Queue failure is durable partial failure, and idempotent replay
resumes or reports the recorded delivery instead of fabricating an empty
success. Manual invitations collect only email and a name for a brand-new
identity; existing participant-owned profiles remain unchanged.

Participant UI and REST profile edits use one canonical full-profile
compare-and-set mutation. The REST patch may remain smaller, but it shares
validation, audit, `speaker.updated` webhook, durable realtime invalidation and
the Airtable authority boundary. Submitted speaker snapshots remain immutable.

Before review begins, a verified primary submitter may explicitly replace the
current submitted proposal with a newer revision while its exact published
form remains open. The command validates against the originally submitted form
version, advances an exact compare-and-set revision, replaces the current
submitted snapshot, and retains every prior submitted revision. It does not
reapply the new-submission limit. Existing speaker relationships and native
upload references are immutable; a new co-speaker may only be appended after
the sender, Queue and durable invitation plan are ready. Any active assignment,
review, conflict, moderation, decision, AI assessment, derived session,
terminal submission state or closed form blocks the revision rather than
falling back to a draft or rewriting downstream evidence.

The submitted-revision command binds actor, organisation, event, command scope,
idempotency key and request hash. Its exact submission and participant-speaker
snapshot is revalidated inside the compare-and-set write, so a concurrent claim
or relationship change survives while the stale revision fails. The command
row, current snapshot, immutable submitted revision, track/routing replacement,
audit, bounded durable result and every expected co-speaker invitation/webhook
operation commit in one D1 batch; a completion assertion rolls the batch back if
the result or expected operations are incomplete. Exact and concurrent replay
returns the recorded result and dispatches only persisted, undispatched
operations. Reusing the key with changed input conflicts, and response loss
cannot create a second revision.

After acceptance, the verified primary submitter may add a role-labelled
co-speaker only after explicitly confirming the exact recipient and while the
application has exactly one derived session in an editable unscheduled or
scheduled state and the form's speaker limit still permits it. This appends an
attributed submission revision and an unclaimed relationship, queues the
existing expiring claim invitation and never rewrites the submitted answer
snapshot or links a global person by email alone. Claiming carries the recorded
role into that session, activates speaker access and idempotently materialises
the published acceptance decision's speaker onboarding task graph using the
original decision time for acceptance-relative deadlines. Direct-session intake
has the same session lock but does not fabricate an evaluation decision or task
plan.

## Reviewer AI suggestions

Reviewer assistance is event-opt-in and requested by the assigned reviewer only
after that reviewer has saved an initial draft. Each suggestion is immutable and
bound to one assignment, reviewer, assignment revision, submitted source
snapshot and scorecard version. It may propose values only for closed criteria;
free-text criteria receive rationale and evidence references but no generated
review text. Evidence is stored as field identifiers and rendered from the
immutable reviewer-visible submission snapshot. The chair's first-pass
assessment is a separate artefact and is never reused or exposed here.
Reviewer assistance is available only when D1 is the event's authoritative
repository; Airtable-authoritative events fail before any provider call rather
than reading a potentially stale D1 projection.

An offered suggestion can only be dismissed or imported. Import writes through
the ordinary review save workflow and records suggestion and criterion
provenance on the review revision. The bulk action fills only unanswered closed
criteria and never replaces the reviewer's saved independent answers; changing
an answered criterion remains an explicit edit. Import does not write private
notes, feedback, confidence or a final recommendation. On submission, each
imported criterion whose value remains unchanged requires an explicit reviewer
confirmation. Changed values require no AI confirmation. Suggestions themselves
never enter review aggregates. Provider work uses a bounded lease; an
interrupted or provider-completed generation that cannot be reconciled becomes
an audited failed operation. Another provider call requires the reviewer to
acknowledge the possible duplicate usage or charge explicitly and is never
automatic.
Every provider-call claim also enforces rolling 24-hour ceilings of three
attempts for the assignment and 100 organisation-wide attempts. Attempts,
including ambiguous and failed calls, consume capacity because they may already
have incurred provider cost. A rolling assignment window prevents transient
provider failures from permanently disabling later review work. The existing
durable operation and activity views are the usage ledger; no second
quota/accounting subsystem or cooldown state is introduced.
Immediately before sending evidence to the provider, one guarded D1 claim
revalidates the exact event repository and opt-in revision, reviewer pool,
assignment status and revision, active round and scorecard, immutable source
snapshot and saved initial draft. The claim also requires that no active
suggestion or unexpired generation exists for the assignment. A failed
provider call remains visible for duplicate-risk acknowledgement even when a
later draft save advances the assignment revision.

Reviewer-AI setting, request, generation, failure, interruption and dismissal
transitions commit only with their exact audit identity. Each D1 batch ends in
an SQL assertion over the complete invariant so a suppressed audit or terminal
operation write raises a database error and rolls the batch back. Review rows
are the single import relationship: the suggestion does not retain a redundant
`imported_review_id`, and baseline triggers enforce the exact assignment,
evaluator, revision, round, target, scorecard and lifecycle relationships for
suggestions, current reviews and immutable revisions. Reopening copies the three
AI provenance fields into the new immutable revision. When a competing actor
wins an expired-lease recovery or failure race, the caller converges only on a
terminal operation carrying the matching terminal audit; an unaudited terminal
row remains an invariant failure.
Provider completion is accepted only when the response carries its own model
attribution. The configured request model is not substituted for missing
provider evidence, because aliases or provider routing could make that value an
inaccurate account of the model that actually produced the suggestion.

## Selective deterministic scheduling

Auto-placement confirmation always verifies the complete original deterministic
preview against the current event, policy, schedule and session revisions. The
client may then select any non-empty subset of that verified proposal. The
server derives that exact subset, revalidates it against the current schedule
and within itself, includes the canonically ordered selected IDs in the idempotency request
hash and applies it atomically. Deselected sessions remain unscheduled and are
reported separately from sessions the planner could not place.

Auto-placement readiness calls the same pure planner as preview and
confirmation. A button may be enabled only when that planner returns at least
one eligible session; otherwise the UI lists each deterministic blocker,
including missing duration, unpublished speakers, unavailable rooms and
conflicts. Event Setup room creation follows the same explicit rule: a server
command validates the name/capacity, performs a revision-checked canonical
setup save and revalidates the returned list before the room can be used by
scheduling.

Evaluation public-applicant verification challenges persist the authentication
realm in which they were requested. Evaluation challenges require the same
active fixture-reset generation at redemption, and ordinary challenges cannot
be converted into evaluation sessions. Migration `0046` revokes the
unclassifiable pending challenges present at upgrade instead of guessing their
realm.

Assigned task instances own an immutable snapshot of the template evidence mode
and validated configuration. Later template edits affect only future
assignments. A `link_visit` template therefore requires an organiser-owned,
credential-free HTTPS destination; participants open that configured link and
explicitly acknowledge visiting it. The acknowledgement records the assigned
destination and time, while navigation telemetry is not treated as proof.
Before migration `0049`, the release preflight inventories existing link and
file templates plus anomalous direct assignments. Deployment stops until link
destinations are valid and file purposes are explicit; it never promotes a
participant-entered URL or guesses a file task's scope.
Active templates and every template still referenced by a historical task are
checked. Completing or waiving an ambiguous task does not make its eventual
snapshot valid. A reported direct or mismatched assignment must be attached to
an explicitly reviewed matching template or removed through an approved,
ID-specific data remediation before deployment; template retirement is not a
general remediation path. The preflight reports every affected ID rather than
truncating the remediation inventory.

Participant profile uploads are limited to headshots. Slides, posters,
handouts, supporting documents and session videos use assigned `file_upload`
tasks and private `task_evidence`. Every file task explicitly declares either a
speaker-scoped participant document or a session-scoped deliverable. Newly
authored file tasks also declare one accepted file kind: presentation slides,
video or supporting document. Upload authorization rejects a missing or
mismatched scope; the authoring and API boundaries reject a missing file kind.
PDF/PPT/PPTX presentations, MP4/WebM videos and supporting documents each use
their matching event policy through browser declaration, multipart resume and
completion. Historical assigned-task snapshots created before this field was
deployed retain their stored broad evidence contract rather than being silently
rewritten. Files derives the session only through the exact task relationship.
A linked session speaker sees only versions already attached as task evidence;
an uploader's incomplete or unattached allocation remains private. Files
downloads task evidence through the exact version-authorized task route. Task
evidence keeps its existing comments, replacement, approval and due-date
workflow and is not participant-erasable from the aggregate Files view.
For every session-targeted task, the current `session_speakers` relationship is
the participant authorization boundary across task reads, comments, completion,
uploads, evidence history and downloads. `owner_person_id` remains accountability
metadata and never preserves participant access after that relationship ends.

Submission confirmations keep configurable message copy but always include the
server-generated, credential-free, submission-ID-based management URL for the
exact submitted application; production requires HTTPS while local development
may use HTTP. That absolute URL is persisted with the original notification
intent before Queue dispatch and is reused in durable delivery source values
and the product-owned management action. Queue materialisation verifies that
the durable URL still names the exact submission route. The stable route
returns non-cacheable denials and resolves the form's current slug internally.
A browser without an applicant session enters the existing verification flow.
When the form is closed or archived, only an exact non-draft submission URL can
load its saved form version; the ordinary public form remains unavailable, the
verified applicant must own the submission, and answers come from the immutable
submitted snapshot in a read-only workspace. A submission ID alone grants no
access. The public form keeps the selected submission visible after submit. A
participant-workspace action is shown only when the same ordinary authenticated
identity has accepted speaker or submitter access to that event;
applicant-cookie access alone does not imply workspace access.
Submission-confirmation templates cannot configure a custom button: the editor
previews the fixed action, authoring rejects custom button fields, and automatic
delivery fails on legacy published content that still contains them.

Participant task APIs return the validated immutable configuration they write.
Exact-definition duplicate detection reads task-instance snapshots and includes
active direct/API-created tasks rather than depending on a template join.
Historical participant-entered link evidence remains visible to administrators
as labelled, non-clickable legacy text; it is never accepted by the current
participant completion contract or treated as the organiser destination.

The Worker applies `Cache-Control: private, no-store` to the complete `/apply`
document, React Router data and nested-action path family. Public application
landing pages intentionally receive the same conservative policy as
applicant-cookie, verification and capability-bound responses: keeping one
fail-closed route-family rule is more important than caching the anonymous
landing page, and prevents later route evolution from exposing private draft or
claim state through browser or intermediary caches.

## Architecture and cross-domain decisions

This table records the choice and points to its owning contract. Domain sections
below take precedence over historical implementation detail; verification belongs
in the implementation audit.

| Decision | Outcome |
| --- | --- |
| Product name | Program Cue |
| Product shape | One pre-release TypeScript modular monolith; no backward-compatibility layer without a real external consumer or deployed migration history |
| Frontend/runtime | React Router framework mode with SSR, loaders/actions, resource routes and path navigation on one Cloudflare Worker |
| Private workspace caching | The Worker enforces `private, no-store` across private administration/review/contextual-AI responses, independent of nested headers. Contextual AI is POST-only; document GET receives the ordinary 405 boundary. The `/apply` family uses the same conservative policy. |
| Vertical-slice pattern | Route → server authorisation/validation → application service → D1/R2/Queue/provider |
| Large-module boundaries | Keep stable service/repository/Queue facades at route and Worker boundaries; split implementations by current domain workflow, keep loader/action orchestration in route modules, and keep page-local state in one route-level container while extracting focused visual panels |
| Visual direction | Retain the Program Cue design language, but prefer a clearer and more appealing UX over exact prototype or Sessionboard parity |
| Tenant model | One organisation with multiple events; private operational records and provider work are event-scoped |
| Public application presentation | Immutable form versions own invitation copy, organiser context, optional deployment artwork/HTTPS website, completion estimate and published-speaker showcase. Empty copy invents no claims; programme navigation is independent of the showcase. Optional verified-applicant Sessionize import accepts only an exact public profile URL, applies production abuse limits, rejects redirects and imports name/biography into an unsaved draft for review; it is neither login nor private-data migration. |
| Public application abuse UX | Turnstile remains mandatory and server-validated for protected public application actions, but its application-page widgets use interaction-only appearance so ordinary visitors do not see permanent provider fields. Each protected application submit control remains disabled with an explicit checking or failure label until its own action-bound token is ready; provider script and challenge failures stay visible and retryable. The hero call to action describes navigation to the application panel, while only the form submit control claims to start an application. |
| Event creation | D1 is recommended; D1 or Airtable authority must be explicitly chosen. Actor-bound durable intents replay exact results and reject changed input. Airtable events remain inaccessible while provisioning or failed and activate only after exact reconciliation. Ordinary provider failures may be retried with re-entered credentials. An expired provisioning lease cannot cancel an external request and therefore permits only explicit keep-on-D1 or discard recovery, never another provider attempt. Discard retains an audited tombstone, clears credentials and releases the slug without claiming provider deletion. |
| Event Setup editing | Dirty state compares the current named form values with the exact loaded baseline and separately compares programme structure plus unfinished record drafts. Reverting every value clears the state. Repository configuration and authority migration may begin only from a clean Event Setup form because their same-route fetcher revalidation bypasses pathname navigation blocking; ordinary navigation, including retention administration, keeps the explicit leave-and-discard confirmation. |
| Current event context | An HttpOnly SameSite cookie identifies a server-authorised event (`Secure __Host-` in production; a separate local HTTP cookie). A default or sole authorised event may establish initial context; otherwise switching is explicit and audited. Unsafe requests with missing, invalid or unauthorised selection fail. Only organisation-wide owner/admin memberships span events. |
| Roles | Owner, administrator, committee chair, evaluator, submitter and speaker; the server, not hidden UI, is the permission boundary. Owners may grant/revoke administrator membership at current-event or organisation scope. Event administrators may invite only current-event administrators; organisation-wide grants and every administrator revocation remain owner-only. |
| Invitation acceptance | A pending event or organisation invitation never grants access during navigation or prefetch. It requires an explicit same-origin event-selector POST, which atomically records acceptance and audit evidence. Every pending invitation has a finite expiry; missing, elapsed or revoked invitation state fails closed. |
| Microsoft identity linking | Microsoft participant sign-in does not globally trust the provider's email because its multi-account tokens normally omit `email_verified`. An invited person whose matching Microsoft identity is not yet linked must first consume the existing five-minute Program Cue magic link. Only the subsequent authenticated explicit-link flow may trust Microsoft: the callback must carry unexpired database-backed OAuth state created by the session-protected link endpoint, and the provider email must still exactly match the magic-link-authenticated email. Ordinary social state, caller-selected state, a missing session or a different email cannot link; once linked, the stable provider account ID supports future direct sign-in. |
| Microsoft callback transport | Microsoft participant authorisation uses `response_mode=form_post`. The cross-site callback POST is size- and shape-validated, tied to an unexpired database-backed OAuth state, encrypted with AES-GCM and staged in D1 for at most 90 seconds under a random single-use relay identifier. A 303 then moves the browser to a clean same-site callback URL containing only that opaque identifier; the Worker atomically consumes and decrypts the relay before passing `code`/`state` internally to Better Auth, which remains authoritative for PKCE, state and account-link validation. Direct query-string Microsoft callbacks and malformed, unknown, expired, tampered or replayed relays fail closed. |
| Admin navigation | Stable workspace families and contextual children follow [navigation and list-state rules](#navigation-list-state-and-application-form-versioning); current product naming follows [administrator information architecture](#operational-truth-and-administrator-information-architecture). |
| Participant workspace | One `/participant` shell serves submitters and speakers; Availability requires speaker authority. Owned/claimed applications remain readable from immutable snapshots after form closure. Draft ownership and claims establish submitter entitlement; portal access never substitutes for session consent. Resource audiences distinguish membership, accepted relationships and confirmed relationships. Session deliverables reuse tasks/comments/versioned evidence. See [participant ownership](#participant-invitation-and-profile-ownership) and [role-aware navigation](#role-aware-participant-navigation-and-bounded-review-scoring). |
| Organiser setup guidance | Command Centre presents four lifecycle phases built from six setup conditions derived from authoritative event description, published form, review-plan/round/criterion, active task template, verified sender and published schedule records. The evaluator-only demo uses the same phase language for its walkthrough. Production stores no checklist state and the guide disappears once all six conditions are satisfied; operational readiness remains the ongoing event view. |
| Participant branding | Logo, welcome and support values are event-scoped, cloned and Airtable-projected. External logos send no referrer. Published managed branding follows [the branding contract](#event-branding-publication-decisions). |
| Speaker Network boundary | An organisation-scoped competition extra includes cross-event history, tags/notes, filtered segments, duplicate review, a five-stage sourcing pipeline and event invitation handoff. Organiser enrichment belongs to `organisation_contact_profiles`; canonical identity remains person-owned. Existing global identities are reusable only through a legitimate current-organisation relationship; merges cannot promote organiser data into canonical profiles. Owners/admins enforce authority. Participant adoption is deferred; general CRM, revenue objects and campaign automation remain excluded. |
| Command record search | The permission-aware palette searches speakers, submissions, sessions, tasks, rooms, tracks, resource pages and the unified background-operation record. Domain aliases are parsed server-side and narrow the authorised record query; rooms and tracks open exact focused Event Setup records, while provider-specific communication and integration job kinds remain unified as operations. |
| Resource embed trust | External resources use the [typed provider registry](#external-resource-embeds), replacing the earlier configurable-origin and empty-sandbox policy. |
| Programme embed configuration | Stateless URLs and managed records share a strict presentation allowlist over published data; [managed embeds](#managed-programme-embed-decision) own persisted lifecycle/configuration. Generated cross-origin customer frames retain `allow-scripts allow-same-origin` because an opaque origin breaks framework modules and origin-backed APIs. Trusted same-origin admin previews omit the ineffective sandbox. Only public `/embed/*` responses allow wildcard inbound framing; private responses remain self-only. Resizing uses the exact-origin handshake described in [security boundaries](#privileged-and-provider-credential-security-boundaries). |
| Admin visual shell | Dark navigation with a light work canvas |
| Participant/public density | Comfortable light surfaces with mobile-responsive workflows |
| Speaker workspace navigation | See the unified [participant navigation contract](#role-aware-participant-navigation-and-bounded-review-scoring); the former separate speaker shell is retired. |
| Published speaker projection | Schedule content and current published speaker identity edges come from one transactional read and are checked for exact bidirectional consistency. Fixture portraits obey the [public programme rules](#public-programme-workstream-decisions); they never disguise real upload or scan state. |
| Organiser speaker-file access | Only current released versions are downloadable. The event/speaker resource route independently checks authority, ownership, signature, clean scan and R2 ETag/size; history and quarantine remain unavailable. See [the file-library boundary](#content-management-workstream-decisions). |
| Event speaker workflow | `event_speaker_workflows` is durable roster authority; reads reject missing state rather than deriving it. Manual entry creates a neutral identity, scoped contact/profile and prospect association atomically and sends nothing. Invitation is a separate confirmed action. Migration `0019` moves only untouched records with exact old-command provenance into organisation scope and aborts on incoherent candidates; participant-owned or unprovable history is not rewritten. |
| Operational data grids | Loaders own cross-page filtering, ordering and pagination; TanStack owns loaded-page presentation/selection, not domain state. Submissions pages are capped at 50; virtualization requires measured need. URL validation and list-state semantics are defined [below](#navigation-list-state-and-application-form-versioning). |
| Form runtime | The native schema owns authoring, rendering and validation; RHF/Zod enforce the draft/server contract. dnd-kit supports pointer creation/reordering with explicit keyboard alternatives. No second schema or adapter. Version migration is defined [below](#navigation-list-state-and-application-form-versioning). |
| Stepped applicant forms | Optional `layout=steps` presents existing v2 sections plus the non-colliding Speakers sentinel. Step identity is stable, navigation is not persisted, continue validates the visible section and submit remains server-authoritative. Save retains the visible step; removed sections choose the next visible section, then previous, then Speakers. Reopen starts first; failed submit reveals the first error. Inactive steps unmount; read-only/admin/reviewer summaries remain one page. No per-step routes or drafts. |
| 9 Aug 2026 scope clarification | The Discord Q&A fixes the MVP boundary: basic conditional form logic is sufficient; a proposal chooses one or more event tracks and reviewers cover one or more tracks; review moves from unreviewed to accept/maybe/deny, with in-app decision email, rationale and applicant-facing reviewer feedback available to ask a speaker for changes; acceptance creates the session/speakers/tasks automatically; hotel-stay requirements and flight-reimbursement forms are the minimum onboarding tasks, while description, profile/photo, announcement and colleague-invite tasks are optional; email and calendar delivery must work at MVP depth rather than be stubbed; Accelevents may be skipped; day/room drag-and-drop with conflict detection is enough for scheduling; and one small useful agent is enough because the administration UI is the priority. The repository can exceed these boundaries, but extra integrations or agent depth must not displace the clarified core. |
| Track identity integrity | Form routing persists both track-name-to-ID and ID-to-name snapshots. Applications accept one or more tracks; direct-session forms and administrator-created direct sessions require exactly one programme track. An accepted application requires the decision-maker to confirm one of its submitted track IDs; the interface retains the submitted label for history but previews and snapshots the current programme-track name used by the created session. Event cloning remaps saved form track identities to the cloned event's new track IDs. Missing maps, selections, snapshots or decision sources fail explicitly; no position-based primary-track inference, scalar compatibility route, raw-ID or empty-object fallback is used. |
| Submission routing boundary | Track selections and team joins are authoritative; intake stores their immutable labels and may complete without staffed evaluation rounds. Assignment remains an explicit review action. Detail derives routing explanations from those snapshots, labels manual overrides and fails on automatic-routing drift. No scalar primary-team or automatic intake assignment. |
| Canonical demo event | Future of Events 2027, 20–22 May 2027, Toronto, with applications closing 30 April 2027. The pre-release fixture retains its existing internal ID, while its attendee-facing public slug is `future-of-events-2027`. The former 2025 slug has no compatibility alias because no immutable external consumer requires one; demo powers require the explicit demo Worker configuration. |
| Demo identity and evaluator fixtures | One rich seed supports local demo and separately gated production evaluation. Evaluation sessions take precedence over ordinary auth, select only fixed identities and remain fixture/reset-generation scoped. Selection grants no membership; explicit applicant activation grants only the documented submitter entitlement and claims no email verification. Exactly four disclosed aliases route only in that signed fixture context; Marcus has no selectable persona. The sole Turnstile exception is first anonymous itinerary creation on the canonical evaluation event, still IP-limited. Exact identities, templates and setup belong in [the evaluation runbook](SBEK_EVALUATION.md). |
| Repository authority | D1 is always the transactional control plane; event domain authority is explicitly D1 or Airtable. Managed schema, reversible permission proof and durable command/result intents gate Airtable operations. Missing credentials, schema/projection drift and failed recovery stop work without a D1 fallback. Published provider tables remain immutable; authority must return to D1 before disconnect. Synchronous migration is capped at 250 changed managed records; larger events stay on D1. |
| Evaluation persona state | The fixture is shared; coordinated runs must not overlap. “Clean” requires an exact empty D1 baseline. The fixed Sam journey and ordinary controlled-mailbox invitation journey are distinct; arbitrary addresses never map to Sam. Reset only after checking no evaluator is active. Procedures and current personas live in [the evaluation runbook](SBEK_EVALUATION.md). |
| Baseline migrations | Until a migration is deployed/shared as immutable, update the pre-release baseline directly; afterward add numbered migrations |
| Session participation migration | The deployed migration history makes the original session-speaker schema immutable. Migration `0008_session_speaker_participation.sql` established the strict pending/confirmed baseline and backfilled legacy relationships as pending. Migration `0050_session_participation_decisions.sql` extends that schema with declined participation, an invitation-cycle revision and bounded decision metadata while preserving the featured-speaker integrity triggers. Portal acceptance is not treated as evidence of session-specific consent. |
| Reference production slice | Event Setup established server authorisation, event scope, Zod validation, optimistic revisions and append-only audit evidence used by later slices |
| Time semantics | Store instants as UTC epoch values, but interpret event boundaries, date-only form/task deadlines and schedule slots in the event timezone; attendee-facing schedule times render in that timezone |
| Person model | Canonical person identity with submission, session, membership and speaker associations |
| Organiser profile edits | Canonical identity remains person-owned. Exclusive-event corrections may update it; shared identities use organisation contact enrichment plus exact event-private logistics without rewriting the canonical person. See [participant ownership](#participant-invitation-and-profile-ownership); a combined edit must satisfy the applicable ownership boundary atomically. |
| Publication snapshots | Public behavior comes from immutable form, resource, schedule-session/content/notes and communication versions, including identity/settings/audience/attachment metadata; mutable drafts do not alter the live version before a claimed publication boundary |
| Draft programme review snapshots | Confidential disclosure, separate from published programme requirements: hashed token, frozen D1 projection, notice-only GET and same-origin POST reveal. Creation binds the reviewed projection hash and draft revision; the blob is frozen, not live-joined or re-fingerprinted in the write. Only scheduled public entries and eligible public speaker names are disclosed; private details/IDs/declines are excluded. Tokens are shown once, never recovered on retry or cloned, capped at ten active links and expire after 1/3/7/30 days (default 7). Successful publication revokes them; retention deletes them. All public invalid states share 404. Detailed evidence is indexed under [capability status](IMPLEMENTATION_STATUS.md#capability-status). |
| Form publishing | Published form versions are immutable; later edits create a new draft, live public settings change only when it publishes, and existing applications retain their original schema snapshot |
| Public draft intent | A public application create/start intent derives one opaque, form- and actor-bound draft identity. Exact D1 retries recover only that matching draft; anonymous retries issue a fresh hashed bearer token and never persist or replay cookie plaintext. Reusing an intent across another form, version, event or owner fails rather than creating or claiming a different draft. |
| Resource publishing | Resource title/slug/category, audience, acknowledgement policy and attachments belong to a version; acknowledgement records identify the exact version read |
| Evaluation | Weighted criteria and explicit conflict declaration; owners/administrators hold decision authority, committee chairs require an explicit plan grant, and accepted released decisions create a session atomically and are final |
| Evaluation round depth | Each round owns open/close UTC timestamps, a scorecard id/version, blind-review setting and compare-and-set revision. `evaluation_round_reviewers` is the authoritative round pool, while dropdown criteria persist an ordered validated JSON option list. Reviewer identity suppression is a server projection selected only after event/organisation, active membership, pool and assignment checks. |
| Schedule conflicts | Event-boundary, room and speaker conflicts block publication by default; track and capacity handling follow the stored policy and are revalidated at publication |
| Speaker availability | Blackouts are an explicit product expansion: D1 event/person-owned intervals, private 500-character notes and a 50-window cap. Pending/confirmed participants or accepted speaker members may create/delete; organisers may inspect intervals and confirm deletion, not author on behalf of speakers. Notes never enter conflicts, logs, AI, Airtable or public/API projections. Policy defaults to blocking; all consumers require loaded windows. Mutations CAS the event, atomically rebuild active-draft conflicts and persist the change cursor; scheduled co-speaker claims share that boundary. Reject ambiguous/nonexistent local times. Clone copies policy, not windows; retention clears both windows and derived conflicts. No v1 REST surface. |
| Deterministic auto-placement | First-fit over the active draft only, with stable session/room order and event-local half-hour slots. No LLM, optimiser, existing-entry movement or publication. Preview/confirmation revalidate authoritative rules and revisions, then commit one atomic statement-budgeted batch. Subset and readiness semantics are defined [above](#selective-deterministic-scheduling). |
| Schedule interaction | FullCalendar supplies list, time-grid day and time-grid week presentation plus pointer move/resize. Keyboard and form alternatives remain first-class, and every place, move, resize, unassign and short-lived undo is submitted to the same server schedule service for authorisation, version checks and conflict revalidation. |
| Public identity | Event slugs are globally unique; canonical programme, embed, API, feed and calendar-session links are event-slug-addressed |
| Personal itinerary calendar export | The programme UI exports the complete server-side itinerary selected by the current signed-in identity or anonymous itinerary cookie; read-only shared pages export by their existing share token. It does not serialize or truncate saved session IDs in the browser. The bounded explicit-session calendar selector remains an API facility, while identity/share exports are private and non-cacheable. |
| Published programme | Anonymous public UI/API/feed reads published data only. Itineraries use independent `ANONYMOUS_ITINERARY_SECRET` authority; missing, weak or auth-secret-reused values fail. Introduction of v2 removes only legacy unversioned anonymous rows and preserves signed-in/new-key data. Pre-release rotation intentionally invalidates anonymous itineraries; follow [the rotation runbook](DEPLOYMENT.md#credentials-and-rotation). |
| Schedule content versions | Draft snapshots own content, visibility and notes; publication copies snapshot visibility to live sessions and all consumers read that published version. D1 forbids published approval/visibility/deletion changes while allowing the documented descriptive redaction/backfill path. Full approval, restoration and publication rules are owned by [content management](#content-management-workstream-decisions). |
| File lifecycle | Private R2 objects use opaque keys and remain quarantined until a trusted clean result releases a version; headless Uppy core/AWS S3 uses signed direct R2 multipart transfer for every valid file size, D1 plus R2 ListParts are authoritative for resume, and no browser hint, missing scanner or proxy-storage fallback may be treated as success |
| File generation after erasure | A retained `file.erasure.requested` audit tombstone permanently consumes its deterministic logical asset ID even when retention or evaluation reset removes the corresponding `file_assets` row. A later upload allocates the next numbered generation by inspecting both live asset IDs and the authoritative retained `file-erasure:<assetId>` audit IDs within the same organisation and event; it never resurrects an erased identity. |
| Upload conflict cleanup | Commit exact D1 discard/tombstone plus ingress-labelled audit before retryable R2 deletion. Incomplete postconditions roll back the batch; ineligible cleanup records nothing. Storage failure reports the committed discard and stable retry identity, never success. Organiser and participant cleanup retain `admin_ui` and `participant_ui` respectively. |
| Production malware scanner | An authenticated companion Worker, idempotent Workflow and four EU-pinned ClamAV slots separate scanning from application requests. Attempts retain slot affinity; explicit retries advance slots without fan-out. Busy slots wait, cold starts have a separate bounded budget, and invalid jobs/objects fail immediately. Callbacks must match the current attempt; stale or ambiguous results cannot release quarantine. Signature refresh precedes readiness, and signed object authority is limited to the private production bucket. Container shutdown and credential setup are specified in [deployment](DEPLOYMENT.md#scanner-release); signed-envelope invariants are retained under [hardening](#pre-release-hardening-decisions). |
| Event file policy | Every event requires a strict policy; administrators may lower but never exceed canonical limits. Each upload boundary rechecks the current policy. New file tasks explicitly select scope/kind; historical task snapshots keep their persisted contract. Missing policy never falls back to global defaults. |
| Accelevents reconciliation | A terminal Accelevents run's downloadable CSV is rendered only from its tenant-scoped stored run, operation and per-run item/diff snapshot. It includes the prior/resulting external IDs, exact mapped payload/diff, statuses and errors, applies spreadsheet-injection protection, and never reconstructs historical results from current programme records or later provider mappings. |
| Accelevents export safety | A live export requires the exact fingerprint returned by its approved preview/dry run. The durable request binds that fingerprint, mode and connection, and Queue work also snapshots the connection revision; preview drift, idempotency-key reuse with changed input or a provider/account reconfiguration fails before another external write. |
| Task completion undo | A direct participant/admin completion may be undone for five minutes only with a server-issued single-use token and an atomic revision/evidence/dependency comparison; submitted, approved, waived, externally effective or subsequently changed work is not presented as reversible. The ordinary inline form/status remains the durable and no-JavaScript interface; Sonner adds a supplemental progress/status notification whose action and lifetime are bounded by the same authoritative token expiry, never toast-only validation. |
| Acceptance task plans | Each task template explicitly declares whether acceptance auto-assigns it; there is no storage default. Accepted decisions atomically materialise active roots plus prerequisites in the same D1 transaction as the session and speaker relationships. Speaker, session and event scopes map to their real target IDs, dependency edges stay within one scope, existing template/target instances are reused without overwrite, and session-start anchors fail validation because a newly accepted session is intentionally unscheduled. |
| Task assignment atomicity | One target assignment binds the exact roster revision/status, complete task-template material/dependency snapshot and prior assignment state, then persists every missing prerequisite/root task, dependency edge, assignment audit, endpoint webhook delivery and operation job in one D1 batch. A failed guard rolls back the whole target graph, while an exact retry reuses its audit, webhook delivery and operation. Bulk confirmation claims its stored preview only while the exact roster, template, dependency-edge and assignment snapshots still match, and carries that snapshot into every target batch. Each target is atomic; the multi-target operation intentionally is not and may honestly finish `partially_failed`. |
| Communication safety | A revisioned D1 draft becomes scheduled/queued only through fingerprint-bound preview/confirmation; edits invalidate previews, not durable intent. Versioned content, source/recipient and verified-sender snapshots survive retries. Sender reuse from another active same-organisation event is explicit and transactionally revalidated, without copying templates or outcomes. Missing task due dates and unresolved delivery placeholders fail. Detailed claim, cancellation and receipt rules belong to [communication operations](#communication-operations-decisions). |
| Outbound webhook intent | Domain mutation, endpoint delivery, operation/item and audit/change evidence commit in one guarded D1 batch. Dispatch follows commit; `dispatched_at` and the scheduler recover undispatched work. Missing Queue blocks mutation when an endpoint matches; post-commit dispatch rejection becomes explicit `queue_failed` work. |
| Email provider selection | `EMAIL_PROVIDER` is explicit. Production accepts only Resend and requires its API key; the local demo, development and test runtimes may select Mailpit's HTTP Send API with complete endpoint/auth configuration. Auth, participant verification, transactional communication and email-ICS share the same send contract, preserve idempotency/attachments and record the provider's real message identifier. There is no provider fallback or SMTP compatibility path. |
| Calendar baseline | Stable iCalendar UIDs and sequence-aware REQUEST/CANCEL operations; one current attempt serializes rapid lifecycle changes and stale completions are superseded. An active invitation stays bound to its provider and account until cancellation completes; it is never silently reused after a provider/account switch. Email-ICS, Google and Microsoft provider boundaries are explicit. Google/Microsoft connections use an authorised OAuth start/callback, encrypted refresh tokens and compare-and-set refresh/failure updates; missing applications or provider failures are reported, never simulated. |
| Microsoft calendar account identity | Microsoft Graph's `mail` value is the preferred calendar-account email. `userPrincipalName` is used only when it is itself a valid email because guest principals commonly use a non-email `#EXT#` identifier even when `mail` is valid. The stable Graph account ID remains the connection reference. If neither value is a usable email, the provider callback fails explicitly and records only bounded provider diagnostics. |
| Calendar OAuth diagnostics | Log only bounded provider and execution-phase classifications, never payloads, codes, state, addresses or raw errors. Malformed profiles are provider failures. Wrap injected/global fetch before storage to preserve receiver-free invocation across OAuth, refresh and lifecycle calls. |
| Dashboard freshness | D1 `event_changes` is authoritative; an event-scoped Durable Object broadcasts post-commit WebSocket invalidations and clients retain a bounded polling fallback of at most 30 seconds |
| API authentication | Event-scoped, scope-limited API keys are stored only as hashes, revealed once, expirable and revocable |
| API contract | Strict versioned REST uses bounded Zod input, RFC 3339 timestamps, cursor pagination and structured errors/correlation IDs, including pre-router maintenance failures. Generated component schemas and explicit operations keep YAML/JSON synchronized. Commands require service-owned actor/idempotency contracts and recover durable side effects; API keys cannot impersonate humans. Webhook-secret session commands share the fifteen-minute recent-auth boundary. |
| AI/agent actions | The event Agent reads authorised evidence; readiness values/links remain deterministic, with schema-bound model summaries and exact blocker keys. Mutations require allowlisted durable proposals, explicit preview/approval and normal domain services under a renewable audited claim. Owner-selected providers fail when unavailable, without fallback. Workers AI supports only DeepSeek V4 Flash 0731; migration `0023` replaces GPT-OSS selections. Structured JSON uses explicit non-thinking mode; open-ended/tool requests retain medium reasoning. |
| Assistant streaming and tool batches | Authenticated SSE must satisfy the browser contract; native document actions return complete non-streaming results. Multi-call batches execute sequentially only when all tools are allowlisted reads under the total budget. Built-in suggestions enforce their exact required call sequence and arguments. Reminder audience/delivery checks run before inference and proposal persistence. Terminal operation/proposal/audit effects commit atomically. Expected stale/pre-provider rejection is cancelled; provider/invariant failure is failed. Expired claims become audited interrupted failures, never automatic model retries. |
| Agents SDK dependency | Pin the Cloudflare Agents SDK and its required AI/MCP peers to verified versions. Its decorators plugin uses Babel 8, so Program Cue declares Babel 8 at the application peer boundary while React Router retains its nested Babel 7 toolchain; `npm ls`, the Agent Durable Object test and both builds must prove that split remains valid. Node 24.11 or newer is the single supported runtime floor, satisfying both this production dependency graph and React Router's current Node contract without retaining an obsolete Node 22 CI path. |
| Failure behaviour | Missing auth, bindings, provider configuration and blocking invariants fail explicitly; no hidden storage, credential, stale-data or provider fallback |
| Runtime modes | Only the checked production, demo, development and test mode pairs are accepted; contradictory or unknown `APP_ENV`/`DEMO_MODE` values fail before routing or Queue consumption, and unknown environments retain production-grade redaction and transport security |
| Production hostname and edge storage | The application uses `app.programcue.com`; apex/www belong to the static website. Application CORS is same-origin. Application files and D1 backups remain private; only the files bucket permits same-origin multipart PUT and exposes ETag. The separate public marketing-media bucket follows [the film contract](#launch-film-evidence-and-delivery-contract). |
| Production compute and data locality | US West audience drives WNAM D1 and Smart Placement. D1 remains the single authority; no replication, dual writes or regional forks. Maintenance must quiesce HTTP, Queue and scheduled work during a move. Operational commands target WNAM; former EEUR retention was a temporary rollback decision, not an assertion that the old database still exists. |
| Public website | A separate static Worker keeps public home, privacy, terms and guide independent of application auth/readiness. HTTP/www canonicalise to secure apex in one hop. The site validator enforces crawlability, content, Google disclosure, contact and link requirements. Public copy names Program Cue and Victoria, Australia. See [end-user documentation](#end-user-product-documentation) and [site deployment](DEPLOYMENT.md#public-website-release). |
| Public website positioning | Lead with the connected programme outcome and a truthful sign-in/account-creation action. Illustrative readiness imagery is labelled; it is not customer evidence. Signup grants no event access. Detailed Google disclosure stays crawlable on the homepage. |
| Event-site rich-text authoring | Fixed pages, FAQ answers and post-event introduction use constrained Tiptap serialized to restricted Markdown: subheadings, lists, bold and credential-free HTTPS links only. Existing validation/publication/rendering remain authoritative. Other domain text fields do not inherit rich text incidentally. |
| Production readiness | HTTP, Queue and scheduled work fail before execution on invalid required bindings/secrets; health additionally probes D1. This proves configuration, not live provider acceptance. Bootstrap requires an empty migrated database and explicit event identity; it creates no permanent endpoint. Follow [deployment](DEPLOYMENT.md). |
| Release identity and telemetry | Production entry points require a hexadecimal source revision. Correlation uses validated Ray ID, caller UUID or generated UUID. Logs contain bounded operational identifiers/classes, never raw paths, payloads, prompts, secrets, personal data or exceptions. Full invocation logs and 10% traces are configured. Application CSP permits Cloudflare Web Analytics and same-origin RUM; the static site remains script-free. Actual telemetry acceptance is recorded only in [the audit](IMPLEMENTATION_STATUS.md#deployment-evidence). |
| Evaluator reset | Reset is confined to the dedicated fixture organisation, preserves audit/global-auth history and never derives deletion authority from creation time. An atomic renewable owner-token lease fences cleanup and concurrent assistant work. Known received previews are cancelled before cleanup; unknown, queued, running or externally active work blocks. Prior assistant proposals are audited as superseded. Pre-destructive expiry may restore only a proven prior generation; post-destructive failure stays unavailable until recovery. Completion and new session generation commit together. Exact active-work, identity and retention checks remain fail-closed. Provisioning and routine/operator reset procedures belong in [the evaluation runbook](SBEK_EVALUATION.md). |
| Performance evidence | Hardware-sensitive budgets stay in an opt-in isolated lab harness, never demo data or the correctness gate. [The performance runbook](PERFORMANCE.md) owns the method; [the audit](IMPLEMENTATION_STATUS.md#performance-measurements) owns dated results and remaining deployed acceptance. |
| D1 backup and recovery | Time Travel supplies point-in-time recovery; a date-idempotent Workflow streams exact-length SQL to private R2 with an immutable checksum manifest. No buffered/teed duplicate stream. Invalid length, authority or provider result fails. Polling repeats the required format; completed signed URLs are consumed directly. Recovery compares streams sequentially and cancels unopened bodies after failure. Procedures live in [recovery](RECOVERY.md); [acceptance evidence](IMPLEMENTATION_STATUS.md#backup-and-restore-acceptance) is separate. |
| Test coverage economy | Prove each observable rule at its lowest sufficient layer; browser tests cover integration, accessibility and visual risk. Retain representative states and Firefox/WebKit smoke coverage without duplicating provider contracts, markup assertions or identical Chromium journeys. Route reachability must exercise routing. Negative-path tests justify distinct authority, atomicity, provider, race, durability or public-contract boundaries. |
| Validation execution | [AGENTS.md](../AGENTS.md#validation) defines required scope. Generated types precede concurrent core lanes; sharded browsers share one build but isolate ports, results and D1. Required hosted PR browsing uses one Worker/Chromium stack after repeated two-stack stalls; failure artifacts retain results/logs for seven days. Local success tracing is off; CI/diagnostics retain failure traces. Focused/quick iteration gates never replace the complete release gate. |
| Browser mutation origin | Cookie-authenticated non-API mutations require an exact same-origin `Origin` header at the Worker boundary; API keys, signed webhooks and Better Auth keep their dedicated request protections |
| Participant retention | Owner preview and typed confirmation gate bounded idempotent pseudonymisation after the retention boundary. Legal holds, published forms, unerased files, active provider work and unreconciled calendars block. Shared global identities survive; exclusive credentials are revoked. Completion and audit commit atomically, retries revalidate, and ingress guards block new participant PII without freezing operational recovery. Historical programme/audit facts and external/global records are explicitly retained or reported, never silently rewritten. |
| Excluded product scope | General CRM, general marketing automation, payments, multilingual expansion and a general-purpose CMS |

Approved assistant proposals retain mutation authority only while their exact
execution claim remains live. The claim is renewed and revalidated immediately
before each domain or communication mutation and is required again when the
execution result and audit settle atomically. A local demo reset supersedes
every still-pending proposal before replacing event data, regardless of the AI
provider that created it. Pre-release null-token operation rows are reconciled
by the scheduler after the same five-minute lease horizon, with an explicit
interrupted failure and matching audit evidence. Reset ignores only a
well-formed, explicitly expired lease; missing claim fields remain blocking
until that reconciliation succeeds.

Workspace navigation uses immediate document scrolling by default. Smooth
scrolling is opt-in only for a bounded interaction that explicitly benefits
from animation; it is not applied to `html`, where browser focus and action
scrolling can delay below-fold controls. Consequential forms also preserve
their submitted scroll position when the route action does not require a new
location.

The persistent admin shell reads a purpose-built event summary, event choices,
capabilities and notification counts. It does not load the complete editable
Event Setup aggregate merely to render navigation. Normal mutation
revalidation remains authoritative for shell counts and context rather than
introducing a stale client-side shell cache.

The local scale harness applies invariant-valid fixture data before starting a
dedicated measurement Worker. Application pagination selects the authorised,
filtered page IDs before computing per-row routing and speaker projections, and
track-name filtering uses the persisted-selection index added by migration
`0048`. The ordinary and scale profiles use separate D1 states.

The complete release gate and a dedicated required CI job audit the complete
locked dependency graph for high/critical advisories. They fail closed when the
advisory service is unavailable; the local core gate remains deterministic and
network-independent. Pull requests additionally use GitHub's dependency diff
at an immutable action revision, and weekly npm/GitHub Actions update proposals
keep dependency changes explicit rather than silently changing installed code.

Negative-path coverage follows the same economy rule. Retain a rejection test
when it proves an authorization or tenant boundary, atomicity or absence of
side effects, provider honesty, idempotency or race handling, durable-data
integrity, or an observable HTTP/UI contract. Do not keep multiple malformed
inputs that exercise the same validation condition and outcome merely to
restate that it throws, and do not assert exact internal error wording unless
that wording is itself a public contract. Prefer one representative input per
distinct validation condition or integration boundary, and test the resulting
state or suppressed external call when those effects matter.

After initial operator provisioning, an access-code-unlocked evaluator may
explicitly reset the shared fixture from `/evaluate` before a separate human or
automated run. The typed destructive action is IP-rate-limited and reuses the
same owner-token lease, tenant-isolation, active-work, retention and R2 cleanup
boundaries as the operator reset. Its lock claim also requires the exact fixture
generation already validated from the initiating session, so a reset completed
in that boundary cannot let a revoked cookie roll itself forward. It reads only the exact safe evaluator
addresses and verified sender already persisted in D1; the reset-only address
values and temporary full-access Resend key remain deleted. Missing or drifted
provisioning fails before the reset claim and requires the operator path.
Completion audits the evaluator authority, invalidates every older evaluator
session and gives only the initiating browser a fresh gate-only session with no
selected persona.

The evaluation gate requires a canonical 32-character lowercase hexadecimal
bearer code generated from 16 random bytes and verifies it before touching
rate-limit storage. A valid code can therefore create its signed gate session
when that unrelated write boundary is unavailable or its IP bucket is exhausted.
Every invalid guess is still charged to the IP-scoped D1 abuse limit, and an
invalid request fails closed if that attempt cannot be recorded. The D1 limit
controls invalid-request abuse; the enforced 128-bit bearer secret, rather than
the mutable attempt bucket, is the credential-guessing boundary.

The authenticated destructive evaluation reset allows ten attempts per IP in a
one-hour window. Exact event-name confirmation, reset ownership and active-work
checks remain authoritative independently of this abuse limit.

Production calendar email delivery rejects invalid, reserved and local-only
recipient domains before durable work is created and rechecks the immutable
recipient at the Queue provider boundary. The production evaluation reset gives
the populated Alex Morgan and Priya Shah showcase identities separate
operator-controlled routeable addresses so publishing their seeded schedule can
exercise real email-ICS delivery. These addresses are not SBEK aliases and are
never mapped to the clean scenario identities.

The signed, activated evaluation applicant may perform an accepted-submission
co-speaker invitation while its fixture mailbox deliberately remains
unverified. The ordinary participant path still requires a verified email.

When a canonical speaker identity is shared, organiser-authored display name,
biography, title and organisation belong to the current organisation contact
profile, while private logistics belong to the exact event profile. Speaker
detail overlays those scoped values without rewriting the canonical person;
both scoped rows, the audit and webhook intent commit in one compare-and-set D1
batch.

## Cross-surface micro-UX decisions

Derived values remain suggestions, not hidden authority. New event, form,
resource and managed-embed slugs follow the source name only until the operator
edits the slug; an explicit “Use suggested” action restores derivation. Existing
identifiers are never silently rewritten, and event availability feedback is
advisory while the server mutation remains the uniqueness authority. Date
ranges preserve their duration when a start moves, but invalid ranges still
fail both client and server validation.

Standalone public-programme filters, selected public session detail and
schedule-source search live in the URL so reload, history and shared links
preserve context. Public session and speaker detail parameters are server-owned:
every transition re-runs strict published-record validation rather than letting
the client substitute a previous or first visible record. Schedule filter,
session and conflict focus also remain server-owned and revalidate. Unavailable
public facets are removed from old links and disclosed
instead of remaining visible while being ignored. Embed configuration remains
owned by its explicit embed query contract. Person-first
lookup is an authorised, organisation-scoped read over established membership,
submission and session relationships; it may fill a manual form but never
links an unrelated global identity or bypasses the mutation's existing server
checks.
Lookup results expose the exact current-event speaker workflow state. Roster
entry blocks active prospects/invitees/confirmed speakers while permitting an
explicit declined or withdrawn restoration; submission editing may reuse an
existing event speaker.

Communication footer defaults come only from an owner-managed organisation
postal address. The setting is organisation scoped and audited without copying
the address into audit metadata. Its write predicates revalidate active owner
membership and compare a dedicated revision, and an operation-bound completion
guard rolls back a partial update or audit. A new template may copy that value
into its editable versioned content; no venue, product-office or fictitious
fallback is substituted when it is absent. Progressive task and communication
controls omit irrelevant values rather than persisting hidden defaults.

Error summaries focus when a new failed submission is rendered and link to the
corresponding field. Character counts appear near bounded limits instead of
adding permanent visual noise. Participant and organiser profile editors warn
before discarding unsaved changes, while the server revision remains the
durable source of truth.

Task-template drafts cross a typed normalisation boundary at the loader/action
form edge: absent text, date and offset values become controlled empty strings,
while invalid submissions retain the typed draft for redisplay. Optional HTTPS
URLs accept blank values but use one exact validation copy for malformed input
and return focus to the invalid control. Event-selection links from reviewer,
speaker and administrator shells use a full document navigation so the first
route after an invitation acceptance reads the authoritative event context.

## TypeScript validation decision

The Node/tooling and Cloudflare application graphs are independent no-emit
checks. They run directly with `tsc -p` rather than as composite project
references. Composite mode implicitly computes declaration signatures even
when `noEmit` is set; after workflow modules were split into focused exported
classes, that unused declaration graph exhausted more than 16 GB while the
identical ordinary check completed below 2 GB. No package consumes generated
TypeScript declarations, so declaration-producing composite validation adds
cost without enforcing an additional contract.

## Managed programme embed decision

This supersedes only the earlier decision that embed configuration must remain
stateless. Stateless URLs and snippets remain supported. An organiser may also
save a named current configuration at an immutable event-scoped slug with a
compare-and-set revision, optional operator-entered installation note and
creator/updater timestamps. The lifecycle is `draft → active ↔ paused →
revoked`; revocation is terminal and retains the row so its slug cannot be
reused.

Draft and missing public URLs are indistinguishable 404s. Paused URLs return a
branded non-cacheable 503 with `Retry-After`; revoked URLs return a
non-cacheable 410. Active URLs read only the current published snapshot and
include the managed revision in their representation ETag. Managed URLs reject
query-string configuration, and missing or corrupt persisted configuration
fails explicitly instead of falling back to stateless defaults. Configuration
updates and lifecycle transitions require explicit preview/confirmation and
write ordinary before/after audit evidence. Automatic installation discovery,
analytics, arbitrary CSS, a generic diff framework and a separate cache
invalidation subsystem remain excluded.

## Evaluation regression decisions

- **Reviewer autosave authority:** The client sends only the latest revision
  acknowledged by the current assignment's save request. React Router's
  retained fetcher response is not a CAS token; an older response cannot clear
  newer edits or advance the revision. The server remains the serialising and
  compare-and-set authority.
- **Per-round reviewer recommendation vocabulary:** Each evaluation round owns
  an ordered list of two to seven choices with stable IDs and editable labels.
  The list becomes immutable when the round receives its first assignment, and
  reviews plus every review revision retain the exact ordered choice snapshot.
  Result views, API reads, Airtable projection and CSV exports resolve labels
  and ordering from that configuration rather than a platform enum. Reviewer
  recommendations remain advisory: moderation and final applicant decisions
  keep their separate fixed consequential statuses, with no automatic mapping,
  weights, colours, branching or policy automation.

- **Form configuration authority:** protected Track and Format questions are
  complete ordered projections of Event Setup, not independently editable
  option lists. Opening a stale builder draft synchronises them for explicit
  review and save. Publication compare-and-set checks the exact ordered track
  identity/name snapshot plus the exact format configuration again.
- **Unified review results:** one selected-round result view combines reviewed
  proposals and sessions under explicit target-type labels and one aggregate
  score ordering. Assignment and decision queues remain target-specific. The
  existing download is labelled proposal-only until combined export exists.
- **Chair results workbench:** the unified result view is also the chair's
  operational surface; no parallel committee board exists. Coverage,
  decision-ready and moderation presets derive from current assignments,
  submitted reviews, recusals and moderation state. Recommendation splits,
  minimum/maximum score ranges and named flags stay transparent. Assignment
  count is the workload authority: decision-ready requires at least one active
  assignment, every active non-recused assignment complete, no recusal gap and
  no split recommendations. Criterion responses, comments already permitted to
  evaluation managers and proposal decision history expand inline. Results are
  server-paged. A pacing chart waits for honest assignment/review history; bulk
  staged decisions remain excluded pending a separate consequential mutation
  and recovery design.
- **Review coverage filters:** incomplete means a target has at least one
  non-recused, non-cancelled assignment and fewer submitted or locked reviews
  than assignments. A target with no assignment is unassigned, not incomplete;
  the two views remain separate.
- **Committee discussion boundary:** one persisted thread is keyed by event,
  evaluation round, target type and target ID. A reviewer may read or post only
  after their exact assignment and review are submitted and not reopened,
  recused or cancelled. Evaluation managers may read the exact thread; archived
  rounds are read-only. Reads return the newest 50 messages and older history is
  loaded through a bounded `(created_at, id)` keyset cursor bound to that exact
  round, target type and target ID; no route can load the complete thread or
  reuse a cursor across threads. Per-author quotas are excluded until there is
  evidence that a posting limit is needed. Reactions, mentions, editing,
  notifications and realtime chat semantics are deliberately excluded.
- **Task identity and comment replay:** the same target cannot receive a second
  active task through another template when its normalised title, description,
  task/evidence type, evidence configuration, impact and resolved due date all
  match. Differently defined work may deliberately reuse a title. The readable
  preflight, mutation guard and concurrent-write diagnosis use the same exact
  material comparison. Participant comments require a stable browser intent
  bound to exact content, comment, audit and prepared webhook work, so exact
  retries converge and changed content conflicts.
- **Actionable schedule conflicts:** rejected speaker overlaps name the speaker
  and both session titles. A generic conflict count is not an adequate operator
  explanation.
- **Decision format remapping:** every accepted outcome requires and stores an
  explicit current Event Setup session-format key, including saved drafts.
  Submitted labels are context for the organiser, never an implicit
  programme-data fallback. A deployed draft without that evidence is migrated
  to an explicit null and requires the organiser to choose again.
- **Released-outcome correction:** rejected and waitlisted decisions may be
  reopened only through an owner/administrator confirmation with a durable
  reason and audit evidence. A pending notification is cancelled with its
  communication, delivery and operation-item graph; an already-completed
  delivery is retained and reported as already delivered. The sent message
  cannot be recalled.
  Accepted decisions are not generically reopened because they already create
  linked session, speaker, invitation and onboarding records; correction must
  start from those explicit records rather than deleting them implicitly.
- **Released-decision communication intent:** release atomically links the
  decision to one notification operation, communication and recipient delivery.
  Those records pin the exact published template version, sender profile,
  recipient identity/address/name, merge values, structured content, rendered
  subject and rendered-body hash before Queue dispatch. The worker sends only
  that persisted communication and never reselects a newer template, sender or
  recipient. When applicant-facing reviewer feedback is selected, release also
  compares the exact ordered assignment/review identities, review revisions,
  statuses and rendered feedback at the write boundary. The final published
  audit is a transaction sentinel that aborts unless the complete linked
  operation, communication, delivery, operation item, prepared audit and change
  record exist. Decision-specific insert guards and the Queue handler reject an
  incomplete pinned contract before provider delivery; generic communication
  compatibility is not used as a decision fallback. Releases created before
  this complete evidence contract remain explicitly unlinked rather than being
  backfilled with partial provenance; a migration-time audit marks that closed
  historical set so a new NULL-linked release cannot claim the exemption.
  Migration `0041` refuses to run while a legacy decision notification is
  actively sending; queued and failed legacy Queue intents are cancelled and
  audited because they cannot be upgraded honestly to the pinned contract. A
  stale Queue delivery for one of those exact
  migration-cancelled operations is acknowledged without sending. The worker
  still rechecks global/provider suppression, unsubscribe state,
  provider readiness and current sender validity at send time. Chair evidence
  follows the retained operation-to-communication-to-delivery relationships
  after participant redaction rather than relying on erased audience/source
  fields. It shows recipient-level state and provider failure without displaying
  the body; `sent` is labelled as provider acceptance, delivery remains a
  distinct provider-confirmed state, and the body-only digest is labelled as
  the rendered template-body SHA-256. The only permitted mutation
  of pinned intent is the existing participant-retention workflow's exact,
  one-way pseudonymisation and redaction contract; it also removes the original
  rendered subject and body hash evidence that must not outlive the event's
  retention period. Outbound reviewer feedback is capped well below D1's 2 MB
  string and row limits; oversized feedback is rejected with a specific request
  to shorten or exclude it, and the durable notification JSON must stay under
  1 MB of UTF-8.
- **Setup-bounded readiness:** operational readiness may expose useful partial
  progress, but the overall percentage cannot exceed the proportion of complete
  setup phases. A new event therefore cannot claim full readiness while most
  setup phases remain incomplete.
- **Per-speaker deadline changes:** a speaker-target task may receive a later
  event-local deadline without changing the template or another speaker's task.
  The task must already have a deadline; creating one remains a distinct
  template operation. The command requires the exact task revision, a reason
  and a future later date, and records audit/webhook evidence.
- **Draft publication feedback:** changing a published CFP closing date changes
  only its editable version until publication. The builder names the currently
  live date and the required save-then-publish sequence instead of implying that
  saving changed the public application.
- **CRM event handoff:** adding an existing Network contact to an event reports
  whether the membership was created or already existed and retains the
  operator's current-event context. The result offers a separate authorised
  event-switch action that opens the exact prospect in the target roster;
  navigation is not a side effect of the mutation.

## Communication operations decisions

A final-decision release requires a syntactically valid and production-
deliverable recipient, configured email provider, verified sender and active
decision template with a valid published email version before any submission or
decision mutation occurs. Reserved and local-only recipient domains fail at
that boundary. The delivery Worker revalidates these mutable dependencies when
it runs. A later configuration change does not pretend that an earlier failed
delivery was queued; failed communication work links to the existing Operations
retry path.

Delivery health is a read model over existing communication and delivery rows,
not a new tracking subsystem. The event summary defaults to the latest 90 days;
event lifetime is an explicit operator-selected view, and one selected
communication is always scoped to that send. Every delivery is counted once
from its current stored state: queued/sending are Pending, provider-accepted
`sent` remains Sent, delivered/opened/clicked roll up under Delivered,
bounced/suppressed/failed are Problems, and cancelled remains separate.
Recipient unsubscribes are shown separately from recorded provider suppressions
and complaints; each list is bounded to its latest 30 active records so the
History route does not grow with the event's lifetime exclusion ledger. Failure
links target the exact owning operation, and task reminder due/overdue behavior
remains the two existing deterministic rules rather than a configurable cadence
builder. Selected-recipient pages retain their 50-row offset contract because a
single communication is already capped at 5,000 recipients; offsets must be
page-aligned and within that communication's recipient count, and a covering
communication/time/ID index bounds the practical scan. The default event
aggregate uses a covering event/creation-time/status index so ordinary page
loads do not scan lifetime history. The explicit lifetime view remains a direct
aggregate rather than introducing a second counter model before it is needed.

## Pre-release hardening decisions

The deployed D1 ledger contains both
`0032_decision_draft_preview_contract.sql` and
`0032_event_brand_asset_normalization.sql` as distinct applied rows. Wrangler
tracks the complete migration filename, so both migration identities remain
immutable. The repository validator permits only that exact historical numeric
collision; every other migration number remains unique and the next migration
after that collision is `0033`. Renaming an applied file or rewriting only the current production
ledger could leave retained rollback data or a restored backup with a divergent
name history and make Wrangler replay destructive schema work.

Reviewer-AI migration `0034` is also immutable now that it is shared on `main`.
Hardening that removes its redundant import link, adds provenance triggers and
adds rolling-usage indexes is therefore migration `0035`. The forward migration
rejects contradictory persisted provenance, preserves valid review and revision
links while replacing the referenced suggestion table, and restores foreign-key
enforcement before completing; it does not rely on an application compatibility
path.

The production release entry point builds and tests once, then validates the
clean checkout, configuration, secrets, D1 integrity, immutable deployed
migration baseline and ordered applied-ledger prefix before any remote
mutation. It applies only migrations after that baseline, requires the resulting
ledger and current schema contract to match exactly, injects the checkout's full
Git revision while deploying that unchanged tested artifact, and checks the
reported live revision. Missing or unexpected migration state stops the
release; the Worker never receives an old-schema compatibility path. A separate
revision-stamp commit is unnecessary.

Pull requests run the cross-cutting core gate and a separate compact browser
gate. The browser lane covers desktop-Chromium golden/provider/reviewer-AI and
accessibility paths plus the public-site suite; the full visual and cross-engine
matrix remains a release gate. Workflow actions are pinned to immutable commit
identities so a mutable major tag cannot change trusted build code.

Each application response receives one cryptographically random script nonce at
the Worker boundary. The same value flows through a dedicated React Router
context into `ServerRouter` and the response CSP, covering framework hydration,
stream and scroll-restoration scripts without an inline-script fallback.
Conditional `304` responses omit a newly generated CSP so the browser retains
the cached representation's matching policy and nonce rather than combining an
old body with new script authority.
Inline script attributes are disabled. `style-src 'unsafe-inline'` remains
temporarily because the application has broad React style-prop usage and the
Scalar API reference and Sonner create runtime style elements. Removing it is a
separate observable styling migration, not a hidden compatibility shim or a
reason to retain unsafe inline script execution. Global Trusted Types
enforcement is also deferred: Scalar/Vue currently creates its rendered API
reference through a named policy and dynamic HTML, so a narrow framework-only
default policy makes the documented public reference fail. The email preview
remains a script-disabled, origin-isolated `srcdoc` iframe. Trusted Types should
be reconsidered only with browser coverage for the API reference, email preview,
Turnstile and client-side navigation; it must not be claimed while those real
surfaces are incompatible.

Applicant and reviewer browser recovery remains an IndexedDB-backed product
requirement so edits survive reloads, crashes and short offline periods.
Snapshots become unusable after one day, not seven, and expired entries are
pruned the next time recovery starts. They remain scope-bound, are cleared after
commit, and sign-out fails closed when cleanup cannot be confirmed. This is the
minimum direct change that reduces shared-browser exposure without removing the
specified recovery behavior; it is not treated as encrypted or
server-authoritative storage.

The ClamAV image may retain root only for its base initializer and update
process. The request-facing Python adapter drops to the image's `clamav` UID and
GID with supplementary groups initialized and `no-new-privileges`; it also
refuses to start as root. Signed scanner callbacks use a 30-second request
timeout and manual redirect handling so a trusted callback-origin redirect
cannot receive a signed verdict.

Pull requests and `main` run a TruffleHog scan over the event-relevant commit
range using a commit-pinned action and fixed CLI release. Verified and unknown
results fail the job. The generic URI detector is the sole exclusion because the
repository's test history deliberately contains fake credential-shaped URLs;
secret-oriented detectors remain enabled. The complete local history is scanned
before release acceptance.

| Decision | Outcome |
| --- | --- |
| Scanner dispatch authority | The application and scanner share a dedicated dispatch HMAC secret that is independent of the callback HMAC secret. The application signs the exact canonical JSON body plus a five-minute timestamp; the scanner verifies the signature, timestamp and envelope expiry before creating a Workflow. The envelope binds organisation, event, asset, version, object key, ETag and size. The scanner's private R2 binding is the only object transport authority, so no presigned-URL-shaped fallback or bearer credential remains. |
| Consequential audit writes | Most mandatory-audit commands write the audit from eligible pre-state first and condition the domain mutation on its exact ID. Branding is the deliberate exception: its mutation is first, while success audit/change rows require the exact post-state and operation ID. A suppressed branding mutation therefore cannot leave success evidence; missing evidence after a committed mutation is reported honestly as a committed warning. Every path asserts the relevant row counts. |
| Evaluation batch completion | Review save, review reopen, decision reopen, moderation and conflict recusal use an in-batch failure guard after their conditional D1 statements. Once any operation-scoped mutation or evidence exists, the guard requires the complete expected current state, immutable revision where applicable and exact ingress-labelled audit event; review save/reopen additionally require AI import provenance and every prepared webhook operation row. Decision reopen requires the `decision.reopened` audit, superseded decision, `decision_ready` submission at the next revision, event-change row, and a terminal notification graph: either the exact closed `decision.notification.legacy_unlinked` audit for a NULL notification operation, or the linked operation is a one-recipient terminal graph: cancelled work has one cancelled communication, one cancelled delivery and one skipped delivery item, while completed work keeps its existing communication, delivery and completed item and does not rewrite later provider failure evidence. Child cancellation requires the parent job to still be cancellable. A NULL link without the 0041 marker fails before supersession. The reopen result is derived from a SELECT in the same batch and reports `cancelled_before_delivery`, `already_provider_accepted` with the actual delivery status, or `legacy_unverified`. Confirmed moderation advances only non-terminal submitted/assigned/in-review work to decision-ready, preserving the documented archived-cycle rule that terminal submissions remain terminal. A missing conditional insert or update therefore fails inside `DB.batch()` and rolls the transaction back; JavaScript row-count checks remain diagnostic conflict reporting, not the rollback mechanism. Webhook preparation applies the same graph check per endpoint so a delivery cannot commit without its operation, item, queued audit and event-change evidence. |
| Evaluation audit ingress | Reviewer-owned save, submit and conflict commands require an explicit `participant_ui` or `api` origin from the calling boundary. Manager-only moderation and reopen require an explicit `admin_ui` or `api` origin. There is no service default inferred from the actor's role. Prepared `webhook.queued` evidence copies actor kind, ingress origin and actor identifiers from its immutable source audit row inside the same batch, avoiding a second provenance declaration. Standalone webhook events without an API-key actor require an explicit ingress origin through a discriminated actor contract and a runtime assertion; omission fails before endpoint discovery instead of defaulting to `admin_ui` or `queue`. Existing append-only rows are retained as written rather than reinterpreted through a compatibility rule. |
| Audit provenance and retention | Audit events record actor kind separately from ingress origin. New rows require metadata contract version 1 and expose only action-allowlisted summaries; known display actions are rejected at insertion when their required version-1 facts are missing or malformed, and readers fail on corrupt known payloads rather than silently hiding them. Preserved pre-contract rows are explicitly version 0, are labelled `historical` and never qualify for a version-1 display summary. Because the product is pre-release, this is a hard cut across every runtime writer rather than dual writes, compatibility aliases or an incremental touched-file migration. New rows cannot use the historical label. Audit evidence has no cascading organisation, event or person foreign key because it must not disappear as a side effect of mutable-record deletion. Normal organisation and event lifecycle is archival, not hard deletion. Participant erasure keeps the existing pseudonymisation boundary, removes event-scoped public-profile revisions that contain PII and prevents recreating them after the completion tombstone; featured-speaker references on a published event site are an explicit preview and claim-boundary blocker rather than being silently withdrawn. It never copies names, email addresses, provider payloads or unrestricted before/after objects into new audit metadata. A future contractual tenant purge must be an explicit privileged retention operation with legal-hold checks and a recorded purge manifest; it may temporarily disable the append-only deletion trigger only for the exact eligible audit IDs. Until that operation and a retention duration are approved, whole-tenant hard deletion is not a supported product action and audit rows are retained. |
| Public collection pagination | D1-backed session, schedule and speaker endpoints use `limit + 1` SQL reads and version-3 keyset cursors. Cursor validity derives from the immutable publication identity plus a persisted public-projection revision and filters; each HTTP validator hashes only its bounded response page. The revision advances transactionally from public-visible event changes: event setup and repository-authority switches insert their change in the domain batch, confirming a public published-programme speaker inserts a `person` change in the same confirmation batch, and headshot revocation commits a durable `file_asset` change before provider erasure. Routes only broadcast a sequence already committed by the domain. A fully completed idempotent erasure or authority-switch retry returns no new notification, rather than looking up and rebroadcasting old work. Page reads therefore do not rescan event history, and an erased public headshot invalidates old cursors immediately. The intentionally complete programme/export path remains separate. Airtable continues to validate its complete immutable provider projection on a cache miss because partial provider reads cannot prove snapshot integrity; subsequent pages reuse the versioned projection cache rather than silently switching to D1 or repeating the provider read. |
| Queue and realtime coordination | A Queue batch runs with bounded concurrency of four while retaining per-message acknowledgement/retry behavior. Event-channel D1 reads and socket sends happen outside global Durable Object blocking; storage transactions perform only cursor compare-and-set work, and overlapping-connect tests prove monotonicity. |
| Operation failure acknowledgement | A terminal operation failure may be acknowledged from the Operation Centre only when that exact record exposes neither a safe generic retry nor a cancel action there. Acknowledgement is organisation/event scoped, actor attributed, timestamped and audited. Timestamp and actor are a database-enforced pair, and inconsistent attribution fails reads instead of displaying an invented actor. It archives the failure from active shell notifications and readiness blockers without changing the failed status, recorded error, result or operation history; the record remains visible in the Operation Centre with its acknowledgement. The acknowledgement transaction also persists an operation invalidation cursor, which is broadcast after commit so concurrent operational views revalidate and D1 polling remains authoritative when live delivery fails. Retryable or cancellable failures cannot be hidden through acknowledgement. Owning workflows may still start replacement work, including resending a co-speaker invitation, without rewriting the archived operation. The complete failed-operation history uses strict, type-filtered 50-row pages with an explicit range and total; invalid and out-of-range pages fail rather than silently clamping or truncating. |

## Event branding publication decisions

Event branding has one event-scoped saved draft and one published projection.
The editable draft uses its own compare-and-set revision. Publication is an
explicit confirmed action that copies the complete saved accent, logo, banner,
welcome message and support-link snapshot to the application, participant
workspace, public programme/embeds and communication email renderer. A partial
per-surface publish is not supported. Program Cue attribution remains visible;
this is event identity, not a white-label entitlement.

Logo and banner bytes live under event-scoped keys in the private `FILES` R2
binding. The bounded organiser upload accepts JPEG, PNG and
WebP only when the declared type, signature and complete decoded structure
agree. Required Cloudflare Images decoding enforces kind-specific width,
height and pixel-count bounds, reduces animation to one frame and re-encodes a
quality-90 WebP before storage. This canonical WebP output discards source
metadata and is decoded again before its dimensions and normalizer version are
recorded. A missing Images binding, decode error, unexpected output type or
post-normalization size violation fails the upload; original bytes are never
stored. Draft previews require event-administrator access.
Anonymous delivery resolves only the asset currently referenced by an active
event's published branding and revalidates the exact R2 ETag and byte size
after the object read. Stable asset URLs require revalidation so a later
publication cannot remain hidden behind a fresh cache entry. A publication
change detected during the object read returns an explicit non-cacheable 503
retry response rather than a false 404 or stale bytes. Because normalization
is synchronous, no persisted `validating` state or scanner fallback exists: a
live asset row itself is ready evidence, while draft and published event
pointers express use. These public-image uploads do not use the participant
multipart/quarantine/scanner workflow and must not be described as scanned.

When a mutation leaves an asset unreferenced by both draft and published
snapshots, D1 tombstones it. The scheduled Worker deletes its R2 object and
then its row, retaining bounded attempt/error evidence when storage deletion
fails. Database triggers prevent retirement or deletion while referenced and
prevent event deletion from cascading away the only durable cleanup record.
Existing pre-normalization rows are deliberately detached and retired by
migration `0032_event_brand_asset_normalization.sql`; there is no raw-byte
compatibility serving path.

Existing event accent and participant welcome/support columns are the
published projection used by established consumers. Deployed external logo and
programme-hero URLs are retired authoring paths: they remain publicly readable
until the first Branding publication, which clears them. Published logo and
banner identity then use event-owned asset IDs. Branding publication increments
both the event revision and public projection revision, records audit/change
evidence and completes the ordinary Airtable event-data projection when
Airtable is authoritative. Draft changes remain in D1 because they are
unpublished Program Cue workflow state. Branding writes mutate first and make
success audit/change inserts conditional on the exact post-mutation revision,
operation ID and relevant asset pointers. Suppressed domain mutations therefore
cannot produce success history. Every non-no-op branding mutation requires
exactly one audit and one positive event-change sequence; missing evidence after
a committed mutation is reported as a committed warning and is never converted
to a zero sequence.
Event Setup rejects attempts to alter its retained legacy branding command
fields. Event cloning copies only unambiguous published text and colour settings
and is blocked while brand images, a legacy programme hero, or unpublished
branding changes exist, because its current clone plan cannot copy private R2
objects safely. Organisation brand defaults, arbitrary CSS, fonts, custom
domains and removal of platform attribution remain outside this slice. Support
links require HTTPS with a hostname and reject embedded usernames or passwords;
ports remain allowed because no current requirement narrows them.

## Public event-site publication decisions

The event site is a bounded editorial layer over the canonical event and
published programme, not a generic block editor. Its homepage has exactly six
known section types and its navigation has five known optional pages. Organisers
may hide or reorder sections with authoritative Move up/Move down controls.
Featured speakers and sessions use searchable available/selected lists whose
explicit selected order is the public display order; FAQ questions use the same
visible ordering controls. Disabled fixed pages remain compact until opened or
enabled. The editor cannot add arbitrary routes, HTML, scripts or layout
blocks. Editorial bodies use a deliberately restricted Markdown subset. Credentialed, non-HTTPS or
invalid Markdown links are rejected when the draft is saved; rendering repeats
the same link restriction as defense in depth rather than silently repairing
published copy. Enabled fixed pages must have case-insensitively unique
navigation labels and cannot reuse built-in event/programme destination
labels. The reservation applies before programme publication so a later
programme launch cannot introduce ambiguous links without changing the site.

The saved site draft and immutable published site snapshot have an independent
compare-and-set revision and lifecycle. An event site may publish before its
programme for CFP promotion, but featured speakers, featured sessions,
statistics and post-event recordings must remain disabled until a published
programme exists. Publication snapshots editorial configuration and the
ordered sponsor records, but never copies sessions, speakers, event description,
venue, map or branding data. Visible featured record IDs are materialized as
published-site references and must resolve to eligible records in the current
published programme. Site publication and schedule publication both recheck
that invariant inside their D1 compare-and-set boundary; an incompatible
schedule remains a draft and the previous public programme remains live. Hidden
selections are not hard references. Published-session status is part of the
same eligibility contract used by the canonical programme. After publication, public speaker eligibility is the same predicate used at
site and schedule publication: a public confirmed relationship, a published
profile, and a published public session with public content. D1
`getPublished()`, D1 public programme API pages, featured-ID membership
checks and featured-speaker mutation guards all use that live predicate.
Airtable-authoritative public reads continue to serve the immutable
published-provider snapshot; the same predicate is applied when staging the
next schedule publication, not by rewriting that snapshot from a later
confirmation. A pending alternative relationship
cannot keep a featured speaker eligible, and the final confirmed public
relationship cannot be hidden, deleted or moved back to pending while the
person remains featured. Unfeatured speakers can still move between pending
and confirmed. Approved public schedule content is
a separate invariant, preserved by the immutable-publication guards in
migration `0021`; featured-speaker relationship checks do not re-implement
that snapshot-integrity count. A database
guard prevents a referenced session, the last public confirmed
published-programme relationship for a featured speaker, or a session with a
published recording from leaving published status, public visibility or
confirmed participation until the public dependency is withdrawn. The same
last-relationship rule applies to hiding a session and to hiding, unconfirming
or deleting a `session_speakers` row. Session-speaker
`event_id` and `session_id` are immutable, and `person_id` may change only
when participant retention remaps the row onto an archived
`retained-participant-*` identity stamped with the current event retention
operation after featured-speaker references are withdrawn. Any other
relationship movement is a guarded delete plus insert. A featured
speaker's canonical profile cannot return to draft while any published site
references it; another session cannot compensate because profile publication is
global to the person. These guards remain authoritative under concurrent writes,
while the service layer translates their exact failures into withdrawal-first
guidance. The organizer sees branding, site and programme publication state
together even though their publication boundaries remain independent.

The event public slug becomes immutable when either the public site or programme
is first published. Event Setup applies that rule in validation, in the atomic
event update predicate and when classifying a rejected concurrent write, so a
site-only launch cannot leave shared homepage, fixed-page or social-card URLs
behind after a rename.

The site draft and ordered sponsor rows are read in one D1 statement so they
belong to one database snapshot. The final site-and-sponsor snapshot is
schema-validated and written directly by the guarded publication statement;
publication does not first copy and then replace the draft JSON. That statement
atomically rechecks the canonical event
description and venue dependencies as well as visible programme references.
Public routes repeat those checks before rendering. Event Setup refuses to
remove description or venue data still required by a published site. Persisted
snapshot corruption, missing visible references and invalid published branding
fail with a non-cacheable error rather than dropping content or substituting
Program Cue presentation defaults.

Every site, sponsor and recording mutation carries a UUID into the existing
durable idempotency ledger. Consequential publish, withdrawal and removal UUIDs
are derived from the actor, event and exact entity generation, so a lost
response, revalidation or reload retries the same intent; a changed revision or
completed lifecycle transition creates a different intent. The ledger binds
that command identity to the exact validated payload and committed result: an
exact replay returns
the original entity or revision and event-change cursor without another
mutation or audit row, while reuse with changed details returns a conflict. The
command claim, domain mutation, audit/change evidence and durable response
complete in one D1 batch.

Every public-site, sponsor and recording command ends with an operation-specific
atomic batch guard. Once that command's domain operation marker exists, the
guard requires the complete resulting state, exact audit and event-change
evidence, positive change cursor and durable completed response; site
publication also requires its exact featured-reference graph and event
projection revision, sponsor mutations require the parent site's exact next
draft revision, and recording publication or withdrawal requires the event's
exact next projection revision. A
missing dependent statement therefore fails and rolls back the D1 batch rather
than leaving a processing command or reporting a committed operation as an
error. An unclaimed or rejected compare-and-set does not activate the guard, so
ordinary conflicts and command races retain their specific handling.

The editorial site draft, fixed pages and sponsors remain D1 control-plane
workflow state for either repository provider. Featured session/speaker
references and post-event recordings currently require D1 programme authority,
because their commit boundary otherwise would validate mutable D1 programme
rows after presenting an Airtable-authoritative immutable projection. The
server rejects those configurations before provider work and repeats the
authority predicate in the atomic mutation; hidden featured IDs are rejected as
provider-bound state, and the interface permits existing unsupported selections
to be cleared before the draft is saved even when they are absent from the
current provider programme. A published provider-incompatible snapshot fails
public reads instead of serving D1 programme content or silently hiding it. Recording
draft writes and publication fail explicitly for Airtable authority, while an
already-published recording can always be withdrawn. There is no Airtable-to-D1
programme fallback. Full Airtable support would extend the existing immutable
published-programme projection mapping with a provider-bound eligibility
manifest rather than add a parallel snapshot system.

Sponsors are event-scoped structured draft records and enter the public surface
only through the site snapshot. Recordings accept external credential-free
HTTPS URLs only; saving is explicitly neither upload nor publication. A separate
confirmed recording publication copies its draft fields, requires its session
in the published programme, and exposes it only after both the event and session
have ended. The event boundary is the first valid instant after its final local
calendar date in the configured IANA timezone; this is normally midnight, while
zones that skip midnight resolve to the transition's next valid instant. The UTC
date marker is never treated as that instant. Organisers can withdraw the public recording immediately without
discarding its editable draft, even while unrelated site-editor changes remain
unsaved. A later schedule cannot make the recording
silently disappear: preflight and the atomic schedule-publication statement
require every published recording's session to remain eligible. Optional
external caption and transcript resources are rendered beside the recording.
Upload processing, media hosting, rights management, transcription and caption
generation remain outside this slice. Recording draft/publication persistence
lives in a focused service inside the same modular monolith; it is not a media
subsystem or separate runtime.

Generated event and speaker social cards author a 1200×630 SVG, rasterize it
in-process with resvg (the Workers Images binding cannot decode SVG), then
require Cloudflare Images to encode that PNG as WebP. Missing Images, failed
rasterization or failed encoding returns an explicit non-cacheable 503. Card
URLs include the complete programme content identity and site publication
revision when a programme exists, or the canonical event-content identity and
site revision before programme publication, so branding, programme and
editorial changes cannot reuse the wrong cached unfurl. Promotion tools reuse
the existing speaker share URL instead of introducing a second speaker-landing
concept.

Fixed editorial pages are public-cacheable. Their conditional response identity
combines the request resource, complete programme/branding content revision and
site publication revision, so canonical event, programme, branding, sponsor and
editorial changes invalidate the representation together.

The programme and fixed event pages share one event header, navigation and
footer contract. With a published site, the root is explicitly Event home while
Programme and Speakers use their dedicated programme routes. Those three
primary destinations stay visible on wide screens; Schedule, gallery and the
five bounded editorial pages live in one keyboard-accessible Browse
popover grouped as Programme views and Event information. At tablet widths all
destinations use the same grouped Browse disclosure, so navigation capacity
does not depend on label length or JavaScript width measurement. Featured
sessions link to the strict sessions-surface `?session=` detail URL; a known
session on another public surface redirects to that canonical URL. Missing or
unpublished records still 404. Duplicate session parameters, mixed
speaker/session shares and embed session focus still 400. The
desktop/mobile preview selects the homepage
or any of the five fixed pages; fixed-page previews and public routes share one
page-content renderer, and disabled pages remain previewable with an explicit
unpublished label. The publication confirmation reports added and removed
sections, fixed pages, featured records and sponsors, plus ordering, theme and
editorial changes. A first publication uses that same comparison against an
empty public baseline rather than a reduced special case. The administrator route retains one loader/action and splits
only its concrete editor, sponsor, recording and preview panels; no generic CMS
component or block framework is introduced.

The canonical CFP projection carries one coherent application link and
availability state. It derives accepting, closed and submission-limit-reached
states from the same deterministic rule used by applicant workflows. Only the
accepting state is labelled “Apply to speak”; closed and full calls retain a
read-only “View call for speakers” destination. Availability participates in
the public content revision instead of becoming presentation-only stale state.
Responses that expose that live projection—the event and programme APIs and a
site-only event home—remain conditionally cacheable by ETag but require shared
cache revalidation on every request. A closing time, manual form transition or
new submission therefore cannot leave an accepting CTA behind a fresh edge
cache entry. Publication-only collection and editorial representations retain
their bounded shared-cache lifetime.

The public-site editor uses the shared navigation and before-unload blocker for
its client-held configuration. Internal navigation, event switching and closing
the page therefore require an explicit discard decision while edits are unsaved.

Light, dark and system themes are a controlled public-surface choice, including
managed programme embeds. They switch a closed event-site token set; arbitrary
CSS, fonts and user-defined theme values remain unsupported. The global
administrator and participant application still has no dark theme.

### External resource embeds

External resources are first-class typed document blocks for YouTube, Vimeo or
Google Maps, not organiser-entered iframe URLs. Deployment selects named
providers through `RESOURCE_EMBED_PROVIDERS`; exact frame origins, canonical
embed/outbound URLs, sandbox and permission attributes, aspect ratios and labels
come from one typed registry. YouTube and Vimeo store validated identifiers and
canonical source URLs. Maps stores a bounded place/search query and requires a
referrer- and API-restricted `GOOGLE_MAPS_EMBED_API_KEY`; arbitrary Maps share
URLs are deliberately not normalised.

Provider configuration is strict. Selecting `google_maps` without a valid key
fails runtime readiness and provider-policy construction; development and demo
therefore default to YouTube and Vimeo, while tests opt into Maps explicitly.
The deployment secret inventory requires the Maps key only when that provider
is selected.

Save and publication reject malformed, disabled or unconfigured blocks. Public
rendering reads the immutable typed document and applies current provider policy
rather than trusting stored HTML. The initial view is inert; a user action loads
the provider iframe, while the ordinary provider link remains visible at all
times. A provider disabled after publication becomes an explanatory link card.
Cross-origin iframe failure detection is not promised. General HTML, document
viewer, oEmbed, provider-plugin and per-event capability systems remain outside
this slice.

## Design system decisions

### Navigation, list-state and application-form versioning

The organiser rail exposes seven stable workspace families: Home,
Applications, Speakers, Programme, Communications, Event settings and
Operations. Existing route-specific tools remain second-level destinations;
they do not move or disappear with event phase. The public programme exposes
Programme and Speakers as its stable concepts; My itinerary appears only after
a visitor saves a session or opens a shared itinerary. Timetable and
Day-by-day, and Directory and Gallery, remain ordinary deep-linkable views
within those concepts. The retired Agenda URL permanently redirects to
Day-by-day Schedule instead of remaining a competing view. Every organiser destination has one
explicit family assignment; an authorised child is promoted when its parent is
unavailable, while missing or duplicate assignments fail validation instead of
falling into a catch-all group. Record-detail routes own a small typed
breadcrumb handle backed by their existing loader data. A successful detail
route without that handle fails explicitly; only an actual loader-error state
uses the generic record label so the original route error remains visible.

The application queue URL is the sole source of truth for filters, sort,
optional-column visibility, density and page. Mandatory identity/action
columns cannot be hidden. Supported values are closed enums; malformed or
duplicate values return 400, and a positive page that no longer exists returns
an explicit 404 while page 1 with no matches remains valid. Offset pagination
is intentional because the interface communicates numbered item ranges and
there is no measured scale requirement for keyset pagination.

Organiser-created application records and direct sessions use dedicated
routes. `/admin/sessions/new` is the canonical schedule-origin route; the only
accepted override is exactly one `from=programme`. Missing origin therefore has
one stable meaning, while duplicate, unknown and redundant `from=schedule`
values fail validation. Origin affects only the post-success destination and
never carries an arbitrary return URL or authority. A successful creation
redirects with the exact created record ID so the destination can focus and
confirm that record.

New and edited application forms use strict schema version 2. Sections have
stable IDs, ordered array position, titles and optional descriptions, and every
v2 field must reference an existing section. Unknown schema versions,
duplicate section IDs and missing or unknown references fail validation; there
is no unsectioned rendering fallback. The narrow schema-v1 parser exists only
for immutable historical form versions. Opening a mutable v1 draft projects
one deterministic `proposal` section for editing, but publication is blocked
until an explicit save writes v2. Published and retired v1 JSON is never
rewritten.

| Decision | Outcome |
| --- | --- |
| Token layer is authoritative for new work | `app/styles/tokens.css` owns reusable palette, spacing and type roles. New non-system hex palette values must be declared there. Context-specific translucent `rgb()`/`rgba()` and `color-mix()` composites may remain beside the surface that owns them unless they represent a reusable semantic role; repeated roles belong in the token layer rather than being copied. `scripts/check-css-hygiene.mjs` enforces the mechanical boundary and fails the check suite on: any non-system hex outside the token layer; an undefined `var()`; a font size below 12px; raw px padding/margin/gap; a raw shadow; a non-canonical breakpoint; or an unowned core selector. Fluid `clamp()`/`calc()` spacing is exempt as a deliberate responsive choice. UI TSX cannot contain hex literals; browser metadata and native colour-input defaults that must cross the CSS boundary live in `app/lib/product-colours.ts`. |
| Legacy visual debt fails directly | Former colour, button, shadow and breakpoint exemptions are removed. Future violations fail directly; there is no compatibility-baseline regeneration path. Detailed migration counts are historical evidence, not design rules. |
| Behavioural primitives are authoritative for actions | `Button`, `ButtonLink`, `ButtonAnchor`, `ButtonSummary`, `IconButton` and `IconButtonAnchor` own element semantics as well as appearance. Navigation remains a real React Router link, external navigation a real anchor, disclosure triggers remain direct `summary` children, pending buttons remain labelled, disabled and `aria-busy`, and icon-only actions require an accessible name. Inert previews and unavailable pagination use `ButtonAnchor` without an `href`; the class-name composer is private to the primitive module. `scripts/check-design-system-adoption.mjs` rejects every raw `btn` and `icon-btn` string outside that boundary. |
| Native form controls opt into owned chrome | Editable native inputs, selects and textareas use `.field`, `.select` and `.textarea`. The few controls whose interaction model genuinely differs use an explicit owned class: inline form-builder editing, inert canvas previews and the composite branding colour value. Hidden fields and checkbox, radio, file, colour, range and button inputs keep their dedicated contracts. A syntax-aware repository gate rejects missing, mismatched and invented form-control classes; adding a wrapper component solely to carry one class would add indirection without improving the contract. |
| Structural context does not buy cascade priority | Ancestor context used only to scope a component is wrapped in zero-specificity `:where(...)`; state and component selectors retain the priority they actually own. Variants that must override a shared primitive either follow its base rule or supply documented custom properties. Biome treats descending specificity as an error, and suppression comments are not an accepted baseline. |
| Core selectors and breakpoints have explicit owners | `.btn`/`.icon-btn` belong to `base.css`; `.field`/`.select`/`.textarea`/`.pill` to `form-controls.css`; and `.status` to `design-primitives.css`. The CSS gate rejects another root owner. Responsive work uses 360, 400, 560, 600, 760, 900, 1000, 1180 or 1350px maximum boundaries; 761, 1001, 1181 and 1351px are the explicit non-overlapping minimum companions currently in use. The checker reads every condition in compound media queries. |
| Spacing tie-breaks are a design rule, not rounding | On a 4px grid, 10px and 14px sit exactly between two steps. Ties tighten the space _between_ things (`gap`, `margin`) and loosen the space _inside_ them (`padding`, `border-radius`, type). Recorded because the direction is a judgement that would otherwise look arbitrary in the diff. |
| Two-tone focus ring, no per-surface overrides | `--focus-ring` uses `--brand-900` (`#522116`) on light grounds and a white `--focus-halo` carries contrast on dark and saturated ones. Both are always painted, so one rule clears the required contrast without surface-specific focus treatment. Nothing may set `outline: 0` without providing an equivalent indicator. |
| Two weights per state colour | `--state-*-solid` paints graphical objects and clears 3:1 against the `--track`; `--state-*-text` paints labels and clears 4.5:1 on white. `--green` and `--amber` are not usable as fills (2.80:1 and 2.71:1) and must not be used as such. |
| Warning hue stays separate from product emphasis | Copper identifies Program Cue actions and informational emphasis, so operational warnings use a gold/olive family instead of orange-brown. Warning text clears 7.28:1 on white, warning graphics clear 4.39:1 against `--track`, and the on-dark warning clears 10.93:1 on the navigation ground. Warning is a feedback/status tone rather than an action-hierarchy variant; actions use default, primary, ghost or danger according to consequence. Danger remains red and success remains green; state meaning never depends on colour alone. |
| Event accent is identity, not global chrome | An event without published custom branding begins with Program Cue copper (`#9d4a31`). Once an organiser chooses an accent, participant-facing identity marks, decorative rails and primary actions use its exact or contrast-safe derived colour. Program Cue navigation remains product chrome and success, warning and failure remain semantic colours; changing an event accent must not recolour either. |
| Gradients are identity, never state | Gradients are permitted on brand marks and heroes. They are not permitted on buttons, progress fills, nav active states or any measured value. A gradient on a measurement implies the value varies across the bar, and `opacity` on a gradient reads as a lighter colour rather than as disabled. |
| Program Cue mark | The product mark is the four-corner registration symbol: three corners use the surrounding text colour and the top-right corner uses `--brand-600`, or the explicit event accent on event-branded surfaces. It is rendered as inline SVG at product surfaces and as a standalone adaptive SVG favicon; raster generations remain concept evidence rather than production assets. |
| Elevation contract | Border contains, tint groups, shadow floats. A card on canvas is a 1px border with no shadow; a panel nested inside a card recedes to `--surface-sunken` with no border and no shadow; a popover is `--elev-3` with no border. |
| Consequential actions show blast radius | `window.confirm` is not permitted. `ConfirmDialog` is used instead and is passed the affected records whenever they are already in scope, satisfying the contributor rule that consequential actions show what they will change. |
| One feedback rule | A result that stays on the page is an inline `StatusNotice` beside the affected workflow. It remains visible with the workflow rather than exposing a speculative dismiss path that could hide durable operational state. Cross-navigation results use an explicit destination notice carried by the route; no shared action-toast abstraction is required. `{ ok: false, committed: true }` is a warning, not a failure — that work committed. |
| Assistant palette drafts stay out of URLs | An `ask …` command carries its unsent, event-sensitive draft through validated React Router navigation state, consumes it into the controlled assistant composer and immediately replaces the history entry without that state. The draft never enters a query string or loader request, a later handoff replaces the current text, and a hard reload deliberately discards it. The ordinary 4,000-character assistant limit remains the only handoff-size rule; server-side validation still applies when the operator explicitly submits the request. |
| Global application dark theme deferred | Removing literal and shadow debt clears the previous technical blocker, but it does not by itself define or accept a complete dark palette for dense administrator and participant workflows. The bounded anonymous event site remains the deliberate exception: light/dark/system switches only its closed public token set and managed embeds, with browser contrast coverage. A global theme requires its own cross-surface contrast and visual acceptance rather than being inferred from debt removal. |
| Reduced motion slows, it does not freeze | `prefers-reduced-motion` overrides `--dur-*` to 1ms rather than blanket-killing animation, so loading signals stay legible at a calmer speed instead of appearing frozen. |
| `.grid-N` is a column ceiling, not a column hint | The track floor is `max(--grid-min, 1/N of the row)`, so extra width widens the existing columns instead of adding more. Previously `.grid-N` meant "as many `--grid-min` columns as fit", rendering `.grid-2` as three columns at 1440px, four at 1920px and six at 2560px — a larger screen bought more cramped columns rather than more comfortable ones. Only narrowing drops columns now. |
| Repeating record editors are tables, not cards | Rooms, tracks and formats use rows under shared headers. This keeps user-grown collections compact and prevents tall cards from creating empty grid space. |
| Admin content has a maximum measure | `.main` is centred, capped at 1600px and explicitly `width: 100%`; auto margins otherwise collapse the grid item to fit-content. Wider screens must not stretch text and fields indefinitely. |
| Unbounded collections collapse by default | Data-growing panels start closed with their record count visible. Deep links reveal the owning panel before focusing its record. |
| Unsaved client state blocks navigation | Where a form holds edits that exist only in client state, leaving is confirmed rather than silent. Event Setup's rooms, tracks and formats reach the server through serialised hidden inputs, so navigating away discarded them with no warning. The blocker compares pathnames so the save POST and the focus-clearing replace both pass through. A typed but not yet added room, resource, track or format also blocks save until it is added or cleared, so a successful save never ignores a visible half-record. |
| Distinct route jobs use mounted workspace panels | When one route owns several distinct jobs under one loader/action boundary, a compact pressed-button navigator switches mounted panels instead of adding routes or nesting the work in one long disclosure. Mounted content preserves unsaved form and builder state. Event Setup keeps one canonical form and shared save instrument across Identity, Structure, Access and Data; hash targets, server errors and invalid native controls reveal the owning panel before focus. Programme Publishing separates records, stateless embed configuration and managed-embed lifecycle. Branding keeps the desktop edit/preview split but switches those mounted surfaces on narrow screens. |

## Cross-surface visual language decision

The public site and every application shell use the same restrained
ink-and-copper product palette: warm canvas and paper surfaces, tinted
elevation, and copper for product emphasis. Event-branded public programme and
application surfaces continue to derive their accent exclusively from the
published event brand; the product palette must not overwrite it. Operational
shells use the self-hosted Inter variable face for headings as well as body
copy, controls and data, so dense working views keep a single scanning rhythm.
The static B2B marketing site and event-branded public pages also use the
self-hosted Inter variable face, with hierarchy expressed through layout,
weight and tracking rather than a browser-owned serif fallback. This avoids a
third-party font request and preserves the public site's `font-src 'self'` CSP.
Shared token changes are the primary mechanism for cross-surface design
changes; workspace styles own only the exceptions required by their interaction
model. Event accents may identify primary actions but never receive synthetic
product gradients, and status text rather than a decorative dot communicates
state.

The public-site release gate protects the visible product scope rather than an
exact marketing sentence. The homepage must describe one connected workflow
and name submissions, reviews, speakers, communications, scheduling and
publication, but its headline and supporting copy may evolve. Google OAuth
review requires an accurate public product description; it does not make one
internally approved sentence an external invariant.

### Taste-led surface refinement

Program Cue remains an operations product. Application surfaces therefore
prioritise compact information density, restrained visual variation and motion
only when it communicates state or spatial change. Dense review, scheduling
and administration workflows stay calm and scannable instead of adopting
landing-page composition or decorative animation. The existing self-hosted
Inter face, semantic tokens and accessible component primitives remain the one
application design system; no second UI library is introduced.

The anonymous event site has a lower density and may use the event's supplied
hero image and accent. Its curated homepage owns the full public-event measure
above the filterable programme; the programme and itinerary retain their denser
working layout below. Public light, dark and system themes remain event-site
choices. A global application theme remains deferred for the reason documented
above.

The homepage follows an editorial event hierarchy rather than a dashboard or a
stack of interchangeable cards. Scale and emphasis are spent on organiser copy,
people, sessions and event facts rather than ornament. Curated sessions state
their event-local date and time, the transition into the working programme is
named, and repeated venue information is suppressed. Attendee-facing controls
use task language rather than file formats or implementation terminology.

The editor preview and published page render the same composition. Homepage
relationships respond to the content container rather than the viewport, so a
phone-sized preview in a desktop window behaves like the published phone page
without a second set of mirrored layout rules.

Motion is confined to state feedback and is expressed through the shared
duration tokens, so `prefers-reduced-motion` governs it. Interactive feedback
must not shift repeated records under the pointer or keyboard focus.

Event branding accepts arbitrary six-digit accent colours and optional customer
imagery without weakening legibility. Decorative accents remain exact, while
text and control foregrounds are derived for the light, dark, tinted and solid
surfaces they actually occupy. Contrast is checked after foregrounds reach
their final hexadecimal colours, with a safety margin where the colour space
allows one. Browser and presentation-rule coverage exercise representative
pale, dark and boundary accents against the rendered surfaces.

Sponsor tier sequencing on the public sponsors page is the alphabetical order of
the tier names an organiser typed, because tier is free text and nothing in the
schema ranks one tier above another. `idx_event_site_sponsors_order` and the
service's read both encode `tier, position, name, id`, so `position` orders
sponsors within a tier and never between tiers. That is a real limitation: a
roster of Platinum, Gold and Bronze publishes in the order Bronze, Gold,
Platinum.

Ranking tiers explicitly is the correct fix and is deferred rather than
declined. It needs a stored rank, a backfill rule for existing rows, a numbered
migration replacing the index, editor affordances for ordering the tiers and a
decision about what a tier is when two events spell one differently. None of
that was required to seed and lay out the evaluation event's pages, and doing it
inside a content change would have altered the published meaning of already
persisted `position` values without a migration. The demo fixture works within
the current rule by naming its tiers Headline, Major and Supporting, which read
in their own hierarchy alphabetically; `demo-reset-fixtures.ts` records that
constraint where a maintainer adding a tier will meet it.

## Launch-film evidence and delivery contract

The six-minute Remotion film demonstrates verified seeded behaviour. Captures
and code-native motion must preserve real workflows, permissions and state
boundaries; editorial event imagery is not customer evidence. Audience copy
leads with outcomes, while material limitations such as an Accelevents export
preview remain explicit. It must not invent provider success or customer metrics.

The film uses US English “program” in authored copy; the product name remains
Program Cue and captured interfaces and routes retain their source spelling.
The approved soundtrack is hash-pinned and recovered from the immutable released
master; generating new provider audio requires explicit selection. Voice-over
and procedural-score auditions remain unmounted unless deliberately selected.

`video/story-state.json` guards source/capture freshness. Publication requires
media validation, decoded-frame comparison and visual review, plus the release
owner's applicable Remotion and ElevenLabs commercial-use approval. The public
bundle pins the master, soundtrack, poster, captions and matching transcript
independently of the working cut. An unpublished render cannot alter that bundle.

The public film uses a dedicated `programcue-media` R2 bucket and
`media.programcue.com`, separate from private application files. A native player
requires explicit play, supports reduced motion and has a visible transcript.
The static website permits only the exact media origin while retaining
`script-src` and `connect-src` as `none`. R2 suits the current single low-bitrate
film; adaptive delivery can be reconsidered if actual usage requires it.

Commands, asset provenance and delivery checks live in the
[film production notes](../video/README.md). Dated release approval and live
acceptance live in [implementation status](IMPLEMENTATION_STATUS.md#public-website).

## Bounded participant-operations depth

Session participation is modelled as a small fixed set of roles—Speaker,
Moderator and Chair—beneath the existing person/session relationship. Each role
owns its response and revision; the relationship status is derived for existing
publication, task and resource rules. This avoids duplicating people or
inventing configurable role taxonomies while fixing the real ambiguity of one
response covering several responsibilities.

Event-owned fields are deliberately typed storage, not a form-builder platform.
They may belong to a person or session and may be text, number, boolean, date or
fixed choice. Participant access is hidden, read-only or editable. There are no
formulas, conditional visibility, cross-field rules or arbitrary owner types.
Standard profile fields use the same three access levels but retain their
canonical columns and validation.

Event-field value edits use optimistic concurrency independently of definition
revisions. Forms carry the loaded value revision, cleared values remain as
revisioned JSON null tombstones, and database triggers reject a stale upsert
before any field in its D1 batch commits. The upsert transiently carries its
expected revision in `updated_at`; companion triggers immediately replace that
sentinel with the real commit timestamp. Keeping cleared rows avoids an
insert/delete ABA path without adding a separate lock or mutation-log table.

Role response state and person-owned event field values remain participant
data. Retention finalisation redacts or removes them before setting the durable
event tombstone, and database triggers reject later writes that could
reintroduce that participant data.

Application opening and per-person limits are form publication settings and are
revalidated at final submission. Automated participant follow-up remains a
fixed daily trigger system: task due, task overdue, unsubmitted draft and
pending participation response. New trigger types reuse the durable preview and
delivery path; they do not introduce a generalized automation canvas.

Speaker readiness is an explainable set of operational signals rather than a
score. A speaker needs attention when a profile is unpublished, a role response
is pending, a required event field is missing, an accessible task is incomplete
or a file is quarantined. The UI exposes the reasons and fixed reminder cohorts
instead of hiding prioritization behind a weighted formula.

## Role-aware participant navigation and bounded review scoring

The participant workspace retains every stable route on desktop. At phone
width it exposes four labelled primary destinations plus More: participants
with application work prioritise Applications, participants with sessions
prioritise Sessions, and participants with both capabilities keep both. Tasks
remains primary for every participant; less-used destinations remain in More,
which also represents the active state of a contained route. This is a durable
capability-based arrangement, not a ranking that changes with transient task
counts or whichever of a participant's memberships wins role resolution.
Application capability is projected by the participant portal itself after its
single repository-authority checkpoint, using an organisation-, event- and
person-scoped existence query. Full application payloads are loaded and
validated only when the participant opens the Applications workspace.

At the three-column desktop breakpoint the review queue, source and rubric form
one viewport-bounded work surface. Source and rubric scroll independently,
rubric progress and commit controls stay visible, and the queue scrolls only
when its contents exceed the available height. Narrower layouts retain normal
document flow rather than stacking several short nested scroll regions.

## Operational truth and administrator information architecture

The Command Centre treats percentage as progress and qualitative status as an
operational assessment. Danger-severity condition categories are counted as
critical conditions and take precedence over percentage, producing
`needs_attention`; warning-only conditions may remain `on_track`, while a
sub-75 score without a critical condition is `at_risk`. Headline counts describe
condition categories, while each condition card reports its affected-record
count; one record may legitimately appear in more than one category. Only 100%
with no active condition is `ready`. The readiness domain service owns these
states and counts, and contextual AI may prioritise that evidence but cannot
recalculate or relabel it.

Tasks & readiness is a first-level Event work destination because its speaker,
session and event requirements are not subordinate to Communications. The
administrator IA distinguishes Event speakers from the organisation-wide
Speaker directory, names the actual planning workspace Schedule planner, and
names its publication child Public programme & embeds. Route URLs remain
stable; the command palette retains the former labels as search aliases.

Evaluation summary metrics describe the same round- and filter-scoped review
target projection as the unified results. The total and proposal/session
breakdown are calculated after result filters and presets but before
pagination; raw workspace array lengths are not presented as equivalent to
the filtered result set.

## Bounded Sessionboard-parity extensions

Reporting depth starts with two fixed relational CSV contracts, Participant
readiness and Session staffing, on the existing authorised export operation.
The readiness report spans claimed application participation, session roles,
tasks, required event fields and quarantined files; the staffing report spans
session/person/role response, active draft-or-published placement and
outstanding requirements. These reports do not introduce arbitrary joins,
field selection, saved schemas, sharing, dashboards or scheduling. Existing
roster filters are deliberately not coupled to exports until a concrete filter
contract is required.

Schedule-change notification is one event-level, opt-in transactional email
trigger. The trigger follows its template's sole current published email
version; each publication then pins that exact version and sender in immutable
communication intent. The first publication is a baseline. Later revisions
notify for session addition/removal, time or room movement, public-visibility
change and title change. Description, track, format and duration edits do not
send because they are editorial metadata changes rather than the bounded
staffing/logistics signal. Pending and confirmed role holders are eligible,
declined roles are not, and all affected sessions are grouped into one delivery
per person. Publication preview exposes the exact cohort and invalid enabled
configuration. The communication graph is committed atomically with schedule
publication before Queue dispatch; a later dispatch failure is retryable and
does not misrepresent the already published schedule. There is no inbox,
channel preference matrix, digest scheduler, Slack or SMS path.

Reviewer inability to review reuses the existing `recused` terminal assignment
state instead of adding a parallel assignment lifecycle. Typed provenance
distinguishes conflict, insufficient expertise, unavailable and other, with an
optional private note. Only conflict creates an `evaluator_conflicts` record.
Returned assignments are resolved for the reviewer but continue to reduce
organiser coverage, so progress presents submitted, returned and resolved
counts separately. The private abstention note is visible to authorised
evaluation managers and excluded from audit metadata and applicant surfaces.
Selecting a conflict exposes only the conflict-return path, so the reviewer
cannot accidentally replace known conflict provenance with an ordinary return.
An abandoned draft remains durable history after return, but organiser
projections redact its scores, recommendation, feedback and notes, and review-
cycle readiness does not count it as unfinished work.

## Operational prioritisation, schedule scenarios and bounded AI feedback

The Command Centre selects one “Do this next” action with a fixed domain-owned
priority order. Critical conditions precede warnings; schedule publication
conflicts, overdue work and other declared operational failures have explicit
relative priority. Remaining conditions are grouped as Must resolve, Due soon,
Waiting or follow-up, and Plan next. The seven-day due-soon condition is derived
from existing task due dates and excludes critical work already represented by
the higher-priority critical condition. Its destination uses the same explicit
due-soon/non-critical filters. This is presentation over authoritative
readiness records, not an assignment queue, workflow engine or AI ranking. When
no AI provider is configured, the large AI controls collapse to one optional
setup notice while deterministic actions remain available.

Schedule scenarios are private, immutable auto-placement proposals attached to
the single active draft; they are not additional `schedule_versions`. The user
first reviews the existing deterministic placement proposal and selects the
moves that define the named alternative. Saving recomputes the proposal
server-side, rejects selections outside it, and records the selected intent
with its exact draft, event, policy and session revisions. Applying the saved
selection, or changing that selection during review, goes through the existing
auto-placement confirmation command and its commit-time revalidation. Current
warning evidence is recomputed from authoritative rules; stale warning evidence
is not presented as current. A later source change makes the saved scenario
inspectable but inapplicable until a fresh scenario is created. An event may
keep at most ten active scenarios. There are no natural-language constraints,
alternative optimisers, scenario-specific authority rules or parallel draft
publication paths.

Every successful schedule publication stores a change digest in the same D1
batch that makes the schedule authoritative. Category counts are exact. Stored
record highlights are capped at twenty per category and content changes retain
field names rather than previous/new bodies; the pre-publication confirmation
continues to show the full exact diff. This makes the latest publication
explainable without risking an oversized row or building a reporting system.

AI feedback belongs to the requesting person’s completed, event-scoped
`ai.*` operation. It records helpful or not helpful, one focused problem reason
and an optional bounded detail, and the requesting person may correct the
recorded classification through the same result UI. Audit metadata records the
classification and whether detail exists, not the free-text detail. The result
store does not copy model prompts or outputs and does not introduce experiments,
incident routing or a telemetry dashboard.

Existing saved views already persist authorised administrator URLs, including
their filters and sorting, and existing exports remain the report contracts.
No separate saved-report schema or semantic reporting layer is introduced
without a concrete filter/export contract that the current saved-view mechanism
cannot represent. The evaluator guide and optional numeric AI assessment remain
unchanged.

### Research disposition — 6 September 2026

The 3 September UX/AI competitor research is retained in Git history at commit
`65cf10337eb70c2e9f8d99d614316c73b495fb55`, path
`docs/UX_AI_COMPETITOR_RESEARCH.md`. Its accepted direction is recorded above;
it is not a second active backlog. The research used public vendor material and
repository inspection, without authenticated competitor trials or moderated
usability evidence, so its comparative claims require fresh research before reuse.

Numeric AI assessment remains an optional organiser/chair diagnostic, separate
from human scores and ranking. Reviewers first save independent work, then may
request the existing evidence aid; a model must not make acceptance, rejection,
mass-send or publication decisions autonomously. Do not substitute model
confidence or invented citations for evidence.

Deferred hypotheses are natural-language reporting, richer scenario constraints,
read-only event-scoped MCP, a consent-based organisation-scoped reusable speaker
profile, attendee discovery over published data, collaboration presence and
aggregate AI telemetry. None is committed scope merely because it appeared in
research. Revisit only after observing a concrete limitation of existing saved
views, deterministic scheduling, profiles or public filters. Any MCP pilot must
reuse existing read authority, revocation and tenant isolation; any later write
must use in-product proposals and approval. Profile reuse requires explicit
consent, provenance and review before copying into another event.

Validate the adopted workflows with programme leads, chairs, reviewers, speaker
coordinators and schedulers across small and multi-track events. Measure top-action
comprehension, time to a publishable draft, constraint failures, report reuse,
AI feedback reasons and completion without AI. Include 320-pixel layouts, 200% zoom,
keyboard/focus recovery, concurrent edits and manual screen-reader acceptance.
These are future acceptance activities, not results of the research.

## D1 production integrity validation

Release validation inventories production tables from `sqlite_master` and runs
`PRAGMA quick_check(table)` for every customer-inspectable table. A single
database-wide `PRAGMA quick_check` exceeded D1's query memory after migration
0057 even though every table-scoped check succeeded. The inventory is resolved
at release time so later tables cannot be omitted silently, and any missing,
failed or non-`ok` result blocks deployment. Cloudflare's protected `_cf_`
internal tables are excluded because D1 rejects direct inspection of them.
Foreign-key validation and the explicit migration/schema contracts remain
separate blocking checks.

## Review workbench hook boundaries — 5 September 2026

The review workbench model composes a draft lifecycle hook, a keyboard/focus
hook and display calculations. Autosave, acknowledged revisions, edit
generations, draft recovery and save-before-navigation remain together because
they share one concurrency boundary. AI import and confirmation state lives in
a focused hook used by that lifecycle; restoring AI suggestions still follows
the ordinary draft restoration path. These are component-level boundaries,
with no new runtime or persistence mechanism.

A queued navigation must wait for the preceding save acknowledgement before
flushing newer edits. Fetcher idleness alone does not mean the revision has
advanced: the response effect still owns the in-flight edit generation until
it has processed the acknowledgement.

## Submission draft discard repository — 5 September 2026

Draft-discard persistence lives in `SubmissionDraftDiscardRepository`: acquiring
the durable lock, finding completed retries, selecting private assets under
that lock and atomically finalizing deletion, membership cleanup and audit
evidence stay together. The existing `D1SubmissionRepository` delegates these
operations directly to it. Applicant draft creation, saving and withdrawal
remain in the applicant repository; private R2 erasure remains orchestrated by
the applicant workflow between lock acquisition and finalization. The
extraction preserves SQL, transaction boundaries and error behavior.

## Application-owned AEK evaluations — 6 September 2026

Programcue owns its evaluation configs, pinned upstream fixtures and scenarios
under `evals/`. AEK is installed from an explicitly selected package checkout;
its public CLI and package exports are the integration boundary. Configs use the
application root so ordinary AEK receipts identify Programcue. Private state and
reports are ignored. Earlier standalone reports retain their original sealed
identity and must not be resumed under the moved configuration.

The pinned upstream criteria are a comparison contract, not the product spec.
AEK's explicit equal automatic/manual shares for the 15 hybrid criteria are a
new scoring policy; historical SBEK percentages are not comparable. Unverified
manual shares reduce coverage. Preserve upstream EMB-16 and score it honestly;
the separate Programcue regression suite verifies draft isolation followed by
explicit publication. A failed exercised action is scoreable failure; unavailable
providers or insufficient evidence are missing coverage. Local Mailpit evidence
never establishes external delivery or ordinary production email verification.

Opaque email-preview frames retain their empty sandbox and no-referrer policy.
A coding-agent screenshot that masks them is unavailable evaluator evidence, not
a blank-preview product defect. Direct project-owned Playwright smokes verify
rendering without loosening those application or evaluator boundaries. Missing
local upload/scanner configuration is a blocked browser-acceptance check; released
R2 fixtures in Worker tests establish ZIP bytes separately and never claim scanning.

The explicit `evals/` file smoke and AEK file regression share the local R2
emulator plus a signed S3 transport adapter, with a manifest containing only acknowledged multipart
writes. It verifies the existing signed scanner dispatch and object identity,
runs the production Python ClamAV invocation with fresh signatures in an isolated
container, and delivers the ordinary signed callback. Missing prerequisites and
scanner execution errors fail this smoke; no verdict is fabricated. A virtual
HTTPS callback origin is routed inside Miniflare, so production network policy
needs no local exception. Hosted S3/CORS, the scanner HTTP object proxy and
Cloudflare Workflow/Container scheduling require separate acceptance.

An evaluation-only Worker entry maps same-origin loopback uploads back to the
original signed S3 authority. Ordinary browser requests work for both AEK and
Playwright, without browser interception or changes to production configuration.
AEK retains scanner receipts through a public command collector and checks their
actual object hashes, engine/signature metadata and accepted callbacks. Its ZIP
grader inspects retained bytes independently of the browser model. The first
completed run exposed a remaining LLM checkpoint-scope limitation for version
history; preserve that partial grade separately from deterministic integrity
passes. No reusable AEK core change was required for this integration.

The file regression now splits the previous version-history weight equally
between an LLM check of visible history/current markers and a deterministic
check of both individually downloaded PDFs against distinct fixture hashes.
This preserves combined weight 4 for the original file criteria and makes byte correctness
independent of visual judgment. Upstream criteria remain unchanged. Both
regression model roles are pinned to `gpt-6-astra` with medium reasoning;
AEK records requested model/effort and CLI versions, without claiming that
Codex's JSON event stream confirms a resolved provider model snapshot.

The file area adds separate deterministic criteria for EICAR quarantine and
anonymous private-file denial, each with weight 1; the original four criteria
keep their weights. Clean scan receipts are collected before a second browser
workflow uploads the EICAR PDF as v3. A public AEK command collector retains
actual local scanner results, authenticated server version history and the
response bodies/statuses from organizer and empty-cookie requests. Quarantine
must preserve current v2 and its exact bytes while denying v3. Anonymous denial
needs a successful authenticated control for the same URL; an unrelated error
page cannot establish authorization correctness. No hosted credentials, direct
database release changes or synthetic scanner verdicts are involved.

Local Programcue regression selections share one isolated Worker runtime.
AEK's validated JSON plan determines whether selected file-integrity scenarios
require the signed storage adapter and real ClamAV; publication and mail alone
do not start those services. Its only additional outbound network
permission is POST to the fixed loopback Mailpit send endpoint, with redirects
rejected and actual provider responses/errors preserved. This allows the three
project areas to share fresh state without introducing production credentials
or claiming external delivery. Publication checkpoints retain the unapproved
blocker, approval action, explicit publication and anonymous result together
so scoped judging can assess the complete publication boundary.

AEK records checkpoint argument failures inside its authoritative browser/workspace
transcript. A completed finalization requires the checkpoints selected by the
rubric and returns a recoverable error if any are missing; unused declarations
do not prevent completion. Honest blocked or feature-not-found outcomes retain
partial evidence and unavailable coverage. The evaluator dependency includes
this handling without changing Programcue's application or scoring criteria.

The nine-criterion local regression comparison baseline is `local-astra-medium`,
promoted from the verified combined run `2026-09-06T13-55-39` with reviewer
recorded as Codex. The explicit promotion policy uses `development` (all current
project criteria), requires 100% score and coverage, and checks every required
scenario. No milestone-policy bypass is used. Its compact snapshot preserves
requested Astra/medium settings and source artifact provenance; baseline
promotion is separate from ordinary evaluation and does not assert production
acceptance. The subsequent checkpoint-fix publication run provides bounded
validation of the updated kit; the other areas were not rerun for that fix.

Local evaluator commands run in owned process groups. Cancellation, early leader
exit and unexpected Worker exit must stop surviving descendants before owned
state is removed; the shutdown grace allows AEK to stop its detached providers.
Docker cleanup failures must still release the coordinator lock. Generated
baseline snapshots are excluded from formatting because their exact bytes are
part of AEK's integrity contract; baseline loading/comparison validates them.

A successful workspace finalization is terminal, including blocked outcomes;
later tools cannot add evidence or overwrite the result. Report provider fields
come from the retained receipt, so rescoring with changed configuration cannot
relabel the model or reasoning effort that collected the evidence.
AEK's artifact validation must also retain effort when a sealed collection is
passed to a detached judge; the current evaluator package includes that schema
round-trip fix.

Scanner evidence uses one shared structural validator. Missing engine, callback
status or object-size fields are execution errors, not failed product criteria.
The shared validator is declared in collector/grader method files so its changes
affect AEK provenance. Mailbox providers likewise share one bounded JSON reader
inside AEK, preserving limits, cancellation and redacted failure diagnostics.

Local startup retries only expected transient conditions: a missing ClamAV ready
file, Worker connection refusal/reset/timeout, or HTTP 503. Docker command errors,
unexpected HTTP statuses and exited Workers fail with diagnostics; each ClamAV
readiness command has a bounded timeout. Preflight uses AEK's public JSON plan
before any owned resource is created rather than duplicating its CLI parser.
The real-file smoke shares the grader's explicit anonymous-denial policy. It
requires a same-URL authenticated byte control, rejects anonymous private bytes,
and accepts only an access-denial status or the expected local sign-in redirect.
Server errors and redirects to unrelated or accessible files cannot pass.

The local evaluator always rebuilds Programcue before serving it, overriding
the ordinary E2E skip-build environment setting in both startup paths. AEK's
current-checkout receipt must not describe an older application build.

Configured scanner failures notify the isolated runtime immediately and remain
errors when its pending work drains. The coordinator checks the Worker's final
exit status after collection, so a blocked scenario cannot hide provider errors
by skipping its evidence collectors. Cleanup still removes owned containers,
state and locks before reporting unsuccessful or forced Worker termination.
Normal isolated shutdown uses an IPC request so service draining finishes
before process-group signals stop remaining descendants. The coordinator rejects
an isolated Worker that needs forced termination instead of accepting its signal
exit as proof that cleanup succeeded.

When the installed evaluator requires provenance absent from an older baseline,
collect and promote a fresh compatible run through AEK's public CLI. Preserve
historical sealed snapshots; do not fabricate missing receipt fields or bypass
schema validation. The active `local-astra-medium` baseline now uses the verified
nine-criterion run `2026-09-07T02-12-32` with AEK 0.4.0, under the same strict
promotion policy. A suite test exercises named baseline loading with the locked
evaluator so dependency/schema changes cannot silently break comparison.

## 2026-09-07 — Reconcile browser form recovery with current event choices

Form-builder loading and explicit browser-draft restoration share the same pure
choice reconciliation. Track IDs and session-format keys preserve routing and
conditional fields across label changes, while custom fields and the recovered
form/draft revisions remain intact. Restoration must not adopt newer server
revisions: concurrent server edits still require explicit conflict resolution.
Conditions whose choices were removed stay visible and block saving until the
organiser repairs them; recovery does not silently remove their conditions.

The form action reports domain validation failures as 400 responses with their
specific repair message. Only a revision mismatch activates the 409 draft
conflict controls. The builder toolbar remains below the fixed admin topbar and
evaluation banner while the page scrolls, keeping save and publication controls
reachable by pointer and keyboard.

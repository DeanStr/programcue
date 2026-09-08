# Verified implementation status

Evidence recorded through **8 September 2026**.
This is the current capability,
requirements and acceptance index; consolidation does not constitute a new
verification or deployment. The [product specification](../sessionboard-replacement-full-scope-implementation-specification-with-competition-ux.md)
owns intended scope, [DECISIONS.md](DECISIONS.md) owns engineering decisions, and
Git history retains earlier committed work logs.

## Current position

- The modular monolith has connected Worker/D1-backed product slices across the
  main application workflow. Repository coverage does not establish replacement
  readiness or live-provider acceptance.
- Source `f3f0b887` passed the full release gate and was deployed on 8 September.
  Recovery, mouse/keyboard saving and publication passed on deployed `/evaluate`.
- The latest independent run published the CFP but was blocked at anonymous
  interaction, with **0% coverage and no acceptance score**. Its fixture was reset.
- Next: resolve the anonymous security-check/dependency boundary and repeat
  deployed acceptance with an explicit coverage gate. Provider, operational and
  manual acceptance gaps remain below.

Status terms:

- **Production slice / foundation:** connected production behavior or shared
  infrastructure, with server authorization, validation and durable storage as
  applicable. Deployment and provider acceptance are stated separately.
- **Frontend foundation / schema only:** interface or schema without the connected
  production behavior; neither counts as a completed requirement.
- **Demonstration only:** explicitly gated fixtures or simulations.
- **Not implemented / external acceptance outstanding:** absent behavior or an
  existing path that still lacks the relevant external verification.

## Latest recorded deployments

| Surface | Latest retained evidence | Boundary |
| --- | --- | --- |
| Application | `f3f0b88746c299e1ec220c3fc49dce7c4e0db7dd`, Worker `bf46ce32-a46b-4f56-959b-602328f9a8ce`, deployed 8 September; health matched before smoke and after final reset. | Supersedes `6e0d77da`. Health and bounded workflows do not verify every feature or provider path. |
| Public website | Bundle `67d5b4b4`, Worker `e9398ee9-5a85-4c73-b751-0de7468c0032`, deployed and exercised on 5 September. | Separate website release; includes the approved film and guide pages. |
| Scanner | Source `ae6133c`, deployed on 17 August with upload, scan, shutdown and erasure acceptance. | Later scanner changes and sustained burst capacity need separate acceptance. |

These are recorded observations, not current health checks. Use the
[deployment runbook](DEPLOYMENT.md) for release procedures.

## Capability status

All “production slice” entries describe repository behavior. The deployment and
acceptance sections qualify their live evidence.

| Capability | Status and verified scope | Remaining boundary |
| --- | --- | --- |
| Runtime and persistence | **Production foundation.** React Router/TypeScript Worker monolith; D1 control plane, explicit D1/Airtable domain authority, R2, Queues, Workflows and event-scoped Durable Objects. | Live Airtable authority/recovery acceptance. |
| Authentication and events | **Production slice.** Identity creation, invitations, tenant/event roles, provisioning, switching and cloning. Signup alone grants no organisation or event access. | Fresh identity/provider-error exercises and production security-hardening acceptance. |
| Forms and submissions | **Production slice.** Immutable form versions, conditional/stepped intake, event-owned tracks/formats, opening/closing dates and caps, anonymous/verified drafts, co-speaker claims, proposal revisions, direct-session intake and administration. | Deployed recovery/save/publication verified; anonymous interaction and subsequent independent acceptance remain blocked. |
| Evaluation and decisions | **Production slice.** Rounds, reviewer pools, mixed rubrics, blind review, assignments, abstention, review recovery, committee discussion, moderation/reopen and atomic decision/onboarding/notification intent. | Independent end-to-end acceptance; committee editing, notifications and realtime chat are not implemented. |
| Participants and tasks | **Production slice.** Independent Speaker/Moderator/Chair responses, participant workspace, availability, reusable event fields, task evidence snapshots, comments, dependencies, roster CSV and read-only organiser preview. | Custom fields have fixed types, without formulas or conditional rules; newer reminder paths need live evidence. |
| Speaker Network | **Optional competition production slice.** Organisation-scoped history, contacts, tags, segments, sourcing/imports and event outreach at `/admin/crm`. | General CRM is excluded; participant adoption is deferred and the newer organiser-created mutation lacks live acceptance. |
| Files and resources | **Production slice; partial live acceptance.** Private multipart upload, quarantine/scanner release, versioned resources, typed embeds, bounded asset/history reads, confirmed durable ZIP exports, retention and erasure. | Sustained live scan load and broader provider-side erasure; local ClamAV evidence does not prove hosted transport. |
| Schedule and content | **Production slice.** Authoritative conflicts, deterministic subset auto-placement, editorial revisions/restoration, approval gates, immutable publication, read-only published planning, breaks/resources and placement undo. | Production drag pacing and scale; publication always rechecks conflicts and content invariants. |
| Scenario Lab and readiness | **Production slices.** One ranked next action, scoped readiness, up to ten private proposals against the active draft, stale-proposal rejection and atomic bounded publication digests. | Scenarios are not independent schedule versions; newer UX/AI increments have repository acceptance only. |
| Public programme and embeds | **Production slice.** Published programme, speakers, timetable/day-by-day schedule, gallery, itineraries and calendars; configurable stateless and managed embeds with audited lifecycle. | Installation detection/analytics and XML output are absent. Private file and published-data restrictions remain enforced. |
| Confidential programme review | **Production slice; separate disclosure path.** Frozen draft snapshots, explicit disclosure confirmation, hashed expiring capabilities, revocation and publication-triggered revocation. | Does not count as published-only public programme delivery. |
| Event branding | **Production slice; schema deployed.** Revisioned draft, desktop/mobile previews, normalized image pipeline and explicit publication. | Live branding-image acceptance; custom fonts/CSS/domains and private-asset copying during cloning are absent. |
| Public event site | **Production slice; deployed with local acceptance.** Event-scoped draft/publication, six fixed homepage sections, five optional pages, sponsors and recordings; can publish CFP content before an agenda. | Programme-dependent sections require published data. Generic blocks, arbitrary HTML/CSS, media upload/processing and sponsor-asset upload are absent. |
| Communications and calendars | **Production slices; core provider lifecycle accepted.** Versioned templates, previews/confirmation, durable sends, reminders, receipts/suppression and calendar invitations. Optional schedule-change emails persist intent with publication. | Broader recipients, fresh provider-error callbacks and newer reminder/schedule-change email acceptance. No inbox, channel preferences, Slack or SMS. |
| AI and assistant | **Production slice; partial live acceptance.** Permissioned evidence, explicit provider selection, approved durable proposals, guarded tool/stream execution, assessment failure evidence and requester-owned feedback. | DeepSeek structured readiness is accepted; full tool-loop, assessment and external-provider paths remain outstanding. Feedback is not an experimentation dashboard. |
| Accelevents | **Production slice.** Confirmed preview, dry run, export/retry and immutable reconciliation CSV; exports require confirmed participants. | Live provider acceptance; dry runs do not prove writes. |
| Operations and reporting | **Production slice.** Durable progress/retry/cancel/skip, failure acknowledgement, confirmed bulk/import work, command search, saved views and two fixed relational CSV exports. | Participant readiness and Session staffing reports have a 10,000-row guard; configurable joins/fields/report definitions are absent. |
| API, audit and recovery | **Production foundation and slices.** [33-path OpenAPI](openapi.yaml), strict commands, atomic idempotency/outbox intent, immutable revisions and explicit actor/origin audit provenance. | Production access review, key-rotation/DNS acceptance, trace continuity and operational recovery objectives. |
| Public website | **Production foundation; live website acceptance.** Separate anonymous static Worker with home, privacy, terms and product guides, without application bindings or authentication. | Illustrative content is not application workflow evidence. |
| Demo and evaluation | **Demonstration only / gated production fixture.** Rich local fixture plus separately authenticated `/evaluate`, fixed identities, reset-generation fencing and scoped reset. | Fixture access and seeded portraits are not ordinary account creation, file uploads or provider success. Independent competition acceptance is incomplete. |

Cross-surface browser evidence covers responsive workspaces, owned design-system
controls, keyboard alternatives, explicit confirmation, linked validation errors,
URL-restored filters, local recovery and unsaved-edit protection. Manual
assistive-technology acceptance remains outstanding. Domain contracts and limits
are recorded in [DECISIONS.md](DECISIONS.md).

## Requirements traceability

“Connected” means repository implementation and its recorded checks, subject to
the deployment and acceptance boundaries above.

| Requirement IDs | Verified status |
| --- | --- |
| OBJ-001–006 | Connected application → evaluation → decisions → onboarding → scheduling/publication → communications/integrations workflow; replacement acceptance outstanding. |
| ADM-001–005 | Command Centre, D1/Airtable event creation, setup, invitations, organisation/event grants, switching and role matrix connected. |
| CFP-001–009 / SUB-001–007 | Versioned authoring/intake, conditional schemas, stepped layout, draft/claim/revision flows, co-speakers, direct-session intake and lifecycle administration connected. |
| EVA-001–009 | Teams, invitations, rounds, assignments, mixed rubrics, moderation, decisions and acceptance onboarding connected. |
| ABS-01/02/03/07 | Independent round configuration, reviewer pools, numeric/dropdown/free-text criteria and blind-review enforcement verified by Worker and ABS-S2/S3 browser coverage. |
| COM-001–006 | Provider/sender setup, templates, scheduled sends/reminders, receipts and calendar lifecycle connected; core Resend/Google/Microsoft live evidence below. |
| SCH-001–007 | Planning, configuration, resources, resize/unassign/undo, content snapshots, publication diff/readiness/conflicts and public/calendar reads connected. |
| DSH-001–003 | Readiness, record-aware navigation/search, operation health/progress and event-scoped realtime invalidation connected. |
| NFR-001–005 | Typed builds, indexed pagination, local performance, automated accessibility/cross-browser tests, security and recovery mechanics verified; field/scale/manual acceptance outstanding. |
| OPT-001–006 | Multi-round evaluation, advanced tasks/resources, AI, event cloning, import/export, saved views and operational UX connected within stated bounds. |
| WVD-001–003 | Accelevents export/reconciliation, versioned resources/files and responsive programme/itinerary connected; external-provider acceptance remains partial. |
| CNT-11/12/13/14 | Editorial history/restoration, approved-public-content publication boundary and private central file library/ZIP workflow connected. |
| EMB-01/04/09/12/13/14/15 | Public programme/gallery, accessible details and configurable/managed embeds connected over published data. |
| AIA-08 | Deterministic auto-placement, exact preview, selected-subset confirmation and authoritative revalidation connected. |
| TEC-001–009 | Worker/D1/R2/Queue/Workflow/DO architecture, isolation, API and operational mechanics connected; historical deployment/backup/alert evidence below does not establish RPO/RTO. |
| UX-001–010 | Search/saved views, readiness, review workspace, consequence previews, recovery, undo, AI, walkthroughs and Operation Centre connected; manual accessibility acceptance outstanding. |
| CMP-001–013 | Repository and deployed evaluator evidence exist, but a completed independent evaluation, Forge/submission/reimbursement/judging and walkthrough evidence remain external. |
| OUT-001–005 | General CRM, broad marketing automation, generic CMS, payments and multilingual expansion excluded. Speaker Network is a bounded extra-credit slice, not frozen base scope. |

## Verification evidence

These are dated records, not a blanket assertion about future working trees.
[Contributor guidance](../AGENTS.md#validation) defines the required gate for each
change. The latest complete gate supersedes older test-count histories.

| Scope | Recorded result | Limit |
| --- | --- | --- |
| `f3f0b887`, 8 September | Ordered `npm run deploy` passed the full gate in 782.4 s: 651 unit, 1,924 Worker, one Agent, 96 configuration and 14 scanner tests; types, quality, build, schema/recovery/OpenAPI, zero dependency vulnerabilities; 219 main browser, six evaluation and 16 website checks, including Firefox/WebKit smoke. Preflight/schema/health passed; no pending migrations. | Two explicit performance-measurement checks skipped. Two browser shards used after the first attempt's local server exit and scan timeout. |
| Production-health evaluator correction | Actual top-level health contract validated; 25 evaluator tests, three configurations and `check:core` passed (351.0 s). | Readiness does not prove product acceptance. |
| Form-recovery fixes | Shared load/restore choice reconciliation preserves custom fields, stable routing/conditions and revision tokens; removed choices require repair. Validation returns 400; actual revision conflicts retain 409. Toolbar stays below topbar/banner. Focused checks and the full gate passed. Deployed rename → restore → mouse/keyboard save → reload → immutable publication passed. | Bounded production workflow; not full submission/provider acceptance. |
| Follow-up Astra/high review | `codex exec review --uncommitted` reported no actionable findings. Focused tests/types/build passed, as did 25 evaluator tests, three configurations and a clean serial run of all six evaluation-browser tests. | An earlier browser run overlapped a rebuild and is invalid evidence; the serial rerun resolved it. No additional source fixes or deployment. |
| Release-gate accessibility fix | Event Setup's section anchor could falsely announce a page change after validation. Route announcements now ignore anchor-only changes. Astra/high review found no actionable issues; typecheck/build/Biome, three serial browser repeats and the full gate passed. | A concurrent review rebuild invalidated one initial browser attempt; retained separately from passing evidence. |

Latest local evidence locations:

- `.artifacts/form-recovery-evaluation-e2e.log` — add conditional field → rename
  event choices → restore → mouse/keyboard save → reload → publish.
- `.artifacts/form-recovery-browser-checks.log` — existing recovery and
  desktop/mobile/laptop form-builder visuals.
- `.artifacts/review-form-recovery/assessment.json` — review result and validation
  scope; the same directory contains the review and serial browser logs.

### Evaluation results

The [application-owned evaluator](../evals/README.md) supersedes old standalone
execution instructions. Local regression scores are not upstream acceptance.
Requested CLI model/effort receipts do not confirm a resolved provider snapshot.

| Run | Outcome | Evidence and boundary |
| --- | --- | --- |
| Local regression `2026-09-07T02-12-32` | Nine criteria, 100% score and coverage with requested Astra/medium agent and judge; 265 artifacts verified. | Mailpit capture, real ClamAV clean/EICAR scans, versioned downloads/ZIP, anonymous denial and publication. Active baseline `2026-09-07T02-29-38-534Z-67a9d91b487d-ee63187c`; self-comparison has zero drift. Not the 98-criterion upstream suite or hosted-provider acceptance. |
| Local upstream `2026-09-07T11-12-08` | Score withheld at 4.737% coverage; CFP-S1 completed, CFP-S2 blocked at applicant verification, 18 dependent scenarios blocked, 17 manual checks pending. | CLI exit 0 was completion without a coverage gate. Provisional 61.111% is not an acceptance score. Earlier `10-54-20` failed judge OAuth refresh and exhausted its setup call budget. |
| Deployed `/evaluate` `2026-09-08T01-11-18` | Score withheld at 0% coverage; CFP-S1 blocked, 19 dependent scenarios blocked, 17 manual checks pending. The explicit 60% coverage gate exited 2. | Codex collection and requested Astra judging, 240 calls/scenario and 1,200 s deadline. All 148 artifacts verified. Health matched the deployed revision above. |

The earlier recovery/save blocker is resolved: both the direct deployed smoke
and independent evaluator published successfully. Anonymous Start application
remained disabled while the harness excluded two verification frames. A separate
Playwright probe loaded those frames but received no token within 30 seconds.
[Cloudflare documents automated-browser blocking](https://developers.cloudflare.com/turnstile/troubleshooting/testing/);
observed 401 responses alone do not identify a configuration defect. Production
verification remains enforced. This is unavailable interaction evidence, not
proof of absent form capabilities. The activated applicant exposed Start
application, but CFP-S2 could not run after CFP-S1 was marked blocked. Review the
upstream permission to defer authenticated form checks before another campaign.
The evaluator also created Forward Summit 2028 with a separate empty queue and
reported a recoverable form-properties toolbar obstruction for focused follow-up.

The deployed fixture was reset before and after the authorised run. Final checks
proved the old organiser session invalid and clean applicant/reviewer baselines
with no selected persona. The direct smoke also reset its fixture on completion.
The shared fixture must not be reset while another evaluator is using it; follow
[SBEK evaluation](SBEK_EVALUATION.md) and the evaluator README.

Reports are retained under `evals/.agent-eval/runs/<run-id>/report.html`.
Deployment health/reset/session receipts are in
`.artifacts/release-85204439/`; local upstream attempts are in
`.artifacts/full-validation-20260907/`. Verified artifact roots:

- Active local regression: `5c7afb60bb4a86f5937aacdd786fe0de16ff5b0c5d798dc16517334b5b5c5415`.
- Local upstream: `86268503e077e1d7560fcf7d40b2cbb5babb7724e64995fe2b5276aef780d427`.
- Deployed upstream: `3a0405fac7a54da6f42819be14746843c3ff116644c33f7d4e12e0c46a1b828d`.

## Deployment evidence

Bounded historical acceptance must not be extended to newer code or unrelated
provider paths.

| Area | Accepted evidence | Still outstanding |
| --- | --- | --- |
| Identity and mail | Owner Turnstile/Resend magic link, delivered/bounced receipts, Google and hardened Microsoft sign-in. | Fresh email-link/Microsoft identity creation and third-party failure callbacks, broader recipients and controlled SBEK inbox evidence. |
| Calendars | Google/Microsoft connections and invitation create/update/cancel lifecycles. | Fresh provider-error exercise and any provider-requested verification; historical flagged callback follow-up. |
| Participant operations | Live preview, structured task validation/completion and draft discard/replacement under `6c811a3`; multi-role acceptance under `1ba0531` on 2 September. | Newer task/reminder behavior and positive co-participant presentation where the canonical fixture lacks such a session. |
| Files/scanner | Actual Uppy/R2 uploads, clean release, EICAR quarantine, scanner error/retry and bounded erasure; `ae6133c` corrected idle container retention and exercised shutdown. | Sustained live burst capacity and broader erasure. |
| AI | DeepSeek structured readiness through Workers AI; malformed/over-budget output failed explicitly. | Full agent tool-loop, assessments and external model providers. |
| Operations | Retained structured logs, empty Queue/DLQ inspection, scoped alert firing, one delayed owner alert email and exact private-R2 backup restore. | Autonomous post-fix backup, timely repeatable alerts, trace continuity and measured RPO/RTO. |

### Public website

The 5 September website release serves the approved six-minute film from
`d03454c5`, with matching live poster, captions, manifest and reachable guides.
A full remote download matched the approved master SHA-256
`3e750f9b8eb9c0f6989799247c5cde0247a2d2069fa7de225551ca0920911caf`.
The website's 16 desktop/mobile checks passed. Film details live in the
[video guide](../video/README.md); this is separate from application acceptance.

### Backup and restore acceptance

The corrected production backup class completed an acceptance-triggered run on
13 August in 15 seconds. Its private R2 SQL and manifest were checksum-verified
and restored into an isolated D1 database: all 93 table counts, 102 indexes and
77 triggers matched; foreign-key and whole-database integrity checks passed.
The temporary Workflow, restore database and local plaintext were removed.
SQL SHA-256: `815ce92e5f601eaf93ee11eae8644850c23da2dd8cca82e059c985ee0b6b4b40`.

Autonomous 14/15 August exports failed before the polling correction in deployed
source `5109324`. No later autonomous success is recorded. The 02:17 UTC backup
and 03:47 R2 evidence monitor still need paired acceptance; the logical export
briefly made D1 unavailable, so its low-traffic window is an operational
constraint. Alert firing and one delayed email prove a path, not timely repeatable
delivery. Do not claim the 24-hour RPO or incident RTO is met. Procedures:
[recovery](RECOVERY.md) and [deployment](DEPLOYMENT.md).

### Performance measurements

Historical **local lab** evidence from 20 August using Chromium and Miniflare;
not rerun by the latest release gate. See [PERFORMANCE.md](PERFORMANCE.md).

| Measurement | Local result | Budget |
| --- | ---: | ---: |
| Programme LCP, p75 of 5 cold navigations | 908 ms | ≤ 2,500 ms |
| Programme CLS, maximum of 5 | 0 | ≤ 0.1 |
| Programme filter feedback, p75 of 7 | 48.5 ms | ≤ 200 ms |
| Command palette usable, p95 of 7 | 37.2 ms | ≤ 100 ms |
| Event search after debounce, p95 of 7 | 13.6 ms | ≤ 300 ms |
| Warmed admin first useful heading, p95 of 20 | 68 ms | ≤ 100 ms |
| Applications first page, 10,000 records | 317.4 ms | ≤ 1,500 ms |
| Applications indexed filter, p95 of 5 | 295.7 ms | ≤ 500 ms |
| Speakers first page, 10,000 records | 280.6 ms | ≤ 1,500 ms |
| Speakers indexed filter, p95 of 5 | 335.6 ms | ≤ 500 ms |
| Event Setup mutation, p95 of 5 | 131 ms | ≤ 750 ms |
| Schedule validation mutation, p95 of 5 | 203.8 ms | ≤ 500 ms |
| Commit to visible invalidation, p95 | 901 ms | ≤ 2,000 ms |
| Form-builder local save feedback | 826 ms | ≤ 2,000 ms |

Production D1 was moved from EEUR to WNAM with Smart Placement on 13 August.
Three California probes and immutable hashed-asset caching verified locality and
cache behavior, but included a 2,320 ms edge outlier; they are not production
percentiles. Field p75 RUM, intended-geography D1/DO scale, drag pacing and Queue
acknowledgement latency remain outstanding.

## Remaining acceptance work

1. **Deployed evaluation:** resolve the anonymous security-check/dependency
   boundary without weakening production verification or claiming unobserved
   behavior. Check the reported form-properties toolbar obstruction, then repeat
   acceptance with fresh personas and an explicit coverage gate.
2. **Provider paths:** exercise Airtable authority/recovery, Accelevents live
   reconciliation, external AI/tool-loop/assessment and fresh provider-error
   callbacks. Verify newer schedule-change emails, reminder cron and controlled
   SBEK mailbox delivery. Complete historical Google callback follow-up.
3. **Operational recovery:** prove autonomous backup plus monitor, timely
   repeatable condition-specific alerts, trace continuity and incident RPO/RTO.
   Broaden scanner load and provider-side erasure acceptance.
4. **Performance and accessibility:** collect deployed RUM and representative
   scale/geography measurements; complete manual screen-reader, keyboard-only,
   contrast and zoom acceptance.
5. **Security and hosted controls:** exercise recent-authentication, provider-key
   rotation/rewrap and delivery-time DNS protections in production; complete
   penetration testing and access review. Ordinary inline-style removal and a
   browser-proven Trusted Types boundary for Scalar/intentional HTML sinks remain.
   Checked-in secret scanning, dependency audit/review and update policies do not
   prove hosted execution, branch protection or environment approvals. Browser
   recovery expires after one day and is pruned when recovery next starts.
6. **Competition evidence:** complete the independent evaluation/manual checks
   and provide Forge, submission, reimbursement/judging and recorded walkthrough
   evidence. A deployed evaluation URL exists; successful acceptance is pending.

Maintain this file as a capability/acceptance index: replace superseded evidence,
keep material blockers and link supporting artifacts. Record decisions in
`DECISIONS.md`; retain detailed implementation chronology in Git history.

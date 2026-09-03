# UX, AI and competitor research

> Delivery note (3 September 2026): this document records research hypotheses,
> not the active competition backlog. Current implementation preserves the
> evaluator guide and optional numeric AI assessment, refines the existing
> Command Centre, adds Scenario Lab lite and a deterministic publication-change
> digest, and adds only minimal AI-result feedback. Broad proof-density work,
> natural-language reporting, MCP, attendee AI and a telemetry platform remain
> deferred. Existing URL-based saved views are reused rather than replaced by a
> new saved-report framework.

**Research date:** 3 September 2026

**Scope:** Conference programme operations from call for speakers through
evaluation, participant readiness, scheduling and publication. Attendee
engagement products are included only where they reveal a relevant UX or AI
pattern.

## Executive answer

Program Cue does not need a larger chatbot. It needs a better operational work
surface and a few narrow AI capabilities built on top of its deterministic
domain model.

The product's strongest current differentiator is its safety architecture:
authorised tools, immutable inputs, exact previews, durable operations,
idempotency and commit-time revalidation. That is more defensible than generic
copy generation. The main competitive gaps are now schedule scenario planning,
flexible reporting and a clearer daily operating loop. Sessionboard already
documents the first two. Several enterprise platforms now expose event data to
external assistants through scoped MCP servers.

The numeric AI “first-pass” evaluation carries anchoring risk. Its result is
correctly kept separate from human scores, but explanations alone do not
reliably prevent overreliance on an incorrect number. For the competition it
should remain an optional organiser/chair diagnostic because the rubric
explicitly rewards it; reviewers should encounter the post-draft evidence aid
as their normal AI workflow, without the diagnostic being blended into human
scores or ranking.

The recommended sequence is:

1. Refine the existing Command Centre with one deterministic top action,
   urgency groups and an honest provider-unavailable state.
2. Add Scenario Lab lite as named private proposals over the existing
   deterministic placement and commit-time validation services.
3. Persist a deterministic digest of changes made by each schedule
   publication.
4. Reuse existing URL-based saved views for report filters; add named report
   affordances only where an existing filter/export contract supports them.
5. Add minimal AI-result feedback and focused safety fixtures, while keeping
   numeric AI optional and isolated from human scoring.
6. Validate and refine existing mobile review and handoff surfaces rather than
   opening a broad redesign.
7. Defer natural-language reporting, a generic proposal platform, MCP,
   attendee-facing AI and a product-operator telemetry dashboard until usage
   establishes a concrete need.

This is a product and heuristic UX assessment, not a moderated usability study.
Competitor availability is based primarily on first-party help and release
material; vendor outcome claims are not treated as independent evidence.

## 1. What Program Cue already gets right

Program Cue is not a static concept. The repository describes connected,
server-backed slices across forms, submissions, evaluation, onboarding,
scheduling, publication, communications, integrations, operations and a
permissioned assistant ([project overview](../README.md)). The implementation
audit still marks several live-provider, performance and manual accessibility
checks as external acceptance rather than silently calling them complete
([implementation status](IMPLEMENTATION_STATUS.md)). That distinction is a
trust advantage.

The product specification also has a strong interaction model:

- Conventional pages and visible actions remain primary; search, shortcuts and
  AI accelerate them.
- Consequential changes follow configure → preview/diff → confirm → progress →
  result/retry.
- Autosave, recovery, revision conflicts, honest undo and keyboard alternatives
  are explicit requirements.
- AI reads may run immediately, drafts remain editable, and writes use the same
  authorisation and validation as ordinary product actions.
- The assistant must cite what it inspected, distinguish records from inference
  and leave the deterministic workflow usable when the provider is unavailable.

Those principles are unusually coherent for this category. They appear in the
[competition UX requirements](../sessionboard-replacement-full-scope-implementation-specification-with-competition-ux.md#114-competition-ux-differentiators)
and [agent safety contract](../sessionboard-replacement-full-scope-implementation-specification-with-competition-ux.md#153-agentic-interface-safety-and-capability),
and the status audit records production-shaped implementations for the shared
operation and approval machinery.

The inspected visual baselines support several positive conclusions:

- The desktop review workbench keeps the queue, source and rubric in one place.
- The schedule planner exposes sessions, calendar context, versions and
  validation without hiding the published state.
- The participant dashboard leads with the next action and progress.
- Tasks/readiness offers useful filters and an operational table rather than a
  decorative dashboard.

These are heuristic observations from the repository's reviewed Playwright
captures, not evidence of first-time-user comprehension.

## 2. What good UX looks like for this product

### Organise around the event phase and the next consequential decision

Programme teams do not visit a dashboard to admire a global percentage. They
need to answer questions such as:

- Can we close the call for speakers?
- Is this evaluation round complete enough for decisions?
- Which accepted speakers need intervention this week?
- Can this schedule be published now?
- What changed since the last publication or provider run?

The default surface should therefore show the current phase, hard blockers,
time-sensitive exceptions, owners and a direct action. Aggregate readiness can
remain as secondary orientation, but it should not average away a single
publication blocker.

### Use overview → filter → detail, while preserving work context

Large submission, participant and schedule sets need an overview, fast
filtering and details on demand. The reviewer should not lose queue position,
filters or a draft after inspecting source material. The scheduler should see
the conflict impact of a proposed move before making it. This applies
[Shneiderman's overview/filter/details model](https://doi.org/10.1109/VL.1996.545307)
and the mixed-initiative
lesson from Cobi: the machine should calculate constraints while the organiser
retains a visual workspace and can understand the net conflict effect
([Cobi paper](https://doi.org/10.1145/2501988.2502034)).

### Make direct manipulation optional, never mandatory

Drag-and-drop is excellent for spatial scheduling, but every move, resize,
reorder and assignment needs an equivalent keyboard operation. Focus must
remain visible and return to a sensible location after dialogs. WCAG 2.2 adds
specific requirements for non-drag alternatives, target size, unobscured focus,
status messages and error prevention for consequential submissions
([WCAG 2.2](https://www.w3.org/TR/WCAG22/)). The existing Program Cue
schedule and dialog patterns are the right foundation; outstanding manual
assistive-technology acceptance should remain visible as an acceptance gap.

### Treat async work and interruption as normal

Email, imports, exports, calendars, provider sync, file scanning and AI all take
time or fail partially. Good UX stores intent before work starts, shows the
scope and owner, permits safe continuation elsewhere, reports record-level
failure, and offers retry only where idempotency is known. Program Cue's unified
Operation Centre is a material strength. The next step is to make each
operation easier to return to from the originating record and each failed item
actionable without reading implementation language.

### Make mobile workflows task-shaped

The participant mobile view is appropriately task-oriented. The review
workbench is harder: the phone baseline becomes a long sequence of queue,
proposal, rubric, notes and discussion. A reviewer needs a focused “current
submission” mode, sticky progress/commit actions, a section navigator and a
quick way back to the filtered queue. On the Command Centre, one urgent action
should lead; large optional-AI forms and secondary summaries should collapse.

### Add collaboration awareness, not a chat product

Concurrent organisers need to know who is viewing or editing a schedule,
whether the underlying revision changed, who owns a blocker and who must
approve a proposal. Lightweight presence, attribution, assignment, soft locks
and stale-state rebase are more valuable here than a general chat stream. This
is consistent with classic shared-workspace research: awareness of others'
activity is part of coordinating the work itself
([Dourish and Bellotti](https://doi.org/10.1145/143457.143468)).

## 3. What good AI looks like here

### Contextual and optional

The best AI entry point is next to a difficult task: compare this proposal with
this rubric, explain this conflict, draft this reminder, or turn this reporting
question into an inspectable report. A blank general assistant can remain as an
accelerator, but it should not be the product's information architecture.

Microsoft's human-AI guidelines emphasise setting expectations, showing
contextually relevant information, supporting easy invocation, dismissal and
correction, explaining why the system acted, and notifying users when behavior
changes ([Microsoft HAX guidelines](https://www.microsoft.com/en-us/research/articles/guidelines-for-human-ai-interaction-eighteen-best-practices-for-human-centered-ai-design/)).
Google's PAIR guidance similarly stresses mental models, user control,
appropriate feedback and graceful failure
([PAIR Guidebook](https://pair.withgoogle.com/guidebook-v2/chapters)).

### Deterministic truth, generative interpretation

AI should not calculate canonical readiness, eligibility, permissions,
conflicts, recipient sets or publication validity. Domain services should do
that. AI may explain, prioritise, draft or translate a user's intent into a
typed proposal. This division means the same answer remains available without
the provider and the model cannot manufacture operational truth.

### A proposal, not an invisible action

A trustworthy AI result should identify:

- the exact records and revisions inspected;
- provider, model and prompt/schema version;
- missing or excluded evidence;
- generated inference versus stored fact;
- the proposed before/after change;
- who can approve it and what cannot be undone;
- whether the proposal became stale before commit;
- the durable result, including partial failure.

For batch changes, users need accept/reject/edit per item, not merely “approve
all.” Program Cue has most of this machinery already. It should become one
consistent proposal object across contextual AI, the assistant and future
natural-language commands.

### Independent judgment before advice in high-stakes evaluation

The current chair-facing AI first pass stores an immutable numeric score and
rationale separately from human scores
([decision record](DECISIONS.md#abstract-management-decisions)). That separation
protects aggregates, but it does not remove cognitive anchoring. In a controlled
study of AI-assisted decisions, explanations did not reliably prevent
overreliance, while interventions that forced independent thought reduced it at
a usability cost ([Buçinca et al., CHI 2021](https://doi.org/10.1145/3449287)).

Program Cue already contains the better pattern in its reviewer action: after a
reviewer has an initial draft, AI can map the submission to rubric evidence and
identify gaps, but cannot score, submit or change the review
([contextual review action](../app/modules/ai/contextual-ai-actions.tsx),
[reviewer AI decision](DECISIONS.md#reviewer-ai-suggestions)). Make that the
product default. If a committee wants portfolio-level assistance, show evidence
coverage, missing information, inconsistent rationale and outliers—not a
generated acceptance proxy or ranking.

This is a risk-based recommendation, not evidence that a Program Cue user has
already been biased by the feature.

### Measured as a product system

Provider success is not product success. Before adding more AI, capture:

- offered, opened, dismissed, accepted, rejected, edited and undone proposals;
- edit distance and per-field acceptance for drafts;
- unsupported-claim and incorrect-record feedback reasons;
- permission/tool rejections and stale-proposal failures;
- time, latency and cost per completed user outcome;
- provider/model/prompt/schema version;
- disaggregated quality checks for evaluation-related assistance;
- user-reported incidents and rollback/correction outcomes.

Build representative offline test sets from consented, minimised fixtures and
known hard cases. Compare against the no-AI workflow, not only against another
model. NIST's Generative AI Profile calls for provenance, predeployment testing,
structured feedback, incident handling, red teaming and ongoing measurement
([NIST AI 600-1](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf)). Do
not present self-reported model confidence as a quality measure.

### Graceful failure with a complete manual path

If credentials are absent or a model fails, the user should still be able to
open the exact blocker cohort, use an ordinary template, inspect deterministic
conflicts or build a report through filters. The inspected Command Centre
mobile and desktop baselines give optional AI forms substantial space even when
the provider is unavailable. Preserve the honest error, but collapse the dead
control and lead with the deterministic action.

## 4. Competitor landscape

### Direct programme-management competitors

| Product              | Strongest documented UX/AI                                                                                                                                                                                                                                                                                                                    | Weakness or caveat                                                                                                                                                                                                          | Program Cue implication                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sessionboard**     | Integrated CFP, review, speaker portal and scheduling; AI creates isolated agenda drafts with ordered constraints, comparison, individual/bulk acceptance and explicit unplaced sessions. Content Remix shows original and generated fields side by side. Insights turns natural language into an explained, editable query before execution. | Insights is early access. AI-evaluation availability is documented, but claims of greater objectivity are not independently validated. The public material does not show Program Cue's transaction-time revalidation depth. | This is the closest direct comparison. Scenario scheduling and transparent reporting are now competitive gaps, while Program Cue should lead on safer commit and provenance. |
| **Sessionize**       | A comparatively simple end-to-end workflow and a reusable speaker profile/talk portfolio across events. Its platform describes three evaluation modes, scheduling, embeds and a smart task list.                                                                                                                                              | Less evidence of deep operational approval, provider and failure handling.                                                                                                                                                  | Make repeat-speaker data reusable within an organisation, with explicit consent and provenance. Do not build a public speaker marketplace.                                   |
| **Sched**            | Mature attendee agenda views, filters, personal schedules, capacity/waitlists, calendar support and offline native access.                                                                                                                                                                                                                    | CFP is a separate subsystem with manual sync; organiser/speaker mobile capability is narrower.                                                                                                                              | Program Cue's connected workflow is a differentiator; public schedule findability and low-connectivity behavior remain useful benchmarks.                                    |
| **pretalx**          | Open-source CFP → review → communication → schedule/publish workflow; scheduling includes speaker availability.                                                                                                                                                                                                                               | Public evidence emphasises functional breadth more than polished operational UX or AI.                                                                                                                                      | Open source alone is not differentiation. Program Cue must win on workflow coherence, safe operations and usability.                                                         |
| **Oxford Abstracts** | Strong abstract collection/review, reminders, multi-stage workflows, assignment and abstract-book output.                                                                                                                                                                                                                                     | Broader programme operations and agentic safety are less visible.                                                                                                                                                           | Keep exports and printable outputs practical, but do not let document production displace the core operating loop.                                                           |
| **OpenWater**        | Configurable submission/review platform; a beta field-level LLM tool can summarise, check completeness, translate or score and can parse uploaded files.                                                                                                                                                                                      | The LLM tool is explicitly best-effort; public documentation shows little granular approval or authoritative revalidation.                                                                                                  | Avoid copying a generic “run a prompt on this field” architecture. Use named, typed tasks with outcome-specific evaluation.                                                  |

Sources: [Sessionboard platform](https://www.sessionboard.com/explore-the-platform),
[AI Agenda Builder](https://learn.sessionboard.com/studio/ai-agenda-builder),
[Content Remix](https://learn.sessionboard.com/studio/remix-session-speaker-content),
[Insights](https://learn.sessionboard.com/reporting/insights-ai),
[AI evaluations](https://learn.sessionboard.com/evaluations/ai-evaluations),
[Sessionize platform overview](https://sessionize.com/playbook/platform-overview),
[Sessionize for speakers](https://sessionize.com/for-speakers),
[Sched CFP](https://support.sched.com/knowledge/callforpapers),
[Sched agenda](https://support.sched.com/knowledge/manage-event-schedule-/-agenda),
[pretalx](https://pretalx.com/p/about/),
[Oxford Abstracts](https://oxfordabstracts.com/product/abstract-management-software/),
and [OpenWater AI](https://help.getopenwater.com/en/articles/13240496-apply-ai-llms-analysis-on-your-submission-data).

There is an important commercial implication. Sessionize currently publishes a
far lower per-event entry price than the Sessionboard cost in the original
brief, while Oxford Abstracts also publishes lower prices for narrower
workflows. These products are not equivalent replacements, but they weaken a
strategy based only on “replace a US$40k tool.” Program Cue needs a positive
case: one connected operating model, strong data/control boundaries, fast
programme workflows and fewer manual handoffs—not merely lower price
([Sessionize](https://sessionize.com/), [Oxford Abstracts](https://oxfordabstracts.com/product/abstract-management-software/)).

### Adjacent enterprise and attendee products

| Pattern                               | Current evidence                                                                                                                                                                                                                                                                  | Lesson                                                                                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Event-grounded attendee assistant** | Bizzabo's Bizzy answers from event content and opted-in directory data, remains read-only and exposes aggregate question patterns. EventMobi's registration concierge documents source scope, unanswered questions and a human fallback.                                          | If Program Cue later adds public AI, constrain it to published data, show freshness/scope and unanswered-question feedback, and keep a non-AI path.                         |
| **Explainable recommendations**       | Cvent's 2026 attendee recommendations use declared interests/profile/behavior while applying visibility, capacity and fee rules, display why an item matched, and document consent/opt-out for inferred interest. Swapcard and Grip also recommend sessions, people and meetings. | “Why this” and deterministic eligibility are the minimum bar. Personalisation is crowded and outside the highest-value organiser scope.                                     |
| **Specialised agents**                | RainFocus presents configuration, concierge, growth, on-site and integration agents, but its launch material distinguishes select-client releases from previews. Cvent similarly separates available, beta and expected agents.                                                   | Do not infer availability from a marketing family page. Program Cue should ship a few complete task agents, not many named personas.                                        |
| **Governed external assistants**      | RainFocus MCP Profiles exposes per-event tools with OAuth, per-user authority, RBAC and audit. Grip launched read-only, permission-filtered MCP. Swoogo documents direct mutations under OAuth and product roles.                                                                 | External-agent access is a real 2026 direction. Read-only first is the credible sequence; later mutations should reuse Program Cue's exact proposal and confirmation model. |

Sources: [Bizzabo Bizzy](https://www.bizzabo.com/blog/bizzy-ai-attendee-copilot),
[EventMobi concierge](https://help.eventmobi.com/en/knowledge/how-to-use-the-mobi-ai-registration-concierge-analytics),
[Cvent May 2026 releases](https://release.cvent.com/eventmanagement/announcements/attendee-engagement-releases-for-may-6-2026),
[Swapcard recommendations](https://help.swapcard.com/en/articles/10021147-creating-and-managing-the-ai-recommendations-page),
[Grip MustMeet](https://support.grip.events/generating-meeting-schedules-in-the-mustmeet-platform),
[RainFocus Nexus](https://www.rainfocus.com/blog/ai-will-accelerate-human-engagement-rainfocus-nexus-debuts-at-insight-2026/),
[RainFocus MCP Profiles](https://www.rainfocus.com/company/news-press/rainfocus-launches-ai-agent-connectivity-for-event-data-with-mcp-profiles/),
[Grip MCP](https://www.grip.events/news/grip-launches-mcp), and
[Swoogo MCP](https://swoogo.events/product-updates/connect-swoogo-to-your-favorite-ai-tools-with-the-swoogo-mcp-server/).

### Converged market patterns

Across the researched products, credible current AI clusters around five
patterns:

1. Event-grounded attendee questions and discovery.
2. Schedule or meeting optimisation with human review.
3. In-context copy transformation with original/proposal comparison.
4. Natural-language analytics with an inspectable generated query.
5. OAuth- and role-scoped access from external assistants.

The strongest organiser patterns are drafts, scenarios and proposals—not a
chatbot that silently acts. Product maturity varies sharply. “Beta,” “early
access,” “select clients” and “expected later” frequently coexist with broad
AI-suite marketing.

No independent evidence was found that competitor AI improves programme
quality, fairness or return on investment. Public documentation is also sparse
on prompt-injection defense, rollback, scheduling failure rates and
transaction-time revalidation.

## 5. Prioritised improvements after repository and rubric review

The competitor findings below are product hypotheses, not proof of demand. The
current backlog uses the smallest version that fits existing domain services
and preserves rubric-visible workflows.

### P0 — protect trust and clarify operations

#### 1. Isolate numeric AI and make evidence aid the normal reviewer path

**Outcome:** Reduce anchoring risk without losing useful model assistance.

**Smallest product change:**

- Keep numeric assessment optional and organiser/chair-facing for the current
  competition rubric.
- Never blend it into human scores, ranking or an “effective score,” and do not
  expose it before a reviewer's independent judgment.
- Preserve reviewer-first cognitive forcing: the reviewer saves an initial
  draft before asking AI for rubric evidence, missing information,
  counter-evidence or suggested questions.
- For chairs, offer an evidence-coverage view after sufficient independent
  human reviews. Never calculate a combined or “effective” score.

**Acceptance signals:** AI is never the first score visible to a reviewer;
every claim links to source evidence; unsupported claims can be flagged; review
completion remains possible with no provider; time and decision changes are
compared against the no-AI workflow.

#### 2. Make the Command Centre an operational inbox

**Outcome:** A programme manager can answer “what needs me now?” in seconds.

**Smallest product change:**

- Lead with phase, blocker-aware state and one next-best action.
- Group cards into **Must resolve**, **Due soon**, **Waiting on others** and
  **Recent changes**.
- Show owner, due horizon, affected-record count, last change and direct filtered
  destination.
- Keep readiness percentage secondary and explain its denominator.
- Collapse unavailable AI. In the same card, offer the deterministic action:
  open cohort, choose template, inspect conflicts, or use filters.
- On mobile, show one primary action and a compact exception list before
  secondary dashboards and AI.

**Acceptance signals:** first-time organisers identify the top blocker and open
the affected cohort without assistance; median time to first meaningful action
falls; no screen claims “ready” while a hard blocker exists; provider absence
does not create a dead end.

#### 3. Add only the feedback and safety loop justified now

**Outcome:** Expansion decisions are based on observed user value and bounded
risk, not successful API calls.

**Smallest product change:**

- Add outcome-specific feedback: wrong record, missing evidence, factually
  wrong, unsafe action, unhelpful, and “other” with optional detail.
- Create fixture-based tests for unsupported claims, stale data, cross-event
  access, indirect prompt injection, malformed tools and provider failure.
- Retain existing provider/model attribution and durable operation evidence.
- Defer aggregate experiments, cost dashboards and an incident/review platform
  until enough real usage exists to make their questions concrete.

**Acceptance signals:** forbidden cross-event and unauthorised targets are
rejected; free-text feedback is excluded from general audit metadata; every
shown factual claim has a valid source reference; provider failure leaves the
deterministic workflow available.

### P1 — next differentiating product slices

#### 4. Build Schedule Scenario Lab lite

**Outcome:** Reduce manual schedule iteration while keeping the organiser in
control.

**Smallest product change:**

- Save named private proposals against the one active draft.
- Generate them with the existing deterministic auto-placement service.
- Show proposed changes, hard conflicts and unplaced sessions, and accept a
  selection or the complete proposal.
- Re-run authoritative conflict and revision checks at commit. Never publish as
  part of generation or acceptance.

Natural-language constraints, multiple optimisers, soft scoring and parallel
draft versions remain later hypotheses.

**Acceptance signals:** every committed placement passes existing conflict
rules; unsatisfied hard constraints are explicit; stale scenarios cannot apply;
the organiser can undo genuinely reversible moves; scenario use reduces time to
a publishable draft without increasing post-publication conflicts.

#### 5. Add publication change digests and reuse saved views

**Outcome:** Make consequential publication changes easy to inspect and let
teams return to useful deterministic report views.

**Smallest product change:**

- Persist an exact-count, bounded-highlight “changes since publication” digest
  from the existing publication preview.
- Reuse authorised URLs, filters, sorting and existing exports through the
  saved-view mechanism.
- Add a named report affordance only for a concrete view whose filters and
  export already have one deterministic contract.

Natural-language interpretation and a semantic reporting layer remain deferred.

**Acceptance signals:** digest counts match the full publication preview;
bounded highlights identify affected records without retaining prior/new body
content; saved views reproduce the same authorised filters without AI.

#### 6. Standardise proposals only when another workflow requires it

**Outcome:** Avoid divergent approval behavior without building a framework in
advance.

When a second concrete workflow needs the same proposal shape, extract only the
shared goal, scope, source revision, diff, staleness and operation-link
contract. Until then, preserve the existing durable workflow-specific
proposals.

If that need appears, batch session-title/description/tag remix, reminder
drafts and task plans are plausible first consumers. They should show original
and proposed fields side by side and save per record.

**Acceptance signals:** no proposed change disappears into chat history; every
mutation is attributable; per-item accept/reject/edit is possible; stale input
blocks application; users can return from a proposal to affected records and
from the operation result back to the proposal.

#### 7. Acceptance-test mobile review and handoffs

**Outcome:** Make real reviewing and schedule coordination practical outside a
large desktop.

**Smallest product change:**

- Verify the existing focused navigation, sticky progress and return-to-queue
  behavior at narrow widths and zoom.
- Verify existing edit attribution, pending-approval and stale-revision states;
  improve only gaps observed in the tested handoff.
- Add ownership or handoff notifications only after a concrete missed-handoff
  case is observed.

**Acceptance signals:** a reviewer can complete multiple assignments at 320 px
and 200% zoom without losing context; dialog close restores focus; concurrent
edits produce an explicit rebase/conflict rather than silent overwrite; manual
screen-reader acceptance is recorded.

### P2 — stage after the core loop is proven

#### 8. Offer read-only, event-scoped MCP

Expose only the existing authorised read tools first, with OAuth, per-user and
per-event scope, short-lived access, rate limits, audit and revocation. Return
record links and revision/freshness metadata. Evaluate prompt-injection and
cross-tenant attacks before release. Later mutations should create Program Cue
proposals for in-product approval; they should never acquire a separate direct
write authority.

This follows the more credible staged pattern documented by Grip and retains
Program Cue's stronger approval contract.

#### 9. Add an organisation-scoped speaker passport

Prefill a returning speaker's biography, links, accessibility preferences and
reusable talk information within the organisation, with explicit consent,
field-level provenance and review before copying into a new event. This answers
Sessionize's strong reusable-profile experience without creating a global
marketplace or leaking private event data.

#### 10. Consider a bounded public programme assistant only later

If evidence shows attendees cannot find relevant sessions through filters and
itineraries, add goal-based discovery over published programme data only. Show
why a session matched, enforce visibility/capacity rules, make freshness clear,
and provide one-click itinerary addition. Do not infer sensitive attributes or
use private programme data. Log unanswered topics in aggregate and provide a
normal search/filter fallback.

This is a crowded market feature and expands the current organiser-focused
scope, so it should not displace the first seven improvements.

## 6. What not to build now

- Autonomous acceptance, rejection, mass sends or publication.
- AI-generated evaluator personas or numeric rankings as a default workflow.
- A generic “ask anything” chatbot as the primary navigation or support model.
- A parallel AI permissions/write layer separate from normal domain commands.
- Attendee matchmaking, meeting optimisation, ticketing, native apps, a CRM or
  general marketing automation merely to match enterprise suites.
- Self-reported model confidence, invented citations or a silent fallback to a
  different provider/model.

These either weaken the product's trust position or expand it beyond programme
operations before the core differentiation is proven.

## 7. Suggested sequence and measurement

The sequence below is about dependency order, not a fixed staffing estimate.

| Sequence | Deliverable                                                       | Evidence to collect before proceeding                                                    |
| -------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1        | Command Centre refinement, Scenario Lab lite and publication digest | Top-action comprehension; scenario application success; publication-change usefulness   |
| 2        | Minimal AI feedback and focused safety tests                       | Feedback volume/reasons; forbidden-target rejection; deterministic fallback completion  |
| 3        | Saved report affordance over an existing filter/export, if needed  | Reuse frequency, filter correctness and time saved versus the existing view/export      |
| 4        | Deeper scenario constraints or comparisons, only if demanded       | Time to acceptable draft, unresolved constraints and manual move count                  |
| 5        | Typed/NL reporting research, only if saved views prove insufficient | Interpretation correction, unauthorised-field tests and time versus deterministic views |
| 6        | Read-only MCP threat model and controlled pilot                    | Scope violations, revocation behavior, task completion and support burden               |

For formative research, recruit the actual roles: programme lead, content chair,
reviewer, speaker coordinator and scheduler. Include a small event and a
multi-track event with overlapping speakers and real exceptions. Measure
observable task success and error recovery, not feature preference alone.

## 8. Bottom line

Program Cue's path is not to imitate every AI announcement. It should make the
programme team's daily decisions faster while keeping the product's strongest
promise: stored facts remain authoritative, every consequential change is
inspectable, and a human can understand and control what happens.

The best near-term product is therefore a clearer operational inbox, private
deterministic schedule alternatives and an inspectable publication digest. AI
should surface evidence and alternatives only where that helps a concrete
workflow. Deterministic services should calculate truth and enforce every
commit.

## Research limitations

- No authenticated competitor accounts were tested.
- No independent head-to-head usability or AI-quality study was available.
- Program Cue observations came from source, status evidence and reviewed
  browser baselines, not moderated sessions with target users.
- Competitor documentation often omits prompt-injection controls, rollback,
  conflict failure rates, fairness analysis and transaction-time revalidation.
- Features labelled beta, early access, select-client or future are identified
  as such and were not counted as generally shipped.

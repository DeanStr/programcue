<!-- Generated from sessionboard-replacement-full-scope-implementation-specification-with-competition-ux.docx by scripts/convert_docx_spec.py. -->

> Implementation progress is audited separately in [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md). Commitment and status language below is preserved from the source specification.

# Product Requirements and Implementation Specification

## Sessionboard Replacement

*Consolidated source requirements, full-scope build commitment, product decisions, architecture and acceptance criteria*

> Prepared: 8 August 2026

> Source status: Google brief body + comments, complete 9:55 video narration, and Discord clarifications

> Source snapshot: Google brief and comments rechecked on 8 August 2026

> Specification update: Competition UX differentiators and cross-surface interaction standards added 8 August 2026.

> Implementation status: All Firm, Core, Optional, Preferred, Bonus and Waived items are committed; explicitly Excluded items remain outside scope. Builder-selected competition UX requirements UX-001 through UX-010 are also committed.

Full-scope direction: The original source priorities are retained for traceability, but they no longer determine inclusion. Every non-excluded capability is planned. Delivery remains risk-sequenced: the conventional administrator UI and six firm feature groups are completed first, then optional, waived, bonus and hardening scope. Airtable is included as a selectable persistence option while Cloudflare D1 remains the recommended default.

# 1. Purpose and interpretation

This specification preserves every product and delivery requirement stated in the walkthrough, linked competition brief and active comments. It now also records the builder direction to implement every non-excluded item, resolves implementation ambiguities, and adds a build-ready product model, architecture, open-source component plan, acceptance criteria and delivery sequence.

Source-derived content: requirements and original priorities remain traceable to the Google brief, video walkthrough and Discord. Builder decisions: implementation commitments and technical choices are labelled as builder direction dated 8 August 2026 and do not claim to be additional competition requirements.

## Priority model

| Source status | Original meaning | Implementation commitment |
| --- | --- | --- |
| P0 Firm | One of the six feature groups explicitly described in the brief comments as firm. | Committed; first delivery gate and non-negotiable acceptance path. |
| P1 Core | Explicitly required or central in the video, but outside the six firm feature groups. | Committed; delivered with the complete end-to-end product. |
| P2 Optional | Explicitly optional, very optional, negotiable or best-effort. | Committed; sequenced after core risk is controlled. |
| Preferred | Strong preference or expected approach, but explicitly not a hard requirement. | Adopted unless a documented conflict would reduce product quality. |
| Permitted | Explicitly allowed implementation choice rather than a required design decision. | A specific implementation choice is selected and documented below. |
| Bonus | Awards bonus consideration; not necessary for a valid submission. | Committed for the competition build and product roadmap. |
| Waived | Struck through and explicitly waived for this competition, though completing it may impress evaluators. | Committed as differentiating scope despite the competition waiver. |
| Excluded | Explicitly unnecessary for the stated use case and not part of expected scope. | Not planned; these remain outside the stated programme-management product boundary. |
| Clarify | The sources are ambiguous, inconsistent or incomplete and require confirmation. | Resolved through builder decisions in section 8.2, subject to later source corrections. |
| Delivery | Competition submission, deadline or judging requirement rather than product behaviour. | Required for the submitted build and walkthrough. |

# 2. Product objectives and scope

| ID | Priority | Requirement | Source |
| --- | --- | --- | --- |
| OBJ-001 | P1 Core | Replace the parts of Sessionboard used to manage a conference programme and avoid the current annual cost of more than US$40,000. | Brief; video 0:38-1:26 |
| OBJ-002 | P1 Core | Support the end-to-end job: collect applications, evaluate them, accept sessions, coordinate speakers, build the programme and publish it. | Video 0:56-1:12; 7:36-8:41 |
| OBJ-003 | P1 Core | Prioritise a good-enough, useful product over exact visual or feature fidelity to Sessionboard. | Brief; video 9:04-9:24 |
| OBJ-004 | P1 Core | Concentrate on programme management. Marketing automation, general CRM and general CMS capabilities are not required. | Video 1:35-2:24 |
| OBJ-005 | Preferred<br>Adopted | Make the implementation open source and retainable by the builder. A brief comment clarifies that open source is strongly desired but not a hard disqualifying condition. | Brief body + comment; video 9:24 |
| OBJ-006 | P1 Core | Use familiar industry-standard interaction patterns and allow users to operate the product without an enterprise demo or guided sales process. | Video 1:50-1:58; 9:24 |

# 3. Active product requirements

## 3.1 Event administration

| ID | Priority | Requirement | Source |
| --- | --- | --- | --- |
| ADM-001 | P1 Core | Provide a programme dashboard that gives administrators an overview of the event and workflow. | Video 3:13-3:21 |
| ADM-002 | P1 Core | Provide settings for basic event configuration and event details. | Brief screenshot heading; video 2:33-2:53 |
| ADM-003 | P2 Optional<br>Committed | Allow additional administrators to be entered or assigned during setup. | Video 5:33-5:50 |
| ADM-004 | Resolved<br>See 8.2 | Define the exact administrator, committee, evaluator and speaker permissions; the sources identify the roles but not a complete permission model. | Derived gap |
| ADM-005 | P1 Core | Provide a conventional administrator UI as the primary operational interface and build it before any agentic interface. Most AIE evaluators are accustomed to an admin UI. | Discord clarification, 8 Aug 2026 |

## 3.2 Call-for-speakers and submission forms

### 3.2.1 Form design and submission models

| ID | Priority | Requirement | Source |
| --- | --- | --- | --- |
| SUB-001 | P0 Firm | Administrators can create custom call-for-speakers submission forms. | Brief firm feature 1, live wording verified 8 Aug 2026; video 4:29-4:53 |
| SUB-002 | P0 Firm | Forms support conditional logic so later questions or sections can depend on earlier responses. | Brief firm feature 1 |
| SUB-003 | P0 Firm | Forms route submissions by selected category. | Brief firm feature 1 |
| SUB-004 | P1 Core | A form can target abstract applications or direct session records. | Video 4:29-4:37 |
| SUB-005 | P1 Core | Speaker applications can include an abstract or video submission. | Video 3:21-3:28 |
| SUB-006 | P1 Core | Administrators can create direct sessions for speakers already guaranteed a place, such as sponsor speakers. | Video 3:28-3:35 |
| SUB-007 | P1 Core | Administrators can enter abstracts, applications or sessions manually. | Video 3:53-4:02 |
| SUB-008 | P1 Core | Configure the form welcome screen, instructions, messaging and basic content customisation. | Video 4:37-4:46 |
| SUB-009 | P1 Core | Select which submission, session and speaker fields appear on a form. | Video 4:46-5:08 |
| SUB-010 | P1 Core | Support required fields and standard field validation. | Video 5:00-5:08; 6:19 |
| SUB-011 | P1 Core | Configure minimum and maximum speaker counts. A one-speaker submission must be allowed; two must not be the default minimum. | Video 4:53; 6:46-6:52 |
| SUB-012 | P1 Core | Support multiple speakers on a submission or session. | Video 6:19-7:20 |
| SUB-013 | P1 Core | Collect speaker details including biography information. | Video 5:00; 7:20-7:30 |

### 3.2.2 Submission controls and access

| ID | Priority | Requirement | Source |
| --- | --- | --- | --- |
| SUB-014 | P1 Core | Configure a submission closing date. | Video 5:15-5:23 |
| SUB-015 | P1 Core | Configure an overall submission limit. | Video 5:23-5:33 |
| SUB-016 | P1 Core | Allow applicants to maintain multiple draft submissions. | Video 5:23-5:33 |
| SUB-017 | P1 Core | Generate a shareable public application URL that can be accessed outside the administrator's session. | Brief screenshot heading; video 5:50-6:06 |
| SUB-018 | Resolved<br>See 8.2 | Determine whether public forms are normally anonymous, login-gated, password-protected or configurable. The demonstration encountered a password but did not define the intended rule. | Video 6:06-6:19 |
| SUB-019 | P1 Core | Operate in English. Multilingual forms are not required for the current use case. | Video 5:33 |
| SUB-020 | P1 Core | Do not require payment collection as part of submission. | Video 5:15 |

## 3.3 Speaker portal and onboarding

| ID | Priority | Requirement | Source |
| --- | --- | --- | --- |
| SPK-001 | P0 Firm | Provide a self-service speaker portal. | Brief firm feature 2; video 6:52-7:20 |
| SPK-002 | P0 Firm | Speakers can view and update their biography and profile details. | Brief firm feature 2; video 7:20-7:30 |
| SPK-003 | P0 Firm | Speakers can upload and manage a headshot, presentation slides and supporting documents. | Brief firm feature 2 |
| SPK-004 | P1 Core | A signed-in submitter can see their submissions/sessions and associated speakers. | Video 6:52-7:20 |
| SPK-005 | P1 Core | A submitter can see whether each application was accepted. | Video 6:59-7:07 |
| SPK-006 | P0 Firm | Track onboarding tasks that accepted speakers must complete. | Brief firm feature 6 + screenshot; video 7:07-7:20 |
| SPK-007 | P0 Firm | Show speakers their outstanding onboarding tasks in the portal. | Brief firm feature 6 + screenshot |
| SPK-008 | P2 Optional<br>Committed | A polished post-acceptance task workflow is desirable. The video called it important and useful but also described it as optional; the brief subsequently makes the underlying task tracking firm. | Video 6:59-7:20; brief comment |

## 3.4 Speaker communications

| ID | Priority | Requirement | Source |
| --- | --- | --- | --- |
| COM-001 | P0 Firm | Support automated, templated communications to speakers. | Brief firm feature 3 |
| COM-002 | P0 Firm | Send configurable reminder messages to speakers. | Brief firm feature 3; video 5:23 |
| COM-003 | P1 Core | Send a configurable thank-you/confirmation email after submission. | Video 5:33 |
| COM-004 | P0 Firm | Send calendar invitations directly to each speaker's own calendar and support Gmail, Outlook and iCal-compatible delivery. | Brief firm feature 3 |
| COM-005 | P1 Core | Allow administrators to send direct or ad-hoc email communications to applicants and speakers. | Video 7:30-7:36 |
| COM-006 | Resolved<br>See 8.2 | Define email triggers, templates, sender identities, audit history, cancellation/update behaviour and calendar invite update semantics. | Derived gap |

## 3.5 Evaluation and acceptance

### 3.5.1 Core evaluation workflow

| ID | Priority | Requirement | Source |
| --- | --- | --- | --- |
| EVA-001 | P0 Firm | Provide submission evaluation and scoring workflows. | Brief firm feature 4 |
| EVA-002 | P1 Core | Administrators can create evaluation plans. | Video 7:36-7:53 |
| EVA-003 | P1 Core | Create conference committees or evaluator teams. | Video 7:45-7:53 |

### 3.5.1 Core evaluation workflow (continued)

| ID | Priority | Requirement | Source |
| --- | --- | --- | --- |
| EVA-004 | P1 Core | Assign submissions or sessions to selected teams/evaluators. | Video 7:45-8:02 |
| EVA-005 | P1 Core | Evaluators can view and evaluate their assigned submissions. | Video 8:02-8:10 |
| EVA-006 | P1 Core | Move evaluated submissions into an accepted or rejected decision state. | Video 8:10-8:17 |

### 3.5.2 Optional and unresolved evaluation

| ID | Priority | Requirement | Source |
| --- | --- | --- | --- |
| EVA-007 | P2 Optional<br>Committed | Support multiple evaluation rounds. | Struck-through brief text; negotiable/best-effort |
| EVA-008 | P2 Optional<br>Committed | Optionally assist reviewers with AI. The video says AI workflow fidelity is unimportant and the brief comment calls this very optional. | Brief strikethrough + comment; video 9:15 |
| EVA-009 | Resolved<br>See 8.2 | Define score scales, rubrics, reviewer conflicts, anonymity, moderation, decision authority and acceptance notification rules. | Derived gap |

## 3.6 Schedule and agenda

| ID | Priority | Requirement | Source |
| --- | --- | --- | --- |
| SCH-001 | P0 Firm | Provide drag-and-drop schedule and agenda building. | Brief firm feature 5 |
| SCH-002 | P1 Core | Add accepted sessions to the agenda. | Video 8:10-8:25 |
| SCH-003 | P0 Firm | Automatically detect scheduling conflicts across rooms and tracks. | Brief firm feature 5 |
| SCH-004 | P0 Firm | Provide list, day, week, track and room views of the programme. | Brief firm feature 5 |
| SCH-005 | P1 Core | Publish a conventional public event programme with linked session, speaker and related information. | Video 8:25-8:41 |
| SCH-006 | P1 Core | Provide a basic mechanism or code for embedding the published programme in an external website. | Video 8:17-8:33 |
| SCH-007 | Resolved<br>See 8.2 | Define session duration, room/track configuration, timezone behaviour, breaks, capacity, conflict rules and schedule publication/versioning. | Derived gap |

## 3.7 Operational dashboard

| ID | Priority | Requirement | Source |
| --- | --- | --- | --- |
| DSH-001 | P0 Firm | Provide a real-time dashboard showing which speakers still have outstanding onboarding tasks. | Brief firm feature 6 |
| DSH-002 | P1 Core | Make the dashboard useful to conference organisers monitoring speaker readiness and follow-up needs. | Brief; video 0:56-1:12 |
| DSH-003 | Resolved<br>See 8.2 | Define real-time refresh expectations, filters, task due dates, ownership, escalation rules and export needs. | Derived gap |

# 4. Non-functional requirements

| ID | Priority | Requirement | Source |
| --- | --- | --- | --- |
| NFR-001 | P1 Core | The application must feel fast and responsive. Sessionboard's slowness is repeatedly identified as a reason to replace it. | Video 3:43-4:11; 7:12-7:20; brief |
| NFR-002 | Bonus<br>Committed | Additional judging credit is available for speed and performance beyond the minimum usable experience. | Brief competition rules |
| NFR-003 | P1 Core | The product should be easy to navigate and make submission-form functionality discoverable. | Video 3:53-4:29 |
| NFR-004 | P1 Core | Exact Sessionboard visual fidelity is not required; usability and completion of the job are more important. | Brief; video 9:15 |
| NFR-005 | Resolved<br>See 8.2 | No explicit requirements are given for security, privacy, backups, availability, accessibility, observability, data retention or browser/device support. | Derived gap |

# 5. Original optional, waived and excluded classifications

Implementation interpretation: Every item in sections 5.1 and 5.2 is now committed. Their original Optional, Bonus or Waived classification is preserved solely to show what the competition sources required. Section 5.3 remains excluded because those items were explicitly described as unnecessary and would expand the product into marketing automation, CRM, general CMS, payments or multilingual scope.

## 5.1 Originally optional or best-effort - now committed

| ID | Priority | Requirement | Source |
| --- | --- | --- | --- |
| OPT-001 | P2 Optional<br>Committed | AI-assisted evaluation across multiple rounds. | Brief strikethrough + comment |
| OPT-002 | P2 Optional<br>Committed | Additional administrator assignment during form setup. | Video 5:33-5:50 |
| OPT-003 | P2 Optional<br>Committed | Higher visual and behavioural fidelity to Sessionboard than is needed to perform the job. | Video 5:43; 9:15 |
| OPT-004 | P2 Optional<br>Committed | Additional Sessionboard features outside the core programme workflow, at the builder's discretion. | Video 2:15-2:24 |
| OPT-005 | P2 Optional<br>Committed | A more elaborate speaker-facing task workflow beyond the firm capability to track and display outstanding tasks. | Video 7:07-7:20 |
| OPT-006 | Bonus<br>Committed | An agentic interface may be added as bonus scope, but it must not displace or delay the primary administrator UI. | Discord clarification, 8 Aug 2026 |

## 5.2 Originally waived for the competition - now committed

| ID | Priority | Requirement | Source |
| --- | --- | --- | --- |
| WVD-001 | Waived<br>Committed | Native one-way integration with Accelevents to eliminate manual data re-entry. | Brief strikethrough + waiver comment |
| WVD-002 | Waived<br>Committed | Resource and wiki pages inside the speaker portal, including HTML embedding of existing reference material. | Brief strikethrough + waiver comment |
| WVD-003 | Waived<br>Committed | A polished, embeddable and mobile-friendly speaker gallery and schedule itinerary for the public website. | Brief strikethrough + waiver comment |

## 5.3 Explicitly unnecessary

| ID | Priority | Requirement | Source |
| --- | --- | --- | --- |
| OUT-001 | Excluded | Marketing automation is not required for the intended use. | Video 2:06-2:24 |
| OUT-002 | Excluded | General CRM functionality is not required for the intended use. | Video 2:06-2:24 |
| OUT-003 | Excluded | A general-purpose CMS is not required beyond programme publication and embedding. | Video 2:06-2:24 |
| OUT-004 | Excluded | Payment collection is not required. | Video 5:15 |
| OUT-005 | Excluded | Languages other than English are not required. | Video 5:33 |

# 6. Competition delivery and evaluation requirements

| ID | Priority | Requirement | Source |
| --- | --- | --- | --- |
| CMP-001 | Delivery | Aim to complete the project in a weekend, while recognising the late start may require additional time. | Brief competition rules |
| CMP-002 | Delivery | Submit by Wednesday 12 August 2026 at 10:00 PM Pacific Time. | Brief competition rules |
| CMP-003 | Delivery | Complete the competition submission form when it is distributed. | Brief competition rules |
| CMP-004 | Preferred<br>Adopted | Provide an open-source repository containing the code. A comment says this is not a hard requirement, although it is listed as a submission item. | Brief body + comment |
| CMP-005 | Delivery | Provide a deployed site that evaluators can test, together with the requested walkthrough. | Brief competition rules |
| CMP-006 | Delivery | A valid, good-faith submission may request reimbursement of up to US$500 in token costs, subject to evidence and subjective validation of the attempt. | Brief competition rules |
| CMP-007 | Delivery | Existing Codex Pro or Claude Max subscription usage is eligible within the stated reimbursement approach. | Brief competition rules |
| CMP-008 | Delivery | The winning submission must pass independent evaluation by the AIE team rather than only the organiser. | Brief competition rules |
| CMP-009 | Delivery | If submissions are tied, preference goes to the product whose judgement calls make it most likely to be genuinely used or purchased. | Brief competition rules + comment |
| CMP-010 | Delivery | The winning submission receives US$10,000 cash. | Brief competition rules |
| CMP-011 | Delivery | The winner must join a walkthrough/interview call for a latent.space write-up. | Brief competition rules |
| CMP-012 | Delivery | Use the competition Discord for updates, questions and communication. | Brief |
| CMP-013 | Resolved<br>See 8.2 | The brief anticipates further Saturday and Sunday walkthroughs followed by a requirements freeze. Confirm the freeze point and whether later clarifications supersede this snapshot. | Brief |

# 7. Technology choices and committed bonus criteria

| ID | Priority | Requirement | Source |
| --- | --- | --- | --- |
| TEC-001 | Permitted<br>Selected | Use any coding agents desired. | Brief tech stack |
| TEC-002 | Permitted<br>Selected | Use any language, tools and frameworks desired. | Brief tech stack |
| TEC-003 | Bonus<br>Committed | Deployment on Cloudflare infrastructure receives mild bonus consideration. | Brief tech stack |
| TEC-004 | Bonus<br>Committed | Using Airtable for persistence/database receives bonus consideration. | Brief tech stack |
| TEC-005 | Bonus<br>Committed | Hosting the source code/site on Forge instead of GitHub receives a very small bonus. | Brief tech stack |
| TEC-006 | Bonus<br>Committed | Extra speed and performance receive bonus consideration. | Brief tech stack |
| TEC-007 | Permitted<br>Selected | The implementation may use Cloudflare workflows for scheduling and email, Resend, or another preferred provider. | Brief comment |
| TEC-008 | Bonus<br>Committed | Completing a strong submission within existing agent subscription limits is considered especially impressive but is not mandatory. | Brief comment |
| TEC-009 | Bonus<br>Committed | Providing an API receives bonus consideration. | Brief tech stack, live body verified 8 Aug 2026 |

# 8. Decisions and implementation resolutions

## 8.1 Resolved decisions

| Ref | Resolution | Source |
| --- | --- | --- |
| Q1 | Resolved: use 'call for speakers' terminology. The live brief now says 'Custom call-for-speakers submission forms.' | Live brief + prior comment, 8 Aug 2026 |
| Q13 | Resolved: a conventional administrator UI is the primary operational surface; the agentic interface is an additional, fully committed surface that calls the same authorised service layer. | Discord + builder direction, 8 Aug 2026 |
| Q14 | Resolved: all Firm, Core, Optional, Preferred, Bonus and Waived items are committed. Explicitly Excluded items remain out of scope. | Builder direction, 8 Aug 2026 |
| Q15 | Resolved: Cloudflare D1 is the recommended default persistence provider. Airtable is implemented as a selectable event-data provider and demonstrated in an Airtable-backed event so the bonus is earned without forcing a weaker default architecture. | Builder direction, 8 Aug 2026 |

## 8.2 Builder decisions resolving implementation gaps

| Ref | Decision area | Builder resolution |
| --- | --- | --- |
| Q2 | Authoritative data model | Use Organisation, Event, Person, Membership, Form, FormVersion, Submission, SubmissionSpeaker, EvaluationPlan, EvaluationRound, RubricCriterion, Assignment, Review, Decision, Session, SessionSpeaker, Room, Track, ScheduleVersion, TaskTemplate, TaskInstance, ResourcePage, CommunicationTemplate, Communication, FileAsset, IntegrationConnection, ApiCredential, Webhook and AuditEvent. Acceptance creates a linked Session while preserving the original Submission and reviews. A direct session is a Session without a Submission. |
| Q3 | Authentication and permissions | Support multi-organisation and multi-event use. Organisation owners and administrators, event administrators, committee chairs, evaluators, submitters and speakers receive server-enforced role permissions. Administrator and evaluator access is invitation-based. Participant sign-in uses email magic links with optional Google and Microsoft OAuth. A public form can be anonymous-start, password-protected or account-required, but an email must be verified before final submission. |
| Q4 | Files and media | Store private assets in Cloudflare R2 with direct signed uploads, version history and expiring downloads. Defaults: headshots JPEG/PNG/WebP up to 10 MB; slides PDF/PPT/PPTX up to 100 MB; supporting files PDF/DOC/DOCX/XLS/XLSX/ZIP up to 100 MB; video MP4/WebM up to 1 GB through multipart upload. Validate MIME and file signatures, quarantine pending scans, retain prior versions, and allow administrator-configured overrides. |
| Q5 | Evaluation | Implement configurable multi-round plans, teams, assignments, weighted rubrics, 1-5 and 1-10 scales, yes/no and free-text criteria, blinded reviewing, declared conflicts, recusal, moderation, locking/reopening and authorised final decisions. AI can summarise, identify gaps and suggest scores or questions, but it may not submit a review or decision without explicit human confirmation. |
| Q6 | Schedule | Each event has an IANA timezone; timestamps are stored in UTC and rendered in the event timezone. Configure event dates, rooms, capacities, tracks, formats, default durations, breaks and resources. Detect room, speaker and required-resource overlaps; optionally treat a track as exclusive. Draft and published schedule versions are distinct. Drag/drop and resize validate conflicts server-side and produce warnings or blockers according to event policy. |
| Q7 | Communications and calendars | Provide versioned templates, sender profiles, triggers, audience rules, previews, test sends, scheduled sends, retries, idempotency, delivery/webhook audit, transactional-versus-optional unsubscribe rules and administrator cancellation. Generate standards-compatible ICS invitations with stable UID and sequence updates. Also support optional direct Google Calendar and Microsoft 365 connections for create/update/cancel, while retaining email and downloadable iCal compatibility. |
| Q8 | Onboarding tasks | Support checklist, acknowledgement, short form, file upload, link visit and administrator-only task types. Task templates can be event-, session- or speaker-scoped, with due dates relative to acceptance or session time, dependencies, owners, evidence, reminders, escalation, comments, administrator override and statuses for not started, in progress, blocked, submitted, complete, waived and overdue. |
| Q9 | Public programme embedding | Deliver a responsive hosted programme, mobile speaker gallery, personal itinerary, iframe embed, script/widget embed, public REST/JSON API, iCal feed and static JSON/HTML export. Embeds support theme variables, event filters and safe cross-origin resizing. |
| Q10 | Tenancy and data isolation | Use multi-organisation, multi-event isolation with organisation- and event-scoped role assignments. D1 is the default provider. Event programme data can instead use the Airtable adapter; provider choice is explicit and cannot change after production data exists without running an audited migration. Authentication, secrets, integration credentials, communication outbox and audit records remain in the D1 control plane. |
| Q11 | Non-functional baseline | Target WCAG 2.2 AA; current Chrome, Edge, Firefox and Safari; responsive participant/public pages and desktop-first responsive administration. Enforce least-privilege authorisation, CSRF protection, secure cookies, rate limits, bot protection, encryption in transit/at rest, private file access, audit logs, retention/deletion workflows, backup/export, structured logs, error reporting and documented recovery. Set measurable performance budgets in section 16. |
| Q12 | Change control and freeze | Treat this document as the implementation baseline dated 8 August 2026. Later brief or Discord changes are recorded in a dated decision log with affected requirement IDs, source, impact and implementation status. A later clarification may correct a source interpretation; it does not silently remove committed builder-added scope. The external competition freeze remains controlled through that log rather than guessed here. |

# 9. Source reconciliation notes

| Topic | Reconciliation |
| --- | --- |
| Six firm groups | The brief comment says the six feature groups preceding the waived items are firm: submission forms, speaker portal, communications, evaluation/scoring, scheduling and the outstanding-task dashboard. |
| Terminology | The earlier 'call for papers' versus 'call for speakers' ambiguity is resolved: the live brief now uses 'Custom call-for-speakers submission forms.' |
| Interface priority | A Discord clarification makes a conventional administrator UI core scope and places an agentic interface in bonus scope because most AIE evaluators are accustomed to admin UIs. |
| Open source | The body and video strongly advocate open source, and a repository is listed as a deliverable, but a comment explicitly says open source is not a hard requirement. |
| AI evaluation | The brief styles the AI/multiple-round clause as struck through, a comment calls it very optional, and the video says AI workflow fidelity is unimportant. |
| Task management | The video describes the post-acceptance task experience as optional, while the brief makes speaker portal and outstanding-task dashboard capabilities firm. The consolidated requirement treats task tracking as firm and richer workflow polish as optional. |
| Public embed | The video requires a basic public agenda and embedding mechanism. The richer mobile-friendly speaker gallery/itinerary in the brief is struck through and waived; these are recorded separately. |
| Waived integrations | Accelevents integration, portal wiki/resources and the richer gallery/itinerary are waived for the competition, but a brief reply states that completing them would still be impressive. |
| Full-scope commitment | The source priorities remain unchanged for traceability, but the builder has committed every non-excluded item. Optional and waived work is therefore planned rather than merely recorded. |
| Airtable | The Airtable bonus is implemented through a selectable persistence adapter and a demonstrable Airtable-backed event. D1 remains the recommended default because the workflow is relational and transaction-heavy. |
| Agentic interface | The agentic interface is fully committed but remains secondary to the administrator UI. It uses the same domain services, permissions, validation, audit and confirmation controls as the conventional interface. |
| Excluded scope | Marketing automation, general CRM, general-purpose CMS, payments and multilingual operation remain excluded. Implementing all scope refers to Firm, Core, Optional, Preferred, Bonus and Waived items, not capabilities the source explicitly says are unnecessary. |

# 10. Original source record

Google brief: [$10,000 Kill My SaaS - Competition Brief](https://docs.google.com/document/d/1rBHJtiNKHv4i43tdf2Rm0sDEYuIcajhmAPoBKR_Az-A/edit?usp=sharing) (body, active formatting and comments rechecked 8 August 2026; current wording uses call-for-speakers and includes an API bonus).

Walkthrough: [Kill my SaaS 1 Walkthrough / Briefing/Requirements - Sessionboard](https://www.youtube.com/watch?v=vUuK4Knl7oc) (complete 9:55 narration reviewed; timestamps recorded in requirement rows).

Competition communications: [Discord channel](https://discord.gg/XYXaapF4q). Clarification recorded 8 August 2026: admin UI first; agentic interface is bonus scope. Future clarifications should be versioned against this snapshot.

# 11. Full-scope implementation commitment

This section turns the original prioritisation into a complete build commitment. No Firm, Core, Optional, Preferred, Bonus or Waived capability is intentionally omitted. Delivery gates below control sequence and risk, not whether an item will be built.

## 11.1 Scope commitment by source category

| Source category | Build treatment | Completion evidence |
| --- | --- | --- |
| P0 Firm | Required in the first end-to-end release gate. | All six firm workflow groups pass automated and walkthrough acceptance scenarios. |
| P1 Core | Required in the complete product release. | Every P1 row has working UI/API behaviour and traceable tests or demo evidence. |
| P2 Optional | Fully committed after core workflow stability. | Multiple evaluation rounds, AI review assistance, richer tasks, extra administrators and selected adjacent features work in the deployed build. |
| Preferred | Adopted. | Open-source repository and familiar self-service UX are provided. |
| Bonus | Fully committed. | Cloudflare deployment, Airtable mode, Forge hosting, API, agentic UI and performance evidence are shown. |
| Waived | Fully committed as differentiation. | Accelevents export, portal resources/wiki and polished mobile gallery/itinerary are testable. |
| Clarify | Resolved by section 8.2. | Implementation follows recorded decisions and later changes use the decision log. |
| Excluded | Not built. | No general marketing automation, CRM, general CMS, payments or non-English product expansion. |

## 11.2 Optional, waived and bonus delivery matrix

| Requirement IDs | Capability | Implementation commitment | Acceptance signal |
| --- | --- | --- | --- |
| OPT-001 / EVA-007 / EVA-008 | Multiple evaluation rounds and AI-assisted review | Configurable rounds, rubrics, assignments, moderation and human-controlled AI summaries/suggestions are available in both admin UI and API. | Create two rounds, generate an AI review aid, require evaluator confirmation, and carry the shortlisted submission into the next round. |
| OPT-002 / ADM-003 | Additional administrators | Invite and assign organisation/event administrators during setup or later, with role-specific permissions and audit history. | A second administrator accepts an invitation and performs an authorised action. |
| OPT-003 | Higher product polish and competition UX | Consistent design system, permission-aware command palette and global search, actionable readiness command centre, split-pane review, preview/diff/confirm flows, autosave and recovery, safe undo, evaluator demo mode, keyboard support, responsive portals and fast list/schedule interaction. | The walkthrough uses production-quality screens and keyboard-first acceleration; blockers lead to actions, consequential changes show previews, and interrupted edits recover without silent loss. |
| OPT-004 | Selected adjacent Sessionboard capabilities | Event cloning/templates, bulk actions, CSV import/export, saved views, tags, activity history, archive/restore, webhooks and branded portals/emails. | At least one end-to-end walkthrough demonstrates cloning, import/export, bulk action and audit history. |
| OPT-005 / SPK-008 | Elaborate speaker task workflow | Dependencies, relative due dates, reminders, evidence, comments, escalation, blockers, bulk actions and administrator overrides. | A dependent file task becomes available, is submitted, reviewed and completed; an overdue task escalates. |
| OPT-006 | Agentic interface | Event-scoped assistant with read tools and authorised write tools for status queries, form/evaluation setup, reminders, scheduling and publication. | The assistant answers a readiness question, proposes a safe action and executes it only after approval. |
| WVD-001 | Accelevents integration | Native one-way export/synchronisation for accepted speakers, sessions and published schedule, with mapping, idempotency and run history. | A changed session is exported, rerun safely and visible in integration history. |
| WVD-002 | Speaker resources and wiki | Tiptap-authored pages, categories, attachments, safe HTML/embed blocks, audience targeting and acknowledgement tasks. | A speaker reads an embedded resource and completes an acknowledgement task. |
| WVD-003 | Public gallery and itinerary | Mobile speaker gallery, session discovery, favourites, personal itinerary, filters, share links and embeddable presentation. | A visitor saves sessions on mobile and sees a conflict warning in their personal itinerary. |
| NFR-002 / TEC-006 | Performance bonus | Edge rendering/cache, query indexes, virtualised data tables where needed, optimised assets, background jobs and measured budgets. | Performance report meets section 16 budgets on representative seeded data. |
| TEC-003 | Cloudflare deployment | React Router application, Workers, D1, R2, Queues, Workflows, Durable Objects, Turnstile and observability deployed on Cloudflare. | The evaluator site and supporting services run on Cloudflare bindings. |
| TEC-004 | Airtable persistence option | Selectable Airtable event repository with batching, caching/backoff, schema validation, migration and explicit provider visibility. | A seeded event uses Airtable as authoritative programme persistence and completes the golden path. |
| TEC-005 | Forge hosting | Canonical source repository on the competition-designated Forge service; optional GitHub mirror may be read-only. | Submission links to Forge and the deployed build identifies the source revision. |
| TEC-008 | Efficient agent use | Track agent/token expenditure, prefer reusable scaffolds and avoid redundant parallel reimplementation. | Submission records the tools used and available reimbursement evidence without making cost the architecture driver. |
| TEC-009 | API bonus | Versioned REST API, OpenAPI 3.1 reference, API keys, webhooks, public programme endpoints and integration-safe idempotency. | Evaluator can open API docs and retrieve the published programme, then exercise an authenticated endpoint. |

## 11.3 Builder-selected adjacent capabilities for OPT-004

The source leaves additional Sessionboard capabilities to the builder's discretion. The following bounded set is committed because it improves real event operations without crossing into the explicitly excluded CRM, marketing automation, payment or general CMS domains:

- Event templates, event duplication and reusable form/evaluation/task/email templates.

- CSV import/export for people, submissions, sessions, rooms, tracks and task status; downloadable audit-friendly exports.

- Bulk assignment, status changes, reminders, tags, archive/restore and publication actions with confirmation and audit.

- Saved filters and views for submissions, evaluations, speakers, sessions and readiness dashboards.

- Activity timeline and immutable audit events for decisions, schedule changes, integrations, permissions and communications.

- Webhooks, API credentials, integration run history, retry controls and idempotency diagnostics.

- Event branding for public forms, participant portals, programme embeds and email templates.

## 11.4 Competition UX differentiators

The following items are builder-selected product requirements intended to turn completeness into a competition advantage. They are not claims about the original brief. The conventional sidebar, pages and visible actions remain the primary interface; search, shortcuts and AI accelerate that interface rather than replacing discoverable navigation.

| ID | Capability | Implementation requirement | Acceptance signal |
| --- | --- | --- | --- |
| UX-001 | Permission-aware global search and command palette | Provide a visible “Search or run a command…” control with Cmd/Ctrl+K. Group results into Navigate, Find records, Create, Actions, Saved views, Recent, Help and Ask assistant. Default to the current event, permit an explicit organisation-wide search, support domain aliases, and return only records/actions the signed-in user may access. Consequential actions open a preview and confirmation rather than executing from search. | From any administrator screen, an evaluator finds a speaker, opens a saved view, creates a direct session and prepares a reminder without using the mouse. A forbidden action is absent, and a bulk or destructive action cannot bypass preview/approval. |
| UX-002 | Actionable event command centre | Turn the event dashboard into an operational command centre. Show a transparent programme-readiness score, blocking conditions, overdue work, unassigned reviews, unscheduled accepted sessions, schedule conflicts, delivery/integration failures and unpublished changes. Every card drills into the exact affected records and exposes the relevant next-best action. | A readiness blocker opens the filtered records that caused it and can start a targeted reminder or repair workflow. The score explains its calculation and cannot report “ready” while a declared blocker remains. |
| UX-003 | Split-pane evaluation workbench | Provide submission queue, source detail and evaluation rubric in one workspace. Preserve filters and position; support next/previous navigation, rubric progress, conflict declaration, autosaved drafts, advisory AI summary, reviewer notes and “submit and open next”. Source material, attachments and speaker context remain visible while scoring. | An evaluator completes several assigned reviews without returning to the list, losing draft text or reopening source material. AI content is labelled and cannot submit or alter the evaluator’s score. |
| UX-004 | Universal preview, diff and confirmation | Use a shared configure → preview/diff → confirm → background progress → result/retry pattern for bulk email, decision release, schedule publication, form publication, imports, Airtable migrations, Accelevents exports, calendar updates, bulk state changes and agent-prepared actions. Show affected records, recipient counts, material changes, warnings and blockers before commitment. | Schedule publication and bulk email use the same understandable safety pattern. The evaluator can inspect changed sessions/recipients before approval and can follow progress, failures and retries afterwards. |
| UX-005 | Autosave, recovery and persistence feedback | Show Saving, Saved, Offline, Retry required and Restored draft states across submission drafts, reviews, form building, resource pages, email templates, session content and schedule notes. Use debounced idempotent saves, local recovery snapshots cleared on logout, server revision checks and an explicit conflict-resolution view instead of silent last-write-wins. | Refreshing during an unfinished review restores the draft. A transient network loss does not silently discard acknowledged edits, and a stale cross-tab edit produces a clear conflict rather than overwriting newer work. |
| UX-006 | Safe undo and irreversible-action semantics | Offer time-bounded undo for genuinely reversible changes such as schedule moves, archive/restore, tags, assignments and task completion. Do not present fake undo for messages already sent, external integration effects, released decisions or published changes; those require preview, confirmation and corrective follow-up workflows. | A schedule move and task completion can be undone from the status toast. A bulk send or released decision cannot proceed without preview/approval and is represented honestly after execution. |
| UX-007 | Contextual AI actions inside conventional workflows | Expose useful AI actions where work occurs: summarise a submission, compare it with a rubric, draft a reminder, explain a schedule conflict, propose conflict-free slots, summarise event blockers, draft a task plan, explain an integration failure and generate public session copy. Results are attributed, editable and executed through the same authorised tools, previews and approval gates as the agentic interface. | An administrator drafts a targeted reminder directly from the readiness dashboard and requests a conflict explanation from the schedule. Neither action requires opening a separate chatbot, and no consequential effect occurs without confirmation. |
| UX-008 | Environment-gated evaluator demo mode | Provide a realistic seeded conference, role switcher, reset-to-demo-state action, optional guided checklist, “What to try” links, test credentials and preconfigured D1- and Airtable-backed events. External integrations use sandbox credentials where available and clearly labelled simulations where access is unavailable. Demo-only powers are impossible in production mode. | A new evaluator can enter as administrator, reviewer, applicant or speaker; reach every judged capability without manual setup; reset the environment; and distinguish sandbox/simulated evidence from live provider behaviour. |
| UX-009 | Live preview across content workflows | Provide desktop/mobile previews for call-for-speakers forms, email templates, resource/wiki pages, session cards/details, public programme branding and calendar content. Form preview includes a test-submission mode that exercises conditional logic without creating production records; email preview supports representative merge data and test send. | The administrator verifies a conditional branch, mobile speaker view, merged email and public session card before publication or send. Test submissions remain isolated from real application data. |
| UX-010 | Unified background operation centre | Provide one operation centre for imports, exports, email batches, calendar lifecycle, file processing, Airtable migration, Accelevents runs, publication and AI jobs. Show status, initiator, scope, start/end time, progress, provider/correlation IDs, warnings, record-level failures, retry/cancel controls where safe and links back to affected records. | The evaluator starts an export and bulk reminder, continues working, then inspects both jobs in one place, retries a failed record and follows its audit trail to the originating action. |

## 11.5 Cross-surface interaction standards

These standards apply to the administrator, reviewer, applicant, speaker and public surfaces unless a role-specific exception is recorded:

- Keep primary navigation and page actions visible. The command palette is an accelerator, never the only route to a capability; its header trigger displays Cmd/Ctrl+K and “?” opens the shortcut reference.

- Provide organisation/event breadcrumbs, copyable deep links, a persistent event switcher, recent records and standard open-in-new-tab behaviour for navigable rows and cards.

- Use scoped keyboard shortcuts that are disabled while typing or using rich editors. Include keyboard alternatives for drag/drop, reorder and bulk selection.

- Use sticky table headers and bulk-action bars, column visibility/density controls, saved views and shareable filter/sort URLs without breaking browser Back/Forward behaviour.

- Show the event timezone wherever a deadline or schedule time could be ambiguous. Pair relative time with an exact, accessible timestamp on hover/focus or disclosure.

- Show upload progress, pause/retry where supported, replacement history and scan/quarantine state. Warn about likely duplicate people before creating another identity.

- Use event configuration and templates for smart defaults, while clearly showing every derived value and allowing authorised override.

- Use instructive empty states, skeletons only for initial loading, existing-content retention during refresh, optimistic feedback for low-risk mutations and inline field errors rather than toast-only validation.

- Show unpublished-change banners on forms, schedules, programme content and resources; use one controlled status vocabulary and colour-independent status treatment across surfaces.

- Respect reduced motion, preserve focus after dialogs/palettes, announce background status changes accessibly and test at 200% zoom plus keyboard-only operation.

# 12. Product model and workflow rules

## 12.1 Canonical domain model

| Entity | Purpose | Key rule |
| --- | --- | --- |
| Organisation | Top-level tenant, branding, owners, plan and default integrations. | Owns many Events and organisation memberships. |
| Event | Conference programme workspace, dates, timezone, configuration and publication state. | Scopes forms, submissions, people roles, reviews, schedule, tasks and communications. |
| Person | Canonical human identity and profile. | May be submitter, speaker, evaluator or administrator through memberships/relationships. |
| Form / FormVersion | Editable form definition and immutable published schema version. | A Submission references the exact version used; edits create a new version. |
| Submission | Applicant proposal and versioned answers. | May have multiple speakers; moves through draft, review and decision states. |
| SubmissionSpeaker | Join between a person or pending invite and a submission. | Stores presenter order, ownership/claim state and session-specific details. |
| EvaluationPlan / Round / Criterion | Review structure, sequence, teams, rubrics and policy. | Generates Assignments and Reviews; supports multiple rounds. |
| Review / Decision | Human review record and authorised programme decision. | AI content is advisory and separately attributed; final decision is audited. |
| Session | Programme item, either created directly or from an accepted submission. | Has speakers, room, track, format, duration and schedule/publication state. |
| ScheduleVersion | Draft or published arrangement of sessions and breaks. | Publication is atomic; prior versions remain available for audit/rollback. |
| TaskTemplate / TaskInstance | Reusable onboarding requirement and per-speaker/session work item. | Supports dependency, due date, evidence, reminder and override rules. |
| Communication | Rendered outbound message or calendar operation. | Tracks template version, audience, provider IDs, delivery events and retries. |
| ResourcePage | Speaker-facing wiki/resource content. | Uses rich text, attachments, safe embeds, visibility and optional acknowledgement. |
| FileAsset | Private or public versioned object metadata. | Bytes live in R2; metadata includes ownership, scan state and replacement history. |
| IntegrationConnection / Run | Credentialed external connector and execution history. | Covers Accelevents, Google Calendar, Microsoft 365, Airtable and webhooks. |
| AuditEvent | Append-only record of consequential actions. | Captures actor, time, scope, before/after summary, request and correlation IDs. |

## 12.2 Lifecycle states

| Object | States | Rule |
| --- | --- | --- |
| Submission | draft -> submitted -> withdrawn; submitted -> screening -> under_review -> shortlisted/waitlisted -> accepted/rejected | Final submit validates the immutable form version. Reopening creates a revision event rather than silently changing the submitted snapshot. |
| Review | assigned -> in_progress -> submitted -> locked; optional reopened | A submitted review is immutable until an authorised administrator explicitly reopens it. |
| Session | draft -> ready -> scheduled -> published -> cancelled/archived | Acceptance creates draft; only valid, conflict-policy-compliant sessions can publish. |
| Schedule | draft -> validation_failed/ready -> published -> superseded | Publishing creates a version and triggers public cache invalidation plus calendar updates. |
| Task | not_started -> in_progress/blocked -> submitted -> complete; waived/overdue are policy states | Dependencies and evidence requirements are enforced server-side. |
| Communication | draft -> scheduled/queued -> sending -> delivered/partially_delivered/failed/cancelled | Every send is idempotent and auditable; retries do not create duplicate messages. |
| Integration run | queued -> running -> succeeded/partially_succeeded/failed/cancelled | Each record mapping and error is visible, retryable and idempotent. |

## 12.3 Permission model

| Role | Authorised scope |
| --- | --- |
| Organisation owner | All organisation settings, events, billing/configuration, integrations, administrators and data export/deletion. |
| Organisation administrator | Manage assigned/all events according to organisation policy; cannot transfer ownership unless granted. |
| Event administrator | Manage event configuration, forms, submissions, decisions, sessions, speakers, tasks, communications, schedule, public programme and event integrations. |
| Committee chair | Manage assigned evaluation plans/rounds, teams, assignments, moderation and recommendations; final decision only when explicitly granted. |
| Evaluator | View and review assigned submissions; declare conflicts; cannot access unrelated submissions or other reviews unless moderation policy allows. |
| Submitter | Create, edit and submit own drafts; manage invited co-speakers within ownership rules; view decisions released to them. |
| Speaker | Claim identity, update own profile, manage own files/tasks, view accepted session details, resources and communications. |
| Public visitor | View published programme, speaker pages, public API/feed and manage a local or signed-in personal itinerary. |
| Agentic assistant | No independent role. It acts as the signed-in user through allow-listed tools, the same authorisation checks, preview/confirmation and complete audit. |

# 13. Technical architecture and stack

## 13.1 Architecture principles

- A modular monolith: one TypeScript codebase and one primary deployable application, with domain modules rather than microservices.

- Server-side domain services own validation, authorisation, state transitions, conflict detection and audit; every UI, API, integration and agent tool calls those services.

- Provider interfaces isolate persistence, email, calendar, AI and external integrations without creating speculative abstraction elsewhere.

- Cloudflare D1 is the recommended transactional default. Airtable is a real selectable mode, not a hard dependency or token demonstration.

- Asynchronous work is idempotent. User actions commit durable intent before queues/workflows contact external providers.

- Published programme data is versioned and aggressively cacheable; private operational data remains authorised and current.

- The administrator UI is primary. Agentic operations add speed but cannot bypass permissions, validation, previews or approval gates.

## 13.2 Recommended stack

| Area | Technology | Decision |
| --- | --- | --- |
| Application | TypeScript, React Router v8 framework mode, React, Vite, Cloudflare Vite plugin | Full-stack SSR application on Workers with route loaders/actions and resource routes. |
| Hosting | Cloudflare Workers and Workers Builds | Single deployable application with preview and production environments. |
| UI system | Tailwind CSS, shadcn/ui, Base UI/Radix primitives, Lucide icons | Open component code and accessible interaction primitives with a coherent design system. |
| Forms and validation | React Hook Form, Zod, @bpmn-io/form-js plus custom conference field extensions | Visual form authoring and conditional schemas; retain required bpmn.io watermark and keep an abstraction seam. |
| Data grids | TanStack Table and TanStack Virtual where required | Filtering, sorting, selection, grouping and large-list rendering without a heavy proprietary grid. |
| Default database | Cloudflare D1 with Drizzle ORM and migrations | Recommended relational event store and control plane. |
| Optional database | Airtable Web API adapter with schema provisioning, batching, cache/backoff and migration | Authoritative event-data provider for selected events; D1 remains control plane. |
| Authentication | Better Auth with D1, magic links, Google/Microsoft OAuth and invitation flows | Application-owned authentication with server-side role memberships. |
| Files | Cloudflare R2, Uppy, signed URLs and multipart upload | Private large-file upload without proxying bytes through the application request path. |
| Async delivery | Cloudflare Queues and Workflows | Queues for fan-out; Workflows for long-lived reminders, integration sequences and recoverable multi-step jobs. |
| Realtime | Durable Objects with WebSockets/SSE | Event-scoped readiness, schedule and collaboration updates; polling remains a fallback. |
| Email | Resend and React Email; Mailpit locally | Typed templates, batch/scheduled sends, webhooks and local inspection. |
| Calendar | ical-generator, Google Calendar API and Microsoft Graph Calendar API | Universal ICS plus optional direct OAuth-connected calendar lifecycle. |
| Scheduling UI | FullCalendar standard views plus custom dnd-kit room/track resource board | Avoids a mandatory premium scheduler while delivering list/day/week/track/room views. |
| Rich content | Tiptap OSS and sanitised embed blocks | Resources/wiki content with controlled HTML embeds. |
| Agentic UI | Cloudflare Agents SDK with Durable Objects and model-provider abstraction | Stateful event assistant, tool calling, approvals, streaming and audit. |
| AI providers | Workers AI plus configurable OpenAI/Anthropic-compatible providers | Provider choice per organisation; no model-specific domain logic. |
| API | React Router resource routes, Zod schemas, OpenAPI 3.1 and Scalar API reference | Versioned REST API in the same Worker rather than a separate backend. |
| External integration | Accelevents REST API connector | One-way accepted speaker/session/schedule sync with mapping and run history. |
| Testing | Vitest, Cloudflare Vitest integration, Playwright, MSW and Mailpit | Domain, Worker integration, browser and provider-contract coverage. |
| Observability | Workers logs/traces, OpenTelemetry-compatible correlation and optional Sentry export | Structured errors, job/integration traces and user-visible operation IDs. |
| Command, search and guided UX | shadcn/ui Command + cmdk, react-hotkeys-hook, Sonner and Driver.js | Permission-aware palette/global search, scoped keyboard shortcuts, status/undo toasts and optional evaluator guidance. Visible navigation and domain validation remain primary. |
| Interaction state and recovery | React Router fetchers, IndexedDB, BroadcastChannel and server revision tokens | Pending/optimistic UI, debounced autosave, local draft recovery and cross-tab conflict detection without introducing a second client-side source of truth. |

## 13.3 Persistence provider architecture

Airtable is included without making every customer accept its limitations. The application separates a D1 control plane from an event-data repository:

- D1 control plane (always): organisations, authentication, memberships, provider selection, secrets metadata, API credentials, outbox, workflow state, integration runs and audit events.

- D1 event repository (default): all event programme entities live in relational D1 tables and participate in transactional state changes.

- Airtable event repository (optional): event forms, submissions, people programme records, reviews, sessions, schedule and tasks are mapped to managed Airtable tables. Writes use batching, upsert keys, queueing and exponential backoff; read-heavy screens use short-lived caching and explicit freshness indicators.

- Provider selection is visible at event creation. Switching an event with data requires a validated migration, reconciliation report and administrator confirmation; there is no transparent dual-write mode.

- The competition demo includes one D1-backed event and one Airtable-backed event, proving the same end-to-end service contract on both providers.

## 13.4 Runtime topology

| Surface | Calls | Back-end responsibility |
| --- | --- | --- |
| Admin, reviewer, submitter and speaker web UI | React Router loaders/actions and API resource routes | Authenticate, authorise, validate, execute domain service, audit, invalidate caches and enqueue side effects. |
| Public programme, gallery, itinerary and embeds | SSR routes, public API, iCal and static export | Read only the current published ScheduleVersion; cache at the edge with event-version cache keys. |
| Agentic interface | Cloudflare Agent tools | Resolve the signed-in user and event, call allow-listed domain commands, present preview, require confirmation, then audit. |
| Communication and reminders | D1 outbox -> Queue -> Workflow/Resend/calendar providers | Idempotent delivery, retry, webhook reconciliation and visible failure handling. |
| Uploads | Browser -> signed R2/multipart URL -> completion callback | Validate requested asset, confirm object metadata, scan/quarantine, create FileAsset version and release access. |
| Realtime dashboards | Durable Object WebSocket/SSE channel | Broadcast event-scoped change summaries after durable database commit; clients re-fetch authorised data. |
| External integrations | Workflow -> provider adapter | Transform, map, send, reconcile, record provider IDs and expose retryable per-record errors. |

# 14. Off-the-shelf open-source components

The goal is to reuse mature building blocks for generic interaction problems while retaining the conference workflow, permissions, state machines and provider contracts as product-owned code.

| Component | Purpose | Decision | Constraint / use |
| --- | --- | --- | --- |
| shadcn/ui + Base UI/Radix | Admin and portal components | Use immediately | Accessible primitives and owned component source; enforce one product design system. |
| TanStack Table / Virtual | Operational data grids | Use immediately | Headless sorting/filtering/grouping/selection; virtualise only demonstrably large lists. |
| React Hook Form + Zod | Forms and validation | Use immediately | Shared client/server schemas; do not rely on client validation for authorisation or state changes. |
| @bpmn-io/form-js | Visual form editor and renderer | Use with constraint | Accelerates schema authoring and conditions. The bpmn.io watermark must remain visible; wrap it behind a product schema adapter so it can be replaced later. |
| Drizzle ORM | D1 schema, typed queries and migrations | Use immediately | Keep critical complex queries explicit and indexed; avoid leaking ORM records across domain boundaries. |
| Better Auth | Authentication and sessions | Use immediately | Use application tables for event permissions; track upstream security releases. |
| Uppy | Large and resumable uploads | Use immediately | Connect directly to R2/S3-compatible signed endpoints; retain server-side completion validation. |
| FullCalendar standard | List/day/week schedule views | Use immediately | Standard edition supplies drag/resize and calendar views. Resource timeline is premium, so room/track view is product-owned with dnd-kit. |
| dnd-kit | Custom room/track scheduling and ordering | Use immediately | Use keyboard sensors and server-side conflict validation. |
| Tiptap OSS | Resource/wiki editor | Use immediately | MIT open-source core; allow-list nodes and sanitise rendered embeds. |
| React Email | Transactional and reminder templates | Use immediately | Preview and test templates in-repo; store versioned rendered inputs and provider metadata. |
| ical-generator | ICS invitations and feeds | Use immediately | Use REQUEST/CANCEL methods, stable UIDs, sequence increments and event timezone components. |
| Cloudflare Agents SDK | Agentic interface | Use immediately for bonus surface | Limit tools to domain commands; require confirmations and audit consequential actions. |
| Scalar API Reference | OpenAPI documentation | Use immediately | Serve generated OpenAPI 3.1 in the application; version public and private endpoints. |
| Papa Parse / ExcelJS | CSV/XLSX import and export | Use selectively | Run schema mapping and validation previews before committing imports. |
| PDF.js | PDF slide/document preview | Use selectively | Preview supported files without making conversion a prerequisite for download. |
| Mailpit | Local email testing | Use immediately in development | Capture messages and calendar attachments without sending externally. |
| MSW | Provider and browser API mocks | Use immediately in tests | Create contract fixtures for Resend, Airtable, calendars and Accelevents. |
| ClamAV or managed scanner adapter | Malware scanning | Production hardening | Workers cannot assume a local daemon; keep scanning provider-pluggable and quarantine files until a result is recorded. |
| cmdk / shadcn Command | Command palette and grouped search/actions | Use immediately | Visible Cmd/Ctrl+K trigger; results are event-scoped and permission-filtered; consequential commands open product-owned previews. |
| react-hotkeys-hook | Scoped keyboard shortcuts | Use immediately | Disable shortcuts in text/rich-editor contexts, support discoverable scopes and test every shortcut with keyboard and screen reader focus. |
| Sonner | Status, progress and reversible-action toasts | Use immediately | Use for concise feedback and genuine undo only; errors still appear at the affected field/record and consequential actions require preview. |
| Driver.js | Optional evaluator tour and contextual highlights | Use selectively | Never block exploration or replace the seeded checklist; load only in demo/onboarding contexts and respect reduced motion. |

## 14.1 Deliberate non-selections

- No microservice split, separate GraphQL server or general workflow engine for the initial product; Cloudflare Queues/Workflows and domain state machines are sufficient.

- No Airtable-only default. It remains a supported mode and competition differentiator, not the architecture imposed on every event.

- No mandatory FullCalendar Premium dependency. Standard views plus the custom room/track board satisfy the product while preserving open-source portability.

- No command-palette-only information architecture. Every capability remains reachable through visible conventional navigation and contextual controls; the palette, shortcuts and agent are accelerators.

- No autonomous acceptance, rejection, mass email or schedule publication. AI and agents can prepare and recommend, but consequential actions require an authorised human approval.

- No general CMS, CRM, marketing automation, payment or translation platform hidden inside the programme product.

# 15. API, integrations and agentic surface

## 15.1 REST API contract

| Audience | Endpoint families | Contract |
| --- | --- | --- |
| Public | GET /api/v1/public/events/{slug}; /programme; /sessions; /speakers; /schedule; /calendar.ics | Published data only, cacheable, filterable and paginated where applicable. |
| Participant | GET/PATCH own profile, submissions, sessions, files and tasks; submit/withdraw actions | Magic-link/OAuth session; ownership and event membership enforced. |
| Evaluation | Plans, rounds, assignments, reviews, conflicts and moderation actions | Evaluator/team permissions and lock/reopen rules enforced. |
| Administration | Events, forms/versions, people, decisions, sessions, schedule versions, tasks, communications, resources and publication | Organisation/event RBAC, idempotency keys on consequential commands and audit events. |
| Integrations | Connections, mappings, runs, retries, Accelevents export and calendar sync | Encrypted credentials, least scopes, per-run correlation and record-level errors. |
| Webhooks | submission.*, review.*, decision.*, speaker.*, task.*, session.*, schedule.*, communication.* | Signed payloads, replay protection, delivery attempts, disable/re-enable and test event. |

- OpenAPI 3.1 is generated from Zod-backed schemas and served with an interactive Scalar reference.

- Use /api/v1, cursor pagination, RFC 3339 timestamps, IANA timezone identifiers, structured error codes and request/correlation IDs.

- API keys are organisation-scoped, hashed at rest, permission-limited, expirable and auditable. Browser sessions use CSRF-protected cookie authentication.

- Create/update endpoints accept idempotency keys where retries could duplicate a decision, send, export, task or schedule publication.

## 15.2 Accelevents integration

1. Administrator connects an Accelevents account/API credential and selects a target event.

2. A mapping preview matches local speaker, session, room, track and schedule fields to Accelevents objects.

3. Only accepted/published records are eligible; the administrator can run a dry-run diff before export.

4. The Workflow creates or updates records using stable external IDs, records provider identifiers and treats reruns as idempotent.

5. Partial failures show record-level error, retry and skip controls; a completed run produces a downloadable reconciliation report.

## 15.3 Agentic interface safety and capability

| Tool class | Examples | Guardrail |
| --- | --- | --- |
| Read tools | Summarise event health, find incomplete speakers, explain review progress, detect schedule issues, search submissions/sessions/resources and inspect integration failures. | May execute immediately within the signed-in user's read scope. |
| Draft tools | Draft forms, rubrics, task plans, email templates, resource pages, schedules and decisions. | Creates an editable preview; does not publish or send. |
| Write tools | Create/update records, assign reviewers, complete bulk tagging, schedule sessions, start integration runs and send reminders. | Must pass domain validation and normal permission checks; consequential bulk/destructive actions require explicit confirmation. |
| AI review tools | Summarise submissions, compare against rubric, highlight missing evidence, suggest questions or score rationale. | Advisory only; output is visibly AI-generated and cannot become a submitted review without evaluator action. |
| Audit | Store user instruction, tool name, validated arguments, preview, approval, result and correlation ID. | Sensitive message content is minimised according to retention policy. |

The same agent tools are exposed through three discoverable entry points: the dedicated event assistant, the command palette’s Ask assistant group, and contextual actions on submissions, dashboards, schedules, communications and integration errors. All entry points resolve to the same permissions, domain commands, previews, approval gates and audit records.

- The assistant must explain what it inspected, distinguish source data from generated inference, link to affected records and degrade to deterministic UI/API workflows when a model or provider is unavailable.

# 16. Non-functional requirements and measurable budgets

## 16.1 Performance

| Area | Budget | Method |
| --- | --- | --- |
| Public programme | LCP <= 2.5 s at p75 on a representative mobile connection; CLS <= 0.1; INP <= 200 ms. | SSR published version, edge cache, optimised images, limited client JavaScript. |
| Admin navigation | Cached route transition feedback <= 100 ms; ordinary server mutations p95 <= 750 ms excluding external providers. | Indexed queries, optimistic pending states, minimal payloads and deferred background work. |
| Operational lists | First useful page <= 1.5 s for 10,000 submissions/speakers; filtering response <= 500 ms for indexed filters. | Server pagination, saved query definitions and virtualisation only where needed. |
| Schedule interaction | Drag feedback at 60 fps on supported desktop browsers; validation response <= 500 ms for typical event size. | Client preview plus authoritative indexed conflict check; no full schedule reload. |
| Dashboard freshness | Committed changes visible to connected clients within 2 s; fallback refresh <= 30 s. | Durable Object event channel and re-fetch-on-change. |
| Background work | User request returns after durable intent is stored, not after email/calendar/integration completion. | Outbox, Queue and Workflow with status UI. |
| Command palette and global search | Palette opens with usable local actions <= 100 ms; event-record results p95 <= 300 ms after debounce for representative data; keyboard selection remains responsive. | Pre-index local navigation/actions, query an indexed event-scoped search endpoint, bound/group results and defer nonessential previews. |
| Autosave and recovery | Save state appears within 2 s after edit idle; an acknowledged edit is not silently lost during refresh, cross-tab use or a transient disconnect. | Debounced idempotent mutations, local recovery snapshots, revision tokens, explicit conflict UI and recovery-state tests. |

## 16.2 Security, privacy, reliability and accessibility

- Server-enforced tenant and event authorisation on every private loader, action, API endpoint, file grant, integration and agent tool.

- Secure, HttpOnly, SameSite cookies; CSRF protection; secret rotation; OAuth state/PKCE; rate limiting; Turnstile on abuse-prone public flows; generic authentication responses.

- Private R2 objects, short-lived signed access, random keys, file-signature validation, quarantine/scan state and no public bucket for participant uploads.

- Append-only audit for permissions, decisions, publication, bulk changes, communications, calendar lifecycle, integrations and agent actions.

- Data export, correction, retention, deletion and legal-hold controls; configurable event retention with safe participant anonymisation after the retention period.

- D1 recovery/time-travel plus scheduled logical exports; Airtable mode receives provider export and reconciliation. Recovery procedures are tested, not merely documented.

- Structured logs, correlation IDs, Workers observability, failed-job dashboards, Resend/calendar/integration webhook reconciliation and user-visible retry paths.

- WCAG 2.2 AA target, semantic headings/tables/forms, keyboard-complete scheduling alternatives, focus management, labelled errors, colour-independent status and reduced-motion support.

- Current Chrome, Edge, Firefox and Safari; responsive public and participant surfaces; administrator UI supports common laptop widths and retains usable tablet workflows.

## 16.3 Quality gates

| Gate | Required evidence |
| --- | --- |
| Unit/domain | State transitions, role decisions, form versioning, evaluation calculations, schedule conflicts, task dependencies, calendar sequence and repository contracts. |
| Worker integration | D1 and Airtable repository suites; queues/workflows; R2 grants; auth; API idempotency; webhook signatures and provider reconciliation. |
| Browser E2E | Golden path plus direct session, multi-round review, speaker claim, task evidence, calendar update, publish/embed, Airtable event, Accelevents dry-run/export and agent approval. Include command-palette navigation, actionable dashboard drill-down, split-pane review, preview/confirm, autosave recovery, demo reset and background-operation retry. |
| Accessibility | Automated checks plus manual keyboard, focus, screen-reader labels, schedule alternative and colour/zoom review. Verify palette focus restoration, shortcut scoping, live-region job updates and keyboard alternatives for every pointer interaction. |
| Performance | Seeded representative event measured in preview/production with stored Lighthouse/Web Vitals and endpoint timing report. |
| Security | Dependency/secret scans, authz regression suite, public-form abuse tests, upload validation, webhook replay and agent tool permission tests. |
| Competition UX | UX-001 through UX-010 pass their acceptance signals on seeded representative data. A first-time evaluator completes the guided golden path without hidden setup or unsupported demo-only production powers. |

# 17. End-to-end acceptance criteria

| Area | Definition of done |
| --- | --- |
| Event administration and roles | Create an organisation and event; invite a second administrator, committee chair and evaluators; verify each role sees only authorised actions; clone the event from a template and view audit history. |
| Call-for-speakers forms | Build and publish a versioned form with required fields, conditional section, category routing, speaker min/max, branding, close date, submission limit and configurable anonymous/password/account access. Submit against v1, publish v2 and prove v1 remains readable. |
| Applicant and co-speaker flow | Applicant signs in, maintains multiple drafts, submits abstract/video, invites a co-speaker, and the co-speaker claims and edits their own profile without losing the submission relationship. |
| Direct sessions and import | Administrator manually creates a guaranteed session and imports additional records from CSV with preview, validation and reconciliation. |
| Evaluation | Create teams, two rounds, weighted rubric, conflicts and assignments. Evaluator submits review; AI provides advisory summary; chair moderates; authorised admin accepts, rejects or waitlists and releases notifications. Complete assigned work in the split-pane workbench with autosave, preserved queue context and submit-and-open-next. |
| Acceptance and onboarding | Accepted submission creates a linked session, speaker records and dependent task plan. Speaker uploads headshot/slides/supporting document, completes acknowledgement/form tasks, receives reminders and sees clear status. |
| Communications and calendar | Preview/test/send confirmation, decision, ad-hoc and reminder templates. Delivery events are visible. ICS works; connected Google and Microsoft calendars receive create/update/cancel without duplicates. |
| Scheduling | Drag accepted and direct sessions into list/day/week/track/room views. Room and speaker conflicts are blocked/warned according to policy. Publish a version, move a session, republish and preserve history. |
| Realtime readiness dashboard | Two connected administrators see task completion update within two seconds. The actionable command centre explains readiness, exposes exact blockers, supports filters/owners/due dates/escalation/saved views/export and starts targeted follow-up from the affected cohort. |
| Public programme | Published programme exposes linked session/speaker pages, mobile gallery, filters, favourites/personal itinerary, conflict warning, iframe, script embed, JSON API, iCal and static export. |
| Resources/wiki | Administrator publishes a targeted Tiptap resource page with attachment and safe embed; speaker views it and completes an acknowledgement task. |
| Airtable option | Create an Airtable-backed event and complete form, submission, evaluation, acceptance, task and schedule operations. UI identifies provider; retries/backoff and migration preview are testable. |
| Accelevents | Connect sandbox/test account, preview mapping/diff, export accepted speakers/sessions/schedule, update one record and rerun idempotently with a reconciliation report. |
| API and webhooks | Interactive OpenAPI docs load. Public programme endpoint works. Scoped API key performs an allowed operation and is denied another. Signed webhook delivery and retry history are visible. |
| Agentic interface | Ask for incomplete speakers, generate a reminder plan, preview recipients/content, approve send and inspect audit. Repeat a useful AI action contextually from the dashboard or schedule and through the command palette. Attempt an unauthorised or destructive command and verify refusal/confirmation. |
| Non-functional | Performance, accessibility, authz, backup/recovery, upload and observability evidence meets section 16 and is included in the submission artefacts. |
| Competition UX and evaluator experience | Cmd/Ctrl+K opens permission-aware search/actions; the dashboard drives the next action; review is completed in split-pane; forms/emails/public content have live preview; drafts recover after refresh/disconnect; reversible changes expose honest undo; background work has one status centre; demo role switching and reset work without granting production-only powers. |

# 18. Delivery sequence and release gates

All committed scope remains in the plan. The sequence below minimises the chance that bonus work destabilises the six firm workflows.

| Gate | Scope | Exit condition |
| --- | --- | --- |
| Gate 0 - Foundation | Repository/CI, Cloudflare environments, design system, D1 schema, repository interfaces, Better Auth, organisations/events/RBAC, audit, R2 upload skeleton and seeded demo data. | Roles and isolation pass; application deploys reproducibly. |
| Gate 1 - Six firm groups | Custom forms/conditional routing; speaker portal/files/tasks; communications/reminders/calendar; evaluation/scoring; drag/drop schedule/conflicts/views; realtime readiness dashboard. | Complete D1-backed golden path passes in Playwright and walkthrough. |
| Gate 2 - Complete core product | Direct sessions, drafts, co-speaker claim, public programme/embed, event setup, committees, decision notifications, rich task workflow and production states. | All P1 rows have acceptance evidence. |
| Gate 3 - Optional and waived | Multiple rounds, AI assistance, event admin expansion, adjacent operational features, Accelevents, resources/wiki, polished gallery and personal itinerary. | All P2 and WVD rows demonstrated. |
| Gate 4 - Competition UX differentiation | Actionable command centre, split-pane review, preview/diff/confirm, command palette/global search, autosave/recovery, safe undo, contextual AI, evaluator demo mode, live previews and unified operation centre. | UX-001 through UX-010 pass acceptance and the seeded evaluator walkthrough can be completed without manual setup. |
| Gate 5 - Bonuses | Airtable event mode, Forge canonical hosting, API/OpenAPI/webhooks, agentic interface and performance optimisation/report. | Every Bonus row has explicit submission evidence. |
| Gate 6 - Hardening and submission | Accessibility, security, recovery, provider failure paths, browser/device checks, performance budgets, documentation, test credentials and walkthrough. | Deployed evaluator site is stable; submission traceability matrix is complete. |

Within Gate 4, implement in this order: actionable command centre; split-pane review; shared preview/diff/confirm; command palette/global search; autosave/recovery; evaluator demo mode; contextual AI; unified operation centre; undo/micro-interaction polish; optional guided tour. This order prioritises domain value over novelty.

## 18.1 Walkthrough narrative

1. Land in evaluator demo mode, select the administrator role, review the guided checklist and open the actionable event command centre.

2. Use Cmd/Ctrl+K to create a branded event, invite a second administrator/evaluation team and jump to the form builder.

3. Build and live-preview a conditional call-for-speakers form; publish it, show the public link and demonstrate form versioning.

4. Switch to applicant/co-speaker roles, submit with a co-speaker, recover an autosaved draft and upload an optional video.

5. Review in the split-pane workbench, run two rounds with clearly advisory AI assistance and accept the proposal after previewing the decision effect.

6. Complete speaker profile, resource acknowledgement, dependent onboarding tasks and file uploads; show progress, scan state and a truthful undo for a reversible task action.

7. Return to the command centre, open the exact not-ready cohort, draft a contextual AI reminder, preview recipients/content and approve the send.

8. Send and update calendar invitations, then inspect email/calendar progress, provider IDs, failures and retry state in the unified operation centre.

9. Schedule the session with drag/drop and keyboard alternatives, explain a conflict contextually, publish through the shared diff/confirm flow and show realtime readiness.

10. Open the public gallery, personal itinerary, iframe/script embed, JSON API, calendar feed and mobile previews.

11. Export to Accelevents, inspect the idempotent reconciliation report, then switch to the seeded Airtable-backed event and show the same workflow contract.

12. Use the dedicated agentic interface and the palette’s Ask assistant group for a safe read/action flow, then demonstrate a refused unauthorised command.

13. Reset the evaluator demo, show performance/accessibility evidence, Forge source and the deployed Cloudflare architecture.

# 19. Risks, constraints and mitigations

| Risk | Issue | Mitigation |
| --- | --- | --- |
| Full-scope deadline | The committed scope is much larger than the original weekend framing. | Use release gates, one modular monolith, seeded demo fixtures and vertical golden paths. Do not build parallel architectures or polish bonus screens before Gate 1 passes. |
| Airtable limits and consistency | Rate limits, weaker transactions and schema drift can make it a poor universal default. | Selectable provider, batches/upserts, queue/backoff, short cache, schema validator, reconciliation and D1 default. No dual-write illusion. |
| form-js licence/watermark | The watermark must stay visible and may be undesirable in a long-term commercial product. | Use it for speed with visible attribution; keep a normalised form schema and renderer adapter so a later custom editor can replace it. |
| Scheduling component licence | FullCalendar resource timeline is premium. | Use MIT standard views and a custom dnd-kit room/track grid; do not accidentally import premium packages. |
| Direct calendar OAuth | Google/Microsoft consent, token refresh and update/cancel semantics add external failure modes. | Keep ICS as universal baseline; isolate provider adapters, use least scopes, encrypted tokens, stable local/external IDs and reconciliation UI. |
| Accelevents access | API credentials, sandbox behaviour or object mappings may differ by account. | Build against official API, support dry-run/diff, keep mapping configurable and show clear blocked status when credentials are unavailable. |
| AI safety and cost | Hallucinated recommendations or excessive context could harm decisions and budget. | Advisory outputs, constrained event data retrieval, provider/cost limits, model attribution, confirmation and deterministic domain validation. |
| Realtime complexity | WebSockets can become a second source of truth. | Database remains authoritative. Durable Objects broadcast invalidation/change summaries; clients re-fetch authorised state and polling is a fallback. |
| Large video/files | Upload size, unreliable connections and malware risk. | Direct multipart R2 upload, resumability, type/signature validation, quarantine, scanning adapter and administrator-configurable limits. |
| Forge ambiguity/access | The competition-designated Forge service or repository workflow may require credentials/configuration. | Create canonical repository as soon as access is available, record exact service in DECISIONS.md and retain an export/mirror so delivery is not blocked. |
| Scope creep from OPT-004 | "Additional Sessionboard features" is inherently unbounded. | Commit only the explicit bounded list in section 11.3; additional ideas enter a later roadmap, not this definition of done. |
| Hidden-power UX | A command palette, shortcuts or agent can look impressive while making ordinary navigation harder to discover. | Keep conventional navigation and contextual controls complete, show the palette trigger visibly, provide a shortcut guide and test the product with first-time users who never open the palette. |
| Autosave conflicts and false confidence | A “Saved” indicator can mislead users if cross-tab edits, stale revisions or provider failures overwrite content. | Acknowledge only durable saves, use revision tokens and idempotency, retain local recovery snapshots, show offline/retry/conflict states and never silently resolve material conflicts. |

# 20. Technical references

These official or primary references support the implementation choices. They are technical guidance, not additional competition requirements. Accessed 8 August 2026.

| Reference | Official / primary URL |
| --- | --- |
| Cloudflare React Router v8 on Workers | [https://developers.cloudflare.com/workers/framework-guides/web-apps/react-router/](https://developers.cloudflare.com/workers/framework-guides/web-apps/react-router/) |
| Cloudflare D1 | [https://developers.cloudflare.com/d1/](https://developers.cloudflare.com/d1/) |
| Cloudflare R2 presigned URLs | [https://developers.cloudflare.com/r2/api/s3/presigned-urls/](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) |
| Cloudflare Workflows | [https://developers.cloudflare.com/workflows/](https://developers.cloudflare.com/workflows/) |
| Cloudflare Durable Objects | [https://developers.cloudflare.com/durable-objects/](https://developers.cloudflare.com/durable-objects/) |
| Cloudflare Agents SDK | [https://developers.cloudflare.com/agents/runtime/agents-api/](https://developers.cloudflare.com/agents/runtime/agents-api/) |
| Better Auth D1 support | [https://better-auth.com/blog/1-5](https://better-auth.com/blog/1-5) |
| Drizzle ORM with Cloudflare D1 | [https://orm.drizzle.team/docs/sqlite/connect-cloudflare-d1](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-d1) |
| bpmn.io form-js | [https://github.com/bpmn-io/form-js](https://github.com/bpmn-io/form-js) |
| bpmn.io licence and watermark condition | [https://bpmn.io/license/](https://bpmn.io/license/) |
| FullCalendar documentation | [https://fullcalendar.io/docs](https://fullcalendar.io/docs) |
| FullCalendar resource timeline premium status | [https://fullcalendar.io/docs/timeline-view](https://fullcalendar.io/docs/timeline-view) |
| Uppy open-source uploader | [https://uppy.io/](https://uppy.io/) |
| Tiptap open-source editor | [https://tiptap.dev/open-source-to-platform](https://tiptap.dev/open-source-to-platform) |
| Airtable API call limits | [https://support.airtable.com/docs/managing-api-call-limits-in-airtable](https://support.airtable.com/docs/managing-api-call-limits-in-airtable) |
| Accelevents API | [https://developer.accelevents.com/docs/accelevents-api-documentation](https://developer.accelevents.com/docs/accelevents-api-documentation) |
| Google Calendar event API | [https://developers.google.com/workspace/calendar/api/guides/create-events](https://developers.google.com/workspace/calendar/api/guides/create-events) |
| Microsoft Graph Calendar API | [https://learn.microsoft.com/en-us/graph/api/resources/calendar-overview?view=graph-rest-1.0](https://learn.microsoft.com/en-us/graph/api/resources/calendar-overview?view=graph-rest-1.0) |
| React Email | [https://react.email/docs/introduction](https://react.email/docs/introduction) |
| ical-generator | [https://github.com/sebbo2002/ical-generator](https://github.com/sebbo2002/ical-generator) |
| cmdk command menu | [https://github.com/pacocoursey/cmdk](https://github.com/pacocoursey/cmdk) |
| react-hotkeys-hook | [https://react-hotkeys-hook.vercel.app/](https://react-hotkeys-hook.vercel.app/) |
| Sonner toast component | [https://sonner.emilkowal.ski/](https://sonner.emilkowal.ski/) |
| Driver.js product tours | [https://driverjs.com/](https://driverjs.com/) |
| React Router pending and optimistic UI | [https://reactrouter.com/start/framework/pending-ui](https://reactrouter.com/start/framework/pending-ui) |

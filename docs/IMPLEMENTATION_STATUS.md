# Verified implementation status

Evidence recorded through **31 October 2026**, including phone Applications filters and the form builder palette, review fixes for typed fields and live filters, typed application answer fields, live list filters and the planner chrome pass, the shared workbench title follow-up, the navigation and page header pass, the local interface consistency pass and its visual review follow-up, the interface refinement and visual evaluation pass, assistant request presentation and partial task coverage, readiness source links, the sponsor/deliverables release, application/scanner releases, a controlled live invited-speaker journey and autonomous backup acceptance.
This is the current capability,
requirements and acceptance index; consolidation does not constitute a new
verification or deployment. The [product specification](../sessionboard-replacement-full-scope-implementation-specification-with-competition-ux.md)
owns intended scope, [DECISIONS.md](DECISIONS.md) owns engineering decisions, and
Git history retains earlier committed work logs.

## Phone Applications filters and form builder palette — 31 October 2026

**Local presentation change; no API, schema or migration change; not
deployed.** See *Phone filters and the form builder palette* in
[DECISIONS.md](DECISIONS.md). This closes the two follow-ups the review left
open.

- Applications on phones: Search sits beside a Filters button with the active
  filter count; Routing, Status, Track, Sort and Clear open below it, and the
  Density label sits beside its control. Measured on a Pixel 7, the first
  application title moved from 830px to 498px (the first screen previously
  showed no application). Desktop and tablet layouts and the desktop baseline
  are unchanged. Of the other filter pages, Event speakers, Speaker
  directory and Operation centre already use compact controls and Tasks and
  review results fold theirs. Speaker deliverables still shows no record on
  a phone's first screen because its Remind speakers card comes first; that
  is unchanged.
- Form builder: the palette shows Short text, Long text and Dropdown, plus a
  More types button that opens the other eight types below them, still
  draggable. It is one 82px row instead of three (162px) at 1280 and 1366px.
- The canvas no longer keeps a 560px floor beside the outline and dock. At
  1280×720 it was 99px taller than its pane, which hid the palette under the
  history strip behind a second scroll. With the stage pinned, the palette is
  fully visible and the pane does not scroll at 1280×720, 1366×768, 1440×900
  and 900×1000. Visible canvas: 352px at 1280×720, 400px at 1366×768.
- On phones the palette still sits below the first screen inside the canvas
  pane's scroll. That predates this change: the committed baseline showed
  only the "Add a field" label, and with a one-row palette that label no
  longer shows either.

Browser coverage adds a phone-width Applications test (filters folded, first
application in view, count after choosing a status). The desktop one-row
test now measures visible controls and checks that the Filters button is
hidden. The authoring tests open More types before using the other types,
and one checks that the button reports its state and that a revealed type
is draggable. The long-track overflow check opens Filters on narrow screens.
Four baselines changed and were inspected: Applications mobile and the form
builder at desktop, laptop and mobile; the desktop and laptop form builder
pins in the launch film were updated.

Validation (31 October): `npm run typecheck`, `npm run check:focused` and
`npm run design-system:check` pass, as does the story-state validator. On a
fresh build, `operational-data-grid`, `submissions` and
`evaluation-public-application` ran in Chromium: 30 passed and the desktop
one-row test failed because it counted the hidden Filters button. After that
test was corrected, it and the phone-width test passed. The Firefox
and WebKit smoke projects (6), mobile WebKit `ux-fixes` (3) and the full
visual spec without updates (32) pass. `npm run check:core` and the full
`npm run check` were not run.

## Review fixes for typed fields and live filters — 30 October 2026

**Local change; no API, schema or migration change; not deployed.** An
independent review of the two entries below found two browser regressions
and a validation inconsistency; all are fixed, with two product follow-ups.

- The applicant preview renders inside the builder's form, so an invalid test
  answer (an email, a URL, or a speaker count outside 1–20, even in a hidden
  pane) silently blocked Save draft through native validation. This predates
  the typed fields for URL and video answers. Preview controls now belong to a
  separate, never-submitted form.
- Back or Forward pressed while a filter edit was pending re-applied that edit
  over the restored history entry. History traversal now restores its
  destination exactly; other navigations still keep an unloaded edit, and the
  first commit still keeps choices made before hydration.
- A second review found that fix incomplete: after Clear, retyping the
  earlier search and continuing to type, Back ended on the newer text. The
  hook took a URL matching its loading request as proof the navigation was
  its own, so Back skipped the traversal handling or a pending debounce
  cancelled it. Each request now carries a fresh id in its history state and
  only that id identifies it. The new tests failed in Chromium, Firefox and
  WebKit before the change.
- Checkbox and date answers must be exact. `" Yes "` and `" 2027-05-20 "`
  passed a trimmed check but could not be displayed by the native controls;
  they are now rejected at final submission.
- A checkbox can control a follow-up question: the condition stores `Yes` and
  the builder, canvas, structure list and public landing outline say "is
  ticked".
- The board's read-only marker shows the state ("Read-only · published")
  instead of leaving the reason to screen readers; the full version, frozen
  surfaces and remedy remain in its accessible text. The short state keeps the
  laptop toolbar on one row, so the board position measured above is
  unchanged.

The Firefox and WebKit smoke projects now include a live-filter test: typing
across a delayed request keeps text and focus, Back to an entry whose query
matches a loading request restores it without applying the pending edit, and
a select applies. Chromium adds the reviewer's density/Back reproduction, the
second review's matching-query reproduction, an unchanged draft saved with
an out-of-range preview value, and a published checkbox revealing its
follow-up question. The laptop Schedule planner baseline and its
launch-film pin were updated for the marker text.

Validation (30 October): `npm run typecheck`, `npm run check:focused` (1,072
tests in 101 files), `npm run design-system:check`, `npm run openapi:check`
and the story-state check pass. One fresh-build run of the twelve affected
Chromium specs, including the full visual inventory without updates, plus the
Firefox and WebKit smoke projects passed all 137 tests. After the
history-state id change, on a fresh build: the matching-query test passed
five repeated runs, the eleven affected Chromium specs passed 100 tests (the
visual inventory was not rerun; the change does not alter rendering), and
the Firefox and WebKit smoke projects passed twice (12 tests).
`npm run typecheck` and `npm run check:focused` (1,072 tests) pass again.
The palette crowding and mobile Applications filter density noted by the
review were addressed on 31 October (see above); the full `npm run check` release gate and `npm run check:core` were not run.

## Live list filters and planner chrome — 30 October 2026

**Local presentation change; no API or schema change; not deployed.** See
*Live list filters and planner chrome* in [DECISIONS.md](DECISIONS.md).

- Nine administrator filter forms apply as they change, without an Apply
  button: Applications, Event speakers, Speaker deliverables, Speaker
  directory, Sponsor readiness, Tasks, Operation centre operations and
  activity, and review results. Text waits 300ms, selects 250ms (one request
  for a run of arrow keys on a closed select) and Enter applies at once.
  Requests replace the history entry and keep the scroll position; filter
  changes still return to page 1 and keep density and columns.
- One hook (`app/components/use-live-filters.ts`) makes the controls
  controlled. The keyed remounts that dropped focus and typed text are gone;
  the Applications grid now resets its selection explicitly. Clear, Back and
  Forward restore the form from the loaded URL. Existing result summaries are
  polite live regions, and text filters carry the server length limits.
- Schedule planner: the full-width read-only bar is removed. The header keeps
  the version beside Edit next version; the board carries the Read-only
  marker in every view, with the full reason as accessible text. The format
  key and scroll hint are canvas-toolbar items that share a row with the day
  tabs when there is room. Title role and breadcrumbs are unchanged.
  Measured top of the first board time row (the bottom of the room header):
  414px → 363px at 1280×720, 470px → 392px at 1440×1000 (the board is 28px
  taller there), 475px → 405px at 1024×768 and 1026px → 934px on a Pixel 7.

Browser coverage now checks typing across a delayed request (focus and text
kept), keyboard traversal of a closed select making one request, Enter,
Clear, Back/Forward restoration, a filter edit during a column or density
change, a select-only Tasks form driven from the keyboard and a choice made
before hydration. The planner's read-only test checks the header version, the
board marker in Room and Week views and its removal on the next draft. Six
baselines changed and were inspected: Applications desktop and mobile,
Speaker directory filters desktop and mobile, the Speaker directory contact
crop on mobile (a sub-pixel shift; the text is unchanged) and the laptop
Schedule planner, whose launch-film pin was updated. The mobile directory
filter baseline still showed Apply within the 1% tolerance and was
regenerated deliberately.

Validation (30 October, local): `npm run check:focused` (Biome, generated
TypeScript checks and 124 affected unit tests), `npm run typecheck`,
`npm run test:config` (98) and `npm run design-system:check` pass. A final
Chromium run of the twelve affected specs, including the visual inventory
without snapshot updates, passed 127 tests. Before that, an Applications
queue test failed because a sort chosen before hydration was reset by the
controlled form; the hook now keeps such choices. Real-browser checks on
Applications and Event speakers with 500ms request delays confirmed typed
text and focus survive requests, four arrow keys make one request, and Clear,
Back and Forward restore the form. None of the nine filter pages makes a
request on load. `npm run check:core`, the full `npm run check` and the
Firefox/WebKit smoke projects were not run.

## Typed application answer fields — 30 October 2026

**Local production slice; API contract change; no schema migration; not
deployed.** Application forms gain single checkbox, number, date, email and
phone fields beside short/long text, dropdown, multiple choice, URL and the
pitch video. The builder palette, canvas, applicant preview and public
application render native controls (`checkbox`, decimal-keypad text, `date`,
`email`, `tel`). Answers remain strings in drafts and immutable snapshots, so
review, export, Airtable and AI evidence read them unchanged; a ticked
checkbox stores `Yes`. Final submission validates each type on the shared
client/server path, and a required checkbox must be ticked. The participant
submission API and form schema in OpenAPI list the new types. A checkbox can
also control a follow-up question (see the review fixes above). A general
applicant file field is **not implemented**: native applicant uploads remain
the single pitch-video asset.
The applications user guide lists the available question types.

The form-builder desktop, laptop and phone baselines changed for the larger
palette (one extra chip row at laptop width); the two pinned launch-film
snapshot hashes were updated deliberately because the film story is unchanged.

Validation (30 October): `npm run check:focused` (Biome, generated TypeScript
and 994 affected tests in 90 files), `npm run design-system:check`, the video
story-state check and `npm run openapi:sync` pass. Unit tests cover type
validation and the applicant controls. The complete `e2e/submissions.spec.ts`
passes 14 tests, including builder preview validation and a published form
whose checkbox and date fields work on the public application; the form-builder
visual checks pass after the baseline update. The full `npm run check` release
gate was not run.

With the live-filter and planner changes above in the same tree,
`npm run typecheck`, `npm run check:focused` (1,065 tests in 100 files),
`npm run design-system:check` and the story-state check pass. A Chromium run
of the twelve affected specs, including the visual inventory without
updates, passed its first 41 tests before a local Wrangler proxy crash
("Network connection lost") refused every later request; rerunning the eight
specs from the crash onward on the same build passed all 100 tests, so all
129 passed across the two runs.

## Shared workbench titles — 25–28 October 2026

**Local presentation change; no API or schema change; not deployed.** Form
Builder, Schedule planner and the reviewer workbench now share the operational
title role: 34px desktop and 30px at phone widths. This supersedes the compact
title exceptions in the 24 October pass and costs 8–13px of workspace height.
Workbench headers keep an 8px gap below the title, and planner actions wrap at
narrower widths. The Form Builder title is now "Form builder": the form picker
names the form being edited, whereas the old title said "Call for Speakers"
for every form and wrapped to two lines on phones. The Applications button and
browser tab title use the same sentence-case name.

The visual suite now verifies title size and typography across sixteen admin
and reviewer routes at desktop and phone widths. Eight screenshots changed
against the committed baselines (the two Applications captures only for the
button label); the five launch-film snapshot pins among them were updated.

Validation (28 October): production build, generated TypeScript checks, Biome
on changed files, CSS hygiene/design-system adoption and the video story-state
check pass. The visual suite passes all 32 checks with the expected baseline
updates and again without updates after the final rebuild. A run without
updates of the visual, submissions, event-setup and demo specs passed 62 tests
before a local Wrangler proxy crash stopped one submissions shard; a separate
submissions run then passed all 12 tests. The later Applications button and
tab-title case change is not referenced by those specs. The 25 October revision also had manual inspection of all three
workbenches at 320–1440px, a refreshed Tailscale comparison gallery and a
`codex exec review` with no actionable findings; none of those was repeated
for the 28 October spacing and title follow-up. The full `npm run check`
release gate was not run.

## Navigation and page header pass — 24 October 2026

**Local presentation change; no API or schema change; not deployed.** See
*Navigation, page headers and filters* in [DECISIONS.md](DECISIONS.md).

- Workspace tabs are underlined on the page; quick filters are count chips.
  Tasks merged its state filter and stats line into chips whose counts match
  the rows each shows, split Impact into its own column and dropped the
  single-task 0% bar. Operation centre's Activity timeline, exports and
  imports are tabs instead of a primary header button stacking panels.
- Page headers hold actions only: duplicate links to sidebar destinations,
  breadcrumb back buttons and "On this page" anchors are removed. Navigation
  primaries became bordered buttons; Add session is the programme page
  primary and Bulk session updates moved there from Operation centre.
- Sidebar: Event assistant and Sponsors are top-level event work, Speaker
  directory has an Organisation group. Titles match sidebar labels (Command
  centre, Operation centre, Communications, Speaker resources, Bulk task
  actions, Speaker deliverables).
- Defects fixed: `.list-clean` had no rule (bullets; name and email run
  together); a doubled table edge under row headers; Sponsors' empty state
  claimed a filter mismatch; complete Command centre bars read as empty;
  full-width stack buttons; unlabelled round-progression fields.
- Sponsors' create form opens on request; preset task plans confirm through
  a dialog listing the templates; the resource speaker preview is a
  disclosure and attachments precede Publish; matrix cells no longer repeat
  their column header; the Schedule notes rail uses an icon and a word, not
  rotated text.

Not changed: organisation/event breadcrumbs (required by §11.5); filters still
apply on an explicit button; the Templates tab keeps its create form open;
compact workbench titles.

Validation (local, 24 October): `npm run check:core` lanes pass — Biome,
TypeScript, production build, configuration tests (98, including the video
story-state check with 11 re-pinned product snapshots) and unit/Worker tests
(210 files, 2,072 tests; 98 files, 668 tests). The Chromium Playwright suite
ran with snapshot updates (272 tests across desktop, mobile, laptop and the
mobile WebKit UX project); its four failures (a reload that no longer kept a
section open, the palette's old Home name, and the Applications filter row
wrapping under the longer Apply filters label) were fixed and their three
specs re-run green. Twenty-six visual baselines were regenerated and
reviewed. `npm run check` (dependency audit and Firefox/WebKit smoke) was not
run. The launch film's recreated scenes and narration still use the old
labels (Home, Command Centre, Open Command Centre).

Review follow-up (24 October, same local pass):
- Task chips count their destination after clearing a focused task, while
  retaining the other filters. A focused handbook task now offers All 3,
  matching the three rows opened by the link.
- Secondary task forms span the table in their own row. Opening More and a
  waiver keeps every requirement cell and action control in place at
  320, 390, 1024, 1280 and 1440px; closing and reopening preserves draft input.
- Hidden button-based workspace views have explicit scroll arrows. Keyboard
  activation reveals and focuses a tab without selecting its view; arrows
  disappear when no views remain hidden in that direction.
- The mobile layout test accepts the organisation Scope control when a prior
  CRM fixture has granted the demo administrator organisation access, removing
  the observed test-order dependency.
- Shared tabs and filter chips use a background rule and inset border instead
  of raw shadows, satisfying the existing CSS hygiene gate. The sponsor-create
  link uses a structured route target so its fragment is not mistaken for a
  colour literal by the design-system check.

Follow-up validation: production build, generated TypeScript checks, Biome,
CSS hygiene/design-system adoption and the video story-state check pass.
Focused tests pass (22 component/navigation tests and 23 task-route Worker
tests). Eight Chromium specs pass across desktop, mobile and laptop projects
(88 checks, including three new task regressions and the CRM-before-mobile
test order). Only the mobile Tasks baseline changed; it and the expanded
action-panel screenshots at 320px and 1280px were inspected. A second visual
run without snapshot updates passes all 32 checks. The complete `npm run check`
gate was not rerun for this focused follow-up.

Requested CLI review/fix loop (24 October): two rounds of
`codex exec review --uncommitted -m gpt-6.1-sol -c 'model_reasoning_effort="high"'`
both reported no actionable findings. No additional code fixes or dismissed
findings were required; the tracked patch and untracked-file hashes matched
between rounds. `npm run check:focused` passed Biome, generated TypeScript
validation and 2,156 affected tests in 213 files. Each reviewer also passed
56 focused unit tests and 69 Worker tests; round 1 passed three Chromium
regressions, and round 2 passed the production build and all 14 task-workflow
browser checks. Raw findings, logs, patch snapshots, hashes and per-round
assessments are in `.artifacts/review-loop-20261024T121047Z/`. Only this audit
receipt changed after the final review. The full `npm run check` gate was not
run for this review loop.

## Interface consistency pass — 23 October 2026

**Local presentation change plus one additive public API field; not
deployed.**

Defects fixed:
- The parked skip link's shadow no longer smudges the top-left of light
  headers (reviewer, participant, applicant and public pages).
- Disabled buttons use one neutral treatment. Copper at half opacity read as a
  broken pink control; a second, conflicting opacity rule in the planner
  stylesheet is gone.
- `<small>` no longer falls to the browser's 11.7px; it sits one pixel below its
  context, never under 12px.
- The task-state control uses two columns at 400px and below so all four
  filters fit narrow screens. Mobile schedule action labels wrap while the
  external-link icon retains its 14px width.

Consistency:
- View toggles (branding and site previews, form builder panes, email and
  applicant previews, embed width, resource embed kind, schedule view and day,
  session-content preview, task quick filters) share `.pc-segmented`. Review &
  selection uses the shared page tabs. The underline `.tab` style is retired.
  The event-site editor's section tabs and the public day tabs keep their own
  styles.
- Schedule planner and Public programme & embeds header actions are bordered
  buttons; Add session moved out of the programme page's link row. Form
  Builder's Publish version renders as the page primary. Task rows show one
  decision with waiver, extension, details and comments behind More.
- Counts beside headings render as count pills, not status dots.
- Field help, errors, record metadata and notice text are 13px; section and
  empty-state descriptions are 14px.

Raw values replaced:
- Statuses of evaluation teams, rounds, assignments and invitations, task
  templates, resource pages, sender profiles, template versions, session
  visibility and participant application summaries use presentation labels.
  Task types use shared labels.
- Session formats show the event's configured label in the evaluation session
  queue, speaker detail, participant sessions and session-details review,
  session-content preview, embed builder and public programme, event site and
  itinerary, and session-content pages and their revision history (which also
  label visibility and content status). Published sessions carry
  `formatLabel`, added to the public session schema; the participant API's
  session-details review carries it beside the fingerprinted fields.

Not covered: about 40 remaining underscore-to-space displays (roles, file
kinds, import entity types) and page-specific 12px rules outside the shared
roles.

Validation:
- Before the responsive follow-up, `npm run check:core` passed: Biome,
  TypeScript, 668 unit, 2,072 Worker and
  one agent test, build, CSS hygiene, design-system adoption, OpenAPI,
  migration, audit and recovery contracts. New tests cover published and paged
  format labels and the one-decision task row.
- 45 visual baselines were regenerated with `--update-snapshots=all` and
  inspected; 26 film pins were updated (frames not re-rendered).
- The first full Chromium run failed five browser checks that asserted the
  old lowercase formats and direct task-row disclosures; those specs were
  updated and passed with the visual suite (60 checks). The final full run
  passed 265 checks with 2 skipped and one failure: the mobile
  public-programme screenshot alternates between two page heights. It fails
  the same way at `b556d536` (3 of 6 repeats; 2 of 6 with this change), so it
  is pre-existing.
- The evaluation suite passed 12 of 12. Firefox/WebKit smoke and the complete
  `npm run check` gate were not run.
- Responsive follow-up: both layout regressions failed the new browser checks
  against the prior build. After the fixes, seven focused Chromium behavior and
  visual checks passed, including filter containment and keyboard use at
  320–393px and the schedule icon at 320–412px. The 320px task and 320px/393px
  schedule screenshots were inspected; existing visual baselines did not change.
  Generated TypeScript checks, Biome, build and design-system checks passed.
  The full repository gate was not rerun for these two CSS fixes.
- The requested Codex review/fix loop completed two
  `codex exec review --uncommitted -m gpt-6.1-sol -c 'model_reasoning_effort="high"'`
  rounds on the same patch. Both reported no actionable regressions; no
  additional code fixes or dismissed findings were required. Round 1 passed
  generated TypeScript checks and 93 focused unit/Worker tests. Round 2 passed
  generated TypeScript checks, build, 81 focused unit/Worker tests and three
  Chromium checks. The full repository gate was not rerun. Logs, findings,
  patch hash and per-round assessments are in
  `.artifacts/review-loop-20261023/`; only this audit receipt changed afterward.

Visual review follow-up (24 October, same uncommitted pass):
- A visual review of all 45 changed baselines plus live checks (hover, focus,
  forced colours, 320–412px) found regressions, which were fixed:
  - The selected segment measured 1.05:1 against its track; it now carries a
    4.6:1 border, and forced colours use the system Highlight fill.
  - The new disabled well made disabled bordered buttons outweigh enabled ones
    (review workbench, Event settings, public Clear filters). Only filled
    primaries keep the well now.
  - Opening a task row's More panel threw the trigger onto its own line.
  - In forced colours the selected page tab had no indicator.
- Also fixed:
  - The design-system width demo now narrows its frame.
  - Form Builder and event-site mobile pane switches use page tabs.
  - The schedule view toggle no longer wraps at 320px.
  - Applicants see "Under review" for internal review stages.
  - Managed-embed status and task template scope use labels.
  - Reviewer role is plain labelled text.
  - Profile-history and operation counts are count pills.
  - Event settings' compact Save is a primary.
  - Applications' Apply is no longer a second filled primary.
- Remaining role displays in the admin account and event switcher still use
  underscore-to-space.
- Validation:
  - Biome, generated TypeScript and design-system checks pass.
  - `npm run test:changed` passed 210 files and 2,080 tests before the final
    small task-panel edit; the task workspace tests pass after it.
  - Visual, public-site and review-link suites passed 41 checks; 27 baselines
    were regenerated with `--update-snapshots=all` and inspected region by
    region against the first pass.
  - 15 affected behaviour specs passed 143 of 144 checks. The failure was a
    stale task-row selector in `speaker-portal.spec.ts`; after the fix that
    spec passed 8 of 8.
  - `check:core`, Firefox/WebKit smoke and the complete `npm run check` gate
    were not rerun.
- Three further review findings, fixed afterwards:
  - Public programme search and facet selects had no resting border, and a
    `background` shorthand cleared the select chevron. They now have a surface
    fill, an editorial hairline, chevrons and the shared focus treatment, in
    light and dark themes.
  - The review-link dialog's session list cut off exactly between rows with no
    cue. It is now a framed, keyboard-focusable region; part of the next row
    shows, with scroll shadows only while more rows are hidden.
  - Evaluation administration's Assign, Add another reviewer, Decide and
    results Apply were actions styled as links. They are now small bordered
    buttons, level with their selects. The results-row Assign link is a button
    link; Open discussion stays a link. On mobile, later items in an
    evaluation table cell stay in the value column, so the reviewer select no
    longer clips.
  - Validation: Biome, generated TypeScript, design-system checks and 158
    related unit tests pass. Visual, public-site and review-link suites passed
    41 checks; 9 baselines changed and were inspected. Eleven evaluation,
    public-programme, embed, itinerary and accessibility specs passed 76
    checks, and six evaluation and accessibility specs passed 51 checks after
    the mobile cell fix.
- Final manifest repair: refreshed 19 of the 26 film screenshot pins against
  the current, visually reviewed baselines. Story-state and caption validation
  and `npm run test:config` (98 tests) pass. The full core and release gates
  were not rerun for this metadata-only repair; film frames were not re-rendered.
- Post-repair review loop (24 October): two further passes of the requested
  `codex exec review --uncommitted -m gpt-6.1-sol -c 'model_reasoning_effort="high"'`
  both reported no actionable findings. No additional fixes or dismissed findings
  were required. Each reviewer passed 93 focused unit/Worker tests; independent
  validation passed 98 tests across seven files, generated TypeScript checks,
  Biome, design-system checks and film validation. OpenAPI validation also passed.
  Round 2 stopped its broader related-test run in favour of focused tests; that
  interrupted run is not credited as passing. Browser and full repository gates
  were not rerun; application code was unchanged. Raw reviews, assessments,
  input hashes and check logs are in `.artifacts/review-loop-20261024-_eu9m5cr/`.
  Only this audit receipt changed after the final clean review.

## Interface defects, displayed values and view races — 22 October 2026

**Local presentation and client-state change; not deployed.**

Defects fixed:
- `.page-actions` is now a flex row with a gap everywhere. Outside page
  headers it was a block, so adjacent controls touched. Affected: the Delivery
  health count and its period button, task filter Apply/Clear, bulk task
  links, and the session-content Desktop/Mobile toggle. Two navs that had
  rendered empty (sponsors, deliverables paging) now render only with links.
- The Tasks table's action cell is a table cell again, so its row divider
  lines up with the rest of the row.
- The speaker dashboard calendar note has a gap after its icon.
- The AI notice on Review & selection no longer ends a sentence with "..".
- Review workbench:
  - Queue references wrap whole instead of mid-reference.
  - The header save state is hidden where the action bar is always in view
    (three-column layout). It remains on narrower layouts.
  - Rubric fields fade out above the action bar instead of being sliced
    mid-line.

Raw values replaced:
- Statuses now use the shared presentation labels and tones:
  - Review & selection submission and session statuses;
  - the session results row;
  - review queue cards.
- Task priorities are capitalised.
- Session slugs no longer appear in the review session queue or results.
- Communication record ids and a duplicate sent count no longer appear in
  Recent communications.
- Applications shows the routing state alone when no team is routed, and the
  team alone when routing is automatic.
- Session formats still showed the event's format key here; resolved by the
  23 October consistency pass.

View races fixed in the Applications grid:
- Column and density changes build on the last requested URL. Holding requests
  open, two quick column toggles kept both changes 9 of 9 times; the previous
  code lost one 5 of 6 times.
- The filter form's view fields come from the grid's requested state, so Apply
  pressed during a pending density change keeps it. The previous code lost the
  change 3 of 3 times.
- A pending view is discarded on any committed navigation. Before this, Clear
  pressed during a pending density change reset the URL but left the selector,
  table and form value on Compact. Back would also have revived an old pending
  view.
- Browser tests reproduce the races with held requests, and cover Clear and
  Back/Forward. Unit tests cover chained column changes and reading the
  requested view.

Validation:
- The five-shard browser suite passed apart from the visual baselines these
  fixes move. A first run lost two shard servers mid-run, and the rerun passed.
- The 11 changed visual baselines were regenerated with
  `--update-snapshots=all` and inspected. One of them sits inside the 1% ratio,
  so it would not have been refreshed otherwise. Their 7 film pins were updated
  and the affected frames rendered. The visual suite then passed 32 of 32.
- The evaluation suite passed 12 of 12, and 53 affected unit tests passed.
  Biome, TypeScript, CSS hygiene, design-system adoption and story-state
  validation passed.
- One test fixture used a session status the schema does not allow. It now
  uses `scheduled`.
- The complete gate was not run.

## Secondary copy reduction — 22 October 2026

**Local presentation change; not deployed.** Administrator, reviewer,
participant, applicant and public pages no longer repeat their titles in ledes,
section and card descriptions, eyebrows, control hints or empty-state bodies.
About 110 route and component files changed (733 lines removed, 192 added).
Consequences, honesty disclosures, validation and status text, format and limit
help, keyboard alternatives, scope and organiser content remain. A review of
every removal restored two consequence notes: routing does not assign
evaluators, and confirmation recomputes a communication's audience. A later
review restored a third beside Add session: it emails a portal invitation to
each speaker who has not accepted access. That notice describes production;
demo and test runtimes deliberately send no invitation. A keyword scan of all
removed copy found no other lost consequence. A further review restored the
bulk speaker invitations' two-contact minimum, a limit hint the rules keep.
Submitting one contact now also says so instead of the schema's generic
array-size error. A scan of removed copy for limits and format help found no
other loss.

The speaker dashboard retains conditional guidance when tasks and resource
acknowledgements are complete but profile or session preparation remains.
A browser regression clears the task list with one session role still pending,
checks the guidance at desktop and phone widths, then accepts the role and
checks that the guidance disappears when preparation is complete. The new
regression, existing speaker workflow and desktop/mobile dashboard visual
checks passed (4 checks), as did 11 focused component tests, generated
TypeScript, Biome and the production build. Both new-state screenshots were
visually inspected. The complete gate was not rerun for this follow-up.

Side effects found and fixed:
- Seven page headers had relied on a lede's width to place their actions. A
  before/after sweep of 46 pages at desktop and phone widths found five, a
  scan of the changed header markup found the other two, and all seven now
  put their actions in the trailing `.page-actions` group.
- The branding commit action kept its trailing position once its note was gone.
- Five now-unused CSS rules were removed.
- Four launch-film focus rings over changed screenshots were realigned and
  checked in rendered frames.

Biome, generated TypeScript, CSS hygiene, design-system adoption and
story-state validation passed, as did 496 affected unit and Worker tests. The
five-shard browser suite ran 270 checks: 265 passed and two opt-in performance
checks were skipped. The three event-website failures were refreshed snapshots
and a layout test that had depended on panel length; after the fix the spec
passed 6 of 6. The evaluation browser suite passed 12 of 12. Four browser specs
that asserted removed text were updated. The 40 visual and 6 public-site
baselines that changed were regenerated and inspected, with their film pins.
The complete gate was not run.

## Status colour roles — 22 October 2026

**Local presentation and test change; not deployed.** Copper is now limited to
brand, primary actions, links and selection. In-progress and informational
statuses, including status badges and in-progress speaker stages, use a muted
steel blue. Failure moved from a 0° red to crimson (about 345°) on near-neutral
rose surfaces; the warning solid is a clearer amber-gold; healthy incomplete
Command centre meters are neutral. Field errors and notification counts use the
failure tokens. All new text pairs meet 4.5:1 and graphical marks 3:1.

These colour changes fell inside the visual tests' 1% tolerance, so 25 affected
baselines were regenerated and inspected, with their 15 film pins. That also
captured existing Form Builder canvas drift the tolerance had hidden. Key
operational pages now allow at most 16 differing pixels. Three fresh runs of the
visual suite passed with a zero-pixel key-page budget. Temporarily restoring
copper to in-progress statuses failed the Applications check with 78 differing
pixels, a change the 1% ratio would have accepted.

Visual, axe and keyboard accessibility, data grid, schedule, responsive and
Firefox/WebKit smoke specs, generated TypeScript, Biome, CSS hygiene,
design-system adoption and story-state validation passed. One data grid assertion
was updated to the new crimson values. The complete gate was not run.

A later review found that three rules still named copper directly instead of
the state tokens: the evaluation results' Moderation draft flag, the default
(informational) status notice, and untoned `.progress` meters (review queue
progress, rubric weights). They now use the steel-blue information tokens and
neutral ink, which computed styles confirm in the browser. A sweep of state and
tone selectors that still use brand tokens found only selection, current-item,
primary-action and loading-indicator rules, which copper still owns. Four
visual baselines and two film pins changed; the visual suite passed 32 of 32.

## Interface refinement and visual evaluation — 20–22 October 2026

**Local presentation changes, one data-integrity fix and evaluator tooling; not
deployed.** Current behavior:

- Ordinary administrator and participant page titles share 34px bold on desktop
  and 30px bold on phones; Form Builder and the reviewer workbench use a 23px
  compact variant; Command centre and Schedule keep their own title roles. A
  browser check holds the twelve-page administration title cohort to one style
  per viewport. (Superseded: see "Shared workbench titles", 25–28 October.)
- At 360px and below the top bar keeps the event name on its own row; between
  761 and 1000px the search trigger truncates instead of wrapping. Pressed
  buttons change fill instead of moving.
- Command centre places critical next actions before the readiness score, whose
  colour follows the server readiness state and warning count. Meters are 6px and
  global New is secondary.
- Applications: Density and Columns are URL view controls that keep applied
  filters and unapplied filter edits; filter submission keeps the density. The
  Columns menu extends below short tables, long track names stay contained, and
  Apply keeps contrasting colours on hover and keyboard press.
- The speaker directory has route-scoped table and filter styling, the shared
  Button for Apply filters and two-column phone filters. Form Builder has a
  stronger canvas hierarchy and contained outline controls. Schedule room columns
  have a 144px minimum, with a quieter desktop grid and category rails on cards
  without conflicts. Resource metadata inputs align.
- Manual applications whose track names are 81–120 characters stay readable:
  choice labels accept 120 characters and manual creation validates its snapshot
  before insertion. Worker tests cover creation, detail reads and a later track
  rename; OpenAPI source and generated JSON are synchronized.

**Evaluation evidence.** Each retained change received five strict preferences
and five absolute quality passes at desktop and mobile sizes from Codex
`gpt-6.1-sol`/high on AEK 0.7.0; earlier 0.6.4 phases remain historical. Withdrawn
and split rounds remain in the reports. Peer comparisons with dated published
references are advisory; the Applications table did not meet its zero-loss target
against Attio (three preferences, one equivalent, one loss). Model judgments are
uncalibrated, and no whole-product or SaaS-parity claim is made. Reports and sealed
runs are under `evals/.agent-eval/` (`ui-unanimous`, `ui-external`,
`ui-table-polish`, `ui-native-batch-20261021`, `ui-forms-schedule-20261022` and
`ui-craft-20261022`); validation logs are under `.artifacts/`.

**Validation.** `npm run check` passed on 22 October in 723.2 seconds: 667 unit,
2,068 Worker and one agent test; types, build and configuration, schema, audit,
recovery and OpenAPI contracts; 266 application browser, 12 production-shaped
evaluation and 16 public-website checks, with two opt-in performance checks
skipped. Its first attempt failed three browser checks and timed out on the npm
advisory service. The fixes corrected test prerequisites (lazily rendered API
examples, hydration waits), refreshed two inspected preview baselines and moved to
the patched Vite 8.2.4. Receipts are under `.artifacts/release-fixes-20261022/`.

That complete gate predates two later corrections. A follow-up fixed two
regressions introduced during this work: column changes discarded unapplied
filters, and holding Space on Apply showed white text on a pale fill. A
subsequent review against `origin/main` set participant phone titles to the
shared 30px role and made the wrapped Create schedule action span the phone
action row. It also stopped the table evaluator from letting a later unanimous
round override an earlier split for the same pixels, and made the table report
print measured title metrics instead of fixed values. After these corrections,
85 Chromium/Firefox/WebKit visual, grid, schedule, accessibility and responsive
checks, the 44 evaluator tests, Biome, generated TypeScript, CSS hygiene,
design-system adoption and film story-state validation passed. Two participant
phone baselines and their film pins were refreshed after inspection. The
complete gate was not repeated.

Remaining: deployment, independent calibration of model judgments and
independent design acceptance. The SaaS reference report does not verify sealed
runs before presenting their verdicts.

## Assistant request presentation and partial task coverage — 20 October 2026

**Production slice, local; not deployed.** Follow-up review exposed a remaining
partial-coverage gap: adding a new conflict while an earlier conflict remained
active hid the earlier coordination task and proposed both conflicts again.
Coverage now applies per source record across active tasks. Existing work stays
visible, and new previews contain only uncovered records. Retained preview
context distinguishes those records from the scope already owned by earlier
tasks, including when an earlier task is subsequently waived.

The assistant now places its current answer, source disclosure and pending
approvals before request history. History summaries show the organiser's request,
event-local timestamp and action outcome. Expanded entries show the retained
answer, sources and resulting task; provider/model, timing, usage, cost and raw
audit data sit behind a separate disclosure. “Task created” explicitly does not
mean the blocker is resolved. Editing, rejecting and approving retain the current
answer while refreshing proposal controls. Four suggested requests remain visible
with the rest under “More requests”; evidence disclosures keep exact previews
near the answer. Narrow layouts constrain the approval table to its own scrollable
area.

Browser validation passed all 20 checks in `assistant-readiness.spec.ts` and
`assistant.spec.ts`, including request/time/outcome labels, readable retained
answers, secondary diagnostics, approval ordering, keyboard disclosure access,
rejection/stale/failure recovery and saved task links. The success workflow also
checks a 390-pixel viewport; its first attempt exposed page-wide table overflow,
which was corrected before the passing run. Desktop, mobile, pending-approval
and expanded-history screenshots were inspected. The model in these browser
fixtures is explicitly simulated; no additional live-provider or deployment
acceptance is claimed. Screenshots and run reports remain under
`.artifacts/assistant-workflow/`.

`npm run check:core` passed in 374.7 seconds: 666 unit tests, 2,047 Worker tests,
one agent test, regenerated types, build, lint and repository/schema/recovery/API
contracts. Coverage includes partial existing work, combined task scope, removal
of earlier coverage, saved request labels and distinct review/execution outcomes.
Logs are retained as `.artifacts/assistant-workflow/core.log` and
`.artifacts/assistant-workflow/browser.log`. The full release gate and live-model
acceptance were not repeated for this local revision.

Reminder edits now retain the original assistant run ID, keeping the replacement
preview and its approved action in the originating request's history after reload.
The edit request keeps its separate correlation ID. The focused regression failed
before the correction; 67 focused Worker tests and all 20 assistant Chromium
checks passed afterward, alongside generated TypeScript validation, lint, build
and OpenAPI synchronization. The browser fixture uses an explicitly simulated
model. Its first run passed the history checks but exposed a test locator that
expected a transient success-banner link after reload; the corrected test follows
the persisted operation link. Receipts are in
`.artifacts/assistant-reminder-history/`. The complete repository gate and live
provider acceptance were not repeated for this focused correction; it is not deployed.

Report loading now validates required stored data instead of substituting missing
answers, evidence, measurements or provider metadata for completed runs. Running,
failed, cancelled and interrupted runs may still lack a final response. Reports
deliberately redacted by completed participant retention are omitted without
recovering removed content from immutable audit records; an unsubstantiated
redaction marker remains an error. Task evidence receives the validated target
label directly from proposal preparation. Live acceptance configuration rejects
missing or blank source provenance before a provider call.
Forward migration `0061` marks the deployed assistant's earlier operation
summaries as predating retained reports, preserving them in Operations without
inventing answers or measurements. Only that explicit historical disposition
is excluded; missing required fields in new reports still fail validation.
An insert guard closes the migration/Worker cutover window by rejecting old
assistant payloads before inference. Failed proposal reviews also reconcile
streamed controls with reloaded server state while preserving the current answer.

Validation passed: `npm run check:core` in 423.7 seconds (666 unit tests, 2,066
Worker tests, one agent test, regenerated types, lint, build and
schema/configuration/recovery/API contracts), 100 focused Worker tests, two
acceptance-provenance tests, the historical-data/cutover migration upgrade test
and all 22 assistant Chromium checks. The browser cases include conflicting
edits and rejections from another tab. The initial conflict-test attempts
exposed test-context and response-URL issues; the corrected full run passed.
The retention regression failed before its correction. Four requested Codex
review rounds are captured with findings and per-finding rationale; the final
review reported no actionable regressions. Receipts are under
`.artifacts/assistant-fail-fast/`, including `triage.json`, `core-complete.log`,
`browser-complete.log` and `review-4.findings.txt`. Only this audit receipt changed
after the reviewed and tested source. The complete release gate and live-model
acceptance were not repeated, and migration `0061` has not been deployed.

## Assistant readiness task scope and delivery links — 20 October 2026

The subsequent presentation/partial-coverage revision above supersedes the
initial all-record coverage rule described in this receipt.

**Production slice, local; not deployed.** Both follow-up review findings were
reproduced and fixed. Existing coordination tasks now suppress a new preview only
when their recorded source keys cover every currently affected record in the same
blocker category. An open task for a resolved room conflict no longer suppresses
work for a new speaker conflict, nor does an existing task hide an additional
uncovered conflict. Resolving part of a task's scope still leaves it covering the
remaining records; task scope is never silently expanded. Durable execution and
idempotency records still identify existing tasks, including interrupted result
settlement. Schedule conflicts use their version and domain fingerprint as the
source key, retaining task coverage when an unchanged conflict is rebuilt with
new row IDs. Other sources use their durable record IDs; previews and evidence
cards still link the actual current records.

Delivery source cards now use `deliveryCommunication` and the
`communications-health` anchor. The real browser opens the selected communication's
recipient deliveries, excludes another communication's recipient, and retains the
selection after reload. The new browser scenario uses isolated local D1 and an
explicit simulated model; it does not claim another live-provider acceptance.

Validation passed: 35 focused Worker tests, generated TypeScript checks,
formatting/lint, and all 20 Chromium checks across `assistant-readiness.spec.ts`
and `assistant.spec.ts`. The initial regression run demonstrated three failures
before the fixes. An additional regression exercises unchanged conflict rebuilds
through the real Schedule service. An ambiguous existing-work browser locator was
scoped to the answer panel before the passing rerun. The repeated requested Codex
review reported no actionable findings. `npm run check:core` also passed in 437.4
seconds: 666 unit tests, 2,047 Worker tests, one agent test, types, build and
repository/configuration contracts. Findings, rationale and logs are retained
under `.artifacts/assistant-findings-2026-10-20/`, including `core.log`,
`browser-scope.log` and `review-2.findings.txt`. Only this audit receipt changed
after the reviewed and tested source. The full release gate and live-model
acceptance were not repeated; the 19 October live-provider evidence below
predates these corrections. No deployment is claimed.

## Assistant readiness-to-task workflow — 19 October 2026

**Production slice, local. Live Workers AI acceptance passed; not deployed.**
The existing assistant loop records each model-call attempt, requested and returned
models, response IDs, durations, available normalised token categories, configuration
hashes, reasoning setting and optional dated inference-price snapshots. Missing
usage remains unknown, including after rejected or partially completed provider
responses. Explicit equal input/write rates permit a cost estimate without
inventing an unavailable write-token count. Private requester-scoped reports survive
reloads and connect the request/hash, source records, immutable proposal revisions,
review decisions, approval wait and persisted action result.

Readiness follows the Command centre's existing highest-priority action. Its read
tool supplies exact supporting records (bounded to 100 and an 8,000-character context), explicit task-target fields
and eligible named organisers. Insufficient evidence prevents a preview. Task-backed
blockers and existing assistant coordination work link to existing tasks instead of
creating another. A new readiness task requires a named organiser and a current-event,
administrator-only preview. The organiser can edit the title/context/owner or reject
it. Editing atomically replaces the preview and requires new approval. Approval
rechecks source evidence and owner availability; the task command checks the event
change cursor atomically. Stale previews are retired. Idempotent recovery returns an
already-created task after interrupted result settlement. Creating a task never
claims that the motivating blocker has been resolved.

The fixed five-scenario set passed against the real configured Workers AI DeepSeek
model: useful proposal/edit/approval/task reload, insufficient information, no
blockers with incomplete setup, changed evidence before approval, and an explicitly
injected failure after one real provider call. Only the AI binding was remote;
scenario records and actions remained in isolated local D1. Earlier unsuccessful
attempts remain in separate directories. They exposed premature requests for preview
permission, completion-budget exhaustion and incorrect task arguments. The final
path prepares the preview in the same run, uses the model's explicit `none` reasoning
setting within the existing 4,000-token limit, and copies authoritative target/owner
fields. Domain validation remains in force. A passing fixed set does not establish
general model reliability.

A separate real browser run exercised the built application's normal streaming
endpoint, Program Cue Agent, Workers AI binding, evidence review, task editing,
explicit approval and persisted-task reload. It used no substituted model response.
A later answer review exposed an invented URL prefix despite correct source-card
links. The final server rejects generated readiness links unless they match an
inspected source; the prose refers to authoritative source cards rather than generating link
destinations. Explicitly requested URLs must copy hrefs exactly. Valid links from the
returned setup/workflow snapshots and existing work remain available. The retained
report includes exact response IDs, available usage, dated inference estimates and
execution timing; the defective earlier answer remains separately recorded. Real recordings and joined evidence live in
`.artifacts/assistant-workflow/live-browser/`; fixed-set attempts live under
`.artifacts/assistant-workflow/live/`, with `latest.json` identifying the newest.
The compact report is `.artifacts/assistant-workflow/report.html` / `report.json`.

The initial uncommitted-change review fixed four additional gaps. An explicit null
readiness key permits unrelated ordinary tasks after a readiness read, including
later edits. Readiness observations identify the requester among eligible organisers.
Interrupted Anthropic streams retain observed usage marked partial; complete totals
and cost stay unknown. Reports recognise a durably created task even when assistant
result recording was interrupted, link that task and explain the idempotent retry.
The fresh five-scenario Workers AI set passed, including requester selection from
two eligible organisers before editing, approval and persisted-task verification.

The requested Codex CLI review/fix loop then identified four actionable gaps:
readiness audit rows could exceed the deployed size limit, organisation-wide
organisers were excluded, review evidence used an unregistered route, and existing
coordination tasks were missing from source cards. The fixes bound retained context
without relaxing the audit invariant, explicitly block proposals when evidence is
limited, recognise accepted organisation-wide organisers in both preview and atomic
event-task validation, and render the correct review/existing-work links. Findings,
fix analysis, review transcripts and check receipts are retained under
`.artifacts/assistant-review-loop/`, with per-finding decisions in `triage.json`.
A second CLI round reproduced a test-isolation failure: organisation-wide grants
leaked between parameterized cases and the simulated model chose a random first
owner. Those grants are now removed in `finally`; the explicit fixture selects the
eligible requester and fails if that invariant is missing. The two-organiser case
also verifies selection when the requester is not first in the returned list.
All 200 AI/task-API regression tests across 21 files, generated TypeScript checks
and formatting/lint passed after this test-fixture correction.
A third CLI round reproduced an owner-revocation race: a global administrator
revoked from another event could still qualify through speaker participation,
without advancing the inspected event's cursor. Readiness task commands now carry
an explicit internal boundary and atomically require the selected owner to retain
an accepted organiser grant. The regression verifies unchanged cursor, retained
speaker participation, zero created tasks and retirement of the stale preview.

Focused Worker coverage includes 26 scenarios in `ai-readiness-workflow.test.ts`,
alongside existing provider/tool coverage: evidence-linked creation/reload,
edits/rejection, atomic review rollback, stale approval and retirement, intervening
event changes, scope denial, crash recovery, provider failure, unknown/partial usage,
cache-write pricing, exact source-link validation and streaming usage normalisation.
The earlier AI regression set passed 177 tests across 20 files. All 19 Chromium checks across
`assistant-readiness.spec.ts` and `assistant.spec.ts` passed; eight retain explicitly
simulated-model recordings, screenshots and reports separately from real acceptance.
The added browser case reloads after task creation with interrupted result recording,
inspects the persisted task link and retries approval to finish recording the same task.
The latest browser case asks readiness again and verifies the existing task source
card without another approval preview. Two initial browser runs exposed ambiguous
report/alert test locators; the full rerun passed after scoping them appropriately.
After the runtime fixes, `npm run check:core` passed in 398.2 seconds: formatting, regenerated
types/TypeScript, 666 unit tests, 2,042 Worker tests, one agent test, the production
build and repository/configuration contracts, including recovery and OpenAPI.
Receipts are `.artifacts/assistant-review-loop/round-3.core.log` and
`round-3.browser.log`. A fresh five-scenario Workers AI run passed after all
CLI-loop fixes, using the exact source fingerprint that cleared the fourth review:
`29f605e052d0c0eddb18370c7f99911d2cc9e49cc53bc5dea31cb363b7719a29`.
Receipts are `.artifacts/assistant-workflow/live/2026-10-19T16-51-23-919Z-bcd9c631/`
(`scenarios.json`, `test-results.json` and `run.log`). The success used three real
model calls in 16.367 seconds, selected the requester from two eligible organisers,
and verified the edited, approved task through a fresh service read. All five
scenarios passed; the provider-failure case deliberately injected its second-call
failure after one real model call. This run predates the 20 October record-scope
and delivery-link corrections above.
Both core and browser gates were repeated after the organiser-revocation race fix,
including the corrected test fixtures.
The full release gate was not run for this uncommitted review; deployment remains
a separate step.

Deployed acceptance of this new source, assessments and additional OpenAI/Anthropic
provider runs remain outstanding. No deployment, shared evaluation reset or
continuation of the stopped independent evaluation is claimed.

## Sponsor assets and readiness — 19 October 2026

**Production slice, local; not deployed.** This slice
adds private named logo/document requests, accepted-contact multipart uploads,
scan-gated downloads, version-specific organiser approval/change requests, and
explicit selection of approved logos into the event website draft. Public logo
bytes require the exact published snapshot reference; publication revalidates
approval and current file availability. Migration `0060_sponsor_assets.sql`
adds scoped requests, retention guards and the publication invariant.

The sponsor readiness view filters invitation acceptance, sessions to submit,
assets needing sponsor action, organiser review, approaching/overdue deadlines
and ready companies. Filtered reminders create ordinary editable Communications
drafts after recomputing recipients; they exclude scanning, organiser review and
closed editing periods. Filters reset correctly on Clear and history navigation.

Review corrections add editable website details during logo selection, preserving
longer company profiles and optional company tiers; a clear-logo control keeps
the website sponsor record while allowing publication after replacement or
erasure. Expired pending uploads count as sponsor action and reminder work,
while uploads already completing remain recoverable. Public delivery rechecks
publication and file release after the R2 read and cancels revoked response bodies.

The requested Codex review/fix loop additionally found and fixed company-scoped
multipart lookup authorization (including cancellation and idempotency reads)
and demo-contact downloads incorrectly inferred from an incidental `role` field.
Portal and organiser downloads now have explicit authorization paths. New
regressions verify company isolation after contact revocation, legitimate
cancellation after the editing deadline, and real authenticated demo downloads.
A second review reproduced and corrected missing retention candidate selection
for sponsor-only uploaders and disagreement between displayed/reviewable versions
while replacement erasure awaits storage cleanup. Version creator attribution
now participates in retention; shared identities remain available to other events.
The three requested Codex review passes returned two, two and zero actionable
findings. All four distinct findings were accepted and fixed; repeated copies
of the CLI's final comments were recorded as duplicates requiring no separate
fix. Review transcripts, assessments and check logs are captured locally in
`.artifacts/sponsor-assets-review-loop-NoBC7uuV/`.

Review-loop validation: `npm run check:core` passed in 722.1 seconds,
including 666 unit tests, 2,016 Worker tests and one agent test, TypeScript,
production build, Biome, migration validation, audit/API contracts and the backup
recovery drill. All 50 focused upload/asset tests and 35 asset/retention tests
passed, as did generated TypeScript after each review's fixes. The 18 sponsor-asset
tests cover public copy validation and private-profile preservation, expired-upload
reminders and restart, recoverable completion, withdrawal/file revocation during
the R2 read, company isolation, contact downloads and review during pending erasure.
Retention tests cover sponsor-only uploaders and shared canonical identities.

All three relevant Playwright workflows passed against the final build in
101.8 seconds, with accessibility checks:
asset requests, acceptance, filter clearing/history, reminder drafts, honest
unconfigured upload failure, private download, organiser review, editable website
copy for long company profiles with blank tiers, private website preview,
publication and clearing stale logos while retaining sponsor records; existing
sponsor session approval/revocation and speaker deliverables remain covered.
Expired uploads appear as actionable in the real readiness interface. Browser
coverage uses explicitly seeded local clean-file and expired-upload fixtures;
synthetic pending intents are cleaned up even when assertions fail. Worker tests
exercise real local D1/R2 multipart
completion with an explicitly simulated scanner callback. No live provider
acceptance or production deployment is claimed.

The complete merge gate (`npm run check`) subsequently passed in 667.0 seconds
against implementation commit `2c081adc`, including the core gate (384.2 seconds),
dependency vulnerability policy, 241 application browser tests, 12 production-shaped
evaluation browser tests and 16 public website browser tests. The two opt-in
performance evidence cases were skipped as configured. Coverage includes
Chromium desktop/mobile/laptop visuals, Firefox/WebKit smoke and accessibility.
The complete log is `.artifacts/sponsor-assets-review-loop-NoBC7uuV/merge-check.log`.

Boundaries: company-wide editing deadline, up to 20 requests per company, raster
logos and supporting documents under existing file policies. No automatic
publication, automated reminder sending, document publication, per-asset deadline,
sponsor editing of accepted sessions or new versioned REST resources.

## Sponsor portal and deliverables release — 19 October 2026

**Production slice, deployed.** `/admin/sponsors` manages
company profiles, tiers, session allowances, event-local editing deadlines and
contacts. `/sponsor` lists authenticated invitations and company workspaces;
acceptance, profile editing, session drafts/submission/withdrawal and organiser
approval persist in D1. Migration `0058_sponsor_portal.sql` adds three scoped
tables. Approval reuses direct-session creation and leaves participation pending
and the session unpublished. Contact restoration requires fresh acceptance.
Invitation preparation creates an editable Communications draft, not a send.

Review fixes add migration `0059_sponsor_retention_guards.sql`: event retention
deletes private sponsor profiles, contacts and proposal snapshots, including
accepted/withdrawn proposals and people never added to the roster. Database
guards block subsequent inserts/updates and scope changes, and the migration
cleans up rows left by earlier completed retention runs. Accepted programme
sessions remain; other-event sponsor identities and records are preserved.
The retention confirmation screen discloses removal of private sponsor intake.
Completion integrity covers all three tables. New sponsor audits contain only
identifiers; existing immutable audit history is not rewritten. Invitation
preparation follows the original template's current published version.

`/admin/tasks/deliverables` adds active-speaker rows, requirement columns,
status/search/requirement filters, pagination, evidence links, deadline extensions
and filtered reminder drafts across all matching pages. It uses the existing
Task and Communications services. Source inspiration is Trackstage's sponsor
portal and Conferencer's deliverables matrix; this is not a claim of complete
feature parity with either repository.

Reminder recipients now exclude administrator-only work even when the existing
participant-access flag is true. Filter controls remount from loader filters,
including Clear and browser history navigation. Review regression evidence:
33 focused Worker tests passed across sponsor service/retention, participant
retention, deliverables rules and the route; the forward migration upgrade test
and generated TypeScript check also passed.

Source `2663a312740bec2446f4874c91de4ea5957175c3` was deployed on
19 October as Worker `1286692b-673d-411b-8e33-8093c2d63740`. The ordinary
`npm run deploy` gate passed in 1,319.0 seconds: 666 unit tests, 1,996 Worker
tests, one agent runtime test, 240 browser tests (two configured opt-in
performance skips), 12 local public-application authentication tests and 16
public-website tests. Build, TypeScript, formatting, configuration, scanner,
migration, audit, recovery, OpenAPI and dependency policy checks passed.
Production preflight verified a clean checkout, the required secrets and the
migration prefix. Migrations `0058` and `0059` applied; the remote schema check
passed with 60 migrations, and health reported the exact deployed source.

Earlier focused validation hit the existing five-second multipart headshot
timeout; its isolated unchanged rerun passed. The release now gives that
multi-step test 15 seconds and each 19-page accessibility sweep 90 seconds,
without removing assertions. Two subsequent release attempts passed core but
lost the local Wrangler proxy during browser navigation and stopped before
production changes. Waiting for outstanding requests after each accessibility
surface passed all ten focused accessibility tests and then the complete release
gate. The independent AI evaluation was not run.

Focused Worker evidence covers company/event/organisation isolation, acceptance
and revocation, concurrent allowance enforcement, idempotency, stale revisions,
deadlines and atomic approval rollback. A production-mode test verifies durable
speaker invitation creation and dispatch to a test queue, with no live email.
Matrix and route tests cover historical assignments, unassigned cells, pagination
audience, actionability, server-recomputed reminder recipients and filtering.
Real-browser sponsor submission/approval/revocation and matrix deadline/reminder
workflows passed, including WCAG A/AA checks. The affected mobile Tasks baseline
was updated and reviewed; the focused desktop/laptop/mobile run passed all five
cases.

A bounded live browser check in the separate controlled invited-speaker event
verified sponsor creation/contact access, invitation draft preparation after
publishing revised template wording, ordinary speaker authentication, sponsor
acceptance, proposal submission and organiser approval. The accepted sponsor
proposal becomes read-only. The live matrix selected zero reminder recipients
for administrator-only work and one for an outstanding speaker checklist. Clear,
back/forward navigation and reapplying the cleared form kept URL, controls and
results consistent. The checklist reminder produced a one-recipient preview.

Read-only D1 verification confirmed one accepted proposal linked to an
unscheduled direct session, no CFP source, and pending speaker participation.
The two invitation messages and one reminder remained drafts; the existing two
deliveries and published schedule were unchanged. Anonymous checks confirmed
the new session was absent from the public programme and the sponsor portal
required sign-in. No email was dispatched, no programme change was published,
and no shared fixture reset was performed. Private screenshots, browser receipts,
before/after database observations and release logs are retained under ignored
`.artifacts/sponsor-release-20261019/`.

Boundaries: the matrix covers speaker-target tasks; session/event deliverables
remain in Tasks & readiness. At that release there was no sponsor file-upload flow (added locally above).
No new REST resources, sponsor-side editing of accepted sessions or automatic public sponsor publishing.
Programme publication
still enforces existing consent/readiness/conflict gates. The independent AI
evaluation remains stopped. Retention erasure and post-erasure rejection have
automated Worker/migration evidence; no live erasure was performed.

## Current position

- Source `2663a312` deployed on 19 October after the complete release gate
  passed (1,319.0 seconds), with migrations `0058` and `0059` and exact-revision
  health verified. Sponsor portals, speaker deliverables and the four review
  corrections are deployed; acceptance evidence and boundaries are recorded above.
- The modular monolith has connected Worker/D1-backed product slices. Repository
  coverage does not establish replacement readiness or live-provider acceptance.
- Source `00d47fb3` was deployed after the full release gate on 18 October at
  05:52 UTC; exact-revision production health passed. The October workspace
  priorities and invited-speaker preparation are deployed. Bounded live
  `/evaluate` checks verified the organiser workspaces and session-form handoff
  for an existing unaccepted prospect, including reload. A separate controlled
  production event subsequently passed direct session creation before new-event
  acceptance, delivered invitation, ordinary magic-link sign-in, separate role
  confirmation, checklist/upload completion, clean file release and publication.
  The returning-speaker boundary and subsequent user-confirmed inbox check are
  recorded below.
  No shared fixture reset was performed.
- Source `a54f37c1` was subsequently deployed on 18 October after the complete
  release gate passed on retry (793.9 seconds). Publication confirmation now
  distinguishes schedule-change emails from separate calendar invitations.
  Exact-revision production health passed. The earlier five-shard run hit a
  tablet accessibility timeout; the unchanged case passed in isolation, then
  the entire release gate passed with three browser shards.
- Source `41420df2` was deployed on 19 October after the complete release gate
  passed in 916.1 seconds. It restores publication-dialog focus after preview
  refresh. Exact-revision health and live Cancel, Escape, keyboard reopening,
  disclosure and reload checks passed. Published version 1 and the two existing
  communications remained unchanged; no publication or evaluation was submitted.
- Scanner source `38a5ad24` was released on 18 October. The live journey exposed
  TLS trust failures in signature updates from the aged September image. The fix
  passed the full release gate and exact-revision health; all four container
  slots rolled out at 09:22 UTC. A fresh retry scanned and released the original
  upload at 09:29 UTC, and its authenticated download matched every source byte.
  A later isolated Cloudflare canary also verified real refresh from September 9
  signatures to October 18 signatures, daemon reload and restored readiness.
  The temporary Worker, container application and registry image were removed.
- External endpoint path/query confirmation and AI review-aid evidence labels
  retain local regression evidence; the latest run did not exercise those paths.
- The latest completed scored run, `2026-09-13T08-07-46`, finalized all 22 scenario outcomes and judging:
  13 completed, eight blocked, one feature unavailable. Coverage was **51.155%**;
  the 60% gate exited 2 and the overall score remains withheld. All 1,230 artifacts
  verified. The pinned AEK `05823a0` run had no provider timeout, captured rendered
  email previews and delivered checkpoint images to judging. Direct session
  creation, claimed biography, 2:1 scoring, AI assessment, speaker upload/download
  and CRM workflows progressed; content and scheduling blockers remain below.
- The 18 October run was stopped at the user's request at 09:33:57 UTC. Four
  scenarios completed collection before interruption during ABS-S2; no judging
  or score was produced. Partial evidence and production fixture state remain
  intact. Do not resume or reset without a new explicit instruction.
- The fixture was reset at **11:03:42 UTC** on 13 September. All four saved persona
  sessions were invalidated, clean applicant/reviewer baselines and no selected
  persona verified, and application health matched `5a758933`.

Status terms:

- **Production slice / foundation:** connected production behavior or shared
  infrastructure, with server authorization, validation and durable storage as
  applicable. Deployment and provider acceptance are stated separately.
- **Frontend foundation / schema only:** interface or schema without the connected
  production behavior; neither counts as a completed requirement.
- **Demonstration only:** explicitly gated fixtures or simulations.
- **Not implemented / external acceptance outstanding:** absent behavior or an
  existing path that still lacks the relevant external verification.

## Invited-speaker preparation — 15 October 2026

**Production slice; deployed 18 October 2026.** Organisers can prepare and manually
place a session for an active speaker on the current event roster before portal
acceptance. Canonical profiles and pending participation remain unchanged;
publication still requires the existing participation, profile and content checks.
The additional identity permission requires a same-event non-revoked speaker
membership and active organisation contact/workflow, and is rechecked atomically.
Existing unrelated identities and other-event prospect associations remain blocked.
The organiser UI and API share this rule; OpenAPI contracts are synchronized.

Seven focused service regressions cover creation, placement, idempotent retry,
publication refusal, inactive records, event/organisation isolation and a concurrent
roster withdrawal. The updated Chromium handoff creates the session and verifies
it after reload. Related route/intake/API checks and regenerated TypeScript passed.
Dependencies were updated to resolve the release audit blocker; the audit now
passes the unchanged high-severity gate with seven low findings remaining.

The full release check passed its core lanes: 666 unit tests, 1,974 Worker tests,
the agent test, generated types/TypeScript, lint, production build, configuration,
schema, recovery and OpenAPI checks. Its first browser run exposed a missing
keyboard scrolling target in the schedule session list, stale expectations for
the merged workspace controls and Scalar's descriptive copy labels, and an
orphaned local Firefox lock. The list is now keyboard-focusable, with a real
tablet keyboard-scrolling assertion; the tests exercise explicit template
selection and opening the placement form. The full browser rerun passed 237
checks with two opt-in performance checks skipped and one remaining test-locator
failure. After correcting that locator, all three event-context tests passed,
including invited-speaker acceptance and task access. All 238 application browser
contracts therefore have passing evidence across the rerun and focused correction;
the separate evaluation suite passed 12 tests and the public-site suite passed 16.
Final lint, TypeScript and the five schedule-workspace unit tests also passed.
The initial `npm run check` failure was resolved through these post-fix checks;
the entire core suite was not repeated after the browser-only corrections.

**Release evidence, 18 October:** replacing the invalid deployment token resolved
the earlier 9109 blocker. The ordinary `npm run deploy` passed the complete gate
in 748.9 seconds, verified all 58 already-applied migrations and the remote schema,
and deployed `00d47fb380822d20e55a08586e4def99159e9c2a`. Exact-revision health passed.
Live `/evaluate` checks verified the speaker's three next-step links and the
prefilled session form with no portal-acceptance blocker, including after reload.
The existing prospect had no accepted organisation membership or proposal/session
links; a post-check confirmed acceptance remains unset and no session was created.
The live scope covers navigation and server-loader eligibility; session mutation,
idempotency and publication refusal were exercised by the local release gate.
Receipts and before/after screenshots: `.artifacts/release-20261018/`.

## Controlled production journey — 18 October 2026

**Publication wording follow-up:** the confirmation now says that disabled
schedule-change emails will not be sent and separately explains that calendar
invitations and updates may still be emailed. The calendar notice appears in the
notification section for every change-email state. The focused Chromium
publication workflow, generated TypeScript and Biome passed. This changes the
disclosure only; delivery behavior and publication guards are unchanged.
Source `a54f37c168d64ab16aefc5a1fd959032643505a4` was deployed as Worker
`6388fca7-0f93-4288-8367-5254f46fae15`. The complete release gate passed on retry
in 793.9 seconds, including all 238 application browser checks, 12 local access
checks and 16 website checks; two opt-in performance checks were skipped.
The initial five-shard run timed out in the unchanged tablet accessibility sweep.
That case passed in isolation and the full retry passed with three browser
shards, without code changes or test exemptions. All 58 migrations were already
applied; remote schema validation and exact-revision production health passed.

The live disclosure check exposed a separate focus defect: preview refresh
disabled the Publish button before the dialog captured its return target, so
Cancel returned focus to the document body. Mouse and keyboard checks reproduced
it in production, and the new local regression failed on the unchanged build.
The follow-up now captures the initiating button before refresh and passes that
stable target to the publication dialog, preserving its existing blocker links'
focus overrides. The regression passes Cancel, keyboard reopening and Escape;
generated TypeScript and Biome also pass.

Source `41420df2d1aa852f46942ab085af3b9504008943` was deployed on 19 October as
Worker `19adc1db-3e8a-4b1f-b98b-63b08a0d5831`. The first release attempt stopped
at the existing headshot workflow's five-second Worker-test timeout. That test
passed unchanged in isolation (2.24 seconds), and the ordinary deployment retry
with two Vitest workers passed the entire release gate in 916.1 seconds:
666 unit tests, 1,974 Worker tests, one agent test, 15 scanner tests, all 238
application browser checks, 12 local access checks and 16 website checks.
The two opt-in performance skips and seven low dependency findings remain.
Remote schema validation, all 58 already-applied migrations and exact-revision
production health passed; no checks were exempted.

At 00:18 UTC, the live browser verified both disclosures, reload, Cancel focus,
keyboard reopening and Escape focus. The anonymous programme remained accessible
with the existing session. The earlier disclosure check had prepared draft
version 2 in this controlled event; the final check created no additional draft
and submitted no publication. Before/after D1 reads retained published version 1,
unpublished draft version 2 and exactly two communications. No shared fixture
reset or independent evaluation run occurred. Receipts, screenshot and release
logs are private under `.artifacts/publication-followup-20261018/`.

A separate synthetic event, `invited-speaker-live-20261018`, exercises the
invited-speaker path on application `00d47fb3` without resetting the shared
evaluation fixture. The organiser added the existing controlled showcase speaker,
created and reloaded a direct session with no CFP submission, and placed it before
acceptance of the new event invitation. Adding the roster record sent no mail;
explicit session creation queued one invitation. Resend recorded delivery on the
first attempt. Opening the link from the stored copy of that sent message in a
fresh browser established an ordinary Better Auth session. The speaker explicitly
accepted event access and, separately, the primary-speaker role, then completed
a checklist and uploaded the real 569-byte headshot fixture through multipart R2.

The draft programme returned 404 anonymously. Publication was initially blocked
by unapproved content and unconfirmed participation; its confirmation button was
disabled. After the speaker confirmed and the organiser approved the exact content
revision, the publication dialog reported no blockers. File approval separately
refused quarantined evidence, and anonymous private-file download redirected to
sign-in. These checks did not bypass either gate.

This is a returning speaker, so it does not independently isolate the new
fresh-roster identity eligibility branch. That branch retains the earlier live
prospect loader check and local atomic-write regressions. The delivery webhook
and real magic-link authentication alone do not establish mailbox rendering or
inbox inspection; the user subsequently confirmed the manual inbox check below.
Receipt details and screenshots are private under
`.artifacts/live-journey-20261018/`.

The upload exposed an aged-signature failure in the September scanner image:
FreshClam could not trust Cloudflare's HTTPS interception certificate (TLS error
60). Source `38a5ad24` supplies the required runtime CA explicitly without
weakening TLS or signature freshness. A real FreshClam HTTPS test rejected an
untrusted synthetic CA and succeeded with the configured bundle; missing runtime
trust failed explicitly. All 15 scanner tests and the complete release gate
passed (736.8 seconds: 666 unit, 1,974 Worker, one agent, 238 application browser,
12 evaluation browser and 16 website checks; two opt-in performance skips and
seven low dependency findings). Scanner Worker `4dd9dc62-478b-422a-83c7-c23a766743a1`
passed exact-revision health, and the container rollout completed at 09:22:07 UTC
with all four slots on image `fe6c98d3a27a6e48dea5b9f5fcb4579d56252d39d96e0b3402fd3540887e77b4`.
The retry begun during rollout still failed readiness and retained quarantine;
a new retry after rollout completed with a clean verdict at 09:29:39 UTC,
using ClamAV 1.4.6/signatures 28157 and scanning all 569 bytes. The authenticated
speaker download matched the fixture exactly; anonymous access remained denied.
The organiser approved the file task and both tasks persisted as completed.
Schedule version 1 was published at 09:30:40 UTC. The anonymous programme exposed
the expected speaker, session and 09:00–09:30 America/Toronto placement, including
after reload. D1 confirmed published status, confirmed participation and a null
`source_submission_id`. Publication also queued a calendar invitation; Resend
recorded delivery on its first attempt. Schedule-change email was disabled, but
calendar delivery was separate. This exposed the publication dialog's broad
“No participants will be emailed” wording, corrected in the follow-up above.
The completed workflow proves hosted scan/callback/R2 transport with fresh baked
signatures. The later canary below establishes aged-signature refresh separately;
sustained scan load remains an acceptance boundary.

### Hosted aged-signature refresh — 18 October 2026

An isolated, authenticated Cloudflare Container started from the retained
September scanner image with signatures **28118, built 9 September**. Its Python
adapter matched the production file byte-for-byte; the only image change was the
already-deployed `38a5ad24` entrypoint trust fix. The canary inherited production
HTTPS interception, TLS verification and the seven-day loaded-signature limit.
It allowed outbound access only to `database.clamav.net`, had one container slot
and no D1, R2, Queue or production-data binding. Initial setup omitted required
R2 metadata and failed explicitly; valid metadata naming an unbound dummy bucket
resolved that canary configuration error before acceptance began.

After daemon startup, readiness remained HTTP 503 while the old signatures were
loaded. Hosted logs recorded the **28118 → 28157** update, database validation and
ClamAV notification at **23:22:36 UTC**, followed by activation of the newly loaded
database at **23:22:50 UTC**. The **23:23:05 UTC** probe returned HTTP 200/ready.
Anonymous requests returned 401. This proves an actual vendor download through
Cloudflare's interception trust boundary and daemon refresh, without lowering
the freshness limit or replacing the live production image with stale data.

The temporary Worker and container application were deleted and their API reads
returned 404; the canary registry image was deleted and no longer listed. The
production scanner still reported source `38a5ad24`. Receipts, image/adapter
hashes and provider logs: `.artifacts/publication-followup-20261018/`.

### Inbox acceptance — user-confirmed 19 October 2026

The user checked the controlled speaker inbox and reported "all looks correct"
against the requested checks: receipt of the speaker and calendar invitations,
correct sender/event details and readable formatting, and an invitation link
opening the speaker portal with access to the intended event. This closes the
controlled journey's inbox acceptance through user-reported manual verification.
No agent-side mailbox inspection or new inbox screenshots were collected; this
does not constitute an independent evaluation result.

No usable AgentMail or Purelymail credential was found in the local environment,
project configuration or saved credential-location references. A live MX lookup
for `programcue.com` returned `mailserver.purelymail.com`; forwarding to AgentMail
has not been verified. The deployment token lacks the separate Cloudflare mail
routing permission, so that read-only lookup could not establish forwarding.
Mailbox integration is unnecessary for this completed manual check. Provider
routing remains unverified; the inbox evidence comes from the user's confirmation,
separately from the existing Resend delivery webhooks and stored message copy.

### Independent evaluation stopped at the user's request

Collection `2026-10-18T08-48-13` exhausted its 120-call budget during CFP-S1 after
event/form/template setup, leaving dependent scenarios blocked. Its 84 artifacts
verified. The event was retained as `DevFlow setup probe — 18 October 2026`;
no shared fixture reset was performed. A subsequent run,
`2026-10-18T08-59-49`, used a 200-call budget and Codex as the selected judge
because the configured Claude login was unavailable. Before judging began, the
user explicitly instructed that the evaluation not run. SIGINT stopped the
runner and its provider process at 09:33:57 UTC (exit 130).

CFP-S1, CFP-S2, ABS-S1 and CFP-S3 completed collection: event/CFP/template setup,
draft recovery and two submissions, a third proposal and co-speaker claiming,
then reviewer invitation, isolated assignment and submitted scoring. ABS-S2 was
interrupted during collection. These are partial collector outcomes, not judged
criterion results or replacement-readiness acceptance. There is no new score,
coverage result or complete sealed acceptance bundle. The earlier September
score boundary remains in force. Retain the unfinished fixture and evidence;
do not resume collection, judge or reset without new authorization. Stop receipt:
`.artifacts/live-journey-20261018/evaluation-stopped.json`.

## Local workflow presentation — 14 October 2026

**Production slice; deployed 18 October 2026.** The connected schedule planner starts
with its inspector collapsed below 1440px, keeps placement selection separate
from opening details, moves break creation to a toolbar dialog and AI copy to
session details, and retains day/room/time context in the scrolling calendar.
Tasks defaults to Outstanding with Overdue, Needs review and All quick choices;
additional filters, revision details and readiness explanations use disclosures.
Blocked tasks name and link their unfinished prerequisites. Session creation uses
**Add session**, and published schedules offer **Edit next version** with an
explicit unchanged-publication explanation.

Command centre leads with the ranked action and linked counts for decision-ready
proposals, distinct participant owners with incomplete speaker or session requirements,
sessions without an active-version placement, and submitted tasks. Readiness
calculation remains below those queues. The exact count definitions are recorded
in [DECISIONS.md](DECISIONS.md).

Evidence: focused component/service tests, `e2e/schedule-calendar.spec.ts`,
`e2e/task-bulk-undo.spec.ts`, and refreshed laptop schedule/task plus desktop/mobile
Command centre and mobile task snapshots. The 18 October release additionally
verified the live Command centre priorities, default Outstanding task filter and
collapsed/openable laptop schedule inspector through `/evaluate`. This does not
establish external-provider acceptance. Browser evidence remains scoped; a full film render
was not requested or run. The film's pinned snapshot hashes are synchronized with
the reviewed captures. Review corrections add in-dialog
break failure/progress/committed-warning coverage, fitted Day/Week calendars,
a bounded 1024px room grid, active custom-filter indicators and accurate empty
queue guidance. Command centre readiness/action annotation frames were rendered
and visually checked against the refreshed screenshot; this is preview evidence,
not a newly released film.
The fallback review also verifies that missing or malformed dashboard counts fail
explicitly and incomplete break responses show an error with submission stopped:
19 readiness service checks and five break-creation Chromium workflows passed.
The requested CLI review found and reproduced a collapsed mobile room grid at
375×667. Mobile agenda and Track content now grow with the page, while room and
Day/Week calendars scroll within their own bounds. A subsequent review found
clipping in longer tablet Track views, which now expose a labelled keyboard
scrolling region. Eleven selected schedule checks, including 375×667 and 412×915
regressions and a tablet track with seven additional real session placements,
plus the laptop visual check passed. The laptop snapshot required no change.

Before local merge, `npm run check` passed its core gates with
`VITEST_MAX_WORKERS=4`: 666 unit tests, 1,967 Worker tests and one agent test,
plus build, types and repository contracts. The initial uncapped run hit the
existing headshot test's five-second timeout. The full retry stopped at the
dependency audit (28 vulnerabilities: seven low, six moderate, 14 high and one
critical). That workspace-priority change did not update the dependency manifests. The complete browser,
evaluation and public-website gates did not run because the audit failed; the
earlier focused browser checks passed. That attempt did not establish a passing
release gate; the successful 18 October release supersedes it.

## Latest recorded deployments

| Surface | Latest retained evidence | Boundary |
| --- | --- | --- |
| Application | `2663a312740bec2446f4874c91de4ea5957175c3`, Worker `1286692b-673d-411b-8e33-8093c2d63740`, deployed 19 October; complete release gate passed (1,319.0 seconds), migrations `0058`/`0059` applied and exact-revision health passed. | Sponsor portal and deliverables release; controlled live acceptance and boundaries recorded above. Earlier publication focus and invited-speaker acceptance evidence remains below; no shared fixture reset or independent AI evaluation. |
| Public website | Bundle `67d5b4b4`, Worker `e9398ee9-5a85-4c73-b751-0de7468c0032`, deployed and exercised on 5 September. | Separate website release; includes the approved film and guide pages. |
| Scanner | Source `38a5ad247b0c1199542a89348d2fbc7223b9abd6`, Worker `4dd9dc62-478b-422a-83c7-c23a766743a1`, deployed 18 October at 09:20 UTC; container rollout complete at 09:22 UTC. Full gate, exact-revision health and real headshot scan/release/exact-byte download passed. | FreshClam trusts the required interception CA; real TLS positive/negative regression passed. The live file retry used fresh baked signatures; a later isolated hosted canary verified aged-signature download, validation, daemon reload and restored readiness. Sustained burst capacity remains outstanding. |

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
| Participants and tasks | **Production slice.** Independent Speaker/Moderator/Chair responses, participant workspace, availability, reusable event fields, task evidence snapshots, comments, dependencies, roster CSV and read-only organiser preview. Speaker creation links to confirmed portal invitation controls, a prefilled Add session form and onboarding assignment with the speaker selected. | Custom fields have fixed types, without formulas or conditional rules; newer reminder paths need live evidence; the controlled returning-speaker creation handoff passed on 18 October. |
| Speaker Network | **Optional competition production slice.** Organisation-scoped history, contacts, tags, segments, sourcing/imports and event outreach at `/admin/crm`. | General CRM is excluded; participant adoption is deferred and the newer organiser-created mutation lacks live acceptance. |
| Files and resources | **Production slice; partial live acceptance.** Private multipart upload, quarantine/scanner release, versioned resources, typed embeds, bounded asset/history reads, confirmed durable ZIP exports, retention and erasure. | Sustained live scan load and broader provider-side erasure. Hosted scan/callback/R2 transport and isolated aged-signature refresh passed on 18 October. |
| Schedule and content | **Production slice.** Authoritative conflicts, deterministic subset auto-placement, editorial revisions/restoration, approval gates, immutable publication, read-only published planning, breaks/resources and placement undo. | Production drag pacing and scale; publication always rechecks conflicts and content invariants. |
| Scenario Lab and readiness | **Production slices.** One ranked next action, scoped readiness, up to ten private proposals against the active draft, stale-proposal rejection and atomic bounded publication digests. | Scenarios are not independent schedule versions; newer UX/AI increments have repository acceptance only. |
| Public programme and embeds | **Production slice.** Published programme, speakers, timetable/day-by-day schedule, gallery, itineraries and calendars; configurable stateless and managed embeds with audited lifecycle. | Installation detection/analytics and XML output are absent. Private file and published-data restrictions remain enforced. |
| Confidential programme review | **Production slice; separate disclosure path.** Frozen draft snapshots, explicit disclosure confirmation, hashed expiring capabilities, revocation and publication-triggered revocation. | Does not count as published-only public programme delivery. |
| Event branding | **Production slice; schema deployed.** Revisioned draft, desktop/mobile previews, normalized image pipeline and explicit publication. | Live branding-image acceptance; custom fonts/CSS/domains and private-asset copying during cloning are absent. |
| Public event site | **Production slice; deployed with local acceptance.** Event-scoped draft/publication, six fixed homepage sections, five optional pages, sponsors and recordings; can publish CFP content before an agenda. | Programme-dependent sections require published data. Generic blocks, arbitrary HTML/CSS and media processing are absent. Sponsor-asset upload and explicit logo selection are implemented locally above, not deployed. |
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
| ADM-001–005 | Command centre, D1/Airtable event creation, setup, invitations, organisation/event grants, switching and role matrix connected. |
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
| UX-001–010 | Search/saved views, readiness, review workspace, consequence previews, recovery, undo, AI, walkthroughs and Operation centre connected; manual accessibility acceptance outstanding. |
| CMP-001–013 | Repository and deployed evaluator evidence exist, but a completed independent evaluation, Forge/submission/reimbursement/judging and walkthrough evidence remain external. |
| OUT-001–005 | General CRM, broad marketing automation, generic CMS, payments and multilingual expansion excluded. Speaker Network is a bounded extra-credit slice, not frozen base scope. |

## Verification evidence

These are dated records, not a blanket assertion about future working trees.
[Contributor guidance](../AGENTS.md#validation) defines the required gate for each
change. The latest complete gate supersedes older test-count histories.

| Scope | Recorded result | Limit |
| --- | --- | --- |
| `38a5ad24` scanner and controlled production journey, 18 October | Full `npm run check` passed in 736.8 s: 666 unit, 1,974 Worker, one agent, 15 scanner, 238 application browser, 12 evaluation and 16 website checks, plus types/lint/build/configuration/schema/recovery/OpenAPI/dependency gates. Real FreshClam TLS trust positive/negative checks passed. Scanner deployed and all four image slots rolled out; original uploaded file scanned clean, released and downloaded with exact-byte equality. Direct invited session, real invitation authentication, separate participation confirmation, two onboarding tasks and anonymous published programme passed. | Returning controlled speaker; sent-message link used without inbox inspection. One retry started during rollout failed closed before a fresh retry succeeded. Two opt-in performance skips and seven low dependency findings. Sustained load and aged-image production refresh not established. Receipts: `.artifacts/live-journey-20261018/`. |
| `00d47fb3`, 18 October | `npm run deploy` completed the full release gate in 748.9 s: 666 unit tests, 1,974 Worker tests and one agent test; types, lint, build, configuration, scanner, schema/recovery/OpenAPI and dependency policy; 238 application browser, 12 evaluation and 16 website checks. All 58 migrations were already applied; remote schema, deployment and exact-revision health passed. Bounded live `/evaluate` checks passed with no observed server errors. Receipts: `.artifacts/release-20261018/`. | Two opt-in performance tests skipped; seven low dependency advisories remain. Live checks used the existing showcase and prospect without submitting a session, sending notifications or resetting the fixture. No new full AEK acceptance run or separate scanner/public-site deployment. |
| Post-feedback handoff review, 14 October 2026 | The requested Codex/high review resumed after both user findings were fixed. Round 3 reproduced an inactive-speaker onboarding link to 404; the finding was accepted and fixed with persisted workflow status and restoration guidance. All 18 affected Worker tests and four targeted Chromium cases passed. Latest completed round 5 reported no actionable regressions after 24 focused unit/Worker tests, generated TypeScript and two active/inactive Chromium handoffs passed. No findings were dismissed. Findings and rationale are captured in `.artifacts/speaker-handoff-review-loop/triage.json`. | Round 4 was interrupted while correcting an isolated-test fixture leak and is excluded from acceptance. Local fixtures only; full release gate and deployment were not run. |
| Persistent speaker handoff, 14 October 2026 | Next-step controls now come from the loaded focused roster record and speaker detail as well as the creation response. The session link explains the portal-acceptance prerequisite before form entry, using the existing server identity rule; Worker coverage verifies it clears after access acceptance. The Chromium handoff follows invitation → reload → detail → onboarding → roster search → detail → session using visible links, without cached invitation/session URLs. Eighteen focused Worker tests, four targeted Chromium workflows, regenerated TypeScript, build and Biome passed. Review additionally found inactive-record onboarding links that led to 404; controls now explain restoration, with declined/withdrawn and active-restoration browser coverage. The expanded workflow exposed a long-email D1 `LIKE` failure; literal substring search and case-insensitive long-email/partial-name/wildcard regressions passed. | Local fixture evidence only; the first browser attempts required navigation-wait correction and exposed the search bug. The integrity regression uses an isolated record after correcting shared-fixture pollution. Full release gate and deployment were not run. |
| Codex speaker-handoff review loop, 14 October 2026 | Two runs of `codex exec review --uncommitted -m gpt-6.1-sol -c 'model_reasoning_effort="high"'` each reported no actionable regressions or individual findings. No additional fixes or dismissed findings. Both reviewed the same patch without modifying source. Round 1 passed 29 focused unit/Worker tests; round 2 passed nine focused and 85 related tests. Generated TypeScript checks, production build and Chromium handoff passed in both rounds. Findings, raw logs, patch snapshots and triage are captured in `.artifacts/speaker-handoff-review-loop/`. | Local fixture and source-review evidence only; full release gate and deployment were not run. |
| Speaker handoff fail-fast follow-up, 14 October 2026 | Removed submitted-name substitution for missing saved roster data and automatic replacement of unavailable task templates. Supplied blank speaker identifiers now return 404 in both handoff loaders. Six unit tests, three Worker tests, generated TypeScript checks, Biome and build passed; all four Chromium CRM workflows passed, then the updated handoff/blank-identifier check passed on the final build. Injected roster-read failure verifies an explicit integrity error and a retry that creates no duplicate identity. | Local fixture evidence; full release gate and deployment were not run for this focused follow-up. Optional biography and ordinary unprefilled creation remain valid states. |
| Speaker handoff review, 14 October 2026 | Restricted onboarding handoffs to speaker templates, with an explicit empty state; reset form/assignment selections when speaker context changes; made the portal-access notice follow the entered email. Six focused unit tests, 28 Worker tests, regenerated TypeScript checks, Biome and build passed. All four Chromium CRM tests passed, followed by the strengthened handoff test covering task context clearing/back navigation and Add session command/back navigation. Worker coverage rejects both another event's and another organisation's roster records. | Local fixture evidence only; full release gate and deployment were not run for this focused review. The history regression waits for restored route data before acting. |
| Speaker creation handoff, 14 October 2026 | Next-action controls and keyboard focus; event-scoped session prefill and portal-access prerequisite; onboarding target preselection; Add session wording across planner, programme, breadcrumbs and commands. Biome, regenerated TypeScript checks, build, 44 creation/task-related tests, 27 focused Worker tests and 47 shell-related tests passed; the updated Worker handoff test passed again. Chromium handoff, existing CRM, direct-session creation, identity review, session lifecycle and isolated scheduling checks passed, along with two desktop/laptop visual checks. | Local fixture evidence only; invitation email explicitly remains unsent in demonstration mode. Initial combined scheduling checks inherited extra session state and passed in a fresh fixture. Full release gate and deployment were not run for this focused change. |
| `c2c402cf`, 13 September | `npm run deploy` passed the full `npm run check` gate in 626.2 s: 665 unit, 1,954 Worker, one Agent and 15 scanner tests; types, quality, build, configuration, schema/recovery/OpenAPI and dependency policy; 224 main browser, 12 local evaluation-access and 16 website checks. All 58 migrations were already applied; preflight/schema and exact-revision production health passed. Two Astra/high code reviews found no actionable issues; 31 evaluation-configuration tests and all three AEK profiles passed. | Two opt-in performance checks skipped; 7 low/3 moderate dependency advisories remain. No deployed evaluation, provider-message test or fixture mutation was performed. Receipts: `.artifacts/reminder-headshot-fixes/`. |
| Timeout and preview-capture corrections, 10–13 September | Production scenarios allow 1,800 seconds including provider finalisation. AEK `05823a0` preserves timeout diagnostics and rejects full-page captures that omit offscreen approved previews. 542 AEK tests, targeted types and installed-package local preview smoke passed. The 13 September deployed run finalized ABS-S2 in 922 seconds, captured rendered viewport previews and completed judging; 68 judge screenshot retrievals succeeded. | No timeout occurred, so timeout-error handling retains local regression evidence. The local upload smoke lacked scanner prerequisites; deployed headshot release/render/download subsequently passed. Receipts: `.artifacts/timeout-preview-fixes/`, `.artifacts/evaluation-20260913/`. |
| Evaluator access corrections | The installed AEK package includes checkpoint-aware image delivery, corrected login-route detection and opt-in read-only preview evidence. The real local merged-email workflow was readable through AEK with its sandbox intact; 30 evaluator tests and three configurations passed. The coordinator consumes AEK plan version 2. | A deployed anonymous probe no longer excluded challenge frames but obtained no token; genuine verification remains manual. AI disclosure authorization is now explicit in the scenario context; no new live AI generation is claimed. Receipts: `.artifacts/evaluator-access-fixes/`. |
| CRM returning-speaker visibility | The directory always shows the returning-speaker count, including zero, with its active-event/session definition. Three Chromium CRM workflows, generated types and focused Biome passed. The 13 September deployed run visibly showed five contacts, three events, zero returning speakers and the definition; top-company filtering, saved segments/notes, duplicate handling and pipeline history worked. | A new cross-event transfer was not demonstrated because the tested contact already belonged to DevFlow. Source/region/focus analytics were not observed. Receipts: `.artifacts/crm-returning-count/`, `.artifacts/release-5a758933/`, `.artifacts/evaluation-20260913/`. |
| `5a758933`, 9 September | `npm run deploy` passed the full `npm run check` gate in 616.1 s: 661 unit, 1,950 Worker, one Agent and 15 scanner tests; types, quality, build, configuration, schema/recovery/OpenAPI and dependency policy; 223 main browser, 12 evaluation and 16 website checks. Production preflight/schema/health passed; all 58 migrations were already applied. Deployed CRM bundle and `/evaluate` access-page checks passed. | Two opt-in performance checks skipped; 7 low/3 moderate dependency advisories remain. Browser workflows used local fixtures; production checks did not mutate the evaluation fixture. Receipts: `.artifacts/release-5a758933/`. |
| `7b27ce4d`, 9 September | Release gate passed after recheck: 661 unit, 1,950 Worker, one Agent, 15 scanner; types, quality, build, configuration, schema/recovery/OpenAPI and dependency policy; all main browser cases passed across the initial run and isolated retry, followed by 12 evaluation and 16 website checks. Two Astra/high source reviews found no actionable issues. | Initial `npm run check` exited 1 on an unchanged pointer-resize test; isolated retry passed on the same build. Two opt-in measurements skipped; 7 low/3 moderate advisories remain. Receipts: `.artifacts/scanner-release-7b27ce4d/`. |
| `6e01f396`, 9 September | Serial `npm run deploy` passed the full `npm run check` gate in 582.0 s: 661 unit, 1,950 Worker, one Agent and 14 scanner tests; configuration, types, quality, build, schema/recovery/OpenAPI and dependency policy; 223 main browser, 12 evaluation and 16 website checks. Production preflight/schema/health passed; 58 migrations already applied, none pending. Deployed `/evaluate` access-page Chromium smoke passed. Receipts: `.artifacts/release-6e01f396/`. | Two opt-in performance measurements skipped; 7 low and 3 moderate dependency advisories remain. Browser suites use local fixtures; the deployed smoke verified access-page availability, not fresh workflow or provider acceptance. |
| Production-health evaluator correction | Actual top-level health contract validated; 25 evaluator tests, three configurations and `check:core` passed (351.0 s). | Readiness does not prove product acceptance. |
| Form-recovery fixes | Shared load/restore choice reconciliation preserves custom fields, stable routing/conditions and revision tokens; removed choices require repair. Validation returns 400; actual revision conflicts retain 409. Toolbar stays below topbar/banner. Focused checks and the full gate passed. Deployed rename → restore → mouse/keyboard save → reload → immutable publication passed. | Bounded production workflow; not full submission/provider acceptance. |
| Follow-up Astra/high review | `codex exec review --uncommitted` reported no actionable findings. Focused tests/types/build passed, as did 25 evaluator tests, three configurations and a clean serial run of all six evaluation-browser tests. | An earlier browser run overlapped a rebuild and is invalid evidence; the serial rerun resolved it. No additional source fixes or deployment. |
| Release-gate accessibility fix | Event Setup's section anchor could falsely announce a page change after validation. Route announcements now ignore anchor-only changes. Astra/high review found no actionable issues; typecheck/build/Biome, three serial browser repeats and the full gate passed. | A concurrent review rebuild invalidated one initial browser attempt; retained separately from passing evidence. |
| Evaluation dependency split | 27 evaluator tests and all three configurations passed. Installed AEK CLI tests cover publication/anonymous dependencies; importer regeneration is identical; Astra/high reviews found no actionable issues; `check:core` passed (366.6 s). The deployed run below verified CFP-S2 starts after blocked anonymous checks. | Evaluator commit `4bc7825b`; application remains `f3f0b887`. Starting a scenario does not establish full acceptance. |
| Proposal handoff and toolbar follow-up | 27 evaluator tests, three configurations, six focused evaluation-browser checks and eight submission/visual checks passed. Review/fix loop repaired canvas collapse and test dependence; final Astra/high review found no actionable issues. Core types, quality, build, 651 unit, 1,924 Worker and one Agent test passed; the full configuration/contracts lane passed on rerun after refreshing the visually reviewed film snapshot pin. | Released as `0d612b82`; the subsequent full gate passed. Deployed toolbar checks passed at 1280×720, 1024×601, 390×700 and 844×390. Local organiser URLs reopen revised proposals and deny gate-only/reviewer access. Deployed CFP-S2 verified the revised abstract as organiser, published its observed detail URL and unblocked CFP-S3. |

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
| Deployed upstream `2026-10-18T08-59-49` | User-stopped at 09:33:57 UTC, exit 130. Four scenarios collected; ABS-S2 interrupted. No judging, score or coverage result. | App `00d47fb3`; scanner changed from `7b27ce4d` to `38a5ad24` during collection. Codex collector, 200-call override; Codex judge selected but never invoked. Fixture preserved and no reset performed. Do not resume without a new explicit request. |
| Deployed collection `2026-10-18T08-48-13` | CFP-S1 budget-blocked at 120 calls; dependent scenarios blocked. All 84 artifacts verified; no judging. | Retained setup event renamed to a dated probe before the subsequent attempt. No shared reset or applicant/reviewer action in this initial collection. |
| Deployed upstream `2026-09-13T08-07-46` | 13 completed, eight blocked, one `feature_not_found`; 17 manual checks pending. Coverage **51.155%**, score withheld, 60% gate exit 2. All **1,230 artifacts verified**. | App `5a758933`, scanner `7b27ce4d`, evaluator `e46a6a1c`, pinned AEK `05823a0`, requested Astra agent/judge, 1,800 s scenario limit. Abstract management 98% / 89.286% coverage; CFP 91.176% / 89.474%; speakers 85.455% / 83.333%; CRM 89.655% / 76.316%. Content coverage 19.355%; agenda/widgets 0%. AI advisory 3.5/5 and separate human assessment 4.0/5 persisted without changing canonical 3.33/5. One CI placement persisted; conflict testing/publication blocked. Reset and all four old-session invalidations verified at 11:03 UTC. Receipts: `.artifacts/evaluation-20260913/`. |
| Deployed upstream `2026-09-10T09-16-55` | Four scenarios completed; ABS-S2 browser called completed but provider finalisation failed at the configured 20-minute limit. No judge or score; `aek verify` rejects the aborted scenario’s unindexed artifacts. | Program Cue `5a758933`, installed AEK master `7a97ab5`, Astra agent/judge requested. Saved submissions/edits, claimed biography and reviewer isolation passed; raw ABS-S2 evidence shows correct 2-assigned/0-submitted progression and readable personalised preview text. Preview screenshot remains blank; AI, session creation, CRM and checkpoint-to-judge delivery untested. Fixture reset and all four old-session invalidations verified at 10:19 UTC. Receipts: `.artifacts/evaluation-20260910/`. |
| Local regression `2026-09-07T02-12-32` | Nine criteria, 100% score and coverage with requested Astra/medium agent and judge; 265 artifacts verified. | Mailpit capture, real ClamAV clean/EICAR scans, versioned downloads/ZIP, anonymous denial and publication. Active baseline `2026-09-07T02-29-38-534Z-67a9d91b487d-ee63187c`; self-comparison has zero drift. Not the 98-criterion upstream suite or hosted-provider acceptance. |
| Local upstream `2026-09-07T11-12-08` | Score withheld at 4.737% coverage; CFP-S1 completed, CFP-S2 blocked at applicant verification, 18 dependent scenarios blocked, 17 manual checks pending. | CLI exit 0 was completion without a coverage gate. Provisional 61.111% is not an acceptance score. Earlier `10-54-20` failed judge OAuth refresh and exhausted its setup call budget. |
| Deployed `/evaluate` `2026-09-08T02-33-47` | Score withheld at 7.368% coverage; CFP-S1 completed, anonymous checks blocked, CFP-S2 ran but its required URL output was blocked, 18 downstream scenarios blocked, 17 manual checks pending. The 60% coverage gate exited 2. | Codex collection and requested Astra judging, 240 calls/scenario and 1,200 s deadline. All 202 artifacts verified. Provisional 89.286% is not an acceptance score. Health matched `f3f0b887` before and after reset. |
| Deployed `/evaluate` `2026-09-08T08-11-18` | Failed in CFP-S1 with `agent_error` / provider exit 1: Codex account usage limit. No completed judging or new acceptance score; the revised proposal handoff was not reached. | Same 21-scenario/98-criterion suite, 240 calls/scenario and 60% coverage gate. Deployed and evaluator source `0d612b82`. Fresh personas and four deployed toolbar checks passed before collection. Final reset and session invalidation verified. |
| Deployed `/evaluate` `2026-09-08T08-23-15` | Score withheld at **16.692%** coverage; five scenarios completed, 16 blocked and 17 manual checks pending. The 60% coverage gate exited 2. CFP area: 89.655% at 76.316% coverage. | All **416 artifacts verified**. Application `0d612b82`, evaluator `65b8925e`; proposal handoff and reviewer scoring completed. Accepted-session HTTP 500 blocked speaker/content/schedule scenarios; ABS setup conflicted with completed reviews. Four deployed toolbar checks and final reset/session invalidation passed. |
| Deployed `/evaluate` `2026-09-08T12-32-26` | Score withheld at **11.579%** coverage; three scenarios completed, one `feature_not_found`, 17 blocked and 17 manual checks pending. The 60% gate exited 2. CFP area: 84.091% at 57.895% coverage. | Application/evaluator `43bd670c`; all **301 artifacts verified**. Fresh DevFlow creation, proposal handoff and submitted/locked CFP review succeeded. Co-author editing after review blocked ABS-S1 and downstream scenarios. Accepted-session access was verified separately, not credited to this run. |
| Deployed `/evaluate` `2026-09-08T14-46-23` | Score withheld at **13.008%** coverage; four scenarios completed, 17 blocked and 17 manual checks pending. The 60% gate exited 2; provisional 67.045% is not acceptance. | Application/evaluator `b946bfd4`; all **373 artifacts verified**. Co-author setup, CFP review and real advancement succeeded. Optional AI approval rejection blocked ABS-S2 and its dependants; speaker/content/scheduling were not exercised. Reset/session invalidation and exact deployed health verified. |
| Deployed `/evaluate` `2026-09-08T17-27-38` | Aborted after CFP-S1; CFP-S2 ended `agent_error` when approval rejected output recording and inaccurate completion claims. No completed grading or acceptance score. | Application/evaluator `b2335e77`. The observed organizer URL was valid; clarified its opaque ID and queue context before a fresh run. Integrity verification reports unindexed aborted-scenario artifacts; retained only as diagnostics. Reset/session invalidation verified at 17:50 UTC. |
| Deployed `/evaluate` `2026-09-08T17-55-36` | Score withheld at **28.346%** coverage; seven scenarios completed, 15 blocked and 17 manual checks pending. The 60% gate exited 2; provisional 93.655% is not acceptance. | Application `b2335e77`, evaluator `1d3b00bb`; all **481 artifacts verified**. Exact 2:1 scoring and AI generation/override passed. CFP-S4 lacked an active decision template and claimed co-speaker; downstream workflows blocked. Final reset/session invalidation and deployed health verified. |
| Deployed `/evaluate` `2026-09-09T01-26-10` | Score withheld at **0%** coverage; 22 scenarios blocked, 17 manual checks pending. | Application/evaluator `00d91286`; all **157 artifacts verified**. CFP-S1 published a decision version of the confirmation template, retiring the latter, then correctly stopped without publishing the CFP. The missing independent-creation action is a product UI gap. Final reset and invalidation of all four personas verified at 01:47 UTC. |
| Deployed `/evaluate` `2026-09-09T08-36-28` | Score withheld at **36.288%** coverage; nine scenarios completed, 13 blocked and 17 manual checks pending. The 60% coverage gate exited 2; provisional 88.87% is not acceptance. | Deployed/evaluator source `6e01f396` with the deployment-audit edit present; all **615 artifacts verified**. Biography, 2:1 scoring, AI assessment, decision release and speaker onboarding progressed. Scanner readiness blocked SPK-S2 and its dependants; anonymous verification separately blocked. Final reset/session invalidation and health verified at 10:32 UTC. |
| Deployed `/evaluate` `2026-09-09T16-27-25` | 11 completed, ten blocked, final CRM scenario `agent_error` / provider exit 1. No complete acceptance score; artifact verification fails on unindexed aborted CRM evidence. | Application `6e01f396`, scanner/evaluator `7b27ce4d`. Headshot clean release/render/download, claimed biography, 2:1 scoring, decision handoff and three persisted schedule placements verified. AEK login-wall detection, evidence access and approval restrictions blocked remaining work. Final reset/session invalidation verified at 19:02 UTC. |

The earlier recovery/save blocker is resolved: both the direct deployed smoke
and independent evaluator published successfully. Anonymous Start application
remained disabled while the harness excluded two verification frames. A separate
Playwright probe loaded those frames but received no token within 30 seconds.
[Cloudflare documents automated-browser blocking](https://developers.cloudflare.com/turnstile/troubleshooting/testing/);
observed 401 responses alone do not identify a configuration defect. Production
verification remains enforced. This is unavailable interaction evidence, not
proof of absent form capabilities. Splitting anonymous steps 9–11 into
CFP-S1-PUBLIC allowed CFP-S2 to run: draft/resume, required-field errors,
Workshop/Talk conditional visibility, two submitted proposals and a persisted
abstract revision were observed. That run did not prove ordinary signup, verification,
email delivery or organiser-side revision visibility. All original steps,
success signals and 98 criteria remain across 22 executable scenarios.

In the earlier `02-33-47` run, automatic approval review rejected CFP-S2's
observed draft-specific proposal URL as a potential capability link. The evaluator left its required output unpublished,
blocking later scenarios. A separate read-only check showed the applicant could
see the proposal through that URL while anonymous and reviewer sessions could
not; source selects the record from the authenticated applicant's applications.
This supports an approval false positive, not a missing submission capability.
The rejected URL was not published and the report was not regraded. The judge
also recorded a minor sticky-toolbar obstruction; Control+Home restored access.
The multi-event probe again created Forward Summit 2028 with a separate empty queue.

Release `b2335e77` and evaluator `1d3b00bb` resolved the relative-weight and
optional-AI blockers. The fresh run preserved co-author setup before assignment,
retained both CFP Review scorecards and advanced exactly two proposals into
Initial Review. Both new round configurations survived reload: blind Initial
Review with Originality weight 2 and Relevance weight 1; identity-visible Final
Review with a separate 1–10 scorecard. CI's submitted result was **3.33/5** from
`(4×2 + 2)/3`; the second proposal scored **5.00/5**. Initial results excluded
historical CFP reviews, and CSV bytes were downloaded. The reminder's application
record reported delivery; inbox receipt was not independently verified.

The independent ABS-S2-AI scenario inspected Workers AI, its configured model and
Cloudflare binding before confirmation. The application saved a **3.8/5** AI
advisory, then a separately confirmed **4.2/5** human assessment. Reload retained
both and the unchanged canonical human score of **3.33/5**. Abstract-management
judging reported 97.727% at 78.571% coverage, with four manual checks pending.
This is observed application evidence, not an independent provider-side audit.

Remaining boundaries from this run:

- **Evaluation setup:** blank-event setup omitted active decision-email templates
  and co-speaker claim completion. Acceptance preview required the claim; release
  returned HTTP 422 requiring a published active template. No accepted session or
  decision notification was observed. Submission-confirmation configuration was
  also reported missing in communications history. Configure these prerequisites;
  do not remove the product's identity or notification checks. CFP closure passed.
- **Product UI:** expanded result cards clipped long AI rationale text at the
  collected viewport. Generation, override persistence and scores worked; text
  readability needs a separate fix. Tracks still uses multiple choice rather
  than the upstream dropdown.
- **Anonymous verification:** the security check remained unavailable to the
  evaluator. This did not gate core review or decisions. A specific deployment
  configuration defect is unproven; production verification remains enforced.
- **Unexercised downstream work:** speaker, content and scheduling scenarios were
  blocked by the missing accepted-session handoff. The earlier accepted-session
  detail fix remains separately verified; this run did not reach that route.

The earlier handoff rejection was evaluation guidance/approval interaction:
observed organiser URLs legitimately retain `draft-` IDs and `?queue=1`. Source
and installed-CLI tests confirmed those semantics. The fresh run recorded the
handoff successfully after clarification, with approval checks still enabled.
The aborted run's later claims that recording succeeded were correctly rejected.

Final cleanup completed at **19:19:27 UTC**. Old organiser sessions were invalid,
applicant/reviewer baselines clean, no persona selected and deployed `b2335e77`
healthy. Integrity root: `4bdfb809bf5be2c0109430fc03f7a55264553d46185d9cf3bfef23c5ab683e45`.

The 9 September run `2026-09-09T01-26-10` demonstrated the missing independent
email-template action: confirmation v1 became retired when decision v2 was
published on the same template. The evaluation correctly withheld CFP publication
and all dependent checks. The first preparation reset returned 409; its cleanup
reset succeeded before the fresh run. Final reset completed at
**01:47:25.999 UTC**, with all saved sessions invalid and `00d91286` healthy.
Integrity root: `576e5858571dfc1b3c46e46d492b2e43ea9a87c79c5f561fddca4585c0434ff6`.
That run's release, review, evaluation and reset receipts are in
`.artifacts/acceptance-prerequisites/`.

The subsequent run `2026-09-09T02-28-52` on deployed `f7d0d63e` retained both
Submission confirmation and Decision templates Live after reload, published the
CFP, exercised draft/required-field/revision behavior and recorded the organiser
proposal handoff. ABS-S1 saved Marcus's proposed biography and completed his
signed-in claim, but his claimed profile biography was empty. The run then
stopped on Codex's usage limit without final judging; later workflows and AI
result wrapping were not freshly exercised. Tracks checkboxes implement the
recorded one-or-more-track decision; evaluator guidance now preserves that
behavior while recording the upstream dropdown difference without changing
criteria or grading.

The deployed biography fix copies the latest submitted speaker biography into an
empty profile only with a successful claim, preserves existing biographies and
increments the profile revision. Both claim paths use this rule. Focused
validation passed: 59 submission Worker tests, 13 application-route tests,
the Marcus Chromium claim/reload workflow,
generated TypeScript checks, 30 evaluator tests and all three evaluator
configurations. Local check receipts are in `.artifacts/claim-biography-review/`;
deployment receipts are in `.artifacts/release-6e01f396/`.
AI endpoint/weight follow-up: 43 focused Worker tests passed, including same-host
path/query rejection before request persistence or dispatch and relative-weight
evidence labels. Two Chromium checks passed for reviewer AI prerequisites and
AI/human result separation after reload; these use local fixtures and do not
prove external provider delivery. Check/review receipts:
`.artifacts/ai-endpoint-weights-review/`.
The earlier template run/release receipts are in `.artifacts/acceptance-template-rerun/`.
The requested fresh cleanup reset completed at **03:16:41.553 UTC**; all four
prior persona sessions were invalid and clean applicant/reviewer baselines and
`f7d0d63e` health verified. Receipts: `.artifacts/fixture-reset-20260909-0317/`.

The fresh `2026-09-09T08-36-28` run on `6e01f396` verified Marcus's supplied
biography after explicit claim and reload, and Priya's view confirmed his linked
identity. Both independent email templates remained Live. Initial Review retained
weights 2:1 and produced 3.33/5 from Originality 4 and Relevance 2, excluding
historical CFP reviews. Actual CSV bytes were retained. Workers AI confirmation
named the model and binding destination; the 3.8/5 advisory and separate 4.2/5
human assessment survived reload without changing the canonical 3.33/5 score.
The expanded rationale wrapped visibly at the captured viewport. External
endpoint-change rejection and review-aid evidence labels were not exercised by
this deployed assessment scenario; their focused regression tests remain the
evidence. UI attribution is not independent provider execution verification.

CI acceptance and AI-proposal rejection persisted, notifications were queued,
and the accepted CI content page opened with both speakers and the revised
abstract. CFP closure was published; Priya accepted speaker access. SPK-S1
imported the roster and assigned three tasks each to Priya and Marcus. SPK-S2
saved profile/social edits and completed two tasks, leaving the release task
incomplete as instructed. Remaining boundaries:

- **Production scanner:** headshot upload and signature validation succeeded,
  but its Workflow repeatedly returned `scanner_not_ready`. At **10:29:00 UTC**
  it delivered an error verdict: scanner capacity remained unavailable for the
  permitted wait window. D1 recorded the file and dispatch as failed, without
  releasing the file. Scanner startup/signature readiness needs investigation;
  stale signatures are a hypothesis, not a verified root cause. SPK-S2 blocked
  SPK-S3, then content, scheduling, widgets and CRM through their dependencies.
- **Evaluation/AEK evidence:** anonymous security verification remained
  unavailable. Several checkpoint-scoped judgements withheld credit because
  supplied excerpts omitted relevant state or linked screenshots were unavailable;
  later retained observations did not satisfy those checkpoint boundaries. An
  initial reminder-send approval rejection was resolved by verifying the actual
  controlled recipient; the app subsequently reported Delivered, without inbox
  verification. Uncommitted bulk assignment and unexercised recusal remain gaps.
- **Product/criterion differences:** Tracks remains multiple choice; the AI
  assessment preserves the immutable advisory instead of overriding it; Priya
  can see Marcus as her confirmed co-speaker. The last behavior failed the
  criterion's blanket prohibition on other speaker names, but no access to
  Marcus's private tasks or Dana's records was observed. These are scope/design
  differences, not established regressions from the deployed fixes.

Cleanup first returned HTTP 409 while the scan was active. The Workflow finished
with its error verdict before an attempted termination, so Cloudflare rejected
termination of the completed instance; no cancellation or manual D1 write occurred.
The normal reset retry completed at **10:32:29.398 UTC**, and all four prior
persona sessions, clean baselines, no selected persona and exact deployed health
were verified. Run/reset/scanner receipts:
`.artifacts/deployed-fixes-evaluation-20260909/`.


The scanner release run `2026-09-09T16-27-25` supersedes the earlier readiness
blocker: the real 569-byte headshot was uploaded at 18:14:19 UTC and released at
18:15:24. Two cold-start readiness responses preceded a clean verdict using
ClamAV 1.4.6/signatures 28118; portrait reload and organiser download passed.
Independent dependencies let scheduling and CRM progress despite content blocks.
AEK's route classifier incorrectly treats the authenticated `/admin/sessions/new`
form as a login wall, blocking content setup and the publication scenario.
Correct checkpoint screenshots were retained, but the Codex judge's 30-image
selection omitted some of them; excluded frames also blocked anonymous security
and merged-email preview checks. Approval review rejected AI disclosure and later
CRM evidence calls as post-finalization actions; CRM collection then exited 1.
The partial report predates CRM completion and is not final acceptance. Cleanup
reset and old-session invalidation passed; production was not left populated.
Receipts and diagnostic evidence: `.artifacts/scanner-release-7b27ce4d/`.

Reports are retained under `evals/.agent-eval/runs/<run-id>/report.html`.
Previous release receipts are in `.artifacts/relative-weights-ai-release/`, the
completed evaluation/reset in `.artifacts/relative-weights-ai-rerun/`, and the
review loop in `.artifacts/relative-weights-ai-review/`. Earlier accepted-session
diagnostics remain in `.artifacts/deployed-accepted-session-smoke-20260908-retry/`.
Verified artifact roots:

- Active local regression: `5c7afb60bb4a86f5937aacdd786fe0de16ff5b0c5d798dc16517334b5b5c5415`.
- Local upstream: `86268503e077e1d7560fcf7d40b2cbb5babb7724e64995fe2b5276aef780d427`.
- Earlier 9 September template-blocked run: `576e5858571dfc1b3c46e46d492b2e43ea9a87c79c5f561fddca4585c0434ff6`.
- Completed deployed run `2026-09-09T08-36-28`: `054d6d8c100807c501edd5e0a9da8ae7dd59f677b691c84cfe2a594f0f454e3f`.
- Completed deployed run `2026-09-13T08-07-46`: `1a39bef4982009b6c9e857c6da3c3e1002582423043fdbc55402c75db673e6d6`.

## Deployment evidence

Bounded historical acceptance must not be extended to newer code or unrelated
provider paths.

| Area | Accepted evidence | Still outstanding |
| --- | --- | --- |
| Identity and mail | Owner Turnstile/Resend magic link, delivered/bounced receipts, Google and hardened Microsoft sign-in. | Fresh email-link/Microsoft identity creation and third-party failure callbacks, broader recipients and controlled SBEK inbox evidence. |
| Calendars | Google/Microsoft connections and invitation create/update/cancel lifecycles. | Fresh provider-error exercise and any provider-requested verification; historical flagged callback follow-up. |
| Participant operations | Live preview, structured task validation/completion and draft discard/replacement under `6c811a3`; multi-role acceptance under `1ba0531` on 2 September. | Newer task/reminder behavior and positive co-participant presentation where the canonical fixture lacks such a session. |
| Files/scanner | Historical Uppy/R2 upload, clean release, EICAR quarantine, error/retry and erasure evidence; `ae6133c` exercised shutdown. Scanner `38a5ad24` passed real multipart upload, clean scan/callback/release, exact-byte authenticated download and anonymous denial on 18 October after correcting FreshClam trust. | Sustained capacity and broader erasure; aged-signature refresh passed in the later hosted canary. The earlier September failed instance's root cause remains unverified. |
| AI | DeepSeek structured readiness through Workers AI; malformed/over-budget output failed explicitly. | Deployed acceptance of the full agent workflow (local live-model evidence above), assessments and external model providers. |
| Operations | Retained structured logs, empty Queue/DLQ inspection, scoped alert firing, one delayed owner alert email and exact private-R2 backup restore. The 18 October autonomous backup and paired monitor passed; the downloaded SQL matched its manifest and restored into isolated SQLite with integrity and foreign-key checks passing. | Timely repeatable alerts, trace continuity and measured incident RPO/RTO. |

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
source `5109324`. On 18 October, read-only production inspection verified five
consecutive completed daily Workflows for 14–18 October. The 18 October instance
started at 02:17:21 UTC and stored its SQL at 02:17:35; its scheduled timestamp
was 02:17:17. The paired 03:47:19 UTC `monitor-verified` log matches the manifest's
date, object key, byte count and checksum. These jobs ran on source `c2c402cf`,
before the October release deployed later that morning.

The private R2 SQL was downloaded and independently checked against its manifest:
3,244,770 bytes, matching ETag, SHA-256
`e0cbd06d10c15492fd0aa53d32e5d5c3f817547acc09f2cb0a0f44e70e6d79ec`.
An isolated in-memory SQLite restore passed whole-database integrity and foreign-key
checks (117 tables, 390 indexes including automatic indexes, 172 triggers and two
views). The downloaded plaintext was removed. Private receipts are retained under
`.artifacts/live-journey-20261018/`. This verifies unattended backup plus monitor
and local restorability; it is not a production D1 restore or a measured incident
RTO. The logical export can briefly make D1 unavailable, so its low-traffic window
remains an operational constraint. Alert firing and one historical delayed email
prove a path, not timely repeatable delivery. Do not claim the 24-hour RPO or
incident RTO is met. Procedures:
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

1. **Deployed evaluation:** the user stopped the 18 October run during ABS-S2;
   four scenarios collected evidence and no judging occurred. Keep the retained
   fixture and partial evidence unchanged; new authorization is required to
   resume or reset. The September 51.155% coverage result remains the latest
   completed score boundary. Independent content, conflict, publication/widget
   and newer task acceptance remain incomplete, although the separate controlled
   invited-speaker journey passed real publication and upload/release. Anonymous
   Cloudflare verification remains manual. CRM new-event transfer/import and
   independent evaluation inbox inspection still lack evidence; the separate
   controlled journey's manual inbox check was confirmed by the user on 19 October.
2. **Provider paths:** exercise Airtable authority/recovery, Accelevents live
   reconciliation, external AI/tool-loop/assessment and fresh provider-error
   callbacks. Verify newer schedule-change emails, reminder cron and controlled
   SBEK mailbox delivery. Complete historical Google callback follow-up.
3. **Operational recovery:** the 18 October autonomous backup and paired monitor
   are verified above. Prove timely repeatable condition-specific alerts, trace
   continuity and incident RPO/RTO.
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

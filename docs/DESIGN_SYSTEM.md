# Design system

The [Program Cue reference board](designs/program-cue-reference-board.jpg) is an aspirational visual input retained for design continuity. It predates the current application and includes imagined capabilities, so it is not implementation or verification evidence. Current rendered evidence lives in the Playwright snapshots under `e2e/visual.spec.ts-snapshots/`.

## Canonical shells

- **Administrator:** dark sidebar, light work canvas, fixed event context and global command control.
- **Reviewer:** focused light workspace with queue, proposal context and rubric visible together when an assignment is active.
- **Speaker/applicant:** comfortable light participant shell with the next required action first.
- **Public/embed:** branded event discovery controls with no administrator terminology; embeds omit application chrome.

## Navigation

Command Centre · Event Setup · Submissions · Review · Speakers · Resources · Schedule · Communications · Tasks · Programme · Integrations · Settings · Operations.

The command palette accelerates visible navigation; it never replaces it.

## Semantic colours

- Green: success and completion.
- Amber: warning and attention.
- Red: conflict, failure and destructive action.
- Blue: neutral information and workflow state.
- Violet: Program Cue brand, focus and primary action.

## Data taxonomy

- **Format:** Keynote, Presentation, Panel, Workshop, Breakout.
- **Track:** AI & Innovation, Event Operations, Experience Design, Leadership.
- **Status:** Draft, In review, Scheduled, Published, Complete.
- **Alert:** Warning, Conflict, Failed.

## Density

Administrator screens use compact operations density. Participant and public screens use comfortable spacing and larger hit targets.

## Time and public identity

Render form/task dates, schedule slots and attendee-facing times in the event timezone. Show a timezone name or abbreviation when the surrounding event context is not enough to prevent ambiguity.

Use the globally unique event slug in canonical programme, embed, API and calendar links. Deep links to programme sessions retain the event URL and use the stable session-slug fragment.

## Consequential actions

Use Configure → Preview/Diff → Confirm → Background progress → Result/Retry where an implemented action has irreversible or external effects. Current examples include communications, decisions and schedule publication. Display authority honestly—for example, a committee-chair decision action is available only when the evaluation plan grants it—and do not imply progress or success for integrations that are not implemented.

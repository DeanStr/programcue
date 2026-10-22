# Programcue evaluations

Project-specific AEK suites live with the application in this repository.
All configs set `project.root: ..`, so AEK records Programcue's Git revision and
working-tree fingerprint. Private sessions, local package archives and reports
live in the ignored `evals/.agent-eval/` directory. The reusable harness remains
an installed dependency, not application source.

Two suites have separate configs and baseline directories. Runs share `.agent-eval/runs`; their project name, specs and fingerprints distinguish the scoring contracts:

| Suite | Config | Contract |
| --- | --- | --- |
| Upstream SBEK, local | `evalkit.local.yaml` | 7 areas, 25 executable scenarios from 20 upstream scripts, 98 criteria; optional CRM included |
| Upstream SBEK, production | `evalkit.production.yaml` | Same criteria, production aliases and `/evaluate` authentication |
| Programcue regression, local | `evalkit.regression.yaml` | 9 additional criteria covering draft/publication isolation, actual versioned ZIP bytes, real local scan receipts, and Mailpit capture |

The upstream snapshot is pinned to `81099583ff4c878f310dc3c48e4916318678425d`
from [Kill My SaaS evals](https://forge.smol.ai/swyx/killmysaas-evals/).
`upstream/source.json` records every source SHA-256. `npm run import` verifies
those bytes and deterministically rebuilds `specs/upstream`. It preserves every
rubric ID, criterion, pass condition, weight, evidence description and manual
instruction. Generated scenario adaptations add Programcue navigation guidance,
explicit dependencies, typed URL handoffs, isolated personas and selected
checkpoints. Edit the importer to change those adaptations, then regenerate.

CFP-S1 runs the original authoring/publication and multi-event steps. Its
anonymous steps 9–11 run in `CFP-S1-PUBLIC`, which consumes the observed portal
URL. CFP-S2 depends on publication, not anonymous verification; a blocked
security check therefore does not prevent testing an already authenticated
applicant. CFP-S2 always checks options, conditional visibility and validation.
CFP-01–03 retain their original requirements and include evidence from all three
scenarios. Authenticated evidence does not prove anonymous verification or
ordinary signup. Missing public evidence remains unavailable to the judge.
The split changes the evaluation fingerprint and requires a fresh run.

CFP-S1 creates a blank DevFlow Conf 2027 event for the chained run, with explicit
reuse of the configured evaluation sender where available. Before CFP publication,
it creates and publishes active Submission confirmation and Decision email
templates through **New template** for each category. Editing a published template
creates a replacement version, so both independent template names must remain
Live after reload. Use an explicit synthetic footer (Evaluation fixture plus the observed
event location). This does not verify an organisation mailing address. Sender
verification alone is not
notification readiness. The populated Future
of Events 2027 showcase retains its protected review work. A pre-existing DevFlow
event blocks a fresh run; only the operator resets shared state between runs.
Every persona selects the new event after gaining access, and applicant/public
checks follow observed output URLs. This is ordinary event creation, not cloned
review evidence or a reset inside a scenario.
Local upstream collection uses the existing organisation-owner persona Morgan
Chen for event creation; production Jordan already has organisation-administrator
access. Local regression and bounded smokes retain Jordan and the showcase.

Review sequencing is CFP-S2 → ABS-S1 → CFP-S3 → ABS-S2/S3 → CFP-S4. The first round is named
CFP Review before assignment. ABS adds Initial Review and Final Review to that
plan, completes the remaining source-round review, then explicitly advances the
two proposals into Initial Review. This gives the required 2-assigned/0-completed
baseline without archiving a cycle or releasing decisions early. Historical CFP
reviews remain inspectable; current and historical evidence must be labelled by
round. ABS-S1 switches to the saved `co_speaker` persona (Marcus), opens the bound
CFP URL and uses **Claim speaker profile** before review assignment. Selecting
Marcus in `/evaluate` grants no membership and claims no invitation; his
ordinary authenticated email-matching claim must persist and be visible to
Priya. This is not evidence of signup, email verification or invitation delivery.
Only CFP-S4 releases decisions and closes the CFP. This ordering requires
the abstract-management prerequisites when selecting CFP-S4, including a
CFP-only run. Existing sealed runs are unchanged; use a fresh evaluation.

The optional AI generation and human-override steps run in `ABS-S2-AI` after
ABS-S3's human scoring. ABS-14 belongs to that separate scenario; no core
scenario depends on it. A blocked AI check retains its own unavailable evidence
without blocking decisions or speaker/content/scheduling. Generated abstract
management uses the `00-` filename so AEK collects this branch before CFP-S4
releases decisions and makes the proposals unavailable for review. The importer
preserves all 98 criteria; tests verify collection
order and dependency behavior with the installed public AEK CLI.

Content setup and scheduling each consume CFP-S4's accepted-session handoff;
neither depends on speaker headshot uploads, content approval or ZIP export.
CRM depends on CFP-S1's event setup and establishes any missing contacts through
its original script. Speaker progress still requires the portal-edit scenario,
and content review still requires the upload scenario. A blocked upload therefore
retains unavailable coverage without preventing independent setup or scheduling.

Presentation setup (`CNT-S1`) and independent headshot requests
(`CNT-S1-HEADSHOT`) have separate outcomes. Presentation uploads depend only on
the former; missing headshot evidence remains visible to the original criteria.
`AIA-SETUP` uses normal direct-session creation for four explicitly named
Scheduling: records, confirms participation as each speaker and publishes their
event profiles. This replaces the upstream instruction to reverse earlier
proposal decisions: direct sessions carry no claimed review/acceptance evidence.
Original AI Pair and Docs decisions and reviews remain intact. Conflict checks and
auto-placement each depend on readiness. `AIA-PUBLISH` independently prepares a
real conflict-free placement baseline and observes normal publication validation;
widgets bind its public URL. Publication cannot pass merely because conflict or
assist checks were skipped. Setup and actual publication failures still block
consumers. Local orchestration tests cover each branch; deployed acceptance of
this sequencing awaits an explicitly requested fresh run.

Checkpoints are published once, after all their observations are captured. Wait
for settled results, verify persistence where requested, and cite the actual
screenshot steps alongside snapshots. Screenshots outside those step references
cannot support a checkpoint, and long snapshot excerpts can omit required values.
The importer adds specific capture guidance for decisions, transferred session
metadata, closure locks, both aggregate sort orders and restored content. These
changes require a fresh run; they do not repair or regrade earlier sealed evidence.

## Install and validate

Use Node 24.11+ and the installed subscription CLIs. Local execution requires
a POSIX host with process groups and `ps` available for cleanup. From this checkout:

Install the published archive matching this lockfile:

```sh
mkdir -p .agent-eval/vendor
gh release download v0.7.0 --repo DeanStr/agent-eval-kit \
  --pattern 'agent-eval-kit-0.7.0.tgz*' --dir .agent-eval/vendor/v0.7.0
(cd .agent-eval/vendor/v0.7.0 && sha256sum --check agent-eval-kit-0.7.0.tgz.sha256)
npm install --save-exact ./.agent-eval/vendor/v0.7.0/agent-eval-kit-0.7.0.tgz
```

For intentional AEK source development, use
`npm run setup -- /absolute/path/to/agent-eval-kit` instead. Setup builds and packs
that checkout into the ignored local archive and updates the installed archive
integrity in `package-lock.json`. A dirty source build is distinct from the
checksum-verified release above. The kit can be anywhere on disk; no sibling
checkout, package symlink or private-module import is required. Ordinary
`npm install` requires the ignored archive to exist first.

The upstream configs use Codex collection and Claude judging; override with
`--agent codex --judge codex` when using one subscription. Preparation uses the
public `aek auth --json` result to locate saved browser sessions. The Programcue
regression config pins both roles to `gpt-6-astra` with `effort: medium`.
AEK records these requested settings and CLI versions in `receipt.json` and its
HTML report, and retains the actual invocation argv. Codex does not report a
resolved model snapshot in its current JSON stream; the requested ID is not
proof of an immutable provider implementation. Explicit overrides use
`--agent-model <id>` and `--judge-model <id>`.

## Design evaluation and improvement

**Current focus: reference-informed visual UI improvement.** The earlier `visual-ui-v3-unanimous` method assesses visual
craft; the earlier workflow-oriented pilot remains historical evidence. Its
results must not be treated as visual-quality verdicts or compared numerically
with this changed method. Browser and accessibility checks remain constraints.

The design loop uses **AEK 0.7.0**, pinned by the versioned archive and integrity
in `package-lock.json`. The published checksum is
`f742f728434c58b4ba31c5d7da3c073de3074c6a269e0d39076e1d1eda172614`.
See the [release](https://github.com/DeanStr/agent-eval-kit/releases/tag/v0.7.0).
Older evaluator reports remain historical; generate fresh runs before making
numeric comparisons or replacing promoted baselines.

`ux:review` prepares one native image-batch manifest, retaining the existing
visual criteria, Sol 6.1/high model and five unanimous votes for both preference
and independent quality. It delegates all judging, queueing, retries, exact
reuse, sealing and per-pair reporting to `aek image batch`. The project adapter
only checks captures, identifies unchanged guards and joins browser results.

If an execution error stops a matrix, repeat the original project command with
`--resume` and its original captures/settings. Native AEK preserves completed
votes. A split design verdict is final for those pixels and is not resampled.
Native resume retains the original concurrency; capacity retries are bounded.

`--reuse PREVIOUS_REVIEW` accepts one prior native review. AEK matches exact image
bytes and the full judging contract, including negative or inconclusive results.
Different settings or pixels receive new judgments. Unsealed project metadata
cannot substitute native evidence. The native batch report records live progress;
the project `review.json` and optional forty-view overview join results when the
native invocation returns.

`--ignore-paint-noise` only identifies unchanged before/after guards: at most 64
pixels differing by at most four RGBA levels with identical geometry. It records
the measured difference and never relaxes quality gates. It does not approximate
cross-run AEK reuse. References equivalent under this explicit guard remain
unchanged, never improvements. The raster checks require installed Chromium.

This project-owned loop is separate from SBEK and provider acceptance. It captures
twenty administrator, reviewer, participant and public surfaces at 1440×1000
and 390×844 (forty views), using a fresh isolated D1 fixture and production build. Captures
reserve local ports 5196/15196 and never use the development database or production.
Mailpit and external credentials are unnecessary: these workflows send nothing.
Source revision, dirty diff, untracked source hashes, toolchain/method hashes,
image hashes and browser results are retained in each `capture.json`. Output
directories must be new; captures are never overwritten. Keep source unchanged
while capturing, and use the same capture toolchain for both designs.

From `evals/`, capture the candidate:

```sh
npm run ux:capture -- --output .agent-eval/ux/iteration-1
```

For the initial comparison, create a detached worktree at the last commit from
the application root, install its dependencies, then capture it with the same
helper. `--checkout` chooses that worktree; it never accepts a remote target:

```sh
npm run ux:capture -- --checkout /absolute/path/to/reference-worktree \
  --output .agent-eval/ux/reference
```

The last commit is a comparison reference, not automatically an approved design.
The browser gate checks document containment, WCAG A/AA rules through axe,
mobile navigation with keyboard activation/Escape/focus return, and keyboard
application-row selection/clear. Captures use unscaled viewport PNGs, with
hydration, fonts and the form canvas ready. This is initial-viewport coverage,
not a complete audit of lower-page content, dialogs, persistence or every route.
Retain existing Playwright behavior, visual and cross-browser coverage for those
contracts. Exit 2 retains observed browser failures; errors fail with exit 1.

Preview the model budget and inputs, then run a bounded pilot:

```sh
npm run ux:review -- --reference .agent-eval/ux/reference \
  --candidate .agent-eval/ux/iteration-1 --output .agent-eval/ux/review-1 \
  --views command-desktop,applications-mobile --dry-run
# Repeat without --dry-run to judge. Omit --views for all forty views.
```

Generate an interactive before/after matrix, including links to retained AEK
votes and original PNGs, at any point during or after a review:

```sh
npm run ux:report -- .agent-eval/ux/review-1
```

The default judge is **gpt-6.1-sol, high effort**. Each changed view receives separate
blind relative-comparison and absolute visual-quality gates, with five votes per
gate and unanimous agreement. That is ten subscription calls per changed view,
up to 400 for the full matrix. Byte-identical views are recorded as unchanged,
not claimed as improvements. Dry runs still validate every selected pair and
show the nominal budget. `--concurrency 1..2` controls native batch view processing
(default two). `--model` and `--effort` are explicit overrides; when using another
provider through `--judge`, supply its supported model/effort. Mock judges
abstain and cannot pass the visual gates. AEK retains anonymous panels, source
images, votes, findings and HTML reports under each view's directory. The parent
`review.json` retains selection, source provenance and browser failures. Any
candidate browser failure blocks the overall result, including outside a pilot's
selected views. Failed/inconclusive gates exit 2; provider errors exit 1.

The visual rubric assesses type scale/weight/line height, spacing rhythm,
alignment, colour harmony, canvas/panel contrast, borders/shadows/radii, control
geometry and icon consistency. It excludes task completion, workflow efficiency,
feature count and records above the fold. Choose `--aspect overall` (default),
`typography`, `spacing`, `surfaces` or `components` to test one visual concern.
Each review records its aspect and method. Brand familiarity, exact palette,
light/dark theme, smaller type and more empty space do not earn points by themselves.
Do not infer unseen interaction states from these screenshots. Current primary
guidance includes [Atlassian typography](https://atlassian.design/foundations/typography/),
[spacing](https://atlassian.design/foundations/spacing/) and
[Linear's 2026 visual refresh](https://linear.app/now/behind-the-latest-design-refresh).

The default policy is strict `preference`; every vote must prefer the candidate.
`--policy non_regression` is an explicit diagnostic option and does not satisfy
the unanimous improvement target. Inspect localized
findings, change one coherent concern, recapture and rerun against the retained
reference. Reject behavior/accessibility regressions and unavailable evidence.
Do not refresh Playwright baselines or replace the reference merely to obtain a
passing result. Require improvement in the targeted concern and review the
remaining views for regressions before accepting a candidate.

Before treating model results as an acceptance gate, review known-good examples
and known defects independently. `ux:capture --variant unreadable` creates an
explicit injected contrast/type-size defect for a negative control; its failures
must remain visible. Judge it against a normal reference. This tests one defect
family, not general judge accuracy. Retain disagreement for review and add held-out
examples of accepted and defective UI through AEK's `judge validate` tooling. Model
agreement measures consistency, not user preference or independent human approval.

### External visual reference pilot

`evalkit.ui.yaml` adds a separate component-level comparison against the updated
right-hand navigation in Linear's published 12 March 2026 refresh. This is a
provisional external reference, not a whole-product or human-approved benchmark.
The rubric compares typography, spacing, icon treatment, alignment and surface
restraint. It excludes the old left-hand sidebar, desktop chrome, editorial
callouts and lower fade. AEK applies the declared crops and seals the source
pixels, normalized comparison panels, votes and findings. Different content,
menu counts and brand colours do not count as quality differences.

From `evals/`, prepare the explicit inputs, substituting your captured directory:

```sh
mkdir -p .agent-eval/ui-input .agent-eval/ui-references/linear-20260312
cp .agent-eval/ux/iteration-1/command-desktop.png .agent-eval/ui-input/candidate.png
cp .agent-eval/ux/iteration-1/capture.json .agent-eval/ui-input/capture.json
curl --fail --location 'https://webassets.linear.app/images/ornj730p/production/b6d6be14c96978b10553cfb9205be1065087e793-3904x2720.png' \
  -o .agent-eval/ui-references/linear-20260312/sidebar.png
npm run ui:benchmark -- --dry-run
npm run ui:benchmark
```

The collector requires the candidate bytes to match a healthy 1440×1000
`command-desktop` entry in the supplied capture manifest and the reference bytes
to match SHA-256 `e8455151bee6433e6add7fd3407d09319612eb900fc02bc35d8bb0960b21e782`.
Missing or changed inputs fail; no reference is silently substituted. Validate
prepared inputs with `aek validate --config evalkit.ui.yaml`. The normal three-suite
validator does not require these optional downloaded artifacts. Reports are under
`.agent-eval/ui-reference-runs`. Run one benchmark at a time while these input
aliases are in use. AEK rejects changed source bytes during execution.

Inspect the actual cropped panels before interpreting votes. This image is an
editorial publication rather than a native 1× product screenshot; typography and
scale comparability need review. This pilot covers navigation styling only.
Whole-page visual composition, tables, forms and other components need separately
curated references. Keep the original Program Cue reference for same-product
before/after comparisons and use external examples to assess a visual standard.

### Published SaaS component references

The `saas-craft-v1` experiment pins four official image assets and compares five
matched components: Linear navigation, Attio application/contact tables, Notion
Forms and Notion Calendar. `scripts/saas-references.mjs` records publication URLs,
image SHA-256 values, source-date limitations, fixed crops and normalized panel
geometry. These are published references, not certified latest-live-product
captures. Match visual relationships rather than copying brand styling or
rewarding feature counts. External equivalence is not evidence of improvement
over our previous UI.

From `evals/`, prepare a new experiment from a healthy forty-view capture:

```sh
npm run ui:saas:prepare -- --capture .agent-eval/ui-external/candidate-08 \
  --output .agent-eval/ui-external/next-round
node node_modules/agent-eval-kit/dist/cli.js run \
  --config .agent-eval/ui-external/next-round/evalkit.yaml
```

Preparation verifies every browser result and image hash, fetches missing
reference images and verifies their pinned bytes. Native AEK command collection
copies verified PNGs; its deterministic collector uses `agent: mock`, while
all quality and preference judgments use real Codex `gpt-6.1-sol`/high calls.
Five absolute votes assess the selected candidate views, followed by five blind
pairwise votes per component, with unanimous agreement and concurrency two.
The external gate uses non-regression; any split remains inconclusive. For a
later candidate, use `--scenarios APPLICATIONS,DIRECTORY` when only those
components changed. Resume execution errors in the same run. Never resample
unchanged pairs to erase dissent.
Partial native runs retain unavailable coverage for omitted scenarios and can
leave the cross-scenario absolute gate unavailable. Their aggregate score is
not full-suite acceptance. Read each retained comparison and use the separate
completed before/after quality review; missing evidence never becomes a pass.

Check shared title roles as a cohort, including all twelve ordinary admin pages
at both sizes; individual page preferences do not prove system consistency:

```sh
npm run ui:consistency -- --capture .agent-eval/ui-external/candidate-08 \
  --output .agent-eval/ui-external/next-headers
```

This retains exact heading metrics, source hashes, native-size title collections
and page-action diagnostics. Exit 2 records differing title signatures. Compact
workbenches, display headings and participant/public roles are explicitly outside
this ordinary-title cohort. Control geometry is a diagnostic, not a universal
same-size requirement. Before/after acceptance additionally requires strict
candidate preference and absolute quality; use native AEK pairwise configuration
or `image compare --policy preference` with five votes and agreement 1. Keep
component and cohort results distinct from the historical forty-view matrix.

Generate the HTML report, retaining every executed round and linking its votes:

```sh
npm run ui:saas:report -- \
  --iteration .agent-eval/ui-external/iteration-01 \
  --iteration .agent-eval/ui-external/iteration-02 \
  --iteration .agent-eval/ui-external/iteration-03 \
  --iteration .agent-eval/ui-external/iteration-04 \
  --output .agent-eval/ui-external/report \
  --consistency .agent-eval/ui-external/headers-final \
  --capture .agent-eval/ui-external/candidate-09 \
  --baseline .agent-eval/ui-external/baseline
python3 -m http.server 5241 --bind 127.0.0.1 \
  --directory .agent-eval/ui-external
```

Open `http://127.0.0.1:5241/report/index.html`. Add repeated `--improvements
/absolute/path/to/native-aek-run` arguments for before/after histories. Verify
each native run with `aek verify --run PATH` before claiming sealed evidence.
Earlier votes remain visible when a later round omits an unchanged component.
With `--capture`, a retained verdict applies only when the decoded crop pixels
match the current capture exactly. `--baseline` additionally identifies withdrawn
experiments whose component pixels were restored. The title collection uses its
sealed original PNG; AEK's lossless PNG re-encoding is verified separately.

### Native-batch table refinement

AEK **0.7.0** is the checksum-verified published prerelease. Its archive SHA-256
is `f742f728434c58b4ba31c5d7da3c073de3074c6a269e0d39076e1d1eda172614`.
`saas-tables-v3-native-batch` preserves the v2 native-pixel rendering and judging
criteria while starting a fresh evaluator identity. Earlier 0.6.4 reports remain
historical; their votes are not imported or combined with 0.7.0 outcomes.

Program Cue crops remain at scale 1 on a 1229×430 canvas. The official 2458px
Attio export is rendered at scale 0.5 under the explicitly unverified 2x-density
assumption. Neither input is enlarged. References are dated published images,
not a claim about the current live product.

From `evals/`, prepare a peer comparison, then run the native pairwise batch:

```sh
npm run ui:tables:prepare -- --capture .agent-eval/ui-native-batch-20261021/baseline \
  --output .agent-eval/ui-native-batch-20261021/reference-baseline
npm run ui:tables:compare -- \
  --manifest .agent-eval/ui-native-batch-20261021/reference-baseline/comparisons.json \
  --output .agent-eval/ui-native-batch-20261021/reference-baseline/comparison \
  --concurrency 2
```

Preparation also writes a native **quality-only** suite. It preserves the
independent gate over the original desktop, mobile and normalized component
images. A crop-only batch absolute check would narrow this gate, so it is not
substituted for those three images:

```sh
node node_modules/agent-eval-kit/dist/cli.js run \
  --config .agent-eval/ui-native-batch-20261021/reference-baseline/evalkit.yaml
```

Use `--reference BEFORE_CAPTURE` when preparing a candidate to require strict
same-product preference; omit it for advisory peer non-regression. Use
`--cases DIRECTORY` for a directory-only revision. Each changed component needs
five strict preferences and five current desktop/mobile quality passes before
retention. Five real Sol 6.1/high contexts judge each gate; equivalence is not
improvement. Do not run separate real-model commands above a combined concurrency
of two. Sequential batch/quality phases are the simplest default.

Native AEK owns queueing, bounded capacity retries, vote journals, sealing,
combined pairwise reports and exact reuse. Resume with `aek image batch --resume
BATCH_DIRECTORY`; reuse with `--reuse PRIOR_NATIVE_BATCH` on a new native batch.
Retain every failed or split verdict. AEK 0.7.0 uses exact bytes and the full
judging contract; the old wrapper's approximate cross-run paint reuse is not
transferred. Project capture guards may separately record at most 64 differing
pixels and a maximum channel delta of four for unchanged viewport paint.

The project report only joins experiments and the independent quality evidence:

```sh
npm run ui:tables:report -- \
  --iteration .agent-eval/ui-native-batch-20261021/reference-baseline \
  --iteration .agent-eval/ui-native-batch-20261021/improvement-01 \
  --review .agent-eval/ui-native-batch-20261021/review-01 \
  --review .agent-eval/ui-native-batch-20261021/review-02 \
  --consistency .agent-eval/ui-native-batch-20261021/titles-02 \
  --current .agent-eval/ui-native-batch-20261021/accepted \
  --output .agent-eval/ui-native-batch-20261021/report
python3 -m http.server 5256 --bind 127.0.0.1 \
  --directory .agent-eval/ui-native-batch-20261021
```

Open `http://127.0.0.1:5256/report/index.html`. Every loaded native batch and
quality run must verify before reporting. Repeated `--review` arguments join the
whole-page matrices; both current desktop and mobile need five preferences and
five quality passes before the report labels a changed component retained. Preferences apply only to identical
component frames. Quality additionally requires identical desktop and mobile
originals, so changing mobile invalidates old quality even if the crop is the
same. The report preserves unsuccessful rounds, indicates withdrawals and links
the native batch HTML and full quality reports. Capture health and the twelve-page
title audit remain independent constraints.

### Real local file smoke

Run `npm run smoke:files` from `evals/` with Docker running. This builds the
repository's pinned ClamAV image (including fresh signatures), starts an isolated
Worker/D1/R2 instance, and exercises only the file browser journey. No evaluator
model, production credentials or external notifications are used. Rebuild the
scanner image with `docker build --no-cache -t programcue-eval-clamav:local
scanner/container` from the application root if its cached signatures exceed the
scanner's seven-day readiness window; stale signatures fail startup.

The smoke uploads two distinct PDFs, waits for actual ClamAV verdicts and signed
application callbacks, downloads the current-version ZIP, and independently
compares its extracted bytes. It then uploads an inert EICAR test signature in a
PDF and checks that the infected version cannot be downloaded and that the last
clean version remains current. Configured service failures fail this command;
they are never converted into skips or synthetic clean results.

Local S3 transport verifies the application's signed URLs and transfers real
browser bytes into Miniflare's R2 multipart binding. Because that binding lacks
ListParts, the adapter retains a manifest only after R2 acknowledges each part.
An evaluation-only Worker entry exposes the upload transport on the loopback
application origin, then reconstructs the original signed S3 request. Signature
validation remains authoritative. Both Playwright and AEK use ordinary browser
requests; no Playwright routing hook or production Worker change is required.
The application's Queue dispatch and callback checks run unchanged. The local
scanner verifies the production dispatch contract and object ETag/size, then runs
the production Python `scan_file` function against actual ClamAV in a container
with networking disabled. Scan errors fail the smoke and leave quarantine intact.

This establishes local integration with real malware scanning. Cloudflare's
hosted S3/CORS service, scanner HTTP object proxy, Workflow retries and container
scheduling remain separate deployment acceptance. Virtual HTTPS scanner/callback
origins exist only inside the isolated runtime; the production scanner's HTTPS
and private-object restrictions are unchanged. Run state, ephemeral keys and the
owned container are removed on exit. Evidence is retained in
`.agent-eval/file-smoke/` and `.agent-eval/file-services.jsonl`.

### AEK file regression

The same isolated storage/scanner setup is available to AEK:

```sh
npm run regression:files -- --agent codex --judge codex --max-turns 90
```

This fixes selection to `file-integrity`: two browser workflows, two independent
command collectors and six criteria. It uses Priya Shah's existing task,
retains both individual PDF versions and the latest-version ZIP, and captures expanded version history.
Command graders hash both downloaded PDFs, inspect actual ZIP bytes and verify
retained scanner receipts; the
browser agent does not need an archive-inspection tool. The version-history
checkpoint assesses only visible history and latest/current markers. The former
version-history weight of 1 is split equally between this visual check and the
deterministic PDF check. Those four criteria retain total weight 4. Two new
criteria add weight 1 each for real EICAR quarantine and anonymous download
denial, bringing total file criterion weight to 6.

After the clean-file receipts are retained, a second browser workflow uploads
the existing EICAR PDF as v3 and captures its quarantine state. A command
collector then reads the application's authenticated version-history endpoint
and probes both version download URLs. It retains the real scan receipts,
server history, HTTP statuses and actual response bodies. The quarantine check
requires an infected EICAR verdict, accepted signed callback, HTTP 404 for v3,
and clean v2 still current and downloadable with its exact bytes. Anonymous
access uses an empty cookie jar and the same v2 URL as a successful organizer
control. Only an explicit denial or the expected local login redirect passes;
server errors fail execution, and a missing clean control reduces coverage.
This now exercises the same quarantine/private-download boundaries as the
separate Playwright file smoke.

The 6 September run `2026-09-06T11-59-52` completed at 87.5% score and 100%
coverage. ZIP and scan graders passed; the version-history LLM awarded partial
credit, requesting content verification and an individual v2 download beyond
its checkpoint evidence. Independent inspection confirmed exact v1 bytes and
the single-entry v2 ZIP. This remains a grading/evidence-scope limitation, with
no observed product defect; a 100% score gate correctly failed. All 75 sealed
artifacts verified. Both model roles used Codex CLI 0.153.4 without an explicit
model name; the receipt does not establish which model the CLI resolved.
Pin model names for reproducible comparisons.

The subsequent run `2026-09-06T12-18-03` passed all four criteria at 100% score
and 100% coverage; all 73 sealed artifacts verified. Its browser and judge both
used requested model `gpt-5.6-terra`, medium effort, Codex CLI 0.153.4, confirmed
against the retained invocation arguments. The report provider table was also
checked in Chromium. Future regression runs now request `gpt-6-astra` with
medium effort for both roles; the completed Terra report retains its original
settings. The unchanged four-criterion regression subsequently passed with Astra Medium
in `2026-09-06T12-42-16`: 100% score/coverage, all 82 artifacts verified, with
both retained invocation arguments matching the receipt's model and effort.

The expanded six-criterion run `2026-09-06T12-51-42` also passed at 100% score
and 100% coverage with Astra Medium; all 139 sealed artifacts verified. The
real scanner returned `infected` / `Eicar-Signature` for the exact 724-byte
fixture with an accepted callback. Server history kept v2 as the only current
version. Organizer requests returned exact v2 bytes with HTTP 200 and denied
v3 with HTTP 404; an empty-cookie request to that same v2 URL returned HTTP
302 to local sign-in. Both browser invocations and the judge recorded the
configured model and medium effort. All services/state owned by the run were
removed afterward; retained evidence supports offline grading.


## Interpretation and known boundaries

- This is the upstream **criteria** port using AEK scoring, not an exact SBEK
  score reproduction. The 15 `auto-partial` items use explicit 50/50 hybrid
  weights; unverified manual shares reduce coverage. The two manual-only items
  stay manual. Historical SBEK percentages are not directly comparable. Core
  required area weights total 100, while optional CRM remains separate.
- Upstream `EMB-16` requires propagation without republishing. Programcue's
  immutable published session-content contract differs. That upstream condition
  remains unchanged; `PC-DRAFT-PRIVATE` and `PC-PUBLISH-CONTENT` separately verify
  intended Programcue behavior. Do not republish secretly to claim `EMB-16` passed.
- Pre-captured evaluator access is not ordinary account creation or email
  verification. Sam still needs the organizer's invitation and explicit acceptance.
  Marcus must explicitly claim his matching invitation after selecting Co-speaker.
  Fixture access must not earn unsupported
  signup or identity-isolation credit. Upstream `ABS-14` is left applicable;
  absence of sufficient AI evidence is not an automatic exclusion.
- The source scripts contain illustrative event dates, names and emails. The
  configured fixtures override literal email examples; canonical event values
  must be observed and substitutions recorded. Required capabilities and exact
  checks cannot be weakened to fit seeded data.
- Production has exactly four routable SBEK aliases. Other upstream CSV contacts
  use reserved placeholder domains. Their import may be testable, but bulk
  sending to those addresses is not authorized or valid delivery evidence.
  Provision controlled recipients explicitly for real bulk-delivery acceptance.
- Mailpit receipts prove local capture only, not delivery through Resend or an
  external inbox. The adapter rejects unhealthy observations rather than scoring
  a transport failure as a missing email. It does not read attachments. Calendar
  import and day-long reminder checks remain manual/external follow-up.
- The separate file regression uses different valid v1/v2 PDFs and verifies ZIP
  bytes. Both `regression:files` and `--regression` enable isolated real
  scanner/storage; ordinary upstream local mode does not provide them. Unavailable prerequisites reduce
  coverage, and configured-service execution errors fail. The original suite
  retains its identical-file version test for criterion fidelity.
- The upstream content approval criterion cannot cite a later area's screenshots
  automatically. Exercise an actual public surface at collection time or abstain.
  Checkpoints preserve reached checks when later parts of a long scenario block.
- AEK's normal Git receipt now identifies Programcue directly. The coordinator
  builds fresh source before starting its isolated Worker. No custom Git/build
  identity script is needed. Production readiness separately records the deployed
  server's reported revision: local checkout identity is not deployment identity.
- Reports moved from the old standalone checkout are retained unchanged, including
  their old paths and fingerprints. They are historical artifacts, not resumable
  collections under the new configuration. Start a new run after this move.

## Validation and acceptance boundaries

Run `npm test`, `npm run validate`, and `npm run local -- --smoke` for bounded
validation without model calls. The three-scenario local-mail pilot above is a
separate focused browser/delivery check. A full run is an explicit operator action;
setup and tests never start one.

| Evidence | What closes the gap |
| --- | --- |
| Port structure and original criteria | Importer hash verification, preservation tests, and all three config validations |
| Local role preparation | Fresh isolated reset and five saved-role captures plus anonymous public browsing |
| Local email delivery | Explicit UI send followed by a correlated Mailpit receipt; healthy missing receipt fails |
| Full upstream workflows | An explicitly requested chained run; currently not verified end to end |
| Real signup, external inbox delivery, attachments/calendar import and timed reminders | Controlled accounts/providers and retained independent evidence; complete declared manual checks using `aek finalize` |
| Upload release and latest ZIP | Real available scanner/storage plus distinct PDF bytes; unavailable services reduce coverage |

AEK now accepts `provider: mailpit` in `mailboxes` for normal `emailAuth` flows.
Programcue's demo profile deliberately displays no-send verification fixtures,
so the local suite continues to capture demo personas. Declaring emailAuth here
would not turn those fixtures into actual email verification. Use a genuinely
email-driven target for that acceptance check; successful Mailpit auth remains
local capture evidence.

## Regression baseline

The named `local-astra-medium` baseline in `baselines/regression/` comes from
the verified nine-criterion run `2026-09-07T02-12-32` (100% score and coverage),
collected and promoted with the locked AEK 0.4.0 schema.
Its compact snapshot retains the source artifact root, scores, requested models,
medium reasoning and CLI versions; full evidence remains in the original run.
Promotion uses the configured `development` split, which contains all nine
current project criteria, and requires 100% score and coverage with every
required scenario exercised. This is a local comparison baseline, not production
acceptance. Loading and self-comparison pass with zero score or coverage drift.
The earlier snapshot remains unchanged as historical evidence; the active
snapshot includes the method provenance required by the installed kit.

After an explicitly authorized fresh combined run, compare it with:

```sh
./node_modules/.bin/aek baseline list --config evalkit.regression.yaml
./node_modules/.bin/aek compare --config evalkit.regression.yaml \
  --baseline-name local-astra-medium --candidate .agent-eval/runs/<run-id> \
  --output .agent-eval/comparisons/<run-id> --fail-on-regression
```

Use a complete nine-criterion candidate with the same scoring contract and model
settings. A publication-only run has a different selection and should be compared
with another publication-only run. Baseline updates require explicit promotion;
ordinary evaluation does not replace the baseline.
Baseline snapshots are generated, hash-verified evidence and are excluded from
Biome formatting alongside the pinned upstream sources. Do not reformat them;
use AEK's baseline loader and comparison command to verify their integrity.

## Production procedure

The old [SBEK notes](../docs/SBEK_EVALUATION.md) are historical context, not
current execution instructions. Verify production fixture provisioning, active
aliases and shared-workspace ownership against the current application before
using this profile. No script here resets production or installs/reads reset secrets.

1. Verify the intended application revision is deployed and no other evaluator
   is using the shared workspace. Use the current operator reset tooling only with explicit reset authorization.
2. Run `npm run auth:production`. Enter the access code in each opened browser;
   capture Event organiser, Clean applicant + Create evaluator submitter account,
   Co-speaker (Marcus), and Clean reviewer respectively. Capture only after reset,
   which invalidates all prior sessions. Attendee remains anonymous.
3. Run `npm run validate`, then `npm run run:production`. Each production scenario
   has a 30-minute deadline including provider finalisation; this provides headroom
   beyond the observed 20-minute round-setup workflow. A timeout is an execution
   failure even if the browser called `done`; it does not count as completed work.
   The configured readiness command checks the production health response and records its reported source
   revision in lifecycle diagnostics. Actual sending and provider work can occur.
4. Retain actual controlled-inbox/scanner/calendar evidence. Complete declared
   manual checks with `aek finalize --config evalkit.production.yaml --run <run>`.
   Resolve supported automatic abstentions using `aek adjudicate` with evidence;
   execution errors require repair/rerun. Verify the sealed run with `aek verify`.

A deployment/reset or changed evaluator config requires a new evaluation.
Do not run a production campaign loop without reset plus fresh authentication
between repetitions. No full live production score is claimed by this port.

# Programcue evaluations

Project-specific AEK suites live with the application in this repository.
All configs set `project.root: ..`, so AEK records Programcue's Git revision and
working-tree fingerprint. Private sessions, local package archives and reports
live in the ignored `evals/.agent-eval/` directory. The reusable harness remains
an installed dependency, not application source.

Two suites have separate configs and baseline directories. Runs share `.agent-eval/runs`; their project name, specs and fingerprints distinguish the scoring contracts:

| Suite | Config | Contract |
| --- | --- | --- |
| Upstream SBEK, local | `evalkit.local.yaml` | 7 areas, 22 executable scenarios from 20 upstream scripts, 98 criteria; optional CRM included |
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
preserves the original step text and all 98 criteria; tests verify collection
order and dependency behavior with the installed public AEK CLI.

Content setup and scheduling each consume CFP-S4's accepted-session handoff;
neither depends on speaker headshot uploads, content approval or ZIP export.
CRM depends on CFP-S1's event setup and establishes any missing contacts through
its original script. Speaker progress still requires the portal-edit scenario,
and content review still requires the upload scenario. A blocked upload therefore
retains unavailable coverage without preventing independent setup or scheduling.

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

```sh
npm run setup -- /absolute/path/to/agent-eval-kit
npm run validate
npm test
npm run plan
```

Setup builds and packs the specified AEK checkout into an ignored local archive,
then installs it using npm. The kit can be anywhere on disk; no sibling checkout,
package symlink or private-module import is required. Rerun setup after changing
AEK. `package-lock.json` records the installed archive's integrity. Ordinary
`npm install` requires the archive produced by setup.

The upstream configs use Codex collection and Claude judging; override with
`--agent codex --judge codex` when using one subscription. Preparation uses the
public `aek auth --json` result to locate saved browser sessions. The Programcue
regression config pins both roles to `gpt-6-astra` with `effort: medium`.
AEK records these requested settings and CLI versions in `receipt.json` and its
HTML report, and retains the actual invocation argv. Codex does not report a
resolved model snapshot in its current JSON stream; the requested ID is not
proof of an immutable provider implementation. Explicit overrides use
`--agent-model <id>` and `--judge-model <id>`.

## Local execution

Start the existing local mail capture service once:

```sh
docker compose -f ../compose.mailpit.yaml up -d
npm run local -- --smoke
```

The coordinator checks ports 5188/15188 and rebuilds Programcue even when
`PROGRAM_CUE_E2E_SKIP_BUILD=1` is inherited. It starts a Worker in a
new `.wrangler/e2e-state-aek-<uuid>` directory, resets that fixture through the
real demo UI and captures organizer Morgan Chen for upstream runs (Jordan Alvarez for regression
and bounded smokes), speaker Priya Raman,
showcase speaker Priya Shah and reviewer Sam Whitfield. Anonymous browsing has no persona cookie. The smoke
retains screenshots and results in `.agent-eval/local-smoke`; it invokes no model
and claims no signup, provider or delivery acceptance. The coordinator stops its
Worker and evaluator process groups, waits for surviving descendants to stop,
and removes only its own state directory on exit. An unexpected Worker exit
cancels the evaluator. Docker cleanup errors still release the coordinator lock.
Configured scanner failures stop the isolated runtime even when a blocked
browser outcome skips its collectors. Failed or forced isolated-Worker shutdown
makes the coordinator fail after cleaning up its owned resources.
It never
resets the ordinary development database or production, deletes Mailpit messages,
or imports production secrets.

```sh
# Fresh full upstream evaluation, including the CRM bonus:
npm run local

# Publication-only pilot (does not exercise anonymous form interaction):
npm run local -- --areas call-for-papers --scenarios CFP-S1 --max-turns 45

# Publication plus anonymous checks:
npm run local -- --areas call-for-papers --scenarios CFP-S1,CFP-S1-PUBLIC

# Separate Programcue requirements:
npm run regression:all -- --fail-under-score 100 --fail-under-coverage 100
npm run local -- --regression --areas publication
npm run local -- --regression --areas local-mail --agent codex --judge codex
```

Regression commands validate their complete selection through AEK's
`run --dry-run --json` before building, starting services or resetting fixtures.
They share an isolated Worker; only selections containing file-integrity
scenarios start the signed storage adapter and real ClamAV container. Mail and
publication selections need no scanner. The outbound allowlist permits the
enabled file services and only POST to `http://127.0.0.1:8025/api/v1/send`. Mailpit responses
and transport failures are preserved; redirects are rejected. `regression:all`
selects the three project areas (nine criteria), not the upstream suite.

Every invocation prepares fresh state. To preserve a target while investigating
or resuming, use a separate terminal:

```sh
npm run local -- --prepare-only
# Leave that terminal running. In a second terminal:
./node_modules/.bin/aek collect --config evalkit.local.yaml --include-optional
./node_modules/.bin/aek judge --evidence .agent-eval/runs/<collection-id>
./node_modules/.bin/aek run --config evalkit.local.yaml --resume .agent-eval/runs/<run-id>
```

Resume requires the original mode, config, selection and evidence. The example
`run --resume` is for an unfinished combined run; use `collect --resume` for an
unfinished collection. Do not restart/reset the target before resume. Ctrl+C
ends the prepared local target. `.agent-eval/local-worker.log` contains startup
diagnostics. A lock prevents concurrent local coordinators. After an uncatchable
process kill, inspect the PID in `.agent-eval/local.lock` and stop any surviving
owned Worker before removing the stale lock; never remove a live run's lock.

`--areas` must include declared prerequisite areas. `--scenarios` must explicitly
include prerequisites or dependent execution will be blocked. All five saved
personas are captured even for public scenarios, because their declared allowed
persona sets require them.

## Bounded product smokes

From `evals/`, run `npm run smoke:product`. This prepares one isolated local
Worker and runs three Playwright checks without model calls or sending email:

- The merged email iframe renders its actual recipient greeting and body in
  desktop/mobile sizes while retaining its opaque sandbox.
- A saved session-title edit remains absent from anonymous public browsing;
  unapproved publication is blocked; explicit approval/publication exposes it.
- The populated showcase speaker attempts two distinct PDF uploads and a
  latest-version ZIP export. A specific unavailable upload/scanner response or
  retained pending scan is reported as **blocked/skipped**, not passed. Unknown
  errors fail. This narrower smoke does not establish clean-persona onboarding.

Screenshots, failures and blocked annotations are retained in
`.agent-eval/product-smoke/`. The configured AEK read-only frame policy permits
text and image evidence from the representative merged email preview only on
`/admin/communications/` pages of the application origin. It requires a direct
`srcdoc` iframe whose sandbox was empty at attachment and has not changed.
State-preserving iframe moves revoke eligibility. No interactive references are
granted inside it. Other opaque frames remain excluded; the product sandbox is unchanged.
For preview images, scroll the content into view and request `fullPage: false`;
capture additional scroll positions for a tall preview. Chromium can leave an
offscreen opaque iframe blank in full-page images even when its text is readable.
AEK rejects that framing without saving an image, and permits a viewport retry.

Production explicitly allows `https://challenges.cloudflare.com` so the collector
can inspect and interact with the genuine verification frame. A read-only deployed
probe with that allowance still showed Security check in progress; no token or
application submission was observed. [Cloudflare does not support automated
browsers for production challenges](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/).
Keep genuine verification as manual acceptance; local mocked verification is not
live proof. The allowance does not bypass the challenge or award coverage.

Production instructions carry the operator-authorized ABS-S2-AI disclosure: the
synthetic CI proposal content and Initial Review rubric from this run's evaluation
event, sent through the configured Cloudflare Workers AI binding for one assessment,
followed by the specified human override. Inspect the displayed provider/model,
confirm in the product and preserve approval decisions. This scope excludes real
customer data, other providers/endpoints and provider-setting changes.

The complementary Worker test runs from the application root:

```sh
npm run test:worker:runtime -- app/modules/content/content-management-service.test.ts
```

It verifies a single-entry latest-version ZIP against distinct local R2 bytes.
Its explicitly released fixtures prove export behavior, not external scanning.

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

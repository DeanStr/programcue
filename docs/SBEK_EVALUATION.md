# SBEK evaluation runbook

The SessionBoard Eval Kit (`sbek`) mutates one chained event across submissions,
evaluation, speaker onboarding, scheduling, publication and optional CRM
scenarios. It may also create events and organisation contacts. The production
reset therefore owns the whole dedicated evaluation organisation, not an
ordinary customer event. Reset only before a new complete run, never between
chained scenarios.

## Choose the target

Use the isolated local Worker while iterating:

```bash
docker compose -f compose.mailpit.yaml up -d
PROGRAM_CUE_E2E_PORT=5180 npm run serve:e2e
```

This uses `.wrangler/e2e-state`, explicit demo identity selection and Mailpit.
Open `http://127.0.0.1:5180/demo`, continue as Jordan Alvarez and reset the
complete event. Local capture proves application behavior, not external email
delivery.

Use `https://app.programcue.com` for the final evaluation. It remains the one
production Worker with `APP_ENV=production` and `DEMO_MODE=false`; the checked-in
profile explicitly sets `EVALUATION_MODE=true`. Install these two independent
secrets for the evaluation period:

- `EVALUATION_ACCESS_CODE`: the private bearer code supplied to human and
  automated evaluators. It must be exactly 32 lowercase hexadecimal characters
  generated from 16 random bytes, for example with `openssl rand -hex 16`.
- `EVALUATION_SESSION_SECRET`: a random server-only signing value of at least 32
  characters. Never give this value to an evaluator.

Keep the two evaluation-session values in the ignored
`.env.production-evaluation` file and the eight reset-only values below in the
ignored `.env.production-evaluation-reset` file. Both files must have mode
`0600`. Source them only in the operator shell and never commit them; each value
still has to cross the Worker boundary through `wrangler secret put`.

```bash
chmod 600 .env.production-evaluation .env.production-evaluation-reset
test "$(stat -c '%a' .env.production-evaluation)" = 600
test "$(stat -c '%a' .env.production-evaluation-reset)" = 600

set -a
. ./.env.production-evaluation
set +a

printf '%s' "$EVALUATION_ACCESS_CODE" | \
  wrangler secret put EVALUATION_ACCESS_CODE -c wrangler.jsonc
printf '%s' "$EVALUATION_SESSION_SECRET" | \
  wrangler secret put EVALUATION_SESSION_SECRET -c wrangler.jsonc
```

Temporarily install these additional reset secrets before seeding:

- `EVALUATION_FIXTURE_SECRET`: a random value of at least 32 characters.
- `EVALUATION_RESEND_API_KEY`: a temporary full-access Resend key used only to
  read domain status, separate from the application's sending-only runtime key.
- `EVALUATOR_ORGANIZER_EMAIL`: Jordan Alvarez's routeable email address.
- `EVALUATOR_SPEAKER_EMAIL`: Priya Raman's routeable email address.
- `EVALUATOR_SECOND_SPEAKER_EMAIL`: Marcus Okafor's routeable email address.
- `EVALUATOR_REVIEWER_EMAIL`: Sam Whitfield's routeable email address.
- `EVALUATOR_SHOWCASE_SUBMITTER_EMAIL`: Alex Morgan's routeable showcase email
  address for email-based calendar invitations.
- `EVALUATOR_SHOWCASE_SPEAKER_EMAIL`: Priya Shah's routeable showcase email
  address for email-based calendar invitations.

The six addresses must be distinct, must not use reserved domains and must be
controlled by the evaluation operator. Alex and Priya Shah are populated
showcase identities rather than SBEK aliases; their addresses allow publishing
the showcase schedule to exercise real email-ICS delivery without sending
reserved-domain mail. Evaluators do not need mailbox access to use `/evaluate`
or enter the documented four SBEK aliases. Source the reset-only file, install
the values without placing a literal secret in shell history, and run the reset
from that same shell:

```bash
set -a
. ./.env.production-evaluation-reset
set +a

printf '%s' "$EVALUATION_FIXTURE_SECRET" | \
  wrangler secret put EVALUATION_FIXTURE_SECRET -c wrangler.jsonc
printf '%s' "$EVALUATION_RESEND_API_KEY" | \
  wrangler secret put EVALUATION_RESEND_API_KEY -c wrangler.jsonc
printf '%s' "$EVALUATOR_ORGANIZER_EMAIL" | \
  wrangler secret put EVALUATOR_ORGANIZER_EMAIL -c wrangler.jsonc
printf '%s' "$EVALUATOR_SPEAKER_EMAIL" | \
  wrangler secret put EVALUATOR_SPEAKER_EMAIL -c wrangler.jsonc
printf '%s' "$EVALUATOR_SECOND_SPEAKER_EMAIL" | \
  wrangler secret put EVALUATOR_SECOND_SPEAKER_EMAIL -c wrangler.jsonc
printf '%s' "$EVALUATOR_REVIEWER_EMAIL" | \
  wrangler secret put EVALUATOR_REVIEWER_EMAIL -c wrangler.jsonc
printf '%s' "$EVALUATOR_SHOWCASE_SUBMITTER_EMAIL" | \
  wrangler secret put EVALUATOR_SHOWCASE_SUBMITTER_EMAIL -c wrangler.jsonc
printf '%s' "$EVALUATOR_SHOWCASE_SPEAKER_EMAIL" | \
  wrangler secret put EVALUATOR_SHOWCASE_SPEAKER_EMAIL -c wrangler.jsonc

npm run evaluation:fixture:reset -- --yes
```

The reset completes production provider/binding checks, Resend's live
sender-domain verification, fixture identity and email-ownership checks before
destructive cleanup. On a first bootstrap, the shared seed may create the
dedicated canonical fixture rows before the remaining cleanup preflight runs;
that bounded fixture-only mutation is not a successful reset and must not be
reported as one. The reset also refuses active operations, multipart uploads,
integrations, communications, calendar attempts or webhook deliveries,
completed participant retention and cross-tenant fixed-fixture identities.

Its destructive scope is deliberately the dedicated `org-future-events`
fixture organisation. It restores `evt-foe-2025` and its private R2 prefix,
clears and tombstones additional events created there by prior evaluation runs,
clears their private R2 prefixes, and removes only otherwise-unreferenced
auxiliary people. Every address invited through the controlled-inbox journey is
treated as a retained global identity, including when its invitation is never
used. Reset removes its evaluation-organisation memberships and event
relationships; it does not promise deletion of the person or matching global
authentication state. An ordinary identity with Better Auth,
verification-token, actor-audit or other-organisation state is likewise
retained.
Fixed SBEK identities remain dedicated and fail reset if linked outside the
fixture. Event rows, global authentication state and append-only audit history
are retained. Reset never crosses the fixture organisation boundary. Reset
attempts use one renewable owner lease, so a second live request is rejected. A
verified failure or lease expiry before destructive work records a cancellation
and restores the previous completed generation. Once destructive work starts, a
failure or malformed state invalidates evaluator sessions and keeps evaluation
unavailable until a successful operator reset. The in-product reset is
inaccessible in that state: recreate the protected reset environment with a
fresh operator secret, a temporary full-access Resend key and the six persisted
fixture addresses; install those eight credentials, run the operator reset,
then repeat the removal and provider-key revocation steps below. Immediately
after every successful operator reset, delete all eight temporary Worker secrets:

```bash
wrangler secret delete EVALUATION_FIXTURE_SECRET -c wrangler.jsonc
wrangler secret delete EVALUATION_RESEND_API_KEY -c wrangler.jsonc
wrangler secret delete EVALUATOR_ORGANIZER_EMAIL -c wrangler.jsonc
wrangler secret delete EVALUATOR_SPEAKER_EMAIL -c wrangler.jsonc
wrangler secret delete EVALUATOR_SECOND_SPEAKER_EMAIL -c wrangler.jsonc
wrangler secret delete EVALUATOR_REVIEWER_EMAIL -c wrangler.jsonc
wrangler secret delete EVALUATOR_SHOWCASE_SUBMITTER_EMAIL -c wrangler.jsonc
wrangler secret delete EVALUATOR_SHOWCASE_SPEAKER_EMAIL -c wrangler.jsonc
```

Also revoke the temporary full-access API key in Resend itself; deleting its
Worker binding does not revoke the provider credential. The six routeable
addresses persist on the seeded D1 people and are no longer needed as Worker
secrets. After the provider-side revocation, clear the eight exported values and
remove their reset-only file; keep `.env.production-evaluation` because its
access code and signing secret remain active for the evaluation period:

```bash
unset EVALUATION_FIXTURE_SECRET EVALUATION_RESEND_API_KEY \
  EVALUATOR_ORGANIZER_EMAIL EVALUATOR_SPEAKER_EMAIL \
  EVALUATOR_SECOND_SPEAKER_EMAIL EVALUATOR_REVIEWER_EMAIL \
  EVALUATOR_SHOWCASE_SUBMITTER_EMAIL EVALUATOR_SHOWCASE_SPEAKER_EMAIL
rm -- .env.production-evaluation-reset
```

Verify the disabled reset boundary returns 404:

```bash
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  --request POST \
  https://app.programcue.com/api/internal/evaluation-fixture/reset
```

The fixture combines two useful data states:

- Morgan Chen, Jordan Lee, Taylor Brooks and Priya Shah retain a separate populated
  showcase cohort for human exploration: two completed reviews with visible
  score spread, one committee discussion, one published decision, one public
  speaker-profile revision, one active named programme embed and a published
  public event site with featured sessions, featured speakers, FAQ, About,
  Sponsors and two text-only sponsor records without outbound URLs.
- Jordan Alvarez, Priya Raman, Marcus Okafor and Sam Whitfield use the exact
  SBEK identities and begin without evaluator-created submissions,
  assignments, accepted-speaker access or tasks.

The baseline gives Jordan Alvarez organisation-administrator authority, a
verified Resend sender, five published communication templates (`Speaker task
reminder`, `Reviewer reminder`, `Speaker welcome`, `Submission confirmation`
and `Proposal decision`), and dated showcase tasks. Task reminders snapshot
`{{task.dueDate}}` in the event timezone and fail if a selected task has no due
date. The canonical event also carries a venue address and HTTPS map link. The
`Active speakers` audience is driven by event workflow state and
includes prospects, invited speakers and confirmed speakers while excluding
declined or withdrawn people.

This is additional production data, not a separate demo. Human evaluators open
`https://app.programcue.com/evaluate`, enter the private access code and choose
a fixed role card. Showcase roles open on useful populated work; separate clean
scenario identities preserve the chained SBEK starting state. The signed
eight-hour cookie contains only an optional allowlisted identity key, fixture
generation, version and expiry metadata and remains subject to every production
authorisation check. It is a bounded authentication realm separate from Better
Auth and ordinary applicant cookies: while present it never falls through to an
unrelated ordinary login, and private evaluation reads remain restricted to the
dedicated fixture organisation. Resetting the fixture invalidates all
previously issued evaluator cookies. Ordinary role selection does not grant
membership. The clean applicant card instead exposes one explicit, audited
`Create evaluator submitter account`
action: it creates or restores only Priya Raman's fixed accepted submitter
membership for the canonical event, leaves her durable email unverified and
makes no verification-email or provider-delivery claim. Only after that action
does the evaluation realm treat Priya as the fixed applicant on any active,
non-password-protected form in the dedicated fixture organisation. Creating a
draft through the ordinary application workflow creates that event's real
submitter membership; identity lookup itself does not. Cross-organisation and
password-protected forms remain unavailable. It does not change the durable
email-verification flag or create a Better Auth session. The secondary
`Activate account and choose event` action first performs the same canonical
activation, then opens `/events/select` with no preselected event; that list
shows only accepted or pending real memberships inside the fixture organisation
and invitation acceptance remains explicit. There is no `/demo` or provider
simulation. Better Auth and real Resend magic links remain
available for delivery/authentication acceptance, but are not required merely
to review every seeded persona. The 128-bit bearer code is verified before
rate-limit storage is touched, so possession cannot be denied by an exhausted
IP bucket or an unavailable invalid-attempt write. Invalid guesses are still
subject to the hashed D1 IP abuse limit; that limit is not the credential's
guess-resistance boundary. Missing or weak evaluator configuration returns
production runtime unavailability rather than an ordinary bad-code response,
and a missing fixture person is reported as reset-required unavailability rather
than an anonymous session. Sam remains
unauthorised until the organiser performs and the reviewer accepts the real
invitation workflow.

For reviewer AI, keep the consent and review steps with their actual actors.
Jordan first enables reviewer AI under `Review & selection`. After Jordan has
assigned the proposal, switch to Sam, save at least one independent rubric
response, then request and inspect the AI suggestions. Sam may fill unanswered
closed criteria from the suggestions or explicitly edit existing answers, must
confirm any unchanged imported values, and submits the review through the
ordinary reviewer workflow.
The configured organisation provider performs the request; the fixture does not
simulate provider output or enable reviewer AI during reset.

Once unlocked, the guide reads the shared canonical state rather than assuming
that both scenario identities are still pristine. Priya's card advances through
activation, draft and submitted/progressed application phases; Sam's advances
through valid or expired invitation, acceptance, assignment, draft review and
submitted review.
Only an identity with none of its corresponding work is labelled `Clean`. If
either identity has progressed, the guide tells evaluators to continue the
coordinated run or, before a separate run, confirm nobody else is evaluating and
use the fixture reset. Concurrent or overlapping evaluation runs are not
supported.

After initial operator provisioning, an unlocked evaluator can expand
`Reset evaluation data` on `/evaluate`, type `Future of Events 2027` and reset
the dedicated fixture before a separate LLM or human run. This routine action
uses the already-provisioned D1 identities and verified sender, not the removed
six address secrets or temporary full-access Resend key. It retains the same
tenant-dedication, active-work, retention, R2 and reset-owner fences, and is
limited to ten attempts per IP in a one-hour window. It resets the whole
shared evaluation workspace, invalidates everyone's saved evaluator cookies
and returns the initiating browser to the unlocked role picker with no persona.
Recapture all three starting states after it completes. If the persisted
identities or sender have drifted, the action fails and an operator must repeat
the separately authenticated provisioning procedure above.

The only production Turnstile exception is creation of the first anonymous
personal itinerary for the exact canonical fixture event while evaluation mode
is enabled. That action still consumes the ordinary hashed, D1-backed IP rate
limit. Every other production public-form action keeps its normal server-verified
Turnstile boundary when that action ordinarily requires one. This narrow
exception lets the automated evaluator exercise the itinerary without
weakening another event or Turnstile-protected action.

Production deliberately sets `EMBED_FRAME_ANCESTORS=*` only on public
`/embed/*` responses so an evaluator or customer site at an unknown origin can
frame a published programme. Other application responses retain
`frame-ancestors 'self'`. This inbound framing policy is separate from
`RESOURCE_EMBED_PROVIDERS`: organiser-authored resource blocks inside Program
Cue remain limited to typed YouTube, Vimeo and Google Maps integrations whose
exact origins are derived from code; production enables all three and requires
a restricted Google Maps Embed API key. The
auto-resize widget also accepts height messages only from the exact Program Cue
embed origin and matching frame window.

### Exact evaluator email aliases

Use these literal SBEK addresses in scenario forms and `evalconfig.json`:

| Persona        | SBEK address                             |
| -------------- | ---------------------------------------- |
| Jordan Alvarez | `jordan.organizer@sbek-test.example.com` |
| Priya Raman    | `priya.speaker@sbek-test.example.com`    |
| Marcus Okafor  | `marcus.speaker@sbek-test.example.com`   |
| Sam Whitfield  | `sam.reviewer@sbek-test.example.com`     |

Only those four exact addresses are aliases. In production evaluation mode,
inside an active event owned by the dedicated fixture organisation and through
a signed evaluator session, the server resolves each alias to its fixed
person's seeded routeable address and reports that routing in the result
message. An exact alias used outside that signed production-evaluation context
fails explicitly instead of being stored or sent as a literal reserved-domain
destination. Lookalikes and additional names are not aliases; normal production
send boundaries still reject every reserved or local-only destination before
mutation.
Marcus has no selectable `/evaluate` card or saved starting state; his alias is
only an in-scenario co-speaker input. Every alias is input compatibility for the
public evaluation kit, not a mailbox and not evidence of email delivery.

### Choose the correct reviewer invitation journey

**Guided scenario:** As Event organiser, invite
`sam.reviewer@sbek-test.example.com`. Program Cue persists Sam's pending
membership and invokes the real email provider boundary for his seeded
routeable address; provider failure remains visible. The evaluator does not
need access to that inbox. Return to `/evaluate`, select Sam's reviewer card
and explicitly accept the pending invitation. Use this path for the
reproducible chained scenario.

**Test your own inbox:** Return to Event organiser and invite an email address
you control. Program Cue creates or reuses a retained ordinary global identity
for that address and sends its real Better Auth magic link. Before opening the
message, return to `/evaluate` and select **Lock evaluation**. Then open the
link in the same browser, continue as that email identity and explicitly accept
its pending evaluator invitation. Do not select Sam's reviewer card for this
invitation. This identity remains global even if the invitation is never used;
reset removes its fixture access rather than promising account deletion.

Receipt of the controlled-address message is the email-delivery evidence.
Alias routing alone is not. Do not reset during an overlapping evaluation run;
afterward, reset removes the controlled identity's fixture access while
preserving its global identity and any authentication tokens or audit history.

## Configure the external evaluator

Keep the evaluator in a separate checkout so its pnpm dependencies, saved
sessions and evidence do not enter this repository:

```bash
git clone --depth 1 https://github.com/mkly/killmysaas-evals-coding-agent.git
cd killmysaas-evals-coding-agent
corepack pnpm install
cp evalconfig.example.json evalconfig.json
```

For local iteration, use `http://127.0.0.1:5180` and the evaluator's shipped
fixture emails. For the final run, set `url` to `https://app.programcue.com`
and use the exact four aliases above. Keep `includeOptional` enabled for the
Speaker Network/CRM bonus:

```json
{
  "url": "https://app.programcue.com",
  "areas": [],
  "includeOptional": true,
  "maxTurnsPerScenario": 70,
  "headless": true,
  "personaEmails": {
    "organizer": "jordan.organizer@sbek-test.example.com",
    "speaker": "priya.speaker@sbek-test.example.com",
    "speaker2": "marcus.speaker@sbek-test.example.com",
    "reviewer": "sam.reviewer@sbek-test.example.com"
  },
  "submissionNotes": "Program Cue production deployment with EVALUATION_MODE enabled for a dedicated seeded Future of Events fixture. Open /evaluate, enter the supplied access code and choose the matching fixed identity before saving each starting state. Organizer = Jordan Alvarez, speaker = Priya Raman, reviewer = Sam Whitfield; Marcus Okafor is an in-scenario co-speaker input, not a separately saved starting state. Return to /evaluate and select the target card whenever a scenario switches roles. For reviewer AI, Jordan enables it under Review & selection; after assignment, switch to Sam, save an independent rubric response, then request and inspect suggestions before submitting. The public programme is /public/programme/future-of-events-2027. When creating a blank D1 event, explicitly choose the available verified sender so that event's later communication workflow is ready. Reset only before a new full run, never between chained scenarios."
}
```

Do not authenticate the attendee persona: it is genuinely anonymous. After the
final reset, capture only the three scenario-starting states consumed by the
current kit:

- `organizer`: choose `Event organiser` under Showcase personas (Jordan
  Alvarez).
- `speaker`: choose `Clean applicant` and `Create evaluator submitter account`
  (Priya Raman) for the canonical chained scenario. `Activate account and choose
event` is only for inspecting real same-organisation memberships created by a
  prior optional journey.
- `reviewer`: choose `Clean reviewer` (Sam Whitfield). The fixed
  identity exists, but event access remains unavailable until Jordan performs
  the invitation step.

Marcus is an in-scenario co-speaker input, not a scenario-starting persona, so
the current kit consumes no `speaker2` saved browser state.

```bash
pnpm run sbek -- auth --persona organizer --at /evaluate
pnpm run sbek -- auth --persona speaker --at /evaluate
pnpm run sbek -- auth --persona reviewer --at /evaluate
```

For each command, complete the role selection in the browser, wait for its
destination to load, return to the terminal and press Enter. The harness writes
the saved `.auth/<host>.<persona>.json` state only after that confirmation.

When a scenario signs out to switch roles, Program Cue returns to `/evaluate`
with the access-code gate still unlocked but no private persona selected. Choose
the target fixed card there. `Lock evaluation` deliberately clears the evaluator
session; if it is used, re-enter the supplied access code before selecting the
next role.

## Validate, evaluate and finalize

Stamp the candidate revision in `SOURCE_REVISION`, apply the remote migration,
run `npm run deploy`, and verify `/api/v1/health` reports that exact revision.
Only then install the temporary reset secrets, run the initial clean production
fixture reset, remove those secrets and capture the three persona states. A D1 event
created during the optional scenario can explicitly copy a still-verified
sender from another active event in the same organisation. That is sender reuse
only; it neither copies templates nor claims a provider send.

In the speaker roster, `Add speaker record` creates a `prospect`, stores the
organiser-entered profile data in the organisation-scoped contact profile and
sends nothing. Use the separate row action to persist an actual portal
invitation and durable email operation. Do not report a roster record as an
invitation.

Run the common preflight first. The dry run validates specs and prints the plan;
it does not browse or judge:

```bash
pnpm run smoke
pnpm run eval -- --url https://app.programcue.com --include-optional --dry-run
```

For the unattended API path, supply the evaluator's supported Anthropic
credentials and run:

```bash
pnpm run eval -- --url https://app.programcue.com --include-optional
```

For the Codex-login/no-key path, do not use `sbek run`. Create the run, drive
each scenario through the `sbek` MCP server and judge each area in a fresh Codex
context or subagent. From the evaluator checkout, confirm the CLI is using the
intended ChatGPT login, register the checkout-local stdio server, and verify the
entry:

```bash
codex login status
codex mcp add sbek -- pnpm --silent exec tsx src/mcp.ts
codex mcp get sbek
```

Fully exit any existing Codex session, stay in the evaluator checkout, and
start `codex` there. Codex loads the evaluator repository's `AGENTS.md` once
when that new run starts, and the `sbek` tools should appear in `/mcp`. Then run
the plan and judgement commands from the evaluator checkout:

```bash
pnpm run sbek -- plan --url https://app.programcue.com --include-optional
# For every scenario: MCP start_scenario -> browser evidence -> done
pnpm run sbek -- judge-brief --area call-for-papers
# Repeat judge-brief for each area and write its judgement JSON.
pnpm run sbek -- score
```

This uses the Codex ChatGPT login rather than an evaluator API key. If
`codex login status` reports no ChatGPT session, run `codex login` and complete
its browser flow first. The MCP registration is stored in Codex configuration,
so remove it when this evaluation is finished:

```bash
codex mcp remove sbek
```

See the official [Codex MCP setup](https://developers.openai.com/codex/mcp),
[authentication](https://developers.openai.com/codex/auth) and
[`AGENTS.md` discovery](https://developers.openai.com/codex/guides/agents-md)
documentation for those CLI boundaries.

For a Codex-login headed pilot, temporarily set `headless` to `false` in the
ignored `evalconfig.json`, create a disposable single-scenario run, and drive it
through the same MCP browser path:

```bash
pnpm run sbek -- plan --url https://app.programcue.com --scenarios CFP-S1
# MCP start_scenario({ scenario_id: "CFP-S1" }) -> evidence -> done
```

If the pilot mutates production, use `Reset evaluation data` on the unlocked
guide and recapture all three saved persona states. Every reset invalidates
previously saved evaluator cookies. Reinstall the reset-only secret and six
fixture-address secrets and create a new temporary full-access Resend key only
when routine reset reports provisioning drift or the fixture has never been
provisioned; perform the full cleanup above immediately afterward. Restore the
intended `headless` setting, start a new full run, and only then begin the
complete ordered evaluation.

Complete `manual-results.json` honestly, then merge it into the report:

```bash
pnpm run sbek -- finalize --run runs/<timestamp>
```

The two bundled SBEK portraits exist only in the public programme projection
and its optional application featured-speaker preview for the canonical
demo/evaluation event and fixed Priya/Marcus person IDs. They never appear as
authenticated profile/file state, are disabled in ordinary production, are
suppressed by any non-deleted real headshot asset and are not upload, scan or
R2-release evidence.

The production run can incur ordinary Cloudflare, Resend, scanner and connected
provider usage. No provider success is simulated. Inbox receipt/bounce evidence
requires controlled real mailboxes, upload release requires the deployed
scanner callback, and scheduled-reminder evidence requires an actual cron run;
calendar/integration outcomes likewise remain external acceptance. Repository
tests and a local run cannot establish a 100% SBEK result. Claim that only after
this revision is deployed, the fixture is reset, a fresh complete ordered run
and human checklist are finalized, and the resulting report supports it.

# SBEK evaluation runbook

The SessionBoard Eval Kit (`sbek`) mutates one chained event across submissions,
evaluation, speaker onboarding, scheduling, publication and optional CRM
scenarios. Reset only before a new complete run, never between chained
scenarios.

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

Use `https://app.programcue.com` for the final evaluation. Production remains
`APP_ENV=production` and `DEMO_MODE=false`; do not deploy an evaluation or demo
runtime profile. Temporarily install these Worker secrets:

- `EVALUATION_FIXTURE_SECRET`: a random value of at least 32 characters.
- `EVALUATION_RESEND_API_KEY`: a temporary full-access Resend key used only to
  read domain status, separate from the application's sending-only runtime key.
- `EVALUATOR_ORGANIZER_EMAIL`: Jordan Alvarez's deliverable mailbox.
- `EVALUATOR_SPEAKER_EMAIL`: Priya Raman's deliverable mailbox.
- `EVALUATOR_SECOND_SPEAKER_EMAIL`: Marcus Okafor's deliverable mailbox.
- `EVALUATOR_REVIEWER_EMAIL`: Sam Whitfield's deliverable mailbox.

The four addresses must be distinct, must not use reserved domains and must be
accessible to the evaluation operator. Install them with `wrangler secret put
<NAME> -c wrangler.jsonc`, then run:

```bash
EVALUATION_FIXTURE_SECRET='<same reset secret>' \
  npm run evaluation:fixture:reset -- --yes
```

The reset fails before mutation if production provider/binding checks, Resend's
live sender-domain verification, tenant isolation or email ownership checks do
not pass. It affects only `org-future-events`, `evt-foe-2025` and
`private/events/evt-foe-2025/`; append-only audit history is preserved. Delete
`EVALUATION_FIXTURE_SECRET` and `EVALUATION_RESEND_API_KEY` immediately
afterward so the internal endpoint returns 404 and the elevated Resend key is
not retained. The four email secrets can also be deleted after a successful
seed.

The fixture combines two useful data states:

- Jordan Lee and Priya Shah retain populated review and speaker records for
  human exploration.
- Jordan Alvarez, Priya Raman, Marcus Okafor and Sam Whitfield use the exact
  SBEK identities and begin without evaluator-created submissions,
  assignments, accepted-speaker access or tasks.

This is additional production data, not a separate demo. Human evaluators can
use every normal production feature. Production persona access uses Better
Auth and real Resend magic links; there is no persona-switching cookie or
`/demo` entry point. The reset leaves the four fixture addresses unverified;
consuming each delivered magic link supplies the real email proof and creates
the new session.

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
and set `personaEmails` to the exact four production fixture addresses. Keep
`includeOptional` enabled for the Speaker Network/CRM bonus:

```json
{
  "url": "https://app.programcue.com",
  "areas": [],
  "includeOptional": true,
  "maxTurnsPerScenario": 70,
  "headless": true,
  "personaEmails": {
    "organizer": "<Jordan Alvarez mailbox>",
    "speaker": "<Priya Raman mailbox>",
    "speaker2": "<Marcus Okafor mailbox>",
    "reviewer": "<Sam Whitfield mailbox>"
  },
  "submissionNotes": "Program Cue ordinary production deployment with a dedicated seeded Future of Events fixture. Authenticate through normal magic links. Organizer = Jordan Alvarez, speakers = Priya Raman and Marcus Okafor, reviewer = Sam Whitfield. The public programme is /public/programme/future-of-events-2025. Reset only before a new full run, never between chained scenarios."
}
```

Do not authenticate the attendee persona: it is the genuinely anonymous
browser state. Establish the other personas through `/sign-in`, consume each
real magic link from its mailbox and save each browser state with the
evaluator's auth command. The reviewer can authenticate before invitation but
must remain unauthorized until Jordan explicitly grants the event relationship.

```bash
pnpm run sbek -- auth --persona organizer
pnpm run sbek -- auth --persona speaker
pnpm run sbek -- auth --persona speaker2
pnpm run sbek -- auth --persona reviewer
```

## Validate, evaluate and finalize

```bash
pnpm run smoke
pnpm run eval -- --dry-run
```

Run a small headed pilot before resetting once more and starting the complete
ordered evaluation. The no-key path uses the evaluator's `sbek` MCP server and
its `sbek-browse` and `sbek-judge` skills: Codex gathers evidence in one agent
context and a fresh agent context judges it. It does not require an OpenAI API
key. Outputs land under `runs/<timestamp>/`.

Complete the generated manual checklist honestly, then finalize:

```bash
pnpm run finalize -- --run runs/<timestamp>
```

The production run can incur ordinary Cloudflare, Resend, scanner and connected
provider usage. No provider success is simulated; external delivery and
calendar/integration outcomes remain real acceptance evidence.

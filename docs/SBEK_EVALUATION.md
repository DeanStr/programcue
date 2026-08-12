# SBEK evaluation runbook

The SessionBoard Eval Kit (`sbek`) must run against a disposable Program Cue
demo Worker. It mutates one chained event across submissions, evaluation,
speaker onboarding, scheduling, publication and optional CRM scenarios. Never
target production or a shared development database.

## Start Program Cue

From the Program Cue checkout:

```bash
docker compose -f compose.mailpit.yaml up -d
PROGRAM_CUE_E2E_PORT=5180 npm run serve:e2e
```

This uses the isolated `.wrangler/e2e-state` D1/R2 state and the explicit demo
runtime. Open `http://127.0.0.1:5180/demo`, select Jordan Alvarez and reset the
complete event before a new full evaluation. Do not reset between scenarios in
the same run.

The baseline deliberately combines two kinds of data:

- Jordan Lee and Priya Shah retain populated reviewer and speaker journeys for
  human exploration.
- Jordan Alvarez, Priya Raman, Marcus Okafor and Sam Whitfield use the exact
  SBEK fixture names and emails. They begin without evaluator-created
  submissions, assignments, accepted-speaker access or tasks.

With no demo identity selected, private routes return to `/demo`; public forms
and the published programme remain anonymously accessible. An explicit invite
or accepted decision activates only the matching SBEK fixture person's local
membership and writes an audit event. The UI still states that no email was
sent. Other demo invitations retain their normal pending/expiry behavior.

## Configure the external evaluator

Keep the evaluator in a separate checkout so its pnpm dependencies, saved
sessions and evidence do not enter this repository:

```bash
git clone --depth 1 https://github.com/mkly/killmysaas-evals-coding-agent.git
cd killmysaas-evals-coding-agent
corepack pnpm install
cp evalconfig.example.json evalconfig.json
```

Use this local configuration:

```json
{
  "url": "http://127.0.0.1:5180",
  "areas": [],
  "includeOptional": true,
  "agentModel": "claude-sonnet-5",
  "judgeModel": "claude-opus-5",
  "maxTurnsPerScenario": 70,
  "headless": true,
  "submissionNotes": "Program Cue explicit local demo. Start at /demo. organizer = Jordan Alvarez, speaker = Priya Raman, reviewer = Sam Whitfield. Exact fixture invitations activate locally after the explicit organizer action; no email delivery is claimed. Populated Jordan Lee and Priya Shah identities are human showcase journeys and must not replace the SBEK personas. The public programme is /public/programme/future-of-events-2025. Reset only before a new full run, never between chained scenarios."
}
```

Do not override `personaEmails`; the evaluator's shipped fixture emails match
the stable demo people.

Save persona sessions without an inbox:

```bash
pnpm run sbek -- auth --persona organizer \
  --at /demo --click "Continue as Jordan Alvarez"
pnpm run sbek -- auth --persona speaker \
  --at /demo --click "Continue as Priya Raman"
pnpm run sbek -- auth --persona reviewer \
  --at /demo --click "Continue as Sam Whitfield"
```

The reviewer capture is valid before Sam has access: it saves his identity
cookie while the guide explains that he is waiting for an invitation. After
Jordan explicitly invites the exact reviewer email, a fresh reviewer scenario
opens Sam's authorised workbench. Do not authenticate the attendee persona.

## Validate, evaluate and finalize

```bash
pnpm run smoke
pnpm run eval -- --dry-run
```

For the unattended API path, provide `ANTHROPIC_API_KEY` through the shell and
run a small pilot before resetting and starting the complete ordered run:

```bash
pnpm run eval -- --areas call-for-papers --scenarios CFP-S1 \
  --max-turns 30 --headed
pnpm run eval
```

The no-key coding-agent path uses the evaluator's `sbek` MCP server and its
`sbek-browse` and `sbek-judge` skills. Browsing and judging must use separate
fresh agent contexts. In either path, outputs land under `runs/<timestamp>/`.
Complete the generated manual checklist honestly, then finalize:

```bash
pnpm run finalize -- --run runs/<timestamp>
```

Mailpit evidence is local capture, not proof of external delivery. Calendar,
provider and multi-account checks remain manual or external acceptance where
the generated checklist says so.

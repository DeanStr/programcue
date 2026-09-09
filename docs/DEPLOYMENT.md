# Deployment runbook

Use this runbook for provisioning, releases and credential rotation. Resource
bindings and secret requirements are enforced by [wrangler.jsonc](../wrangler.jsonc)
and [the deployment contract](../scripts/deploy-contract.mjs).
[Implementation status](IMPLEMENTATION_STATUS.md#latest-recorded-deployments)
records dated deployment and acceptance evidence; these instructions do not
assert that the current checkout is deployed. Evaluation fixture setup belongs
to [the evaluation runbook](SBEK_EVALUATION.md), and backup/restore procedures to
[the recovery runbook](RECOVERY.md).

Run the commands below from the Program Cue repository root so Wrangler uses
the intended configuration files.

For headless Wrangler access in this workspace, keep the temporary deployment
token and account ID only in the ignored, mode-0600 `.env.cloudflare` file and
source that file explicitly before Wrangler commands. Do not put deployment
credentials in the root `.env`; Vite treats that file as application runtime
input during builds.

## Provisioning

The checked-in production profiles define the resource inventory:

- WNAM D1 database `program-cue-db-wnam`
  (`ac812720-eefc-45d0-b6cf-0236ab8de8c8`). Historical region-cutover evidence is
  recorded in the implementation audit; do not infer retained rollback resources
  from that historical record.
- Private R2 buckets `program-cue-files` and `program-cue-d1-backups`, plus R2
  S3 API credentials scoped to the files bucket.
- Queue `program-cue-operations` and dead-letter queue
  `program-cue-operations-dlq`.
- Durable Object classes `EventChannel` and `ProgramCueEventAgent`, Workers AI
  binding `AI`, Images binding `IMAGES`, and Workflow
  `program-cue-d1-backup`; Wrangler creates these from the checked-in bindings
  and migrations.
- File-scanner Worker `program-cue-file-scanner`, Workflow
  `program-cue-file-scans` and a four-slot EU-pinned pool of `standard-2`
  Cloudflare Containers running the pinned ClamAV 1.4 LTS image. Each container
  checks the running daemon's loaded signatures on every readiness probe (at
  most seven days old), refreshes them in the background, exits after one admitted scan
  and retains a five-minute idle fallback plus an independent graceful-shutdown
  trigger after forty minutes for cold-start or provider-alarm failures.
- A Resend sending domain and webhook, the provisioned Turnstile widget, and
  matching application/scanner credentials.
- Google and Microsoft OAuth applications for participant sign-in and calendar
  connections. Airtable and Accelevents credentials are entered per integration
  after deployment and encrypted with `INTEGRATION_CREDENTIALS_KEY`.

Provider setup for this production hostname uses these exact endpoints:

- Resend sender `Program Cue <auth@programcue.com>` and webhook
  `https://app.programcue.com/api/webhooks/resend`.
- Google redirect URIs `https://app.programcue.com/api/auth/callback/google`
  and `https://app.programcue.com/oauth/calendar/callback`.
- Microsoft redirect URIs
  `https://app.programcue.com/api/auth/callback/microsoft` and
  `https://app.programcue.com/oauth/calendar/callback`.
- File-scanner endpoint `https://scanner.programcue.com/v1/scans` and callback
  `https://app.programcue.com/api/webhooks/file-scanner`.
- R2 S3 Object Read & Write credentials scoped only to
  `program-cue-files`, and a separate durable D1 token scoped to the production
  database for scheduled logical exports. Do not reuse the temporary deployment
  token for either runtime credential.

Install the complete runtime secret inventory during initial provisioning.
For later changes, follow [Credentials and rotation](#credentials-and-rotation);
provider encryption keys require an atomic bulk update, not individual puts:

```bash
wrangler secret put BETTER_AUTH_SECRET
wrangler secret put ANONYMOUS_ITINERARY_SECRET
wrangler secret put RESEND_API_KEY
wrangler secret put RESEND_WEBHOOK_SECRET
wrangler secret put CALENDAR_CREDENTIALS_KEY
wrangler secret put GOOGLE_CALENDAR_CLIENT_ID
wrangler secret put GOOGLE_CALENDAR_CLIENT_SECRET
wrangler secret put MICROSOFT_CALENDAR_CLIENT_ID
wrangler secret put MICROSOFT_CALENDAR_CLIENT_SECRET
wrangler secret put GOOGLE_AUTH_CLIENT_ID
wrangler secret put GOOGLE_AUTH_CLIENT_SECRET
wrangler secret put MICROSOFT_AUTH_CLIENT_ID
wrangler secret put MICROSOFT_AUTH_CLIENT_SECRET
wrangler secret put INTEGRATION_CREDENTIALS_KEY
wrangler secret put WEBHOOK_CREDENTIALS_KEY
wrangler secret put TURNSTILE_SECRET_KEY
wrangler secret put FILE_SCANNER_DISPATCH_SECRET
wrangler secret put FILE_SCANNER_WEBHOOK_SECRET
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put D1_REST_API_TOKEN
wrangler secret put EVALUATION_ACCESS_CODE
wrangler secret put EVALUATION_SESSION_SECRET
wrangler secret put GOOGLE_MAPS_EMBED_API_KEY
```

## Application release

Before each release, verify the production URLs, sender and embed
configuration in both Wrangler profiles. `RESOURCE_EMBED_PROVIDERS` is either
`none` or a comma-separated selection of `youtube`, `vimeo` and `google_maps`.
Program Cue derives the exact CSP origins and iframe capabilities from its typed
provider registry; operators do not enter origins. Google Maps additionally
requires `GOOGLE_MAPS_EMBED_API_KEY`, restricted to the Maps Embed API and the
Program Cue HTTP referrers in Google Cloud. The production profile enables all
three providers, so deployment fails its secret inventory and runtime readiness
checks until that restricted key is installed. Release the tested checkout with
the single ordered entry point:

```bash
npm run deploy
```

The command runs the complete release gate once and retains that build. Before
any remote mutation it requires a clean checkout, configuration and secret
preflights, D1 integrity, the immutable deployed migration baseline and an
applied ledger that is an exact prefix of the local migration order. It then
applies migrations, requires the exact remote ledger and deployed schema,
deploys the unchanged tested artifact with the checkout's full Git revision and
confirms production health reports that revision. The protected release
workflow invokes this same entry point. Lower-level `deploy:*` commands are not
a substitute for the ordinary release command.

The manually dispatched [Production release workflow](../.github/workflows/release.yml)
uses this same entry point. Configure repository branch protection to require
the checked-in CI gates and require operator approval for the `production`
environment. The workflow needs a Cloudflare account ID and deployment token;
checked-in workflow files do not prove these external settings are configured.

## Scanner release

The scanner is deployed separately with `npm run deploy:scanner`. Its
deployment token requires account-level Workers Scripts Write and Containers
Edit plus the existing `programcue.com` Worker-route authority. Configure
`PROGRAM_CUE_DISPATCH_SECRET` on the scanner with the exact value used for the
application's `FILE_SCANNER_DISPATCH_SECRET`; likewise, configure
`PROGRAM_CUE_CALLBACK_SECRET` with the application's
`FILE_SCANNER_WEBHOOK_SECRET`. Both pairs are independently random values of at
least 32 characters, and the dispatch secret must differ from the callback
secret. The application signs the exact, short-lived scan envelope; the scanner
verifies that signature before persisting an idempotent Workflow, then reads the
bound private R2 object only after its key, ETag and size match the envelope. It
returns only an HMAC-signed verdict bound to the same organisation and object.
A failed, expired or ambiguous scan leaves the file quarantined.

## Public website release

The public website is deployed separately with `npm run deploy:site`. It is a
static-asset Worker in `site/` with no D1, R2, Queue, Durable Object or AI
binding: it publishes the home page, `/privacy` and `/terms` that Google's OAuth
verification reviewers must be able to read anonymously, plus a separate
product guide at `/guide`. It deliberately shares no authorisation or
readiness path with the application. Deployment
requires the `programcue.com` and `www.programcue.com` Custom Domains to be
attached to `program-cue-site`; `www` answers a 301 to the apex host.
Plain-HTTP requests to either production hostname are also upgraded to the
secure apex URL.
`npm run deploy:site` runs `scripts/validate-site-config.mjs` first, which fails
the deploy on a lost Custom Domain, a data binding, a `noindex`, a broken
internal link or anchor, placeholder copy, a missing contact address, or a
privacy policy that no longer carries the declared Google scopes and the Limited
Use statement. Preview it locally with `npm run dev:site`; run its focused
desktop/mobile accessibility, containment and visual coverage with
`npm run test:site:e2e`. That suite uses port `8788` by default; set
`PROGRAM_CUE_SITE_E2E_PORT` when it is occupied. During `npm run check`, an
overridden `PROGRAM_CUE_E2E_PORT` automatically gives the site an isolated port
1,000 higher unless the site-specific value is set.

## Initial workspace bootstrap

The production bootstrap is intentionally one-time and requires an empty,
migrated application database. It atomically creates the first Better Auth
person, organisation-wide owner membership and explicitly slugged initial event;
it does not install a permanent bootstrap endpoint. Ordinary email, Google and
Microsoft identity creation remains available after bootstrap, but signup alone
creates no organisation, event, membership or participant access. After
deployment, the bootstrap owner requests their first magic link at `/sign-in`.
Production is already bootstrapped; do not run this command there again. For a
new empty production database only, run it once after migrations:

```bash
npm run db:bootstrap:production -- \
  --owner-email owner@your-domain.example \
  --owner-name "Owner Name" \
  --organisation-name "Organisation Name" \
  --organisation-slug organisation-name \
  --event-name "Event Name" \
  --event-slug event-name \
  --timezone America/Toronto \
  --start-date 2027-05-20 \
  --end-date 2027-05-22 \
  --yes
```

## Credentials and rotation

`BETTER_AUTH_SECRET` and `ANONYMOUS_ITINERARY_SECRET` must contain at least
32 characters and must be independently generated. Missing, short or reused
values fail production readiness; anonymous itineraries never fall back to the
authentication secret.
Rotating `ANONYMOUS_ITINERARY_SECRET` is an intentional destructive reset while
the product is pre-release: existing anonymous cookies stop verifying and their
event-scoped database rows can no longer be found. Signed-in itineraries are
unaffected. Coordinate any required rotation with removal of the unreachable
anonymous rows; do not retain a previous-key compatibility fallback.
`CALENDAR_CREDENTIALS_KEY`, `INTEGRATION_CREDENTIALS_KEY` and
`WEBHOOK_CREDENTIALS_KEY` must each be an independently generated,
base64-encoded 32-byte AES-GCM key. Their version-2 envelopes contain a
non-secret key identifier; calendar envelopes also authenticate the owning
organisation, connection, provider and stable credential generation.

Before the first rotation, deploy the recovery-capable application source and
wait until the old deployment no longer receives traffic and its in-flight
provider requests have drained; allow at least one minute after cutover. Then
rotate one key with one atomic bulk-secret update: set its current value as the
matching `*_PREVIOUS_KEY` and set a newly generated value as the active `*_KEY`.
Do not update them with separate `secret put` commands because the intermediate
deployment would be invalid. For example, use a local ignored JSON or dotenv
file such as `.env.provider-rotation.json` (covered by `.gitignore`), set its
permissions to `0600`, and run:

```bash
chmod 600 .env.provider-rotation.json
npx wrangler secret bulk -c wrangler.jsonc < .env.provider-rotation.json
```

The minute scheduler then rewraps at most 100 rows of each credential type per
run with compare-and-set updates; its `provider-credential-rewrap` structured
log reports `rewrapped` and `remaining`. New writes always use the active key,
in-flight calendar OAuth state accepts the one explicit previous key for its
ten-minute lifetime, and an in-flight calendar token refresh can safely finish
after a rewrap without repeating the provider exchange or losing a rotated
refresh token, including when the refresh began on the pre-rotation deployment.
Webhook API replays fingerprint the signing secret rather than its randomized
envelope, so a rewrap does not look like a user-requested secret rotation; the
rewrapper also upgrades still-live legacy ciphertext fingerprints before it
changes the envelope, including legacy version-1 envelopes during this explicit
rotation window. After `remaining` first reaches zero, exercise the
affected provider operations and wait at least ten minutes for calendar OAuth
state plus all requests on the pre-rotation deployment to drain. Run the
rewrapper again and require a second `remaining = 0` observation before
removing the matching previous key by setting it to `null` in one JSON
bulk-secret update, then verify readiness again. (Dotenv bulk files cannot
delete secrets.)
Never leave a previous key installed as an indefinite fallback, and retain it
in the approved backup-recovery key inventory until the associated backups
expire.

## Provider selection

Workers AI is the configured default and
uses the Cloudflare-hosted `@cf/deepseek-ai/deepseek-v4-flash-0731` model;
that model requires a Workers Paid plan. Runtime readiness verifies the binding
and exact model selection, while a real request after deployment proves billing
access and provider acceptance.
`OPENAI_API_KEY` or `ANTHROPIC_API_KEY` is an additional Cloudflare secret only
when that provider is deliberately selected. `npm run deploy:secrets` queries
the configured Worker and fails if the complete required secret inventory is
missing. Production fixes `EMAIL_PROVIDER=resend`; runtime validation rejects
Mailpit and never falls back to local capture, demo identity, stale data or
simulated provider success.

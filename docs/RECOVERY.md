# Recovery runbook

Program Cue uses [Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) for point-in-time recovery and [logical SQL exports](https://developers.cloudflare.com/d1/best-practices/import-export-data/) for longer-lived, independently verifiable backups. File objects remain private in R2 and follow the event retention/legal-hold workflow; a D1 restore does not recreate deleted R2 bytes.

## Routine evidence

Run the clean-room local drill after schema changes:

```bash
npm run recovery:drill
```

The drill creates an isolated D1 database from the baseline and inserts a deterministic cross-table conference chain: organisation, people/membership, event policy, track/room, published session/speaker/schedule, readiness task, released file metadata and append-only audit evidence. It exports that database, imports it into a second isolated database, then requires exact representative values and relationships, identical row counts for every application table, no foreign-key violations, a successful SQLite integrity check, and matching index/trigger counts. It does not claim to back up R2 object bytes. Temporary data is removed after the check.

Production configuration schedules `D1BackupWorkflow` at 02:17 UTC every day. The scheduler derives the UTC date from Cloudflare's scheduled timestamp and calls the Workflow binding with the deterministic `d1-backup-YYYY-MM-DD` instance ID. Because Cloudflare rejects a duplicate instance ID, the scheduler verifies the existing instance and its known status before recording the duplicate schedule as deduplicated. At 03:47 UTC, a separate scheduled monitor requires that day's exact manifest and matching SQL object to exist in private R2; absence or integrity drift becomes an error-level application log. The Workflow:

1. Refuses to run without a valid account ID, matching D1 database UUID, private `BACKUPS` R2 binding and `D1_REST_API_TOKEN`.
2. Starts and continually polls Cloudflare's [D1 export API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/) in durable, separately retryable steps.
3. Downloads only the HTTPS Cloudflare R2 signed URL returned by that API and streams it into the dedicated backup bucket without buffering the SQL dump in Worker memory.
4. Computes SHA-256 with the Workers streaming digest API, checks the stored byte count, refuses to replace different bytes at the daily key and writes a conditional, immutable JSON manifest beside the SQL object.
5. Emits JSON logs with `subsystem=d1-backup`, the Workflow instance ID, UTC backup date, stage, byte count and checksum. It never logs the API token or signed download URL.

Daily objects use these private keys:

```text
d1-logical/YYYY-MM-DD/program-cue-YYYY-MM-DD.sql
d1-logical/YYYY-MM-DD/program-cue-YYYY-MM-DD.sql.manifest.json
```

Provision `program-cue-d1-backups` as a private bucket with no `r2.dev` or public custom-domain access. Set `CLOUDFLARE_ACCOUNT_ID` and `D1_DATABASE_ID` to the same account/database used by the `DB` binding, and create `D1_REST_API_TOKEN` as a Cloudflare secret restricted to the target account and D1 export access. The production deploy preflight checks the binding, schedule, identifiers and secret name; it cannot prove bucket privacy, token scope, successful execution or alert delivery.

The D1 export API can make the database temporarily unavailable while it creates the dump. Keep the daily cron in a measured low-traffic window and inspect both the Workflow instance timeline and Workers JSON logs after deployment. Alert on missing daily `completed` events and every meaningful application, Queue, scanner or backup error. Cloudflare exposes [per-Workflow status metrics](https://developers.cloudflare.com/workflows/observability/metrics-analytics/); the next autonomous run and measured recovery objectives remain deployment acceptance work.

Create an additional operator-controlled logical export in an access-controlled destination when needed:

```bash
npm run backup:d1 -- --output=/secure/backups/program-cue-$(date -u +%Y%m%dT%H%M%SZ).sql
```

The command refuses to overwrite a file and writes a mode-0600 SHA-256 manifest beside it. It remains an independent pre-change/incident export path; it does not replace the scheduled Workflow.

The scheduled logical-export objective is a maximum 24-hour logical-backup RPO once the Workflow is deployed and monitored. D1 Time Travel provides plan-window restore points independently.

Production evidence from 13 August 2026: Workflow instances for 11, 12 and the original 13 August instance first failed at `initiate D1 logical export` with Cloudflare HTTP 401/code 10000. The 13 August cron fired on schedule at 02:17 UTC and failed one second after starting, confirming that scheduling was healthy and the then-installed runtime credential was the first blocker. A new account-owned token restricted to this account and D1 Write was installed as `D1_REST_API_TOKEN` and expires on 13 August 2027. Live retries then found two API-contract gaps: bookmark polls must repeat `output_format: "polling"`, and the completed result's signed URL must be downloaded directly rather than polling the terminal bookmark again. The deployed corrections are covered by focused tests.

Because an existing instance stays pinned to its original Workflow code, the corrected production class was registered temporarily under an acceptance-only Workflow name and triggered with the exact `d1-backup-2026-08-13` identity and 02:17 UTC scheduled timestamp. The run completed all six steps in 15 seconds and stored the canonical private keys. The SQL object is 167,106 bytes with SHA-256 `815ce92e5f601eaf93ee11eae8644850c23da2dd8cca82e059c985ee0b6b4b40` and ETag `fb5589f9851282fc0c13f65d1c47bf08`; the adjacent manifest matches. Retained logs record the same completion at source revision `18212c18c24b094021aeffb924659f0928b6bc0d`. The temporary Workflow registration was deleted. This proves the deployed canonical code/class but not yet the next autonomous post-fix cron.

The autonomous 14 and 15 August instances initiated an export and received a pending bookmark, but both errored after the then-configured ten-second wait before their first poll. A separate, token-sanitised poll of the 15 August bookmark returned Cloudflare's inner result error `Not currently exporting anything.` The Workflow had also masked that response by requiring another bookmark before checking `result.success`. Application source `5109324` includes the correction to poll once immediately, continue every second while pending, allow the full export-duration budget and report provider result errors directly, plus the later R2 evidence monitor. Its 23 focused backup tests and the complete core gate passed, and Worker version `e7d12152-dbbc-42f5-9063-73bf97bafdeb` is deployed. The next canonical autonomous acceptance is `d1-backup-2026-08-16` at 02:17 UTC followed by the 03:47 monitor; do not treat the code correction alone as that acceptance.

The exact Workflow-created R2 SQL object and manifest were downloaded, checksum-verified and imported into an isolated Oceania D1 database. All 93 non-internal table row counts matched production exactly, `PRAGMA foreign_key_check` returned no rows, `PRAGMA quick_check` returned `ok`, and the restored 102 non-SQLite indexes and 77 triggers matched production. The isolated database and local plaintext were deleted after validation. This proves a non-destructive production logical-export restore from private R2, not a production point-in-time restore, alert delivery or measured incident RTO.

The acceptance export briefly made production D1 unavailable and one minute of the communication/outbound-webhook scheduler logged `Currently processing a long-running export`; later minute cron invocations returned to `ok`. Keep 02:17 UTC as a low-traffic window and treat this short unavailability as an explicit operational constraint. Workers Observability has three account-level alerts attached to the enabled Program Cue email policy: scanner errors, meaningful application/Queue/scheduled-task errors, and D1 backup/scheduler/monitor errors. The broad application rule excludes routine React Router not-found traces from stale hashed-asset requests. A direct `count < 1` log rule was removed after live evaluation showed that Cloudflare resolves an entirely absent filtered series instead of treating its count as zero; the 03:47 R2 monitor converts that absence into a real error event instead. Harmless 404 exercises moved the alert to `firing`, including incidents `NCRGGQREN0`, `7321V7TT4B` and `QQ6DZGHEYW`. Direct tests of both the original and replacement notification policies appear in Notification History as dispatched to the owner address, but none of those real incidents produced a Notification History entry. Canonical-UUID reassociation and policy replacement did not correct the handoff. Treat Workers Observability email delivery as unavailable until Cloudflare resolves this reproducible platform failure and a new real firing incident is recorded and received. Until the 16 August autonomous run and monitor succeed, do not claim the 24-hour logical-backup RPO as operationally met.

## Point-in-time incident recovery

1. Stop consequential mutations and Queue consumers for the affected environment.
2. Record the incident timestamp, current D1 bookmark, active operation IDs, latest successful Workflow instance ID and latest logical-export manifest in the incident log. Verify the manifest SHA-256, byte count and object ETag against the downloaded private R2 object before using it.
3. Use `wrangler d1 time-travel info program-cue-db-wnam --timestamp=<RFC3339> -c wrangler.jsonc` to resolve the intended restore point.
4. Export the current damaged state before changing it.
5. Review the affected interval and obtain explicit incident-owner approval.
6. Run `wrangler d1 time-travel restore program-cue-db-wnam --bookmark=<bookmark> -c wrangler.jsonc`. This is destructive and must remain interactive.
7. Apply any newer immutable migrations, then run health, tenant-isolation, operation-state, file-version and published-programme checks.
8. Reconcile R2, Resend, calendar, Airtable, Accelevents and outbound-webhook side effects by their durable operation/idempotency records before resuming consumers.
9. Retain the pre-restore bookmark printed by Cloudflare so the restore itself can be undone.

Cloudflare Time Travel is automatically available on production D1 and keeps restore points for the plan-specific retention window. A deployed recovery exercise and measured RPO/RTO remain environment acceptance work; local passing evidence is not a claim that production was restored.

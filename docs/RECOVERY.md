# Recovery runbook

Program Cue uses [Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) for point-in-time recovery and [logical SQL exports](https://developers.cloudflare.com/d1/best-practices/import-export-data/) for longer-lived, independently verifiable backups. File objects remain private in R2 and follow the event retention/legal-hold workflow; a D1 restore does not recreate deleted R2 bytes.

## Routine evidence

Run the clean-room local drill after schema changes:

```bash
npm run recovery:drill
```

The drill creates an isolated D1 database from the baseline and inserts a deterministic cross-table conference chain: organisation, people/membership, event policy, track/room, published session/speaker/schedule, readiness task, released file metadata and append-only audit evidence. It exports that database, imports it into a second isolated database, then requires exact representative values and relationships, identical row counts for every application table, no foreign-key violations, a successful SQLite integrity check, and matching index/trigger counts. It does not claim to back up R2 object bytes. Temporary data is removed after the check.

Production configuration schedules `D1BackupWorkflow` at 02:17 UTC every day. The scheduler derives the UTC date from Cloudflare's scheduled timestamp and calls the Workflow binding with the deterministic `d1-backup-YYYY-MM-DD` instance ID. Because Cloudflare rejects a duplicate instance ID, the scheduler verifies the existing instance and its known status before recording the duplicate schedule as deduplicated. The Workflow:

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

The D1 export API can make the database temporarily unavailable while it creates the dump. Keep the daily cron in a measured low-traffic window and inspect both the Workflow instance timeline and Workers JSON logs after deployment. Alert on missing daily `completed` events and every `failed` event. Cloudflare exposes [per-Workflow status metrics](https://developers.cloudflare.com/workflows/observability/metrics-analytics/); notification/Logpush routing and a successful live backup remain deployment acceptance work.

Create an additional operator-controlled logical export in an access-controlled destination when needed:

```bash
npm run backup:d1 -- --output=/secure/backups/program-cue-$(date -u +%Y%m%dT%H%M%SZ).sql
```

The command refuses to overwrite a file and writes a mode-0600 SHA-256 manifest beside it. It remains an independent pre-change/incident export path; it does not replace the scheduled Workflow.

The scheduled logical-export objective is a maximum 24-hour logical-backup RPO once the Workflow is deployed and monitored. D1 Time Travel provides plan-window restore points independently. No production backup run, alert, restore exercise or measured RPO/RTO has been completed from this workspace, so those remain explicit release-acceptance evidence rather than an implementation claim.

## Point-in-time incident recovery

1. Stop consequential mutations and Queue consumers for the affected environment.
2. Record the incident timestamp, current D1 bookmark, active operation IDs, latest successful Workflow instance ID and latest logical-export manifest in the incident log. Verify the manifest SHA-256, byte count and object ETag against the downloaded private R2 object before using it.
3. Use `wrangler d1 time-travel info program-cue-db --timestamp=<RFC3339> -c wrangler.jsonc` to resolve the intended restore point.
4. Export the current damaged state before changing it.
5. Review the affected interval and obtain explicit incident-owner approval.
6. Run `wrangler d1 time-travel restore program-cue-db --bookmark=<bookmark> -c wrangler.jsonc`. This is destructive and must remain interactive.
7. Apply any newer immutable migrations, then run health, tenant-isolation, operation-state, file-version and published-programme checks.
8. Reconcile R2, Resend, calendar, Airtable, Accelevents and outbound-webhook side effects by their durable operation/idempotency records before resuming consumers.
9. Retain the pre-restore bookmark printed by Cloudflare so the restore itself can be undone.

Cloudflare Time Travel is automatically available on production D1 and keeps restore points for the plan-specific retention window. A deployed recovery exercise and measured RPO/RTO remain environment acceptance work; local passing evidence is not a claim that production was restored.

import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import { AirtableProviderBoundary } from "./airtable-provider-boundary.server";
import { AIRTABLE_REPOSITORY_PROVIDER } from "./airtable-room-repository.server";

const STALE_RUNNING_SECONDS = 60;

const recoverableSummarySchema = z.object({
  kind: z.literal("airtable_event_projection"),
  phase: z.enum(["intent_recorded", "d1_committed", "external_committed"]),
  eventId: z.string().min(1),
  operation: z.string().min(1),
  beforeHash: z.string().min(1),
  afterHash: z.string().min(1).optional(),
  error: z.string().optional(),
  executionLease: z.string().min(1).optional(),
  executionLeaseExpiresAt: z.number().int().optional(),
  recoveryLease: z.string().min(1).optional(),
});

type RecoveryRow = {
  id: string;
  status: string;
  summaryJson: string;
  startedAt: number | null;
  completedAt: number | null;
  itemCount: number;
};

export type AirtableProjectionRecoveryItem = {
  runId: string;
  status: "running" | "partially_failed" | "failed";
  phase: "intent_recorded" | "d1_committed" | "external_committed";
  operation: string;
  error: string | null;
  beforeHash: string;
  afterHash: string | null;
  itemCount: number;
  startedAt: number | null;
  completedAt: number | null;
};

export class AirtableProjectionRecoveryError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 404 | 409,
  ) {
    super(message);
    this.name = "AirtableProjectionRecoveryError";
  }
}

export class AirtableProjectionRecoveryService {
  private readonly boundary: AirtableProviderBoundary;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { boundary?: AirtableProviderBoundary } = {},
  ) {
    this.boundary =
      dependencies.boundary ?? new AirtableProviderBoundary(this.env);
  }

  private assertAdministrator(viewer: Viewer) {
    if (viewer.role !== "owner" && viewer.role !== "administrator")
      throw new AirtableProjectionRecoveryError(
        "Only event owners and administrators can recover Airtable projections.",
        403,
      );
  }

  private async rows(viewer: Viewer, runId?: string) {
    return this.env.DB.prepare(
      `SELECT run.id, run.status, run.summary_json AS summaryJson,
              run.started_at AS startedAt, run.completed_at AS completedAt,
              (SELECT COUNT(*) FROM integration_run_items item
                WHERE item.run_id = run.id) AS itemCount
         FROM integration_runs run
         JOIN integration_connections connection ON connection.id = run.connection_id
        WHERE connection.organisation_id = ? AND connection.event_id = ?
          AND connection.provider = ?
          AND json_extract(run.summary_json, '$.kind') = 'airtable_event_projection'
          ${runId ? "AND run.id = ?" : ""}
        ORDER BY run.created_at DESC, run.id DESC`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        AIRTABLE_REPOSITORY_PROVIDER,
        ...(runId ? [runId] : []),
      )
      .all<RecoveryRow>();
  }

  private toRecoverable(
    row: RecoveryRow,
    now: number,
  ): AirtableProjectionRecoveryItem | null {
    const parsed = recoverableSummarySchema.safeParse(
      JSON.parse(row.summaryJson),
    );
    if (!parsed.success || parsed.data.recoveryLease) return null;
    if (
      parsed.data.executionLease &&
      (parsed.data.executionLeaseExpiresAt === undefined ||
        parsed.data.executionLeaseExpiresAt > now)
    )
      return null;
    if (
      row.status !== "partially_failed" &&
      row.status !== "failed" &&
      !(
        row.status === "running" &&
        row.startedAt !== null &&
        row.startedAt <= now - STALE_RUNNING_SECONDS
      )
    )
      return null;
    return {
      runId: row.id,
      status: row.status,
      phase: parsed.data.phase,
      operation: parsed.data.operation,
      error: parsed.data.error ?? null,
      beforeHash: parsed.data.beforeHash,
      afterHash: parsed.data.afterHash ?? null,
      itemCount: row.itemCount,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    } as AirtableProjectionRecoveryItem;
  }

  async list(viewer: Viewer) {
    this.assertAdministrator(viewer);
    const rows = await this.rows(viewer);
    const now = Math.floor(Date.now() / 1_000);
    return rows.results
      .map((row) => this.toRecoverable(row, now))
      .filter((row): row is AirtableProjectionRecoveryItem => row !== null);
  }

  async recover(viewer: Viewer, runId: string) {
    this.assertAdministrator(viewer);
    if (!runId)
      throw new AirtableProjectionRecoveryError(
        "Airtable projection run id is required.",
        409,
      );
    const rows = await this.rows(viewer, runId);
    const row = rows.results[0];
    if (!row)
      throw new AirtableProjectionRecoveryError(
        "Airtable projection run not found in the current event.",
        404,
      );
    const now = Math.floor(Date.now() / 1_000);
    if (!this.toRecoverable(row, now))
      throw new AirtableProjectionRecoveryError(
        "This Airtable projection is not recoverable, is still active, or is already leased for recovery.",
        409,
      );

    const lease = crypto.randomUUID();
    const claimed = await this.env.DB.prepare(
      `UPDATE integration_runs
          SET summary_json = json_set(
                summary_json,
                '$.recoveryLease', ?,
                '$.recoveryActorPersonId', ?,
                '$.recoveryLeasedAt', ?
              )
        WHERE id = ?
          AND status IN ('running','partially_failed','failed')
          AND json_extract(summary_json, '$.kind') = 'airtable_event_projection'
          AND json_extract(summary_json, '$.recoveryLease') IS NULL
          AND (
            json_extract(summary_json, '$.executionLease') IS NULL
            OR json_extract(summary_json, '$.executionLeaseExpiresAt') <= ?
          )
          AND EXISTS (
            SELECT 1 FROM integration_connections connection
             WHERE connection.id = integration_runs.connection_id
               AND connection.organisation_id = ? AND connection.event_id = ?
               AND connection.provider = ?
          )`,
    )
      .bind(
        lease,
        viewer.personId,
        now,
        runId,
        now,
        viewer.organisationId,
        viewer.eventId,
        AIRTABLE_REPOSITORY_PROVIDER,
      )
      .run();
    if ((claimed.meta.changes ?? 0) !== 1)
      throw new AirtableProjectionRecoveryError(
        "Another administrator already started recovery for this Airtable projection.",
        409,
      );

    try {
      await this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) VALUES (?, ?, ?, ?, 'airtable.event_data.recovery_requested',
                   'integration_run', ?, ?, '{}', unixepoch())`,
      )
        .bind(
          crypto.randomUUID(),
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          runId,
          runId,
        )
        .run();
      return await this.boundary.recover(viewer, runId);
    } catch (error) {
      await this.env.DB.prepare(
        `UPDATE integration_runs
            SET summary_json = json_remove(
                  summary_json,
                  '$.recoveryLease',
                  '$.recoveryActorPersonId',
                  '$.recoveryLeasedAt'
                )
          WHERE id = ? AND json_extract(summary_json, '$.recoveryLease') = ?`,
      )
        .bind(runId, lease)
        .run();
      throw error;
    }
  }
}

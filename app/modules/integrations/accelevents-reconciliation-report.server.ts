import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import {
  acceleventsRunItemDiffSchema,
  isAcceleventsTerminalRunStatus,
} from "./accelevents-run-contract";

const terminalOperationStatuses = new Set([
  "queue_failed",
  "completed",
  "partially_failed",
  "failed",
  "cancelled",
]);

const runSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    create: z.number().int().nonnegative(),
    update: z.number().int().nonnegative(),
    noop: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    requestHash: z.string().regex(/^[0-9a-f]{64}$/),
    previewFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    completed: z.number().int().nonnegative().optional(),
    failed: z.number().int().nonnegative().optional(),
    skipped: z.number().int().nonnegative().optional(),
    queueError: z.string().optional(),
  })
  .strict();

type ReportRow = {
  runId: string;
  connectionId: string;
  operationId: string;
  correlationId: string;
  provider: string;
  eventId: string;
  eventName: string;
  runStatus: string;
  direction: string;
  dryRun: number;
  summaryJson: string;
  runStartedAt: number | null;
  runCompletedAt: number | null;
  runCreatedAt: number;
  operationStatus: string;
  requestedBy: string | null;
  operationProgressTotal: number;
  operationProgressCompleted: number;
  operationProgressFailed: number;
  operationAttemptCount: number;
  operationLastError: string | null;
  operationStartedAt: number | null;
  operationCompletedAt: number | null;
  itemId: string | null;
  entityType: string | null;
  entityId: string | null;
  externalId: string | null;
  action: string | null;
  itemStatus: string | null;
  diffJson: string | null;
  itemAttemptCount: number | null;
  itemErrorCode: string | null;
  itemErrorMessage: string | null;
  itemUpdatedAt: number | null;
};

type CsvValue = string | number | null;

const reportColumns = [
  "recordType",
  "reportVersion",
  "runId",
  "connectionId",
  "operationId",
  "correlationId",
  "provider",
  "eventId",
  "eventName",
  "mode",
  "direction",
  "runStatus",
  "operationStatus",
  "runCreatedAt",
  "runStartedAt",
  "runCompletedAt",
  "operationStartedAt",
  "operationCompletedAt",
  "requestedBy",
  "operationProgressTotal",
  "operationProgressCompleted",
  "operationProgressFailed",
  "operationAttemptCount",
  "operationLastError",
  "runSummaryJson",
  "entityType",
  "entityId",
  "label",
  "action",
  "itemStatus",
  "externalId",
  "previousExternalId",
  "sourceHash",
  "itemAttemptCount",
  "itemErrorCode",
  "itemErrorMessage",
  "providerSupport",
  "providerMessage",
  "changesJson",
  "payloadJson",
  "itemUpdatedAt",
] as const;

type ReportRecord = Record<(typeof reportColumns)[number], CsvValue>;

function parseJson(value: string, label: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new AcceleventsReconciliationReportDataError(
      `${label} contains invalid JSON.`,
      { cause: error },
    );
  }
}

function iso(epoch: number | null) {
  return epoch === null ? null : new Date(epoch * 1_000).toISOString();
}

function csvCell(value: CsvValue) {
  const raw = value === null ? "" : String(value);
  const safe = /^[\u0000-\u0020]*[=+\-@]/u.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function renderCsv(records: ReportRecord[]) {
  return `${[
    reportColumns.join(","),
    ...records.map((record) =>
      reportColumns.map((column) => csvCell(record[column])).join(","),
    ),
  ].join("\r\n")}\r\n`;
}

function stableFilename(runId: string) {
  const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/gu, "-").slice(0, 100);
  return `program-cue-accelevents-${safeRunId}-reconciliation.csv`;
}

export class AcceleventsReconciliationReportNotFoundError extends Error {
  constructor() {
    super("Accelevents reconciliation run not found in this event.");
    this.name = "AcceleventsReconciliationReportNotFoundError";
  }
}

export class AcceleventsReconciliationReportUnavailableError extends Error {
  constructor() {
    super("The reconciliation report is available only after the run ends.");
    this.name = "AcceleventsReconciliationReportUnavailableError";
  }
}

export class AcceleventsReconciliationReportDataError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AcceleventsReconciliationReportDataError";
  }
}

export class AcceleventsReconciliationReportService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async create(viewer: Viewer, runId: string) {
    if (!(["owner", "administrator"] as string[]).includes(viewer.role))
      throw new Response("Administrator access is required", { status: 403 });
    const normalizedRunId = z.string().trim().min(1).max(160).parse(runId);
    const result = await this.env.DB.prepare(
      `SELECT run.id AS runId, run.connection_id AS connectionId,
              run.operation_id AS operationId,
              operation.correlation_id AS correlationId,
              connection.provider, event.id AS eventId, event.name AS eventName,
              run.status AS runStatus, run.direction,
              run.dry_run AS dryRun, run.summary_json AS summaryJson,
              run.started_at AS runStartedAt,
              run.completed_at AS runCompletedAt,
              run.created_at AS runCreatedAt,
              operation.status AS operationStatus,
              requester.display_name AS requestedBy,
              operation.progress_total AS operationProgressTotal,
              operation.progress_completed AS operationProgressCompleted,
              operation.progress_failed AS operationProgressFailed,
              operation.attempt_count AS operationAttemptCount,
              operation.last_error AS operationLastError,
              operation.started_at AS operationStartedAt,
              operation.completed_at AS operationCompletedAt,
              item.id AS itemId, item.entity_type AS entityType,
              item.entity_id AS entityId, item.external_id AS externalId,
              item.action, item.status AS itemStatus,
              item.diff_json AS diffJson,
              item.attempt_count AS itemAttemptCount,
              item.error_code AS itemErrorCode,
              item.error_message AS itemErrorMessage,
              item.updated_at AS itemUpdatedAt
         FROM integration_runs run
         JOIN integration_connections connection
           ON connection.id = run.connection_id
         JOIN events event
           ON event.id = connection.event_id
          AND event.organisation_id = connection.organisation_id
         JOIN operation_jobs operation
           ON operation.id = run.operation_id
          AND operation.event_id = connection.event_id
          AND operation.organisation_id = connection.organisation_id
          AND operation.type = 'integration.accelevents.export'
         LEFT JOIN people requester
           ON requester.id = operation.requested_by_person_id
         LEFT JOIN integration_run_items item ON item.run_id = run.id
        WHERE run.id = ? AND connection.provider = 'accelevents'
          AND connection.event_id = ? AND connection.organisation_id = ?
        ORDER BY CASE item.entity_type
                   WHEN 'speaker' THEN 0 WHEN 'track' THEN 1
                   WHEN 'session' THEN 2 WHEN 'session_speaker' THEN 3
                   ELSE 4 END,
                 item.entity_id, item.id`,
    )
      .bind(normalizedRunId, viewer.eventId, viewer.organisationId)
      .all<ReportRow>();
    const rows = result.results;
    const run = rows[0];
    if (!run) throw new AcceleventsReconciliationReportNotFoundError();
    if (
      !isAcceleventsTerminalRunStatus(run.runStatus) ||
      run.runCompletedAt === null ||
      !terminalOperationStatuses.has(run.operationStatus)
    )
      throw new AcceleventsReconciliationReportUnavailableError();

    const parsedSummary = runSummarySchema.safeParse(
      parseJson(run.summaryJson, `Integration run ${run.runId} summary`),
    );
    if (!parsedSummary.success)
      throw new AcceleventsReconciliationReportDataError(
        `Integration run ${run.runId} has an invalid stored summary.`,
        { cause: parsedSummary.error },
      );
    const summaryJson = JSON.stringify(parsedSummary.data);
    const base = {
      reportVersion: 1,
      runId: run.runId,
      connectionId: run.connectionId,
      operationId: run.operationId,
      correlationId: run.correlationId,
      provider: run.provider,
      eventId: run.eventId,
      eventName: run.eventName,
      mode: run.dryRun ? "dry_run" : "live",
      direction: run.direction,
      runStatus: run.runStatus,
      operationStatus: run.operationStatus,
      runCreatedAt: iso(run.runCreatedAt),
      runStartedAt: iso(run.runStartedAt),
      runCompletedAt: iso(run.runCompletedAt),
      operationStartedAt: iso(run.operationStartedAt),
      operationCompletedAt: iso(run.operationCompletedAt),
      requestedBy: run.requestedBy,
      operationProgressTotal: run.operationProgressTotal,
      operationProgressCompleted: run.operationProgressCompleted,
      operationProgressFailed: run.operationProgressFailed,
      operationAttemptCount: run.operationAttemptCount,
      operationLastError: run.operationLastError,
      runSummaryJson: summaryJson,
    };
    const blankItem = {
      entityType: null,
      entityId: null,
      label: null,
      action: null,
      itemStatus: null,
      externalId: null,
      previousExternalId: null,
      sourceHash: null,
      itemAttemptCount: null,
      itemErrorCode: null,
      itemErrorMessage: null,
      providerSupport: null,
      providerMessage: null,
      changesJson: null,
      payloadJson: null,
      itemUpdatedAt: null,
    };
    const records: ReportRecord[] = [
      { recordType: "run", ...base, ...blankItem },
    ];
    for (const row of rows) {
      if (!row.itemId || !row.diffJson) continue;
      const parsedDiff = acceleventsRunItemDiffSchema.safeParse(
        parseJson(row.diffJson, `Integration run item ${row.itemId}`),
      );
      if (!parsedDiff.success)
        throw new AcceleventsReconciliationReportDataError(
          `Integration run item ${row.itemId} has invalid stored mapping data.`,
          { cause: parsedDiff.error },
        );
      const diff = parsedDiff.data;
      records.push({
        recordType: "item",
        ...base,
        entityType: row.entityType,
        entityId: row.entityId,
        label: diff.label,
        action: row.action,
        itemStatus: row.itemStatus,
        externalId: row.externalId,
        previousExternalId: diff.previousExternalId,
        sourceHash: diff.sourceHash,
        itemAttemptCount: row.itemAttemptCount,
        itemErrorCode: row.itemErrorCode,
        itemErrorMessage: row.itemErrorMessage,
        providerSupport: diff.providerSupport,
        providerMessage: diff.providerMessage,
        changesJson: JSON.stringify(diff.changes),
        payloadJson: JSON.stringify(diff.payload),
        itemUpdatedAt: iso(row.itemUpdatedAt),
      });
    }
    return {
      csv: renderCsv(records),
      filename: stableFilename(run.runId),
      runId: run.runId,
      operationId: run.operationId,
      rowCount: records.length,
    };
  }
}

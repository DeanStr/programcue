import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import {
  currentEvaluationFixtureGeneration,
  EVALUATION_FIXTURE_GENERATION_FENCE_PREDICATE,
  EVALUATION_FIXTURE_RESET_OPERATION_ID,
  EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
  evaluationFixtureResetIsRunning,
  shouldFenceEvaluationFixtureMutation,
} from "~/platform/evaluation/evaluation-fixture-reset-lock.server";
import {
  type PreparedWebhookEvent,
  WebhookService,
} from "~/platform/operations/webhook-service.server";
import { parseCsv } from "./csv";
import { DataImportExecutionSupport } from "./data-import-execution-support.server";
import {
  dataImportMutationStatements,
  normalizeImportRow,
} from "./data-import-resources.server";
import {
  DataImportStateError,
  type ImportScalar,
  type InvalidImportRow,
  importResourceSchema,
  importSchemas,
  issueMessages,
  type NormalizedImportRow,
  requestedPersonEmails,
  requestedSpeakerTargetIds,
  storedPreviewSchema,
} from "./data-import-validation.server";
import { DataImportValidationContext } from "./data-import-validation-context.server";

export {
  DataImportStateError,
  type EventImportResource,
  type ImportScalar,
  type NormalizedImportRow,
  type ValidationContextRecord,
} from "./data-import-validation.server";

const IMPORT_BYTES_LIMIT = 512_000;

export class DataImportService {
  private readonly support: DataImportExecutionSupport;
  private readonly validationContext: DataImportValidationContext;

  constructor(private readonly env: CloudflareEnvironment) {
    this.validationContext = new DataImportValidationContext(env);
    this.support = new DataImportExecutionSupport(env);
  }

  async preview(
    viewer: Viewer,
    input: { resource: unknown; fileName: string; csv: string },
  ) {
    const resource = importResourceSchema.parse(input.resource);
    const fenceEvaluationReset = shouldFenceEvaluationFixtureMutation(
      this.env,
      viewer.organisationId,
    );
    const fixtureGeneration = fenceEvaluationReset
      ? await currentEvaluationFixtureGeneration(this.env)
      : null;
    if (fenceEvaluationReset && !fixtureGeneration) {
      throw new DataImportStateError(
        "A new preview cannot start while the evaluation fixture is resetting.",
      );
    }
    await this.support.assertSupportedAuthority(viewer, resource);
    if (new TextEncoder().encode(input.csv).byteLength > IMPORT_BYTES_LIMIT) {
      throw new Error("CSV import files cannot exceed 512 KB.");
    }
    const parsed = parseCsv(input.csv);
    const context = await this.validationContext.load(viewer, resource, {
      requestedTaskIds:
        resource === "tasks"
          ? parsed.rows
              .map((row) => row.id?.trim())
              .filter((id): id is string => Boolean(id))
          : [],
      requestedPersonEmails: requestedPersonEmails(resource, parsed.rows),
      requestedSpeakerTargetIds: requestedSpeakerTargetIds(
        resource,
        parsed.rows,
      ),
    });
    const valid: NormalizedImportRow[] = [];
    const invalid: InvalidImportRow[] = [];
    const fileKeys = new Set<string>();

    for (const [index, raw] of parsed.rows.entries()) {
      const rowNumber = index + 2;
      const result = importSchemas[resource].safeParse(raw);
      if (!result.success) {
        invalid.push({ rowNumber, errors: issueMessages(result.error), raw });
        continue;
      }
      const normalized = normalizeImportRow(
        viewer,
        resource,
        result.data as Record<string, ImportScalar>,
        context,
        rowNumber,
      );
      if ("errors" in normalized) {
        invalid.push({ rowNumber, errors: normalized.errors, raw });
        continue;
      }
      const duplicateKey = `${resource}:${String(normalized.values.importKey)}`;
      if (fileKeys.has(duplicateKey)) {
        invalid.push({
          rowNumber,
          errors: ["duplicates another row in this import"],
          raw,
        });
        continue;
      }
      fileKeys.add(duplicateKey);
      delete normalized.values.importKey;
      valid.push(normalized);
    }

    if (resource === "tasks" && invalid.length === 0) {
      const changedTaskStatusCount = valid.filter(
        (row) => row.values.statusTransition !== "none",
      ).length;
      await this.support.assertTaskImportQueryBudget(
        viewer,
        valid.length,
        changedTaskStatusCount,
      );
    }

    const operationId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const items = [
      ...valid.map((row) => ({
        id: crypto.randomUUID(),
        itemKey: `row:${row.rowNumber}`,
        status: "pending",
        result: row,
        errorCode: null,
        errorMessage: null,
      })),
      ...invalid.map((row) => ({
        id: crypto.randomUUID(),
        itemKey: `row:${row.rowNumber}`,
        status: "failed",
        result: row,
        errorCode: "VALIDATION_ERROR",
        errorMessage: row.errors.join("; "),
      })),
    ].sort(
      (left, right) =>
        Number(left.itemKey.slice(4)) - Number(right.itemKey.slice(4)),
    );
    const resultJson = JSON.stringify({
      resource,
      fileName: input.fileName.slice(0, 255),
      headers: parsed.headers,
      validCount: valid.length,
      invalidCount: invalid.length,
    });
    const itemJson = JSON.stringify(items);
    const entityType = {
      people: "person",
      submissions: "submission",
      sessions: "session",
      rooms: "room",
      tracks: "track",
      tasks: "task_instance",
    }[resource];
    const [created] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT INTO operation_jobs (
          id, organisation_id, event_id, requested_by_person_id, type,
          idempotency_key, correlation_id, status, payload_json, result_json,
          progress_total, progress_completed, progress_failed, cancellable,
          created_at, updated_at
        ) SELECT ?, ?, ?, ?, 'data.import', ?, ?, 'received', ?, ?, ?, 0, ?, 1,
                 unixepoch(), unixepoch()
           FROM events e
           WHERE e.id = ? AND e.organisation_id = ?
             AND e.repository_provider = 'd1'
             AND (? = 0 OR EXISTS (
               SELECT 1 FROM operation_jobs fixture_reset
                WHERE ${EVALUATION_FIXTURE_GENERATION_FENCE_PREDICATE}
             ))
      `,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `data-import:${operationId}`,
        correlationId,
        JSON.stringify({ type: "data.import", operationId, resource }),
        resultJson,
        items.length,
        invalid.length,
        viewer.eventId,
        viewer.organisationId,
        fenceEvaluationReset ? 1 : 0,
        fixtureGeneration,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO operation_items (
          id, operation_id, item_key, entity_type, entity_id, status, result_json,
          error_code, error_message, completed_at, updated_at
        )
        SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.itemKey'),
               ?, json_extract(value, '$.result.values.id'),
               json_extract(value, '$.status'),
               json(json_extract(value, '$.result')),
               json_extract(value, '$.errorCode'),
               json_extract(value, '$.errorMessage'),
               CASE WHEN json_extract(value, '$.status') = 'failed' THEN unixepoch() ELSE NULL END,
               unixepoch()
          FROM json_each(?)
         WHERE EXISTS (SELECT 1 FROM operation_jobs WHERE id = ?)
      `,
      ).bind(operationId, entityType, itemJson, operationId),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, correlation_id, metadata_json, created_at
        ) SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'data_import.previewed', 'operation', ?, ?, ?, unixepoch()
           WHERE EXISTS (SELECT 1 FROM operation_jobs WHERE id = ?)
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        operationId,
        correlationId,
        resultJson,
        operationId,
      ),
    ]);
    if ((created.meta.changes ?? 0) !== 1) {
      await this.support.assertSupportedAuthority(viewer, resource);
      if (
        fenceEvaluationReset &&
        (await currentEvaluationFixtureGeneration(this.env)) !==
          fixtureGeneration
      ) {
        throw new DataImportStateError(
          "The evaluation fixture changed while this preview was prepared. Start a new preview.",
        );
      }
      throw new Error("The import preview could not be recorded.");
    }
    return {
      operationId,
      resource,
      validCount: valid.length,
      invalidCount: invalid.length,
    };
  }

  async confirm(viewer: Viewer, operationId: string) {
    if (
      await evaluationFixtureResetIsRunning(this.env, viewer.organisationId)
    ) {
      throw new DataImportStateError(
        "This preview cannot be confirmed while the evaluation fixture is resetting.",
      );
    }
    const operation = await this.env.DB.prepare(
      `
      SELECT o.status, o.result_json AS resultJson, o.progress_failed AS failed
        FROM operation_jobs o
        JOIN events e ON e.id = o.event_id AND e.organisation_id = ?
       WHERE o.id = ? AND o.event_id = ? AND o.type = 'data.import'
       LIMIT 1
    `,
    )
      .bind(viewer.organisationId, operationId, viewer.eventId)
      .first<{ status: string; resultJson: string; failed: number }>();
    if (!operation) throw new DataImportStateError("Import preview not found.");
    if (operation.status !== "received") {
      throw new DataImportStateError(
        "Only an uncommitted import preview can be confirmed.",
      );
    }
    if (operation.failed > 0) {
      throw new DataImportStateError(
        "Resolve every invalid CSV row before confirming this import.",
      );
    }
    const summary = z
      .object({
        resource: importResourceSchema,
        validCount: z.number().int().min(1),
      })
      .passthrough()
      .parse(JSON.parse(operation.resultJson));
    await this.support.assertSupportedAuthority(viewer, summary.resource);
    const itemRows = await this.env.DB.prepare(
      `SELECT result_json AS resultJson FROM operation_items
         WHERE operation_id = ? AND status = 'pending'
         ORDER BY CAST(substr(item_key, 5) AS INTEGER)`,
    )
      .bind(operationId)
      .all<{ resultJson: string }>();
    const rows = itemRows.results.map((item) =>
      storedPreviewSchema.parse(JSON.parse(item.resultJson)),
    );
    if (rows.length !== summary.validCount || rows.length === 0) {
      throw new Error(
        "The import preview row count no longer matches its durable summary.",
      );
    }
    await this.support.revalidate(viewer, summary.resource, rows);
    const changedTaskStatusRows =
      summary.resource === "tasks"
        ? rows.filter((row) => row.values.statusTransition !== "none")
        : [];
    const taskWebhookEndpointCount =
      summary.resource === "tasks"
        ? await this.support.assertTaskImportQueryBudget(
            viewer,
            rows.length,
            changedTaskStatusRows.length,
          )
        : 0;
    const completionAuditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const preparedWebhooks: PreparedWebhookEvent[] = [];
    if (taskWebhookEndpointCount > 0) {
      for (const row of changedTaskStatusRows) {
        const taskId = String(row.values.id);
        preparedWebhooks.push(
          await webhookService.prepareEventForAudit(
            viewer,
            {
              eventType: "task.updated",
              entityType: "task",
              entityId: taskId,
              idempotencyKey: `task.updated:${taskId}:${operationId}`,
              correlationId: operationId,
              data: {
                action: "csv_import",
                status: row.values.status,
              },
            },
            completionAuditEventId,
          ),
        );
      }
    }
    const mutations = rows.flatMap((row) =>
      dataImportMutationStatements(
        this.env,
        viewer,
        operationId,
        summary.resource,
        row,
      ),
    );
    const taskStateRefreshes =
      summary.resource === "tasks"
        ? this.support.taskStateRefreshStatements(viewer, operationId)
        : [];
    const fenceEvaluationReset = shouldFenceEvaluationFixtureMutation(
      this.env,
      viewer.organisationId,
    );
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `UPDATE operation_jobs SET status = 'running', started_at = unixepoch(),
                attempt_count = attempt_count + 1, updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND type = 'data.import' AND status = 'received' AND progress_failed = 0
            AND EXISTS (
              SELECT 1 FROM events e
               WHERE e.id = operation_jobs.event_id
                 AND e.organisation_id = operation_jobs.organisation_id
                 AND e.repository_provider = 'd1'
            )
            AND (? = 0 OR NOT EXISTS (
              SELECT 1 FROM operation_jobs fixture_reset
               WHERE fixture_reset.id = ? AND fixture_reset.type = ?
                 AND fixture_reset.status = 'running'
            ))
            ${this.support.confirmationFreshnessGuard(summary.resource)}`,
      ).bind(
        operationId,
        viewer.eventId,
        viewer.organisationId,
        fenceEvaluationReset ? 1 : 0,
        EVALUATION_FIXTURE_RESET_OPERATION_ID,
        EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
      ),
      ...mutations,
      ...taskStateRefreshes,
      this.env.DB.prepare(
        `UPDATE operation_items SET status = 'completed', completed_at = unixepoch(),
                updated_at = unixepoch()
          WHERE operation_id = ? AND status = 'pending'
            AND EXISTS (SELECT 1 FROM operation_jobs WHERE id = ? AND status = 'running')`,
      ).bind(operationId, operationId),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT lower(hex(randomblob(16))), 'system', 'queue', 1, ?, ?, ?, 'data_import.record_upserted',
                item.entity_type, item.entity_id, operation.correlation_id,
                json_object(
                  'operationId', ?,
                  'rowNumber', json_extract(item.result_json, '$.rowNumber'),
                  'action', json_extract(item.result_json, '$.action'),
                  'resource', ?
                ), unixepoch()
           FROM operation_items item
           JOIN operation_jobs operation
             ON operation.id = item.operation_id AND operation.status = 'running'
          WHERE item.operation_id = ? AND item.status = 'completed'`,
      ).bind(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        operationId,
        summary.resource,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type, correlation_id, created_at
         )
         SELECT ?, item.entity_type, item.entity_id,
                CASE WHEN json_extract(item.result_json, '$.action') = 'create'
                     THEN 'created' ELSE 'updated' END,
                operation.correlation_id, unixepoch()
           FROM operation_items item
           JOIN operation_jobs operation
             ON operation.id = item.operation_id AND operation.status = 'running'
          WHERE item.operation_id = ? AND item.status = 'completed'`,
      ).bind(viewer.eventId, operationId),
      this.env.DB.prepare(
        `UPDATE operation_jobs SET status = 'completed', progress_completed = progress_total,
                progress_failed = 0, completed_at = unixepoch(), updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND organisation_id = ? AND status = 'running'`,
      ).bind(operationId, viewer.eventId, viewer.organisationId),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         ) SELECT ?, 'system', 'queue', 1, ?, ?, ?, 'data_import.completed', 'operation', ?, ?, unixepoch()
          WHERE EXISTS (SELECT 1 FROM operation_jobs WHERE id = ? AND status = 'completed')`,
      ).bind(
        completionAuditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        operationId,
        JSON.stringify({ resource: summary.resource, rowCount: rows.length }),
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type, correlation_id, created_at
         ) SELECT ?, 'operation', ?, 'progress', correlation_id, unixepoch()
             FROM operation_jobs WHERE id = ? AND status = 'completed'`,
      ).bind(viewer.eventId, operationId, operationId),
    ];
    const completionResultIndex = statements.length - 3;
    statements.push(
      ...preparedWebhooks.flatMap((webhook) => webhook.statements),
    );
    this.support.assertPreparedTaskImportQueryBudget(
      rows.length,
      changedTaskStatusRows.length,
      preparedWebhooks,
      statements.length,
    );
    const results = await this.env.DB.batch(statements);
    if ((results[0].meta.changes ?? 0) !== 1) {
      await this.support.assertSupportedAuthority(viewer, summary.resource);
      if (
        await evaluationFixtureResetIsRunning(this.env, viewer.organisationId)
      ) {
        throw new DataImportStateError(
          "This preview cannot be confirmed while the evaluation fixture is resetting.",
        );
      }
      throw new DataImportStateError(
        "The import changed before it could be confirmed.",
      );
    }
    const completion = results[completionResultIndex];
    if ((completion?.meta.changes ?? 0) !== 1) {
      throw new Error("The confirmed import did not reach a completed state.");
    }
    const webhookWarning = await this.support.dispatchTaskStatusWebhooks(
      webhookService,
      preparedWebhooks,
    );
    return {
      operationId,
      resource: summary.resource,
      rowCount: rows.length,
      ...(webhookWarning ? { webhookWarning } : {}),
    };
  }
}

import type { Viewer } from "~/platform/auth/authorize.server";
import {
  WebhookService,
  type PreparedWebhookEvent,
} from "~/platform/operations/webhook-service.server";
import { roomScheduleErrors } from "./data-import-resources.server";
import { DataImportValidationContext } from "./data-import-validation-context.server";
import {
  DataImportStateError,
  requestedPersonEmails,
  requestedSpeakerTargetIds,
  type EventImportResource,
  type NormalizedImportRow,
} from "./data-import-validation.server";

export {
  DataImportStateError,
  type EventImportResource,
  type ImportScalar,
  type NormalizedImportRow,
  type ValidationContextRecord,
} from "./data-import-validation.server";

// Leave headroom below Workers' 1,000 D1-query invocation limit for framework
// and post-commit bookkeeping that is outside this service's estimate.
const TASK_IMPORT_D1_QUERY_BUDGET = 800;
const TASK_IMPORT_FIXED_QUERY_ALLOWANCE = 20;

export class DataImportExecutionSupport {
  private readonly validationContext: DataImportValidationContext;

  constructor(private readonly env: CloudflareEnvironment) {
    this.validationContext = new DataImportValidationContext(env);
  }

  taskStateRefreshStatements(
    viewer: Viewer,
    operationId: string,
  ): D1PreparedStatement[] {
    const operationGuard = `EXISTS (
      SELECT 1 FROM operation_jobs operation
       WHERE operation.id = ? AND operation.event_id = ?
         AND operation.organisation_id = ? AND operation.status = 'running'
    )`;
    return [
      this.env.DB.prepare(
        `UPDATE task_instances AS task
            SET status = 'blocked', readiness_state = 'blocked',
                readiness_percent = 0, updated_at = unixepoch()
          WHERE task.event_id = ?
            AND task.status IN ('not_started','in_progress','overdue')
            AND ${operationGuard}
            AND EXISTS (
              SELECT 1
                FROM task_instance_dependencies dependency
                JOIN task_instances prerequisite
                  ON prerequisite.id = dependency.depends_on_task_id
               WHERE dependency.task_id = task.id
                 AND prerequisite.status NOT IN ('completed','waived')
            )`,
      ).bind(
        viewer.eventId,
        operationId,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `UPDATE task_instances AS task
            SET status = CASE
                  WHEN due_at IS NOT NULL AND due_at < unixepoch()
                    THEN 'overdue' ELSE 'not_started'
                END,
                readiness_state = CASE
                  WHEN due_at IS NOT NULL AND due_at < unixepoch()
                    THEN 'overdue' ELSE 'on_track'
                END,
                readiness_percent = 0, updated_at = unixepoch()
          WHERE task.event_id = ? AND task.status = 'blocked'
            AND ${operationGuard}
            AND NOT EXISTS (
              SELECT 1
                FROM task_instance_dependencies dependency
                JOIN task_instances prerequisite
                  ON prerequisite.id = dependency.depends_on_task_id
               WHERE dependency.task_id = task.id
                 AND prerequisite.status NOT IN ('completed','waived')
            )`,
      ).bind(
        viewer.eventId,
        operationId,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `UPDATE task_instances
            SET status = 'overdue', readiness_state = 'overdue',
                readiness_percent = 0, updated_at = unixepoch()
          WHERE event_id = ? AND due_at IS NOT NULL AND due_at < unixepoch()
            AND status IN ('not_started','in_progress')
            AND ${operationGuard}`,
      ).bind(
        viewer.eventId,
        operationId,
        viewer.eventId,
        viewer.organisationId,
      ),
    ];
  }

  async dispatchTaskStatusWebhooks(
    webhookService: WebhookService,
    preparedWebhooks: readonly PreparedWebhookEvent[],
  ) {
    if (preparedWebhooks.length === 0) return null;
    try {
      const results = await Promise.all(
        preparedWebhooks.map((prepared) =>
          webhookService.dispatchPreparedEvent(prepared),
        ),
      );
      return results
        .flat()
        .some((delivery) =>
          ["queue_failed", "failed", "partially_failed", "cancelled"].includes(
            delivery.status,
          ),
        )
        ? "Task statuses were imported, but one or more outbound webhooks need attention in the Operation Centre."
        : null;
    } catch (error) {
      console.error("Failed to dispatch imported task status webhooks", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return "Task statuses were imported, but their durable outbound webhook events could not all be dispatched.";
    }
  }

  async activeTaskWebhookEndpointCount(viewer: Viewer) {
    const row = await this.env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM webhook_endpoints endpoint
         JOIN events event
           ON event.id = endpoint.event_id AND event.organisation_id = ?
        WHERE endpoint.event_id = ? AND endpoint.status IN ('active','failing')
          AND EXISTS (
            SELECT 1 FROM json_each(endpoint.event_types_json)
             WHERE value = 'task.updated'
          )`,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  taskImportQueryEstimate(
    rowCount: number,
    changedTaskStatusCount: number,
    endpointCount: number,
  ) {
    return (
      TASK_IMPORT_FIXED_QUERY_ALLOWANCE +
      rowCount * 3 +
      changedTaskStatusCount * (1 + endpointCount * 8)
    );
  }

  taskImportBudgetError(
    rowCount: number,
    changedTaskStatusCount: number,
    endpointCount: number,
  ) {
    const available =
      TASK_IMPORT_D1_QUERY_BUDGET -
      TASK_IMPORT_FIXED_QUERY_ALLOWANCE -
      rowCount * 3;
    const perChangedTask = 1 + endpointCount * 8;
    const maximumChangedTasks = Math.max(
      0,
      Math.floor(available / perChangedTask),
    );
    return new DataImportStateError(
      `This import changes ${changedTaskStatusCount} task statuses with ${endpointCount} subscribed webhook endpoint${endpointCount === 1 ? "" : "s"}, which exceeds the safe D1 query budget. Split it so each file changes at most ${maximumChangedTasks} task statuses.`,
    );
  }

  async assertTaskImportQueryBudget(
    viewer: Viewer,
    rowCount: number,
    changedTaskStatusCount: number,
  ) {
    const endpointCount =
      changedTaskStatusCount > 0
        ? await this.activeTaskWebhookEndpointCount(viewer)
        : 0;
    if (
      this.taskImportQueryEstimate(
        rowCount,
        changedTaskStatusCount,
        endpointCount,
      ) > TASK_IMPORT_D1_QUERY_BUDGET
    ) {
      throw this.taskImportBudgetError(
        rowCount,
        changedTaskStatusCount,
        endpointCount,
      );
    }
    return endpointCount;
  }

  assertPreparedTaskImportQueryBudget(
    rowCount: number,
    changedTaskStatusCount: number,
    preparedWebhooks: readonly PreparedWebhookEvent[],
    statementCount: number,
  ) {
    const deliveryCount = preparedWebhooks.reduce(
      (total, prepared) =>
        total + prepared.existingResults.length + prepared.candidates.length,
      0,
    );
    const candidateCount = preparedWebhooks.reduce(
      (total, prepared) => total + prepared.candidates.length,
      0,
    );
    const estimate =
      TASK_IMPORT_FIXED_QUERY_ALLOWANCE +
      changedTaskStatusCount +
      deliveryCount +
      statementCount +
      candidateCount * 2;
    if (estimate <= TASK_IMPORT_D1_QUERY_BUDGET) return;
    const endpointCount =
      changedTaskStatusCount === 0
        ? 0
        : Math.ceil(deliveryCount / changedTaskStatusCount);
    throw this.taskImportBudgetError(
      rowCount,
      changedTaskStatusCount,
      endpointCount,
    );
  }

  async assertSupportedAuthority(
    viewer: Viewer,
    resource: EventImportResource,
  ) {
    const event = await this.env.DB.prepare(
      `SELECT repository_provider AS repositoryProvider
         FROM events
        WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ repositoryProvider: string }>();
    if (!event) {
      throw new DataImportStateError(
        "The import event is unavailable in the authorised organisation.",
      );
    }
    if (event.repositoryProvider === "d1") return;
    if (event.repositoryProvider !== "airtable") {
      throw new Error("The event repository provider is invalid.");
    }
    throw new DataImportStateError(
      `CSV import for ${resource} is unavailable while Airtable is authoritative. Make canonical programme changes through the Airtable-aware Event Setup and programme screens.`,
    );
  }

  async revalidate(
    viewer: Viewer,
    resource: EventImportResource,
    rows: NormalizedImportRow[],
  ) {
    const event = await this.env.DB.prepare(
      `SELECT session_formats_json AS sessionFormatsJson
         FROM events WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ sessionFormatsJson: string }>();
    if (!event)
      throw new DataImportStateError("The import event no longer exists.");
    const context = await this.validationContext.load(viewer, resource, {
      requestedTaskIds:
        resource === "tasks" ? rows.map((row) => String(row.values.id)) : [],
      requestedPersonEmails: requestedPersonEmails(
        resource,
        rows.map((row) => row.values),
      ),
      requestedSpeakerTargetIds: requestedSpeakerTargetIds(
        resource,
        rows.map((row) => row.values),
      ),
    });
    if (
      resource === "sessions" &&
      rows.some((row) => !context.sessionFormats?.[String(row.values.format)])
    ) {
      throw new DataImportStateError(
        "An imported session format was removed after preview. Create a new preview before confirming.",
      );
    }
    const changed = rows.some((row) => {
      const values = row.values;
      if (resource === "people") {
        const key = String(values.email).toLowerCase();
        const current = context.people?.[key];
        if (row.action === "create") return current !== undefined;
        return (
          !current ||
          current.id !== values.id ||
          current.revision !== values.expectedRevision ||
          current.linked !== values.expectedLinked ||
          Boolean(
            context.memberships?.[`${key}\u0000${String(values.role)}`],
          ) !== values.expectedRoleLinked
        );
      }
      if (resource === "submissions") {
        const current = context.submissions?.[String(values.publicReference)];
        const stale =
          row.action === "create"
            ? current !== undefined
            : !current ||
              current.id !== values.id ||
              current.revision !== values.expectedRevision ||
              current.status !== values.expectedStatus;
        const submitter = values.submitterEmail
          ? context.people?.[String(values.submitterEmail).toLowerCase()]
          : null;
        return (
          stale ||
          (values.submitterPersonId !== null &&
            (!submitter ||
              !submitter.linked ||
              submitter.id !== values.submitterPersonId))
        );
      }
      if (resource === "sessions") {
        const current = context.sessions?.[String(values.slug)];
        const formatExists = Boolean(
          context.sessionFormats?.[String(values.format)],
        );
        const track = values.trackSlug
          ? context.tracks?.[String(values.trackSlug)]
          : null;
        return (
          !formatExists ||
          (values.trackId !== null && track?.id !== values.trackId) ||
          (row.action === "create"
            ? current !== undefined
            : !current ||
              current.id !== values.id ||
              current.revision !== values.expectedRevision ||
              current.status !== values.expectedStatus ||
              !["unscheduled", "cancelled"].includes(current.status ?? ""))
        );
      }
      if (resource === "rooms") {
        const current = context.rooms?.[String(values.name).toLowerCase()];
        return row.action === "create"
          ? current !== undefined
          : !current ||
              current.ambiguous ||
              current.id !== values.id ||
              current.name !== values.expectedName ||
              current.building !== values.expectedBuilding ||
              current.level !== values.expectedLevel ||
              current.capacity !== values.expectedCapacity ||
              current.position !== values.expectedPosition ||
              current.status !== values.expectedStatus;
      }
      if (resource === "tracks") {
        const current = context.tracks?.[String(values.slug)];
        return row.action === "create"
          ? current !== undefined
          : !current ||
              current.id !== values.id ||
              current.name !== values.expectedName ||
              current.colour !== values.expectedColour ||
              current.position !== values.expectedPosition ||
              current.exclusive !== values.expectedExclusive ||
              current.public !== values.expectedPublic;
      }
      const current = context.tasks?.[String(values.id)];
      const owner = values.ownerEmail
        ? context.people?.[String(values.ownerEmail).toLowerCase()]
        : null;
      const targetExists =
        values.targetType === "event"
          ? values.targetId === viewer.eventId
          : values.targetType === "session"
            ? Boolean(context.sessionIds?.[String(values.targetId)])
            : Boolean(context.speakerTargets?.[String(values.targetId)]);
      return (
        (row.action === "create"
          ? current !== undefined
          : !current ||
            current.eventId !== viewer.eventId ||
            current.id !== values.id ||
            current.revision !== values.expectedRevision ||
            current.status !== values.expectedStatus ||
            current.taskType !== values.expectedTaskType ||
            current.dependenciesBlocked !==
              values.expectedDependenciesBlocked ||
            current.dependentAdvanced !== values.expectedDependentAdvanced ||
            current.safeSubmittedEvidence !==
              values.expectedSafeSubmittedEvidence) ||
        (values.ownerPersonId !== null &&
          (!owner || !owner.linked || owner.id !== values.ownerPersonId)) ||
        !targetExists
      );
    });
    if (changed) {
      throw new DataImportStateError(
        `An imported ${resource} record changed after preview. Create a new preview before confirming.`,
      );
    }
    if (resource === "rooms") {
      for (const row of rows) {
        if (row.action !== "update") continue;
        const current = context.rooms?.[String(row.values.name).toLowerCase()];
        if (!current) continue;
        const errors = roomScheduleErrors(row.values, current);
        if (errors.length) {
          throw new DataImportStateError(
            `An imported room no longer satisfies schedule constraints: ${errors.join("; ")}. Create a new preview before confirming.`,
          );
        }
      }
    }
  }

  confirmationFreshnessGuard(resource: EventImportResource) {
    const itemScope = `item.operation_id = operation_jobs.id AND item.status = 'pending'`;
    if (resource === "people") {
      return `AND NOT EXISTS (
        SELECT 1
          FROM operation_items item
          LEFT JOIN people current
            ON lower(current.email) = lower(json_extract(item.result_json, '$.values.email'))
         WHERE ${itemScope}
           AND (
             (json_extract(item.result_json, '$.action') = 'create' AND current.id IS NOT NULL)
             OR
             (json_extract(item.result_json, '$.action') IN ('link','update') AND (
               current.id IS NULL
               OR current.id <> json_extract(item.result_json, '$.values.id')
               OR current.profile_revision <> json_extract(item.result_json, '$.values.expectedRevision')
               OR EXISTS (
                    SELECT 1 FROM memberships linked
                     WHERE linked.person_id = current.id
                       AND linked.event_id = operation_jobs.event_id
                       AND linked.accepted_at IS NOT NULL
                       AND linked.revoked_at IS NULL
                  ) <> json_extract(item.result_json, '$.values.expectedLinked')
               OR EXISTS (
                    SELECT 1 FROM memberships role_membership
                     WHERE role_membership.person_id = current.id
                       AND role_membership.event_id = operation_jobs.event_id
                       AND role_membership.role = json_extract(item.result_json, '$.values.role')
                       AND role_membership.revoked_at IS NULL
                  ) <> json_extract(item.result_json, '$.values.expectedRoleLinked')
             ))
           )
      )`;
    }
    if (resource === "submissions") {
      return `AND NOT EXISTS (
        SELECT 1
          FROM operation_items item
          LEFT JOIN submissions current
            ON current.event_id = operation_jobs.event_id
           AND current.public_reference = json_extract(item.result_json, '$.values.publicReference')
         WHERE ${itemScope}
           AND (
             (json_extract(item.result_json, '$.action') = 'create' AND current.id IS NOT NULL)
             OR
             (json_extract(item.result_json, '$.action') = 'update' AND (
               current.id IS NULL
               OR current.id <> json_extract(item.result_json, '$.values.id')
               OR current.revision <> json_extract(item.result_json, '$.values.expectedRevision')
               OR current.status <> 'draft'
               OR current.status <> json_extract(item.result_json, '$.values.expectedStatus')
             ))
             OR
             (json_extract(item.result_json, '$.values.submitterPersonId') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM memberships submitter_membership
                 WHERE submitter_membership.event_id = operation_jobs.event_id
                   AND submitter_membership.person_id = json_extract(item.result_json, '$.values.submitterPersonId')
                   AND submitter_membership.accepted_at IS NOT NULL
                   AND submitter_membership.revoked_at IS NULL
              ))
           )
      )`;
    }
    if (resource === "sessions") {
      return `AND NOT EXISTS (
        SELECT 1
          FROM operation_items item
          LEFT JOIN sessions current
            ON current.event_id = operation_jobs.event_id
           AND current.slug = json_extract(item.result_json, '$.values.slug')
         WHERE ${itemScope}
           AND (
             (json_extract(item.result_json, '$.action') = 'create' AND current.id IS NOT NULL)
             OR
             (json_extract(item.result_json, '$.action') = 'update' AND (
               current.id IS NULL
               OR current.id <> json_extract(item.result_json, '$.values.id')
               OR current.revision <> json_extract(item.result_json, '$.values.expectedRevision')
               OR current.status <> json_extract(item.result_json, '$.values.expectedStatus')
               OR current.status NOT IN ('unscheduled','cancelled')
             ))
             OR NOT EXISTS (
               SELECT 1 FROM events event, json_each(event.session_formats_json) format
                WHERE event.id = operation_jobs.event_id
                  AND event.organisation_id = operation_jobs.organisation_id
                  AND json_extract(format.value, '$.key') = json_extract(item.result_json, '$.values.format')
             )
             OR
             (json_extract(item.result_json, '$.values.trackId') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM tracks track
                 WHERE track.event_id = operation_jobs.event_id
                   AND track.id = json_extract(item.result_json, '$.values.trackId')
                   AND track.slug = json_extract(item.result_json, '$.values.trackSlug')
              ))
           )
      )`;
    }
    if (resource === "rooms") {
      return `AND NOT EXISTS (
        SELECT 1
          FROM operation_items item
          LEFT JOIN rooms current
            ON current.event_id = operation_jobs.event_id
           AND lower(current.name) = lower(json_extract(item.result_json, '$.values.name'))
         WHERE ${itemScope}
           AND (
             (json_extract(item.result_json, '$.action') = 'create' AND current.id IS NOT NULL)
             OR
             (json_extract(item.result_json, '$.action') = 'update' AND (
               current.id IS NULL
               OR current.id <> json_extract(item.result_json, '$.values.id')
               OR current.name IS NOT json_extract(item.result_json, '$.values.expectedName')
               OR current.building IS NOT json_extract(item.result_json, '$.values.expectedBuilding')
               OR current.level IS NOT json_extract(item.result_json, '$.values.expectedLevel')
               OR current.capacity IS NOT json_extract(item.result_json, '$.values.expectedCapacity')
               OR current.position IS NOT json_extract(item.result_json, '$.values.expectedPosition')
               OR current.status IS NOT json_extract(item.result_json, '$.values.expectedStatus')
             ))
             OR
             (json_extract(item.result_json, '$.action') = 'update'
              AND json_extract(item.result_json, '$.values.status') = 'retired'
              AND json_extract(item.result_json, '$.values.expectedStatus') <> 'retired'
              AND EXISTS (
                SELECT 1
                  FROM schedule_entries entry
                  JOIN schedule_versions version
                    ON version.id = entry.schedule_version_id
                   AND version.event_id = entry.event_id
                 WHERE entry.event_id = operation_jobs.event_id
                   AND entry.room_id = json_extract(item.result_json, '$.values.id')
                   AND version.status IN ('draft','publishing','published')
              ))
             OR
             (json_extract(item.result_json, '$.action') = 'update'
              AND EXISTS (
                SELECT 1
                  FROM schedule_entries entry
                  JOIN schedule_versions version
                    ON version.id = entry.schedule_version_id
                   AND version.event_id = entry.event_id
                   AND version.status = 'published'
                  JOIN sessions session
                    ON session.id = entry.session_id
                   AND session.event_id = entry.event_id
                  JOIN schedule_policies policy
                    ON policy.event_id = entry.event_id
                   AND policy.capacity_action = 'block'
                 WHERE entry.event_id = operation_jobs.event_id
                   AND entry.room_id = json_extract(item.result_json, '$.values.id')
                   AND session.expected_attendance IS NOT NULL
                   AND session.expected_attendance > json_extract(item.result_json, '$.values.capacity')
              ))
           )
      )`;
    }
    if (resource === "tracks") {
      return `AND NOT EXISTS (
        SELECT 1
          FROM operation_items item
          LEFT JOIN tracks current
            ON current.event_id = operation_jobs.event_id
           AND current.slug = json_extract(item.result_json, '$.values.slug')
         WHERE ${itemScope}
           AND (
             (json_extract(item.result_json, '$.action') = 'create' AND current.id IS NOT NULL)
             OR
             (json_extract(item.result_json, '$.action') = 'update' AND (
               current.id IS NULL
               OR current.id <> json_extract(item.result_json, '$.values.id')
               OR current.name IS NOT json_extract(item.result_json, '$.values.expectedName')
               OR current.colour_token IS NOT json_extract(item.result_json, '$.values.expectedColour')
               OR current.position IS NOT json_extract(item.result_json, '$.values.expectedPosition')
               OR current.exclusive IS NOT json_extract(item.result_json, '$.values.expectedExclusive')
               OR current.is_public IS NOT json_extract(item.result_json, '$.values.expectedPublic')
             ))
           )
      )`;
    }
    return `AND NOT EXISTS (
      SELECT 1
        FROM operation_items item
        LEFT JOIN task_instances current
          ON current.event_id = operation_jobs.event_id
         AND current.id = json_extract(item.result_json, '$.values.id')
       WHERE ${itemScope}
         AND (
           (json_extract(item.result_json, '$.action') = 'create' AND EXISTS (
             SELECT 1 FROM task_instances collision
              WHERE collision.id = json_extract(item.result_json, '$.values.id')
           ))
           OR
           (json_extract(item.result_json, '$.action') = 'create' AND current.id IS NOT NULL)
           OR
           (json_extract(item.result_json, '$.action') = 'update' AND (
             current.id IS NULL
             OR current.revision <> json_extract(item.result_json, '$.values.expectedRevision')
             OR current.status <> json_extract(item.result_json, '$.values.expectedStatus')
             OR current.task_type <> json_extract(item.result_json, '$.values.expectedTaskType')
             OR EXISTS (
               SELECT 1
                 FROM task_instance_dependencies dependency
                 JOIN task_instances prerequisite
                   ON prerequisite.id = dependency.depends_on_task_id
                WHERE dependency.task_id = current.id
                  AND prerequisite.status NOT IN ('completed','waived')
             ) <> json_extract(item.result_json, '$.values.expectedDependenciesBlocked')
             OR EXISTS (
               SELECT 1
                 FROM task_instance_dependencies dependency
                 JOIN task_instances dependent ON dependent.id = dependency.task_id
                WHERE dependency.depends_on_task_id = current.id
                  AND dependent.status IN ('submitted','completed')
             ) <> json_extract(item.result_json, '$.values.expectedDependentAdvanced')
             OR EXISTS (
               SELECT 1
                 FROM task_evidence evidence
                 JOIN file_assets asset
                   ON asset.id = evidence.file_asset_id
                  AND asset.event_id = evidence.event_id
                 JOIN file_versions version
                   ON version.id = json_extract(evidence.evidence_json, '$.fileVersionId')
                  AND version.asset_id = asset.id
                  AND version.event_id = asset.event_id
                WHERE evidence.task_id = current.id
                  AND evidence.status = 'submitted'
                  AND asset.status = 'active'
                  AND version.scan_status = 'clean'
                  AND version.signature_status = 'valid'
                  AND version.released_at IS NOT NULL
             ) <> json_extract(item.result_json, '$.values.expectedSafeSubmittedEvidence')
           ))
           OR
           (json_extract(item.result_json, '$.values.ownerPersonId') IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM memberships owner_membership
               WHERE owner_membership.event_id = operation_jobs.event_id
                 AND owner_membership.person_id = json_extract(item.result_json, '$.values.ownerPersonId')
                 AND owner_membership.accepted_at IS NOT NULL
                 AND owner_membership.revoked_at IS NULL
            ))
           OR
           (json_extract(item.result_json, '$.values.targetType') = 'event'
            AND json_extract(item.result_json, '$.values.targetId') <> operation_jobs.event_id)
           OR
           (json_extract(item.result_json, '$.values.targetType') = 'session'
            AND NOT EXISTS (
              SELECT 1 FROM sessions target_session
               WHERE target_session.event_id = operation_jobs.event_id
                 AND target_session.id = json_extract(item.result_json, '$.values.targetId')
            ))
           OR
           (json_extract(item.result_json, '$.values.targetType') = 'speaker'
            AND NOT EXISTS (
              SELECT 1 FROM memberships target_membership
               WHERE target_membership.event_id = operation_jobs.event_id
                 AND target_membership.person_id = json_extract(item.result_json, '$.values.targetId')
                 AND target_membership.accepted_at IS NOT NULL
                 AND target_membership.revoked_at IS NULL
            ))
         )
    )`;
  }
}

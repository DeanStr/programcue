import type { Viewer } from "~/platform/auth/authorize.server";
import type {
  EventImportResource,
  ImportScalar,
  NormalizedImportRow,
  ValidationContextRecord,
} from "./data-import-validation.server";

function readiness(status: string) {
  if (status === "completed" || status === "waived")
    return { state: "on_track", percent: 100 };
  if (status === "blocked") return { state: "blocked", percent: 0 };
  if (status === "overdue") return { state: "overdue", percent: 0 };
  if (status === "submitted") return { state: "on_track", percent: 80 };
  if (status === "in_progress") return { state: "at_risk", percent: 40 };
  return { state: "on_track", percent: 0 };
}

type TaskStatusTransition =
  "none" | "progress" | "complete" | "approve" | "waive" | "reopen";

const taskProgressStatuses = [
  "not_started",
  "in_progress",
  "blocked",
  "overdue",
] as const;

function importedTaskStatusTransition(
  task: ValidationContextRecord,
  requestedStatus: string,
  reason: string,
): { transition: TaskStatusTransition } | { error: string } {
  const currentStatus = task.status;
  if (!currentStatus) return { error: "the existing task status is invalid" };
  if (requestedStatus === "blocked" && (task.dependenciesBlocked ?? 0) === 0) {
    return {
      error:
        "blocked status requires at least one unfinished prerequisite task",
    };
  }
  if (currentStatus === requestedStatus) return { transition: "none" };

  if (requestedStatus === "submitted") {
    return {
      error:
        "submitted status requires participant evidence and cannot be created by CSV import",
    };
  }
  if (requestedStatus === "completed") {
    if (
      !taskProgressStatuses.includes(
        currentStatus as (typeof taskProgressStatuses)[number],
      ) &&
      currentStatus !== "submitted"
    ) {
      return {
        error: `a ${currentStatus.replaceAll("_", " ")} task cannot be completed`,
      };
    }
    if ((task.dependenciesBlocked ?? 0) !== 0) {
      return {
        error:
          "prerequisite tasks must be completed or waived before this task can be completed",
      };
    }
    if (
      task.taskType === "file_upload" &&
      (task.safeSubmittedEvidence ?? 0) === 0
    ) {
      return {
        error:
          "file evidence must be submitted, scanned, signature-valid and released before this task can be completed",
      };
    }
    return {
      transition: currentStatus === "submitted" ? "approve" : "complete",
    };
  }
  if (requestedStatus === "waived") {
    if (
      !taskProgressStatuses.includes(
        currentStatus as (typeof taskProgressStatuses)[number],
      ) &&
      currentStatus !== "submitted"
    ) {
      return {
        error: `a ${currentStatus.replaceAll("_", " ")} task cannot be waived`,
      };
    }
    if (reason.length < 5) {
      return {
        error:
          "statusReason must explain in at least 5 characters why the task is waived",
      };
    }
    return { transition: "waive" };
  }
  if (
    requestedStatus === "not_started" &&
    (currentStatus === "completed" || currentStatus === "waived")
  ) {
    if ((task.dependentAdvanced ?? 0) !== 0) {
      return {
        error:
          "a dependent task was submitted or completed; reopen that work first",
      };
    }
    return { transition: "reopen" };
  }
  if (
    taskProgressStatuses.includes(
      requestedStatus as (typeof taskProgressStatuses)[number],
    ) &&
    taskProgressStatuses.includes(
      currentStatus as (typeof taskProgressStatuses)[number],
    )
  ) {
    if (
      requestedStatus !== "blocked" &&
      (task.dependenciesBlocked ?? 0) !== 0
    ) {
      return {
        error:
          "this task must remain blocked until every prerequisite is completed or waived",
      };
    }
    return { transition: "progress" };
  }
  return {
    error: `a ${currentStatus.replaceAll("_", " ")} task cannot transition to ${requestedStatus.replaceAll("_", " ")} by CSV import`,
  };
}

export function roomScheduleErrors(
  values: Record<string, ImportScalar>,
  existing: ValidationContextRecord,
) {
  const errors: string[] = [];
  if (
    values.status === "retired" &&
    existing.status !== "retired" &&
    (existing.scheduleReferences ?? 0) > 0
  ) {
    errors.push(
      "an active room referenced by a draft, publishing or published schedule cannot be retired",
    );
  }
  if (
    existing.requiredCapacity !== null &&
    existing.requiredCapacity !== undefined &&
    Number(values.capacity) < existing.requiredCapacity
  ) {
    errors.push(
      `capacity cannot be lower than the published schedule requirement of ${existing.requiredCapacity}`,
    );
  }
  return errors;
}

export function normalizeImportRow(
  viewer: Viewer,
  resource: EventImportResource,
  values: Record<string, ImportScalar>,
  context: Record<string, Record<string, ValidationContextRecord>>,
  rowNumber: number,
): NormalizedImportRow | { errors: string[] } {
  if (resource === "people") {
    const key = String(values.email).toLowerCase();
    const existing = context.people?.[key];
    if (
      existing &&
      (existing.name !== values.name ||
        existing.organisation !== values.organisation ||
        existing.jobTitle !== values.jobTitle ||
        existing.profileStatus !== values.profileStatus)
    ) {
      return {
        errors: [
          "email identifies an existing person; profile fields must match the existing identity because CSV imports can only link its event membership",
        ],
      };
    }
    return {
      rowNumber,
      action: existing ? "link" : "create",
      values: {
        ...values,
        importKey: key,
        id: existing?.id ?? crypto.randomUUID(),
        membershipId: crypto.randomUUID(),
        expectedRevision: existing?.revision ?? null,
        expectedLinked: existing?.linked ?? null,
        expectedRoleLinked: existing
          ? Boolean(context.memberships?.[`${key}\u0000${String(values.role)}`])
          : null,
      },
    };
  }
  if (resource === "submissions") {
    const key = String(values.publicReference);
    const existing = context.submissions?.[key];
    if (existing && existing.status !== "draft") {
      return {
        errors: [
          "an existing non-draft submission must be changed through the submission, evaluation or decision workflow",
        ],
      };
    }
    const submitterEmail = values.submitterEmail
      ? String(values.submitterEmail).toLowerCase()
      : null;
    const submitter = submitterEmail ? context.people?.[submitterEmail] : null;
    if (submitterEmail && (!submitter || !submitter.linked)) {
      return {
        errors: [
          "submitterEmail must identify a person already linked to this event",
        ],
      };
    }
    return {
      rowNumber,
      action: existing ? "update" : "create",
      values: {
        ...values,
        importKey: key,
        id: existing?.id ?? crypto.randomUUID(),
        submitterPersonId: submitter?.id ?? null,
        expectedRevision: existing?.revision ?? null,
        expectedStatus: existing?.status ?? null,
      },
    };
  }
  if (resource === "sessions") {
    const key = String(values.slug);
    const existing = context.sessions?.[key];
    if (!context.sessionFormats?.[String(values.format)]) {
      return { errors: ["format is not configured for this event"] };
    }
    if (
      existing &&
      ["scheduled", "published", "archived"].includes(existing.status ?? "")
    ) {
      return {
        errors: [
          "the existing session is scheduled, published or archived; change its lifecycle through the schedule or bulk session workflow first",
        ],
      };
    }
    const trackSlug = values.trackSlug ? String(values.trackSlug) : null;
    if (trackSlug && !context.tracks?.[trackSlug]) {
      return { errors: ["trackSlug does not match a track in this event"] };
    }
    return {
      rowNumber,
      action: existing ? "update" : "create",
      values: {
        ...values,
        importKey: key,
        id: existing?.id ?? crypto.randomUUID(),
        trackId: trackSlug ? (context.tracks?.[trackSlug]?.id ?? null) : null,
        expectedRevision: existing?.revision ?? null,
        expectedStatus: existing?.status ?? null,
      },
    };
  }
  if (resource === "rooms") {
    const key = String(values.name).toLowerCase();
    const existing = context.rooms?.[key];
    if (existing?.ambiguous) {
      return {
        errors: [
          "name matches multiple existing rooms; make room names unique before importing",
        ],
      };
    }
    if (existing) {
      const errors = roomScheduleErrors(values, existing);
      if (errors.length) return { errors };
    }
    return {
      rowNumber,
      action: existing ? "update" : "create",
      values: {
        ...values,
        importKey: key,
        id: existing?.id ?? crypto.randomUUID(),
        expectedName: existing?.name ?? null,
        expectedBuilding: existing?.building ?? null,
        expectedLevel: existing?.level ?? null,
        expectedCapacity: existing?.capacity ?? null,
        expectedPosition: existing?.position ?? null,
        expectedStatus: existing?.status ?? null,
      },
    };
  }
  if (resource === "tracks") {
    const key = String(values.slug);
    return {
      rowNumber,
      action: context.tracks?.[key] ? "update" : "create",
      values: {
        ...values,
        importKey: key,
        id: context.tracks?.[key]?.id ?? crypto.randomUUID(),
        expectedName: context.tracks?.[key]?.name ?? null,
        expectedColour: context.tracks?.[key]?.colour ?? null,
        expectedPosition: context.tracks?.[key]?.position ?? null,
        expectedExclusive: context.tracks?.[key]?.exclusive ?? null,
        expectedPublic: context.tracks?.[key]?.public ?? null,
      },
    };
  }
  const key = values.id ? String(values.id) : crypto.randomUUID();
  const existingTask = context.tasks?.[key];
  if (existingTask && existingTask.eventId !== viewer.eventId) {
    return { errors: ["id is already owned by a task in another event"] };
  }
  if (!existingTask && values.status !== "not_started") {
    return {
      errors: [
        "a new task must start in not_started status; import later lifecycle changes against its assigned id",
      ],
    };
  }
  const statusTransition = existingTask
    ? importedTaskStatusTransition(
        existingTask,
        String(values.status),
        String(values.statusReason),
      )
    : ({ transition: "none" } as const);
  if ("error" in statusTransition) {
    return { errors: [statusTransition.error] };
  }
  const ownerEmail = values.ownerEmail
    ? String(values.ownerEmail).toLowerCase()
    : null;
  const owner = ownerEmail ? context.people?.[ownerEmail] : null;
  if (ownerEmail && (!owner || !owner.linked)) {
    return {
      errors: [
        "ownerEmail must identify a person already linked to this event",
      ],
    };
  }
  const targetType = String(values.targetType);
  const targetId = String(values.targetId);
  if (targetType === "event" && targetId !== viewer.eventId) {
    return { errors: [`event task targetId must be ${viewer.eventId}`] };
  }
  if (targetType === "session" && !context.sessionIds?.[targetId]) {
    return { errors: ["session task targetId does not match this event"] };
  }
  if (targetType === "speaker" && !context.speakerTargets?.[targetId]) {
    return {
      errors: [
        "speaker task targetId does not match a person linked to this event",
      ],
    };
  }
  return {
    rowNumber,
    action: existingTask ? "update" : "create",
    values: {
      ...values,
      importKey: key,
      id: key,
      ownerPersonId: owner?.id ?? null,
      expectedRevision: existingTask?.revision ?? null,
      expectedStatus: existingTask?.status ?? null,
      expectedTaskType: existingTask?.taskType ?? null,
      expectedDependenciesBlocked: existingTask?.dependenciesBlocked ?? null,
      expectedDependentAdvanced: existingTask?.dependentAdvanced ?? null,
      expectedSafeSubmittedEvidence:
        existingTask?.safeSubmittedEvidence ?? null,
      statusTransition: statusTransition.transition,
    },
  };
}

export function dataImportMutationStatements(
  env: CloudflareEnvironment,
  viewer: Viewer,
  operationId: string,
  resource: EventImportResource,
  row: NormalizedImportRow,
): D1PreparedStatement[] {
  const value = row.values;
  const operationGuard = `EXISTS (SELECT 1 FROM operation_jobs WHERE id = ? AND event_id = ? AND organisation_id = ? AND status = 'running')`;
  if (resource === "people") {
    const person = env.DB.prepare(
      `INSERT INTO people (
           id, email, display_name, email_verified, organisation_name, job_title,
           profile_status, last_operation_id, created_at, updated_at
         ) SELECT ?, ?, ?, 0, ?, ?, ?, ?, unixepoch(), unixepoch()
          WHERE ${operationGuard}
         ON CONFLICT(email) DO NOTHING`,
    ).bind(
      value.id,
      value.email,
      value.name,
      value.organisation,
      value.jobTitle,
      value.profileStatus,
      operationId,
      operationId,
      viewer.eventId,
      viewer.organisationId,
    );
    const membership = env.DB.prepare(
      `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, invited_at,
           invitation_expires_at, accepted_at, revoked_at, last_operation_id,
           created_at
         ) SELECT ?, ?, ?, ?, ?, unixepoch(), unixepoch() + 604800, NULL,
                  NULL, ?, unixepoch()
          WHERE ${operationGuard}
         ON CONFLICT(event_id, person_id, role) WHERE event_id IS NOT NULL
         DO UPDATE SET invited_at = unixepoch(),
                       invitation_expires_at = unixepoch() + 604800,
                       accepted_at = NULL, revoked_at = NULL,
                       last_operation_id = excluded.last_operation_id
          WHERE memberships.organisation_id = excluded.organisation_id
            AND (memberships.revoked_at IS NOT NULL
                 OR (memberships.accepted_at IS NULL
                     AND (memberships.invitation_expires_at IS NULL
                          OR memberships.invitation_expires_at <= unixepoch())))`,
    ).bind(
      value.membershipId,
      viewer.organisationId,
      viewer.eventId,
      value.id,
      value.role,
      operationId,
      operationId,
      viewer.eventId,
      viewer.organisationId,
    );
    return [person, membership];
  }
  if (resource === "submissions") {
    return [
      env.DB.prepare(
        `INSERT INTO submissions (
           id, event_id, submitter_person_id, submitter_email, public_reference,
           title, category, format, status, answers_json, submitted_snapshot_json,
           revision, last_operation_id, submitted_at, created_at, updated_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, 1, ?, ?, unixepoch(), unixepoch()
          WHERE ${operationGuard}
         ON CONFLICT(event_id, public_reference) DO UPDATE SET
           submitter_person_id = excluded.submitter_person_id,
           submitter_email = excluded.submitter_email, title = excluded.title,
           category = excluded.category, format = excluded.format,
           status = excluded.status, submitted_snapshot_json = excluded.submitted_snapshot_json,
           submitted_at = excluded.submitted_at, withdrawn_at = CASE WHEN excluded.status = 'withdrawn' THEN unixepoch() ELSE NULL END,
           revision = submissions.revision + 1, last_operation_id = excluded.last_operation_id,
           updated_at = unixepoch()
         WHERE submissions.id = excluded.id
           AND submissions.status = 'draft' AND excluded.status = 'draft'`,
      ).bind(
        value.id,
        viewer.eventId,
        value.submitterPersonId,
        value.submitterEmail,
        value.publicReference,
        value.title,
        value.category,
        value.format,
        value.status,
        null,
        operationId,
        null,
        operationId,
        viewer.eventId,
        viewer.organisationId,
      ),
    ];
  }
  if (resource === "sessions") {
    return [
      env.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, track_id, title, slug, description, format,
           duration_minutes, expected_attendance, status, visibility,
           revision, created_at, updated_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, unixepoch(), unixepoch()
          WHERE ${operationGuard}
         ON CONFLICT(event_id, slug) DO UPDATE SET track_id = excluded.track_id,
           title = excluded.title, description = excluded.description,
           format = excluded.format, duration_minutes = excluded.duration_minutes,
           expected_attendance = excluded.expected_attendance, status = excluded.status,
           visibility = excluded.visibility, revision = sessions.revision + 1,
           updated_at = unixepoch()
         WHERE ? = 'update' AND sessions.id = excluded.id
           AND sessions.event_id = excluded.event_id
           AND sessions.revision = ? AND sessions.status = ?
           AND sessions.status IN ('unscheduled','cancelled')`,
      ).bind(
        value.id,
        viewer.eventId,
        value.trackId,
        value.title,
        value.slug,
        value.description,
        value.format,
        value.durationMinutes,
        value.expectedAttendance,
        value.status,
        value.visibility,
        operationId,
        viewer.eventId,
        viewer.organisationId,
        row.action,
        value.expectedRevision,
        value.expectedStatus,
      ),
    ];
  }
  if (resource === "rooms") {
    return [
      env.DB.prepare(
        `INSERT INTO rooms (id, event_id, name, building, level, capacity, resources_json, position, status)
         SELECT ?, ?, ?, ?, ?, ?, '[]', ?, ? WHERE ${operationGuard}
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, building = excluded.building,
           level = excluded.level, capacity = excluded.capacity, position = excluded.position,
           status = excluded.status WHERE rooms.event_id = excluded.event_id`,
      ).bind(
        value.id,
        viewer.eventId,
        value.name,
        value.building,
        value.level,
        value.capacity,
        value.position,
        value.status,
        operationId,
        viewer.eventId,
        viewer.organisationId,
      ),
    ];
  }
  if (resource === "tracks") {
    return [
      env.DB.prepare(
        `INSERT INTO tracks (id, event_id, name, slug, colour_token, position, exclusive, is_public)
         SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${operationGuard}
         ON CONFLICT(event_id, slug) DO UPDATE SET name = excluded.name,
           colour_token = excluded.colour_token, position = excluded.position,
           exclusive = excluded.exclusive, is_public = excluded.is_public`,
      ).bind(
        value.id,
        viewer.eventId,
        value.name,
        value.slug,
        value.colour,
        value.position,
        value.exclusive ? 1 : 0,
        value.public ? 1 : 0,
        operationId,
        viewer.eventId,
        viewer.organisationId,
      ),
    ];
  }
  const taskReadiness = readiness(String(value.status));
  const statusTransition = String(
    value.statusTransition,
  ) as TaskStatusTransition;
  const taskStatusAction =
    statusTransition === "progress"
      ? "task.status_imported"
      : `task.${statusTransition}`;
  return [
    env.DB.prepare(
      `INSERT INTO task_instances (
         id, event_id, target_type, target_id, owner_person_id, title, description,
         task_type, impact, status, readiness_state, readiness_percent, revision,
         last_operation_id, due_at, completed_at, completed_by_person_id,
         created_at, updated_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, 'checklist', ?, ?, ?, ?, 1, ?, ?,
                CASE WHEN ? IN ('completed','waived') THEN unixepoch() ELSE NULL END,
                CASE WHEN ? IN ('completed','waived') THEN ? ELSE NULL END,
                unixepoch(), unixepoch() WHERE ${operationGuard}
       ON CONFLICT(id) DO UPDATE SET target_type = excluded.target_type,
         target_id = excluded.target_id, owner_person_id = excluded.owner_person_id,
         title = excluded.title, description = excluded.description,
         impact = excluded.impact,
         status = CASE WHEN ? = 'none' THEN task_instances.status ELSE excluded.status END,
         readiness_state = CASE WHEN ? = 'none' THEN task_instances.readiness_state ELSE excluded.readiness_state END,
         readiness_percent = CASE WHEN ? = 'none' THEN task_instances.readiness_percent ELSE excluded.readiness_percent END,
         waiver_json = CASE
           WHEN ? = 'waive' THEN json_object('reason', ?, 'by', ?)
           WHEN ? IN ('complete','approve','reopen') THEN NULL
           ELSE task_instances.waiver_json
         END,
         completed_at = CASE
           WHEN ? IN ('complete','approve','waive') THEN unixepoch()
           WHEN ? = 'reopen' THEN NULL
           ELSE task_instances.completed_at
         END,
         completed_by_person_id = CASE
           WHEN ? IN ('complete','approve','waive') THEN ?
           WHEN ? = 'reopen' THEN NULL
           ELSE task_instances.completed_by_person_id
         END,
         last_operation_id = excluded.last_operation_id, due_at = excluded.due_at,
         revision = task_instances.revision + 1, updated_at = unixepoch()
         WHERE task_instances.event_id = excluded.event_id
           AND task_instances.revision = ? AND task_instances.status = ?`,
    ).bind(
      value.id,
      viewer.eventId,
      value.targetType,
      value.targetId,
      value.ownerPersonId,
      value.title,
      value.description,
      value.impact,
      value.status,
      taskReadiness.state,
      taskReadiness.percent,
      operationId,
      value.dueAt,
      value.status,
      value.status,
      viewer.personId,
      operationId,
      viewer.eventId,
      viewer.organisationId,
      statusTransition,
      statusTransition,
      statusTransition,
      statusTransition,
      value.statusReason,
      viewer.personId,
      statusTransition,
      statusTransition,
      statusTransition,
      statusTransition,
      viewer.personId,
      statusTransition,
      value.expectedRevision,
      value.expectedStatus,
    ),
    env.DB.prepare(
      `UPDATE task_evidence
            SET status = 'approved', reviewed_by_person_id = ?, reviewed_at = unixepoch()
          WHERE task_id = ? AND event_id = ? AND status = 'submitted'
            AND ? = 'approve'
            AND EXISTS (
              SELECT 1 FROM task_instances task
               WHERE task.id = task_evidence.task_id
                 AND task.event_id = task_evidence.event_id
                 AND task.revision = ? AND task.last_operation_id = ?
            )`,
    ).bind(
      viewer.personId,
      value.id,
      viewer.eventId,
      statusTransition,
      Number(value.expectedRevision) + 1,
      operationId,
    ),
    env.DB.prepare(
      `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, ?, ?, 'task_instance', ?, ?, ?, unixepoch()
          WHERE ? <> 'none'
            AND EXISTS (
              SELECT 1 FROM task_instances task
               WHERE task.id = ? AND task.event_id = ?
                 AND task.revision = ? AND task.last_operation_id = ?
            )`,
    ).bind(
      crypto.randomUUID(),
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      taskStatusAction,
      value.id,
      operationId,
      JSON.stringify({
        source: "csv_import",
        beforeStatus: value.expectedStatus,
        afterStatus: value.status,
        reason: value.statusReason,
      }),
      statusTransition,
      value.id,
      viewer.eventId,
      Number(value.expectedRevision) + 1,
      operationId,
    ),
  ];
}

import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import {
  participantCurrentTaskAccessSql,
  participantResourceTaskAccessSql,
} from "~/modules/tasks/task-service-foundation.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  groupProgrammeSetupSteps,
  type ProgrammeSetupStep,
} from "./programme-workflow-phases";
import {
  calculateOverallReadiness,
  calculateReadiness,
  type ReadinessTask,
} from "./readiness-rules";

type CountRow = { total: number; complete?: number; failed?: number };
export type DeliveryChannel = "email" | "sms" | "push" | "calendar";
type TaskRow = {
  id: string;
  impact: ReadinessTask["impact"];
  readinessPercent: number;
  status: string;
  readinessState: string;
  targetType: string;
  taskType: string;
  dueAt: number | null;
  participantActionable: number;
};

export type ReadinessWorkflow = {
  key:
    | "content"
    | "review"
    | "schedule"
    | "speakers"
    | "communications"
    | "operations";
  label: string;
  score: number;
  completed: number;
  total: number;
  detail: string;
  href: string;
};

export type ReadinessBlocker = {
  key: string;
  label: string;
  count: number;
  severity: "danger" | "warning";
  detail: string;
  href: string;
  action: string;
};

export type CommandCentreSnapshot = {
  eventId: string;
  eventTimezone: string;
  generatedAt: number;
  cursor: number;
  readiness: {
    percentage: number;
    status: "ready" | "on_track" | "at_risk";
    declaredBlockers: number;
    explanation: string;
  };
  setupGuide: ProgrammeSetupStep[];
  workflows: ReadinessWorkflow[];
  blockers: ReadinessBlocker[];
  deliveryHealth: Array<{
    channel: DeliveryChannel;
    acceptedOrDelivered: number;
    total: number;
    percentage: number;
  }>;
  upcoming: Array<{
    id: string;
    title: string;
    startsAt: number;
    room: string;
    /* Published is not the same as ready. Attention here means an unresolved
       blocking conflict or outstanding high-impact work on the session, both
       of which are still fixable while the session is still upcoming. */
    status: "no_blockers_detected" | "attention_required";
    riskReason: string | null;
  }>;
  operations: Array<{
    id: string;
    type: string;
    status: string;
    completed: number;
    total: number;
  }>;
};

function percent(complete: number, total: number) {
  if (total === 0) return 100;
  return Math.max(0, Math.min(100, Math.round((complete / total) * 100)));
}
function numeric(value: number | null | undefined) {
  return Number(value ?? 0);
}

async function loadCommandCentreRecords(
  env: CloudflareEnvironment,
  viewer: Viewer,
  now: number,
) {
  return Promise.all([
    env.DB.prepare(
      `
        SELECT id, impact, readiness_percent AS readinessPercent, status,
               readiness_state AS readinessState, target_type AS targetType,
               task_type AS taskType, due_at AS dueAt,
               CASE WHEN (
                 (target_type <> 'session' OR EXISTS (
                   SELECT 1 FROM session_speakers eligible_participant
                    WHERE eligible_participant.event_id = task_instances.event_id
                      AND eligible_participant.session_id = task_instances.target_id
                      AND eligible_participant.participation_status IN ('pending','confirmed')
                 ))
                 AND ${participantCurrentTaskAccessSql("task_instances")}
                 AND ${participantResourceTaskAccessSql("task_instances")}
               ) THEN 1 ELSE 0 END AS participantActionable
          FROM task_instances
         WHERE event_id = ?
      `,
    )
      .bind(viewer.eventId)
      .all<TaskRow>(),
    env.DB.prepare(
      `
        SELECT COUNT(*) AS total,
               COALESCE(SUM(CASE WHEN status IN ('accepted','waitlisted','rejected','withdrawn') THEN 1 ELSE 0 END), 0) AS complete
          FROM submissions
         WHERE event_id = ? AND status <> 'draft'
      `,
    )
      .bind(viewer.eventId)
      .first<CountRow>(),
    env.DB.prepare(
      `
        SELECT COUNT(*) AS total,
               COALESCE(SUM(CASE WHEN assignment.status = 'submitted' THEN 1 ELSE 0 END), 0) AS complete
          FROM evaluator_assignments assignment
          JOIN evaluation_rounds round
            ON round.id = assignment.round_id
           AND round.event_id = assignment.event_id
          JOIN evaluation_plans plan
            ON plan.id = round.plan_id AND plan.event_id = round.event_id
         WHERE assignment.event_id = ?
           AND assignment.status NOT IN ('cancelled','recused')
           AND round.status = 'active' AND plan.status = 'active'
      `,
    )
      .bind(viewer.eventId)
      .first<CountRow>(),
    env.DB.prepare(
      `
        SELECT COUNT(*) AS total,
               COALESCE(SUM(CASE WHEN status IN ('scheduled','published') THEN 1 ELSE 0 END), 0) AS complete
          FROM sessions
         WHERE event_id = ? AND status NOT IN ('cancelled','archived')
      `,
    )
      .bind(viewer.eventId)
      .first<CountRow>(),
    env.DB.prepare(
      `
        SELECT COUNT(*) AS total
          FROM schedule_conflicts
         WHERE event_id = ? AND severity = 'blocking' AND resolved_at IS NULL
      `,
    )
      .bind(viewer.eventId)
      .first<CountRow>(),
    env.DB.prepare(
      `
        SELECT COUNT(*) AS total
          FROM submissions s
         WHERE s.event_id = ?
           AND s.status IN ('submitted','assigned','in_review')
           AND NOT EXISTS (
             SELECT 1 FROM evaluator_assignments a
             JOIN evaluation_rounds round
               ON round.id = a.round_id AND round.event_id = a.event_id
             JOIN evaluation_plans plan
               ON plan.id = round.plan_id AND plan.event_id = round.event_id
              WHERE a.event_id = s.event_id
                AND a.submission_id = s.id
                AND a.status NOT IN ('cancelled','recused')
                AND round.status = 'active' AND plan.status = 'active'
           )
      `,
    )
      .bind(viewer.eventId)
      .first<CountRow>(),
    env.DB.prepare(
      `
        SELECT COUNT(*) AS total,
               COALESCE(SUM(CASE WHEN status IN ('sent','delivered','opened','clicked') THEN 1 ELSE 0 END), 0) AS complete,
               COALESCE(SUM(CASE WHEN status IN ('failed','bounced','suppressed') THEN 1 ELSE 0 END), 0) AS failed
          FROM communication_deliveries
         WHERE event_id = ? AND status <> 'cancelled'
      `,
    )
      .bind(viewer.eventId)
      .first<CountRow>(),
    env.DB.prepare(
      `
        SELECT (
          SELECT COUNT(*) FROM integration_connections
           WHERE event_id = ? AND status IN ('needs_attention','failed')
        ) + (
          SELECT COUNT(*) FROM integration_runs r
          JOIN integration_connections c ON c.id = r.connection_id
           WHERE c.event_id = ? AND r.status IN ('partially_failed','failed')
        ) AS total
      `,
    )
      .bind(viewer.eventId, viewer.eventId)
      .first<CountRow>(),
    env.DB.prepare(
      `
        SELECT COUNT(*) AS total FROM schedule_versions d
         WHERE d.event_id = ? AND d.status = 'draft'
           AND d.version_number > COALESCE((
             SELECT MAX(p.version_number) FROM schedule_versions p
              WHERE p.event_id = d.event_id AND p.status = 'published'
           ), 0)
      `,
    )
      .bind(viewer.eventId)
      .first<CountRow>(),
    env.DB.prepare(
      `
        SELECT s.id, s.title, e.starts_at AS startsAt, r.name AS room,
               -- A session on the published schedule is not automatically
               -- clear: an unresolved blocking conflict on it is exactly the
               -- thing this panel exists to surface before the day arrives.
               -- Conflicts name schedule entries, so both sides are resolved
               -- back to their session.
               (SELECT COUNT(*)
                  FROM schedule_conflicts conflict
                  LEFT JOIN schedule_entries primary_entry
                    ON primary_entry.id = conflict.primary_entry_id
                   AND primary_entry.event_id = conflict.event_id
                  LEFT JOIN schedule_entries other_entry
                    ON other_entry.id = conflict.conflicting_entry_id
                   AND other_entry.event_id = conflict.event_id
                 WHERE conflict.event_id = v.event_id
                   AND conflict.schedule_version_id = v.id
                   AND conflict.resolved_at IS NULL
                   AND conflict.severity = 'blocking'
                   AND (primary_entry.session_id = s.id
                        OR other_entry.session_id = s.id)
               ) AS blockingConflicts,
               (SELECT COUNT(*)
                  FROM task_instances speaker_task
                 WHERE speaker_task.event_id = v.event_id
                   AND speaker_task.target_type = 'session'
                   AND speaker_task.target_id = s.id
                   AND speaker_task.status NOT IN ('completed','waived')
                   AND speaker_task.impact IN ('critical','high')
                   AND ${participantCurrentTaskAccessSql("speaker_task")}
                   AND EXISTS (
                     SELECT 1 FROM session_speakers eligible_participant
                      WHERE eligible_participant.event_id = speaker_task.event_id
                        AND eligible_participant.session_id = speaker_task.target_id
                        AND eligible_participant.participation_status IN ('pending','confirmed')
                   )
               ) AS openCriticalTasks
          FROM schedule_versions v
          JOIN schedule_entries e ON e.schedule_version_id = v.id AND e.event_id = v.event_id
          JOIN sessions s ON s.id = e.session_id AND s.event_id = v.event_id
          JOIN rooms r ON r.id = e.room_id AND r.event_id = v.event_id
         WHERE v.event_id = ? AND v.status = 'published'
           AND s.visibility = 'public' AND e.starts_at >= ?
           AND v.version_number = (
             SELECT MAX(version_number) FROM schedule_versions
              WHERE event_id = v.event_id AND status = 'published'
           )
         ORDER BY e.starts_at ASC LIMIT 5
      `,
    )
      .bind(viewer.eventId, now)
      .all<{
        id: string;
        title: string;
        startsAt: number;
        room: string;
        blockingConflicts: number;
        openCriticalTasks: number;
      }>(),
    env.DB.prepare(
      `
        SELECT COUNT(*) AS total,
               COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS complete,
               COALESCE(SUM(CASE WHEN status IN ('failed','queue_failed','partially_failed') THEN 1 ELSE 0 END), 0) AS failed
          FROM operation_jobs
         WHERE event_id = ? AND status <> 'cancelled'
           AND alert_acknowledged_at IS NULL
      `,
    )
      .bind(viewer.eventId)
      .first<CountRow>(),
    env.DB.prepare(
      `
        SELECT id, type, status, progress_completed AS completed, progress_total AS total
          FROM operation_jobs
         WHERE event_id = ?
         ORDER BY created_at DESC LIMIT 5
      `,
    )
      .bind(viewer.eventId)
      .all<{
        id: string;
        type: string;
        status: string;
        completed: number;
        total: number;
      }>(),
    env.DB.prepare(
      `
        SELECT channel, COUNT(*) AS total,
               COALESCE(SUM(CASE WHEN status IN ('sent','delivered','opened','clicked') THEN 1 ELSE 0 END), 0) AS acceptedOrDelivered
          FROM communication_deliveries
         WHERE event_id = ? AND status <> 'cancelled'
         GROUP BY channel ORDER BY channel
      `,
    )
      .bind(viewer.eventId)
      .all<{
        channel: DeliveryChannel;
        acceptedOrDelivered: number;
        total: number;
      }>(),
  ]);
}

export class ReadinessService {
  private readonly airtable: AirtableProviderBoundary;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  async getCommandCentre(viewer: Viewer): Promise<CommandCentreSnapshot> {
    await this.airtable.assertReadable(viewer);
    const event = await this.env.DB.prepare(
      `
      SELECT id, timezone,
             (SELECT COALESCE(MAX(sequence), 0)
                FROM event_changes
               WHERE event_id = events.id) AS baselineCursor,
             length(trim(COALESCE(description, ''))) > 0 AS detailsComplete,
             EXISTS (
               SELECT 1 FROM form_definitions form
               JOIN form_versions version
                 ON version.form_id = form.id
                AND version.event_id = form.event_id
                AND version.status = 'published'
              WHERE form.event_id = events.id AND form.status = 'published'
             ) AS formComplete,
             EXISTS (
               SELECT 1 FROM evaluation_plans plan
               JOIN evaluation_rounds round
                 ON round.plan_id = plan.id AND round.event_id = plan.event_id
               JOIN evaluation_criteria criterion
                 ON criterion.round_id = round.id
                AND criterion.event_id = round.event_id
              WHERE plan.event_id = events.id
                AND plan.status IN ('draft', 'active')
                AND round.status IN ('draft', 'active')
             ) AS reviewComplete,
             EXISTS (
               SELECT 1 FROM task_templates template
                WHERE template.event_id = events.id
                  AND template.status = 'active'
             ) AS tasksComplete,
             EXISTS (
               SELECT 1 FROM sender_profiles sender
                WHERE sender.event_id = events.id
                  AND sender.status = 'verified'
             ) AS communicationsComplete,
             EXISTS (
               SELECT 1 FROM schedule_versions version
                WHERE version.event_id = events.id
                  AND version.status = 'published'
             ) AS publicationComplete
        FROM events WHERE id = ? AND organisation_id = ?
    `,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{
        id: string;
        timezone: string;
        detailsComplete: number;
        formComplete: number;
        reviewComplete: number;
        tasksComplete: number;
        communicationsComplete: number;
        publicationComplete: number;
        baselineCursor: number;
      }>();
    if (!event)
      throw new Response("This event could not be found.", { status: 404 });

    const now = Math.floor(Date.now() / 1000);
    // Capture the cursor before the snapshot. Any mutation that commits while
    // the remaining reads run will therefore have a newer cursor and trigger a
    // subsequent client revalidation instead of being silently skipped.
    const [
      taskResult,
      content,
      review,
      schedule,
      conflict,
      unassigned,
      deliveries,
      integrations,
      draftSchedule,
      upcoming,
      operationSummary,
      operations,
      deliveryChannels,
    ] = await loadCommandCentreRecords(this.env, viewer, now);

    const tasks = taskResult.results.filter(
      (task) => task.participantActionable === 1,
    );
    const incomplete = new Set([
      "not_started",
      "in_progress",
      "blocked",
      "submitted",
      "overdue",
    ]);
    const overdueTasks = tasks.filter(
      (task) =>
        incomplete.has(task.status) &&
        (task.status === "overdue" ||
          task.readinessState === "overdue" ||
          (task.dueAt !== null && task.dueAt < now)),
    );
    const criticalTasks = tasks.filter(
      (task) => incomplete.has(task.status) && task.impact === "critical",
    );
    const speakerTasks = tasks.filter((task) => task.targetType === "speaker");
    const missingSpeakerAssets = speakerTasks.filter(
      (task) => task.taskType === "file_upload" && incomplete.has(task.status),
    );
    const speakerReadiness = calculateReadiness(
      speakerTasks.map((task) => ({
        id: task.id,
        impact: task.impact,
        readinessPercent: task.readinessPercent,
        blocking: task.impact === "critical" && incomplete.has(task.status),
      })),
    );

    const operationRows = operations.results;
    const operationComplete = numeric(operationSummary?.complete);
    const operationFailed = numeric(operationSummary?.failed);
    const operationTotal = numeric(operationSummary?.total);
    const contentTotal = numeric(content?.total);
    const contentComplete = numeric(content?.complete);
    const reviewTotal = numeric(review?.total);
    const reviewComplete = numeric(review?.complete);
    const scheduleTotal = numeric(schedule?.total);
    const scheduleComplete = numeric(schedule?.complete);
    const deliveryTotal = numeric(deliveries?.total);
    const deliveryComplete = numeric(deliveries?.complete);
    const blockingConflicts = numeric(conflict?.total);

    const workflows: ReadinessWorkflow[] = [
      {
        key: "content",
        label: "Content & submissions",
        score: percent(contentComplete, contentTotal),
        completed: contentComplete,
        total: contentTotal,
        detail: "Submissions with a recorded outcome",
        href: "/admin/submissions",
      },
      {
        key: "review",
        label: "Review",
        score: percent(reviewComplete, reviewTotal),
        completed: reviewComplete,
        total: reviewTotal,
        detail: "Active assignments submitted",
        href: "/admin/review",
      },
      {
        key: "schedule",
        label: "Schedule",
        score: Math.min(
          percent(scheduleComplete, scheduleTotal),
          blockingConflicts > 0 ? 75 : 100,
        ),
        completed: scheduleComplete,
        total: scheduleTotal,
        detail: "Active sessions scheduled without blocking conflicts",
        href: "/admin/schedule",
      },
      {
        key: "speakers",
        label: "Speakers & materials",
        score: speakerReadiness.percentage,
        completed: speakerTasks.filter((task) => !incomplete.has(task.status))
          .length,
        total: speakerTasks.length,
        detail: "Impact-weighted speaker task readiness",
        href: "/admin/tasks?target=speaker",
      },
      {
        key: "communications",
        label: "Communications",
        score: percent(deliveryComplete, deliveryTotal),
        completed: deliveryComplete,
        total: deliveryTotal,
        detail: "Accepted or delivered records",
        href: "/admin/communications",
      },
      {
        key: "operations",
        label: "Operations",
        score: percent(operationComplete, operationTotal),
        completed: operationComplete,
        total: operationTotal,
        detail: "Durable background operations completed",
        href: "/admin/operations",
      },
    ];

    const blockers = (
      [
        {
          key: "overdue_tasks",
          label: "Overdue tasks",
          count: overdueTasks.length,
          severity: "danger",
          detail: "Incomplete tasks whose due date has passed.",
          href: "/admin/tasks?state=overdue",
          action: "Review overdue work",
        },
        {
          key: "critical_tasks",
          label: "Critical tasks incomplete",
          count: criticalTasks.length,
          severity: "danger",
          detail: "Declared critical work is not complete.",
          href: "/admin/tasks?impact=critical&state=open",
          action: "Resolve critical work",
        },
        {
          key: "speaker_assets",
          label: "Missing speaker assets",
          count: missingSpeakerAssets.length,
          severity: "warning",
          detail: "Speaker file requests still need an approved upload.",
          href: "/admin/tasks?target=speaker&type=file_upload&state=open",
          action: "Follow up with speakers",
        },
        {
          key: "unassigned_reviews",
          label: "Unassigned reviews",
          count: numeric(unassigned?.total),
          severity: "warning",
          detail: "Submitted proposals have no active evaluator assignment.",
          href: "/admin/review?filter=unassigned",
          action: "Assign evaluators",
        },
        {
          key: "unscheduled_sessions",
          label: "Unscheduled sessions",
          count: Math.max(0, scheduleTotal - scheduleComplete),
          severity: "warning",
          detail: "Active sessions still need a time and room.",
          href: "/admin/schedule?filter=unscheduled",
          action: "Open schedule planner",
        },
        {
          key: "schedule_conflicts",
          label: "Blocking schedule conflicts",
          count: blockingConflicts,
          severity: "danger",
          detail: "Unresolved conflicts will prevent publication.",
          href: "/admin/schedule?filter=conflicts",
          action: "Resolve conflicts",
        },
        {
          key: "delivery_failures",
          label: "Delivery failures",
          count: numeric(deliveries?.failed),
          severity: "danger",
          detail: "Messages bounced, were suppressed or failed.",
          href: "/admin/communications?filter=failed",
          action: "Inspect deliveries",
        },
        {
          key: "integration_failures",
          label: "Integration attention",
          count: numeric(integrations?.total),
          severity: "danger",
          detail: "Connections or integration runs need attention.",
          href: "/admin/integrations?filter=attention",
          action: "Inspect integrations",
        },
        {
          key: "operation_failures",
          label: "Operation failures",
          count: operationFailed,
          severity: "danger",
          detail: "Active durable operations failed or partially failed.",
          href: "/admin/operations?status=failed",
          action: "Review failed operations",
        },
        {
          key: "unpublished_schedule",
          label: "Unpublished schedule changes",
          count: numeric(draftSchedule?.total),
          severity: "warning",
          detail: "A newer schedule draft has not been published.",
          href: "/admin/schedule?filter=draft",
          action: "Review draft changes",
        },
      ] satisfies ReadinessBlocker[]
    ).filter((blocker) => blocker.count > 0);

    const declaredBlockers = blockers.reduce(
      (sum, blocker) => sum + blocker.count,
      0,
    );
    const setupGuide = [
      {
        key: "event-details",
        label: "Describe the event",
        description:
          "Add the public event description and confirm identity, dates and location.",
        href: "/admin/event",
        complete: Boolean(event.detailsComplete),
      },
      {
        key: "application-form",
        label: "Publish an application form",
        description:
          "Configure participant intake and publish its first version.",
        href: "/admin/submissions/form",
        complete: Boolean(event.formComplete),
      },
      {
        key: "review-plan",
        label: "Configure review",
        description:
          "Create a review plan with a round and at least one criterion.",
        href: "/admin/review",
        complete: Boolean(event.reviewComplete),
      },
      {
        key: "participant-tasks",
        label: "Prepare participant tasks",
        description:
          "Create the requirements participants will complete after acceptance.",
        href: "/admin/tasks",
        complete: Boolean(event.tasksComplete),
      },
      {
        key: "communications",
        label: "Verify communications",
        description:
          "Verify the sender identity used for participant messages.",
        href: "/admin/communications",
        complete: Boolean(event.communicationsComplete),
      },
      {
        key: "publication",
        label: "Publish the programme",
        description:
          "Publish a conflict-free schedule when the programme is ready.",
        href: "/admin/schedule",
        complete: Boolean(event.publicationComplete),
      },
    ] satisfies ProgrammeSetupStep[];
    const setupPhases = groupProgrammeSetupSteps(setupGuide);
    const setupPercentage = percent(
      setupPhases.filter((phase) => phase.complete).length,
      setupPhases.length,
    );
    const percentage = Math.min(
      calculateOverallReadiness(workflows, declaredBlockers),
      setupPercentage,
    );
    return {
      eventId: viewer.eventId,
      eventTimezone: event.timezone,
      generatedAt: now,
      cursor: numeric(event.baselineCursor),
      readiness: {
        percentage,
        status:
          percentage === 100
            ? "ready"
            : percentage >= 75
              ? "on_track"
              : "at_risk",
        declaredBlockers,
        explanation:
          "Equal-weighted average across six operational workflows, capped by completion of the four programme setup phases. Any declared blocker prevents a 100% ready result.",
      },
      setupGuide,
      workflows,
      blockers,
      deliveryHealth: deliveryChannels.results.map((row) => ({
        ...row,
        percentage: percent(row.acceptedOrDelivered, row.total),
      })),
      upcoming: upcoming.results.map((session) => {
        const conflicts = numeric(session.blockingConflicts);
        const openWork = numeric(session.openCriticalTasks);
        return {
          id: session.id,
          title: session.title,
          startsAt: session.startsAt,
          room: session.room,
          status:
            conflicts > 0 || openWork > 0
              ? "attention_required"
              : "no_blockers_detected",
          riskReason: conflicts
            ? `${conflicts} unresolved blocking conflict${conflicts === 1 ? "" : "s"}`
            : openWork
              ? `${openWork} high-impact task${openWork === 1 ? "" : "s"} outstanding`
              : null,
        };
      }),
      operations: operationRows,
    };
  }
}

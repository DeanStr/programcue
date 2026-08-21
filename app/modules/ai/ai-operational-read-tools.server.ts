import { ReadinessService } from "~/modules/readiness/readiness-service.server";
import { participantResourceTaskAccessSql } from "~/modules/tasks/task-service-foundation.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  distinctEvidence,
  parseArguments,
  parseJson,
} from "./ai-read-tool-shared.server";
import {
  boundedLimitSchema,
  emptyArgumentsSchema,
} from "./ai-tool-contracts.server";
import {
  type AiToolExecution,
  AiToolPermissionError,
} from "./ai-tool-execution";
import type { AiEvidence } from "./ai-types";

export class AiOperationalReadTools {
  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly viewer: Viewer,
  ) {}

  execute(name: string, encodedArguments: string): Promise<AiToolExecution> {
    switch (name) {
      case "get_event_readiness":
        return this.executeGetEventReadiness(encodedArguments);
      case "find_incomplete_speakers":
        return this.executeFindIncompleteSpeakers(encodedArguments);
      case "get_review_progress":
        return this.executeGetReviewProgress(encodedArguments);
      case "inspect_schedule_conflicts":
        return this.executeInspectScheduleConflicts(encodedArguments);
      case "inspect_integration_failures":
        return this.executeInspectIntegrationFailures(encodedArguments);
      default:
        throw new AiToolPermissionError(
          `Tool ${name} is not an operational read tool.`,
        );
    }
  }

  private async executeGetEventReadiness(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "get_event_readiness";

    const args = parseArguments(name, encodedArguments, emptyArgumentsSchema);
    const snapshot = await new ReadinessService(this.env).getCommandCentre(
      this.viewer,
    );
    const evidence: AiEvidence[] = [
      {
        id: "event-readiness",
        label: "Event readiness",
        detail: `${snapshot.readiness.percentage}% · ${snapshot.readiness.status.replaceAll("_", " ")}`,
        href: "/admin/command",
        source: "Program Cue D1",
      },
      ...snapshot.blockers.map((blocker) => ({
        id: `readiness-blocker:${blocker.key}`,
        label: blocker.label,
        detail: `${blocker.count} affected · ${blocker.detail}`,
        href: blocker.href,
        source: "Program Cue D1" as const,
      })),
    ];
    return {
      output: {
        source: "authoritative_command_centre_snapshot",
        generatedAt: new Date(snapshot.generatedAt * 1_000).toISOString(),
        readiness: snapshot.readiness,
        workflows: snapshot.workflows,
        blockers: snapshot.blockers,
      },
      evidence,
      proposals: [],
      auditSummary: {
        arguments: args,
        readiness: snapshot.readiness.percentage,
        blockerCount: snapshot.blockers.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeFindIncompleteSpeakers(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "find_incomplete_speakers";

    const args = parseArguments(name, encodedArguments, boundedLimitSchema);
    const rows = await this.env.DB.prepare(
      `WITH event_speakers(person_id) AS (
         SELECT person_id FROM session_speakers WHERE event_id = ?
         UNION
         SELECT person_id FROM memberships
          WHERE event_id = ? AND role = 'speaker'
            AND accepted_at IS NOT NULL AND revoked_at IS NULL
       )
       SELECT p.id, p.display_name AS name,
              COUNT(ti.id) AS taskCount,
              COALESCE(SUM(CASE WHEN ti.status NOT IN ('completed','waived') THEN 1 ELSE 0 END), 0) AS incompleteCount,
              COALESCE(SUM(CASE WHEN ti.status = 'overdue' OR
                (ti.status NOT IN ('completed','waived') AND ti.due_at IS NOT NULL AND ti.due_at < unixepoch())
                THEN 1 ELSE 0 END), 0) AS overdueCount
         FROM event_speakers es
         JOIN people p ON p.id = es.person_id
         JOIN events e ON e.id = ? AND e.organisation_id = ?
         LEFT JOIN task_instances ti ON ti.event_id = e.id
           AND ti.target_type = 'speaker' AND ti.target_id = p.id
           AND ${participantResourceTaskAccessSql("ti")}
        GROUP BY p.id, p.display_name
       HAVING incompleteCount > 0
        ORDER BY overdueCount DESC, incompleteCount DESC, p.display_name
        LIMIT ?`,
    )
      .bind(
        this.viewer.eventId,
        this.viewer.eventId,
        this.viewer.eventId,
        this.viewer.organisationId,
        args.limit,
      )
      .all<{
        id: string;
        name: string;
        taskCount: number;
        incompleteCount: number;
        overdueCount: number;
      }>();
    const evidence = rows.results.map((speaker) => ({
      id: `speaker:${speaker.id}`,
      label: speaker.name,
      detail: `${speaker.incompleteCount} incomplete task${speaker.incompleteCount === 1 ? "" : "s"}`,
      href: `/admin/speakers?person=${encodeURIComponent(speaker.id)}`,
      source: "Program Cue D1" as const,
    }));
    return {
      output: { source: "event_speaker_tasks", speakers: rows.results },
      evidence,
      proposals: [],
      auditSummary: {
        arguments: args,
        resultCount: rows.results.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeGetReviewProgress(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "get_review_progress";

    const args = parseArguments(name, encodedArguments, emptyArgumentsSchema);
    const rows = await this.env.DB.prepare(
      `SELECT r.id, r.name, r.round_number AS roundNumber, r.status,
              COUNT(a.id) AS totalAssignments,
              COALESCE(SUM(CASE WHEN a.status = 'submitted' THEN 1 ELSE 0 END), 0) AS submittedAssignments,
              COALESCE(SUM(CASE WHEN a.status IN ('assigned','in_progress','reopened') THEN 1 ELSE 0 END), 0) AS openAssignments,
              COALESCE(SUM(CASE WHEN a.status = 'recused' THEN 1 ELSE 0 END), 0) AS recusals
         FROM evaluation_rounds r
         JOIN evaluation_plans plan
           ON plan.id = r.plan_id AND plan.event_id = r.event_id
         JOIN events e ON e.id = r.event_id AND e.organisation_id = ?
         LEFT JOIN evaluator_assignments a ON a.round_id = r.id AND a.event_id = r.event_id
        WHERE r.event_id = ? AND r.status <> 'archived'
          AND plan.status <> 'archived'
        GROUP BY r.id, r.name, r.round_number, r.status
        ORDER BY r.round_number`,
    )
      .bind(this.viewer.organisationId, this.viewer.eventId)
      .all<{
        id: string;
        name: string;
        roundNumber: number;
        status: string;
        totalAssignments: number;
        submittedAssignments: number;
        openAssignments: number;
        recusals: number;
      }>();
    const evidence = rows.results.map((round) => ({
      id: `evaluation-round:${round.id}`,
      label: round.name,
      detail: `${round.submittedAssignments}/${round.totalAssignments} assignments submitted`,
      href: `/admin/review?round=${encodeURIComponent(round.id)}`,
      source: "Program Cue D1" as const,
    }));
    return {
      output: { source: "evaluation_assignments", rounds: rows.results },
      evidence,
      proposals: [],
      auditSummary: {
        arguments: args,
        resultCount: rows.results.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeInspectScheduleConflicts(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "inspect_schedule_conflicts";

    const args = parseArguments(name, encodedArguments, boundedLimitSchema);
    const rows = await this.env.DB.prepare(
      `SELECT c.id, c.conflict_type AS conflictType, c.severity,
              c.details_json AS detailsJson,
              primary_session.title AS primarySession,
              conflicting_session.title AS conflictingSession
         FROM schedule_conflicts c
         JOIN schedule_versions v ON v.id = c.schedule_version_id AND v.event_id = c.event_id
         JOIN events event ON event.id = c.event_id AND event.organisation_id = ?
         LEFT JOIN schedule_entries primary_entry ON primary_entry.id = c.primary_entry_id
         LEFT JOIN sessions primary_session ON primary_session.id = primary_entry.session_id
         LEFT JOIN schedule_entries conflicting_entry ON conflicting_entry.id = c.conflicting_entry_id
         LEFT JOIN sessions conflicting_session ON conflicting_session.id = conflicting_entry.session_id
        WHERE c.event_id = ? AND c.resolved_at IS NULL
        ORDER BY CASE c.severity WHEN 'blocking' THEN 0 ELSE 1 END, c.created_at DESC
        LIMIT ?`,
    )
      .bind(this.viewer.organisationId, this.viewer.eventId, args.limit)
      .all<{
        id: string;
        conflictType: string;
        severity: string;
        detailsJson: string;
        primarySession: string | null;
        conflictingSession: string | null;
      }>();
    const conflicts = rows.results.map(({ detailsJson, ...row }) => ({
      ...row,
      details: parseJson(detailsJson, `Schedule conflict ${row.id}`),
    }));
    const evidence = conflicts.map((conflict) => ({
      id: `schedule-conflict:${conflict.id}`,
      label: `${conflict.severity} ${conflict.conflictType.replaceAll("_", " ")} conflict`,
      detail:
        [conflict.primarySession, conflict.conflictingSession]
          .filter(Boolean)
          .join(" / ") || "Recorded schedule conflict",
      href: `/admin/schedule?conflict=${encodeURIComponent(conflict.id)}`,
      source: "Program Cue D1" as const,
    }));
    return {
      output: {
        source: "deterministic_schedule_conflict_engine",
        conflicts,
      },
      evidence,
      proposals: [],
      auditSummary: {
        arguments: args,
        resultCount: conflicts.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeInspectIntegrationFailures(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "inspect_integration_failures";

    const args = parseArguments(name, encodedArguments, boundedLimitSchema);
    const rows = await this.env.DB.prepare(
      `SELECT c.id AS connectionId, c.provider,
              c.status AS connectionStatus, r.id AS runId, r.status AS runStatus,
              item.entity_type AS entityType, item.entity_id AS entityId,
              item.error_code AS errorCode, item.error_message AS errorMessage
         FROM integration_connections c
         JOIN events event ON event.id = c.event_id AND event.organisation_id = ?
         LEFT JOIN integration_runs r ON r.connection_id = c.id
           AND r.id = (SELECT latest.id FROM integration_runs latest
                        WHERE latest.connection_id = c.id
                        ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1)
         LEFT JOIN integration_run_items item ON item.run_id = r.id AND item.status = 'failed'
        WHERE c.event_id = ? AND (
          c.status IN ('needs_attention','failed')
          OR r.status IN ('partially_failed','failed')
        )
        ORDER BY c.updated_at DESC, item.updated_at DESC
        LIMIT ?`,
    )
      .bind(this.viewer.organisationId, this.viewer.eventId, args.limit)
      .all<{
        connectionId: string;
        provider: string;
        connectionStatus: string;
        runId: string | null;
        runStatus: string | null;
        entityType: string | null;
        entityId: string | null;
        errorCode: string | null;
        errorMessage: string | null;
      }>();
    const evidence = distinctEvidence(
      rows.results.map((failure) => ({
        id: `integration:${failure.connectionId}`,
        label: `${failure.provider} integration`,
        detail:
          failure.errorMessage?.slice(0, 300) ??
          failure.runStatus ??
          failure.connectionStatus,
        href: `/admin/integrations?connection=${encodeURIComponent(failure.connectionId)}`,
        source: "Program Cue D1" as const,
      })),
    );
    return {
      output: { source: "integration_run_history", failures: rows.results },
      evidence,
      proposals: [],
      auditSummary: {
        arguments: args,
        resultCount: rows.results.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }
}

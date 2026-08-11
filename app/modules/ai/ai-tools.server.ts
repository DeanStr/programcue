import { z } from "zod";

import type { AiEvidence } from "./ai-types";
import {
  AiProposalToolExecutor,
  prepareReminderSendProposal,
} from "./ai-proposal-tool-executor.server";
export { prepareReminderSendProposal } from "./ai-proposal-tool-executor.server";
import {
  AiToolPermissionError,
  AiToolValidationError,
  type AiToolExecution,
} from "./ai-tool-execution";
import type { OpenAiFunctionTool } from "./openai-responses-provider.server";
import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { CommunicationService } from "~/modules/communications/communication-service.server";
import { EvaluationService } from "~/modules/evaluations/evaluation-service.server";
import { IntegrationService } from "~/modules/integrations/integration-service.server";
import { ReadinessService } from "~/modules/readiness/readiness-service.server";
import {
  detectScheduleConflicts,
  type ScheduledItem,
} from "~/modules/schedule/schedule-rules";
import { ScheduleService } from "~/modules/schedule/schedule-service.server";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";

import {
  AI_TOOLS,
  type AiToolName,
  acceleventsRunProposalArgumentsSchema,
  adminRoles,
  assistantProposalMetadataSchema,
  boundedLimitSchema,
  emailTemplateDraftProposalArgumentsSchema,
  emptyArgumentsSchema,
  formDraftProposalArgumentsSchema,
  formPublicationProposalArgumentsSchema,
  reminderCohortSchema,
  reminderDraftArgumentsSchema,
  reminderSendProposalArgumentsSchema,
  submissionSearchSchema,
  taskProposalArgumentsSchema,
} from "./ai-tool-contracts.server";
export {
  acceleventsRunProposalArgumentsSchema,
  assistantProposalMetadataSchema,
  emailTemplateDraftProposalArgumentsSchema,
  formDraftProposalArgumentsSchema,
  formPublicationProposalArgumentsSchema,
  reminderCohortSchema,
  reminderSendAudienceSchema,
  reminderSendProposalArgumentsSchema,
  taskProposalArgumentsSchema,
} from "./ai-tool-contracts.server";

export {
  AiToolPermissionError,
  AiToolValidationError,
} from "./ai-tool-execution";
export type { AiToolExecution } from "./ai-tool-execution";

function parseJson(value: string, context: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${context} contains invalid JSON.`, { cause: error });
  }
}

function parseArguments<T>(name: string, value: string, schema: z.ZodType<T>) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new AiToolValidationError(
      `The selected AI provider returned invalid JSON arguments for ${name}.`,
    );
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    throw new AiToolValidationError(
      `The selected AI provider returned invalid arguments for ${name}: ${parsed.error.issues[0]?.message ?? "validation failed"}`,
    );
  }
  return parsed.data;
}

function likePattern(value: string) {
  return `%${value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_")}%`;
}

function distinctEvidence(evidence: AiEvidence[]) {
  return [...new Map(evidence.map((item) => [item.id, item])).values()];
}

type ReminderCohort = z.infer<typeof reminderCohortSchema>;

export async function loadReminderCohort(
  env: CloudflareEnvironment,
  viewer: Viewer,
  cohort: ReminderCohort,
) {
  if (!adminRoles.has(viewer.role)) throw new AiToolPermissionError();
  const definitions: Record<
    ReminderCohort,
    { from: string; where: string; reason: string; href: string }
  > = {
    incomplete_speakers: {
      from: `people p JOIN task_instances ti
               ON ti.target_id = p.id AND ti.event_id = ?
              AND ti.target_type = 'speaker'`,
      where: "ti.status NOT IN ('completed','waived')",
      reason: "incomplete speaker tasks",
      href: "/admin/tasks?target=speaker&state=open",
    },
    overdue_speaker_tasks: {
      from: `people p JOIN task_instances ti
               ON ti.target_id = p.id AND ti.event_id = ?
              AND ti.target_type = 'speaker'`,
      where:
        "ti.status = 'overdue' OR (ti.status NOT IN ('completed','waived') AND ti.due_at IS NOT NULL AND ti.due_at < unixepoch())",
      reason: "overdue speaker tasks",
      href: "/admin/tasks?target=speaker&state=overdue",
    },
    reviewers_with_open_assignments: {
      from: `people p JOIN evaluator_assignments a
               ON a.evaluator_person_id = p.id AND a.event_id = ?`,
      where: "a.status IN ('assigned','in_progress','reopened')",
      reason: "open review assignments",
      href: "/admin/review?filter=open",
    },
  };
  const definition = definitions[cohort];
  const base = `FROM ${definition.from}
    JOIN events e ON e.id = ? AND e.organisation_id = ?
   WHERE ${definition.where}`;
  const [count, sample] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(DISTINCT p.id) AS count ${base}`)
      .bind(viewer.eventId, viewer.eventId, viewer.organisationId)
      .first<{ count: number }>(),
    env.DB.prepare(
      `SELECT p.id, p.display_name AS name, COUNT(*) AS affected ${base}
       GROUP BY p.id, p.display_name ORDER BY affected DESC, p.display_name LIMIT 10`,
    )
      .bind(viewer.eventId, viewer.eventId, viewer.organisationId)
      .all<{ id: string; name: string; affected: number }>(),
  ]);
  return {
    cohort,
    count: Number(count?.count ?? 0),
    reason: definition.reason,
    sample: sample.results,
    href: definition.href,
  };
}

export function availableAiTools(viewer: Viewer): OpenAiFunctionTool[] {
  if (!adminRoles.has(viewer.role)) return [];
  return AI_TOOLS.map(({ class: _class, ...tool }) => tool);
}

export class AiToolExecutor {
  private readonly airtable: AirtableProviderBoundary;

  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly viewer: Viewer,
    private readonly runId: string,
    private readonly model: string,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  async execute(
    name: string,
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    if (!adminRoles.has(this.viewer.role)) throw new AiToolPermissionError();
    const definition = AI_TOOLS.find((tool) => tool.name === name);
    if (!definition) {
      throw new AiToolPermissionError(
        `The selected AI provider requested the non-allow-listed tool ${name}.`,
      );
    }
    await this.airtable.assertReadable(this.viewer);
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
      case "search_submissions":
        return this.executeSearchSubmissions(encodedArguments);
      case "list_reminder_templates":
        return this.executeListReminderTemplates(encodedArguments);
      case "get_evaluation_setup":
        return this.executeGetEvaluationSetup(encodedArguments);
      case "get_schedule_workspace":
        return this.executeGetScheduleWorkspace(encodedArguments);
      case "list_form_drafts":
        return this.executeListFormDrafts(encodedArguments);
      case "get_accelevents_export_status":
        return this.executeGetAcceleventsExportStatus(encodedArguments);
      case "draft_reminder":
        return this.executeDraftReminder(encodedArguments);
      case "propose_reminder_send":
      case "propose_form_draft":
      case "propose_rubric_update":
      case "propose_reviewer_assignment":
      case "propose_email_template_draft":
      case "propose_schedule_placement":
      case "propose_form_publication":
      case "propose_schedule_publication":
      case "propose_accelevents_run":
      case "propose_task":
        return new AiProposalToolExecutor(
          this.env,
          this.viewer,
          this.runId,
          this.model,
        ).execute(name, encodedArguments);
    }
    throw new AiToolPermissionError(`Tool ${name} is not allow-listed.`);
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
         JOIN events e ON e.id = r.event_id AND e.organisation_id = ?
         LEFT JOIN evaluator_assignments a ON a.round_id = r.id AND a.event_id = r.event_id
        WHERE r.event_id = ?
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

  private async executeSearchSubmissions(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "search_submissions";

    const args = parseArguments(name, encodedArguments, submissionSearchSchema);
    const pattern = likePattern(args.query);
    const rows = await this.env.DB.prepare(
      `SELECT s.id, s.public_reference AS reference, s.title, s.category,
              s.format, s.status
         FROM submissions s
         JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
        WHERE s.event_id = ? AND (
          s.title LIKE ? ESCAPE '\\'
          OR s.public_reference LIKE ? ESCAPE '\\'
          OR COALESCE(s.category, '') LIKE ? ESCAPE '\\'
        )
        ORDER BY s.updated_at DESC, s.id
        LIMIT ?`,
    )
      .bind(
        this.viewer.organisationId,
        this.viewer.eventId,
        pattern,
        pattern,
        pattern,
        args.limit,
      )
      .all<{
        id: string;
        reference: string;
        title: string;
        category: string | null;
        format: string | null;
        status: string;
      }>();
    const evidence = rows.results.map((submission) => ({
      id: `submission:${submission.id}`,
      label: submission.title,
      detail: `${submission.reference} · ${submission.status}`,
      href: `/admin/submissions/${encodeURIComponent(submission.id)}`,
      source: "Program Cue D1" as const,
    }));
    return {
      output: { source: "event_submissions", submissions: rows.results },
      evidence,
      proposals: [],
      auditSummary: {
        arguments: args,
        resultCount: rows.results.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeListReminderTemplates(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "list_reminder_templates";

    const args = parseArguments(name, encodedArguments, emptyArgumentsSchema);
    const rows = await this.env.DB.prepare(
      `SELECT version.id, version.template_id AS templateId, version.name,
              version.version_number AS versionNumber,
              version.subject_template AS subject
         FROM communication_template_versions version
         JOIN communication_templates template
           ON template.id = version.template_id
          AND template.event_id = version.event_id
         JOIN events event
           ON event.id = version.event_id AND event.organisation_id = ?
        WHERE version.event_id = ? AND version.category = 'task_reminder'
          AND version.channel = 'email' AND version.status = 'published'
          AND template.status = 'active'
        ORDER BY template.updated_at DESC, version.version_number DESC
        LIMIT 20`,
    )
      .bind(this.viewer.organisationId, this.viewer.eventId)
      .all<{
        id: string;
        templateId: string;
        name: string;
        versionNumber: number;
        subject: string;
      }>();
    const evidence = rows.results.map((template) => ({
      id: `communication-template-version:${template.id}`,
      label: template.name,
      detail: `Published task reminder v${template.versionNumber} · ${template.subject}`,
      href: `/admin/communications?template=${encodeURIComponent(template.templateId)}`,
      source: "Program Cue D1" as const,
    }));
    return {
      output: {
        source: "published_communication_templates",
        templates: rows.results,
        nextStep: rows.results.length
          ? "Use one returned version ID as baseTemplateVersionId when preparing a reminder-send preview."
          : "Create and publish a task-reminder template in Communications before preparing a send.",
      },
      evidence,
      proposals: [],
      auditSummary: {
        arguments: args,
        resultCount: rows.results.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeGetEvaluationSetup(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "get_evaluation_setup";

    const args = parseArguments(name, encodedArguments, emptyArgumentsSchema);
    const workspace = await new EvaluationService(this.env).getAdminWorkspace(
      this.viewer,
    );
    const plan = workspace.plan
      ? {
          id: workspace.plan.id,
          name: workspace.plan.name,
          status: workspace.plan.status,
          revision: workspace.plan.revision,
          decisionRole: workspace.plan.decisionRole,
          rounds: workspace.plan.rounds.map((round) => ({
            id: round.id,
            name: round.name,
            roundNumber: round.roundNumber,
            status: round.status,
            revision: round.revision,
            criteria: round.criteria.map((criterion) => ({
              id: criterion.id,
              name: criterion.name,
              description: criterion.description,
              inputType: criterion.inputType,
              weightPercent: criterion.weightPercent,
              required: criterion.required,
              position: criterion.position,
            })),
          })),
        }
      : null;
    const targets = {
      submissions: workspace.submissions.slice(0, 100).map((submission) => ({
        id: submission.id,
        reference: submission.reference,
        title: submission.title,
        status: submission.status,
      })),
      sessions: workspace.sessions.slice(0, 100).map((session) => ({
        id: session.id,
        reference: session.reference,
        title: session.title,
        status: session.status,
      })),
    };
    const evidence: AiEvidence[] = plan
      ? plan.rounds.map((round) => ({
          id: `evaluation-round:${round.id}`,
          label: round.name,
          detail: `${round.status} · revision ${round.revision} · ${round.criteria.length} criteria`,
          href: `/admin/review?round=${encodeURIComponent(round.id)}`,
          source: "Program Cue D1" as const,
        }))
      : [];
    return {
      output: {
        source: "allow_listed_evaluation_setup",
        plan,
        evaluators: workspace.evaluators.map((evaluator) => ({
          id: evaluator.id,
          name: evaluator.name,
          role: evaluator.role,
        })),
        teams: workspace.teams.map((team) => ({
          id: team.id,
          name: team.name,
          status: team.status,
          members: team.members
            .filter((member) => member.authorised)
            .map((member) => ({
              personId: member.personId,
              name: member.name,
              role: member.role,
            })),
        })),
        targets,
        truncated: {
          submissions:
            workspace.submissions.length > targets.submissions.length,
          sessions: workspace.sessions.length > targets.sessions.length,
        },
      },
      evidence,
      proposals: [],
      auditSummary: {
        arguments: args,
        roundCount: plan?.rounds.length ?? 0,
        evaluatorCount: workspace.evaluators.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeGetScheduleWorkspace(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "get_schedule_workspace";

    const args = parseArguments(name, encodedArguments, emptyArgumentsSchema);
    const workspace = await new ScheduleService(this.env).getWorkspace(
      this.viewer,
    );
    const sessions = workspace.sessions.slice(0, 200).map((session) => ({
      id: session.id,
      title: session.title,
      status: session.status,
      durationMinutes: session.durationMinutes,
      trackId: session.trackId,
      speakerIds: session.speakerIds,
      requiredResources: session.requiredResources,
    }));
    const entries = workspace.entries.slice(0, 300).map((entry) => ({
      id: entry.id,
      sessionId: entry.sessionId,
      roomId: entry.roomId,
      startsAt: entry.startsAt,
      endsAt: entry.endsAt,
      revision: entry.revision,
    }));
    const evidence: AiEvidence[] = workspace.version
      ? [
          {
            id: `schedule-version:${workspace.version.id}`,
            label: `${workspace.version.status} schedule v${workspace.version.versionNumber}`,
            detail: `Revision ${workspace.version.revision} · ${workspace.entries.length} entries`,
            href: "/admin/schedule",
            source: "Program Cue D1",
          },
        ]
      : [];
    return {
      output: {
        source: "authoritative_schedule_workspace",
        event: {
          id: workspace.event.id,
          startsAt: workspace.event.startsAt,
          endsAt: workspace.event.endsAt,
          timezone: workspace.event.timezone,
        },
        version: workspace.version,
        rooms: workspace.rooms.map((room) => ({
          id: room.id,
          name: room.name,
          capacity: room.capacity,
          resources: room.resources,
        })),
        sessions,
        entries,
        conflictCount: workspace.conflicts.length,
        truncated: {
          sessions: workspace.sessions.length > sessions.length,
          entries: workspace.entries.length > entries.length,
        },
      },
      evidence,
      proposals: [],
      auditSummary: {
        arguments: args,
        sessionCount: workspace.sessions.length,
        entryCount: workspace.entries.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeListFormDrafts(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "list_form_drafts";

    const args = parseArguments(name, encodedArguments, emptyArgumentsSchema);
    const rows = await this.env.DB.prepare(
      `SELECT form.id, form.name, form.status,
              form.public_slug AS publicSlug, form.revision AS formRevision,
              draft.id AS draftVersionId,
              draft.version_number AS draftVersionNumber,
              draft.revision AS draftRevision,
              json_array_length(json_extract(draft.schema_json, '$.fields')) AS fieldCount
         FROM form_definitions form
         JOIN events event
           ON event.id = form.event_id AND event.organisation_id = ?
         JOIN form_versions draft
           ON draft.form_id = form.id AND draft.event_id = form.event_id
          AND draft.status = 'draft'
        WHERE form.event_id = ? AND form.status <> 'archived'
        ORDER BY form.updated_at DESC, form.id
        LIMIT 50`,
    )
      .bind(this.viewer.organisationId, this.viewer.eventId)
      .all<{
        id: string;
        name: string;
        status: string;
        publicSlug: string;
        formRevision: number;
        draftVersionId: string;
        draftVersionNumber: number;
        draftRevision: number;
        fieldCount: number;
      }>();
    const evidence = rows.results.map((form) => ({
      id: `form:${form.id}`,
      label: form.name,
      detail: `Draft v${form.draftVersionNumber} · form revision ${form.formRevision} · draft revision ${form.draftRevision}`,
      href: "/admin/submissions/form",
      source: "Program Cue D1" as const,
    }));
    return {
      output: { source: "event_form_drafts", forms: rows.results },
      evidence,
      proposals: [],
      auditSummary: {
        arguments: args,
        resultCount: rows.results.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeGetAcceleventsExportStatus(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "get_accelevents_export_status";

    const args = parseArguments(name, encodedArguments, emptyArgumentsSchema);
    const workspace = await new IntegrationService(this.env).getWorkspace(
      this.viewer,
    );
    const evidence = workspace.connections.map((connection) => ({
      id: `integration:${connection.id}`,
      label: "Accelevents connection",
      detail: `${connection.status} · ${connection.direction}`,
      href: `/admin/integrations?connection=${encodeURIComponent(connection.id)}`,
      source: "Program Cue D1" as const,
    }));
    return {
      output: {
        source: "accelevents_integration_workspace",
        connections: workspace.connections.map((connection) => ({
          id: connection.id,
          provider: connection.provider,
          status: connection.status,
          direction: connection.direction,
          hasCredentials: connection.hasCredentials,
          configuration: connection.configuration,
        })),
        recentRuns: workspace.runs.slice(0, 10).map((run) => ({
          id: run.id,
          connectionId: run.connectionId,
          operationId: run.operationId,
          status: run.status,
          dryRun: run.dryRun,
          summary: run.summary,
        })),
      },
      evidence,
      proposals: [],
      auditSummary: {
        arguments: args,
        connectionCount: workspace.connections.length,
        runCount: workspace.runs.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  private async executeDraftReminder(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "draft_reminder";

    const args = parseArguments(
      name,
      encodedArguments,
      reminderDraftArgumentsSchema,
    );
    const cohort = await loadReminderCohort(this.env, this.viewer, args.cohort);
    const evidence: AiEvidence[] = [
      {
        id: `reminder-cohort:${args.cohort}`,
        label: args.cohort.replaceAll("_", " "),
        detail: `${cohort.count} recipient${cohort.count === 1 ? "" : "s"} with ${cohort.reason}`,
        href: cohort.href,
        source: "Program Cue D1",
      },
    ];
    return {
      output: {
        source: "deterministic_recipient_cohort",
        draftOnly: true,
        sent: false,
        cohort,
        draft: { subject: args.subject, body: args.body },
        nextStep:
          "Open Communications, review exact recipients and content, then use its normal confirmation flow if sending is intended.",
      },
      evidence,
      proposals: [],
      auditSummary: {
        arguments: args,
        recipientCount: cohort.count,
        sent: false,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }
}

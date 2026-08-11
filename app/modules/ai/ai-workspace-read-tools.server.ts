import { EvaluationService } from "~/modules/evaluations/evaluation-service.server";
import { IntegrationService } from "~/modules/integrations/integration-service.server";
import { ScheduleService } from "~/modules/schedule/schedule-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { emptyArgumentsSchema } from "./ai-tool-contracts.server";
import {
  AiToolPermissionError,
  type AiToolExecution,
} from "./ai-tool-execution";
import type { AiEvidence } from "./ai-types";
import { parseArguments } from "./ai-read-tool-shared.server";

export class AiWorkspaceReadTools {
  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly viewer: Viewer,
  ) {}

  execute(name: string, encodedArguments: string): Promise<AiToolExecution> {
    switch (name) {
      case "get_evaluation_setup":
        return this.executeGetEvaluationSetup(encodedArguments);
      case "get_schedule_workspace":
        return this.executeGetScheduleWorkspace(encodedArguments);
      case "get_accelevents_export_status":
        return this.executeGetAcceleventsExportStatus(encodedArguments);
      default:
        throw new AiToolPermissionError(
          `Tool ${name} is not a workspace read tool.`,
        );
    }
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
}

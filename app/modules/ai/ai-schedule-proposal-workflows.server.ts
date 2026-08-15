import {
  detectScheduleConflicts,
  type ScheduledItem,
} from "~/modules/schedule/schedule-rules";
import {
  schedulePlacementSchema,
  schedulePublishSchema,
} from "~/modules/schedule/schedule-schema";
import { ScheduleService } from "~/modules/schedule/schedule-service.server";
import { AiEvaluationProposalWorkflows } from "./ai-evaluation-proposal-workflows.server";
import {
  hashJson,
  parseArguments,
  persistDomainProposal,
} from "./ai-proposal-executor-foundation.server";
import {
  AiToolValidationError,
  type AiToolExecution,
} from "./ai-tool-execution";
import type { AiEvidence, AiProposalPreview } from "./ai-types";

export abstract class AiScheduleProposalWorkflows extends AiEvaluationProposalWorkflows {
  protected async executeProposeSchedulePlacement(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "propose_schedule_placement";

    const args = parseArguments(
      name,
      encodedArguments,
      schedulePlacementSchema,
    );
    const workspace = await new ScheduleService(this.env).getWorkspace(
      this.viewer,
    );
    if (
      !workspace.version ||
      workspace.version.id !== args.scheduleVersionId ||
      workspace.version.status !== "draft" ||
      workspace.version.revision !== args.scheduleRevision
    ) {
      throw new AiToolValidationError(
        "The proposed placement does not target the current draft schedule revision.",
      );
    }
    const session = workspace.sessions.find(
      (candidate) => candidate.id === args.sessionId,
    );
    const room = workspace.rooms.find(
      (candidate) => candidate.id === args.roomId,
    );
    if (!session || !room) {
      throw new AiToolValidationError(
        "The proposed session or room is not available in this event.",
      );
    }
    const currentEntry = workspace.entries.find(
      (entry) => entry.sessionId === session.id,
    );
    const sessionById = new Map(
      workspace.sessions.map((candidate) => [candidate.id, candidate]),
    );
    const existing: ScheduledItem[] = workspace.entries.map((entry) => {
      const scheduledSession = sessionById.get(entry.sessionId);
      if (!scheduledSession) {
        throw new Error(
          `Schedule entry ${entry.id} references an unavailable session.`,
        );
      }
      return {
        entryId: entry.id,
        sessionId: entry.sessionId,
        roomId: entry.roomId,
        startsAt: entry.startsAt,
        endsAt: entry.endsAt,
        trackId: scheduledSession.trackId,
        trackExclusive: scheduledSession.trackExclusive,
        speakerIds: scheduledSession.speakerIds,
        speakerNames: scheduledSession.speakerNames,
        requiredResources: scheduledSession.requiredResources,
        expectedAttendance: scheduledSession.expectedAttendance,
        title: scheduledSession.title,
      };
    });
    const conflicts = detectScheduleConflicts({
      candidate: {
        sessionId: session.id,
        title: session.title,
        roomId: room.id,
        startsAt: args.startsAt,
        endsAt: args.endsAt,
        trackId: session.trackId,
        trackExclusive: session.trackExclusive,
        speakerIds: session.speakerIds,
        speakerNames: session.speakerNames,
        requiredResources: session.requiredResources,
        expectedAttendance: session.expectedAttendance,
      },
      existing,
      rooms: workspace.rooms,
      eventStartsAt: workspace.event.startsAt,
      eventEndsAt: workspace.event.endsAt,
      eventTimezone: workspace.event.timezone,
      policies: workspace.policies,
      excludeEntryId: currentEntry?.id,
    });
    const blocking = conflicts.filter(
      (conflict) => conflict.severity === "blocking",
    );
    if (blocking.length) {
      throw new AiToolValidationError(
        `The proposed schedule placement is blocked: ${blocking.map((conflict) => conflict.message).join(" ")}`,
      );
    }
    const warnings = conflicts.filter(
      (conflict): conflict is typeof conflict & { severity: "warning" } =>
        conflict.severity === "warning",
    );
    const proposalId = crypto.randomUUID();
    const preview: AiProposalPreview = {
      id: proposalId,
      toolName: "propose_schedule_placement",
      title: `Place ${session.title}`,
      summary: `${currentEntry ? "Move" : "Place"} one session in ${room.name} from ${new Date(args.startsAt * 1_000).toISOString()} to ${new Date(args.endsAt * 1_000).toISOString()}.`,
      consequence:
        "Approval calls ScheduleService.place against the exact draft revision. The service re-runs every deterministic conflict rule, CASes the schedule/session records and returns its normal 30-second undo. This does not publish the schedule.",
      changes: [
        {
          field: "Room",
          before: currentEntry
            ? (workspace.rooms.find(
                (candidate) => candidate.id === currentEntry.roomId,
              )?.name ?? currentEntry.roomId)
            : null,
          after: room.name,
        },
        {
          field: "Starts",
          before: currentEntry
            ? new Date(currentEntry.startsAt * 1_000).toISOString()
            : null,
          after: new Date(args.startsAt * 1_000).toISOString(),
        },
        {
          field: "Ends",
          before: currentEntry
            ? new Date(currentEntry.endsAt * 1_000).toISOString()
            : null,
          after: new Date(args.endsAt * 1_000).toISOString(),
        },
        {
          field: "Warnings",
          before: null,
          after: warnings.length
            ? warnings.map((warning) => warning.message).join(" · ")
            : "No deterministic warnings",
        },
      ],
      affectedRecords: [
        {
          id: `session:${session.id}`,
          label: session.title,
          detail: `${session.durationMinutes} minutes · ${session.status}`,
          href: `/admin/schedule?session=${encodeURIComponent(session.id)}`,
        },
        {
          id: `room:${room.id}`,
          label: room.name,
          detail: `Capacity ${room.capacity}`,
          href: "/admin/schedule",
        },
      ],
      approvalRequired: true,
    };
    const snapshot = { input: args, warningConflicts: warnings };
    const persisted = await persistDomainProposal(this.env, this.viewer, {
      version: 1,
      toolName: "propose_schedule_placement",
      runId: this.runId,
      model: this.model,
      arguments: args,
      snapshot,
      preview,
    });
    const evidence: AiEvidence[] = [
      {
        id: `schedule-version:${workspace.version.id}`,
        label: `Draft schedule v${workspace.version.versionNumber}`,
        detail: `Revision ${workspace.version.revision} · ${warnings.length} placement warnings`,
        href: `/admin/schedule?session=${encodeURIComponent(session.id)}`,
        source: "Program Cue D1",
      },
    ];
    return {
      output: {
        source: "deterministic_schedule_placement_preview",
        proposalId,
        executed: false,
        warningCount: warnings.length,
        blockingCount: 0,
        approvalRequired: true,
      },
      evidence,
      proposals: [persisted],
      auditSummary: {
        arguments: args,
        proposalId,
        executed: false,
        warningCount: warnings.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  protected async executeProposeSchedulePublication(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "propose_schedule_publication";

    const args = parseArguments(name, encodedArguments, schedulePublishSchema);
    const workspace = await new ScheduleService(this.env).getWorkspace(
      this.viewer,
    );
    if (
      !workspace.version ||
      workspace.version.id !== args.scheduleVersionId ||
      workspace.version.status !== "draft" ||
      workspace.version.revision !== args.scheduleRevision
    ) {
      throw new AiToolValidationError(
        "The proposed publication does not target the current draft schedule revision.",
      );
    }
    const blockingConflicts = workspace.conflicts.filter(
      (conflict) => conflict.severity === "blocking",
    );
    if (blockingConflicts.length) {
      throw new AiToolValidationError(
        `The draft schedule has ${blockingConflicts.length} blocking conflict${blockingConflicts.length === 1 ? "" : "s"}. Resolve them before preparing a publication preview.`,
      );
    }
    const entriesHash = await hashJson(
      workspace.entries.map((entry) => ({
        id: entry.id,
        sessionId: entry.sessionId,
        roomId: entry.roomId,
        startsAt: entry.startsAt,
        endsAt: entry.endsAt,
        revision: entry.revision,
      })),
    );
    const snapshot = {
      scheduleVersionId: workspace.version.id,
      versionNumber: workspace.version.versionNumber,
      scheduleRevision: workspace.version.revision,
      entryCount: workspace.entries.length,
      unresolvedBlockingConflicts: 0,
      entriesHash,
    };
    const proposalId = crypto.randomUUID();
    const sessionById = new Map(
      workspace.sessions.map((session) => [session.id, session]),
    );
    const roomById = new Map(workspace.rooms.map((room) => [room.id, room]));
    const preview: AiProposalPreview = {
      id: proposalId,
      toolName: "propose_schedule_publication",
      title: `Publish schedule v${workspace.version.versionNumber}`,
      summary: `Publish ${workspace.entries.length} scheduled session${workspace.entries.length === 1 ? "" : "s"} with no recorded blocking conflicts.`,
      consequence:
        "Approval re-runs all publication-boundary conflict rules and CAS revision validation, publishes the schedule, exposes public programme data and queues calendar fan-out. Published changes are not presented as undoable.",
      changes: [
        {
          field: "Schedule status",
          before: "draft",
          after: "published",
        },
        {
          field: "Published sessions",
          before: null,
          after: `${workspace.entries.length}`,
        },
        {
          field: "Blocking conflicts",
          before: "0",
          after: "Revalidated at approval",
        },
        {
          field: "Calendar fan-out",
          before: null,
          after: "Queued background operation",
        },
      ],
      affectedRecords: workspace.entries.map((entry) => ({
        id: `schedule-entry:${entry.id}`,
        label: sessionById.get(entry.sessionId)?.title ?? entry.sessionId,
        detail: `${new Date(entry.startsAt * 1_000).toISOString()} · ${roomById.get(entry.roomId)?.name ?? entry.roomId}`,
        href: `/admin/schedule?session=${encodeURIComponent(entry.sessionId)}`,
      })),
      approvalRequired: true,
    };
    const persisted = await persistDomainProposal(this.env, this.viewer, {
      version: 1,
      toolName: "propose_schedule_publication",
      runId: this.runId,
      model: this.model,
      arguments: args,
      snapshot,
      preview,
    });
    const evidence: AiEvidence[] = [
      {
        id: `schedule-version:${workspace.version.id}`,
        label: `Draft schedule v${workspace.version.versionNumber}`,
        detail: `Revision ${workspace.version.revision} · ${workspace.entries.length} entries · no blocking conflicts`,
        href: "/admin/schedule",
        source: "Program Cue D1",
      },
    ];
    return {
      output: {
        source: "validated_schedule_publication_preview",
        proposalId,
        executed: false,
        entryCount: workspace.entries.length,
        blockingConflictCount: 0,
        approvalRequired: true,
      },
      evidence,
      proposals: [persisted],
      auditSummary: {
        arguments: args,
        proposalId,
        executed: false,
        entriesHash,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }
}

import type { z } from "zod";

import { AiProposalStateError } from "./ai-assistant-errors";
import type { assistantProposalMetadataSchema } from "./ai-tool-contracts.server";
import { CommunicationService } from "~/modules/communications/communication-service.server";
import { EvaluationService } from "~/modules/evaluations/evaluation-service.server";
import { IntegrationService } from "~/modules/integrations/integration-service.server";
import { ScheduleService } from "~/modules/schedule/schedule-service.server";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";

type AssistantProposalMetadata = z.infer<
  typeof assistantProposalMetadataSchema
>;
export type DomainProposalMetadata = Exclude<
  AssistantProposalMetadata,
  { toolName: "propose_reminder_send" } | { toolName: "propose_task" }
>;
type DomainProposalToolName = DomainProposalMetadata["toolName"];
type DomainProposalMetadataFor<TName extends DomainProposalToolName> = Extract<
  DomainProposalMetadata,
  { toolName: TName }
>;
type DomainProposalInput<TMetadata extends DomainProposalMetadata> = {
  proposalId: string;
  metadata: TMetadata;
  operationId: string;
};
export type ExecutedDomainProposal = {
  entityType: string;
  entityId: string;
  title: string;
  href: string;
  operationId: string | null;
  details: Record<string, unknown>;
};

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export class AiDomainProposalExecutor {
  constructor(private readonly env: CloudflareEnvironment) {}

  async execute(
    viewer: Viewer,
    input: DomainProposalInput<DomainProposalMetadata>,
  ): Promise<ExecutedDomainProposal> {
    const { metadata } = input;
    switch (metadata.toolName) {
      case "propose_form_draft":
        return this.prepareApprovedFormDraft(viewer, { ...input, metadata });
      case "propose_rubric_update":
        return this.prepareApprovedRubricUpdate(viewer, { ...input, metadata });
      case "propose_reviewer_assignment":
        return this.prepareApprovedReviewerAssignment(viewer, {
          ...input,
          metadata,
        });
      case "propose_email_template_draft":
        return this.prepareApprovedEmailTemplateDraft(viewer, {
          ...input,
          metadata,
        });
      case "propose_schedule_placement":
        return this.prepareApprovedSchedulePlacement(viewer, {
          ...input,
          metadata,
        });
      case "propose_form_publication":
        return this.prepareApprovedFormPublication(viewer, {
          ...input,
          metadata,
        });
      case "propose_schedule_publication":
        return this.prepareApprovedSchedulePublication(viewer, {
          ...input,
          metadata,
        });
      case "propose_accelevents_run":
        return this.prepareApprovedAcceleventsRun(viewer, {
          ...input,
          metadata,
        });
    }
  }

  private async prepareApprovedFormDraft(
    viewer: Viewer,
    input: DomainProposalInput<DomainProposalMetadataFor<"propose_form_draft">>,
  ): Promise<ExecutedDomainProposal> {
    const { proposalId, metadata, operationId } = input;
    const formId = await new SubmissionService(this.env).saveForm(
      viewer,
      metadata.snapshot,
      {
        operationId,
        formId: proposalId,
        versionId: `assistant-form-version:${proposalId}`,
        auditId: `assistant-form-audit:${proposalId}`,
      },
    );
    return {
      entityType: "form_definition",
      entityId: formId,
      title: metadata.preview.title,
      href: "/admin/submissions/form",
      operationId: null,
      details: { formId, published: false },
    };
  }

  private async prepareApprovedRubricUpdate(
    viewer: Viewer,
    input: DomainProposalInput<
      DomainProposalMetadataFor<"propose_rubric_update">
    >,
  ): Promise<ExecutedDomainProposal> {
    const { proposalId, metadata, operationId } = input;
    await new EvaluationService(this.env).updateDraftRound(
      viewer,
      metadata.snapshot,
      {
        operationId,
        auditId: `assistant-rubric-audit:${proposalId}`,
      },
    );
    return {
      entityType: "evaluation_round",
      entityId: metadata.snapshot.roundId,
      title: metadata.preview.title,
      href: `/admin/review?round=${encodeURIComponent(metadata.snapshot.roundId)}`,
      operationId: null,
      details: {
        roundId: metadata.snapshot.roundId,
        previousRevision: metadata.snapshot.revision,
        criterionCount: metadata.snapshot.criteria.length,
      },
    };
  }

  private async prepareApprovedReviewerAssignment(
    viewer: Viewer,
    input: DomainProposalInput<
      DomainProposalMetadataFor<"propose_reviewer_assignment">
    >,
  ): Promise<ExecutedDomainProposal> {
    const { metadata, operationId } = input;
    const evaluation = new EvaluationService(this.env);
    const assignmentInput = metadata.snapshot.input;
    const requestHash = await sha256(JSON.stringify(assignmentInput));
    const recordedAssignment = await this.env.DB.prepare(
      `SELECT status, request_hash AS requestHash
         FROM idempotency_records
        WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
          AND scope = 'evaluation.assign' AND idempotency_key = ?
          AND expires_at > unixepoch()`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        `assistant:${viewer.personId}`,
        operationId,
      )
      .first<{ status: string; requestHash: string }>();
    if (recordedAssignment?.status !== "completed") {
      const workspace = await evaluation.getAdminWorkspace(viewer);
      const currentEvaluatorIds = assignmentInput.teamId
        ? (workspace.teams
            .find(
              (team) =>
                team.id === assignmentInput.teamId && team.status === "active",
            )
            ?.members.filter((member) => member.authorised)
            .map((member) => member.personId) ?? [])
        : workspace.evaluators
            .filter((evaluator) =>
              assignmentInput.evaluatorPersonIds.includes(evaluator.id),
            )
            .map((evaluator) => evaluator.id);
      const expectedEvaluatorIds = [
        ...metadata.snapshot.resolvedEvaluatorPersonIds,
      ].sort();
      if (
        JSON.stringify([...new Set(currentEvaluatorIds)].sort()) !==
        JSON.stringify(expectedEvaluatorIds)
      ) {
        throw new AiProposalStateError(
          "The authorised reviewer set changed after preview. Prepare and inspect a fresh assignment preview.",
        );
      }
    } else if (recordedAssignment.requestHash !== requestHash) {
      throw new AiProposalStateError(
        "The durable reviewer-assignment operation does not match this proposal.",
      );
    }
    const result = await evaluation.assign(viewer, assignmentInput, {
      actorId: `assistant:${viewer.personId}`,
      idempotencyKey: operationId,
      requestHash,
    });
    return {
      entityType: "evaluation_round",
      entityId: assignmentInput.roundId,
      title: metadata.preview.title,
      href: `/admin/review?round=${encodeURIComponent(assignmentInput.roundId)}`,
      operationId: result.undoOperationId,
      details: {
        roundId: assignmentInput.roundId,
        createdAssignmentCount: result.createdAssignmentCount,
        requestedAssignmentCount: result.requestedAssignmentCount,
        undoOperationId: result.undoOperationId,
        undoExpiresAt: result.undoExpiresAt,
      },
    };
  }

  private async prepareApprovedEmailTemplateDraft(
    viewer: Viewer,
    input: DomainProposalInput<
      DomainProposalMetadataFor<"propose_email_template_draft">
    >,
  ): Promise<ExecutedDomainProposal> {
    const { proposalId, metadata, operationId } = input;
    const result = await new CommunicationService(this.env).saveTemplate(
      viewer,
      metadata.snapshot,
      {
        operationId,
        templateId: proposalId,
        versionId: `assistant-template-version:${proposalId}`,
        auditId: `assistant-template-audit:${proposalId}`,
      },
    );
    return {
      entityType: "communication_template",
      entityId: result.templateId,
      title: metadata.preview.title,
      href: `/admin/communications?template=${encodeURIComponent(result.templateId)}`,
      operationId: null,
      details: { ...result, published: false, sent: false },
    };
  }

  private async prepareApprovedSchedulePlacement(
    viewer: Viewer,
    input: DomainProposalInput<
      DomainProposalMetadataFor<"propose_schedule_placement">
    >,
  ): Promise<ExecutedDomainProposal> {
    const { metadata, operationId } = input;
    const result = await new ScheduleService(this.env).place(
      viewer,
      metadata.snapshot.input,
      {
        actorId: `assistant:${viewer.personId}`,
        idempotencyKey: operationId,
        requestHash: await sha256(JSON.stringify(metadata.snapshot.input)),
      },
    );
    return {
      entityType: "schedule_entry",
      entityId: result.entryId,
      title: metadata.preview.title,
      href: `/admin/schedule?session=${encodeURIComponent(metadata.snapshot.input.sessionId)}`,
      operationId: null,
      details: {
        entryId: result.entryId,
        warningCount: result.warnings.length,
        undoToken: result.undo.token,
        undoExpiresAt: result.undo.expiresAt,
      },
    };
  }

  private async prepareApprovedFormPublication(
    viewer: Viewer,
    input: DomainProposalInput<
      DomainProposalMetadataFor<"propose_form_publication">
    >,
  ): Promise<ExecutedDomainProposal> {
    const { proposalId, metadata, operationId } = input;
    const submissions = new SubmissionService(this.env);
    const recordedPublication = await this.env.DB.prepare(
      `SELECT form.id
         FROM form_definitions form
         JOIN events event
           ON event.id = form.event_id AND event.organisation_id = ?
        WHERE form.id = ? AND form.event_id = ?
          AND form.status = 'published' AND form.last_operation_id = ?`,
    )
      .bind(
        viewer.organisationId,
        metadata.snapshot.formId,
        viewer.eventId,
        operationId,
      )
      .first();
    if (!recordedPublication) {
      const current = await submissions.getAdminWorkspace(
        viewer,
        metadata.snapshot.formId,
      );
      if (!current) {
        throw new AiProposalStateError(
          "The form no longer exists in this event.",
        );
      }
      const currentSchemaHash = await sha256(
        JSON.stringify({
          schema: current.draftVersion.schema,
          routing: current.draftVersion.routing,
          settings: current.draftVersion.settings,
        }),
      );
      if (
        current.revision !== metadata.snapshot.formRevision ||
        current.draftVersion.revision !== metadata.snapshot.draftRevision ||
        current.draftVersion.id !== metadata.snapshot.draftVersionId ||
        currentSchemaHash !== metadata.snapshot.schemaHash
      ) {
        throw new AiProposalStateError(
          "The form draft changed after preview. Prepare and inspect a fresh publication preview.",
        );
      }
    }
    await submissions.publishForm(
      viewer,
      metadata.snapshot.formId,
      metadata.snapshot.formRevision,
      metadata.snapshot.draftRevision,
      {
        operationId,
        nextVersionId: `assistant-next-form-version:${proposalId}`,
        auditId: `assistant-form-publication-audit:${proposalId}`,
      },
    );
    return {
      entityType: "form_definition",
      entityId: metadata.snapshot.formId,
      title: metadata.preview.title,
      href: "/admin/submissions/form",
      operationId: null,
      details: {
        formId: metadata.snapshot.formId,
        publicPath: `/apply/${metadata.snapshot.publicSlug}`,
        published: true,
      },
    };
  }

  private async prepareApprovedSchedulePublication(
    viewer: Viewer,
    input: DomainProposalInput<
      DomainProposalMetadataFor<"propose_schedule_publication">
    >,
  ): Promise<ExecutedDomainProposal> {
    const { metadata, operationId } = input;
    const schedules = new ScheduleService(this.env);
    const scheduleActorId = `assistant:${viewer.personId}`;
    const requestHash = await sha256(JSON.stringify(metadata.arguments));
    const recordedPublication = await this.env.DB.prepare(
      `SELECT status, request_hash AS requestHash
         FROM idempotency_records
        WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
          AND scope = 'schedule.publish' AND idempotency_key = ?
          AND expires_at > unixepoch()`,
    )
      .bind(viewer.organisationId, viewer.eventId, scheduleActorId, operationId)
      .first<{ status: string; requestHash: string }>();
    if (recordedPublication?.status !== "completed") {
      const current = await schedules.getWorkspace(viewer);
      const currentEntriesHash = await sha256(
        JSON.stringify(
          current.entries.map((entry) => ({
            id: entry.id,
            sessionId: entry.sessionId,
            roomId: entry.roomId,
            startsAt: entry.startsAt,
            endsAt: entry.endsAt,
            revision: entry.revision,
          })),
        ),
      );
      if (
        !current.version ||
        current.version.id !== metadata.snapshot.scheduleVersionId ||
        current.version.status !== "draft" ||
        current.version.revision !== metadata.snapshot.scheduleRevision ||
        currentEntriesHash !== metadata.snapshot.entriesHash
      ) {
        throw new AiProposalStateError(
          "The draft schedule changed after preview. Prepare and inspect a fresh publication preview.",
        );
      }
    } else if (recordedPublication.requestHash !== requestHash) {
      throw new AiProposalStateError(
        "The durable schedule publication does not match this proposal.",
      );
    }
    const result = await schedules.publish(
      {
        organisationId: viewer.organisationId,
        eventId: viewer.eventId,
      },
      metadata.arguments,
      { actorId: scheduleActorId },
      {
        actorId: scheduleActorId,
        idempotencyKey: operationId,
        requestHash,
      },
    );
    return {
      entityType: "schedule_version",
      entityId: result.scheduleVersionId,
      title: metadata.preview.title,
      href: "/admin/schedule",
      operationId: result.calendar.operationId,
      details: {
        scheduleVersionId: result.scheduleVersionId,
        changeSequence: result.changeSequence,
        calendar: result.calendar,
      },
    };
  }

  private async prepareApprovedAcceleventsRun(
    viewer: Viewer,
    input: DomainProposalInput<
      DomainProposalMetadataFor<"propose_accelevents_run">
    >,
  ): Promise<ExecutedDomainProposal> {
    const { metadata, operationId } = input;
    const integrations = new IntegrationService(this.env);
    const previewFingerprint = metadata.snapshot.previewFingerprint;
    const recordedRun = await this.env.DB.prepare(
      `SELECT run.id
         FROM integration_runs run
         JOIN integration_connections connection
           ON connection.id = run.connection_id
        WHERE run.connection_id = ? AND run.idempotency_key = ?
          AND connection.event_id = ?
          AND connection.organisation_id = ?`,
    )
      .bind(
        metadata.snapshot.connectionId,
        operationId,
        viewer.eventId,
        viewer.organisationId,
      )
      .first();
    if (!recordedRun) {
      const current = await integrations.preview(
        viewer,
        metadata.snapshot.connectionId,
      );
      const currentPlanHash = await sha256(JSON.stringify(current.items));
      if (
        currentPlanHash !== metadata.snapshot.planHash ||
        current.previewFingerprint !== previewFingerprint
      ) {
        throw new AiProposalStateError(
          "The Accelevents export plan changed after preview. Prepare and inspect a fresh run preview.",
        );
      }
    }
    const result = await integrations.startRun(viewer, {
      ...metadata.arguments,
      idempotencyKey: operationId,
      previewFingerprint,
    });
    if (!result.operationId) {
      throw new Error(
        "The approved Accelevents run did not resolve a durable operation.",
      );
    }
    return {
      entityType: "integration_run",
      entityId: result.runId,
      title: metadata.preview.title,
      href: `/admin/operations?operation=${encodeURIComponent(result.operationId)}`,
      operationId: result.operationId,
      details: {
        runId: result.runId,
        operationId: result.operationId,
        queued: result.queued,
        replayed: result.replayed,
        dryRun: metadata.arguments.dryRun,
      },
    };
  }
}

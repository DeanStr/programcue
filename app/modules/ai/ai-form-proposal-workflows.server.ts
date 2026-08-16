import {
  type SaveFormInput,
  saveFormSchema,
} from "~/modules/submissions/submission-schema";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import { AiCommunicationProposalWorkflows } from "./ai-communication-proposal-workflows.server";
import {
  hashJson,
  parseArguments,
  persistDomainProposal,
} from "./ai-proposal-executor-foundation.server";
import {
  formDraftProposalArgumentsSchema,
  formPublicationProposalArgumentsSchema,
} from "./ai-tool-contracts.server";
import {
  type AiToolExecution,
  AiToolValidationError,
} from "./ai-tool-execution";
import type { AiEvidence, AiProposalPreview } from "./ai-types";

export abstract class AiFormProposalWorkflows extends AiCommunicationProposalWorkflows {
  protected async executeProposeFormDraft(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "propose_form_draft";

    const args = parseArguments(
      name,
      encodedArguments,
      formDraftProposalArgumentsSchema,
    );
    const submissions = new SubmissionService(this.env);
    const [defaults, existingForms] = await Promise.all([
      submissions.getDefaultFormInput(this.viewer),
      submissions.listAdminForms(this.viewer),
    ]);
    if (existingForms.some((form) => form.publicSlug === args.publicSlug)) {
      throw new AiToolValidationError(
        "A form with this public slug already exists in the current event.",
      );
    }
    const snapshot: SaveFormInput = saveFormSchema.parse({
      ...defaults,
      ...args,
    });
    const proposalId = crypto.randomUUID();
    const preview: AiProposalPreview = {
      id: proposalId,
      toolName: "propose_form_draft",
      title: snapshot.name,
      summary: `Create one editable ${snapshot.kind.replaceAll("_", " ")} form draft with ${snapshot.schema.fields.length} default fields.`,
      consequence:
        "Approval saves one D1-backed form draft through the normal submission service. It does not publish the form or accept applications.",
      changes: [
        { field: "Form", before: null, after: snapshot.name },
        { field: "Public slug", before: null, after: snapshot.publicSlug },
        {
          field: "Close date",
          before: null,
          after: snapshot.closeDate ?? "No close date",
        },
        {
          field: "Speaker limits",
          before: null,
          after: `${snapshot.minSpeakers}–${snapshot.maxSpeakers ?? "unlimited"}`,
        },
        {
          field: "Access",
          before: null,
          after: snapshot.accessMode.replaceAll("_", " "),
        },
      ],
      affectedRecords: snapshot.schema.fields.map((field) => ({
        id: `form-field:${field.id}`,
        label: field.label,
        detail: `${field.type.replaceAll("_", " ")}${field.required ? " · required" : " · optional"}`,
        href: "/admin/submissions/form",
      })),
      approvalRequired: true,
    };
    const persisted = await persistDomainProposal(this.env, this.viewer, {
      version: 1,
      toolName: "propose_form_draft",
      runId: this.runId,
      model: this.model,
      arguments: args,
      snapshot,
      preview,
    });
    const evidence: AiEvidence[] = [
      {
        id: `event:${this.viewer.eventId}`,
        label: "Current event form configuration",
        detail: `Default ${snapshot.accessMode.replaceAll("_", " ")} access · ${snapshot.schema.fields.length} fields`,
        href: "/admin/submissions/form",
        source: "Program Cue D1",
      },
    ];
    return {
      output: {
        source: "validated_form_draft_preview",
        proposalId,
        executed: false,
        published: false,
        fieldCount: snapshot.schema.fields.length,
        approvalRequired: true,
      },
      evidence,
      proposals: [persisted],
      auditSummary: {
        arguments: args,
        proposalId,
        executed: false,
        fieldCount: snapshot.schema.fields.length,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }

  protected async executeProposeFormPublication(
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    const name = "propose_form_publication";

    const args = parseArguments(
      name,
      encodedArguments,
      formPublicationProposalArgumentsSchema,
    );
    const workspace = await new SubmissionService(this.env).getAdminWorkspace(
      this.viewer,
      args.formId,
    );
    if (!workspace) {
      throw new AiToolValidationError(
        "The proposed form publication target was not found in this event.",
      );
    }
    if (
      workspace.revision !== args.formRevision ||
      workspace.draftVersion.revision !== args.draftRevision
    ) {
      throw new AiToolValidationError(
        "The form or its draft changed. Inspect current revisions and prepare a fresh publication preview.",
      );
    }
    const schemaHash = await hashJson({
      schema: workspace.draftVersion.schema,
      routing: workspace.draftVersion.routing,
      settings: workspace.draftVersion.settings,
    });
    const snapshot = {
      formId: workspace.id,
      name: workspace.name,
      publicSlug: workspace.publicSlug,
      status: workspace.status,
      formRevision: workspace.revision,
      draftRevision: workspace.draftVersion.revision,
      draftVersionId: workspace.draftVersion.id,
      fieldCount: workspace.draftVersion.schema.fields.length,
      schemaHash,
    };
    const proposalId = crypto.randomUUID();
    const preview: AiProposalPreview = {
      id: proposalId,
      toolName: "propose_form_publication",
      title: `Publish ${workspace.name}`,
      summary: `Publish draft version ${workspace.draftVersion.versionNumber} with ${snapshot.fieldCount} fields at /apply/${workspace.publicSlug}.`,
      consequence:
        "Approval makes this form draft publicly available through the normal form publication CAS boundary. Applicants may immediately see it; publication is consequential and is not treated as undoable.",
      changes: [
        {
          field: "Form status",
          before: workspace.status,
          after: "published",
        },
        {
          field: "Published version",
          before: workspace.publishedVersion
            ? `${workspace.publishedVersion.versionNumber}`
            : null,
          after: `${workspace.draftVersion.versionNumber}`,
        },
        {
          field: "Public path",
          before: workspace.publishedVersion
            ? `/apply/${workspace.publicSlug}`
            : null,
          after: `/apply/${workspace.publicSlug}`,
        },
      ],
      affectedRecords: workspace.draftVersion.schema.fields.map((field) => ({
        id: `form-field:${field.id}`,
        label: field.label,
        detail: `${field.type.replaceAll("_", " ")}${field.required ? " · required" : ""}`,
        href: "/admin/submissions/form",
      })),
      approvalRequired: true,
    };
    const persisted = await persistDomainProposal(this.env, this.viewer, {
      version: 1,
      toolName: "propose_form_publication",
      runId: this.runId,
      model: this.model,
      arguments: args,
      snapshot,
      preview,
    });
    const evidence: AiEvidence[] = [
      {
        id: `form:${workspace.id}`,
        label: workspace.name,
        detail: `Draft version ${workspace.draftVersion.versionNumber} · revision ${workspace.draftVersion.revision}`,
        href: "/admin/submissions/form",
        source: "Program Cue D1",
      },
    ];
    return {
      output: {
        source: "validated_form_publication_preview",
        proposalId,
        executed: false,
        formRevision: workspace.revision,
        draftRevision: workspace.draftVersion.revision,
        fieldCount: snapshot.fieldCount,
        approvalRequired: true,
      },
      evidence,
      proposals: [persisted],
      auditSummary: {
        arguments: args,
        proposalId,
        executed: false,
        schemaHash,
        evidenceIds: evidence.map((item) => item.id),
      },
    };
  }
}

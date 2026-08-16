import type { z } from "zod";
import {
  assertMergeAudienceCompatible,
  type CommunicationPreview,
} from "~/modules/communications/communication-service-shared";
import { CommunicationService } from "~/modules/communications/communication-service.server";
import {
  renderMergeTemplate,
  representativeMergeValues,
} from "~/modules/communications/merge-template";
import { apiTaskCreateSchema } from "~/platform/api/api-task-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  adminRoles,
  assistantProposalMetadataSchema,
  reminderSendProposalArgumentsSchema,
  type taskProposalArgumentsSchema,
} from "./ai-tool-contracts.server";
import {
  AiToolPermissionError,
  AiToolValidationError,
} from "./ai-tool-execution";
import type { AiEvidence, AiProposalPreview } from "./ai-types";

export function parseArguments<T>(
  name: string,
  value: string,
  schema: z.ZodType<T>,
) {
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

export async function hashJson(value: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function persistDomainProposal(
  env: CloudflareEnvironment,
  viewer: Viewer,
  rawMetadata: unknown,
) {
  const metadata = assistantProposalMetadataSchema.parse(rawMetadata);
  if (
    metadata.toolName === "propose_task" ||
    metadata.toolName === "propose_reminder_send"
  ) {
    throw new Error(
      `Domain proposal persistence does not accept ${metadata.toolName}.`,
    );
  }
  await env.DB.prepare(
    `INSERT INTO audit_events (
      id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, actor_id, action,
      entity_type, entity_id, correlation_id, metadata_json, created_at
    ) VALUES (?, 'agent', 'admin_ui', 1, ?, ?, ?, 'program_cue_agent', 'assistant.proposal.previewed',
              'assistant_proposal', ?, ?, ?, unixepoch())`,
  )
    .bind(
      crypto.randomUUID(),
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      metadata.preview.id,
      metadata.runId,
      JSON.stringify(metadata),
    )
    .run();
  return metadata.preview as AiProposalPreview;
}

export async function requireTargetLabel(
  env: CloudflareEnvironment,
  viewer: Viewer,
  targetType: "speaker" | "session" | "event",
  targetId: string,
) {
  if (targetType === "event") {
    const event = await env.DB.prepare(
      "SELECT name FROM events WHERE id = ? AND organisation_id = ?",
    )
      .bind(targetId, viewer.organisationId)
      .first<{ name: string }>();
    if (!event || targetId !== viewer.eventId) {
      throw new AiToolValidationError(
        "The proposed task target is not the authorised event.",
      );
    }
    return event.name;
  }
  if (targetType === "session") {
    const session = await env.DB.prepare(
      `SELECT s.title FROM sessions s
        JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
       WHERE s.id = ? AND s.event_id = ?`,
    )
      .bind(viewer.organisationId, targetId, viewer.eventId)
      .first<{ title: string }>();
    if (!session)
      throw new AiToolValidationError(
        "The proposed session task target is not available in this event.",
      );
    return session.title;
  }
  const speaker = await env.DB.prepare(
    `SELECT p.display_name AS name
       FROM people p
       JOIN events event ON event.id = ? AND event.organisation_id = ?
      WHERE p.id = ? AND (
        EXISTS (SELECT 1 FROM memberships m
                 WHERE m.person_id = p.id AND m.event_id = event.id
                   AND m.role = 'speaker' AND m.accepted_at IS NOT NULL
                   AND m.revoked_at IS NULL)
        OR EXISTS (SELECT 1 FROM session_speakers ss
                    WHERE ss.person_id = p.id AND ss.event_id = event.id)
      )`,
  )
    .bind(viewer.eventId, viewer.organisationId, targetId)
    .first<{ name: string }>();
  if (!speaker)
    throw new AiToolValidationError(
      "The proposed speaker task target is not available in this event.",
    );
  return speaker.name;
}

export async function validateTaskReferences(
  env: CloudflareEnvironment,
  viewer: Viewer,
  input: z.infer<typeof taskProposalArgumentsSchema>,
) {
  apiTaskCreateSchema.parse(input);
  const targetLabel = await requireTargetLabel(
    env,
    viewer,
    input.targetType,
    input.targetId,
  );
  if (input.ownerPersonId) {
    const owner = await env.DB.prepare(
      `SELECT p.display_name AS name FROM people p
        JOIN events event ON event.id = ? AND event.organisation_id = ?
        WHERE p.id = ? AND (
          EXISTS (SELECT 1 FROM memberships m
                   WHERE m.person_id = p.id AND m.event_id = event.id
                     AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL)
          OR EXISTS (SELECT 1 FROM session_speakers ss
                      WHERE ss.person_id = p.id AND ss.event_id = event.id)
        )`,
    )
      .bind(viewer.eventId, viewer.organisationId, input.ownerPersonId)
      .first<{ name: string }>();
    if (!owner)
      throw new AiToolValidationError(
        "The proposed task owner is not available in this event.",
      );
  }
  if (input.dependencyIds.length) {
    const dependencies = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM task_instances task
        JOIN events event ON event.id = task.event_id AND event.organisation_id = ?
       WHERE task.event_id = ?
         AND task.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        JSON.stringify(input.dependencyIds),
      )
      .first<{ count: number }>();
    if (Number(dependencies?.count ?? 0) !== input.dependencyIds.length) {
      throw new AiToolValidationError(
        "One or more proposed task dependencies are not available in this event.",
      );
    }
  }
  return targetLabel;
}

export function assertReminderDeliveryReady(preview: CommunicationPreview) {
  if (preview.template.category !== "task_reminder") {
    throw new AiToolValidationError(
      "The selected base template is not a task-reminder template.",
    );
  }
  if (preview.template.versionStatus !== "published") {
    throw new AiToolValidationError(
      "The selected base reminder template is not published. Publish it in Communications before preparing a send.",
    );
  }
  if (!preview.provider.configured || !preview.provider.sender) {
    throw new AiToolValidationError(
      "A verified sender and configured email provider are required before preparing an assistant reminder send.",
    );
  }
  if (!preview.provider.queueConfigured) {
    throw new AiToolValidationError(
      "The OPERATIONS_QUEUE binding is required before preparing an assistant reminder send.",
    );
  }
  if (!preview.recipients.deliverable.length) {
    throw new AiToolValidationError(
      "The selected reminder audience has no deliverable recipients.",
    );
  }
}

export async function prepareReminderSendProposal(
  env: CloudflareEnvironment,
  viewer: Viewer,
  input: {
    runId: string;
    model: string;
    arguments: z.infer<typeof reminderSendProposalArgumentsSchema>;
    templateId?: string;
  },
) {
  if (!adminRoles.has(viewer.role)) throw new AiToolPermissionError();
  const args = reminderSendProposalArgumentsSchema.parse(input.arguments);
  const communications = new CommunicationService(env);
  const deliveryInput = {
    templateVersionId: args.baseTemplateVersionId,
    audienceType: args.audienceType,
    manualRecipients: "",
    kind: args.kind,
  } as const;
  const basePreview = await communications.preview(viewer, deliveryInput);
  assertReminderDeliveryReady(basePreview);

  const content = { ...basePreview.template.content, body: args.body };
  const candidateTemplate = {
    category: "task_reminder" as const,
    subject: args.subject,
    content,
  };
  assertMergeAudienceCompatible(candidateTemplate, args.audienceType);
  // Reject unknown merge variables before a durable draft version is created.
  renderMergeTemplate(args.subject, representativeMergeValues);
  renderMergeTemplate(args.body, representativeMergeValues);

  const saved = await communications.saveTemplate(viewer, {
    ...(input.templateId ? { templateId: input.templateId } : {}),
    name: `Assistant reminder · ${args.subject.slice(0, 120)}`,
    category: "task_reminder",
    subject: args.subject,
    content,
  });
  const previewInput = {
    ...deliveryInput,
    templateVersionId: saved.versionId,
  };
  const exactPreview = await communications.preview(viewer, previewInput);
  if (
    !exactPreview.provider.configured ||
    !exactPreview.provider.sender ||
    !exactPreview.provider.queueConfigured
  ) {
    throw new AiToolValidationError(
      "The configured reminder delivery boundary became unavailable while preparing the preview.",
    );
  }
  if (!exactPreview.recipients.deliverable.length) {
    throw new AiToolValidationError(
      "The selected reminder audience no longer has deliverable recipients.",
    );
  }

  const proposalId = crypto.randomUUID();
  const reminder = {
    template: {
      id: exactPreview.template.id,
      templateId: exactPreview.template.templateId,
      name: exactPreview.template.name,
      category: "task_reminder" as const,
      versionNumber: exactPreview.template.versionNumber,
      versionStatus: "draft" as const,
      subject: exactPreview.template.subject,
      content: exactPreview.template.content,
    },
    audienceType: args.audienceType,
    kind: args.kind,
    recipients: exactPreview.recipients,
    confirmation: exactPreview.confirmation,
    rendered: {
      subject: exactPreview.rendered.subject,
      text: exactPreview.rendered.text,
    },
    provider: {
      configured: true as const,
      sender: exactPreview.provider.sender,
      queueConfigured: true as const,
    },
  };
  const preview: AiProposalPreview = {
    id: proposalId,
    toolName: "propose_reminder_send",
    title: args.subject,
    summary: `Queue one ${args.kind} reminder to ${reminder.recipients.deliverable.length} deliverable ${args.audienceType.replaceAll("_", " ")} recipient${reminder.recipients.deliverable.length === 1 ? "" : "s"}.`,
    consequence:
      "Approval publishes this immutable assistant-created template version, records the exact communication and queues delivery through the normal provider operation. Sending cannot be undone. Newly suppressed recipients are skipped; any other audience change requires a fresh preview.",
    changes: [
      { field: "Subject", before: null, after: args.subject },
      {
        field: "Audience",
        before: null,
        after: `${reminder.recipients.deliverable.length} deliverable · ${reminder.recipients.suppressed.length} suppressed · ${reminder.recipients.invalid.length} invalid`,
      },
      {
        field: "Sender",
        before: null,
        after: reminder.provider.sender,
      },
      {
        field: "Delivery",
        before: null,
        after: "Queued background communication operation",
      },
    ],
    approvalRequired: true,
    reminder,
  };
  const metadata = assistantProposalMetadataSchema.parse({
    version: 1,
    toolName: "propose_reminder_send",
    runId: input.runId,
    model: input.model,
    arguments: args,
    preview,
  });
  await env.DB.prepare(
    `INSERT INTO audit_events (
      id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, actor_id, action,
      entity_type, entity_id, correlation_id, metadata_json, created_at
    ) VALUES (?, 'agent', 'admin_ui', 1, ?, ?, ?, 'program_cue_agent', 'assistant.proposal.previewed',
              'assistant_proposal', ?, ?, ?, unixepoch())`,
  )
    .bind(
      crypto.randomUUID(),
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      proposalId,
      input.runId,
      JSON.stringify(metadata),
    )
    .run();
  const evidence: AiEvidence[] = [
    {
      id: `communication-template-version:${saved.versionId}`,
      label: exactPreview.template.name,
      detail: `Draft reminder template version ${saved.versionNumber}`,
      href: `/admin/communications?template=${encodeURIComponent(saved.templateId)}`,
      source: "Program Cue D1",
    },
    {
      id: `reminder-audience:${args.audienceType}`,
      label: args.audienceType.replaceAll("_", " "),
      detail: `${exactPreview.recipients.deliverable.length} deliverable · ${exactPreview.recipients.suppressed.length} suppressed · ${exactPreview.recipients.invalid.length} invalid`,
      href: "/admin/communications",
      source: "Program Cue D1",
    },
  ];
  return { preview, metadata, evidence };
}

export abstract class AiProposalExecutorFoundation {
  constructor(
    protected readonly env: CloudflareEnvironment,
    protected readonly viewer: Viewer,
    protected readonly runId: string,
    protected readonly model: string,
  ) {}
}

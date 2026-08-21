import type { z } from "zod";
import { CommunicationService } from "~/modules/communications/communication-service.server";
import {
  assertMergeAudienceCompatible,
  type CommunicationPreview,
} from "~/modules/communications/communication-service-shared";
import {
  findUnresolvedTemplateContent,
  renderMergeTemplate,
  representativeMergeValues,
  unresolvedTemplateTokenMessage,
} from "~/modules/communications/merge-template";
import { apiTaskCreateSchema } from "~/platform/api/api-task-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  atomicBatchGuardStatement,
  isAtomicBatchGuardError,
} from "~/platform/database/atomic-batch-guard.server";
import type { AiOperationAtomicMutation } from "./ai-operation-lease.server";
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
                    WHERE ss.person_id = p.id AND ss.event_id = event.id
                      AND ss.participation_status IN ('pending','confirmed'))
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
    const owner =
      input.targetType === "session"
        ? await env.DB.prepare(
            `SELECT p.display_name AS name FROM people p
              JOIN events event ON event.id = ? AND event.organisation_id = ?
              JOIN session_speakers ss
                ON ss.event_id = event.id AND ss.session_id = ?
               AND ss.person_id = p.id
               AND ss.participation_status IN ('pending','confirmed')
             WHERE p.id = ?`,
          )
            .bind(
              viewer.eventId,
              viewer.organisationId,
              input.targetId,
              input.ownerPersonId,
            )
            .first<{ name: string }>()
        : await env.DB.prepare(
            `SELECT p.display_name AS name FROM people p
              JOIN events event ON event.id = ? AND event.organisation_id = ?
             WHERE p.id = ? AND (
               EXISTS (SELECT 1 FROM memberships m
                        WHERE m.person_id = p.id AND m.event_id = event.id
                          AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL)
               OR EXISTS (SELECT 1 FROM session_speakers ss
                           WHERE ss.person_id = p.id AND ss.event_id = event.id
                             AND ss.participation_status IN ('pending','confirmed'))
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

export type StagedReminderSendProposal = {
  preview: AiProposalPreview & { toolName: "propose_reminder_send" };
  metadata: z.infer<typeof assistantProposalMetadataSchema>;
  evidence: AiEvidence[];
  mutation: AiOperationAtomicMutation;
};

export async function stageReminderSendProposal(
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
  const unresolved = findUnresolvedTemplateContent({
    subject: args.subject,
    body: args.body,
  });
  if (unresolved) {
    throw new AiToolValidationError(unresolvedTemplateTokenMessage(unresolved));
  }
  // Reject unknown merge variables before a durable draft version is created.
  renderMergeTemplate(args.subject, representativeMergeValues);
  renderMergeTemplate(args.body, representativeMergeValues);

  const name = `Assistant reminder · ${args.subject.slice(0, 120)}`;
  const templateId = input.templateId ?? crypto.randomUUID();
  const existing = input.templateId
    ? await env.DB.prepare(
        `SELECT template.status,
                COALESCE(MAX(version.version_number), 0) + 1 AS versionNumber
           FROM communication_templates template
           JOIN events event
             ON event.id = template.event_id AND event.organisation_id = ?
           LEFT JOIN communication_template_versions version
             ON version.template_id = template.id
            AND version.event_id = template.event_id
            AND version.channel = 'email'
          WHERE template.id = ? AND template.event_id = ?
            AND template.status <> 'archived'
          GROUP BY template.id`,
      )
        .bind(viewer.organisationId, templateId, viewer.eventId)
        .first<{ status: "draft" | "active"; versionNumber: number }>()
    : null;
  if (input.templateId && !existing) {
    throw new AiToolValidationError(
      "The assistant reminder template is no longer available in this event.",
    );
  }
  const versionId = crypto.randomUUID();
  const versionNumber = existing?.versionNumber ?? 1;
  const candidate = {
    id: versionId,
    templateId,
    name,
    category: "task_reminder" as const,
    templateStatus: existing?.status ?? ("draft" as const),
    versionNumber,
    subject: args.subject,
    content,
    versionStatus: "draft" as const,
    publishedAt: null,
  };
  const previewInput = {
    ...deliveryInput,
    templateVersionId: versionId,
  };
  const exactPreview = await communications.previewCandidate(
    viewer,
    previewInput,
    candidate,
  );
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
  const saveOperationId = crypto.randomUUID();
  const versionAuditId = crypto.randomUUID();
  const proposalAuditId = crypto.randomUUID();
  const contentJson = JSON.stringify(content);
  const metadataJson = JSON.stringify(metadata);
  const mutation: AiOperationAtomicMutation = {
    statements: [
      env.DB.prepare(
        `INSERT INTO communication_templates (
           id, event_id, name, category, status, last_operation_id,
           created_by_person_id, created_at, updated_at
         )
         SELECT ?, event.id, ?, 'task_reminder', 'draft', ?, ?,
                unixepoch(), unixepoch()
           FROM events event
          WHERE event.id = ? AND event.organisation_id = ?
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, category = excluded.category,
           last_operation_id = excluded.last_operation_id,
           updated_at = unixepoch()
         WHERE communication_templates.event_id = excluded.event_id
           AND communication_templates.status <> 'archived'`,
      ).bind(
        templateId,
        name,
        saveOperationId,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
      ),
      env.DB.prepare(
        `INSERT INTO communication_template_versions (
           id, event_id, template_id, version_number, name, category,
           channel, subject_template, content_json, rendered_preview_html,
           status, created_by_person_id, created_at
         )
         SELECT ?, template.event_id, template.id, ?, ?, 'task_reminder',
                'email', ?, ?, ?, 'draft', ?, unixepoch()
           FROM communication_templates template
          WHERE template.id = ? AND template.event_id = ?
            AND template.status <> 'archived'
            AND template.last_operation_id = ?
            AND ? = COALESCE((
              SELECT MAX(existing.version_number) + 1
                FROM communication_template_versions existing
               WHERE existing.template_id = template.id
                 AND existing.channel = 'email'
            ), 1)`,
      ).bind(
        versionId,
        versionNumber,
        name,
        args.subject,
        contentJson,
        exactPreview.rendered.html,
        viewer.personId,
        templateId,
        viewer.eventId,
        saveOperationId,
        versionNumber,
      ),
      env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id,
           event_id, actor_person_id, action, entity_type, entity_id,
           metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, version.event_id, ?,
                'communication.template.version.created',
                'communication_template', version.template_id,
                json_object(
                  'versionId', version.id,
                  'versionNumber', version.version_number,
                  'category', version.category
                ), unixepoch()
           FROM communication_template_versions version
          WHERE version.id = ? AND version.event_id = ?
            AND version.template_id = ?`,
      ).bind(
        versionAuditId,
        viewer.organisationId,
        viewer.personId,
        versionId,
        viewer.eventId,
        templateId,
      ),
      env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id,
           event_id, actor_person_id, actor_id, action, entity_type,
           entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, 'agent', 'admin_ui', 1, ?, version.event_id, ?,
                'program_cue_agent', 'assistant.proposal.previewed',
                'assistant_proposal', ?, ?, ?, unixepoch()
           FROM communication_template_versions version
          WHERE version.id = ? AND version.event_id = ?
            AND version.template_id = ?
            AND EXISTS (
              SELECT 1 FROM audit_events audit WHERE audit.id = ?
            )`,
      ).bind(
        proposalAuditId,
        viewer.organisationId,
        viewer.personId,
        proposalId,
        input.runId,
        metadataJson,
        versionId,
        viewer.eventId,
        templateId,
        versionAuditId,
      ),
    ],
    failurePredicateSql: `NOT EXISTS (
       SELECT 1 FROM communication_template_versions version
        WHERE version.id = ? AND version.event_id = ?
          AND version.template_id = ? AND version.version_number = ?
          AND version.subject_template = ? AND version.content_json = ?
     ) OR NOT EXISTS (
       SELECT 1 FROM audit_events audit WHERE audit.id = ?
     ) OR NOT EXISTS (
       SELECT 1 FROM audit_events audit WHERE audit.id = ?
     )`,
    bindings: [
      versionId,
      viewer.eventId,
      templateId,
      versionNumber,
      args.subject,
      contentJson,
      versionAuditId,
      proposalAuditId,
    ],
  };
  const evidence: AiEvidence[] = [
    {
      id: `communication-template-version:${versionId}`,
      label: exactPreview.template.name,
      detail: `Draft reminder template version ${versionNumber}`,
      href: `/admin/communications?template=${encodeURIComponent(templateId)}`,
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
  return { preview, metadata, evidence, mutation };
}

export async function persistStagedReminderSendProposal(
  env: CloudflareEnvironment,
  staged: StagedReminderSendProposal,
) {
  try {
    await env.DB.batch([
      ...staged.mutation.statements,
      atomicBatchGuardStatement(
        env,
        staged.mutation.failurePredicateSql,
        staged.mutation.bindings,
      ),
    ]);
  } catch (error) {
    if (isAtomicBatchGuardError(error)) {
      throw new AiToolValidationError(
        "The reminder template changed while its assistant preview was being prepared. Generate a fresh preview.",
      );
    }
    throw error;
  }
}

export async function prepareReminderSendProposal(
  env: CloudflareEnvironment,
  viewer: Viewer,
  input: Parameters<typeof stageReminderSendProposal>[2],
) {
  const staged = await stageReminderSendProposal(env, viewer, input);
  await persistStagedReminderSendProposal(env, staged);
  const { mutation: _mutation, ...result } = staged;
  return result;
}

export abstract class AiProposalExecutorFoundation {
  constructor(
    protected readonly env: CloudflareEnvironment,
    protected readonly viewer: Viewer,
    protected readonly runId: string,
    protected readonly model: string,
  ) {}
}

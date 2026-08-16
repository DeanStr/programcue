import type { Viewer } from "~/platform/auth/authorize.server";
import {
  likePattern,
  loadReminderCohort,
  parseArguments,
} from "./ai-read-tool-shared.server";
import {
  emptyArgumentsSchema,
  reminderDraftArgumentsSchema,
  submissionSearchSchema,
} from "./ai-tool-contracts.server";
import {
  type AiToolExecution,
  AiToolPermissionError,
} from "./ai-tool-execution";
import type { AiEvidence } from "./ai-types";

export class AiContentReadTools {
  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly viewer: Viewer,
  ) {}

  execute(name: string, encodedArguments: string): Promise<AiToolExecution> {
    switch (name) {
      case "search_submissions":
        return this.executeSearchSubmissions(encodedArguments);
      case "list_reminder_templates":
        return this.executeListReminderTemplates(encodedArguments);
      case "list_form_drafts":
        return this.executeListFormDrafts(encodedArguments);
      case "draft_reminder":
        return this.executeDraftReminder(encodedArguments);
      default:
        throw new AiToolPermissionError(
          `Tool ${name} is not a content read tool.`,
        );
    }
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
          OR (
            s.status = 'draft'
            AND COALESCE(s.category, '') LIKE ? ESCAPE '\\'
          )
          OR EXISTS (
            SELECT 1 FROM submission_track_selections selection
             WHERE selection.submission_id = s.id
               AND selection.event_id = s.event_id
               AND selection.track_name_snapshot LIKE ? ESCAPE '\\'
          )
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

import { Eye, FilePenLine, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useNavigation,
  useSubmit,
} from "react-router";
import { ZodError, type ZodType, z } from "zod";
import { CommunicationDraftPreview } from "~/components/communication-draft-preview";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { PageHeader } from "~/components/ui/page-header";
import { EmptyState } from "~/components/ui/states";
import {
  type AudienceType,
  audienceTypeSchema,
  communicationCategorySchema,
} from "~/modules/communications/communication-schema";
import {
  CommunicationNotFoundError,
  type CommunicationPreview,
  CommunicationQueueUnavailableError,
  CommunicationService,
  CommunicationStateError,
  communicationErrorMessage,
} from "~/modules/communications/communication-service.server";
import {
  communicationScheduledEpoch,
  communicationScheduledLocalValue,
  communicationScheduleIssue,
} from "~/modules/communications/communication-time";
import { UnknownMergeVariableError } from "~/modules/communications/merge-template";
import { RecipientLimitError } from "~/modules/communications/recipient-query.server";
import { EventService } from "~/modules/events/event-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import "~/styles/workspace-communication-composer.css";
import { Button, ButtonLink } from "~/components/ui/button";
import type { Route } from "./+types/communication-composer";

export const meta = () => [{ title: "Compose Communication · Program Cue" }];

type ComposerActionResult = {
  ok: boolean;
  intent: string;
  message: string;
  draftId?: string;
  draftRevision?: number;
  preview?: CommunicationPreview;
  operationId?: string;
};

async function viewerFor(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  return requireCurrentEventRole(request, env, ["owner", "administrator"]);
}

function preset<T>(value: string | null, schema: ZodType<T>) {
  if (value === null) return null;
  const result = schema.safeParse(value);
  if (!result.success)
    throw new Response("Communication preset is invalid.", { status: 400 });
  return result.data;
}

function requireDraftId(value: string | undefined) {
  const result = z.uuid().safeParse(value);
  if (!result.success) {
    throw new Response("Communication draft not found.", { status: 404 });
  }
  return result.data;
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await viewerFor(request, context);
  const service = new CommunicationService(env);
  const event = await new EventService(env).getSetup(viewer);
  const centre = await service.listCentre(viewer);
  const templates = centre.templates.filter(
    (template) => template.versionStatus === "published",
  );
  const search = new URL(request.url).searchParams;
  const audiencePreset = preset<AudienceType>(
    search.get("audience"),
    audienceTypeSchema,
  );
  const categoryPreset = preset(
    search.get("category"),
    communicationCategorySchema,
  );
  const defaultTemplateCategory =
    categoryPreset ?? (audiencePreset === null ? "task_reminder" : null);
  const defaultTemplate = defaultTemplateCategory
    ? templates.find(
        (template) =>
          template.category === defaultTemplateCategory &&
          template.category !== "submission_confirmation",
      )
    : undefined;
  let draft = null;
  if (params.draftId) {
    try {
      draft = await service.getDraft(viewer, params.draftId);
    } catch (error) {
      if (error instanceof CommunicationNotFoundError) {
        throw new Response("Communication draft not found.", { status: 404 });
      }
      throw error;
    }
  }
  return {
    draft,
    templates,
    eventTimezone: event.timezone,
    eventStartDate: event.startDate,
    defaults: {
      templateVersionId: defaultTemplate?.id ?? "",
      audienceType: audiencePreset ?? "incomplete_speakers",
    },
  };
}

async function draftFields(form: FormData, eventTimezone: string) {
  const scheduledValue = String(form.get("scheduledAt") ?? "").trim();
  let scheduledAt: number | null = null;
  if (scheduledValue) {
    try {
      scheduledAt = communicationScheduledEpoch(scheduledValue, eventTimezone);
    } catch (error) {
      throw new CommunicationStateError(
        error instanceof Error
          ? error.message
          : "Scheduled delivery time is invalid.",
      );
    }
  }
  return {
    templateVersionId: String(form.get("templateVersionId") ?? ""),
    audienceType: String(form.get("audienceType") ?? "") as AudienceType,
    manualRecipients: String(form.get("manualRecipients") ?? ""),
    kind: String(form.get("kind") ?? "") as "transactional" | "optional",
    scheduledAt,
  };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await viewerFor(request, context);
  const service = new CommunicationService(env);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  try {
    if (intent === "create-draft" || intent === "save-draft") {
      const event = await new EventService(env).getSetup(viewer);
      const fields = await draftFields(form, event.timezone);
      const draft =
        intent === "create-draft"
          ? await service.createDraft(viewer, fields)
          : await service.updateDraft(viewer, {
              ...fields,
              draftId: requireDraftId(params.draftId),
              revision: form.get("revision"),
            });
      return redirect(`/admin/communications/compose/${draft.id}`);
    }
    if (intent === "preview-draft") {
      const result = await service.previewDraft(
        viewer,
        requireDraftId(params.draftId),
      );
      return data<ComposerActionResult>({
        ok: true,
        intent,
        message: `${new Intl.NumberFormat("en").format(result.preview.recipients.deliverable.length)} deliverable recipients. Nothing has been queued.`,
        draftId: result.draft.id,
        draftRevision: result.draft.revision,
        preview: result.preview,
      });
    }
    if (intent === "confirm-draft") {
      const result = await service.confirmDraft(viewer, {
        draftId: requireDraftId(params.draftId),
        revision: form.get("revision"),
        recipientFingerprint: String(form.get("recipientFingerprint") ?? ""),
        deliverableFingerprint: String(
          form.get("deliverableFingerprint") ?? "",
        ),
        suppressedCount: form.get("suppressedCount"),
      });
      return redirect(
        `/admin/communications?composed=${encodeURIComponent(result.status)}&communication=${encodeURIComponent(result.communicationId)}`,
      );
    }
    if (intent === "discard-draft") {
      const draftId = requireDraftId(params.draftId);
      await service.discardDraft(viewer, {
        draftId,
        revision: form.get("revision"),
      });
      return redirect(
        `/admin/communications?discarded=${encodeURIComponent(draftId)}`,
      );
    }
    return data<ComposerActionResult>(
      {
        ok: false,
        intent,
        message: "Unsupported communication composer action.",
      },
      { status: 400 },
    );
  } catch (error) {
    if (
      error instanceof ZodError ||
      error instanceof CommunicationNotFoundError ||
      error instanceof CommunicationStateError ||
      error instanceof RecipientLimitError ||
      error instanceof UnknownMergeVariableError
    ) {
      return data<ComposerActionResult>(
        { ok: false, intent, message: communicationErrorMessage(error) },
        {
          status:
            error instanceof CommunicationNotFoundError
              ? 404
              : error instanceof CommunicationStateError
                ? 409
                : 422,
        },
      );
    }
    if (error instanceof CommunicationQueueUnavailableError) {
      return data<ComposerActionResult>(
        {
          ok: false,
          intent,
          message: error.message,
          operationId: error.operationId,
        },
        { status: 503 },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

const audienceOptions = [
  ["submitted_applicants", "Submitted applicants"],
  ["decision_recipients", "Applicants with decisions"],
  ["accepted_speakers", "Accepted speakers"],
  ["active_speakers", "Active speaker roster"],
  ["incomplete_speakers", "Speakers with incomplete tasks"],
  ["due_speakers", "Speakers due within 24 hours"],
  ["overdue_speakers", "Overdue speakers"],
  ["event_administrators", "Event administrators"],
  ["manual", "Manual addresses"],
] as const;

function DraftFields({
  templates,
  defaults,
  eventTimezone,
  eventStartDate,
}: {
  templates: Route.ComponentProps["loaderData"]["templates"];
  defaults: {
    templateVersionId: string;
    audienceType: AudienceType;
    kind?: "transactional" | "optional";
    manualRecipients?: string;
    scheduledAt?: number | null;
  };
  eventTimezone: string;
  eventStartDate: string;
}) {
  const scheduledErrorId = useId();
  const [audienceType, setAudienceType] = useState(defaults.audienceType);
  const [manualRecipients, setManualRecipients] = useState(
    defaults.manualRecipients ?? "",
  );
  const [scheduledLocal, setScheduledLocal] = useState(
    communicationScheduledLocalValue(
      defaults.scheduledAt ?? null,
      eventTimezone,
    ),
  );
  useEffect(() => {
    setAudienceType(defaults.audienceType);
    setManualRecipients(defaults.manualRecipients ?? "");
    setScheduledLocal(
      communicationScheduledLocalValue(
        defaults.scheduledAt ?? null,
        eventTimezone,
      ),
    );
  }, [
    defaults.audienceType,
    defaults.manualRecipients,
    defaults.scheduledAt,
    eventTimezone,
  ]);
  const nowLocal = communicationScheduledLocalValue(
    Math.floor(Date.now() / 1_000),
    eventTimezone,
  );
  const scheduledError = communicationScheduleIssue(
    scheduledLocal,
    eventTimezone,
    Math.floor(Date.now() / 1_000),
  );
  const tomorrowMorning = (() => {
    const localDate = nowLocal.slice(0, 10);
    const next = new Date(`${localDate}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return `${next.toISOString().slice(0, 10)}T09:00`;
  })();
  const weekBeforeEvent = (() => {
    const next = new Date(`${eventStartDate}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() - 7);
    return `${next.toISOString().slice(0, 10)}T09:00`;
  })();
  const weekBeforeEventIsFuture =
    communicationScheduledEpoch(weekBeforeEvent, eventTimezone) * 1_000 >
    Date.now();
  return (
    <>
      <label className="label">
        <span className="pc-field-label">
          <span>Published template</span>
          <span className="pc-required" aria-hidden="true">
            Required
          </span>
        </span>
        <select
          className="select"
          name="templateVersionId"
          defaultValue={defaults.templateVersionId}
          required
        >
          <option value="" disabled>
            Select a published version
          </option>
          {templates.map((template) => (
            <option
              key={template.id}
              value={template.id}
              disabled={template.category === "submission_confirmation"}
            >
              {template.name} · v{template.versionNumber}
              {template.category === "submission_confirmation"
                ? " · automatic only"
                : ""}
            </option>
          ))}
        </select>
      </label>
      <div className="form-row">
        <label className="label">
          Audience
          <select
            className="select"
            name="audienceType"
            value={audienceType}
            onChange={(event) =>
              setAudienceType(event.currentTarget.value as AudienceType)
            }
          >
            {audienceOptions.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="label">
          Message policy
          <select
            className="select"
            name="kind"
            defaultValue={defaults.kind ?? "transactional"}
          >
            <option value="transactional">
              Transactional · required operational message
            </option>
            <option value="optional">
              Optional · honour category unsubscribes
            </option>
          </select>
        </label>
      </div>
      {audienceType === "manual" ? (
        <label className="label">
          Manual addresses
          <textarea
            className="textarea"
            name="manualRecipients"
            value={manualRecipients}
            onChange={(event) => setManualRecipients(event.currentTarget.value)}
            placeholder="Alex Morgan <alex@example.com>, priya@example.com"
            required
          />
          <span className="help">
            Separate addresses with commas. Named addresses are supported.
          </span>
        </label>
      ) : (
        <input type="hidden" name="manualRecipients" value="" />
      )}
      <label className="label">
        Schedule for later (optional, {eventTimezone})
        <input
          className="field"
          name="scheduledAt"
          type="datetime-local"
          value={scheduledLocal}
          min={nowLocal}
          onChange={(event) => setScheduledLocal(event.currentTarget.value)}
          aria-invalid={scheduledError ? true : undefined}
          aria-describedby={scheduledError ? scheduledErrorId : undefined}
        />
        <span className="help">
          Leave blank to queue immediately after confirmation.
        </span>
        <span className="row-actions mt">
          <Button
            size="small"
            type="button"
            onClick={() => setScheduledLocal(tomorrowMorning)}
          >
            Tomorrow at 9:00 AM
          </Button>
          {weekBeforeEventIsFuture ? (
            <Button
              size="small"
              type="button"
              onClick={() => setScheduledLocal(weekBeforeEvent)}
            >
              One week before event
            </Button>
          ) : null}
          {scheduledLocal ? (
            <Button
              size="small"
              type="button"
              onClick={() => setScheduledLocal("")}
            >
              Queue immediately
            </Button>
          ) : null}
        </span>
        {scheduledError ? (
          <span className="field-error" id={scheduledErrorId} role="alert">
            {scheduledError}
          </span>
        ) : null}
      </label>
    </>
  );
}

export default function CommunicationComposer({
  loaderData,
}: Route.ComponentProps) {
  const actionData = useActionData<typeof action>() as
    | ComposerActionResult
    | undefined;
  const navigation = useNavigation();
  const submit = useSubmit();
  const { confirm, dialog } = useConfirm();
  const working = navigation.state !== "idle";
  const pendingIntent = navigation.formData?.get("intent");
  const [configurationDirty, setConfigurationDirty] = useState(false);
  const { draft } = loaderData;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Draft identity and revision are deliberate reset triggers for transient dirty state.
  useEffect(() => {
    setConfigurationDirty(false);
  }, [draft?.id, draft?.revision]);
  const preview =
    actionData?.preview &&
    draft &&
    actionData.draftId === draft?.id &&
    actionData.draftRevision === draft.revision
      ? actionData.preview
      : null;
  const confirmedPreviewReady = Boolean(preview && !configurationDirty);

  return (
    <div className="pc-compose">
      {dialog}
      <PageHeader
        eyebrow="Durable communication workflow"
        title={draft ? "Compose communication" : "New communication"}
        description="Configure a saved draft, recompute the exact audience, then confirm the same record for delivery."
        actions={
          <>
            {draft ? (
              <span className="status info">
                Draft revision {draft.revision}
              </span>
            ) : null}
            <ButtonLink to="/admin/communications">
              Communications Centre
            </ButtonLink>
          </>
        }
      />

      <ol className="pc-compose-steps" aria-label="Communication workflow">
        <li className={draft ? "is-complete" : "is-current"}>Save draft</li>
        <li
          className={
            confirmedPreviewReady
              ? "is-complete"
              : draft
                ? "is-current"
                : undefined
          }
        >
          Verify preview
        </li>
        <li className={confirmedPreviewReady ? "is-current" : undefined}>
          Confirm delivery
        </li>
      </ol>

      {actionData ? (
        <div
          className={`card pad mb validation-item ${actionData.ok ? "ok" : "error"}`}
          role={actionData.ok ? "status" : "alert"}
        >
          <strong>{actionData.ok ? "✓" : "△"}</strong>
          <span>{actionData.message}</span>
          {actionData.operationId ? (
            <Link to="/admin/operations">Open operation</Link>
          ) : null}
        </div>
      ) : null}

      {!draft ? (
        <section className="pc-compose-surface">
          <div className="card-title">
            <div>
              <h2>1. Create the durable draft</h2>
              <p className="help">
                Nothing is queued by creating or editing a draft.
              </p>
            </div>
          </div>
          {loaderData.templates.length ? (
            <Form method="post" className="stack">
              <input type="hidden" name="intent" value="create-draft" />
              <DraftFields
                templates={loaderData.templates}
                defaults={loaderData.defaults}
                eventTimezone={loaderData.eventTimezone}
                eventStartDate={loaderData.eventStartDate}
              />
              <Button type="submit" variant="primary" disabled={working}>
                <FilePenLine aria-hidden size={16} />
                {working ? "Saving…" : "Create durable draft"}
              </Button>
            </Form>
          ) : (
            <EmptyState
              title="No published templates"
              description="Publish a template version before composing a communication."
              action={
                <ButtonLink variant="primary" to="/admin/communications">
                  Manage templates
                </ButtonLink>
              }
            />
          )}
        </section>
      ) : (
        <div className="pc-compose-surface">
          <section>
            <div className="card-title">
              <div>
                <h2>1. Saved draft configuration</h2>
                <p className="help">
                  Saving changes creates a new version and discards any earlier
                  preview.
                </p>
              </div>
              <span className="status success right">Saved</span>
            </div>
            <Form
              method="post"
              className="stack"
              onChange={() => setConfigurationDirty(true)}
            >
              <input type="hidden" name="intent" value="save-draft" />
              <input type="hidden" name="revision" value={draft.revision} />
              <DraftFields
                templates={loaderData.templates}
                defaults={draft}
                eventTimezone={loaderData.eventTimezone}
                eventStartDate={loaderData.eventStartDate}
              />
              <div className="row-actions">
                <Button type="submit" disabled={working}>
                  {working && pendingIntent === "save-draft"
                    ? "Saving…"
                    : "Save and continue"}
                </Button>
              </div>
            </Form>
          </section>

          <section>
            <div className="card-title">
              <div>
                <h2>2. Verify the authoritative preview</h2>
                <p className="help">
                  Recipient, source, template and sender data are queried again
                  each time.
                </p>
              </div>
              <span className="status info right">Nothing queued</span>
            </div>
            <Form method="post">
              <input type="hidden" name="intent" value="preview-draft" />
              <Button
                type="submit"
                variant="primary"
                disabled={working || configurationDirty}
              >
                <Eye aria-hidden size={16} />
                {working && pendingIntent === "preview-draft"
                  ? "Querying…"
                  : "Generate current preview"}
              </Button>
            </Form>

            {configurationDirty ? (
              <div className="validation-item warn mt" role="status">
                Save the visible configuration changes before generating or
                confirming a preview.
              </div>
            ) : null}

            {preview ? (
              <CommunicationDraftPreview
                preview={preview}
                revision={draft.revision}
                scheduledAt={draft.scheduledAt}
                eventTimezone={loaderData.eventTimezone}
                working={working}
                pendingIntent={pendingIntent}
                configurationDirty={configurationDirty}
              />
            ) : null}
          </section>

          <Form
            className="pc-compose-discard"
            method="post"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              confirm(
                {
                  title: "Discard this communication draft?",
                  description: `Revision ${draft.revision} stops being editable and remains in communication history as cancelled. Nothing has been queued, so no recipient is affected.`,
                  confirmLabel: "Discard draft",
                  cancelLabel: "Keep editing",
                },
                () => submit(form),
              );
            }}
          >
            <input type="hidden" name="intent" value="discard-draft" />
            <input type="hidden" name="revision" value={draft.revision} />
            <Button type="submit" variant="danger" disabled={working}>
              <Trash2 aria-hidden size={16} /> Discard draft
            </Button>
          </Form>
        </div>
      )}
    </div>
  );
}

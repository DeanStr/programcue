import { useEffect, useMemo, useState } from "react";
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useNavigation,
} from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/communications-centre";
import { CalendarService } from "~/modules/calendars/calendar-service.server";
import {
  CommunicationNotFoundError,
  CommunicationQueueUnavailableError,
  CommunicationService,
  CommunicationStateError,
  communicationErrorMessage,
  type CommunicationPreview,
} from "~/modules/communications/communication-service.server";
import type { CommunicationCategory } from "~/modules/communications/communication-schema";
import { UnknownMergeVariableError } from "~/modules/communications/merge-template";
import { RecipientLimitError } from "~/modules/communications/recipient-query.server";
import { requireEventRole } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

export const meta = () => [{ title: "Communications Centre · Program Cue" }];

type PreviewFields = {
  templateVersionId: string;
  audienceType: string;
  manualRecipients: string;
  kind: string;
};
type ActionResult = {
  ok: boolean;
  intent: string;
  message: string;
  preview?: CommunicationPreview;
  fields?: PreviewFields;
  idempotencyKey?: string;
  operationId?: string;
};

async function viewerFor(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  if (!env.DEFAULT_EVENT_ID)
    throw new Response("DEFAULT_EVENT_ID is not configured", { status: 503 });
  return requireEventRole(request, env, env.DEFAULT_EVENT_ID, [
    "owner",
    "administrator",
  ]);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await viewerFor(request, context);
  const search = new URL(request.url).searchParams;
  const activeFilter =
    search.get("filter") === "failed" ? ("failed" as const) : null;
  const [centre, invitations] = await Promise.all([
    new CommunicationService(env).listCentre(viewer, {
      filter: activeFilter ?? undefined,
    }),
    new CalendarService(env).list(viewer),
  ]);
  const requestedTemplate = search.get("template");
  const selected =
    requestedTemplate !== null
      ? (centre.templates.find((version) => version.id === requestedTemplate) ??
        null)
      : (centre.templates.find(
          (version) => version.versionStatus === "published",
        ) ??
        centre.templates[0] ??
        null);
  if (requestedTemplate !== null && !selected) {
    throw new Response("Communication template version not found", {
      status: 404,
    });
  }
  const savedVersion = search.get("saved");
  const savedVersionNumber =
    savedVersion === null ? null : Number(savedVersion);
  const persistedSave =
    selected &&
    requestedTemplate === selected.id &&
    Number.isSafeInteger(savedVersionNumber) &&
    savedVersionNumber === selected.versionNumber &&
    selected.versionStatus === "draft";
  return {
    ...centre,
    invitations,
    selected,
    activeFilter,
    notice: persistedSave
      ? `Draft version ${selected.versionNumber} is stored in D1.`
      : "",
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await viewerFor(request, context);
  const service = new CommunicationService(env);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  try {
    if (intent === "save-template") {
      const buttonText = String(form.get("buttonText") ?? "").trim();
      const buttonUrl = String(form.get("buttonUrl") ?? "").trim();
      const result = await service.saveTemplate(viewer, {
        templateId: String(form.get("templateId") ?? "") || undefined,
        name: String(form.get("name") ?? ""),
        category: String(form.get("category") ?? "") as CommunicationCategory,
        subject: String(form.get("subject") ?? ""),
        content: {
          body: String(form.get("body") ?? ""),
          physicalAddress: String(form.get("physicalAddress") ?? ""),
          ...(buttonText ? { buttonText } : {}),
          ...(buttonUrl ? { buttonUrl } : {}),
        },
      });
      return redirect(
        `/admin/communications?template=${encodeURIComponent(result.versionId)}&saved=${result.versionNumber}`,
      );
    }
    if (intent === "publish-template") {
      const published = await service.publishTemplate(
        viewer,
        String(form.get("templateVersionId") ?? ""),
      );
      return data<ActionResult>({
        ok: true,
        intent,
        message: `Version ${published.versionNumber} is now the published sending version.`,
      });
    }
    if (intent === "preview" || intent === "confirm") {
      const fields: PreviewFields = {
        templateVersionId: String(form.get("templateVersionId") ?? ""),
        audienceType: String(form.get("audienceType") ?? ""),
        manualRecipients: String(form.get("manualRecipients") ?? ""),
        kind: String(form.get("kind") ?? ""),
      };
      if (intent === "preview") {
        const preview = await service.preview(
          viewer,
          fields as Parameters<CommunicationService["preview"]>[1],
        );
        return data<ActionResult>({
          ok: true,
          intent,
          message: `${new Intl.NumberFormat("en").format(preview.recipients.deliverable.length)} deliverable recipients. Nothing has been queued.`,
          preview,
          fields,
          idempotencyKey: crypto.randomUUID(),
        });
      }
      const result = await service.confirm(viewer, {
        ...fields,
        idempotencyKey: String(form.get("idempotencyKey") ?? ""),
        recipientFingerprint: String(form.get("recipientFingerprint") ?? ""),
        deliverableFingerprint: String(
          form.get("deliverableFingerprint") ?? "",
        ),
        suppressedCount:
          typeof form.get("suppressedCount") === "string"
            ? Number(form.get("suppressedCount"))
            : Number.NaN,
      } as Parameters<CommunicationService["confirm"]>[1]);
      if (
        result.duplicate &&
        ["failed", "partially_failed", "cancelled"].includes(result.status)
      ) {
        return data<ActionResult>(
          {
            ok: false,
            intent,
            message: `This exact send was already recorded with status ${result.status.replaceAll("_", " ")}. Inspect the operation before retrying.`,
            operationId: result.operationId,
          },
          { status: 409 },
        );
      }
      return data<ActionResult>({
        ok: true,
        intent,
        message: result.duplicate
          ? "This exact send was already recorded."
          : "Delivery intent is durable and queued. Follow provider progress in the Operation Centre.",
        operationId: result.operationId,
      });
    }
    if (intent === "cancel") {
      await service.cancel(viewer, String(form.get("communicationId") ?? ""));
      return data<ActionResult>({
        ok: true,
        intent,
        message:
          "The unsent communication and queued deliveries were cancelled.",
      });
    }
    return data<ActionResult>(
      {
        ok: false,
        intent,
        message: "Unsupported Communications Centre action.",
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
      return data<ActionResult>(
        { ok: false, intent, message: communicationErrorMessage(error) },
        { status: 422 },
      );
    }
    if (error instanceof CommunicationQueueUnavailableError) {
      return data<ActionResult>(
        {
          ok: false,
          intent,
          message: communicationErrorMessage(error),
          operationId: error.operationId,
        },
        { status: 503 },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

function formatDate(epoch: number | null) {
  return epoch
    ? new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(new Date(epoch * 1_000))
    : "—";
}

function categoryLabel(category: string) {
  return category
    .replaceAll("_", " ")
    .replace(/^./, (value) => value.toUpperCase());
}

export default function CommunicationsCentre({
  loaderData,
}: Route.ComponentProps) {
  const actionData = useActionData<typeof action>() as ActionResult | undefined;
  const navigation = useNavigation();
  const selected = loaderData.selected;
  const working = navigation.state !== "idle";
  const pendingIntent = navigation.formData?.get("intent");
  const [templateDirty, setTemplateDirty] = useState(false);
  useEffect(() => setTemplateDirty(false), [selected?.id]);
  const publishedTemplates = useMemo(
    () =>
      loaderData.templates.filter(
        (template) => template.versionStatus === "published",
      ),
    [loaderData.templates],
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Communications Centre</h1>
          <p>
            Version content, inspect the exact audience, then confirm durable
            delivery.
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/admin/operations">
            Operation Centre
          </Link>
          <span
            className={`status ${loaderData.provider.configured && loaderData.provider.queueConfigured ? "success" : "danger"}`}
          >
            {loaderData.provider.configured &&
            loaderData.provider.queueConfigured
              ? "Delivery configured"
              : "Delivery blocked"}
          </span>
        </div>
      </div>

      {loaderData.activeFilter === "failed" ? (
        <div className="validation-item error mb" role="status">
          <strong>Failed delivery filter</strong>
          <span>
            {loaderData.communications.length} failed or partially failed
            communication{loaderData.communications.length === 1 ? "" : "s"}{" "}
            require attention.
          </span>
          <Link className="btn small" to="/admin/communications">
            Clear filter
          </Link>
        </div>
      ) : null}

      {loaderData.notice ? (
        <div className="card pad mb validation-item ok" role="status">
          <strong>✓</strong>
          <span>
            {loaderData.notice} Preview it, then publish when it is ready.
          </span>
        </div>
      ) : null}
      {actionData ? (
        <div
          className={`card pad mb validation-item ${actionData.ok ? "ok" : "error"}`}
          role={actionData.ok ? "status" : "alert"}
        >
          <strong>{actionData.ok ? "✓" : "△"}</strong>
          <span>
            {actionData.message}
            {actionData.operationId ? (
              <>
                {" "}
                <Link to="/admin/operations">
                  Open {actionData.operationId}
                </Link>
              </>
            ) : null}
          </span>
        </div>
      ) : null}

      <div className="comms-provider-strip card pad mb">
        <span>
          <strong>Sender</strong>
          <small>
            {loaderData.provider.sender ?? "No verified Resend sender profile"}
          </small>
        </span>
        <span>
          <strong>Resend</strong>
          <small>
            {loaderData.provider.configured
              ? "API key and verified sender present"
              : "Configuration required"}
          </small>
        </span>
        <span>
          <strong>Queue</strong>
          <small>
            {loaderData.provider.queueConfigured
              ? "Operations Queue bound"
              : "OPERATIONS_QUEUE is unavailable"}
          </small>
        </span>
        <span>
          <strong>Policy</strong>
          <small>No provider simulation or silent fallback</small>
        </span>
      </div>

      <div className="comms-layout comms-production-layout">
        <aside className="card pad template-column">
          <div className="card-title">
            <h2>Template versions</h2>
            <span className="status info right">
              {loaderData.templates.length}
            </span>
          </div>
          <div className="template-list">
            {loaderData.templates.length ? (
              loaderData.templates.map((template) => (
                <Link
                  key={template.id}
                  to={`?template=${template.id}`}
                  className={`template-item${selected?.id === template.id ? " active" : ""}`}
                >
                  <strong>{template.name}</strong>
                  <small>
                    {categoryLabel(template.category)} · v
                    {template.versionNumber}
                  </small>
                  <span
                    className={`status ${template.versionStatus === "published" ? "success" : template.versionStatus === "draft" ? "warning" : "info"}`}
                  >
                    {template.versionStatus}
                  </span>
                </Link>
              ))
            ) : (
              <div className="empty compact">
                <p>Create the first versioned email template.</p>
              </div>
            )}
          </div>
        </aside>

        <main className="stack">
          <section className="card pad">
            <div className="card-title">
              <h2>
                {selected ? `Edit ${selected.name}` : "New email template"}
              </h2>
              {selected ? (
                <span
                  className={`status ${selected.versionStatus === "published" ? "success" : "warning"} right`}
                >
                  v{selected.versionNumber} · {selected.versionStatus}
                </span>
              ) : null}
            </div>
            <Form
              key={selected?.id ?? "new-template"}
              method="post"
              className="stack"
              onChange={() => setTemplateDirty(true)}
            >
              {selected ? (
                <input
                  type="hidden"
                  name="templateId"
                  value={selected.templateId}
                />
              ) : null}
              <div className="form-row">
                <label className="label">
                  Template name
                  <input
                    className="field"
                    name="name"
                    defaultValue={selected?.name ?? ""}
                    required
                  />
                </label>
                <label className="label">
                  Type
                  <select
                    className="select"
                    name="category"
                    defaultValue={selected?.category ?? "ad_hoc"}
                  >
                    <option value="submission_confirmation">
                      Submission confirmation
                    </option>
                    <option value="decision">Decision</option>
                    <option value="task_reminder">Task reminder</option>
                    <option value="schedule">Schedule update</option>
                    <option value="calendar">Calendar</option>
                    <option value="ad_hoc">Ad hoc</option>
                  </select>
                </label>
              </div>
              <label className="label">
                Subject
                <input
                  className="field"
                  name="subject"
                  defaultValue={
                    selected?.subject ??
                    "Hi {{recipient.firstName}} — an update from {{event.name}}"
                  }
                  required
                />
              </label>
              <label className="label">
                Message
                <textarea
                  className="textarea comms-body"
                  name="body"
                  defaultValue={
                    selected?.content.body ??
                    "Hi {{recipient.firstName}},\n\nHere is an update from {{event.name}}."
                  }
                  required
                />
              </label>
              <label className="label">
                Physical address
                <input
                  className="field"
                  name="physicalAddress"
                  defaultValue={
                    selected?.content.physicalAddress ??
                    "Program Cue event operations"
                  }
                  required
                />
                <span className="help">Required in the rendered footer.</span>
              </label>
              <div className="form-row">
                <label className="label">
                  Optional button text
                  <input
                    className="field"
                    name="buttonText"
                    defaultValue={selected?.content.buttonText ?? ""}
                  />
                </label>
                <label className="label">
                  Optional button URL
                  <input
                    className="field"
                    name="buttonUrl"
                    type="url"
                    defaultValue={selected?.content.buttonUrl ?? ""}
                  />
                </label>
              </div>
              <div className="row-actions">
                <button
                  className="btn"
                  name="intent"
                  value="save-template"
                  disabled={working}
                >
                  {working && pendingIntent === "save-template"
                    ? "Saving…"
                    : "Save as new draft version"}
                </button>
                {selected?.versionStatus === "draft" ? (
                  <button
                    className="btn primary"
                    name="intent"
                    value="publish-template"
                    formNoValidate
                    disabled={working || templateDirty}
                  >
                    {templateDirty
                      ? "Save changes before publishing"
                      : working && pendingIntent === "publish-template"
                        ? "Publishing…"
                        : "Publish this saved version"}
                  </button>
                ) : null}
                {selected?.versionStatus === "draft" ? (
                  <input
                    type="hidden"
                    name="templateVersionId"
                    value={selected.id}
                  />
                ) : null}
              </div>
            </Form>
          </section>

          <section className="card pad">
            <div className="card-title">
              <h2>1. Configure audience</h2>
              <span className="help right">
                Preview re-runs the tenant-scoped query.
              </span>
            </div>
            <Form method="post" className="stack">
              <input type="hidden" name="intent" value="preview" />
              <label className="label">
                Published template
                <select
                  className="select"
                  name="templateVersionId"
                  defaultValue={
                    actionData?.fields?.templateVersionId ??
                    (selected?.versionStatus === "published" ? selected.id : "")
                  }
                  required
                >
                  <option value="" disabled>
                    Select a published version
                  </option>
                  {publishedTemplates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name} · v{template.versionNumber}
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
                    defaultValue={
                      actionData?.fields?.audienceType ?? "incomplete_speakers"
                    }
                  >
                    <option value="submitted_applicants">
                      Submitted applicants
                    </option>
                    <option value="decision_recipients">
                      Applicants with decisions
                    </option>
                    <option value="accepted_speakers">Accepted speakers</option>
                    <option value="incomplete_speakers">
                      Speakers with incomplete tasks
                    </option>
                    <option value="manual">Manual addresses</option>
                  </select>
                </label>
                <label className="label">
                  Message policy
                  <select
                    className="select"
                    name="kind"
                    defaultValue={actionData?.fields?.kind ?? "transactional"}
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
              <label className="label">
                Manual addresses
                <textarea
                  className="textarea"
                  name="manualRecipients"
                  defaultValue={actionData?.fields?.manualRecipients ?? ""}
                  placeholder="Alex Morgan <alex@example.com>, priya@example.com"
                />
                <span className="help">
                  Only used when Manual addresses is selected.
                </span>
              </label>
              <button
                className="btn primary"
                disabled={working || !publishedTemplates.length}
              >
                {working && pendingIntent === "preview"
                  ? "Querying…"
                  : "Preview recipients and content"}
              </button>
            </Form>
          </section>

          {actionData?.preview && actionData.fields ? (
            <section className="card pad comms-confirm-panel">
              <div className="card-title">
                <h2>2. Verify preview</h2>
                <span className="status info right">Nothing queued</span>
              </div>
              <div className="grid grid-4 mb">
                <div className="metric">
                  <span className="label">Selected</span>
                  <strong className="value">
                    {actionData.preview.recipients.selected}
                  </strong>
                </div>
                <div className="metric">
                  <span className="label">Deliverable</span>
                  <strong className="value">
                    {actionData.preview.recipients.deliverable.length}
                  </strong>
                </div>
                <div className="metric">
                  <span className="label">Suppressed</span>
                  <strong className="value">
                    {actionData.preview.recipients.suppressed.length}
                  </strong>
                </div>
                <div className="metric">
                  <span className="label">Invalid</span>
                  <strong className="value">
                    {actionData.preview.recipients.invalid.length}
                  </strong>
                </div>
              </div>
              {actionData.preview.recipients.invalid.length ||
              actionData.preview.recipients.suppressed.length ? (
                <div className="validation-item warn mb">
                  △ Excluded recipients will not receive this batch. Inspect the
                  counts before confirming.
                </div>
              ) : (
                <div className="validation-item ok mb">
                  ✓ All selected recipients are deliverable.
                </div>
              )}
              <div className="comms-preview-grid">
                <div>
                  <h3>Representative email</h3>
                  <iframe
                    className="email-preview-frame"
                    title="Representative email preview"
                    srcDoc={actionData.preview.rendered.html}
                  />
                </div>
                <div>
                  <h3>Recipient sample</h3>
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Address</th>
                        </tr>
                      </thead>
                      <tbody>
                        {actionData.preview.recipients.deliverable
                          .slice(0, 20)
                          .map((recipient) => (
                            <tr key={recipient.address}>
                              <td>{recipient.name}</td>
                              <td>{recipient.address}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                  {actionData.preview.recipients.deliverable.length > 20 ? (
                    <p className="help">
                      Showing 20 of{" "}
                      {actionData.preview.recipients.deliverable.length}{" "}
                      deliverable recipients.
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="divider" />
              <div className="card-title">
                <h2>3. Confirm durable send</h2>
              </div>
              {!actionData.preview.provider.configured ||
              !actionData.preview.provider.queueConfigured ? (
                <div className="validation-item error mb">
                  △ Confirm is blocked until a verified sender, RESEND_API_KEY
                  and OPERATIONS_QUEUE are configured.
                </div>
              ) : null}
              <Form method="post" className="row-actions">
                <input type="hidden" name="intent" value="confirm" />
                <input
                  type="hidden"
                  name="templateVersionId"
                  value={actionData.fields.templateVersionId}
                />
                <input
                  type="hidden"
                  name="audienceType"
                  value={actionData.fields.audienceType}
                />
                <input
                  type="hidden"
                  name="manualRecipients"
                  value={actionData.fields.manualRecipients}
                />
                <input
                  type="hidden"
                  name="kind"
                  value={actionData.fields.kind}
                />
                <input
                  type="hidden"
                  name="idempotencyKey"
                  value={actionData.idempotencyKey}
                />
                <input
                  type="hidden"
                  name="recipientFingerprint"
                  value={actionData.preview.confirmation.recipientFingerprint}
                />
                <input
                  type="hidden"
                  name="deliverableFingerprint"
                  value={actionData.preview.confirmation.deliverableFingerprint}
                />
                <input
                  type="hidden"
                  name="suppressedCount"
                  value={actionData.preview.confirmation.suppressedCount}
                />
                <span className="help">
                  The audience is recomputed at confirmation; saved delivery
                  rows become authoritative.
                </span>
                <button
                  className="btn primary"
                  disabled={
                    working ||
                    !actionData.preview.provider.configured ||
                    !actionData.preview.provider.queueConfigured ||
                    !actionData.preview.recipients.deliverable.length
                  }
                >
                  {working && pendingIntent === "confirm"
                    ? "Recording…"
                    : `Confirm ${actionData.preview.recipients.deliverable.length} deliveries`}
                </button>
              </Form>
            </section>
          ) : null}
        </main>
      </div>

      <div className="grid grid-2 mt comms-history">
        <section className="card pad">
          <div className="card-title">
            <h2>Recent communications</h2>
            <span className="status info right">
              {loaderData.communications.length}
            </span>
          </div>
          {loaderData.communications.length ? (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Created (UTC)</th>
                    <th>Status</th>
                    <th>Progress</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {loaderData.communications.map((item) => (
                    <tr key={item.id}>
                      <td>
                        {formatDate(item.createdAt)}
                        <small>{item.id}</small>
                      </td>
                      <td>
                        <span
                          className={`status ${item.status === "sent" ? "success" : ["failed", "partially_failed"].includes(item.status) ? "danger" : "info"}`}
                        >
                          {item.status.replaceAll("_", " ")}
                        </span>
                      </td>
                      <td>
                        {item.sentCount}/{item.recipientCount} sent
                        {item.failedCount
                          ? ` · ${item.failedCount} failed`
                          : ""}
                      </td>
                      <td>
                        {["draft", "scheduled", "queued", "failed"].includes(
                          item.status,
                        ) ? (
                          <Form
                            method="post"
                            onSubmit={(event) => {
                              if (
                                !window.confirm(
                                  `Cancel communication ${item.id}? Unsent deliveries will not be sent.`,
                                )
                              )
                                event.preventDefault();
                            }}
                          >
                            <input type="hidden" name="intent" value="cancel" />
                            <input
                              type="hidden"
                              name="communicationId"
                              value={item.id}
                            />
                            <button className="btn small" disabled={working}>
                              {working && pendingIntent === "cancel"
                                ? "Cancelling…"
                                : "Cancel"}
                            </button>
                          </Form>
                        ) : item.operationId ? (
                          <Link className="btn small" to="/admin/operations">
                            Details
                          </Link>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty compact">
              <p>No sends have been confirmed.</p>
            </div>
          )}
        </section>
        <section className="card pad">
          <div className="card-title">
            <h2>Calendar lifecycle</h2>
            <span className="status info right">
              {loaderData.invitations.length}
            </span>
          </div>
          {loaderData.invitations.length ? (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>Speaker</th>
                    <th>Provider</th>
                    <th>Lifecycle</th>
                  </tr>
                </thead>
                <tbody>
                  {loaderData.invitations.map((invitation) => (
                    <tr key={invitation.id}>
                      <td>
                        {invitation.sessionTitle}
                        <small>{invitation.icalUid}</small>
                      </td>
                      <td>
                        {invitation.personName}
                        <small>{invitation.email}</small>
                      </td>
                      <td>{invitation.provider ?? "Pending"}</td>
                      <td>
                        <span
                          className={`status ${invitation.status === "sent" || invitation.status === "confirmed" ? "success" : invitation.status === "failed" ? "danger" : "info"}`}
                        >
                          {invitation.method} · seq {invitation.sequenceNumber}{" "}
                          · {invitation.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty compact">
              <p>
                Published schedule updates will create stable-UID calendar
                operations here.
              </p>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

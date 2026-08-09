import { useEffect, useMemo, useState } from "react";
import {
  data,
  Link,
  redirect,
  useActionData,
  useNavigation,
} from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/communications-centre";
import {
  AudienceComposer,
  CalendarLifecycleTable,
  CommunicationPreviewConfirmation,
  RecentCommunications,
  TemplateEditor,
  TemplateVersionList,
} from "~/components/communications-centre-panels";
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
export type ActionResult = {
  ok: boolean;
  intent: string;
  message: string;
  preview?: CommunicationPreview;
  fields?: PreviewFields;
  idempotencyKey?: string;
  operationId?: string;
};

export type CommunicationsCentreLoaderData = Route.ComponentProps["loaderData"];

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
        <TemplateVersionList loaderData={loaderData} selected={selected} />
        <main className="stack">
          <TemplateEditor
            selected={selected}
            working={working}
            pendingIntent={pendingIntent}
            templateDirty={templateDirty}
            onDirty={() => setTemplateDirty(true)}
          />
          <AudienceComposer
            actionData={actionData}
            selected={selected}
            publishedTemplates={publishedTemplates}
            working={working}
            pendingIntent={pendingIntent}
          />
          <CommunicationPreviewConfirmation
            actionData={actionData}
            working={working}
            pendingIntent={pendingIntent}
          />
        </main>
      </div>

      <div className="grid grid-2 mt comms-history">
        <RecentCommunications
          loaderData={loaderData}
          working={working}
          pendingIntent={pendingIntent}
        />
        <CalendarLifecycleTable loaderData={loaderData} />
      </div>
    </>
  );
}

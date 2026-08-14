import { useCallback, useEffect, useMemo, useState } from "react";
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
  CalendarLifecycleTable,
  CalendarAdministration,
  CommunicationAutomation,
  DeliveryConfiguration,
  RecentCommunications,
  SenderDnsRecords,
  TemplateEditor,
  TemplateVersionList,
  type SenderDnsRecord,
  type SenderDnsRecordSet,
  type TemplateDraftFields,
} from "~/components/communications-centre-panels";
import { DraftRecoveryFeedback } from "~/components/draft-recovery-feedback";
import {
  AdminPageSection,
  AdminPageSectionNavigation,
} from "~/components/ui/admin-page-sections";
import { statusPresentation } from "~/components/ui/domain-status-badge";
import { CalendarService } from "~/modules/calendars/calendar-service.server";
import {
  CalendarQueueUnavailableError,
  CalendarStateError,
} from "~/modules/calendars/calendar-errors";
import {
  CalendarProviderConfigurationError,
  CalendarProviderRequestError,
} from "~/modules/calendars/calendar-providers.server";
import {
  CommunicationNotFoundError,
  CommunicationQueueUnavailableError,
  CommunicationService,
  CommunicationStateError,
  communicationErrorMessage,
} from "~/modules/communications/communication-service.server";
import {
  audienceTypeSchema,
  communicationCategorySchema,
  type AudienceType,
  type CommunicationCategory,
} from "~/modules/communications/communication-schema";
import { UnknownMergeVariableError } from "~/modules/communications/merge-template";
import { RecipientLimitError } from "~/modules/communications/recipient-query.server";
import { EventService } from "~/modules/events/event-service.server";
import {
  ResendDomainConfigurationError,
  ResendDomainRequestError,
} from "~/modules/communications/resend-domain.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  clearDraftRecoveryScope,
  useDraftRecovery,
} from "~/platform/drafts/draft-recovery";

export const meta = () => [{ title: "Communications Centre · Program Cue" }];

export type ActionResult = {
  ok: boolean;
  intent: string;
  message: string;
  operationId?: string;
  senderRecords?: SenderDnsRecordSet;
};

export type CommunicationsCentreLoaderData = Route.ComponentProps["loaderData"];

/**
 * Resend returns its DNS records as loosely typed objects, and the reader has
 * to copy every one of them into their DNS host for the domain to verify.
 *
 * Anything this cannot read is therefore kept verbatim rather than dropped: a
 * record silently missing from the table looks like a record that was not
 * required, and the domain then never verifies for a reason nothing on screen
 * explains.
 */
function senderDnsRecords(
  records: ReadonlyArray<unknown>,
): SenderDnsRecordSet {
  const text = (value: unknown) =>
    typeof value === "string"
      ? value
      : typeof value === "number"
        ? String(value)
        : null;
  const readable: SenderDnsRecord[] = [];
  const unreadable: string[] = [];
  for (const entry of records) {
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      const type = text(record.type);
      const name = text(record.name);
      const value = text(record.value);
      if (type && name && value) {
        readable.push({ type, name, value, priority: text(record.priority) });
        continue;
      }
    }
    unreadable.push(JSON.stringify(entry));
  }
  return { readable, unreadable };
}

async function viewerFor(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  return requireCurrentEventRole(request, env, ["owner", "administrator"]);
}
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await viewerFor(request, context);
  const search = new URL(request.url).searchParams;
  const activeFilter =
    search.get("filter") === "failed" ? ("failed" as const) : null;
  const requestedAudience = search.get("audience");
  const audiencePreset = requestedAudience
    ? audienceTypeSchema.safeParse(requestedAudience)
    : null;
  if (audiencePreset && !audiencePreset.success)
    throw new Response("Communication audience preset is invalid", {
      status: 400,
    });
  const requestedCategory = search.get("category");
  const categoryPreset = requestedCategory
    ? communicationCategorySchema.safeParse(requestedCategory)
    : null;
  if (categoryPreset && !categoryPreset.success)
    throw new Response("Communication category preset is invalid", {
      status: 400,
    });
  const communicationService = new CommunicationService(env);
  const calendarService = new CalendarService(env);
  const [
    centre,
    invitations,
    senders,
    triggers,
    connections,
    calendarTargets,
    event,
  ] = await Promise.all([
    communicationService.listCentre(viewer, {
      filter: activeFilter ?? undefined,
    }),
    calendarService.list(viewer),
    communicationService.listSenderProfiles(viewer),
    communicationService.listTriggers(viewer),
    calendarService.listConnections(viewer),
    calendarService.listTargets(viewer),
    new EventService(env).getSetup(viewer),
  ]);
  const requestedTemplate = search.get("template");
  const selected =
    requestedTemplate !== null
      ? (centre.templates.find((version) => version.id === requestedTemplate) ??
        null)
      : categoryPreset?.success
        ? (centre.templates.find(
            (version) =>
              version.versionStatus === "published" &&
              version.category === categoryPreset.data,
          ) ?? null)
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
  const requestedRecoveryRecord = search.get("recovery");
  const clearedRecoveryRecord =
    persistedSave &&
    requestedRecoveryRecord &&
    (requestedRecoveryRecord === "new" ||
      requestedRecoveryRecord === selected.templateId)
      ? requestedRecoveryRecord
      : null;
  const composedId = search.get("communication");
  const composedStatus = search.get("composed");
  const composedCommunication = centre.communications.find(
    (communication) =>
      communication.id === composedId &&
      communication.status === composedStatus &&
      ["queued", "scheduled", "sending", "sent"].includes(communication.status),
  );
  const discardedId = search.get("discarded");
  const discardedCommunication = centre.communications.find(
    (communication) =>
      communication.id === discardedId && communication.status === "cancelled",
  );
  return {
    ...centre,
    invitations,
    senders,
    triggers,
    connections,
    calendarTargets,
    testSendKey: crypto.randomUUID(),
    selected,
    recoveryScope: { eventId: viewer.eventId, personId: viewer.personId },
    clearedRecoveryRecord,
    activeFilter,
    audiencePreset: audiencePreset?.success
      ? (audiencePreset.data satisfies AudienceType)
      : null,
    categoryPreset: categoryPreset?.success
      ? (categoryPreset.data satisfies CommunicationCategory)
      : null,
    eventTimezone: event.timezone,
    notice: persistedSave
      ? `Draft version ${selected.versionNumber} saved.`
      : "",
    deliveryNotice: composedCommunication
      ? `This communication is ${statusPresentation("communication", composedCommunication.status).label.toLowerCase()}. That is the authoritative delivery result for the draft.`
      : discardedCommunication
        ? "The communication draft was discarded and retained as cancelled history."
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
    if (intent === "save-sender") {
      const saved = await service.saveSenderProfile(viewer, {
        id: String(form.get("senderProfileId") ?? "") || undefined,
        name: String(form.get("name") ?? ""),
        fromName: String(form.get("fromName") ?? ""),
        fromEmail: String(form.get("fromEmail") ?? ""),
        replyToEmail: String(form.get("replyToEmail") ?? ""),
      });
      return data<ActionResult>({
        ok: true,
        intent,
        message:
          saved.provider === "mailpit"
            ? `Sender profile ${saved.id} is verified for the explicitly selected local Mailpit capture service.`
            : `Sender profile ${saved.id} is saved. Check its Resend domain before using it.`,
      });
    }
    if (intent === "provision-sender") {
      const result = await service.provisionSenderProfile(
        viewer,
        String(form.get("senderProfileId") ?? ""),
      );
      const senderRecords =
        result.status === "verified"
          ? undefined
          : senderDnsRecords(result.records);
      // Only promise records "below" when there are records below. Resend
      // returns none while a domain is still being created, and pointing the
      // reader at an empty panel reads as a product fault.
      const publishedRecordCount = senderRecords
        ? senderRecords.readable.length + senderRecords.unreadable.length
        : 0;
      return data<ActionResult>({
        ok: result.status === "verified",
        intent,
        message:
          result.status === "verified"
            ? result.provider === "mailpit"
              ? "This sender is verified for the explicitly selected local Mailpit capture service."
              : `${result.domain} is verified by Resend and can send production email.`
            : publishedRecordCount > 0
              ? `${result.domain} is not verified yet. Publish the DNS records below with your domain host, then check again.`
              : `${result.domain} is not verified yet, and Resend has not returned its DNS records. Check the domain in your Resend dashboard, then check again here.`,
        senderRecords,
      });
    }
    if (intent === "disable-sender" || intent === "enable-sender") {
      const result = await service.setSenderProfileEnabled(
        viewer,
        String(form.get("senderProfileId") ?? ""),
        intent === "enable-sender",
      );
      return data<ActionResult>({
        ok: true,
        intent,
        message:
          result.status === "disabled"
            ? "This sender is disabled and can no longer send email."
            : result.status === "verified"
              ? "This sender is enabled and verified for sending."
              : "This sender is enabled, but still needs to be verified before it can send.",
      });
    }
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
        `/admin/communications?template=${encodeURIComponent(result.versionId)}&saved=${result.versionNumber}&recovery=${encodeURIComponent(String(form.get("templateId") ?? "") || "new")}`,
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
    if (intent === "test-send") {
      const result = await service.testSend(viewer, {
        templateVersionId: String(form.get("templateVersionId") ?? ""),
        recipient: String(form.get("recipient") ?? ""),
        idempotencyKey: String(form.get("idempotencyKey") ?? ""),
      });
      return data<ActionResult>({
        ok: true,
        intent,
        message:
          "The real test email is queued with representative merge data. Inspect provider progress in the Operation Centre.",
        operationId: result.operationId ?? undefined,
      });
    }
    if (intent === "save-trigger") {
      await service.saveTrigger(viewer, {
        id: String(form.get("triggerId") ?? "") || undefined,
        templateId: String(form.get("templateId") ?? ""),
        triggerType: String(form.get("triggerType") ?? "") as
          "task_due" | "task_overdue",
        audienceType: String(form.get("triggerAudience") ?? "") as
          "due_speakers" | "overdue_speakers" | "event_administrators",
        kind: String(form.get("kind") ?? "") as "transactional" | "optional",
        sendHourUtc: Number(form.get("sendHourUtc")),
        enabled: true,
      });
      return data<ActionResult>({
        ok: true,
        intent,
        message: "Automatic reminder trigger is active.",
      });
    }
    if (intent === "enable-trigger" || intent === "disable-trigger") {
      await service.setTriggerEnabled(
        viewer,
        String(form.get("triggerId") ?? ""),
        intent === "enable-trigger",
      );
      return data<ActionResult>({
        ok: true,
        intent,
        message: `Automatic reminder trigger ${intent === "enable-trigger" ? "enabled" : "disabled"}.`,
      });
    }
    const calendarService = new CalendarService(env);
    if (intent === "calendar-lifecycle") {
      const result = await calendarService.queueLifecycle(viewer, {
        sessionId: String(form.get("sessionId") ?? ""),
        personId: String(form.get("personId") ?? ""),
        method: String(form.get("method") ?? "") as "REQUEST" | "CANCEL",
        provider: String(form.get("provider") ?? "") as
          "email_ics" | "google" | "microsoft",
        ...(String(form.get("connectionId") ?? "")
          ? { connectionId: String(form.get("connectionId")) }
          : {}),
        idempotencyKey: String(form.get("idempotencyKey") ?? ""),
      });
      return data<ActionResult>({
        ok: true,
        intent,
        message: `${String(form.get("method")) === "CANCEL" ? "Cancellation" : "Calendar invitation"} is durable and queued.`,
        operationId: result.operationId,
      });
    }
    if (intent === "refresh-calendar") {
      await calendarService.refreshConnection(
        viewer,
        String(form.get("connectionId") ?? ""),
      );
      return data<ActionResult>({
        ok: true,
        intent,
        message:
          "Calendar access token refreshed and encrypted credentials rotated.",
      });
    }
    if (intent === "disconnect-calendar") {
      await calendarService.disconnect(
        viewer,
        String(form.get("connectionId") ?? ""),
      );
      return data<ActionResult>({
        ok: true,
        intent,
        message: "Calendar account disconnected.",
      });
    }
    if (intent === "reconcile-calendar-rsvp") {
      const result = await calendarService.reconcileAttendance(
        viewer,
        String(form.get("invitationId") ?? ""),
      );
      return data<ActionResult>({
        ok: true,
        intent,
        message: `Provider RSVP response is ${result.response.replaceAll("_", " ")}. Accepted invitations are marked confirmed; other responses remain visible in the audit trail without fabricating acceptance.`,
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
      error instanceof UnknownMergeVariableError ||
      error instanceof CalendarStateError ||
      error instanceof CalendarProviderConfigurationError ||
      error instanceof CalendarProviderRequestError ||
      error instanceof ResendDomainConfigurationError ||
      error instanceof ResendDomainRequestError
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
    if (error instanceof CalendarQueueUnavailableError) {
      return data<ActionResult>(
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

export default function CommunicationsCentre({
  loaderData,
}: Route.ComponentProps) {
  const actionData = useActionData<typeof action>() as ActionResult | undefined;
  const navigation = useNavigation();
  const selected = loaderData.selected;
  const working = navigation.state !== "idle";
  const pendingIntent = navigation.formData?.get("intent");
  const [templateDirty, setTemplateDirty] = useState(false);
  const templateFromServer = useMemo<TemplateDraftFields>(
    () => ({
      name: selected?.name ?? "",
      category: selected?.category ?? "ad_hoc",
      subject:
        selected?.subject ??
        "Hi {{recipient.firstName}} — an update from {{event.name}}",
      body:
        selected?.content.body ??
        "Hi {{recipient.firstName}},\n\nHere is an update from {{event.name}}.",
      physicalAddress:
        selected?.content.physicalAddress ?? "Program Cue event operations",
      buttonText: selected?.content.buttonText ?? "",
      buttonUrl: selected?.content.buttonUrl ?? "",
    }),
    [selected?.id],
  );
  const [templateDraft, setTemplateDraft] = useState(templateFromServer);
  const restoreTemplate = useCallback((draft: TemplateDraftFields) => {
    setTemplateDraft(draft);
    setTemplateDirty(true);
  }, []);
  const recovery = useDraftRecovery({
    scope: {
      ...loaderData.recoveryScope,
      recordType: "communication_template",
      recordId: selected?.templateId ?? "new",
    },
    serverRevision: `${selected?.id ?? "new"}:${selected?.versionNumber ?? 0}`,
    payload: templateDraft,
    dirty: templateDirty,
    onRestore: restoreTemplate,
  });
  useEffect(() => {
    setTemplateDraft(templateFromServer);
    setTemplateDirty(false);
  }, [selected?.id]);
  useEffect(() => {
    if (!loaderData.clearedRecoveryRecord) return;
    void clearDraftRecoveryScope({
      ...loaderData.recoveryScope,
      recordType: "communication_template",
      recordId: loaderData.clearedRecoveryRecord,
    });
  }, [loaderData.clearedRecoveryRecord, loaderData.recoveryScope]);
  useEffect(() => {
    if (actionData?.ok && actionData.intent === "publish-template") {
      void recovery.markServerSaved();
    }
  }, [actionData?.intent, actionData?.ok, recovery.markServerSaved]);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Communications Centre</h1>
          <p>
            Manage delivery configuration and versioned content, then launch a
            durable staged draft for each audience.
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn primary" to="/admin/communications/compose">
            New communication
          </Link>
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

      <AdminPageSectionNavigation
        label="Communications Centre sections"
        links={[
          { id: "communications-delivery", label: "Delivery" },
          { id: "communications-templates", label: "Templates" },
          { id: "communications-history", label: "History" },
          { id: "communications-automation", label: "Automation" },
          { id: "communications-calendars", label: "Calendars" },
        ]}
      />

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
      {loaderData.deliveryNotice ? (
        <div className="card pad mb validation-item ok" role="status">
          <strong>✓</strong>
          <span>{loaderData.deliveryNotice}</span>
        </div>
      ) : null}
      {loaderData.audiencePreset ? (
        <div className="card pad mb validation-item warn" role="status">
          <strong>Reminder preset</strong>
          <span>
            {loaderData.categoryPreset === "task_reminder"
              ? "The task-reminder audience is preselected; use the matching published template."
              : "An audience has been preselected."}{" "}
            Review the exact recipients in preview before confirming delivery.
          </span>
          <Link
            className="btn small"
            to={`/admin/communications/compose?${new URLSearchParams({
              audience: loaderData.audiencePreset,
              ...(loaderData.categoryPreset
                ? { category: loaderData.categoryPreset }
                : {}),
            })}`}
          >
            Start durable draft
          </Link>
        </div>
      ) : null}
      {actionData ? (
        <div
          className={`card pad mb validation-item ${actionData.ok ? "ok" : "error"}`}
          role={actionData.ok ? "status" : "alert"}
        >
          <strong>{actionData.ok ? "✓" : "△"}</strong>
          <div>
            {actionData.message}
            {actionData.operationId ? (
              <>
                {" "}
                <Link to="/admin/operations">Follow it in Operations</Link>
              </>
            ) : null}
            {actionData.senderRecords ? (
              <SenderDnsRecords records={actionData.senderRecords} />
            ) : null}
          </div>
        </div>
      ) : null}

      <AdminPageSection
        id="communications-delivery"
        label="Delivery configuration"
        description="Sender, provider and Queue readiness"
      >
        <div className="comms-provider-strip card pad mb">
          <span>
            <strong>Sender</strong>
            <small>
              {loaderData.provider.sender ?? "No verified sender profile"}
            </small>
          </span>
          <span>
            <strong>
              {loaderData.provider.name === "mailpit" ? "Mailpit" : "Resend"}
            </strong>
            <small>
              {loaderData.provider.configured
                ? loaderData.provider.name === "mailpit"
                  ? "Local capture endpoint and verified sender present"
                  : "API key and verified sender present"
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

        <DeliveryConfiguration
          loaderData={loaderData}
          working={working}
          pendingIntent={pendingIntent}
        />
      </AdminPageSection>

      <AdminPageSection
        id="communications-templates"
        label="Templates and composition"
        description="Versioned content and durable communication drafts"
        defaultExpandedOnMobile
      >
        <div className="comms-layout comms-production-layout">
          <TemplateVersionList loaderData={loaderData} selected={selected} />
          <main className="stack">
            <DraftRecoveryFeedback recovery={recovery} className="" />
            <TemplateEditor
              selected={selected}
              working={working}
              pendingIntent={pendingIntent}
              templateDirty={templateDirty}
              draft={templateDraft}
              recoveryState={recovery.state}
              onChange={(draft) => {
                setTemplateDraft(draft);
                setTemplateDirty(true);
              }}
            />
            <section className="card pad">
              <div className="card-title">
                <div>
                  <h2>Compose and send</h2>
                  <p className="help">
                    Audience configuration, preview and confirmation live in a
                    durable communication draft that can be resumed safely.
                  </p>
                </div>
                <Link
                  className="btn primary right"
                  to="/admin/communications/compose"
                >
                  New communication
                </Link>
              </div>
            </section>
          </main>
        </div>
      </AdminPageSection>

      <AdminPageSection
        id="communications-history"
        label="Communication history"
        description="Delivery records and calendar lifecycle"
      >
        <div className="grid grid-2 comms-history">
          <RecentCommunications
            loaderData={loaderData}
            working={working}
            pendingIntent={pendingIntent}
          />
          <CalendarLifecycleTable loaderData={loaderData} />
        </div>
      </AdminPageSection>
      <AdminPageSection
        id="communications-automation"
        label="Automatic reminders"
        description="Scheduled reminder and escalation policy"
      >
        <CommunicationAutomation
          loaderData={loaderData}
          working={working}
          pendingIntent={pendingIntent}
        />
      </AdminPageSection>
      <AdminPageSection
        id="communications-calendars"
        label="Calendar administration"
        description="Connections and published-session invitations"
      >
        <CalendarAdministration
          loaderData={loaderData}
          working={working}
          pendingIntent={pendingIntent}
        />
      </AdminPageSection>
    </>
  );
}

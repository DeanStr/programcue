import { data, redirect } from "react-router";
import { ZodError } from "zod";
import type {
  SenderDnsRecord,
  SenderDnsRecordSet,
} from "~/components/communications-centre-panels";
import { statusPresentation } from "~/components/ui/domain-status-badge";
import {
  CalendarQueueUnavailableError,
  CalendarStateError,
} from "~/modules/calendars/calendar-errors";
import {
  CalendarProviderConfigurationError,
  CalendarProviderRequestError,
} from "~/modules/calendars/calendar-providers.server";
import { CalendarService } from "~/modules/calendars/calendar-service.server";
import {
  type AudienceType,
  audienceTypeSchema,
  type CommunicationCategory,
  communicationCategorySchema,
} from "~/modules/communications/communication-schema";
import {
  CommunicationNotFoundError,
  CommunicationQueueUnavailableError,
  CommunicationService,
  CommunicationStateError,
  communicationErrorMessage,
} from "~/modules/communications/communication-service.server";
import {
  representativeMergeValues,
  UnknownMergeVariableError,
} from "~/modules/communications/merge-template";
import {
  OrganisationCommunicationSettingsConflictError,
  OrganisationCommunicationSettingsService,
} from "~/modules/communications/organisation-communication-settings.server";
import { RecipientLimitError } from "~/modules/communications/recipient-query.server";
import {
  ResendDomainConfigurationError,
  ResendDomainRequestError,
} from "~/modules/communications/resend-domain.server";
import { EventService } from "~/modules/events/event-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/communications-centre";

export type ActionResult = {
  ok: boolean;
  intent: string;
  message: string;
  operationId?: string;
  senderRecords?: SenderDnsRecordSet;
};

/**
 * Resend returns its DNS records as loosely typed objects, and the reader has
 * to copy every one of them into their DNS host for the domain to verify.
 *
 * Anything this cannot read is therefore kept verbatim rather than dropped: a
 * record silently missing from the table looks like a record that was not
 * required, and the domain then never verifies for a reason nothing on screen
 * explains.
 */
function senderDnsRecords(records: ReadonlyArray<unknown>): SenderDnsRecordSet {
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
  const selectedCommunicationId =
    search.get("deliveryCommunication")?.trim() ?? "";
  if (selectedCommunicationId.length > 200) {
    throw new Response("Communication selection is invalid.", { status: 400 });
  }
  const requestedDeliveryOffset = search.get("deliveryOffset") ?? "0";
  if (!/^\d+$/u.test(requestedDeliveryOffset)) {
    throw new Response("Delivery page is invalid.", { status: 400 });
  }
  const deliveryOffset = Number(requestedDeliveryOffset);
  if (!Number.isSafeInteger(deliveryOffset)) {
    throw new Response("Delivery page is invalid.", { status: 400 });
  }
  const requestedDeliveryPeriod = search.get("deliveryPeriod") ?? "90d";
  if (
    requestedDeliveryPeriod !== "90d" &&
    requestedDeliveryPeriod !== "lifetime"
  ) {
    throw new Response("Delivery health period is invalid.", { status: 400 });
  }
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
    deliveryHealth,
    organisationCommunicationSettings,
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
    communicationService.listDeliveryHealth(viewer, {
      communicationId: selectedCommunicationId || undefined,
      offset: deliveryOffset,
      period: requestedDeliveryPeriod === "lifetime" ? "lifetime" : "recent",
    }),
    new OrganisationCommunicationSettingsService(env).get(viewer),
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
    // Sender profiles, reminder triggers and calendar connections are set up
    // once and then left alone, so they are a destination rather than eight
    // more cards between the reader and the work they came here to do.
    view:
      search.get("view") === "setup" ? ("setup" as const) : ("centre" as const),
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
    templatePreviewMergeValues: {
      ...representativeMergeValues,
      "recipient.name": "Example recipient",
      "recipient.firstName": "Example",
      "event.name": event.name,
      "event.dates":
        event.startDate === event.endDate
          ? event.startDate
          : `${event.startDate} – ${event.endDate}`,
    },
    organisationPhysicalAddress:
      organisationCommunicationSettings.physicalAddress,
    organisationPhysicalAddressRevision:
      organisationCommunicationSettings.revision,
    canManageOrganisationCommunicationSettings:
      organisationCommunicationSettings.canManage,
    deliveryHealth,
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

export type CommunicationsCentreLoaderData = Awaited<ReturnType<typeof loader>>;

type CommunicationsViewer = Awaited<ReturnType<typeof viewerFor>>;

type CommunicationsIntentContext = {
  env: CloudflareEnvironment;
  viewer: CommunicationsViewer;
  service: CommunicationService;
  form: FormData;
  intent: string;
};

async function handleSenderIntent({
  env,
  viewer,
  service,
  form,
  intent,
}: CommunicationsIntentContext) {
  if (intent === "save-organisation-physical-address") {
    await new OrganisationCommunicationSettingsService(env).save(
      viewer,
      form.get("physicalAddress"),
      form.get("physicalAddressRevision"),
    );
    return data<ActionResult>({
      ok: true,
      intent,
      message: "The organisation postal address is saved.",
    });
  }
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
  return null;
}

async function handleTemplateAutomationIntent({
  viewer,
  service,
  form,
  intent,
}: CommunicationsIntentContext) {
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
        | "task_due"
        | "task_overdue",
      audienceType: String(form.get("triggerAudience") ?? "") as
        | "due_speakers"
        | "overdue_speakers"
        | "event_administrators",
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
  return null;
}

async function handleCalendarCommunicationIntent({
  env,
  viewer,
  service,
  form,
  intent,
}: CommunicationsIntentContext) {
  const calendarService = new CalendarService(env);
  if (intent === "calendar-lifecycle") {
    const result = await calendarService.queueLifecycle(viewer, {
      sessionId: String(form.get("sessionId") ?? ""),
      personId: String(form.get("personId") ?? ""),
      method: String(form.get("method") ?? "") as "REQUEST" | "CANCEL",
      provider: String(form.get("provider") ?? "") as
        | "email_ics"
        | "google"
        | "microsoft",
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
      message: "The unsent communication and queued deliveries were cancelled.",
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
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await viewerFor(request, context);
  const service = new CommunicationService(env);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  try {
    const intentContext = { env, viewer, service, form, intent };
    const senderResponse = await handleSenderIntent(intentContext);
    if (senderResponse) return senderResponse;
    const templateResponse =
      await handleTemplateAutomationIntent(intentContext);
    if (templateResponse) return templateResponse;
    return handleCalendarCommunicationIntent(intentContext);
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
      error instanceof OrganisationCommunicationSettingsConflictError ||
      error instanceof ResendDomainConfigurationError ||
      error instanceof ResendDomainRequestError
    ) {
      return data<ActionResult>(
        { ok: false, intent, message: communicationErrorMessage(error) },
        {
          status:
            error instanceof OrganisationCommunicationSettingsConflictError
              ? 409
              : 422,
        },
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

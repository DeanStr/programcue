import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useActionData, useNavigation } from "react-router";
import {
  SenderDnsRecords,
  type TemplateDraftFields,
} from "~/components/communications-centre-panels";
import {
  CommunicationsSetupView,
  CommunicationsWorkView,
} from "~/components/communications-centre-workspace";
import { AdminPageSectionNavigation } from "~/components/ui/admin-page-sections";
import {
  clearDraftRecoveryScope,
  useDraftRecovery,
} from "~/platform/drafts/draft-recovery";
import type { Route } from "./+types/communications-centre";
import {
  type ActionResult,
  action,
  loader,
} from "./communications-centre.server";

export type { CommunicationsCentreLoaderData } from "./communications-centre.server";
export { action, loader };

export const meta = () => [{ title: "Communications Centre · Program Cue" }];

export default function CommunicationsCentre({
  loaderData,
}: Route.ComponentProps) {
  const actionData = useActionData<typeof action>() as ActionResult | undefined;
  const navigation = useNavigation();
  const selected = loaderData.selected;
  const working = navigation.state !== "idle";
  const pendingIntent = navigation.formData?.get("intent");
  const [templateDirty, setTemplateDirty] = useState(false);
  const templateName = selected?.name ?? "";
  const templateCategory = selected?.category ?? "ad_hoc";
  const templateSubject =
    selected?.subject ??
    "Hi {{recipient.firstName}} — an update from {{event.name}}";
  const templateBody =
    selected?.content.body ??
    "Hi {{recipient.firstName}},\n\nHere is an update from {{event.name}}.";
  const templatePhysicalAddress =
    selected?.content.physicalAddress ?? loaderData.organisationPhysicalAddress;
  const templateButtonText = selected?.content.buttonText ?? "";
  const templateButtonUrl = selected?.content.buttonUrl ?? "";
  const templateFromServer = useMemo<TemplateDraftFields>(
    () => ({
      name: templateName,
      category: templateCategory,
      subject: templateSubject,
      body: templateBody,
      physicalAddress: templatePhysicalAddress,
      buttonText: templateButtonText,
      buttonUrl: templateButtonUrl,
    }),
    [
      templateBody,
      templateButtonText,
      templateButtonUrl,
      templateCategory,
      templateName,
      templatePhysicalAddress,
      templateSubject,
    ],
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: Template identity deliberately resets the editor even when two saved versions have identical content.
  useEffect(() => {
    setTemplateDraft(templateFromServer);
    setTemplateDirty(false);
  }, [selected?.id, templateFromServer]);
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
  const setup = loaderData.view === "setup";
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{setup ? "Delivery settings" : "Communications Centre"}</h1>
          <p>
            {setup
              ? "Sender profiles, reminder triggers and calendar connections. Set these up once; the Communications Centre is where the daily work happens."
              : "Publish versioned email content, then launch a durable staged draft for each audience."}
          </p>
        </div>
        <div className="page-actions">
          {setup ? (
            <Link className="btn" to="/admin/communications">
              Back to Communications Centre
            </Link>
          ) : (
            <>
              <Link className="btn primary" to="/admin/communications/compose">
                New communication
              </Link>
              <Link className="btn" to="/admin/operations">
                Operation Centre
              </Link>
            </>
          )}
        </div>
      </div>

      {setup ? (
        <AdminPageSectionNavigation
          label="Delivery settings sections"
          links={[
            { id: "communications-delivery", label: "Delivery" },
            { id: "communications-automation", label: "Automation" },
            { id: "communications-calendars", label: "Calendars" },
          ]}
        />
      ) : (
        <AdminPageSectionNavigation
          label="Communications Centre sections"
          links={[
            { id: "communications-templates", label: "Templates" },
            { id: "communications-history", label: "History" },
          ]}
        />
      )}

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

      {setup ? (
        <CommunicationsSetupView
          loaderData={loaderData}
          working={working}
          pendingIntent={pendingIntent}
        />
      ) : (
        <CommunicationsWorkView
          loaderData={loaderData}
          selected={selected}
          working={working}
          pendingIntent={pendingIntent}
          recovery={recovery}
          templateDirty={templateDirty}
          templateDraft={templateDraft}
          setTemplateDraft={setTemplateDraft}
          setTemplateDirty={setTemplateDirty}
        />
      )}
    </>
  );
}

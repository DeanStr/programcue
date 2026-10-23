import { Form } from "react-router";
import {
  CalendarAdministration,
  CalendarLifecycleTable,
  CommunicationAutomation,
  CommunicationDeliveryHealth,
  DeliveryConfiguration,
  DeliveryReadiness,
  RecentCommunications,
  type TemplateDraftFields,
  TemplateEditor,
  TemplatePreview,
  TemplateVersionList,
} from "~/components/communications-centre-panels";
import { DraftRecoveryFeedback } from "~/components/draft-recovery-feedback";
import { AdminPageSection } from "~/components/ui/admin-page-sections";
import { Button } from "~/components/ui/button";
import type { useDraftRecovery } from "~/platform/drafts/draft-recovery";
import type { CommunicationsCentreLoaderData } from "~/routes/communications-centre.server";

export function CommunicationsSetupView({
  loaderData,
  working,
  pendingIntent,
}: {
  loaderData: CommunicationsCentreLoaderData;
  working: boolean;
  pendingIntent: FormDataEntryValue | null | undefined;
}) {
  return (
    <>
      <AdminPageSection
        id="communications-delivery"
        label="Delivery configuration"
        defaultExpandedOnMobile
      >
        <section className="card pad mb">
          <div className="card-title">
            <div>
              <h3>Organisation email-footer address</h3>
              <p className="help">
                New templates copy this postal address into their editable
                footer.
              </p>
            </div>
          </div>
          {loaderData.canManageOrganisationCommunicationSettings ? (
            <Form method="post" className="stack">
              <input
                type="hidden"
                name="intent"
                value="save-organisation-physical-address"
              />
              <input
                type="hidden"
                name="physicalAddressRevision"
                value={loaderData.organisationPhysicalAddressRevision}
              />
              <label className="label">
                Complete postal address
                <textarea
                  className="textarea"
                  name="physicalAddress"
                  defaultValue={loaderData.organisationPhysicalAddress}
                  minLength={5}
                  maxLength={500}
                  required
                />
              </label>
              <Button type="submit" disabled={working}>
                Save organisation address
              </Button>
            </Form>
          ) : (
            <p className="validation-item info">
              An organisation owner must configure this address before new
              templates can be published with a compliant footer.
            </p>
          )}
        </section>
        <DeliveryConfiguration
          loaderData={loaderData}
          working={working}
          pendingIntent={pendingIntent}
        />
      </AdminPageSection>
      <AdminPageSection
        id="communications-automation"
        label="Automatic reminders"
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

export function CommunicationsWorkView({
  loaderData,
  selected,
  working,
  pendingIntent,
  recovery,
  templateDirty,
  templateDraft,
  setTemplateDraft,
  setTemplateDirty,
}: {
  loaderData: CommunicationsCentreLoaderData;
  selected: CommunicationsCentreLoaderData["selected"];
  working: boolean;
  pendingIntent: FormDataEntryValue | null | undefined;
  recovery: ReturnType<typeof useDraftRecovery>;
  templateDirty: boolean;
  templateDraft: TemplateDraftFields;
  setTemplateDraft(value: TemplateDraftFields): void;
  setTemplateDirty(value: boolean): void;
}) {
  return (
    <>
      <DeliveryReadiness loaderData={loaderData} />

      <AdminPageSection
        id="communications-templates"
        label="Templates"
        defaultExpandedOnMobile
      >
        <div className="comms-workbench">
          <TemplateVersionList loaderData={loaderData} selected={selected} />
          <div className="stack comms-workbench-editor">
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
          </div>
          <TemplatePreview
            draft={templateDraft}
            mergeValues={loaderData.templatePreviewMergeValues}
          />
        </div>
      </AdminPageSection>

      <AdminPageSection id="communications-history" label="History">
        <CommunicationDeliveryHealth loaderData={loaderData} />
        <div className="comms-history comms-activity-grid">
          <RecentCommunications
            loaderData={loaderData}
            working={working}
            pendingIntent={pendingIntent}
          />
          <CalendarLifecycleTable loaderData={loaderData} />
        </div>
      </AdminPageSection>
    </>
  );
}

import { useEffect, useState } from "react";
import { useActionData, useNavigation } from "react-router";
import { AdminSpeakerDetailHeader } from "~/components/admin-speaker-detail-header";
import { SpeakerActionNotice } from "~/components/speaker-action-notice";
import { ConfirmDialog, useConfirm } from "~/components/ui/confirm-dialog";
import { useUnsavedChanges } from "~/components/ui/use-unsaved-changes";
import type { action } from "~/routes/admin-speaker-detail";
import type { AdminSpeakerDetailLoaderData } from "./admin-speaker-detail-presentation";
import {
  AdminSpeakerFilesPanel,
  AdminSpeakerHeadshotPanel,
} from "./admin-speaker-file-panels";
import {
  AdminSpeakerAvailabilityPanel,
  AdminSpeakerSessionsPanel,
} from "./admin-speaker-participation-panels";
import { AdminSpeakerProfilePanel } from "./admin-speaker-profile-panels";

export function AdminSpeakerDetailPage({
  loaderData,
}: {
  loaderData: AdminSpeakerDetailLoaderData;
}) {
  const { detail, availability, customFields } = loaderData;
  const { profile, sessions, files, tasks } = detail;
  const headshot = files.find(
    (file) =>
      file.kind === "headshot" &&
      file.targetType === "person" &&
      file.targetId === profile.id &&
      file.currentVersionId &&
      file.downloadReleasedAt &&
      file.downloadUploadedAt &&
      file.downloadFilename &&
      file.downloadUploaderName,
  );
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [profileDirty, setProfileDirty] = useState(false);
  const blocker = useUnsavedChanges(profileDirty);
  const { confirm: confirmAction, dialog: actionDialog } = useConfirm();
  // biome-ignore lint/correctness/useExhaustiveDependencies: These persisted version tokens deliberately clear dirty state after either profile scope is saved, including when normalized values remain unchanged.
  useEffect(
    () => setProfileDirty(false),
    [
      profile.organisationProfileOperationId,
      profile.revision,
      profile.travelProfileOperationId,
    ],
  );
  return (
    <>
      {blocker.state === "blocked" ? (
        <ConfirmDialog
          title="Leave without saving this speaker profile?"
          description="The profile changes on this page have not been saved."
          confirmLabel="Leave and discard"
          cancelLabel="Keep editing"
          onCancel={() => blocker.reset()}
          onConfirm={() => blocker.proceed()}
        />
      ) : null}
      {actionDialog}
      <div className="crm-workspace crm-record">
        <AdminSpeakerDetailHeader
          profile={profile}
          headshot={headshot}
          sessionCount={sessions.length}
          outstandingTaskCount={tasks.outstanding}
          fileCount={files.length}
        />
        <SpeakerActionNotice notice={actionData} />
        <div className="crm-record-grid">
          <AdminSpeakerProfilePanel
            detail={detail}
            customFields={customFields}
            busy={busy}
            onDirty={() => setProfileDirty(true)}
          />
          <AdminSpeakerHeadshotPanel detail={detail} headshot={headshot} />
        </div>
        <AdminSpeakerAvailabilityPanel
          detail={detail}
          availability={availability}
          busy={busy}
          confirmAction={confirmAction}
        />
        <AdminSpeakerSessionsPanel
          detail={detail}
          busy={busy}
          confirmAction={confirmAction}
        />
        <AdminSpeakerFilesPanel detail={detail} />
      </div>
    </>
  );
}

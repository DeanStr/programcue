import { Plus } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { useMemo } from "react";
import { Form } from "react-router";

import {
  SitePanelHeading,
  SiteRecordDisclosure,
} from "~/components/admin-public-site-panels";
import { RestrictedMarkdownEditor } from "~/components/restricted-markdown-editor";
import { Button } from "~/components/ui/button";
import type { PublishedProgramme } from "~/modules/programme/public-programme-types";
import type { PublicRecordingWorkspaceItem } from "~/modules/public-site/public-recording-service.server";
import type { PublicSiteDraft } from "~/modules/public-site/public-site";

function RecordingFields({
  recording,
  disabled,
}: {
  recording?: PublicRecordingWorkspaceItem;
  disabled: boolean;
}) {
  return (
    <div className="public-site-field-grid">
      <label className="label is-wide">
        {recording ? "Title" : "Recording title"}
        <input
          className="field"
          name="title"
          required
          maxLength={160}
          defaultValue={recording?.draftTitle}
          disabled={disabled}
        />
      </label>
      <label className="label is-wide">
        {recording ? "Recording URL" : "External recording URL"}
        <input
          className="field"
          name="recordingUrl"
          required
          type="url"
          defaultValue={recording?.draftRecordingUrl}
          disabled={disabled}
        />
      </label>
      <label className="label">
        Captions URL
        <input
          className="field"
          name="captionsUrl"
          type="url"
          defaultValue={recording?.draftCaptionsUrl ?? ""}
          disabled={disabled}
        />
      </label>
      <label className="label">
        Transcript URL
        <input
          className="field"
          name="transcriptUrl"
          type="url"
          defaultValue={recording?.draftTranscriptUrl ?? ""}
          disabled={disabled}
        />
      </label>
    </div>
  );
}

function recordingPublicationState(recording: PublicRecordingWorkspaceItem) {
  if (recording.publishedAt === null) return "Draft only";
  return recording.publishedRevision === recording.draftRevision
    ? "Published"
    : "Changes waiting";
}

/* Post-event mode and the recordings it reveals were two disconnected controls
   several screens apart. The switch that turns the section on now sits above
   the records it publishes. */
function PostEventSettings({
  configuration,
  setConfiguration,
  programme,
  programmeFeaturesAvailable,
}: {
  configuration: PublicSiteDraft;
  setConfiguration: Dispatch<SetStateAction<PublicSiteDraft>>;
  programme: PublishedProgramme | null;
  programmeFeaturesAvailable: boolean;
}) {
  return (
    <div className="public-site-post-event">
      <label className="public-site-inline-check">
        <input
          type="checkbox"
          checked={configuration.postEvent.enabled}
          disabled={
            (!programme || !programmeFeaturesAvailable) &&
            !configuration.postEvent.enabled
          }
          onChange={(event) =>
            setConfiguration((current) => ({
              ...current,
              postEvent: {
                ...current.postEvent,
                enabled: event.target.checked,
              },
            }))
          }
        />
        <span>Show published recordings after the event ends</span>
      </label>
      {programmeFeaturesAvailable ? null : (
        <p className="help">
          Post-event recordings are unavailable for this event's programme
          source.
        </p>
      )}
      <label className="label">
        Heading
        <input
          className="field"
          maxLength={120}
          value={configuration.postEvent.heading}
          onChange={(event) =>
            setConfiguration((current) => ({
              ...current,
              postEvent: { ...current.postEvent, heading: event.target.value },
            }))
          }
        />
      </label>
      <RestrictedMarkdownEditor
        label="Introduction"
        maximumLength={2_000}
        value={configuration.postEvent.body}
        onChange={(body) =>
          setConfiguration((current) => ({
            ...current,
            postEvent: { ...current.postEvent, body },
          }))
        }
      />
    </div>
  );
}

export function AdminPublicSiteRecordings({
  recordings,
  programme,
  programmeFeaturesAvailable,
  configuration,
  setConfiguration,
  blockedReason,
  busy,
  hidden,
  onPublish,
  onUnpublish,
}: {
  recordings: PublicRecordingWorkspaceItem[];
  programme: PublishedProgramme | null;
  programmeFeaturesAvailable: boolean;
  configuration: PublicSiteDraft;
  setConfiguration: Dispatch<SetStateAction<PublicSiteDraft>>;
  /* Why these controls are unavailable, or null when they are not. Withdrawal
     stays available regardless: a published recording is public now. */
  blockedReason: string | null;
  busy: boolean;
  hidden: boolean;
  onPublish: (recording: PublicRecordingWorkspaceItem) => void;
  onUnpublish: (recording: PublicRecordingWorkspaceItem) => void;
}) {
  const commandIds = useMemo(() => {
    const ids = new Map(
      recordings.map(
        (recording) => [recording.id, crypto.randomUUID()] as const,
      ),
    );
    ids.set("", crypto.randomUUID());
    return ids;
  }, [recordings]);
  const blocked = blockedReason !== null;
  const availableSessions =
    programme?.sessions.filter(
      (session) =>
        !recordings.some((recording) => recording.sessionId === session.id),
    ) ?? [];
  return (
    <section
      className="public-site-editor-panel"
      aria-label="Session recordings"
      hidden={hidden}
    >
      <SitePanelHeading
        title="Post-event mode"
        help="Recordings appear on the event website only after their session and the event have ended."
      />
      <PostEventSettings
        configuration={configuration}
        setConfiguration={setConfiguration}
        programme={programme}
        programmeFeaturesAvailable={programmeFeaturesAvailable}
      />

      <SitePanelHeading
        title="Session recordings"
        help="Only external HTTPS recordings are supported in this slice. Saving never implies upload or publication."
      />
      {blockedReason ? (
        <p className="validation-item warn" role="status">
          {blockedReason}
        </p>
      ) : null}
      {programmeFeaturesAvailable ? null : (
        <p className="validation-item warn" role="status">
          Recording drafts and publication are unavailable for this event's
          programme source. Published recordings can still be withdrawn.
        </p>
      )}
      {recordings.length ? (
        <div className="public-site-record-list">
          {recordings.map((recording) => (
            <SiteRecordDisclosure
              key={recording.id}
              title={recording.sessionTitle}
              meta={recording.draftTitle}
              state={recordingPublicationState(recording)}
            >
              <Form method="post" className="public-site-record-editor">
                <input type="hidden" name="intent" value="save-recording" />
                <input
                  type="hidden"
                  name="commandId"
                  value={commandIds.get(recording.id)}
                />
                <input type="hidden" name="id" value={recording.id} />
                <input
                  type="hidden"
                  name="sessionId"
                  value={recording.sessionId}
                />
                <input
                  type="hidden"
                  name="revision"
                  value={recording.draftRevision}
                />
                <RecordingFields
                  recording={recording}
                  disabled={!programmeFeaturesAvailable}
                />
                <div className="page-actions">
                  <Button
                    size="small"
                    type="submit"
                    disabled={blocked || busy || !programmeFeaturesAvailable}
                  >
                    Save recording draft
                  </Button>
                  <Button
                    variant="primary"
                    size="small"
                    type="button"
                    disabled={
                      blocked ||
                      busy ||
                      !programmeFeaturesAvailable ||
                      recording.publishedRevision === recording.draftRevision
                    }
                    onClick={() => onPublish(recording)}
                  >
                    {recording.publishedAt
                      ? "Publish update"
                      : "Publish recording"}
                  </Button>
                  {recording.publishedAt ? (
                    <Button
                      variant="danger"
                      size="small"
                      type="button"
                      disabled={busy}
                      onClick={() => onUnpublish(recording)}
                    >
                      Withdraw
                    </Button>
                  ) : null}
                </div>
              </Form>
            </SiteRecordDisclosure>
          ))}
        </div>
      ) : (
        <p className="help">No recording drafts for this event yet.</p>
      )}
      {programme && programmeFeaturesAvailable ? (
        <Form method="post" className="public-site-record-editor is-new">
          <input type="hidden" name="intent" value="save-recording" />
          <input type="hidden" name="commandId" value={commandIds.get("")} />
          <input type="hidden" name="id" value="" />
          <input type="hidden" name="revision" value="0" />
          <h3 className="public-site-panel-title">Add a recording draft</h3>
          <label className="label">
            Published session
            <select
              className="select"
              name="sessionId"
              required
              defaultValue=""
            >
              <option value="" disabled>
                Select a session
              </option>
              {availableSessions.map((session) => (
                <option value={session.id} key={session.id}>
                  {session.title}
                </option>
              ))}
            </select>
          </label>
          <RecordingFields disabled={false} />
          <div className="page-actions">
            <Button
              size="small"
              type="submit"
              disabled={blocked || busy || !availableSessions.length}
            >
              <Plus aria-hidden size={14} /> Create recording draft
            </Button>
          </div>
          {availableSessions.length ? null : (
            <p className="help">
              Every published session already has a recording draft.
            </p>
          )}
        </Form>
      ) : !programme ? (
        <p className="help">
          Publish a programme before creating recording drafts.
        </p>
      ) : null}
    </section>
  );
}

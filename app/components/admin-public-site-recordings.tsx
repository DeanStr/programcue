import { useMemo } from "react";
import { Form } from "react-router";

import { SiteRailDisclosure } from "~/components/admin-public-site-disclosure";
import type { PublishedProgramme } from "~/modules/programme/public-programme-types";
import type { PublicRecordingWorkspaceItem } from "~/modules/public-site/public-recording-service.server";

function RecordingFields({
  recording,
  disabled,
}: {
  recording?: PublicRecordingWorkspaceItem;
  disabled: boolean;
}) {
  return (
    <>
      <label className="label">
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
      <label className="label">
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
    </>
  );
}

export function AdminPublicSiteRecordings({
  recordings,
  programme,
  programmeFeaturesAvailable,
  blocked,
  busy,
  onPublish,
  onUnpublish,
}: {
  recordings: PublicRecordingWorkspaceItem[];
  programme: PublishedProgramme | null;
  programmeFeaturesAvailable: boolean;
  blocked: boolean;
  busy: boolean;
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
  return (
    <SiteRailDisclosure
      title="Session recordings"
      preview={
        !programmeFeaturesAvailable
          ? "Unavailable for this programme source"
          : recordings.length
            ? `${recordings.length} recording${
                recordings.length === 1 ? "" : "s"
              } · ${recordings
                .slice(0, 2)
                .map((recording) => recording.sessionTitle)
                .join(" · ")}`
            : "None yet"
      }
      help="Only external HTTPS recordings are supported in this slice. Saving never implies upload or publication."
    >
      {!programmeFeaturesAvailable ? (
        <p className="validation-item warn" role="status">
          Recording drafts and publication are unavailable for this event's
          programme source. Published recordings can still be withdrawn.
        </p>
      ) : null}
      {recordings.map((recording) => (
        <Form
          method="post"
          className="public-site-record-editor"
          key={recording.id}
        >
          <input type="hidden" name="intent" value="save-recording" />
          <input
            type="hidden"
            name="commandId"
            value={commandIds.get(recording.id)}
          />
          <input type="hidden" name="id" value={recording.id} />
          <input type="hidden" name="sessionId" value={recording.sessionId} />
          <input
            type="hidden"
            name="revision"
            value={recording.draftRevision}
          />
          <strong>{recording.sessionTitle}</strong>
          <RecordingFields
            recording={recording}
            disabled={!programmeFeaturesAvailable}
          />
          <div className="page-actions">
            <button
              className="btn small"
              type="submit"
              disabled={blocked || busy || !programmeFeaturesAvailable}
            >
              Save recording draft
            </button>
            <button
              className="btn small primary"
              type="button"
              disabled={
                blocked ||
                busy ||
                !programmeFeaturesAvailable ||
                recording.publishedRevision === recording.draftRevision
              }
              onClick={() => onPublish(recording)}
            >
              {recording.publishedAt ? "Publish update" : "Publish recording"}
            </button>
            {recording.publishedAt ? (
              <button
                className="btn small danger"
                type="button"
                disabled={busy}
                onClick={() => onUnpublish(recording)}
              >
                Withdraw
              </button>
            ) : null}
          </div>
        </Form>
      ))}
      {programme && programmeFeaturesAvailable ? (
        <Form method="post" className="public-site-record-editor">
          <input type="hidden" name="intent" value="save-recording" />
          <input type="hidden" name="commandId" value={commandIds.get("")} />
          <input type="hidden" name="id" value="" />
          <input type="hidden" name="revision" value="0" />
          <label className="label">
            Published session
            <select className="field" name="sessionId" required defaultValue="">
              <option value="" disabled>
                Select a session
              </option>
              {programme.sessions
                .filter(
                  (session) =>
                    !recordings.some(
                      (recording) => recording.sessionId === session.id,
                    ),
                )
                .map((session) => (
                  <option value={session.id} key={session.id}>
                    {session.title}
                  </option>
                ))}
            </select>
          </label>
          <RecordingFields disabled={false} />
          <button
            className="btn small"
            type="submit"
            disabled={blocked || busy}
          >
            Create recording draft
          </button>
        </Form>
      ) : !programme ? (
        <p className="help">
          Publish a programme before creating recording drafts.
        </p>
      ) : null}
    </SiteRailDisclosure>
  );
}

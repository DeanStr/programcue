import { Form } from "react-router";

import type { PublishedProgramme } from "~/modules/programme/public-programme-types";
import type { PublicRecordingWorkspaceItem } from "~/modules/public-site/public-recording-service.server";

function RecordingFields({
  recording,
}: {
  recording?: PublicRecordingWorkspaceItem;
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
        />
      </label>
      <label className="label">
        Captions URL
        <input
          className="field"
          name="captionsUrl"
          type="url"
          defaultValue={recording?.draftCaptionsUrl ?? ""}
        />
      </label>
      <label className="label">
        Transcript URL
        <input
          className="field"
          name="transcriptUrl"
          type="url"
          defaultValue={recording?.draftTranscriptUrl ?? ""}
        />
      </label>
    </>
  );
}

export function AdminPublicSiteRecordings({
  recordings,
  programme,
  blocked,
  busy,
  onPublish,
  onUnpublish,
}: {
  recordings: PublicRecordingWorkspaceItem[];
  programme: PublishedProgramme | null;
  blocked: boolean;
  busy: boolean;
  onPublish: (recording: PublicRecordingWorkspaceItem) => void;
  onUnpublish: (recording: PublicRecordingWorkspaceItem) => void;
}) {
  return (
    <section className="card pad">
      <div className="card-title">
        <div>
          <h2>Session recordings</h2>
          <p className="help">
            Only external HTTPS recordings are supported in this slice. Saving
            never implies upload or publication.
          </p>
        </div>
      </div>
      {recordings.map((recording) => (
        <Form
          method="post"
          className="public-site-record-editor"
          key={recording.id}
        >
          <input type="hidden" name="intent" value="save-recording" />
          <input type="hidden" name="id" value={recording.id} />
          <input type="hidden" name="sessionId" value={recording.sessionId} />
          <input
            type="hidden"
            name="revision"
            value={recording.draftRevision}
          />
          <strong>{recording.sessionTitle}</strong>
          <RecordingFields recording={recording} />
          <div className="page-actions">
            <button
              className="btn small"
              type="submit"
              disabled={blocked || busy}
            >
              Save recording draft
            </button>
            <button
              className="btn small primary"
              type="button"
              disabled={
                blocked ||
                busy ||
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
                disabled={blocked || busy}
                onClick={() => onUnpublish(recording)}
              >
                Withdraw
              </button>
            ) : null}
          </div>
        </Form>
      ))}
      {programme ? (
        <Form method="post" className="public-site-record-editor">
          <input type="hidden" name="intent" value="save-recording" />
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
          <RecordingFields />
          <button
            className="btn small"
            type="submit"
            disabled={blocked || busy}
          >
            Create recording draft
          </button>
        </Form>
      ) : (
        <p className="help">
          Publish a programme before creating recording drafts.
        </p>
      )}
    </section>
  );
}

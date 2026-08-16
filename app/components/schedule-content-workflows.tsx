import { useCallback, useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";

import {
  DraftRecoveryFeedback,
  DraftRecoveryStatus,
} from "~/components/draft-recovery-feedback";
import { CharacterCount } from "~/components/ui/character-count";
import type {
  ScheduleSession,
  ScheduleWorkspace,
} from "~/modules/schedule/schedule-service.server";
import { useDraftRecovery } from "~/platform/drafts/draft-recovery";
import {
  commandId,
  downloadRecovery,
  type EditorActionData,
  PersistenceStatus,
  type RecoveryScope,
  type ScheduleCalendarPreview,
  statusFor,
  useOnlineState,
  useScheduleAutosave,
} from "./schedule-content-editor-shared";
import { SessionContentEditor } from "./schedule-session-content-editor";

export type { ScheduleCalendarPreview } from "./schedule-content-editor-shared";

function ScheduleNotesEditor({
  workspace,
  recoveryScope,
}: {
  workspace: ScheduleWorkspace;
  recoveryScope: RecoveryScope;
}) {
  const version = workspace.version;
  const editable = version?.status === "draft";
  const [notes, setNotes] = useState(version?.notes ?? "");
  const notesRef = useRef(notes);
  const [savedNotes, setSavedNotes] = useState(version?.notes ?? "");
  const [scheduleRevision, setScheduleRevision] = useState(
    version?.revision ?? 0,
  );
  const [serverError, setServerError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<NonNullable<
    ScheduleWorkspace["version"]
  > | null>(null);
  const [saved, setSaved] = useState(false);
  const fetcher = useFetcher<EditorActionData>();
  const online = useOnlineState();
  const dirty = notes !== savedNotes;
  const operationRef = useRef<{ key: string; notes: string } | null>(null);
  const submittedNotesRef = useRef<string | null>(null);
  const handledDataRef = useRef<EditorActionData | null>(null);
  notesRef.current = notes;
  const recovery = useDraftRecovery({
    scope:
      editable && version
        ? {
            ...recoveryScope,
            recordType: "schedule_notes",
            recordId: version.id,
          }
        : null,
    serverRevision: `${version?.id ?? "none"}:${scheduleRevision}`,
    payload: { notes },
    dirty,
    onRestore: (payload) => {
      setNotes(payload.notes);
      setSaved(false);
      setServerError(null);
    },
    enabled: editable,
  });
  const submit = useCallback(
    (revisionOverride?: number) => {
      if (!editable || !version || !online || fetcher.state !== "idle") return;
      const currentNotes = notesRef.current;
      if (!operationRef.current || operationRef.current.notes !== currentNotes)
        operationRef.current = { key: commandId(), notes: currentNotes };
      const values = new FormData();
      values.set("intent", "save-schedule-notes");
      values.set("scheduleVersionId", version.id);
      values.set(
        "scheduleRevision",
        String(revisionOverride ?? scheduleRevision),
      );
      values.set("idempotencyKey", operationRef.current.key);
      values.set("notes", currentNotes);
      submittedNotesRef.current = currentNotes;
      setServerError(null);
      setSaved(false);
      void fetcher.submit(values, { method: "post" });
    },
    [editable, fetcher, online, scheduleRevision, version],
  );

  useScheduleAutosave({
    enabled: editable,
    dirty,
    online,
    blocked: Boolean(serverError || conflict),
    fetcherState: fetcher.state,
    recoveryState: recovery.state,
    changeToken: notes,
    submit,
  });

  useEffect(() => {
    const result = fetcher.data;
    if (
      fetcher.state !== "idle" ||
      !result ||
      result === handledDataRef.current ||
      result.intent !== "save-schedule-notes"
    )
      return;
    handledDataRef.current = result;
    if (result.ok && result.scheduleVersionId === version?.id) {
      if (!Number.isSafeInteger(result.scheduleRevision)) {
        setServerError("The server saved notes without returning a revision.");
        return;
      }
      setScheduleRevision(result.scheduleRevision!);
      if (submittedNotesRef.current === notesRef.current) {
        setSavedNotes(notesRef.current);
        setSaved(true);
        void recovery.markServerSaved();
      }
      operationRef.current = null;
      submittedNotesRef.current = null;
      return;
    }
    if (result.conflict && result.currentVersion) {
      setConflict(result.currentVersion);
      setServerError(null);
      return;
    }
    setServerError(result.error ?? "Schedule notes could not be saved.");
  }, [fetcher.data, fetcher.state, recovery.markServerSaved, version?.id]);

  useEffect(() => {
    if (!version || version.revision === scheduleRevision) return;
    if (fetcher.state !== "idle") return;
    const ownSave =
      fetcher.data?.ok === true &&
      fetcher.data.intent === "save-schedule-notes" &&
      fetcher.data.scheduleVersionId === version.id &&
      fetcher.data.scheduleRevision === version.revision;
    if (ownSave) {
      setScheduleRevision(version.revision);
      return;
    }
    if (dirty) {
      setConflict(version);
      return;
    }
    setNotes(version.notes);
    setSavedNotes(version.notes);
    setScheduleRevision(version.revision);
    setSaved(false);
  }, [dirty, fetcher.data, fetcher.state, scheduleRevision, version]);

  const status = statusFor({
    conflict: Boolean(conflict),
    online,
    serverError,
    submitting: fetcher.state !== "idle",
    dirty,
    saved,
    restored: recovery.state === "restored",
  });
  return (
    <section
      className="card pad mt"
      aria-labelledby="schedule-notes-title"
      data-testid="schedule-notes-editor"
    >
      <div className="card-title">
        <div>
          <span className="pc-page-eyebrow">Draft-only operations context</span>
          <h2 id="schedule-notes-title">Schedule notes</h2>
        </div>
        <span className="row-actions right">
          {status ? <PersistenceStatus {...status} /> : null}
          <DraftRecoveryStatus state={recovery.state} />
        </span>
      </div>
      <p className="help">
        Notes belong to this schedule version. Publishing freezes them; editing
        resumes only on the next draft.
      </p>
      <DraftRecoveryFeedback recovery={recovery} />
      {serverError ? (
        <div className="validation-item error mb" role="alert">
          <strong>Retry required</strong>
          <span>{serverError}</span>
          <button
            className="btn small right"
            type="button"
            onClick={() => submit()}
          >
            Retry the same save
          </button>
        </div>
      ) : null}
      {conflict ? (
        <div className="validation-item error card pad mb" role="alert">
          <strong>Schedule-notes conflict</strong>
          <span>
            The draft changed after these notes loaded. Nothing was overwritten.
          </span>
          <span className="row-actions right">
            <button
              className="btn small"
              type="button"
              onClick={() =>
                downloadRecovery("schedule-notes-recovery.json", { notes })
              }
            >
              Export local notes
            </button>
            <button
              className="btn small"
              type="button"
              onClick={() => {
                setNotes(conflict.notes);
                setSavedNotes(conflict.notes);
                setScheduleRevision(conflict.revision);
                setConflict(null);
                setServerError(null);
                operationRef.current = null;
                void recovery.clear();
              }}
            >
              Load server notes
            </button>
            <button
              className="btn small primary"
              type="button"
              onClick={() => {
                const revision = conflict.revision;
                setScheduleRevision(revision);
                setConflict(null);
                operationRef.current = null;
                window.setTimeout(() => submit(revision), 0);
              }}
            >
              Save my notes
            </button>
          </span>
        </div>
      ) : null}
      <textarea
        className="textarea"
        rows={6}
        maxLength={12_000}
        aria-label="Schedule notes"
        value={notes}
        disabled={!editable}
        onChange={(event) => {
          setNotes(event.target.value);
          setServerError(null);
          setSaved(false);
        }}
      />
      <CharacterCount value={notes} maximum={12_000} />
    </section>
  );
}

export function ScheduleContentWorkflows({
  workspace,
  session,
  recoveryScope,
  calendarPreview,
}: {
  workspace: ScheduleWorkspace;
  session: ScheduleSession | null;
  recoveryScope: RecoveryScope;
  calendarPreview: ScheduleCalendarPreview | null;
}) {
  return (
    <>
      <ScheduleNotesEditor
        key={`notes:${workspace.version?.id ?? "none"}`}
        workspace={workspace}
        recoveryScope={recoveryScope}
      />
      {session ? (
        <SessionContentEditor
          key={`session:${session.id}`}
          workspace={workspace}
          session={session}
          recoveryScope={recoveryScope}
          calendarPreview={calendarPreview}
        />
      ) : null}
    </>
  );
}

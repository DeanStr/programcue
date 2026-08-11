import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useFetcher } from "react-router";

import {
  DraftRecoveryFeedback,
  DraftRecoveryStatus,
} from "~/components/draft-recovery-feedback";
import type {
  ScheduleSession,
  ScheduleWorkspace,
} from "~/modules/schedule/schedule-service.server";
import { useDraftRecovery } from "~/platform/drafts/draft-recovery";

type RecoveryScope = { eventId: string; personId: string };

export type ScheduleCalendarPreview = {
  payload: {
    uid: string;
    sequence: number;
    method: "REQUEST";
    title: string;
    description: string;
    location: string;
    startsAt: number;
    endsAt: number;
    organizerName: string;
    organizerEmail: string;
    attendeeName: string;
    attendeeEmail: string;
  };
  ics: string;
};

type EditorActionData = {
  ok: boolean;
  intent?: string;
  error?: string;
  warning?: string | null;
  conflict?: boolean;
  retryable?: boolean;
  revision?: number;
  scheduleRevision?: number;
  sessionId?: string;
  scheduleVersionId?: string;
  currentSession?: ScheduleSession | null;
  currentVersion?: ScheduleWorkspace["version"];
};

type SessionContentDraft = Pick<
  ScheduleSession,
  | "title"
  | "description"
  | "format"
  | "durationMinutes"
  | "trackId"
  | "visibility"
  | "requiredResources"
>;

function fingerprint(value: unknown) {
  return JSON.stringify(value);
}

function commandId() {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function")
    throw new Error("Secure editor save identifiers are unavailable.");
  return crypto.randomUUID();
}

function useOnlineState() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}
function useScheduleAutosave(input: {
  enabled: boolean;
  dirty: boolean;
  online: boolean;
  blocked: boolean;
  fetcherState: string;
  recoveryState: string;
  changeToken: string;
  submit: () => void;
}) {
  const {
    enabled,
    dirty,
    online,
    blocked,
    fetcherState,
    recoveryState,
    changeToken,
    submit,
  } = input;
  useEffect(() => {
    if (
      !enabled ||
      !dirty ||
      !online ||
      blocked ||
      fetcherState !== "idle" ||
      recoveryState === "conflict" ||
      recoveryState === "restore_available" ||
      recoveryState === "retry_required"
    )
      return;
    const timer = window.setTimeout(submit, 900);
    return () => window.clearTimeout(timer);
  }, [
    blocked,
    changeToken,
    dirty,
    enabled,
    fetcherState,
    online,
    recoveryState,
    submit,
  ]);
}

function downloadRecovery(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json",
  });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(href);
}

function PersistenceStatus({
  label,
  tone,
}: {
  label: string;
  tone: "success" | "info" | "warning" | "danger";
}) {
  return (
    <span className={`status ${tone}`} role="status" aria-live="polite">
      {label}
    </span>
  );
}

function statusFor(input: {
  conflict: boolean;
  online: boolean;
  serverError: string | null;
  submitting: boolean;
  dirty: boolean;
  saved: boolean;
  restored: boolean;
}) {
  if (input.conflict) return { label: "Conflict", tone: "danger" as const };
  if (!input.online) return { label: "Offline", tone: "warning" as const };
  if (input.serverError)
    return { label: "Retry required", tone: "danger" as const };
  if (input.restored) return { label: "Restored", tone: "warning" as const };
  if (input.submitting || input.dirty)
    return { label: "Saving", tone: "info" as const };
  if (input.saved) return { label: "Saved", tone: "success" as const };
  return null;
}
type SessionContentEditorProps = {
  workspace: ScheduleWorkspace;
  session: ScheduleSession;
  recoveryScope: RecoveryScope;
  calendarPreview: ScheduleCalendarPreview | null;
};

function useSessionContentEditorState({
  workspace,
  session,
  recoveryScope,
  calendarPreview,
}: SessionContentEditorProps) {
  const version = workspace.version;
  const editable = version?.status === "draft";
  const initialDraft = useMemo<SessionContentDraft>(
    () => ({
      title: session.title,
      description: session.description,
      format: session.format,
      durationMinutes: session.durationMinutes,
      trackId: session.trackId,
      visibility: session.visibility,
      requiredResources: [...session.requiredResources],
    }),
    [session],
  );
  const [draft, setDraft] = useState(initialDraft);
  const draftRef = useRef(draft);
  const [savedFingerprint, setSavedFingerprint] = useState(() =>
    fingerprint(initialDraft),
  );
  const [serverRevision, setServerRevision] = useState(session.revision);
  const [scheduleRevision, setScheduleRevision] = useState(
    version?.revision ?? 0,
  );
  const [serverError, setServerError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    session: ScheduleSession;
    version: NonNullable<ScheduleWorkspace["version"]>;
  } | null>(null);
  const [saved, setSaved] = useState(false);
  const [surface, setSurface] = useState<"card" | "detail" | "calendar">(
    "card",
  );
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
  const fetcher = useFetcher<EditorActionData>();
  const online = useOnlineState();
  const currentFingerprint = fingerprint(draft);
  const dirty = currentFingerprint !== savedFingerprint;
  const operationRef = useRef<{ key: string; fingerprint: string } | null>(
    null,
  );
  const submittedRef = useRef<{
    fingerprint: string;
    sessionRevision: number;
    scheduleRevision: number;
  } | null>(null);
  const handledDataRef = useRef<EditorActionData | null>(null);
  draftRef.current = draft;
  const restore = useCallback((payload: SessionContentDraft) => {
    setDraft({ ...payload, requiredResources: [...payload.requiredResources] });
    setSaved(false);
    setServerError(null);
  }, []);
  const recovery = useDraftRecovery({
    scope: editable
      ? {
          ...recoveryScope,
          recordType: "session_content",
          recordId: session.id,
        }
      : null,
    serverRevision: `${version?.id ?? "none"}:${serverRevision}:${scheduleRevision}`,
    payload: draft,
    dirty,
    onRestore: restore,
    enabled: editable,
  });
  const submit = useCallback(
    (revisionOverride?: { session: number; schedule: number }) => {
      if (!editable || !version || !online || fetcher.state !== "idle") return;
      const payload = draftRef.current;
      const payloadFingerprint = fingerprint(payload);
      if (
        !operationRef.current ||
        operationRef.current.fingerprint !== payloadFingerprint
      ) {
        operationRef.current = {
          key: commandId(),
          fingerprint: payloadFingerprint,
        };
      }
      const values = new FormData();
      values.set("intent", "save-session-content");
      values.set("scheduleVersionId", version.id);
      values.set(
        "scheduleRevision",
        String(revisionOverride?.schedule ?? scheduleRevision),
      );
      values.set("sessionId", session.id);
      values.set(
        "sessionRevision",
        String(revisionOverride?.session ?? serverRevision),
      );
      values.set("idempotencyKey", operationRef.current.key);
      values.set("title", payload.title);
      values.set("description", payload.description);
      values.set("format", payload.format);
      values.set("durationMinutes", String(payload.durationMinutes));
      values.set("trackId", payload.trackId ?? "");
      values.set("visibility", payload.visibility);
      for (const resource of payload.requiredResources)
        values.append("requiredResource", resource);
      submittedRef.current = {
        fingerprint: payloadFingerprint,
        sessionRevision: revisionOverride?.session ?? serverRevision,
        scheduleRevision: revisionOverride?.schedule ?? scheduleRevision,
      };
      setServerError(null);
      setWarning(null);
      setSaved(false);
      void fetcher.submit(values, { method: "post" });
    },
    [
      editable,
      fetcher,
      online,
      scheduleRevision,
      serverRevision,
      session.id,
      version,
    ],
  );
  useScheduleAutosave({
    enabled: editable,
    dirty,
    online,
    blocked: Boolean(serverError || conflict),
    fetcherState: fetcher.state,
    recoveryState: recovery.state,
    changeToken: currentFingerprint,
    submit,
  });
  useEffect(() => {
    const result = fetcher.data;
    if (
      fetcher.state !== "idle" ||
      !result ||
      result === handledDataRef.current ||
      result.intent !== "save-session-content"
    )
      return;
    handledDataRef.current = result;
    if (result.ok && result.sessionId === session.id) {
      if (
        !Number.isSafeInteger(result.revision) ||
        !Number.isSafeInteger(result.scheduleRevision)
      ) {
        setServerError("The server saved content without returning revisions.");
        return;
      }
      setServerRevision(result.revision!);
      setScheduleRevision(result.scheduleRevision!);
      setWarning(result.warning ?? null);
      const submitted = submittedRef.current;
      if (
        submitted &&
        submitted.fingerprint === fingerprint(draftRef.current)
      ) {
        setSavedFingerprint(submitted.fingerprint);
        setSaved(true);
        void recovery.markServerSaved();
      }
      operationRef.current = null;
      submittedRef.current = null;
      return;
    }
    if (result.conflict && result.currentSession && result.currentVersion) {
      setConflict({
        session: result.currentSession,
        version: result.currentVersion,
      });
      setServerError(null);
      return;
    }
    setServerError(result.error ?? "Session content could not be saved.");
  }, [fetcher.data, fetcher.state, recovery.markServerSaved, session.id]);
  useEffect(() => {
    if (session.revision === serverRevision) return;
    if (fetcher.state !== "idle") return;
    const ownSave =
      fetcher.data?.ok === true &&
      fetcher.data.intent === "save-session-content" &&
      fetcher.data.sessionId === session.id &&
      fetcher.data.revision === session.revision;
    if (ownSave) {
      setServerRevision(session.revision);
      if (version && fetcher.data?.scheduleRevision === version.revision) {
        setScheduleRevision(version.revision);
      }
      return;
    }
    if (dirty) {
      if (version) setConflict({ session, version });
      return;
    }
    setDraft(initialDraft);
    setSavedFingerprint(fingerprint(initialDraft));
    setServerRevision(session.revision);
    setScheduleRevision(version?.revision ?? 0);
    setSaved(false);
  }, [
    dirty,
    fetcher.data,
    fetcher.state,
    initialDraft,
    serverRevision,
    session,
    version,
  ]);
  useEffect(() => {
    if (!version || version.revision === scheduleRevision) return;
    if (fetcher.state !== "idle") return;
    const ownSave =
      fetcher.data?.ok === true &&
      fetcher.data.intent === "save-session-content" &&
      fetcher.data.scheduleRevision === version.revision;
    if (ownSave) {
      setScheduleRevision(version.revision);
      return;
    }
    if (dirty) {
      setConflict({ session, version });
      return;
    }
    setScheduleRevision(version.revision);
  }, [dirty, fetcher.data, fetcher.state, scheduleRevision, session, version]);
  const inventory = useMemo(
    () =>
      [...new Set(workspace.rooms.flatMap((room) => room.resources))].sort(),
    [workspace.rooms],
  );
  const entry = workspace.entries.find((item) => item.sessionId === session.id);
  const room = entry
    ? workspace.rooms.find((candidate) => candidate.id === entry.roomId)
    : null;
  const status = statusFor({
    conflict: Boolean(conflict),
    online,
    serverError,
    submitting: fetcher.state !== "idle",
    dirty,
    saved,
    restored: recovery.state === "restored",
  });
  const acceptServer = () => {
    if (!conflict) return;
    const next = {
      title: conflict.session.title,
      description: conflict.session.description,
      format: conflict.session.format,
      durationMinutes: conflict.session.durationMinutes,
      trackId: conflict.session.trackId,
      visibility: conflict.session.visibility,
      requiredResources: [...conflict.session.requiredResources],
    } satisfies SessionContentDraft;
    setDraft(next);
    setSavedFingerprint(fingerprint(next));
    setServerRevision(conflict.session.revision);
    setScheduleRevision(conflict.version.revision);
    setConflict(null);
    setServerError(null);
    setSaved(false);
    operationRef.current = null;
    void recovery.clear();
  };
  const overwrite = () => {
    if (!conflict) return;
    const revisions = {
      session: conflict.session.revision,
      schedule: conflict.version.revision,
    };
    setServerRevision(revisions.session);
    setScheduleRevision(revisions.schedule);
    setConflict(null);
    operationRef.current = null;
    window.setTimeout(() => submit(revisions), 0);
  };
  return {
    workspace,
    session,
    calendarPreview,
    editable,
    draft,
    setDraft,
    serverError,
    setServerError,
    warning,
    conflict,
    setSaved,
    surface,
    setSurface,
    viewport,
    setViewport,
    recovery,
    submit,
    inventory,
    entry,
    room,
    status,
    acceptServer,
    overwrite,
  };
}

const SessionContentEditorContext = createContext<ReturnType<
  typeof useSessionContentEditorState
> | null>(null);

function useSessionContentEditorModel() {
  const model = useContext(SessionContentEditorContext);
  if (!model) throw new Error("Session content editor model is unavailable.");
  return model;
}

function SessionContentFieldsPanel() {
  const {
    workspace,
    session,
    editable,
    draft,
    setDraft,
    serverError,
    setServerError,
    warning,
    conflict,
    setSaved,
    recovery,
    submit,
    inventory,
    status,
    acceptServer,
    overwrite,
  } = useSessionContentEditorModel();
  return (
    <section
      className="card pad mt"
      aria-labelledby="session-content-title"
      data-testid="session-content-editor"
    >
      <div className="card-title">
        <div>
          <span className="pc-page-eyebrow">Revisioned content</span>
          <h2 id="session-content-title">Session editor</h2>
        </div>
        <span className="row-actions right">
          {status ? <PersistenceStatus {...status} /> : null}
          <DraftRecoveryStatus state={recovery.state} />
        </span>
      </div>
      {!editable ? (
        <div className="validation-item warn mb">
          <span>
            This published version is read-only. Create the next draft before
            changing session content.
          </span>
        </div>
      ) : null}
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
      {warning ? (
        <div className="validation-item warn mb" role="status">
          <span>{warning}</span>
        </div>
      ) : null}
      {conflict ? (
        <div className="validation-item error card pad mb" role="alert">
          <strong>Session-content conflict</strong>
          <span>
            The server changed after this editor loaded. Nothing was
            overwritten. Compare the current server title “
            {conflict.session.title}” with your local title “{draft.title}”,
            then choose which version to keep.
          </span>
          <span className="row-actions right">
            <button
              className="btn small"
              type="button"
              onClick={() =>
                downloadRecovery(`${session.slug}-session-recovery.json`, draft)
              }
            >
              Export local edits
            </button>
            <button className="btn small" type="button" onClick={acceptServer}>
              Load server version
            </button>
            <button
              className="btn small primary"
              type="button"
              onClick={overwrite}
            >
              Save my version
            </button>
          </span>
        </div>
      ) : null}
      <div className="grid grid-2">
        <label className="label">
          Title
          <input
            className="field"
            value={draft.title}
            maxLength={240}
            disabled={!editable}
            onChange={(event) => {
              setDraft((current) => ({
                ...current,
                title: event.target.value,
              }));
              setServerError(null);
              setSaved(false);
            }}
            onBlur={() =>
              setDraft((current) => ({
                ...current,
                title: current.title.trim(),
              }))
            }
          />
        </label>
        <label className="label">
          Format
          <select
            className="select"
            value={draft.format}
            disabled={!editable}
            onChange={(event) => {
              const selected = workspace.sessionFormats.find(
                (format) => format.key === event.target.value,
              );
              setDraft((current) => ({
                ...current,
                format: event.target.value,
                durationMinutes:
                  current.format === event.target.value || !selected
                    ? current.durationMinutes
                    : selected.defaultDurationMinutes,
              }));
              setServerError(null);
              setSaved(false);
            }}
          >
            {workspace.sessionFormats.map((format) => (
              <option key={format.key} value={format.key}>
                {format.label}
              </option>
            ))}
          </select>
        </label>
        <label className="label span-2">
          Public description
          <textarea
            className="textarea"
            rows={5}
            maxLength={12_000}
            value={draft.description}
            disabled={!editable}
            onChange={(event) => {
              setDraft((current) => ({
                ...current,
                description: event.target.value,
              }));
              setServerError(null);
              setSaved(false);
            }}
          />
        </label>
        <label className="label">
          Duration (minutes)
          <input
            className="field"
            type="number"
            min={5}
            max={480}
            value={draft.durationMinutes}
            disabled={!editable}
            onChange={(event) => {
              setDraft((current) => ({
                ...current,
                durationMinutes: Number(event.target.value),
              }));
              setServerError(null);
              setSaved(false);
            }}
          />
        </label>
        <label className="label">
          Track
          <select
            className="select"
            value={draft.trackId ?? ""}
            disabled={!editable}
            onChange={(event) => {
              setDraft((current) => ({
                ...current,
                trackId: event.target.value || null,
              }));
              setServerError(null);
              setSaved(false);
            }}
          >
            <option value="">No track</option>
            {workspace.tracks.map((track) => (
              <option key={track.id} value={track.id}>
                {track.name}
              </option>
            ))}
          </select>
        </label>
        <label className="label">
          Visibility
          <select
            className="select"
            value={draft.visibility}
            disabled={!editable}
            onChange={(event) => {
              setDraft((current) => ({
                ...current,
                visibility: event.target
                  .value as SessionContentDraft["visibility"],
              }));
              setServerError(null);
              setSaved(false);
            }}
          >
            <option value="public">Public</option>
            <option value="private">Private</option>
            <option value="hidden">Hidden</option>
          </select>
        </label>
        <fieldset className="stack">
          <legend className="label">Required resources</legend>
          {inventory.length ? (
            inventory.map((resource) => (
              <label className="toggle" key={resource}>
                <input
                  type="checkbox"
                  checked={draft.requiredResources.includes(resource)}
                  disabled={!editable}
                  onChange={(event) => {
                    setDraft((current) => ({
                      ...current,
                      requiredResources: event.target.checked
                        ? [...current.requiredResources, resource]
                        : current.requiredResources.filter(
                            (candidate) => candidate !== resource,
                          ),
                    }));
                    setServerError(null);
                    setSaved(false);
                  }}
                />{" "}
                {resource}
              </label>
            ))
          ) : (
            <span className="help">No room resources are configured.</span>
          )}
        </fieldset>
      </div>
    </section>
  );
}

function SessionContentPreviewPanel() {
  const {
    workspace,
    session,
    calendarPreview,
    draft,
    surface,
    setSurface,
    viewport,
    setViewport,
    entry,
    room,
  } = useSessionContentEditorModel();
  return (
    <section
      className="card pad mt"
      aria-labelledby="content-preview-title"
      data-testid="session-content-preview"
    >
      <div className="card-title">
        <div>
          <span className="pc-page-eyebrow">Isolated live preview</span>
          <h2 id="content-preview-title">Session card and detail</h2>
        </div>
        <div className="page-actions">
          {(["desktop", "mobile"] as const).map((option) => (
            <button
              className={`btn small${viewport === option ? " primary" : ""}`}
              type="button"
              aria-pressed={viewport === option}
              key={option}
              onClick={() => setViewport(option)}
            >
              {option[0].toUpperCase() + option.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="tabs mb" role="group" aria-label="Preview surface">
        {(["card", "detail", "calendar"] as const).map((option) => (
          <button
            className={`tab${surface === option ? " active" : ""}`}
            type="button"
            aria-pressed={surface === option}
            key={option}
            onClick={() => setSurface(option)}
          >
            {option === "card"
              ? "Session card"
              : option === "detail"
                ? "Session detail"
                : "Calendar"}
          </button>
        ))}
      </div>
      <div
        className="card pad"
        style={{
          marginInline: "auto",
          maxWidth: viewport === "mobile" ? 390 : 900,
          borderColor: workspace.event.brandAccent,
        }}
        data-preview-viewport={viewport}
      >
        {surface === "card" ? (
          <article>
            <span className="pill">{draft.format}</span>
            <h3>{draft.title || "Untitled session"}</h3>
            <p className="help">
              {session.speakerNames.join(", ") || "Speaker to be announced"}
            </p>
            <strong>
              {entry
                ? `${formatDate(entry.startsAt, workspace.event.timezone)} · ${formatTime(entry.startsAt, workspace.event.timezone)}`
                : `${draft.durationMinutes} minutes · not scheduled`}
            </strong>
          </article>
        ) : surface === "detail" ? (
          <article>
            <span className="pill">Session detail</span>
            <h2>{draft.title || "Untitled session"}</h2>
            <p>{draft.description || "No public description yet."}</p>
            <dl>
              <div>
                <dt>Speakers</dt>
                <dd>{session.speakerNames.join(", ") || "To be announced"}</dd>
              </div>
              <div>
                <dt>Track</dt>
                <dd>
                  {workspace.tracks.find((track) => track.id === draft.trackId)
                    ?.name ?? "No track"}
                </dd>
              </div>
              <div>
                <dt>Visibility</dt>
                <dd>{draft.visibility}</dd>
              </div>
            </dl>
          </article>
        ) : (
          <article>
            <span className="pill">Generated invitation data</span>
            <h2>{draft.title || "Untitled session"}</h2>
            <p>{draft.description || "No description."}</p>
            <p>
              {entry
                ? `${formatDate(entry.startsAt, workspace.event.timezone)} · ${formatTime(entry.startsAt, workspace.event.timezone)}–${formatTime(entry.endsAt, workspace.event.timezone)}`
                : "Schedule the session to generate invitation data."}
            </p>
            <p>
              {room?.name ?? "Room to be assigned"} · {workspace.event.timezone}
            </p>
            {calendarPreview ? (
              <details>
                <summary>
                  Exact ICS generated from the last saved server revision
                </summary>
                <pre className="code-block">{calendarPreview.ics}</pre>
                <button
                  className="btn small"
                  type="button"
                  onClick={() => {
                    const blob = new Blob([calendarPreview.ics], {
                      type: "text/calendar;charset=utf-8",
                    });
                    const href = URL.createObjectURL(blob);
                    const link = document.createElement("a");
                    link.href = href;
                    link.download = `${session.slug}-preview.ics`;
                    link.click();
                    URL.revokeObjectURL(href);
                  }}
                >
                  Download generated ICS
                </button>
              </details>
            ) : null}
          </article>
        )}
      </div>
    </section>
  );
}

function SessionContentEditor(props: SessionContentEditorProps) {
  const model = useSessionContentEditorState(props);
  return (
    <SessionContentEditorContext.Provider value={model}>
      <SessionContentFieldsPanel />
      <SessionContentPreviewPanel />
    </SessionContentEditorContext.Provider>
  );
}

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
    </section>
  );
}

function formatTime(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
}

function formatDate(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
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

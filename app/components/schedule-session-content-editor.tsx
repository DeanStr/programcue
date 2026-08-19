import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useFetcher } from "react-router";
import {
  DraftRecoveryFeedback,
  DraftRecoveryStatus,
} from "~/components/draft-recovery-feedback";
import { CharacterCount } from "~/components/ui/character-count";
import { requireValue } from "~/lib/required-value";
import type { ScheduleEditLock } from "~/modules/schedule/schedule-edit-lock";
import type {
  ScheduleSession,
  ScheduleWorkspace,
} from "~/modules/schedule/schedule-service.server";
import { useDraftRecovery } from "~/platform/drafts/draft-recovery";
import {
  commandId,
  downloadRecovery,
  type EditorActionData,
  fingerprint,
  formatDate,
  formatTime,
  PersistenceStatus,
  type RecoveryScope,
  type ScheduleCalendarPreview,
  ScheduleReadOnlyMarker,
  type SessionContentDraft,
  statusFor,
  useOnlineState,
  useScheduleAutosave,
} from "./schedule-content-editor-shared";

type SessionContentEditorProps = {
  workspace: ScheduleWorkspace;
  session: ScheduleSession;
  editLock: ScheduleEditLock;
  recoveryScope: RecoveryScope;
  calendarPreview: ScheduleCalendarPreview | null;
};

function useSessionContentEditorState({
  workspace,
  session,
  editLock,
  recoveryScope,
  calendarPreview,
}: SessionContentEditorProps) {
  const version = workspace.version;
  const editable = editLock.editable;
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
      setServerRevision(
        requireValue(
          result.revision,
          "Required result.revision is unavailable.",
        ),
      );
      setScheduleRevision(
        requireValue(
          result.scheduleRevision,
          "Required result.scheduleRevision is unavailable.",
        ),
      );
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
    editLock,
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
    editLock,
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
      className="schedule-inspector-panel"
      aria-labelledby="session-content-title"
      data-testid="session-content-editor"
    >
      <div className="card-title">
        <div>
          <span className="pc-page-eyebrow">Revisioned content</span>
          <h2 id="session-content-title">Session editor</h2>
        </div>
        <span className="row-actions right">
          <span className="pill">
            {session.contentStatus.replaceAll("_", " ")} · revision{" "}
            {session.contentRevision}
          </span>
          <Link
            className="btn small"
            to={`/admin/content/sessions/${encodeURIComponent(session.id)}`}
          >
            Review history
          </Link>
          {status ? <PersistenceStatus {...status} /> : null}
          <DraftRecoveryStatus state={recovery.state} />
        </span>
      </div>
      {editLock.reason ? <ScheduleReadOnlyMarker /> : null}
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
          <CharacterCount value={draft.description} maximum={12_000} />
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
      className="schedule-inspector-panel"
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
      <fieldset
        className="tabs mb pc-plain-fieldset"
        aria-label="Preview surface"
      >
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
      </fieldset>
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
                <dd>
                  {draft.visibility === "public"
                    ? "Public"
                    : draft.visibility === "private"
                      ? "Private"
                      : "Hidden"}
                </dd>
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
                  View the exact calendar file speakers will receive
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

export function SessionContentEditor(props: SessionContentEditorProps) {
  const model = useSessionContentEditorState(props);
  return (
    <SessionContentEditorContext.Provider value={model}>
      <SessionContentFieldsPanel />
      <SessionContentPreviewPanel />
    </SessionContentEditorContext.Provider>
  );
}

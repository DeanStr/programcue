import { Pause, Play, UploadCloud, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";

import {
  createProgramCueMultipartSession,
  readProgramCueMultipartResponse,
  type ProgramCueMultipartOperation,
  type ProgramCueMultipartRequest,
  type ProgramCueMultipartSession,
} from "~/modules/files/uppy-multipart-client";
import { maximumMegabytes } from "~/modules/files/file-policy";
import {
  UserFacingError,
  userFacingMessage,
} from "~/platform/user-facing-error";

type DirectUploadTarget = {
  targetType: "person" | "task" | "resource";
  targetId: string;
};

export type DirectUploadKind = {
  value: string;
  label: string;
  accept?: string;
  maximumBytes: number;
};

type DirectUploadState =
  | { status: "idle"; message: null }
  | { status: "uploading"; message: string; progress: number }
  | { status: "paused"; message: string; progress: number }
  | { status: "error"; message: string; reloadRequired?: boolean }
  | { status: "complete"; message: string };

export class DirectUploadCompletionConflictError extends UserFacingError {
  constructor(message: string) {
    super(message);
    this.name = "DirectUploadCompletionConflictError";
  }
}

async function jsonRequest<T>(
  operation: ProgramCueMultipartOperation,
  body: unknown,
  options?: { idempotencyKey?: string; signal?: AbortSignal },
) {
  const response = await fetch(`/files/multipart/${operation}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options?.idempotencyKey
        ? { "idempotency-key": options.idempotencyKey }
        : {}),
    },
    body: JSON.stringify(body),
    signal: options?.signal,
  });
  return readProgramCueMultipartResponse<T>(response, operation);
}

export function DirectMultipartUpload({
  target,
  kinds,
  heading = "Upload a file",
  description = "Your file uploads straight from this browser to private storage. Program Cue checks the completed file and keeps it quarantined until the malware scan passes.",
  onCompleted,
  disabled = false,
}: {
  target: DirectUploadTarget;
  kinds: DirectUploadKind[];
  heading?: string;
  description?: string;
  onCompleted?: (result: {
    assetId: string;
    versionId: string;
  }) => Promise<{ message?: string } | void>;
  disabled?: boolean;
}) {
  const revalidator = useRevalidator();
  const [state, setState] = useState<DirectUploadState>({
    status: "idle",
    message: null,
  });
  const [selectedKindValue, setSelectedKindValue] = useState(
    kinds[0]?.value ?? "",
  );
  const session = useRef<ProgramCueMultipartSession | null>(null);
  const uploadInFlight = useRef(false);
  const completedUpload = useRef<{ assetId: string; versionId: string } | null>(
    null,
  );

  function discardRevokedUploadSession() {
    completedUpload.current = null;
    session.current?.markAttached();
    session.current?.disposePreservingUpload();
    session.current = null;
  }

  async function finishCompletedUpload(result: {
    assetId: string;
    versionId: string;
  }) {
    const completion = onCompleted ? await onCompleted(result) : undefined;
    session.current?.markAttached();
    completedUpload.current = null;
    session.current?.disposePreservingUpload();
    session.current = null;
    setState({
      status: "complete",
      message:
        completion?.message ??
        "Upload complete. The file remains private and quarantined until its malware scan passes.",
    });
    void revalidator.revalidate();
  }

  useEffect(
    () => () => {
      session.current?.disposePreservingUpload();
    },
    [],
  );

  async function retryCompletion() {
    const completed = completedUpload.current;
    if (!completed) return;
    try {
      setState({
        status: "uploading",
        message: "Attaching the completed upload to the current record…",
        progress: 100,
      });
      await finishCompletedUpload(completed);
    } catch (error) {
      if (error instanceof DirectUploadCompletionConflictError)
        discardRevokedUploadSession();
      setState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "The completed upload could not be attached.",
        reloadRequired: error instanceof DirectUploadCompletionConflictError,
      });
    }
  }

  async function abortUpload() {
    const active = session.current;
    if (!active) return;
    try {
      await active.cancel();
      session.current = null;
      completedUpload.current = null;
      setState({ status: "error", message: "Upload cancelled." });
    } catch (error) {
      setState({
        status: "error",
        message: userFacingMessage(
          error,
          "The upload stopped, but the partial file was not cleared. Try cancelling again.",
        ),
      });
    }
  }

  function pauseResumeUpload() {
    const active = session.current;
    if (!active) return;
    const paused = active.pauseResume();
    const progress =
      state.status === "uploading" || state.status === "paused"
        ? state.progress
        : 0;
    setState({
      status: paused ? "paused" : "uploading",
      message: paused
        ? "Upload paused. Resume to continue from where it stopped."
        : "Resuming your upload…",
      progress,
    });
  }

  async function finishTransfer(active: ProgramCueMultipartSession) {
    const completed = await active.upload();
    completedUpload.current = completed;
    await finishCompletedUpload(completed);
  }

  async function resumeFailedUpload() {
    const active = session.current;
    if (
      !active ||
      uploadInFlight.current ||
      completedUpload.current ||
      state.status !== "error"
    )
      return;
    uploadInFlight.current = true;
    try {
      setState({
        status: "uploading",
        message: "Resuming your upload…",
        progress: 0,
      });
      await finishTransfer(active);
    } catch (error) {
      setState({
        status: "error",
        message: userFacingMessage(
          error,
          "The upload could not be completed. Try again.",
        ),
        reloadRequired: error instanceof DirectUploadCompletionConflictError,
      });
      if (error instanceof DirectUploadCompletionConflictError)
        discardRevokedUploadSession();
    } finally {
      uploadInFlight.current = false;
    }
  }

  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (uploadInFlight.current || session.current) return;
    const form = new FormData(event.currentTarget);
    const file = form.get("directFile");
    const assetKind = String(form.get("directAssetKind") ?? "");
    if (!(file instanceof File) || file.size === 0) {
      setState({ status: "error", message: "Choose a non-empty file." });
      return;
    }
    const selectedKind = kinds.find((kind) => kind.value === assetKind);
    if (!selectedKind) {
      setState({
        status: "error",
        message: "Choose a supported file purpose.",
      });
      return;
    }
    if (file.size > selectedKind.maximumBytes) {
      setState({
        status: "error",
        message: `The file exceeds this event's ${maximumMegabytes(selectedKind.maximumBytes)} MB limit for ${selectedKind.label}.`,
      });
      return;
    }
    uploadInFlight.current = true;
    completedUpload.current = null;
    try {
      setState({
        status: "uploading",
        message: "Checking for a resumable private upload…",
        progress: 0,
      });
      const request: ProgramCueMultipartRequest = (operation, body, options) =>
        jsonRequest(
          operation,
          operation === "initiate" || operation === "resume"
            ? {
                ...body,
                target: {
                  targetType: target.targetType,
                  targetId: target.targetId,
                  assetKind,
                },
              }
            : body,
          options,
        );
      const active = await createProgramCueMultipartSession({
        file,
        assetKind,
        resumeScope: `authenticated:${target.targetType}:${target.targetId}`,
        request,
        onProgress: (progress) =>
          setState({
            status: "uploading",
            message: `Uploading… ${progress}%`,
            progress,
          }),
        onPauseChange: (paused) => {
          if (!paused) return;
          setState((current) => ({
            status: "paused",
            message:
              "Upload paused. Resume to continue from where it stopped.",
            progress:
              current.status === "uploading" || current.status === "paused"
                ? current.progress
                : 0,
          }));
        },
      });
      session.current = active;
      setState({
        status: "uploading",
        message: "Uploading…",
        progress: 0,
      });
      await finishTransfer(active);
    } catch (error) {
      setState({
        status: "error",
        message: userFacingMessage(
          error,
          "The upload could not be completed. Try again.",
        ),
        reloadRequired: error instanceof DirectUploadCompletionConflictError,
      });
      if (error instanceof DirectUploadCompletionConflictError)
        discardRevokedUploadSession();
    } finally {
      uploadInFlight.current = false;
    }
  }

  const uploading = state.status === "uploading";
  const transferActive = uploading || state.status === "paused";
  const selectedKind =
    kinds.find((kind) => kind.value === selectedKindValue) ?? kinds[0];
  return (
    <form className="stack speaker-upload-form mt" onSubmit={upload}>
      <div>
        <strong>{heading}</strong>
        <p className="subtle">{description}</p>
      </div>
      <label className="label">
        File purpose
        <select
          className="select"
          name="directAssetKind"
          title={selectedKind?.label ?? "Choose file purpose"}
          value={selectedKind?.value ?? ""}
          onChange={(event) => setSelectedKindValue(event.currentTarget.value)}
          disabled={disabled || transferActive}
        >
          {kinds.map((kind) => (
            <option key={kind.value} value={kind.value}>
              {kind.label}
            </option>
          ))}
        </select>
      </label>
      <label className="label">
        Choose file
        <input
          className="field"
          name="directFile"
          type="file"
          accept={selectedKind?.accept}
          required
          disabled={disabled || transferActive}
        />
        {selectedKind ? (
          <span className="help">
            Maximum {maximumMegabytes(selectedKind.maximumBytes)} MB for this
            event.
          </span>
        ) : null}
      </label>
      {transferActive ? (
        <progress max={100} value={state.progress} aria-label="Upload progress">
          {state.progress}%
        </progress>
      ) : null}
      <div className="page-actions">
        <button
          className="btn primary"
          disabled={
            disabled ||
            transferActive ||
            uploadInFlight.current ||
            Boolean(session.current)
          }
        >
          <UploadCloud aria-hidden size={15} /> Upload file
        </button>
        {transferActive ? (
          <button className="btn" type="button" onClick={pauseResumeUpload}>
            {state.status === "paused" ? (
              <Play aria-hidden size={15} />
            ) : (
              <Pause aria-hidden size={15} />
            )}{" "}
            {state.status === "paused" ? "Resume upload" : "Pause upload"}
          </button>
        ) : null}
        {transferActive ? (
          <button className="btn danger" type="button" onClick={abortUpload}>
            <X aria-hidden size={15} /> Cancel upload
          </button>
        ) : null}
        {!transferActive &&
        state.status === "error" &&
        session.current &&
        !completedUpload.current ? (
          <button className="btn" type="button" onClick={resumeFailedUpload}>
            <Play aria-hidden size={15} /> Resume upload
          </button>
        ) : null}
        {!transferActive &&
        state.status === "error" &&
        session.current &&
        !completedUpload.current ? (
          <button className="btn danger" type="button" onClick={abortUpload}>
            <X aria-hidden size={15} /> Cancel upload
          </button>
        ) : null}
        {!uploading && completedUpload.current ? (
          <button
            className="btn"
            type="button"
            disabled={disabled}
            onClick={retryCompletion}
          >
            Retry attachment
          </button>
        ) : null}
        {state.status === "error" && state.reloadRequired ? (
          <button
            className="btn"
            type="button"
            onClick={() => window.location.reload()}
          >
            Reload latest draft
          </button>
        ) : null}
      </div>
      {state.message ? (
        <p
          className={state.status === "error" ? "notice error" : "notice"}
          role="status"
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

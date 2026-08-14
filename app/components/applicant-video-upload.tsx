import { useCallback, useEffect, useRef, useState } from "react";

import { TurnstileWidget } from "~/components/turnstile-widget";
import { maximumMegabytes } from "~/modules/files/file-policy";
import {
  createProgramCueMultipartSession,
  readProgramCueMultipartResponse,
  type ProgramCueMultipartOperation,
  type ProgramCueMultipartRequest,
  type ProgramCueMultipartSession,
} from "~/modules/files/uppy-multipart-client";
import { userFacingMessage } from "~/platform/user-facing-error";

export type ApplicantVideoUploadRecord = {
  fieldId: string;
  assetId: string;
  versionId: string;
  filename: string;
  sizeBytes: number;
  status: "uploading" | "scanning" | "ready" | "rejected";
};

type ApplicantVideoOperationRef = { current: symbol | null };

export function claimApplicantVideoUploadOperation(
  uploadOperation: ApplicantVideoOperationRef,
  cancellationOperation: ApplicantVideoOperationRef,
  hasActiveSession: boolean,
): symbol | null {
  if (
    uploadOperation.current ||
    cancellationOperation.current ||
    hasActiveSession
  ) {
    return null;
  }
  const operation = Symbol("applicant-video-upload");
  uploadOperation.current = operation;
  return operation;
}

async function applicantMultipartRequest<T>(
  publicSlug: string,
  operation: ProgramCueMultipartOperation,
  body: Record<string, unknown>,
  options?: { idempotencyKey?: string; signal?: AbortSignal },
) {
  const response = await fetch(
    `/apply/${encodeURIComponent(publicSlug)}/files/multipart/${operation}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options?.idempotencyKey
          ? { "idempotency-key": options.idempotencyKey }
          : {}),
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    },
  );
  return readProgramCueMultipartResponse<T>(
    response,
    operation,
    "Video upload request",
  );
}

export function ApplicantVideoUpload({
  publicSlug,
  submissionId,
  fieldId,
  current,
  siteKey,
  disabled,
  maximumBytes,
  onReferenceChange,
}: {
  publicSlug: string;
  submissionId: string;
  fieldId: string;
  current: ApplicantVideoUploadRecord | null;
  siteKey: string | null;
  disabled: boolean;
  maximumBytes: number;
  onReferenceChange(reference: { assetId: string; versionId: string }): void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadSession = useRef<ProgramCueMultipartSession | null>(null);
  const completedUpload = useRef<{
    assetId: string;
    versionId: string;
  } | null>(null);
  const uploadOperation = useRef<symbol | null>(null);
  const cancellationOperation = useRef<symbol | null>(null);
  const [cancellationInFlight, setCancellationInFlight] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [progress, setProgress] = useState(0);
  const [state, setState] = useState<{
    status: "idle" | "uploading" | "paused" | "error" | "scanning" | "ready";
    message: string;
  }>(() => {
    if (current?.status === "ready")
      return {
        status: "ready",
        message: `${current.filename} passed security validation and is ready to submit.`,
      };
    if (current?.status === "scanning")
      return {
        status: "scanning",
        message: `${current.filename} is quarantined while its security scan finishes.`,
      };
    if (current?.status === "uploading")
      return {
        status: "error",
        message: `${current.filename} did not finish uploading. Re-select the same file to resume its uploaded parts, or choose a replacement.`,
      };
    if (current?.status === "rejected")
      return {
        status: "error",
        message: `${current.filename} did not pass upload or security validation. Upload a replacement.`,
      };
    return { status: "idle", message: "" };
  });

  useEffect(
    () => () => {
      uploadOperation.current = null;
      cancellationOperation.current = null;
      uploadSession.current?.disposePreservingUpload();
    },
    [],
  );
  useEffect(() => {
    const completed = completedUpload.current;
    const active = uploadSession.current;
    if (
      !completed ||
      !active ||
      current?.assetId !== completed.assetId ||
      current.versionId !== completed.versionId
    )
      return;
    active.markAttached();
    active.disposePreservingUpload();
    completedUpload.current = null;
    uploadSession.current = null;
  }, [current?.assetId, current?.versionId]);

  async function cancel() {
    const active = uploadSession.current;
    if (!active || cancellationOperation.current) return;
    const operation = Symbol("applicant-video-cancellation");
    cancellationOperation.current = operation;
    uploadOperation.current = null;
    setCancellationInFlight(true);
    try {
      await active.cancel();
      if (uploadSession.current === active) uploadSession.current = null;
      setState({ status: "error", message: "Video upload cancelled." });
    } catch (error) {
      setState({
        status: "error",
        message: userFacingMessage(
          error,
          "The upload stopped, but the partial file was not cleared. Try cancelling again.",
        ),
      });
    } finally {
      if (cancellationOperation.current === operation) {
        cancellationOperation.current = null;
        setCancellationInFlight(false);
      }
    }
  }

  function pauseResume() {
    const active = uploadSession.current;
    if (!active || cancellationOperation.current) return;
    const paused = active.pauseResume();
    setState({
      status: paused ? "paused" : "uploading",
      message: paused
        ? "Video upload paused. Resume to continue from where it stopped."
        : "Resuming your video upload…",
    });
  }

  async function finishVideoTransfer(
    active: ProgramCueMultipartSession,
    operation: symbol,
  ) {
    const completed = await active.upload();
    if (uploadOperation.current !== operation) {
      active.disposePreservingUpload();
      return;
    }
    completedUpload.current = completed;
    active.disposePreservingUpload();
    onReferenceChange({
      assetId: completed.assetId,
      versionId: completed.versionId,
    });
    setState({
      status: "scanning",
      message:
        "Upload complete. The video remains private and cannot be submitted until its security scan passes.",
    });
  }

  async function resumeFailedTransfer() {
    const active = uploadSession.current;
    if (
      !active ||
      uploadOperation.current ||
      cancellationOperation.current ||
      state.status !== "error"
    )
      return;
    const operation = Symbol("applicant-video-upload-resume");
    uploadOperation.current = operation;
    setState({
      status: "uploading",
      message: "Resuming your video upload…",
    });
    try {
      await finishVideoTransfer(active, operation);
    } catch (error) {
      if (uploadOperation.current !== operation) return;
      setState({
        status: "error",
        message: userFacingMessage(
          error,
          "Your video could not be uploaded. Try again.",
        ),
      });
    } finally {
      if (uploadOperation.current === operation) {
        uploadOperation.current = null;
      }
    }
  }

  async function upload() {
    const file = fileInput.current?.files?.[0];
    if (!file || file.size < 1) {
      setState({
        status: "error",
        message: "Choose a non-empty MP4 or WebM video.",
      });
      return;
    }
    if (!(["video/mp4", "video/webm"] as string[]).includes(file.type)) {
      setState({
        status: "error",
        message: "Video uploads must be MP4 or WebM.",
      });
      return;
    }
    if (file.size > maximumBytes) {
      setState({
        status: "error",
        message: `Video uploads cannot exceed this event's ${maximumMegabytes(maximumBytes)} MB limit.`,
      });
      return;
    }
    if (siteKey && !turnstileToken) {
      setState({
        status: "error",
        message: "Complete the security check before starting the upload.",
      });
      return;
    }
    const operation = claimApplicantVideoUploadOperation(
      uploadOperation,
      cancellationOperation,
      Boolean(uploadSession.current),
    );
    if (!operation) return;
    try {
      setProgress(0);
      setState({
        status: "uploading",
        message: "Checking for a resumable private video upload…",
      });
      const request: ProgramCueMultipartRequest = (operation, body, options) =>
        applicantMultipartRequest(
          publicSlug,
          operation,
          {
            submissionId,
            fieldId,
            ...body,
            ...(operation === "initiate" ? { turnstileToken } : {}),
          },
          options,
        );
      const active = await createProgramCueMultipartSession({
        file,
        assetKind: "video",
        resumeScope: `applicant:${publicSlug}:${submissionId}:${fieldId}`,
        request,
        onProgress: (percentage) => {
          if (uploadOperation.current !== operation) return;
          setProgress(percentage);
          setState({
            status: "uploading",
            message: `Uploading your video… ${percentage}%`,
          });
        },
        onPauseChange: (paused) => {
          if (uploadOperation.current !== operation) return;
          if (!paused) return;
          setState({
            status: "paused",
            message:
              "Video upload paused. Resume to continue from where it stopped.",
          });
        },
      });
      if (uploadOperation.current !== operation) {
        active.disposePreservingUpload();
        return;
      }
      uploadSession.current = active;
      setState({
        status: "uploading",
        message: "Uploading your video…",
      });
      await finishVideoTransfer(active, operation);
    } catch (error) {
      if (uploadOperation.current !== operation) return;
      setState({
        status: "error",
        message: userFacingMessage(
          error,
          "Your video could not be uploaded. Try again.",
        ),
      });
    } finally {
      if (uploadOperation.current === operation) {
        uploadOperation.current = null;
      }
      setTurnstileToken("");
      setTurnstileResetKey((value) => value + 1);
    }
  }

  const uploading = state.status === "uploading";
  const transferActive = uploading || state.status === "paused";
  const uploadBlocked =
    disabled ||
    transferActive ||
    cancellationInFlight ||
    Boolean(uploadSession.current) ||
    Boolean(uploadOperation.current);
  return (
    <div className="card pad mt stack">
      <div>
        <strong>Pitch video</strong>
        <p className="help">
          Upload an MP4 or WebM file of up to {maximumMegabytes(maximumBytes)}{" "}
          MB. Only the review team can see it. Large uploads resume where they
          left off, and your video stays quarantined until it has been scanned.
        </p>
      </div>
      <input
        ref={fileInput}
        className="field"
        type="file"
        accept="video/mp4,video/webm,.mp4,.webm"
        disabled={uploadBlocked}
        aria-label="Choose an MP4 or WebM pitch video"
      />
      <TurnstileWidget
        siteKey={siteKey}
        action="application_file_upload"
        onTokenChange={setTurnstileToken}
        resetKey={turnstileResetKey}
      />
      {transferActive ? (
        <progress max={100} value={progress} aria-label="Video upload progress">
          {progress}%
        </progress>
      ) : null}
      <div className="page-actions">
        <button
          className="btn"
          type="button"
          disabled={uploadBlocked}
          onClick={upload}
        >
          {current ? "Upload replacement" : "Upload video"}
        </button>
        {transferActive ? (
          <button
            className="btn"
            type="button"
            disabled={cancellationInFlight}
            onClick={pauseResume}
          >
            {state.status === "paused" ? "Resume upload" : "Pause upload"}
          </button>
        ) : null}
        {transferActive ? (
          <button
            className="btn danger"
            type="button"
            disabled={cancellationInFlight}
            onClick={cancel}
          >
            {cancellationInFlight ? "Cancelling…" : "Cancel upload"}
          </button>
        ) : null}
        {!transferActive &&
        state.status === "error" &&
        uploadSession.current ? (
          <button
            className="btn"
            type="button"
            disabled={cancellationInFlight}
            onClick={resumeFailedTransfer}
          >
            Resume upload
          </button>
        ) : null}
        {!transferActive &&
        state.status === "error" &&
        uploadSession.current ? (
          <button
            className="btn danger"
            type="button"
            disabled={cancellationInFlight}
            onClick={cancel}
          >
            {cancellationInFlight ? "Cancelling…" : "Cancel upload"}
          </button>
        ) : null}
        {state.status === "scanning" ? (
          <button
            className="btn"
            type="button"
            onClick={() => window.location.reload()}
          >
            Refresh scan status
          </button>
        ) : null}
      </div>
      {state.message ? (
        <div
          className={`validation-item ${state.status === "error" ? "error" : state.status === "ready" ? "ok" : "warn"}`}
          role={state.status === "error" ? "alert" : "status"}
        >
          <strong>
            {state.status === "ready"
              ? "Ready"
              : state.status === "error"
                ? "Upload issue"
                : "Private video"}
          </strong>
          <span>{state.message}</span>
        </div>
      ) : null}
    </div>
  );
}

import { useEffect, useState } from "react";
import type {
  ScheduleSession,
  ScheduleWorkspace,
} from "~/modules/schedule/schedule-service.server";

export type RecoveryScope = { eventId: string; personId: string };

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

export type EditorActionData = {
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

export type SessionContentDraft = Pick<
  ScheduleSession,
  | "title"
  | "description"
  | "format"
  | "durationMinutes"
  | "trackId"
  | "visibility"
  | "requiredResources"
>;

export function fingerprint(value: unknown) {
  return JSON.stringify(value);
}

export function commandId() {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function")
    throw new Error("Secure editor save identifiers are unavailable.");
  return crypto.randomUUID();
}

export function useOnlineState() {
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
export function useScheduleAutosave(input: {
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

export function downloadRecovery(filename: string, value: unknown) {
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

export function PersistenceStatus({
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

export function statusFor(input: {
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

export function formatTime(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
}

export function formatDate(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
}

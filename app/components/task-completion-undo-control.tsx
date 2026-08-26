import { RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Form, useFetcher, useNavigation } from "react-router";
import { toast } from "sonner";

import {
  undoRemainingLabel,
  undoRemainingMilliseconds,
} from "~/components/operational-ui-rules";
import { Button } from "~/components/ui/button";

export type TaskCompletionUndoNotice = {
  ok?: boolean;
  committed?: boolean;
  message?: string;
  undoToken?: string | null;
  undoTaskId?: string | null;
  undoExpiresAt?: number | null;
};

type UndoActionResult = {
  ok: boolean;
  committed?: boolean;
  message: string;
};

function taskUndoMetadata(notice: TaskCompletionUndoNotice) {
  const hasAnyMetadata =
    notice.undoToken != null ||
    notice.undoTaskId != null ||
    notice.undoExpiresAt != null;
  if (!hasAnyMetadata) return null;

  if (
    typeof notice.undoToken !== "string" ||
    notice.undoToken.length === 0 ||
    typeof notice.undoTaskId !== "string" ||
    notice.undoTaskId.length === 0 ||
    typeof notice.undoExpiresAt !== "number" ||
    !Number.isInteger(notice.undoExpiresAt) ||
    notice.undoExpiresAt <= 0
  ) {
    throw new Error("Task completion undo metadata is incomplete or invalid.");
  }

  return {
    token: notice.undoToken,
    taskId: notice.undoTaskId,
    expiresAt: notice.undoExpiresAt,
  };
}

export function dismissOwnedTaskCompletionToasts(
  toastIds: Iterable<string>,
  dismiss: (toastId: string) => void,
) {
  for (const toastId of toastIds) dismiss(toastId);
}

export function TaskCompletionUndoControl({
  notice,
}: {
  notice: TaskCompletionUndoNotice;
}) {
  const undo = taskUndoMetadata(notice);
  const fetcher = useFetcher<UndoActionResult>();
  const navigation = useNavigation();
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const shownResult = useRef<UndoActionResult | undefined>(undefined);
  const ownedToastIds = useRef(new Set<string>());
  const previousUndoToastId = useRef<string | null>(null);
  const [fetcherToastId, setFetcherToastId] = useState<string | null>(null);
  const [remainingMilliseconds, setRemainingMilliseconds] = useState<
    number | null
  >(null);
  const toastId = undo
    ? `task-completion:${undo.taskId}:${undo.expiresAt}`
    : null;
  const undoExpiresAt = undo?.expiresAt ?? null;
  const undoToken = undo?.token ?? null;

  useEffect(() => {
    if (toastId) ownedToastIds.current.add(toastId);
  }, [toastId]);

  useEffect(
    () => () => {
      dismissOwnedTaskCompletionToasts(ownedToastIds.current, (ownedToastId) =>
        toast.dismiss(ownedToastId),
      );
      ownedToastIds.current.clear();
    },
    [],
  );

  useEffect(() => {
    const previous = previousUndoToastId.current;
    previousUndoToastId.current = toastId;
    if (!previous || toastId || !notice.message) return;

    if (notice.ok) {
      toast.success("Task completion undone", {
        id: previous,
        description: notice.message,
        duration: 5_000,
      });
    } else if (notice.committed) {
      toast.warning("Task completion undone; follow-up needed", {
        id: previous,
        description: notice.message,
        duration: 8_000,
      });
    } else {
      toast.error("Undo failed", {
        id: previous,
        description: notice.message,
        duration: 8_000,
      });
    }
  }, [notice.committed, notice.message, notice.ok, toastId]);

  useEffect(() => {
    if (undoExpiresAt === null || !toastId) {
      setRemainingMilliseconds(null);
      return;
    }

    const expiresAt = undoExpiresAt;
    const initialRemaining = undoRemainingMilliseconds(expiresAt, Date.now());
    setRemainingMilliseconds(initialRemaining);
    if (initialRemaining === 0) {
      toast.dismiss(toastId);
      return;
    }

    const interval = window.setInterval(() => {
      const remaining = undoRemainingMilliseconds(expiresAt, Date.now());
      setRemainingMilliseconds(remaining);
      if (remaining === 0) {
        toast.dismiss(toastId);
        window.clearInterval(interval);
      }
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [toastId, undoExpiresAt]);

  useEffect(() => {
    if (undoExpiresAt === null || undoToken === null || !toastId) return;

    const duration = undoRemainingMilliseconds(undoExpiresAt, Date.now());
    if (duration === 0) return;

    const description =
      notice.ok === false && notice.message
        ? `${notice.message} This shortcut remains available until the server-issued window expires unless later work makes undo unsafe.`
        : "This shortcut remains available until the server-issued window expires unless later work makes undo unsafe.";
    const options = {
      id: toastId,
      description,
      duration,
      action: {
        label: "Undo",
        onClick: () => {
          setFetcherToastId(toastId);
          toast.loading("Undoing task completion…", {
            id: toastId,
            duration: Number.POSITIVE_INFINITY,
          });
          fetcherRef.current.submit(
            {
              intent: "undo-task-completion",
              undoToken,
            },
            { method: "post" },
          );
        },
      },
    };

    if (notice.ok === false) {
      toast.warning("Task completed; follow-up needed", options);
    } else {
      toast.success("Task completed", options);
    }
  }, [notice.message, notice.ok, toastId, undoExpiresAt, undoToken]);

  const undoResult = fetcherToastId === toastId ? fetcher.data : undefined;

  useEffect(() => {
    const result = undoResult;
    if (!result || shownResult.current === result || !toastId) return;
    shownResult.current = result;

    if (result.ok) {
      toast.success("Task completion undone", {
        id: toastId,
        description: result.message,
        duration: 5_000,
      });
    } else if (result.committed) {
      toast.warning("Task completion undone; follow-up needed", {
        id: toastId,
        description: result.message,
        duration: 8_000,
      });
    } else {
      toast.error("Undo failed", {
        id: toastId,
        description: result.message,
        duration: 8_000,
      });
    }
  }, [toastId, undoResult]);

  if (!undo) {
    return null;
  }

  const expired = remainingMilliseconds === 0;
  const undoFinished = Boolean(undoResult);
  const routeUndoSubmitting =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "undo-task-completion";
  const undoSubmitting = fetcher.state !== "idle" || routeUndoSubmitting;

  return (
    <div className="stack mt">
      {!expired && !undoFinished ? (
        <Form
          method="post"
          className="page-actions"
          onSubmit={() => {
            if (!toastId) return;
            toast.loading("Undoing task completion…", {
              id: toastId,
              duration: Number.POSITIVE_INFINITY,
            });
          }}
        >
          <input type="hidden" name="undoToken" value={undo.token} />
          <Button
            size="small"
            type="submit"
            name="intent"
            value="undo-task-completion"
            disabled={undoSubmitting}
          >
            <RotateCcw aria-hidden size={14} />
            {undoSubmitting ? "Undoing…" : "Undo completion"}
          </Button>
          <span
            className="help"
            title={`Expires ${new Date(undo.expiresAt * 1_000).toISOString()}`}
          >
            {remainingMilliseconds === null
              ? "Available for five minutes unless later work makes it unsafe."
              : `${undoRemainingLabel(remainingMilliseconds)} unless later work makes it unsafe.`}
          </span>
        </Form>
      ) : null}
      {expired && !undoFinished ? (
        <span className="help" role="status">
          The five-minute undo window has expired.
        </span>
      ) : null}
      {undoResult ? (
        <span
          className={`validation-item ${undoResult.ok ? "ok" : undoResult.committed ? "warn" : "error"}`}
          role={undoResult.ok || undoResult.committed ? "status" : "alert"}
        >
          {undoResult.message}
        </span>
      ) : null}
    </div>
  );
}

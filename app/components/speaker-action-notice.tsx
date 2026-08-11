import { AlertTriangle, CheckCircle2 } from "lucide-react";

import {
  TaskCompletionUndoControl,
  type TaskCompletionUndoNotice,
} from "~/components/task-completion-undo-control";

export function SpeakerActionNotice({
  notice,
}: {
  notice?: { ok: boolean; message: string } & TaskCompletionUndoNotice;
}) {
  if (!notice) return null;
  return (
    <div
      className={`pc-status-notice ${notice.ok ? "is-success" : "is-danger"}`}
      role={notice.ok ? "status" : "alert"}
    >
      {notice.ok ? (
        <CheckCircle2 aria-hidden size={19} />
      ) : (
        <AlertTriangle aria-hidden size={19} />
      )}
      <div className="pc-status-notice-copy">
        <strong>{notice.ok ? "Saved" : "Action needed"}</strong>
        <div>{notice.message}</div>
        <TaskCompletionUndoControl notice={notice} />
      </div>
    </div>
  );
}

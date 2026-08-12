import {
  DRAFT_RECOVERY_CHANNEL_NAME,
  draftRecoveryKey,
  type DraftRecoveryScope,
  type RecoveryMessage,
} from "./draft-recovery-core";
import { indexedDbDraftSnapshotStore } from "./draft-recovery-storage";

function cleanupWriterId(fallback: string) {
  return typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : fallback;
}

function broadcast(message: RecoveryMessage) {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(DRAFT_RECOVERY_CHANNEL_NAME);
  channel.postMessage(message);
  channel.close();
}

export async function clearAllDraftRecovery() {
  await indexedDbDraftSnapshotStore.clear();
  broadcast({
    type: "clear_all",
    writerId: cleanupWriterId("sign-out"),
  });
}

export async function clearDraftRecoveryScope(scope: DraftRecoveryScope) {
  const key = draftRecoveryKey(scope);
  await indexedDbDraftSnapshotStore.delete(key);
  broadcast({
    type: "cleared",
    key,
    writerId: cleanupWriterId("scope-clear"),
  });
}

export function installDraftRecoverySignOutCleanup() {
  const resubmitting = new WeakSet<HTMLFormElement>();
  const handleSubmit = (event: SubmitEvent) => {
    if (!(event.target instanceof HTMLFormElement)) return;
    const form = event.target;
    if (resubmitting.delete(form)) return;
    const action = new URL(
      form.action || window.location.href,
      window.location.href,
    );
    const values = new FormData(form, event.submitter ?? undefined);
    const signingOut =
      action.pathname === "/sign-out" || values.get("_intent") === "sign_out";
    if (!signingOut) return;

    event.preventDefault();
    const submitter = event.submitter;
    void clearAllDraftRecovery()
      .then(() => {
        resubmitting.add(form);
        form.requestSubmit(submitter);
      })
      .catch((error: unknown) => {
        console.error("Draft recovery cleanup failed during sign-out", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        window.alert(
          "Sign-out was stopped because browser recovery copies could not be cleared. Retry sign-out before leaving this browser.",
        );
      });
  };
  document.addEventListener("submit", handleSubmit, true);
  return () => document.removeEventListener("submit", handleSubmit, true);
}

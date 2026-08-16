import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  assessDraftSnapshot,
  createDraftRecoveryOperationGuard,
  DRAFT_RECOVERY_CHANNEL_NAME,
  DRAFT_RECOVERY_SCHEMA_VERSION,
  DRAFT_RECOVERY_TTL_MS,
  type DraftRecoveryController,
  type DraftRecoveryOperationGuard,
  type DraftRecoveryState,
  type DraftSnapshot,
  draftRecoveryKey,
  type RecoveryMessage,
  type UseDraftRecoveryOptions,
} from "./draft-recovery-core";
import {
  indexedDbDraftSnapshotStore,
  pruneDraftRecovery,
} from "./draft-recovery-storage";

export * from "./draft-recovery-cleanup";
export * from "./draft-recovery-core";
export {
  indexedDbDraftSnapshotStore,
  pruneDraftRecovery,
} from "./draft-recovery-storage";

function createWriterId() {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function")
    throw new Error(
      "Secure browser identifiers are unavailable for draft recovery.",
    );
  return crypto.randomUUID();
}

function createChannel() {
  if (typeof BroadcastChannel === "undefined") {
    throw new Error(
      "This browser does not provide cross-tab draft conflict detection.",
    );
  }
  return new BroadcastChannel(DRAFT_RECOVERY_CHANNEL_NAME);
}

function payloadsMatch(left: unknown, right: unknown) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function payloadFingerprint(value: unknown) {
  try {
    return JSON.stringify(value) ?? "__program_cue_undefined_draft__";
  } catch {
    return "__program_cue_unserializable_draft__";
  }
}

export function useDraftRecovery<T>({
  scope,
  serverRevision,
  payload,
  dirty,
  onRestore,
  isPayloadCompatible,
  enabled = true,
  debounceMs = 500,
  ttlMs = DRAFT_RECOVERY_TTL_MS,
}: UseDraftRecoveryOptions<T>): DraftRecoveryController<T> {
  const key = useMemo(
    () => (scope && enabled ? draftRecoveryKey(scope) : null),
    [enabled, scope],
  );
  const revision = String(serverRevision);
  const operationGuardRef = useRef<DraftRecoveryOperationGuard | null>(null);
  if (!operationGuardRef.current)
    operationGuardRef.current = createDraftRecoveryOperationGuard();
  const operationGuard = operationGuardRef.current;
  const operationContext = JSON.stringify([key, revision]);
  const operationContextRef = useRef<string | null>(null);
  if (operationContextRef.current !== operationContext) {
    operationContextRef.current = operationContext;
    operationGuard.changeContext();
  }
  const writerId = useRef<string | null>(null);
  const payloadRef = useRef(payload);
  const scopeRef = useRef(scope);
  const initialPayloadRef = useRef(payload);
  const dirtyRef = useRef(dirty);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const [state, setState] = useState<DraftRecoveryState>(
    key ? "checking" : "idle",
  );
  const [candidate, setCandidate] = useState<DraftSnapshot<T> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const candidateRef = useRef<DraftSnapshot<T> | null>(null);
  const restoredPayloadFingerprintRef = useRef<string | null>(null);
  const stateRef = useRef(state);
  const currentPayloadFingerprint = useMemo(
    () => payloadFingerprint(payload),
    [payload],
  );

  payloadRef.current = payload;
  scopeRef.current = scope;
  dirtyRef.current = dirty;
  candidateRef.current = candidate;
  stateRef.current = state;

  const broadcast = useCallback((value: Omit<RecoveryMessage, "writerId">) => {
    if (!writerId.current) return;
    channelRef.current?.postMessage({ ...value, writerId: writerId.current });
  }, []);

  const load = useCallback(
    async (crossTab = false) => {
      if (!key) return;
      const operation = operationGuard.begin("load");
      const isCurrent = () => operationGuard.isCurrent(operation);
      try {
        restoredPayloadFingerprintRef.current = null;
        await pruneDraftRecovery();
        if (!isCurrent()) return;
        const snapshot = await indexedDbDraftSnapshotStore.get<T>(key);
        if (!isCurrent()) return;
        if (!snapshot) {
          if (!crossTab) setState(navigator.onLine ? "idle" : "offline");
          setCandidate(null);
          setMessage(null);
          return;
        }
        const assessment = assessDraftSnapshot(snapshot, revision);
        if (assessment === "expired") {
          await indexedDbDraftSnapshotStore.delete(key);
          if (!isCurrent()) return;
          setCandidate(null);
          setMessage(null);
          setState(navigator.onLine ? "idle" : "offline");
          return;
        }
        if (
          assessment === "incompatible" ||
          (isPayloadCompatible && !isPayloadCompatible(snapshot.payload))
        ) {
          setCandidate(snapshot);
          setState("incompatible");
          setMessage(
            "This browser draft is incompatible with the current editor. Keep the server version or discard the local snapshot.",
          );
          return;
        }
        if (
          !crossTab &&
          assessment === "restore_available" &&
          payloadsMatch(snapshot.payload, initialPayloadRef.current)
        ) {
          await indexedDbDraftSnapshotStore.delete(key);
          if (!isCurrent()) return;
          setCandidate(null);
          setMessage(null);
          setState(navigator.onLine ? "idle" : "offline");
          return;
        }
        setCandidate(snapshot);
        if (assessment === "conflict" || (crossTab && dirtyRef.current)) {
          setState("conflict");
          setMessage(
            assessment === "conflict"
              ? "The server changed after this browser snapshot was saved. Choose which version to keep; nothing has been overwritten."
              : "Another tab saved edits for this record. Choose which local version to keep; nothing has been overwritten.",
          );
        } else {
          setState("restore_available");
          setMessage(
            crossTab
              ? "Another tab saved edits for this record. Restore them only if they are the version you want."
              : "Unfinished edits are available in this browser. They have not changed the server draft.",
          );
        }
      } catch (error) {
        if (!isCurrent()) return;
        setState("retry_required");
        setMessage(
          error instanceof Error
            ? error.message
            : "Browser draft recovery failed. Retry before leaving this page.",
        );
      }
    },
    [isPayloadCompatible, key, operationGuard, revision],
  );

  useEffect(() => {
    initialPayloadRef.current = payloadRef.current;
    restoredPayloadFingerprintRef.current = null;
    setCandidate(null);
    setMessage(null);
    if (!key) {
      setState("idle");
      return;
    }
    setState("checking");
    try {
      writerId.current = createWriterId();
      const channel = createChannel();
      channelRef.current = channel;
      channel.addEventListener(
        "message",
        (event: MessageEvent<RecoveryMessage>) => {
          const value = event.data;
          if (!value || value.writerId === writerId.current) return;
          if (value.type === "clear_all") {
            operationGuard.invalidate("load");
            operationGuard.invalidate("save");
            setCandidate(null);
            setMessage(null);
            setState("idle");
            return;
          }
          if (value.key !== key) return;
          if (value.type === "saved") void load(true);
          else if (!dirtyRef.current) {
            operationGuard.invalidate("load");
            setCandidate(null);
            setMessage(null);
            setState(navigator.onLine ? "idle" : "offline");
          }
        },
      );
      void load();
      return () => {
        operationGuard.changeContext();
        channel.close();
        channelRef.current = null;
      };
    } catch (error) {
      setState("retry_required");
      setMessage(
        error instanceof Error
          ? error.message
          : "Browser draft recovery could not start.",
      );
    }
  }, [key, load, operationGuard]);

  useEffect(() => {
    if (!key) return;
    const online = () => {
      if (state === "offline") setState(dirtyRef.current ? "saved" : "idle");
    };
    const offline = () => {
      if (!candidateRef.current) setState("offline");
    };
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, [key, state]);

  useEffect(() => {
    const restoredPayloadFingerprint = restoredPayloadFingerprintRef.current;
    // Restoring does not create new local work: the exact payload is already
    // durable in IndexedDB. Keep the explicit acknowledgement visible until
    // the user changes that payload again.
    if (
      !key ||
      !scopeRef.current ||
      !dirty ||
      candidate ||
      stateRef.current === "retry_required" ||
      (stateRef.current === "restored" &&
        restoredPayloadFingerprint !== null &&
        restoredPayloadFingerprint === currentPayloadFingerprint)
    )
      return;
    restoredPayloadFingerprintRef.current = null;
    setState(navigator.onLine ? "saving" : "offline");
    const operation = operationGuard.begin("save");
    const timer = window.setTimeout(() => {
      if (!writerId.current || !operationGuard.isCurrent(operation)) return;
      const now = Date.now();
      const snapshot: DraftSnapshot<T> = {
        ...scopeRef.current!,
        key,
        schemaVersion: DRAFT_RECOVERY_SCHEMA_VERSION,
        serverRevision: revision,
        payload: payloadRef.current,
        savedAt: now,
        expiresAt: now + ttlMs,
        writerId: writerId.current,
      };
      void indexedDbDraftSnapshotStore
        .put(snapshot)
        .then(() => {
          if (!operationGuard.isCurrent(operation)) return;
          broadcast({ type: "saved", key });
          setState(navigator.onLine ? "saved" : "offline");
          setMessage(null);
        })
        .catch((error: unknown) => {
          if (!operationGuard.isCurrent(operation)) return;
          setState("retry_required");
          setMessage(
            error instanceof Error
              ? error.message
              : "The browser draft could not be saved.",
          );
        });
    }, debounceMs);
    return () => {
      window.clearTimeout(timer);
      if (operationGuard.isCurrent(operation))
        operationGuard.invalidate("save");
    };
  }, [
    broadcast,
    candidate,
    debounceMs,
    dirty,
    key,
    currentPayloadFingerprint,
    operationGuard,
    revision,
    ttlMs,
  ]);

  const discard = useCallback(async () => {
    if (!key) return;
    operationGuard.invalidate("load");
    operationGuard.invalidate("save");
    const operation = operationGuard.begin("mutation");
    try {
      await indexedDbDraftSnapshotStore.delete(key);
      if (!operationGuard.isCurrent(operation)) return;
      broadcast({ type: "cleared", key });
      restoredPayloadFingerprintRef.current = null;
      setCandidate(null);
      setMessage(null);
      setState(navigator.onLine ? "idle" : "offline");
    } catch (error) {
      if (!operationGuard.isCurrent(operation)) return;
      setState("retry_required");
      setMessage(
        error instanceof Error
          ? error.message
          : "The browser draft could not be cleared.",
      );
    }
  }, [broadcast, key, operationGuard]);

  const restore = useCallback(() => {
    if (!candidate) return;
    restoredPayloadFingerprintRef.current = payloadFingerprint(
      candidate.payload,
    );
    onRestore(candidate.payload);
    setCandidate(null);
    setMessage(
      "Browser edits were restored for review. Save them to make them authoritative.",
    );
    setState("restored");
  }, [candidate, onRestore]);

  const markServerSaved = useCallback(async () => {
    if (!key) return;
    operationGuard.invalidate("load");
    operationGuard.invalidate("save");
    const operation = operationGuard.begin("mutation");
    try {
      await indexedDbDraftSnapshotStore.delete(key);
      if (!operationGuard.isCurrent(operation)) return;
      broadcast({ type: "cleared", key });
      restoredPayloadFingerprintRef.current = null;
      setCandidate(null);
      setMessage(null);
      setState("saved");
    } catch (error) {
      if (!operationGuard.isCurrent(operation)) return;
      setState("retry_required");
      setMessage(
        error instanceof Error
          ? error.message
          : "The saved server draft could not clear its browser snapshot.",
      );
    }
  }, [broadcast, key, operationGuard]);

  return {
    state,
    candidate,
    message,
    restore,
    discard,
    retry: load,
    markServerSaved,
    clear: discard,
  };
}

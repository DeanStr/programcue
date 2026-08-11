import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const DRAFT_RECOVERY_SCHEMA_VERSION = 1;
export const DRAFT_RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

const DATABASE_NAME = "program-cue-draft-recovery";
const DATABASE_VERSION = 2;
const OBJECT_STORE = "snapshots";
const EXPIRY_INDEX = "expiresAt";
const SCHEMA_INDEX = "schemaVersion";
const CHANNEL_NAME = "program-cue-draft-recovery-v1";
const PRUNE_LIMIT = 250;

export type DraftRecoveryScope = {
  eventId: string;
  personId: string;
  recordType: string;
  recordId: string;
};

export type DraftSnapshot<T> = DraftRecoveryScope & {
  key: string;
  schemaVersion: number;
  serverRevision: string;
  payload: T;
  savedAt: number;
  expiresAt: number;
  writerId: string;
};

export type DraftRecoveryState =
  | "checking"
  | "idle"
  | "saving"
  | "saved"
  | "offline"
  | "retry_required"
  | "restore_available"
  | "restored"
  | "conflict";

export type DraftSnapshotAssessment =
  "expired" | "incompatible" | "restore_available" | "conflict";

export type DraftSnapshotStore = {
  get<T>(key: string): Promise<DraftSnapshot<T> | null>;
  put<T>(snapshot: DraftSnapshot<T>): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
};

type RecoveryMessage = {
  type: "saved" | "cleared" | "clear_all";
  key?: string;
  writerId: string;
};

type DraftRecoveryOperationKind = "load" | "save" | "mutation";
type DraftRecoveryOperationToken = {
  generation: number;
  kind: DraftRecoveryOperationKind;
  sequence: number;
};

export type DraftRecoveryOperationGuard = {
  changeContext(): void;
  begin(kind: DraftRecoveryOperationKind): DraftRecoveryOperationToken;
  invalidate(kind: DraftRecoveryOperationKind): void;
  isCurrent(token: DraftRecoveryOperationToken): boolean;
};

/**
 * IndexedDB work cannot be aborted reliably after its transaction starts.
 * Tokens prevent an older record or superseded operation from publishing its
 * completion into the currently rendered editor.
 */
export function createDraftRecoveryOperationGuard(): DraftRecoveryOperationGuard {
  let generation = 0;
  const sequences: Record<DraftRecoveryOperationKind, number> = {
    load: 0,
    save: 0,
    mutation: 0,
  };
  return {
    changeContext() {
      generation += 1;
      sequences.load += 1;
      sequences.save += 1;
      sequences.mutation += 1;
    },
    begin(kind) {
      sequences[kind] += 1;
      return { generation, kind, sequence: sequences[kind] };
    },
    invalidate(kind) {
      sequences[kind] += 1;
    },
    isCurrent(token) {
      return (
        token.generation === generation &&
        token.sequence === sequences[token.kind]
      );
    },
  };
}

export type UseDraftRecoveryOptions<T> = {
  scope: DraftRecoveryScope | null;
  serverRevision: string | number;
  payload: T;
  dirty: boolean;
  onRestore(payload: T): void;
  enabled?: boolean;
  debounceMs?: number;
  ttlMs?: number;
};

export type DraftRecoveryController<T> = {
  state: DraftRecoveryState;
  candidate: DraftSnapshot<T> | null;
  message: string | null;
  restore(): void;
  discard(): Promise<void>;
  retry(): Promise<void>;
  markServerSaved(): Promise<void>;
  clear(): Promise<void>;
};

function nonEmpty(value: string, field: keyof DraftRecoveryScope) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Draft recovery ${field} is required.`);
  return trimmed;
}

export function draftRecoveryKey(scope: DraftRecoveryScope) {
  return JSON.stringify([
    DRAFT_RECOVERY_SCHEMA_VERSION,
    nonEmpty(scope.eventId, "eventId"),
    nonEmpty(scope.personId, "personId"),
    nonEmpty(scope.recordType, "recordType"),
    nonEmpty(scope.recordId, "recordId"),
  ]);
}

export function assessDraftSnapshot(
  snapshot: Pick<
    DraftSnapshot<unknown>,
    "schemaVersion" | "serverRevision" | "expiresAt"
  >,
  currentServerRevision: string | number,
  now = Date.now(),
): DraftSnapshotAssessment {
  if (snapshot.expiresAt <= now) return "expired";
  if (snapshot.schemaVersion !== DRAFT_RECOVERY_SCHEMA_VERSION)
    return "incompatible";
  return snapshot.serverRevision === String(currentServerRevision)
    ? "restore_available"
    : "conflict";
}

function isDraftSnapshot(value: unknown): value is DraftSnapshot<unknown> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DraftSnapshot<unknown>>;
  return (
    typeof candidate.key === "string" &&
    typeof candidate.eventId === "string" &&
    typeof candidate.personId === "string" &&
    typeof candidate.recordType === "string" &&
    typeof candidate.recordId === "string" &&
    typeof candidate.schemaVersion === "number" &&
    typeof candidate.serverRevision === "string" &&
    typeof candidate.savedAt === "number" &&
    Number.isFinite(candidate.savedAt) &&
    typeof candidate.expiresAt === "number" &&
    Number.isFinite(candidate.expiresAt) &&
    typeof candidate.writerId === "string" &&
    Object.hasOwn(candidate, "payload")
  );
}

export function shouldPruneDraftSnapshot(value: unknown, now = Date.now()) {
  return (
    !isDraftSnapshot(value) ||
    value.expiresAt <= now ||
    value.schemaVersion !== DRAFT_RECOVERY_SCHEMA_VERSION
  );
}

function openDatabase() {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(
      new Error("This browser does not provide IndexedDB draft recovery."),
    );
  }
  return new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(OBJECT_STORE)
        ? request.transaction!.objectStore(OBJECT_STORE)
        : database.createObjectStore(OBJECT_STORE, { keyPath: "key" });
      if (!store.indexNames.contains(EXPIRY_INDEX))
        store.createIndex(EXPIRY_INDEX, "expiresAt");
      if (!store.indexNames.contains(SCHEMA_INDEX))
        store.createIndex(SCHEMA_INDEX, "schemaVersion");
    });
    request.addEventListener("success", () => {
      if (settled) request.result.close();
      else {
        settled = true;
        resolve(request.result);
      }
    });
    request.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      reject(
        request.error ?? new Error("Draft recovery database failed to open."),
      );
    });
    request.addEventListener("blocked", () => {
      if (settled) return;
      settled = true;
      reject(new Error("Draft recovery database upgrade is blocked."));
    });
  });
}

/**
 * Removes a bounded batch of expired, incompatible or malformed snapshots
 * whenever an editor starts. Indexes find stale records regardless of store
 * order; a bounded cursor also catches legacy values missing indexed fields.
 */
export async function pruneDraftRecovery(
  now = Date.now(),
  limit = PRUNE_LIMIT,
) {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new RangeError(
      "Draft recovery prune limit must be a positive integer.",
    );
  const database = await openDatabase();
  try {
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const current = database.transaction(OBJECT_STORE, "readonly");
      const store = current.objectStore(OBJECT_STORE);
      const malformedKeys: IDBValidKey[] = [];
      let inspected = 0;
      const cursor = store.openCursor();
      cursor.addEventListener("success", () => {
        const item = cursor.result;
        if (!item || inspected >= limit) return;
        inspected += 1;
        if (shouldPruneDraftSnapshot(item.value, now))
          malformedKeys.push(item.primaryKey);
        item.continue();
      });
      cursor.addEventListener("error", () => current.abort());
      const requests = [
        store
          .index(EXPIRY_INDEX)
          .getAllKeys(IDBKeyRange.upperBound(now), limit),
        store
          .index(SCHEMA_INDEX)
          .getAllKeys(
            IDBKeyRange.upperBound(DRAFT_RECOVERY_SCHEMA_VERSION - 1),
            limit,
          ),
        store
          .index(SCHEMA_INDEX)
          .getAllKeys(
            IDBKeyRange.lowerBound(DRAFT_RECOVERY_SCHEMA_VERSION + 1),
            limit,
          ),
      ];
      for (const request of requests)
        request.addEventListener("error", () => current.abort());
      current.addEventListener("complete", () =>
        resolve(
          [
            ...new Set([
              ...malformedKeys,
              ...requests.flatMap((request) => request.result),
            ]),
          ].slice(0, limit),
        ),
      );
      current.addEventListener("abort", () =>
        reject(
          current.error ??
            new Error("Expired browser drafts could not be inspected."),
        ),
      );
    });
    if (!keys.length) return 0;
    await new Promise<void>((resolve, reject) => {
      const current = database.transaction(OBJECT_STORE, "readwrite");
      const store = current.objectStore(OBJECT_STORE);
      for (const key of keys) store.delete(key);
      current.addEventListener("complete", () => resolve());
      current.addEventListener("abort", () =>
        reject(
          current.error ??
            new Error("Expired browser drafts could not be pruned."),
        ),
      );
    });
    return keys.length;
  } finally {
    database.close();
  }
}

async function transaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const current = database.transaction(OBJECT_STORE, mode);
      const request = operation(current.objectStore(OBJECT_STORE));
      let result: T;
      request.addEventListener("success", () => {
        result = request.result;
      });
      request.addEventListener("error", () =>
        reject(request.error ?? new Error("Draft recovery operation failed.")),
      );
      current.addEventListener("complete", () => resolve(result));
      current.addEventListener("abort", () =>
        reject(
          current.error ?? new Error("Draft recovery transaction aborted."),
        ),
      );
    });
  } finally {
    database.close();
  }
}

export const indexedDbDraftSnapshotStore: DraftSnapshotStore = {
  async get<T>(key: string) {
    const value = await transaction<unknown>("readonly", (store) =>
      store.get(key),
    );
    if (value === undefined) return null;
    if (!isDraftSnapshot(value)) {
      throw new Error(
        "The saved browser draft is invalid and was not restored.",
      );
    }
    return value as DraftSnapshot<T>;
  },
  async put<T>(snapshot: DraftSnapshot<T>) {
    await transaction("readwrite", (store) => store.put(snapshot));
  },
  async delete(key: string) {
    await transaction("readwrite", (store) => store.delete(key));
  },
  async clear() {
    await transaction("readwrite", (store) => store.clear());
  },
};

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
  return new BroadcastChannel(CHANNEL_NAME);
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
  enabled = true,
  debounceMs = 500,
  ttlMs = DRAFT_RECOVERY_TTL_MS,
}: UseDraftRecoveryOptions<T>): DraftRecoveryController<T> {
  const key = useMemo(
    () => (scope && enabled ? draftRecoveryKey(scope) : null),
    [
      enabled,
      scope?.eventId,
      scope?.personId,
      scope?.recordId,
      scope?.recordType,
    ],
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
        if (assessment === "incompatible") {
          setCandidate(snapshot);
          setState("conflict");
          setMessage(
            "This browser draft was created by an incompatible editor version. Keep the server version or discard the local snapshot.",
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
    [key, operationGuard, revision],
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

export async function clearAllDraftRecovery() {
  await indexedDbDraftSnapshotStore.clear();
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage({
      type: "clear_all",
      writerId:
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : "sign-out",
    } satisfies RecoveryMessage);
    channel.close();
  }
}

export async function clearDraftRecoveryScope(scope: DraftRecoveryScope) {
  const key = draftRecoveryKey(scope);
  await indexedDbDraftSnapshotStore.delete(key);
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage({
      type: "cleared",
      key,
      writerId:
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : "scope-clear",
    } satisfies RecoveryMessage);
    channel.close();
  }
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

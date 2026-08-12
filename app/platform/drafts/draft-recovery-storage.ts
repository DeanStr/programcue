import {
  DRAFT_RECOVERY_SCHEMA_VERSION,
  isDraftSnapshot,
  shouldPruneDraftSnapshot,
  type DraftSnapshot,
  type DraftSnapshotStore,
} from "./draft-recovery-core";

const DATABASE_NAME = "program-cue-draft-recovery";
const DATABASE_VERSION = 2;
const OBJECT_STORE = "snapshots";
const EXPIRY_INDEX = "expiresAt";
const SCHEMA_INDEX = "schemaVersion";
const PRUNE_LIMIT = 250;

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

/** Removes one bounded batch of expired, incompatible, or malformed drafts. */
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

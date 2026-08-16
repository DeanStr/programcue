export const DRAFT_RECOVERY_SCHEMA_VERSION = 1;
export const DRAFT_RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const DRAFT_RECOVERY_CHANNEL_NAME = "program-cue-draft-recovery-v1";

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
  | "incompatible"
  | "restore_available"
  | "restored"
  | "conflict";

export type DraftSnapshotAssessment =
  | "expired"
  | "incompatible"
  | "restore_available"
  | "conflict";

export type DraftSnapshotStore = {
  get<T>(key: string): Promise<DraftSnapshot<T> | null>;
  put<T>(snapshot: DraftSnapshot<T>): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
};

export type RecoveryMessage = {
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
  isPayloadCompatible?(payload: unknown): payload is T;
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

export function isDraftSnapshot(
  value: unknown,
): value is DraftSnapshot<unknown> {
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

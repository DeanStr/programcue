import { z } from "zod";
import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  AcceleventsProvider,
  acceleventsCredentialsSchema,
  type AcceleventsSessionPayload,
  type AcceleventsSessionSpeakerAssociationPayload,
  type AcceleventsSpeakerPayload,
  type AcceleventsTrackPayload,
} from "./accelevents-provider.server";

export type IntegrationApiActor = {
  kind: "api_key";
  organisationId: string;
  eventId: string;
  personId: null;
  actorId: string;
};

export type IntegrationAdminActor = Viewer | IntegrationApiActor;

export const integrationRunMessageSchema = z.object({
  type: z.literal("integration.accelevents.export"),
  operationId: z.string().min(1),
  runId: z.string().min(1),
  connectionId: z.string().min(1),
  connectionRevision: z.number().int().positive(),
  organisationId: z.string().min(1),
  eventId: z.string().min(1),
  itemId: z.string().min(1).optional(),
});

export const configureIntegrationConnectionSchema =
  acceleventsCredentialsSchema.extend({
    provider: z.literal("accelevents"),
  });

export const integrationMappingInputSchema = z
  .object({
    entityType: z.enum(["speaker", "track", "session", "session_speaker"]),
    entityId: z.string().trim().min(1).max(300),
    externalId: z.string().trim().min(1).max(300),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    metadata: z.record(z.string().max(100), z.unknown()).default({}),
  })
  .strict();

export const runIdentitySchema = {
  connectionId: z.string().min(1),
  idempotencyKey: z.string().trim().min(8).max(128),
};

export const startRunSchema = z.discriminatedUnion("dryRun", [
  z
    .object({
      ...runIdentitySchema,
      dryRun: z.literal(true),
      previewFingerprint: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      ...runIdentitySchema,
      dryRun: z.literal(false),
      previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
]);

export type IntegrationPlanChange = {
  field: string;
  before: unknown;
  after: unknown;
};

export type IntegrationPlanItem = {
  entityType: "speaker" | "track" | "session" | "session_speaker";
  entityId: string;
  label: string;
  action: "create" | "update" | "noop";
  externalId: string | null;
  sourceHash: string;
  payload:
    | AcceleventsSpeakerPayload
    | AcceleventsTrackPayload
    | AcceleventsSessionPayload
    | AcceleventsSessionSpeakerAssociationPayload;
  changes: IntegrationPlanChange[];
  providerSupport: "supported" | "blocked";
  providerMessage: string | null;
};

export class IntegrationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationStateError";
  }
}

export type IntegrationServiceDependencies = {
  airtable?: AirtableProviderBoundary;
  createAccelevents?: (
    credentials: z.infer<typeof acceleventsCredentialsSchema>,
  ) => Pick<AcceleventsProvider, "validateConnection">;
  enqueue?: (
    message: z.infer<typeof integrationRunMessageSchema>,
  ) => Promise<void>;
};

export type ConnectionRow = {
  id: string;
  provider: string;
  status: string;
  direction: string;
  configurationJson: string;
  encryptedCredentials: string | null;
  updatedAt: number;
};

export type LocalSpeakerRow = {
  id: string;
  displayName: string;
  email: string;
  biography: string | null;
  organisationName: string | null;
  jobTitle: string | null;
};

export type LocalSessionRow = {
  id: string;
  title: string;
  description: string | null;
  format: string;
  visibility: string;
  startsAt: number;
  endsAt: number;
  room: string | null;
  timezone: string;
};

export type LocalTrackRow = {
  id: string;
  name: string;
  slug: string;
  colour: string | null;
  position: number;
};

export type LocalSessionSpeakerRow = {
  sessionId: string;
  sessionTitle: string;
  personId: string;
  displayName: string;
  position: number;
  roleLabel: string | null;
};

export type MappingRow = {
  entityType: string;
  entityId: string;
  externalId: string;
  sourceHash: string;
  metadataJson: string;
};

export type ExistingRun = {
  runId: string;
  operationId: string | null;
  operationStatus: string | null;
  dryRun: number;
  requestHash: string | null;
  previewFingerprint: string | null;
};

export function splitName(displayName: string) {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2)
    throw new IntegrationStateError(
      `Speaker “${displayName}” needs both a first and last name for Accelevents. Update the speaker’s display name, then preview the export again.`,
    );
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts.at(-1)!,
  };
}

export function acceleventsSessionFormat(
  format: string,
): AcceleventsSessionPayload["format"] {
  if (format === "keynote") return "MAIN_STAGE";
  if (format === "workshop") return "WORKSHOP";
  if (format === "break") return "BREAK";
  if (format === "other") return "OTHER";
  return "BREAKOUT_SESSION";
}

export function eventLocalDateTime(epoch: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epoch * 1_000));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const values = {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
  if (Object.values(values).some((value) => !value))
    throw new IntegrationStateError(
      "The event timezone could not be formatted for Accelevents.",
    );
  return `${values.year}/${values.month}/${values.day} ${values.hour}:${values.minute}`;
}

export function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

export function stableJson(value: unknown) {
  return JSON.stringify(canonicalValue(value));
}

export async function sourceHash(payload: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stableJson(payload)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function mappingPayload(mapping: MappingRow | undefined) {
  if (!mapping) return null;
  let metadata: unknown;
  try {
    metadata = JSON.parse(mapping.metadataJson);
  } catch {
    throw new IntegrationStateError(
      `The saved ${mapping.entityType} mapping contains invalid metadata.`,
    );
  }
  if (!metadata || typeof metadata !== "object" || !("payload" in metadata))
    return null;
  return (metadata as { payload: unknown }).payload;
}

export function payloadChanges(before: unknown, after: unknown) {
  const beforeRecord =
    before && typeof before === "object" && !Array.isArray(before)
      ? (before as Record<string, unknown>)
      : {};
  const afterRecord =
    after && typeof after === "object" && !Array.isArray(after)
      ? (after as Record<string, unknown>)
      : {};
  return [
    ...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)]),
  ]
    .sort()
    .filter(
      (field) =>
        stableJson(beforeRecord[field] ?? null) !==
        stableJson(afterRecord[field] ?? null),
    )
    .map((field) => ({
      field,
      before: beforeRecord[field] ?? null,
      after: afterRecord[field] ?? null,
    }));
}

export async function planItem(
  input: Omit<IntegrationPlanItem, "action" | "sourceHash" | "changes"> & {
    mapping?: MappingRow;
  },
): Promise<IntegrationPlanItem> {
  const hash = await sourceHash(input.payload);
  const before = mappingPayload(input.mapping);
  const { mapping, ...item } = input;
  return {
    ...item,
    action: !mapping
      ? "create"
      : mapping.sourceHash === hash
        ? "noop"
        : "update",
    externalId: mapping?.externalId ?? item.externalId,
    sourceHash: hash,
    changes: payloadChanges(before, input.payload),
  };
}

export function summary(items: IntegrationPlanItem[]) {
  return {
    total: items.length,
    create: items.filter((item) => item.action === "create").length,
    update: items.filter((item) => item.action === "update").length,
    noop: items.filter((item) => item.action === "noop").length,
    blocked: items.filter(
      (item) => item.action !== "noop" && item.providerSupport === "blocked",
    ).length,
  };
}

export abstract class IntegrationServiceFoundation {
  protected readonly airtable: AirtableProviderBoundary;
  constructor(
    protected readonly env: CloudflareEnvironment,
    protected readonly dependencies: IntegrationServiceDependencies = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  protected assertAdministrator(viewer: IntegrationAdminActor) {
    if ("kind" in viewer) {
      if (
        viewer.kind !== "api_key" ||
        viewer.personId !== null ||
        !viewer.actorId.startsWith("api_key:")
      ) {
        throw new Response("Invalid integration API actor", { status: 403 });
      }
      return;
    }
    if (!(["owner", "administrator"] as const).includes(viewer.role as never))
      throw new Response("Administrator access is required", { status: 403 });
  }

  protected auditActor(viewer: IntegrationAdminActor) {
    return "kind" in viewer
      ? { personId: null, actorId: viewer.actorId }
      : { personId: viewer.personId, actorId: null };
  }

  protected accelevents(
    credentials: z.infer<typeof acceleventsCredentialsSchema>,
  ) {
    return (
      this.dependencies.createAccelevents?.(credentials) ??
      new AcceleventsProvider(credentials)
    );
  }

  protected async enqueue(
    message: z.infer<typeof integrationRunMessageSchema>,
  ) {
    if (this.dependencies.enqueue) return this.dependencies.enqueue(message);
    if (!this.env.OPERATIONS_QUEUE)
      throw new IntegrationStateError(
        "The operations Queue binding is required for integration exports.",
      );
    await this.env.OPERATIONS_QUEUE.send(message);
  }

  protected async existingRun(
    viewer: IntegrationAdminActor,
    connectionId: string,
    idempotencyKey: string,
  ) {
    return this.env.DB.prepare(
      `SELECT run.id AS runId, run.operation_id AS operationId,
              operation.status AS operationStatus, run.dry_run AS dryRun,
              json_extract(run.summary_json, '$.requestHash') AS requestHash,
              json_extract(run.summary_json, '$.previewFingerprint') AS previewFingerprint
         FROM integration_runs run
         JOIN integration_connections connection ON connection.id = run.connection_id
         LEFT JOIN operation_jobs operation ON operation.id = run.operation_id
        WHERE run.connection_id = ? AND run.idempotency_key = ?
          AND connection.event_id = ? AND connection.organisation_id = ?`,
    )
      .bind(connectionId, idempotencyKey, viewer.eventId, viewer.organisationId)
      .first<ExistingRun>();
  }

  protected replayRun(
    existing: ExistingRun,
    dryRun: boolean,
    requestHash: string,
  ) {
    if (
      Boolean(existing.dryRun) !== dryRun ||
      existing.requestHash !== requestHash
    ) {
      throw new IntegrationStateError(
        "This idempotency key was already used with a different export request.",
      );
    }
    return {
      runId: existing.runId,
      operationId: existing.operationId,
      queued: existing.operationStatus === "queued",
      replayed: true,
      previewFingerprint: existing.previewFingerprint,
    };
  }
}

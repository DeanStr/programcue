import { z } from "zod";

export const auditActorKinds = [
  "historical",
  "person",
  "api_key",
  "agent",
  "provider",
  "system",
] as const;

export type AuditActorKind = (typeof auditActorKinds)[number];

export const auditOrigins = [
  "historical",
  "admin_ui",
  "participant_ui",
  "public_form",
  "api",
  "provider_webhook",
  "queue",
  "scheduled",
  "internal",
] as const;

export type AuditOrigin = (typeof auditOrigins)[number];

export const auditScopes = ["event", "organisation"] as const;
export type AuditScope = (typeof auditScopes)[number];

export const AUDIT_METADATA_VERSION = 1 as const;
export const AUDIT_ACTIVITY_PAGE_SIZE = 50;

const displayString = z.string().min(1).max(500);
const displayCount = z.number().int().nonnegative();
const displayRevision = z.number().int().positive();

type DisplayMetadataContract = {
  fields: readonly string[];
  schema: z.ZodType<Record<string, unknown>>;
};

function displayMetadataContract(
  fields: readonly string[],
  schema: z.ZodType<Record<string, unknown>>,
): DisplayMetadataContract {
  return { fields, schema };
}

const displayMetadataByAction: Readonly<
  Record<string, DisplayMetadataContract>
> = {
  "data.exported": displayMetadataContract(
    ["resource", "rowCount"],
    z.object({ resource: displayString, rowCount: displayCount }),
  ),
  "decision.drafted": displayMetadataContract(
    ["decision"],
    z.object({ decision: displayString }),
  ),
  "decision.published": displayMetadataContract(
    ["decision"],
    z.object({ decision: displayString }),
  ),
  "decision.recorded": displayMetadataContract(
    ["outcome"],
    z.object({ outcome: displayString }),
  ),
  "event.settings.updated": displayMetadataContract(
    ["revision", "roomCount", "trackCount"],
    z.object({
      revision: displayRevision,
      roomCount: displayCount,
      trackCount: displayCount,
    }),
  ),
  "integration.run.created": displayMetadataContract(
    ["dryRun"],
    z.object({ dryRun: z.boolean() }),
  ),
  "membership.accepted": displayMetadataContract(
    ["role"],
    z.object({ role: displayString }),
  ),
  "operation.failure_acknowledged": displayMetadataContract(
    ["type", "status"],
    z.object({ type: displayString, status: displayString }),
  ),
  "participant.retention.completed": displayMetadataContract(
    ["scope", "repositoryProvider"],
    z.object({ scope: displayString, repositoryProvider: displayString }),
  ),
  "programme_embed.created": displayMetadataContract(
    ["status", "revision"],
    z.object({ status: displayString, revision: displayRevision }),
  ),
  "programme_embed.updated": displayMetadataContract(
    ["status", "revision"],
    z.object({ status: displayString, revision: displayRevision }),
  ),
  "review.conflict.declared": displayMetadataContract(
    ["targetType", "targetId", "roundId"],
    z.object({
      targetType: z.enum(["submission", "session"]),
      targetId: displayString,
      roundId: displayString,
    }),
  ),
  "review.reopened": displayMetadataContract(
    ["revision"],
    z.object({ revision: displayRevision }),
  ),
  "schedule.published": displayMetadataContract(
    ["entryCount"],
    z.object({ entryCount: displayCount }),
  ),
  "speaker.blackout.created": displayMetadataContract(
    ["windowId", "startsAt", "endsAt"],
    z.object({
      windowId: displayString,
      personId: displayString,
      startsAt: z.number().int().nonnegative(),
      endsAt: z.number().int().positive(),
    }),
  ),
  "speaker.blackout.deleted": displayMetadataContract(
    ["windowId", "startsAt", "endsAt"],
    z.object({
      windowId: displayString,
      personId: displayString,
      startsAt: z.number().int().nonnegative(),
      endsAt: z.number().int().positive(),
    }),
  ),
  "speaker.blackout.deleted_by_organiser": displayMetadataContract(
    ["windowId", "startsAt", "endsAt"],
    z.object({
      windowId: displayString,
      personId: displayString,
      startsAt: z.number().int().nonnegative(),
      endsAt: z.number().int().positive(),
    }),
  ),
  "session.content.status_changed": displayMetadataContract(
    ["from", "to", "contentRevision"],
    z.object({
      from: displayString,
      to: displayString,
      contentRevision: displayRevision,
    }),
  ),
  "session.content.updated": displayMetadataContract(
    ["revision", "contentRevision"],
    z.object({
      revision: displayRevision,
      contentRevision: displayRevision,
    }),
  ),
  "submission.revised": displayMetadataContract(
    ["revision"],
    z.object({ revision: displayRevision }),
  ),
  "submission.submitted": displayMetadataContract(
    ["version"],
    z.object({ version: displayRevision }),
  ),
  "submission.withdrawn": displayMetadataContract(
    ["revision"],
    z.object({ revision: displayRevision }),
  ),
};

function displayValue(value: unknown) {
  if (typeof value === "string") return value.trim().slice(0, 160) || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (
    Array.isArray(value) &&
    value.length <= 8 &&
    value.every((item) => typeof item === "string")
  ) {
    return value.map((item) => item.slice(0, 60)).join(", ");
  }
  return null;
}

function label(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./u, (character) => character.toUpperCase());
}

/**
 * Audit payloads are never rendered generically. Only fields approved for the
 * exact action may cross the server/UI boundary.
 */
export function auditDisplaySummary(
  action: string,
  metadataVersion: number,
  metadata: unknown,
) {
  if (metadataVersion !== AUDIT_METADATA_VERSION) return null;
  const contract = displayMetadataByAction[action];
  if (!contract) return null;
  const parsed = contract.schema.safeParse(metadata);
  if (!parsed.success) {
    throw new Error(
      `Audit metadata for ${action} does not satisfy version ${metadataVersion}.`,
    );
  }
  const values = contract.fields.flatMap((key) => {
    const value = displayValue(parsed.data[key]);
    return value === null ? [] : [`${label(key)}: ${value}`];
  });
  return values.length ? values.join(" · ") : null;
}

export function auditOperationId(
  action: string,
  metadataVersion: number,
  metadata: unknown,
) {
  if (metadataVersion !== AUDIT_METADATA_VERSION) return null;
  // Only operational event families can produce a privileged operation link.
  if (
    !/^(?:data_|integration\.|operation\.|session_bulk\.|task_bulk\.|webhook)/u.test(
      action,
    )
  ) {
    return null;
  }
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    !("operationId" in metadata)
  ) {
    return null;
  }
  const operationId = metadata.operationId;
  if (
    typeof operationId !== "string" ||
    operationId.trim() !== operationId ||
    operationId.length < 1 ||
    operationId.length > 200
  ) {
    throw new Error(
      `Audit metadata for ${action} contains an invalid operation ID.`,
    );
  }
  return operationId;
}

type ActivityCursorBinding = {
  scope: AuditScope;
  organisationId: string;
  eventId: string | null;
  area: string;
  actorKey: string;
  query: string;
};

const activityCursorSchema = z
  .object({
    version: z.literal(1),
    scope: z.enum(auditScopes),
    organisationId: z.string().min(1).max(200),
    eventId: z.string().min(1).max(200).nullable(),
    area: z.string().max(40),
    actorKey: z.string().max(420),
    query: z.string().max(120),
    createdAt: z.number().int().nonnegative(),
    id: z.string().min(1).max(200),
  })
  .strict();

function encode(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decode(value: string) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export function encodeAuditActivityCursor(
  binding: ActivityCursorBinding,
  position: { createdAt: number; id: string },
) {
  return encode({ version: 1, ...binding, ...position });
}

export function decodeAuditActivityCursor(
  value: string | undefined,
  binding: ActivityCursorBinding,
) {
  if (!value) return null;
  try {
    const parsed = activityCursorSchema.parse(decode(value));
    if (
      parsed.scope !== binding.scope ||
      parsed.organisationId !== binding.organisationId ||
      parsed.eventId !== binding.eventId ||
      parsed.area !== binding.area ||
      parsed.actorKey !== binding.actorKey ||
      parsed.query !== binding.query
    ) {
      throw new Error("cursor binding changed");
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new Response(
      "Activity cursor is invalid or does not match the selected scope and filters.",
      { status: 400 },
    );
  }
}

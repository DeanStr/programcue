import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import { PublicSiteCommandConflictError } from "./public-site-errors";

export type PublicSiteCommandScope =
  | "public_site.draft.save"
  | "public_site.publish"
  | "public_site.sponsor.save"
  | "public_site.sponsor.delete"
  | "public_site.recording.save"
  | "public_site.recording.publish"
  | "public_site.recording.unpublish";

type StoredCommand = {
  id: string;
  requestHash: string;
  status: "processing" | "completed" | "failed";
  responseJson: string | null;
};

export type PublicSiteCommand = {
  id: string;
  scope: PublicSiteCommandScope;
  key: string;
  requestHash: string;
};

export type PublicSiteCommandReplay = {
  response: unknown;
  changeSequence: number;
};

export function parsePublicSiteCommandReplay<T>(
  replay: PublicSiteCommandReplay,
  schema: z.ZodType<T>,
) {
  return {
    ...schema.parse(replay.response),
    changeSequence: replay.changeSequence,
  };
}

const storedResponseSchema = z.record(z.string(), z.unknown());

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Consequential UI commands keep one identity for the exact domain generation
 * they describe. A lost response, harmless loader refresh, or full-page retry
 * therefore reaches the durable replay record instead of creating a new
 * command. The key must change when the underlying entity generation changes.
 */
export async function publicSiteCommandIdForIntent(
  viewer: Pick<Viewer, "organisationId" | "eventId" | "personId">,
  intentKey: string,
) {
  const hex = await sha256(
    JSON.stringify([
      "public-site-command-intent-v1",
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      intentKey,
    ]),
  );
  const variant = ((Number.parseInt(hex[16]!, 16) & 0b0011) | 0b1000).toString(
    16,
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function readStoredCommand(
  env: CloudflareEnvironment,
  viewer: Viewer,
  scope: PublicSiteCommandScope,
  key: string,
) {
  return env.DB.prepare(
    `SELECT id, request_hash AS requestHash, status,
            response_json AS responseJson
       FROM idempotency_records
      WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
        AND scope = ? AND idempotency_key = ? AND expires_at > unixepoch()`,
  )
    .bind(viewer.organisationId, viewer.eventId, viewer.personId, scope, key)
    .first<StoredCommand>();
}

async function completedReplay(
  env: CloudflareEnvironment,
  viewer: Viewer,
  stored: StoredCommand,
): Promise<PublicSiteCommandReplay> {
  if (!stored.responseJson) {
    throw new Error(
      "The completed public-site command is missing its durable response.",
    );
  }
  let response: unknown;
  try {
    response = storedResponseSchema.parse(JSON.parse(stored.responseJson));
  } catch {
    throw new Error(
      "The completed public-site command has an invalid durable response.",
    );
  }
  const change = await env.DB.prepare(
    `SELECT sequence
       FROM event_changes
      WHERE event_id = ? AND correlation_id = ?
      ORDER BY sequence DESC LIMIT 1`,
  )
    .bind(viewer.eventId, stored.id)
    .first<{ sequence: number }>();
  if (
    !change ||
    !Number.isSafeInteger(change.sequence) ||
    change.sequence < 1
  ) {
    throw new Error(
      "The completed public-site command is missing its change cursor.",
    );
  }
  return { response, changeSequence: change.sequence };
}

async function resolveStoredCommand(
  env: CloudflareEnvironment,
  viewer: Viewer,
  scope: PublicSiteCommandScope,
  key: string,
  requestHash: string,
) {
  const stored = await readStoredCommand(env, viewer, scope, key);
  if (!stored) return null;
  if (stored.requestHash !== requestHash) {
    throw new PublicSiteCommandConflictError(
      "This action identifier was already used with different public-site details. Refresh before trying again.",
    );
  }
  if (stored.status !== "completed") {
    throw new PublicSiteCommandConflictError(
      stored.status === "processing"
        ? "This public-site action is already being processed. Retry the same action shortly."
        : "This public-site action did not complete. Refresh before trying again.",
    );
  }
  return completedReplay(env, viewer, stored);
}

export async function preparePublicSiteCommand(
  env: CloudflareEnvironment,
  viewer: Viewer,
  scope: PublicSiteCommandScope,
  key: string,
  payload: unknown,
): Promise<
  | { replay: PublicSiteCommandReplay; command: null }
  | { replay: null; command: PublicSiteCommand }
> {
  const requestHash = await sha256(JSON.stringify(payload));
  const replay = await resolveStoredCommand(
    env,
    viewer,
    scope,
    key,
    requestHash,
  );
  return replay
    ? { replay, command: null }
    : {
        replay: null,
        command: {
          id: crypto.randomUUID(),
          scope,
          key,
          requestHash,
        },
      };
}

export function publicSiteCommandClaimStatements(
  env: CloudflareEnvironment,
  viewer: Viewer,
  command: PublicSiteCommand,
) {
  return [
    env.DB.prepare(
      `DELETE FROM idempotency_records
        WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
          AND scope = ? AND idempotency_key = ?
          AND expires_at <= unixepoch()`,
    ).bind(
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      command.scope,
      command.key,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO idempotency_records (
         id, organisation_id, event_id, actor_id, scope, idempotency_key,
         request_hash, status, expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing',
                 unixepoch() + 2592000, unixepoch())`,
    ).bind(
      command.id,
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      command.scope,
      command.key,
      command.requestHash,
    ),
  ] as const;
}

export function publicSiteCommandGuard(
  viewer: Viewer,
  command: PublicSiteCommand,
) {
  return {
    sql: `SELECT 1 FROM idempotency_records
           WHERE id = ? AND organisation_id = ? AND event_id = ?
             AND actor_id = ? AND scope = ? AND idempotency_key = ?
             AND request_hash = ? AND status = 'processing'`,
    bindings: [
      command.id,
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      command.scope,
      command.key,
      command.requestHash,
    ],
  };
}

export function publicSiteCommandCompletionStatement(
  env: CloudflareEnvironment,
  viewer: Viewer,
  command: PublicSiteCommand,
  response: Record<string, unknown>,
) {
  return env.DB.prepare(
    `UPDATE idempotency_records
        SET status = 'completed', response_status = 200, response_json = ?,
            completed_at = unixepoch()
      WHERE id = ? AND organisation_id = ? AND event_id = ?
        AND actor_id = ? AND scope = ? AND idempotency_key = ?
        AND request_hash = ? AND status = 'processing'
        AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
  ).bind(
    JSON.stringify(response),
    command.id,
    viewer.organisationId,
    viewer.eventId,
    viewer.personId,
    command.scope,
    command.key,
    command.requestHash,
    command.id,
  );
}

export async function resolvePublicSiteCommandRace(
  env: CloudflareEnvironment,
  viewer: Viewer,
  command: PublicSiteCommand,
) {
  const stored = await readStoredCommand(
    env,
    viewer,
    command.scope,
    command.key,
  );
  if (stored && stored.requestHash !== command.requestHash) {
    throw new PublicSiteCommandConflictError(
      "This action identifier was already used with different public-site details. Refresh before trying again.",
    );
  }
  if (stored?.status === "completed")
    return completedReplay(env, viewer, stored);
  if (stored && stored.id !== command.id) {
    throw new PublicSiteCommandConflictError(
      "This public-site action is already being processed. Retry the same action shortly.",
    );
  }
  await env.DB.prepare(
    `DELETE FROM idempotency_records
      WHERE id = ? AND organisation_id = ? AND event_id = ? AND actor_id = ?
        AND status = 'processing'`,
  )
    .bind(command.id, viewer.organisationId, viewer.eventId, viewer.personId)
    .run();
  return null;
}

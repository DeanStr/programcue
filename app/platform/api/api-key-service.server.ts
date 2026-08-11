import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";

const encoder = new TextEncoder();

export const API_KEY_SCOPES = [
  "events:read",
  "submissions:read",
  "forms:read",
  "people:read",
  "speakers:read",
  "sessions:read",
  "sessions:write",
  "schedule:read",
  "evaluation:read",
  "evaluation:write",
  "decisions:read",
  "communications:read",
  "resources:read",
  "integrations:read",
  "integrations:write",
  "operations:read",
  "tasks:read",
  "tasks:write",
  "schedule:publish",
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

const createApiKeySchema = z.object({
  name: z.string().trim().min(2).max(80),
  scopes: z
    .array(z.enum(API_KEY_SCOPES))
    .min(1)
    .max(API_KEY_SCOPES.length)
    .transform((scopes) => [...new Set(scopes)]),
  expiresInDays: z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .nullable()
    .default(null),
});

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `pc_live_${encoded}`;
}

export type ApiKeyListItem = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
  revokedAt: number | null;
};

export class ApiKeyNameConflictError extends Error {
  constructor() {
    super("An active API key with that name already exists for this event.");
    this.name = "ApiKeyNameConflictError";
  }
}

export class ApiKeyService {
  constructor(private readonly env: CloudflareEnvironment) {}

  private async assertEvent(viewer: Viewer) {
    const event = await this.env.DB.prepare(
      "SELECT id FROM events WHERE id = ? AND organisation_id = ?",
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first();
    if (!event) throw new Response("Event not found", { status: 404 });
  }

  async list(viewer: Viewer): Promise<ApiKeyListItem[]> {
    await this.assertEvent(viewer);
    const result = await this.env.DB.prepare(
      `
      SELECT id, name, key_prefix AS prefix, scopes_json AS scopesJson,
             expires_at AS expiresAt, last_used_at AS lastUsedAt,
             created_at AS createdAt, revoked_at AS revokedAt
        FROM api_keys
       WHERE organisation_id = ? AND event_id = ?
       ORDER BY revoked_at IS NOT NULL, created_at DESC
    `,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .all<Omit<ApiKeyListItem, "scopes"> & { scopesJson: string }>();
    return result.results.map(({ scopesJson, ...row }) => {
      let scopes: unknown;
      try {
        scopes = JSON.parse(scopesJson);
      } catch {
        throw new Error(`API key ${row.id} has invalid scope data.`);
      }
      const parsedScopes = z
        .array(z.enum(API_KEY_SCOPES))
        .max(API_KEY_SCOPES.length)
        .safeParse(scopes);
      if (!parsedScopes.success) {
        throw new Error(`API key ${row.id} has invalid scope data.`);
      }
      return { ...row, scopes: parsedScopes.data };
    });
  }

  async create(viewer: Viewer, rawInput: unknown) {
    await this.assertEvent(viewer);
    const input = createApiKeySchema.parse(rawInput);
    const token = randomToken();
    const id = crypto.randomUUID();
    const prefix = token.slice(0, 15);
    const keyHash = await sha256(token);
    const expiresAt =
      input.expiresInDays === null
        ? null
        : Math.floor(Date.now() / 1_000) + input.expiresInDays * 86_400;
    let created: D1Result;
    try {
      [created] = await this.env.DB.batch([
        this.env.DB.prepare(
          `
        INSERT INTO api_keys (
          id, organisation_id, event_id, name, key_prefix, key_hash,
          scopes_json, expires_at, created_by_person_id, created_at
        )
        SELECT ?, e.organisation_id, e.id, ?, ?, ?, ?, ?, ?, unixepoch()
          FROM events e
         WHERE e.id = ? AND e.organisation_id = ?
        `,
        ).bind(
          id,
          input.name,
          prefix,
          keyHash,
          JSON.stringify(input.scopes),
          expiresAt,
          viewer.personId,
          viewer.eventId,
          viewer.organisationId,
        ),
        this.env.DB.prepare(
          `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, 'api_key.created', 'api_key', ?, ?, unixepoch()
          WHERE EXISTS (SELECT 1 FROM api_keys WHERE id = ?)
        `,
        ).bind(
          crypto.randomUUID(),
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          id,
          JSON.stringify({
            name: input.name,
            prefix,
            scopes: input.scopes,
            expiresAt,
          }),
          id,
        ),
      ]);
    } catch (error) {
      if (
        error instanceof Error &&
        /UNIQUE constraint failed: api_keys\.event_id, api_keys\.name/i.test(
          error.message,
        )
      ) {
        throw new ApiKeyNameConflictError();
      }
      throw error;
    }
    if ((created.meta.changes ?? 0) !== 1)
      throw new Error("API key could not be created for this event.");
    return {
      id,
      name: input.name,
      token,
      prefix,
      scopes: input.scopes,
      expiresAt,
    };
  }

  async revoke(viewer: Viewer, id: string) {
    await this.assertEvent(viewer);
    const [revoked] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE api_keys SET revoked_at = unixepoch()
         WHERE id = ? AND organisation_id = ? AND event_id = ? AND revoked_at IS NULL
      `,
      ).bind(
        z.string().uuid().parse(id),
        viewer.organisationId,
        viewer.eventId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, 'api_key.revoked', 'api_key', ?, '{}', unixepoch()
          WHERE changes() = 1
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        id,
      ),
    ]);
    if ((revoked.meta.changes ?? 0) !== 1)
      throw new Error("Active API key not found.");
  }
}

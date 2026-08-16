import { z } from "zod";
import { requireValue } from "~/lib/required-value";
import { ApiError, type ApiPrincipal } from "./api.server";
import {
  decodePrivateCursor,
  encodePrivateCursor,
  isoTimestamp,
  parseStrictQuery,
} from "./api-pagination.server";

export const INTEGRATION_API_RESOURCES = [
  "connections",
  "mappings",
  "runs",
  "run-items",
] as const;
export type IntegrationApiResource = (typeof INTEGRATION_API_RESOURCES)[number];

const resourceSchema = z.enum(INTEGRATION_API_RESOURCES);
const limitSchema = z
  .string()
  .regex(/^\d+$/u, "limit must be a whole number from 1 to 100")
  .transform(Number)
  .pipe(z.number().int().min(1).max(100))
  .default(50);
const base = {
  limit: limitSchema,
  cursor: z.string().trim().min(1).max(512).optional(),
};
const querySchemas = {
  connections: z
    .object({
      ...base,
      provider: z.string().trim().min(1).max(80).optional(),
      status: z
        .enum(["connected", "needs_attention", "failed", "disconnected"])
        .optional(),
    })
    .strict(),
  mappings: z
    .object({
      ...base,
      connectionId: z.string().trim().min(1).max(200).optional(),
      entityType: z.string().trim().min(1).max(80).optional(),
    })
    .strict(),
  runs: z
    .object({
      ...base,
      connectionId: z.string().trim().min(1).max(200).optional(),
      status: z
        .enum([
          "queued",
          "running",
          "succeeded",
          "partially_failed",
          "failed",
          "cancelled",
        ])
        .optional(),
      dryRun: z
        .enum(["true", "false"])
        .transform((value) => value === "true")
        .optional(),
    })
    .strict(),
  "run-items": z
    .object({
      ...base,
      runId: z.string().trim().min(1).max(200),
      status: z
        .enum(["pending", "running", "succeeded", "failed", "skipped"])
        .optional(),
      entityType: z.string().trim().min(1).max(80).optional(),
    })
    .strict(),
} satisfies Record<IntegrationApiResource, z.ZodType>;

type IntegrationQuery = {
  limit: number;
  cursor?: string;
  provider?: string;
  status?: string;
  connectionId?: string;
  entityType?: string;
  dryRun?: boolean;
  runId?: string;
};
type EventPrincipal = ApiPrincipal & { eventId: string };
type PageRow = { id: string; sort: number } & Record<string, unknown>;

export function parseIntegrationResource(value: string | undefined) {
  const parsed = resourceSchema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      404,
      "API_RESOURCE_NOT_FOUND",
      "Integration API resource not found",
    );
  return parsed.data;
}

export function parseIntegrationQuery(
  request: Request,
  resource: IntegrationApiResource,
): IntegrationQuery {
  return parseStrictQuery(
    request,
    querySchemas[resource] as unknown as z.ZodType<IntegrationQuery>,
    `The integration ${resource} query parameters are invalid`,
  );
}

function parseJson(value: unknown, label: string) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} contains invalid persisted JSON.`);
  }
}

function conditions(
  input: IntegrationQuery,
  columns: Partial<Record<keyof IntegrationQuery, string>>,
) {
  let sql = "";
  const bindings: unknown[] = [];
  for (const [key, column] of Object.entries(columns) as Array<
    [keyof IntegrationQuery, string]
  >) {
    const value = input[key];
    if (value === undefined) continue;
    sql += ` AND ${column} = ?`;
    bindings.push(typeof value === "boolean" ? Number(value) : value);
  }
  if (input.cursor) {
    const cursor = decodePrivateCursor(input.cursor);
    sql += " AND (base.sort < ? OR (base.sort = ? AND base.id < ?))";
    bindings.push(cursor.sort, cursor.sort, cursor.id);
  }
  return { sql, bindings };
}

const responseKeys: Record<IntegrationApiResource, string> = {
  connections: "connections",
  mappings: "mappings",
  runs: "runs",
  "run-items": "runItems",
};

export class ApiIntegrationService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async list(
    principal: EventPrincipal,
    resource: IntegrationApiResource,
    input: IntegrationQuery,
  ) {
    const rows = await this.query(principal, resource, input);
    const visible = rows.slice(0, input.limit);
    return {
      [responseKeys[resource]]: visible.map(({ sort: _sort, ...row }) =>
        this.serialise(resource, row),
      ),
      nextCursor:
        rows.length > input.limit && visible.length
          ? encodePrivateCursor(
              requireValue(
                visible.at(-1),
                "Required visible.at(-1) is unavailable.",
              ).sort,
              String(
                requireValue(
                  visible.at(-1),
                  "Required visible.at(-1) is unavailable.",
                ).id,
              ),
            )
          : null,
    };
  }

  private async query(
    principal: EventPrincipal,
    resource: IntegrationApiResource,
    input: IntegrationQuery,
  ): Promise<PageRow[]> {
    let sql: string;
    let selected: ReturnType<typeof conditions>;
    if (resource === "connections") {
      selected = conditions(input, {
        provider: "base.provider",
        status: "base.status",
      });
      sql = `SELECT * FROM (
        SELECT connection.id, connection.created_at AS sort,
               connection.provider, connection.status, connection.direction,
               connection.conflict_policy AS conflictPolicy,
               connection.configuration_json AS configurationJson,
               connection.encrypted_credentials IS NOT NULL AS hasCredentials,
               connection.revision, connection.created_at AS createdAt,
               connection.updated_at AS updatedAt
          FROM integration_connections connection
          JOIN events event ON event.id = connection.event_id
            AND event.organisation_id = connection.organisation_id
           AND event.organisation_id = ?
         WHERE connection.event_id = ?
      ) base WHERE 1 = 1${selected.sql}
      ORDER BY base.sort DESC, base.id DESC LIMIT ?`;
    } else if (resource === "mappings") {
      selected = conditions(input, {
        connectionId: "base.connectionId",
        entityType: "base.entityType",
      });
      sql = `SELECT * FROM (
        SELECT mapping.id, mapping.created_at AS sort,
               mapping.connection_id AS connectionId,
               mapping.entity_type AS entityType,
               mapping.entity_id AS entityId,
               mapping.external_id AS externalId,
               mapping.source_hash AS sourceHash,
               mapping.metadata_json AS metadataJson,
               mapping.last_synced_at AS lastSyncedAt,
               mapping.created_at AS createdAt,
               mapping.updated_at AS updatedAt
          FROM integration_entity_mappings mapping
          JOIN integration_connections connection
            ON connection.id = mapping.connection_id
          JOIN events event ON event.id = connection.event_id
            AND event.organisation_id = connection.organisation_id
           AND event.organisation_id = ?
         WHERE connection.event_id = ?
      ) base WHERE 1 = 1${selected.sql}
      ORDER BY base.sort DESC, base.id DESC LIMIT ?`;
    } else if (resource === "runs") {
      selected = conditions(input, {
        connectionId: "base.connectionId",
        status: "base.status",
        dryRun: "base.dryRun",
      });
      sql = `SELECT * FROM (
        SELECT run.id, run.created_at AS sort,
               run.connection_id AS connectionId,
               connection.provider, run.operation_id AS operationId,
               run.status, run.direction, run.dry_run AS dryRun,
               run.summary_json AS summaryJson,
               run.started_at AS startedAt,
               run.completed_at AS completedAt,
               run.created_at AS createdAt
          FROM integration_runs run
          JOIN integration_connections connection
            ON connection.id = run.connection_id
          JOIN events event ON event.id = connection.event_id
            AND event.organisation_id = connection.organisation_id
           AND event.organisation_id = ?
         WHERE connection.event_id = ?
      ) base WHERE 1 = 1${selected.sql}
      ORDER BY base.sort DESC, base.id DESC LIMIT ?`;
    } else {
      selected = conditions(input, {
        runId: "base.runId",
        status: "base.status",
        entityType: "base.entityType",
      });
      sql = `SELECT * FROM (
        SELECT item.id, item.updated_at AS sort, item.run_id AS runId,
               item.entity_type AS entityType, item.entity_id AS entityId,
               item.external_id AS externalId, item.action, item.status,
               item.diff_json AS diffJson,
               item.attempt_count AS attemptCount,
               item.error_code AS errorCode,
               item.error_message AS errorMessage,
               item.updated_at AS updatedAt
          FROM integration_run_items item
          JOIN integration_runs run ON run.id = item.run_id
          JOIN integration_connections connection
            ON connection.id = run.connection_id
          JOIN events event ON event.id = connection.event_id
            AND event.organisation_id = connection.organisation_id
           AND event.organisation_id = ?
         WHERE connection.event_id = ?
      ) base WHERE 1 = 1${selected.sql}
      ORDER BY base.sort DESC, base.id DESC LIMIT ?`;
    }
    return (
      await this.env.DB.prepare(sql)
        .bind(
          principal.organisationId,
          principal.eventId,
          ...selected.bindings,
          input.limit + 1,
        )
        .all<PageRow>()
    ).results;
  }

  private serialise(
    resource: IntegrationApiResource,
    row: Record<string, unknown>,
  ) {
    const result = { ...row };
    for (const field of [
      "createdAt",
      "updatedAt",
      "lastSyncedAt",
      "startedAt",
      "completedAt",
    ]) {
      if (field in result)
        result[field] = isoTimestamp(result[field] as number | null);
    }
    if (resource === "connections") {
      result.configuration = parseJson(
        result.configurationJson,
        `Integration connection ${String(result.id)} configuration`,
      );
      result.hasCredentials = Boolean(result.hasCredentials);
      delete result.configurationJson;
    } else if (resource === "mappings") {
      result.metadata = parseJson(
        result.metadataJson,
        `Integration mapping ${String(result.id)} metadata`,
      );
      delete result.metadataJson;
    } else if (resource === "runs") {
      result.summary = parseJson(
        result.summaryJson,
        `Integration run ${String(result.id)} summary`,
      );
      result.dryRun = Boolean(result.dryRun);
      delete result.summaryJson;
    } else {
      result.diff = parseJson(
        result.diffJson,
        `Integration run item ${String(result.id)} diff`,
      );
      delete result.diffJson;
    }
    return result;
  }
}

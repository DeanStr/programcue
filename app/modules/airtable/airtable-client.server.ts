import { z } from "zod";

import { readBoundedResponseJson } from "~/platform/http/read-response";
import type {
  AirtableCredentials,
  AirtableFieldDefinition,
} from "./airtable-schema";

const airtableFieldSchema = z.object({
  id: z.string().min(1).max(512),
  name: z.string().min(1).max(255),
  type: z.string().min(1).max(128),
});

const airtableTableSchema = z.object({
  id: z.string().min(1).max(512),
  name: z.string().min(1).max(255),
  primaryFieldId: z.string().min(1).max(512),
  fields: z.array(airtableFieldSchema),
});

const baseSchemaResponse = z.object({
  tables: z.array(airtableTableSchema),
});

const recordSchema = z.object({
  id: z.string().min(1).max(512),
  createdTime: z.string().optional(),
  fields: z.record(z.string(), z.unknown()),
});

const listRecordsResponse = z.object({
  records: z.array(recordSchema),
  offset: z.string().max(2_048).optional(),
});

const upsertRecordsResponse = z.object({
  records: z.array(recordSchema),
  createdRecords: z.array(z.string().min(1).max(512)).optional(),
  updatedRecords: z.array(z.string().min(1).max(512)).optional(),
});

const deleteRecordsResponse = z.object({
  records: z.array(
    z.object({
      id: z.string().min(1).max(512),
      deleted: z.literal(true),
    }),
  ),
});

export type AirtableTable = z.infer<typeof airtableTableSchema>;
export type AirtableRecord = z.infer<typeof recordSchema>;
export type AirtableListRecordsOptions = {
  filterByFormula: string;
  fields: readonly string[];
};

export function airtableEqualsFormula(field: string, value: string) {
  if (!/^[A-Za-z][A-Za-z0-9 ]*$/.test(field))
    throw new TypeError("Airtable formula field names must be canonical.");
  return `{${field}}=${JSON.stringify(value)}`;
}

export function airtableAndFormula(...expressions: string[]) {
  if (!expressions.length)
    throw new TypeError(
      "At least one Airtable formula expression is required.",
    );
  return expressions.length === 1
    ? expressions[0]!
    : `AND(${expressions.join(",")})`;
}

export class AirtableProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly providerCode: string | null = null,
  ) {
    super(message);
    this.name = "AirtableProviderError";
  }
}

export class AirtableRateLimitError extends AirtableProviderError {
  constructor(readonly attempts: number) {
    super(
      `Airtable remained rate limited after ${attempts} attempts. Try again after the provider limit clears.`,
      429,
      "RATE_LIMITED",
    );
    this.name = "AirtableRateLimitError";
  }
}

type AirtableClientDependencies = {
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

const MAX_BATCH_SIZE = 10;
const MAX_RATE_LIMIT_ATTEMPTS = 3;
const MIN_REQUEST_INTERVAL_MS = 200;
const DEFAULT_RATE_LIMIT_WAIT_MS = 30_000;
const MAX_RATE_LIMIT_WAIT_MS = 120_000;
const PROVIDER_REQUEST_TIMEOUT_MS = 20_000;
const PROVIDER_RESPONSE_MAX_BYTES = 4 * 1_024 * 1_024;

function responseErrorMessage(body: unknown, status: number) {
  const parsed = z
    .object({
      error: z
        .union([
          z.string().max(500),
          z.object({
            type: z.string().max(128).optional(),
            message: z.string().max(500).optional(),
          }),
        ])
        .optional(),
    })
    .safeParse(body);
  if (!parsed.success || !parsed.data.error)
    return {
      message: `Airtable request failed with HTTP ${status}.`,
      code: null,
    };
  if (typeof parsed.data.error === "string")
    return { message: parsed.data.error, code: null };
  return {
    message:
      parsed.data.error.message ??
      parsed.data.error.type ??
      `Airtable request failed with HTTP ${status}.`,
    code: parsed.data.error.type ?? null,
  };
}

function retryAfterMilliseconds(response: Response, now: number) {
  const value = response.headers.get("retry-after");
  if (!value) return DEFAULT_RATE_LIMIT_WAIT_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(
      MAX_RATE_LIMIT_WAIT_MS,
      Math.max(DEFAULT_RATE_LIMIT_WAIT_MS, seconds * 1_000),
    );
  const date = Date.parse(value);
  if (Number.isFinite(date))
    return Math.min(
      MAX_RATE_LIMIT_WAIT_MS,
      Math.max(DEFAULT_RATE_LIMIT_WAIT_MS, date - now),
    );
  return DEFAULT_RATE_LIMIT_WAIT_MS;
}

export class AirtableClient {
  private readonly fetchImplementation;
  private readonly sleep;
  private readonly now;
  private lastRequestAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly credentials: AirtableCredentials,
    dependencies: AirtableClientDependencies = {},
  ) {
    this.fetchImplementation = dependencies.fetch ?? globalThis.fetch;
    this.sleep =
      dependencies.sleep ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    this.now = dependencies.now ?? Date.now;
  }

  private async pace() {
    const elapsed = this.now() - this.lastRequestAt;
    if (elapsed < MIN_REQUEST_INTERVAL_MS)
      await this.sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
    this.lastRequestAt = this.now();
  }

  private async request(path: string, init: RequestInit = {}) {
    for (let attempt = 1; attempt <= MAX_RATE_LIMIT_ATTEMPTS; attempt += 1) {
      await this.pace();
      const response = await this.fetchImplementation(
        new URL(path, "https://api.airtable.com"),
        {
          ...init,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.credentials.personalAccessToken}`,
            ...(init.body ? { "content-type": "application/json" } : {}),
            ...init.headers,
          },
          signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
        },
      );
      if (response.status === 429) {
        if (attempt === MAX_RATE_LIMIT_ATTEMPTS)
          throw new AirtableRateLimitError(attempt);
        const providerDelay = retryAfterMilliseconds(response, this.now());
        const exponentialDelay =
          DEFAULT_RATE_LIMIT_WAIT_MS * 2 ** (attempt - 1);
        await this.sleep(Math.max(providerDelay, exponentialDelay));
        continue;
      }
      if (!response.ok) {
        let body: unknown = null;
        try {
          body = await readBoundedResponseJson(
            response,
            PROVIDER_RESPONSE_MAX_BYTES,
          );
        } catch {
          // The status remains the authoritative failure when Airtable does not
          // provide its normal JSON error envelope.
        }
        const failure = responseErrorMessage(body, response.status);
        throw new AirtableProviderError(
          failure.message,
          response.status,
          failure.code,
        );
      }
      if (response.status === 204) return null;
      try {
        return await readBoundedResponseJson(
          response,
          PROVIDER_RESPONSE_MAX_BYTES,
        );
      } catch {
        throw new AirtableProviderError(
          "Airtable returned an invalid or oversized JSON response.",
          response.status,
          "INVALID_PROVIDER_RESPONSE",
        );
      }
    }
    throw new AirtableRateLimitError(MAX_RATE_LIMIT_ATTEMPTS);
  }

  async getBaseSchema() {
    const body = await this.request(
      `/v0/meta/bases/${encodeURIComponent(this.credentials.baseId)}/tables`,
    );
    return baseSchemaResponse.parse(body).tables;
  }

  async createTable(name: string, fields: readonly AirtableFieldDefinition[]) {
    const body = await this.request(
      `/v0/meta/bases/${encodeURIComponent(this.credentials.baseId)}/tables`,
      {
        method: "POST",
        body: JSON.stringify({ name, fields }),
      },
    );
    return airtableTableSchema.parse(body);
  }

  async createField(tableId: string, field: AirtableFieldDefinition) {
    const body = await this.request(
      `/v0/meta/bases/${encodeURIComponent(this.credentials.baseId)}/tables/${encodeURIComponent(tableId)}/fields`,
      { method: "POST", body: JSON.stringify(field) },
    );
    return airtableFieldSchema.parse(body);
  }

  async listRecords(tableId: string, options: AirtableListRecordsOptions) {
    if (!options?.filterByFormula.trim())
      throw new TypeError(
        "Airtable record reads require an explicit filter formula.",
      );
    if (!options.fields.length || options.fields.some((field) => !field.trim()))
      throw new TypeError(
        "Airtable record reads require at least one explicit managed field.",
      );
    const records: AirtableRecord[] = [];
    let offset: string | undefined;
    let pages = 0;
    do {
      const query = new URLSearchParams({ pageSize: "100" });
      query.set("filterByFormula", options.filterByFormula);
      for (const field of options.fields) query.append("fields[]", field);
      if (offset) query.set("offset", offset);
      const body = await this.request(
        `/v0/${encodeURIComponent(this.credentials.baseId)}/${encodeURIComponent(tableId)}?${query}`,
      );
      const page = listRecordsResponse.parse(body);
      records.push(...page.records);
      offset = page.offset;
      pages += 1;
      if (pages > 10_000)
        throw new AirtableProviderError(
          "Airtable pagination did not terminate.",
          502,
          "INVALID_PAGINATION",
        );
    } while (offset);
    return records;
  }

  async upsertRecords(
    tableId: string,
    records: ReadonlyArray<{ fields: Record<string, unknown> }>,
    mergeField = "Program Cue ID",
  ) {
    if (!records.length || records.length > MAX_BATCH_SIZE) {
      throw new RangeError(
        `Airtable upsert batches must contain between 1 and ${MAX_BATCH_SIZE} records.`,
      );
    }
    const body = await this.request(
      `/v0/${encodeURIComponent(this.credentials.baseId)}/${encodeURIComponent(tableId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          performUpsert: { fieldsToMergeOn: [mergeField] },
          records,
          typecast: false,
        }),
      },
    );
    return upsertRecordsResponse.parse(body);
  }

  async deleteRecords(tableId: string, recordIds: readonly string[]) {
    if (!recordIds.length || recordIds.length > MAX_BATCH_SIZE) {
      throw new RangeError(
        `Airtable delete batches must contain between 1 and ${MAX_BATCH_SIZE} record IDs.`,
      );
    }
    const query = new URLSearchParams();
    for (const recordId of recordIds) query.append("records[]", recordId);
    const body = await this.request(
      `/v0/${encodeURIComponent(this.credentials.baseId)}/${encodeURIComponent(tableId)}?${query}`,
      { method: "DELETE" },
    );
    const result = deleteRecordsResponse.parse(body);
    const deleted = new Set(result.records.map((record) => record.id));
    if (recordIds.some((recordId) => !deleted.has(recordId)))
      throw new AirtableProviderError(
        "Airtable did not confirm deletion of every connection-validation record.",
        502,
        "INCOMPLETE_DELETE",
      );
    return result;
  }
}

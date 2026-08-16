import { describe, expect, it, vi } from "vitest";

import {
  AirtableClient,
  type AirtableProviderError,
} from "./airtable-client.server";

const credentials = {
  personalAccessToken: "pat-test-token-at-least-twenty",
  baseId: "app12345678901234",
};

describe("Airtable Web API client", () => {
  it("paginates record reads and sends PAT authentication", async () => {
    const requests: Request[] = [];
    const requestSignals: Array<AbortSignal | null | undefined> = [];
    const fetchImplementation = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        requestSignals.push(init?.signal);
        const request = new Request(input, init);
        requests.push(request);
        const offset = new URL(request.url).searchParams.get("offset");
        return Response.json(
          offset
            ? { records: [{ id: "rec-2", fields: { Name: "Second" } }] }
            : {
                records: [{ id: "rec-1", fields: { Name: "First" } }],
                offset: "next/page",
              },
        );
      },
    );
    let now = 1_000;
    const client = new AirtableClient(credentials, {
      fetch: fetchImplementation as typeof fetch,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });

    await expect(
      client.listRecords("tblRooms", {
        filterByFormula: '{Event ID}="evt-1"',
        fields: ["Program Cue ID", "Event ID"],
      }),
    ).resolves.toHaveLength(2);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers.get("authorization")).toBe(
      `Bearer ${credentials.personalAccessToken}`,
    );
    expect(new URL(requests[0]!.url).searchParams.get("pageSize")).toBe("100");
    expect(new URL(requests[1]!.url).searchParams.get("offset")).toBe(
      "next/page",
    );
    expect(new URL(requests[0]!.url).searchParams.get("filterByFormula")).toBe(
      '{Event ID}="evt-1"',
    );
    expect(new URL(requests[0]!.url).searchParams.getAll("fields[]")).toEqual([
      "Program Cue ID",
      "Event ID",
    ]);
    expect(requestSignals).toHaveLength(2);
    expect(requestSignals.every((signal) => signal && !signal.aborted)).toBe(
      true,
    );
  });

  it("refuses unscoped or all-field record reads before contacting Airtable", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new AirtableClient(credentials, { fetch });

    await expect(
      client.listRecords("tblRooms", {
        filterByFormula: "",
        fields: ["Program Cue ID"],
      }),
    ).rejects.toThrow(/explicit filter formula/iu);
    await expect(
      client.listRecords("tblRooms", {
        filterByFormula: '{Event ID}="evt-1"',
        fields: [],
      }),
    ).rejects.toThrow(/at least one explicit managed field/iu);
    await expect(
      client.listRecords("tblRooms", undefined as never),
    ).rejects.toThrow(/explicit filter formula/iu);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("waits at least 30 seconds and backs off exponentially for 429s", async () => {
    let now = 1_000;
    const waits: number[] = [];
    const responses = [
      new Response(null, { status: 429 }),
      new Response(null, { status: 429 }),
      Response.json({ tables: [] }),
    ];
    const client = new AirtableClient(credentials, {
      fetch: vi.fn(async () => responses.shift()!) as typeof fetch,
      now: () => now,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
    });

    await expect(client.getBaseSchema()).resolves.toEqual([]);
    expect(waits).toEqual([30_000, 60_000]);
  });

  it("caps numeric and date Retry-After values to a bounded wait", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const waits: number[] = [];
    const responses = [
      new Response(null, {
        status: 429,
        headers: { "retry-after": "999999" },
      }),
      new Response(null, {
        status: 429,
        headers: { "retry-after": "Wed, 01 Jan 2036 00:00:00 GMT" },
      }),
      Response.json({ tables: [] }),
    ];
    const client = new AirtableClient(credentials, {
      fetch: vi.fn(async () => responses.shift()!) as typeof fetch,
      now: () => now,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
    });

    await expect(client.getBaseSchema()).resolves.toEqual([]);
    expect(waits).toEqual([120_000, 120_000]);
  });

  it("stops after three rate-limit attempts instead of reporting success", async () => {
    let now = 1_000;
    const client = new AirtableClient(credentials, {
      fetch: vi.fn(
        async () => new Response(null, { status: 429 }),
      ) as typeof fetch,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });

    await expect(client.getBaseSchema()).rejects.toEqual(
      expect.objectContaining({
        name: "AirtableRateLimitError",
        status: 429,
        attempts: 3,
      }),
    );
  });

  it("uses Airtable performUpsert and enforces ten-record batches", async () => {
    let request: Request | null = null;
    const client = new AirtableClient(credentials, {
      fetch: vi.fn(async (input, init) => {
        request = new Request(input, init);
        return Response.json({
          records: [{ id: "rec-1", fields: { "Program Cue ID": "room-1" } }],
          createdRecords: ["rec-1"],
        });
      }) as typeof fetch,
    });

    await client.upsertRecords("tblRooms", [
      { fields: { "Program Cue ID": "room-1", Name: "Main" } },
    ]);
    const body = JSON.parse(await request!.text()) as Record<string, unknown>;
    expect(request!.method).toBe("PATCH");
    expect(body.performUpsert).toEqual({
      fieldsToMergeOn: ["Program Cue ID"],
    });
    await expect(
      client.upsertRecords(
        "tblRooms",
        Array.from({ length: 11 }, (_, index) => ({
          fields: { "Program Cue ID": `room-${index}` },
        })),
      ),
    ).rejects.toThrow(/between 1 and 10/i);
  });

  it("deletes bounded record batches and requires complete confirmation", async () => {
    let request: Request | null = null;
    const client = new AirtableClient(credentials, {
      fetch: vi.fn(async (input, init) => {
        request = new Request(input, init);
        return Response.json({
          records: [{ id: "rec-1", deleted: true }],
        });
      }) as typeof fetch,
    });

    await expect(client.deleteRecords("tblRooms", ["rec-1"])).resolves.toEqual({
      records: [{ id: "rec-1", deleted: true }],
    });
    expect(request!.method).toBe("DELETE");
    expect(new URL(request!.url).searchParams.getAll("records[]")).toEqual([
      "rec-1",
    ]);
    await expect(client.deleteRecords("tblRooms", [])).rejects.toThrow(
      /between 1 and 10/iu,
    );
    await expect(
      client.deleteRecords("tblRooms", ["rec-1", "rec-2"]),
    ).rejects.toThrow(/did not confirm deletion of every/iu);
  });

  it("surfaces provider errors without stale or simulated data", async () => {
    const client = new AirtableClient(credentials, {
      fetch: vi.fn(async () =>
        Response.json(
          {
            error: {
              type: "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND",
              message: "Token cannot read this base",
            },
          },
          { status: 403 },
        ),
      ) as typeof fetch,
    });

    await expect(client.getBaseSchema()).rejects.toEqual(
      expect.objectContaining<AirtableProviderError>({
        name: "AirtableProviderError",
        status: 403,
        providerCode: "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND",
        message: "Token cannot read this base",
      }),
    );
  });

  it("rejects an oversized successful provider body", async () => {
    const client = new AirtableClient(credentials, {
      fetch: vi.fn(
        async () =>
          new Response("{}", {
            status: 200,
            headers: { "content-length": String(4 * 1_024 * 1_024 + 1) },
          }),
      ) as typeof fetch,
    });

    await expect(client.getBaseSchema()).rejects.toMatchObject({
      name: "AirtableProviderError",
      providerCode: "INVALID_PROVIDER_RESPONSE",
    });
  });
});

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  ApiKeyNameConflictError,
  ApiKeyService,
} from "./api-key-service.server";
import { apiKeyLifecycleState } from "./api-key-state";
import { requireApiKey } from "./api.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

beforeEach(async () => ensureDemoData(env as unknown as CloudflareEnvironment));

describe("event API key lifecycle", () => {
  it("treats an elapsed expiry as inactive even before revocation", () => {
    expect(apiKeyLifecycleState({ expiresAt: 100, revokedAt: null }, 100)).toBe(
      "expired",
    );
    expect(apiKeyLifecycleState({ expiresAt: 101, revokedAt: null }, 100)).toBe(
      "active",
    );
    expect(apiKeyLifecycleState({ expiresAt: null, revokedAt: 90 }, 100)).toBe(
      "revoked",
    );
  });

  it("reveals a scoped token once and authenticates its hash", async () => {
    const service = new ApiKeyService(env as unknown as CloudflareEnvironment);
    const created = await service.create(viewer, {
      name: "Schedule publisher",
      scopes: ["schedule:publish"],
      expiresInDays: 30,
    });
    expect(created.token).toMatch(/^pc_live_/);
    const list = await service.list(viewer);
    expect(list[0]).not.toHaveProperty("token");
    expect(list[0].prefix).toBe(created.prefix);

    const principal = await requireApiKey(
      new Request(`https://example.test/api/v1/events/${viewer.eventId}`, {
        headers: { authorization: `Bearer ${created.token}` },
      }),
      env as unknown as CloudflareEnvironment,
      "schedule:publish",
      viewer.eventId,
    );
    expect(principal.organisationId).toBe(viewer.organisationId);
    const firstUse = await env.DB.prepare(
      "SELECT last_used_at AS lastUsedAt FROM api_keys WHERE id = ?",
    )
      .bind(created.id)
      .first<{ lastUsedAt: number }>();
    await env.DB.prepare(
      `CREATE TRIGGER reject_unnecessary_api_key_usage_write
       BEFORE UPDATE OF last_used_at ON api_keys
       WHEN OLD.id = '${created.id}'
       BEGIN
         SELECT RAISE(ABORT, 'recent API key usage must not enter the write path');
       END`,
    ).run();
    try {
      await requireApiKey(
        new Request(`https://example.test/api/v1/events/${viewer.eventId}`, {
          headers: { authorization: `Bearer ${created.token}` },
        }),
        env as unknown as CloudflareEnvironment,
        "schedule:publish",
        viewer.eventId,
      );
    } finally {
      await env.DB.prepare(
        "DROP TRIGGER IF EXISTS reject_unnecessary_api_key_usage_write",
      ).run();
    }
    await expect(
      env.DB.prepare(
        "SELECT last_used_at AS lastUsedAt FROM api_keys WHERE id = ?",
      )
        .bind(created.id)
        .first(),
    ).resolves.toEqual(firstUse);

    await service.revoke(viewer, created.id);
    await expect(
      requireApiKey(
        new Request("https://example.test", {
          headers: { authorization: `Bearer ${created.token}` },
        }),
        env as unknown as CloudflareEnvironment,
        "schedule:publish",
        viewer.eventId,
      ),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });

    const auditBeforeRetry = await env.DB.prepare(
      `
      SELECT COUNT(*) AS count FROM audit_events
       WHERE entity_id = ? AND action = 'api_key.revoked'
    `,
    )
      .bind(created.id)
      .first<{ count: number }>();
    await expect(service.revoke(viewer, created.id)).rejects.toThrow(
      "Active API key not found",
    );
    const auditAfterRetry = await env.DB.prepare(
      `
      SELECT COUNT(*) AS count FROM audit_events
       WHERE entity_id = ? AND action = 'api_key.revoked'
    `,
    )
      .bind(created.id)
      .first<{ count: number }>();
    expect(auditAfterRetry?.count).toBe(auditBeforeRetry?.count);
  });

  it("does not create an API key when its required audit insert is suppressed", async () => {
    const name = `Unaudited key ${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare(
      `CREATE TRIGGER suppress_api_key_creation_audit
       BEFORE INSERT ON audit_events
       WHEN NEW.action = 'api_key.created'
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
    ).run();
    try {
      await expect(
        new ApiKeyService(env as unknown as CloudflareEnvironment).create(
          viewer,
          { name, scopes: ["tasks:read"], expiresInDays: null },
        ),
      ).rejects.toThrow(/could not be created/u);
      await expect(
        env.DB.prepare(
          `SELECT COUNT(*) AS count FROM api_keys
            WHERE event_id = ? AND name = ?`,
        )
          .bind(viewer.eventId, name)
          .first(),
      ).resolves.toEqual({ count: 0 });
    } finally {
      await env.DB.prepare(
        "DROP TRIGGER IF EXISTS suppress_api_key_creation_audit",
      ).run();
    }
  });

  it("does not allow one tenant to list another tenant's keys", async () => {
    await new ApiKeyService(env as unknown as CloudflareEnvironment).create(
      viewer,
      {
        name: "Read-only tasks",
        scopes: ["tasks:read"],
        expiresInDays: null,
      },
    );
    await expect(
      new ApiKeyService(env as unknown as CloudflareEnvironment).list({
        ...viewer,
        organisationId: "another-organisation",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("scopes active key names to an event and permits reuse after revocation", async () => {
    const service = new ApiKeyService(env as unknown as CloudflareEnvironment);
    const name = `Release integration ${crypto.randomUUID().slice(0, 8)}`;
    const first = await service.create(viewer, {
      name,
      scopes: ["tasks:read"],
      expiresInDays: null,
    });
    await expect(
      service.create(viewer, {
        name,
        scopes: ["tasks:read"],
        expiresInDays: null,
      }),
    ).rejects.toBeInstanceOf(ApiKeyNameConflictError);

    const otherEventId = `api-key-event-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO events (
        id, organisation_id, name, slug, timezone, starts_at, ends_at,
        file_policy_json
      ) VALUES (?, ?, 'Other API key event', ?, 'UTC', 2_000_000_000, 2_000_086_400,
                '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')`,
    )
      .bind(
        otherEventId,
        viewer.organisationId,
        `api-key-event-${crypto.randomUUID()}`,
      )
      .run();
    await expect(
      service.create(
        { ...viewer, eventId: otherEventId },
        { name, scopes: ["tasks:read"], expiresInDays: null },
      ),
    ).resolves.toMatchObject({ name });

    await service.revoke(viewer, first.id);
    await expect(
      service.create(viewer, {
        name,
        scopes: ["tasks:read"],
        expiresInDays: null,
      }),
    ).resolves.toMatchObject({ name });
  });
});

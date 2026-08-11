import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { ResendDomainProvider } from "./resend-domain.server";
import { SenderProfileService } from "./sender-profile-service.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

async function environment(
  fetcher: typeof fetch,
  provider: "resend" | "mailpit" = "resend",
) {
  const testEnv = {
    ...(env as unknown as CloudflareEnvironment),
    DB: env.DB,
    EMAIL_PROVIDER: provider,
    RESEND_API_KEY:
      provider === "resend" ? "sender-profile-test-key" : undefined,
    MAILPIT_SEND_API_URL:
      provider === "mailpit" ? "http://127.0.0.1:8025/api/v1/send" : undefined,
  } as CloudflareEnvironment;
  await ensureDemoData(testEnv);
  return {
    testEnv,
    service: new SenderProfileService(
      testEnv,
      new ResendDomainProvider(
        testEnv.RESEND_API_KEY,
        fetcher,
        "https://resend.test",
      ),
    ),
  };
}

describe("sender-profile provisioning", () => {
  it("persists only provider-verified domains as verified senders", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const requestSignals: Array<AbortSignal | null | undefined> = [];
    let checked = false;
    const { service, testEnv } = await environment(async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET" });
      requestSignals.push(init?.signal);
      if (url.endsWith("/domains") && !init?.method)
        return Response.json({ data: [] });
      if (url.endsWith("/domains") && init?.method === "POST")
        return Response.json({
          id: "domain-1",
          name: "programme.example",
          status: "pending",
          records: [{ type: "TXT" }],
        });
      if (url.endsWith("/verify")) {
        checked = true;
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/domains/domain-1") && checked)
        return Response.json({
          id: "domain-1",
          name: "programme.example",
          status: "verified",
        });
      return new Response("unexpected request", { status: 500 });
    });
    const saved = await service.save(viewer, {
      name: "Programme team",
      fromName: "Programme Cue",
      fromEmail: "hello@programme.example",
      replyToEmail: "replies@programme.example",
    });

    const provisioned = await service.provision(viewer, saved.id);

    expect(provisioned).toMatchObject({
      status: "verified",
      providerStatus: "verified",
      domain: "programme.example",
    });
    expect(requests).toEqual([
      { url: "https://resend.test/domains", method: "GET" },
      { url: "https://resend.test/domains", method: "POST" },
      {
        url: "https://resend.test/domains/domain-1/verify",
        method: "POST",
      },
      { url: "https://resend.test/domains/domain-1", method: "GET" },
    ]);
    expect(requestSignals.every((signal) => signal && !signal.aborted)).toBe(
      true,
    );
    await expect(
      testEnv.DB.prepare(
        "SELECT status, provider_sender_id AS providerSenderId FROM sender_profiles WHERE id = ?",
      )
        .bind(saved.id)
        .first(),
    ).resolves.toEqual({ status: "verified", providerSenderId: "domain-1" });
  });

  it("does not fabricate verification while Resend still reports pending", async () => {
    const { service } = await environment(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/domains") && !init?.method)
        return Response.json({
          data: [
            {
              id: "domain-pending",
              name: "pending.example",
              status: "pending",
            },
          ],
        });
      if (url.endsWith("/verify")) return new Response(null, { status: 204 });
      return Response.json({
        id: "domain-pending",
        name: "pending.example",
        status: "pending",
        records: [{ type: "TXT", value: "provider-record" }],
      });
    });
    const saved = await service.save(viewer, {
      name: "Pending sender",
      fromName: "Programme Cue",
      fromEmail: "hello@pending.example",
      replyToEmail: "",
    });

    const result = await service.provision(viewer, saved.id);

    expect(result.status).toBe("unverified");
    expect(result.records).toEqual([{ type: "TXT", value: "provider-record" }]);
    expect(
      (await service.list(viewer)).find((item) => item.id === saved.id),
    ).toMatchObject({
      status: "unverified",
      providerSenderId: "domain-pending",
    });
  });

  it("does not let a stale provider check re-enable a concurrently disabled sender", async () => {
    let releaseProvider!: () => void;
    const providerRelease = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let providerStarted!: () => void;
    const providerStart = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const { service } = await environment(async () => {
      providerStarted();
      await providerRelease;
      return Response.json({
        data: [
          {
            id: "stale-domain",
            name: "stale.example",
            status: "verified",
          },
        ],
      });
    });
    const saved = await service.save(viewer, {
      name: `Stale provider check ${crypto.randomUUID()}`,
      fromName: "Program Cue",
      fromEmail: "hello@stale.example",
      replyToEmail: "",
    });

    const provisioning = service.provision(viewer, saved.id);
    await providerStart;
    await service.setEnabled(viewer, saved.id, false);
    releaseProvider();

    await expect(provisioning).rejects.toThrow(
      "changed while its provider status was checked",
    );
    expect(
      (await service.list(viewer)).find((profile) => profile.id === saved.id),
    ).toMatchObject({ status: "disabled", providerSenderId: null });
  });

  it("freezes delivery fields while a communication remains retryable", async () => {
    const { service, testEnv } = await environment(async () =>
      Response.json({ data: [] }),
    );
    const saved = await service.save(viewer, {
      name: `Active sender ${crypto.randomUUID()}`,
      fromName: "Original sender",
      fromEmail: "active@sender.example",
      replyToEmail: "reply@sender.example",
    });
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "UPDATE sender_profiles SET status = 'verified' WHERE id = ?",
      ).bind(saved.id),
      testEnv.DB.prepare(
        `INSERT INTO communications (
           id, event_id, sender_profile_id, idempotency_key, kind, channel,
           status, audience_json, content_snapshot_json, recipient_count
         ) VALUES (?, ?, ?, ?, 'transactional', 'email', 'failed', '{}', '{}', 1)`,
      ).bind(
        crypto.randomUUID(),
        viewer.eventId,
        saved.id,
        `active-sender-${crypto.randomUUID()}`,
      ),
    ]);

    await expect(
      service.save(viewer, {
        id: saved.id,
        name: (await service.list(viewer)).find(
          (profile) => profile.id === saved.id,
        )!.name,
        fromName: "Changed sender",
        fromEmail: "active@sender.example",
        replyToEmail: "reply@sender.example",
      }),
    ).rejects.toThrow("while a scheduled or retryable communication is active");
  });

  it("creates an explicitly selected Mailpit sender ready for local capture", async () => {
    let resendRequestCount = 0;
    const { service, testEnv } = await environment(async () => {
      resendRequestCount += 1;
      return new Response("unexpected Resend request", { status: 500 });
    }, "mailpit");

    const saved = await service.save(viewer, {
      name: `Local capture ${crypto.randomUUID()}`,
      fromName: "Program Cue local",
      fromEmail: "events@programcue.local",
      replyToEmail: "",
    });

    expect(saved).toMatchObject({ provider: "mailpit", status: "verified" });
    expect(await service.list(viewer)).toContainEqual(
      expect.objectContaining({
        id: saved.id,
        provider: "mailpit",
        status: "verified",
      }),
    );
    await expect(service.provision(viewer, saved.id)).resolves.toMatchObject({
      provider: "mailpit",
      status: "verified",
      domain: null,
    });
    await expect(service.setEnabled(viewer, saved.id, false)).resolves.toEqual({
      id: saved.id,
      status: "disabled",
    });
    await expect(service.setEnabled(viewer, saved.id, true)).resolves.toEqual({
      id: saved.id,
      status: "verified",
    });
    expect(resendRequestCount).toBe(0);
    await expect(
      testEnv.DB.prepare(
        "SELECT provider, status FROM sender_profiles WHERE id = ?",
      )
        .bind(saved.id)
        .first(),
    ).resolves.toEqual({ provider: "mailpit", status: "verified" });
  });

  it("resets verification when the From address changes", async () => {
    const { service } = await environment(async () =>
      Response.json({ data: [] }),
    );
    const saved = await service.save(viewer, {
      name: "Changed sender",
      fromName: "Programme Cue",
      fromEmail: "hello@first.example",
      replyToEmail: "",
    });
    await env.DB.prepare(
      "UPDATE sender_profiles SET status = 'verified', provider_sender_id = 'domain-old' WHERE id = ?",
    )
      .bind(saved.id)
      .run();

    await service.save(viewer, {
      id: saved.id,
      name: "Changed sender",
      fromName: "Programme Cue",
      fromEmail: "hello@second.example",
      replyToEmail: "",
    });

    expect(
      (await service.list(viewer)).find((item) => item.id === saved.id),
    ).toMatchObject({
      fromEmail: "hello@second.example",
      status: "unverified",
      providerSenderId: null,
    });
  });

  it("rejects duplicate profile names with a domain error", async () => {
    const { service } = await environment(async () =>
      Response.json({ data: [] }),
    );
    const input = {
      name: `Duplicate ${crypto.randomUUID()}`,
      fromName: "Programme Cue",
      fromEmail: "hello@first.example",
      replyToEmail: "",
    };
    await service.save(viewer, input);

    await expect(
      service.save(viewer, {
        ...input,
        fromEmail: "hello@second.example",
      }),
    ).rejects.toThrow("Use a unique profile name");
  });
});

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { resolveAiProvider } from "./ai-provider.server";
import {
  AiProviderSettingsService,
  aiProviderConfirmation,
} from "./ai-provider-settings.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Jordan",
  email: "fixture@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};
const testEnv = {
  ...env,
  OPENAI_API_KEY: "test-key-not-a-real-provider-credential",
  OPENAI_RESPONSES_URL:
    "https://gateway.example.com/openai/responses?tenant=fixture",
  ANTHROPIC_API_KEY: "test-key-not-a-real-provider-credential",
} as unknown as CloudflareEnvironment;
beforeEach(async () => {
  await ensureDemoData(testEnv);
  await env.DB.prepare(
    "UPDATE organisation_ai_settings SET provider = 'openai', model = 'fixture-model', revision = 1 WHERE organisation_id = ?",
  )
    .bind(viewer.organisationId)
    .run();
});

async function confirmation(configuration = testEnv) {
  return aiProviderConfirmation(
    configuration,
    await new AiProviderSettingsService(configuration).readiness(viewer),
  );
}

describe("AI request destination confirmation", () => {
  it("shows the actual gateway origin without exposing URL query or credentials", async () => {
    const details = await confirmation();
    expect(details).toMatchObject({
      providerLabel: "OpenAI",
      model: "fixture-model",
      destination: "https://gateway.example.com",
    });
    expect(JSON.stringify(details)).not.toContain("tenant=");
    expect(JSON.stringify(details)).not.toContain(testEnv.OPENAI_API_KEY);
    const provider = await resolveAiProvider(testEnv, viewer, {
      expectedConfiguration: details!.configuration,
    });
    expect(provider.providerName).toBe("OpenAI");
    expect(provider.model).toBe("fixture-model");
  });

  it.each(["model", "provider", "revision"])(
    "rejects stale confirmed %s before any provider call",
    async (field) => {
      const details = await confirmation();
      const updates = {
        model: "model = 'another-model'",
        provider: "provider = 'anthropic'",
        revision: "revision = revision + 1",
      };
      await env.DB.prepare(
        `UPDATE organisation_ai_settings SET ${updates[field as keyof typeof updates]} WHERE organisation_id = ?`,
      )
        .bind(viewer.organisationId)
        .run();
      await expect(
        resolveAiProvider(testEnv, viewer, {
          expectedConfiguration: details!.configuration,
        }),
      ).rejects.toThrow(/changed/);
    },
  );

  it("rejects changed destinations and missing confirmation", async () => {
    const details = await confirmation();
    await expect(
      resolveAiProvider(
        {
          ...testEnv,
          OPENAI_RESPONSES_URL: "https://another.example.com/responses",
        },
        viewer,
        { expectedConfiguration: details!.configuration },
      ),
    ).rejects.toThrow(/changed/);
    await expect(
      resolveAiProvider(testEnv, viewer, { expectedConfiguration: "" }),
    ).rejects.toThrow(/changed/);
  });

  it("does not present an unavailable provider as ready", async () => {
    expect(await confirmation({ ...testEnv, OPENAI_API_KEY: "" })).toBeNull();
    await expect(
      resolveAiProvider({ ...testEnv, OPENAI_API_KEY: "" }, viewer, {
        expectedConfiguration: "",
      }),
    ).rejects.toThrow(/credentials are not configured/);
  });
});

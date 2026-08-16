import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import { defaultPublicSiteDraft } from "~/modules/public-site/public-site";
import { PublicSiteService } from "~/modules/public-site/public-site-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoProgramme } from "~/platform/demo/seed.server";
import { loader, publishedSocialCardAccent } from "./public-social-card";

const testEnv = env as unknown as CloudflareEnvironment;
const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

function routeContext(environment: CloudflareEnvironment) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: environment,
    ctx: {} as ExecutionContext,
  });
  return context;
}

async function responseFor(environment: CloudflareEnvironment, query = "") {
  try {
    return await loader({
      request: new Request(
        `https://programcue.test/public/programme/future-of-events-2027/social-card.webp${query}`,
      ),
      params: { slug: "future-of-events-2027" },
      context: routeContext(environment),
    } as never);
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

beforeEach(async () => {
  await ensureDemoProgramme(testEnv);
  await env.DB.prepare("DELETE FROM event_public_sites WHERE event_id = ?")
    .bind(viewer.eventId)
    .run();
  const configuration = defaultPublicSiteDraft();
  configuration.sectionVisibility.introduction = false;
  configuration.sectionVisibility.venue = false;
  const service = new PublicSiteService(testEnv);
  const saved = await service.saveDraft(viewer, {
    revision: 0,
    configurationJson: JSON.stringify(configuration),
  });
  await service.publish(viewer, {
    revision: saved.revision,
    confirmed: "true",
  });
});

describe("generated public social cards", () => {
  it("renders a real WebP through the configured Images binding", async () => {
    const response = await responseFor(testEnv);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("fails explicitly when image rendering is not configured", async () => {
    const environment = new Proxy(testEnv, {
      get(target, property, receiver) {
        if (property === "IMAGES") return undefined;
        return Reflect.get(target, property, receiver);
      },
    });
    const response = await responseFor(environment);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects an unpublished speaker identifier", async () => {
    const response = await responseFor(testEnv, "?speaker=not-published");
    expect(response.status).toBe(404);
  });

  it("does not render current content under a stale revision cache key", async () => {
    const response = await responseFor(testEnv, "?v=stale-1");
    expect(response.status).toBe(404);
  });

  it("fails instead of substituting a platform accent for invalid published branding", () => {
    expect(() => publishedSocialCardAccent("invalid")).toThrow(
      /brand accent is invalid/i,
    );
  });

  it("serves the exact full programme and site revision as immutable", async () => {
    const [programme, site] = await Promise.all([
      new PublicProgrammeService(testEnv).getPublished("future-of-events-2027"),
      new PublicSiteService(testEnv).getPublished("future-of-events-2027"),
    ]);
    const version = `${programme!.contentRevision}-${site!.revision}`;
    const response = await responseFor(
      testEnv,
      `?v=${encodeURIComponent(version)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("immutable");
  });
});

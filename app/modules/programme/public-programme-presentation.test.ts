import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureDemoData } from "~/platform/demo/seed.server";
import { descriptionSnippet } from "~/routes/public-programme";
import { PublicProgrammeService } from "./public-programme-service.server";

describe("published programme and itinerary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("truncates long public descriptions on a word boundary and leaves short ones intact", () => {
    const short = "A practical session about accessible programme design.";
    expect(descriptionSnippet(short)).toBe(short);
    expect(descriptionSnippet(" Collapsed   whitespace\nsnippet ")).toBe(
      "Collapsed whitespace snippet",
    );

    const long = `${"word ".repeat(80)}end`;
    const snippet = descriptionSnippet(long);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(181);
    expect(snippet.slice(0, -1)).not.toMatch(/\s$/u);
    expect(long.startsWith(snippet.slice(0, -1))).toBe(true);

    const unbroken = "x".repeat(400);
    expect(descriptionSnippet(unbroken)).toBe(`${"x".repeat(180)}…`);
  });

  it("returns no programme for an unpublished event", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const service = new PublicProgrammeService({
      ...(env as unknown as CloudflareEnvironment),
      DEMO_MODE: "false",
    } as CloudflareEnvironment);
    expect(await service.getPublished("not-an-event")).toBeNull();
  });
});

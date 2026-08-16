import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  descriptionSnippet,
  shouldRevalidate,
} from "~/routes/public-programme";
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

  it("keeps embed query configuration and actions on the loader validation path", () => {
    const revalidation = (current: string, next: string, formMethod?: string) =>
      shouldRevalidate({
        currentUrl: new URL(current),
        nextUrl: new URL(next),
        defaultShouldRevalidate: true,
        formMethod,
      } as Parameters<typeof shouldRevalidate>[0]);

    expect(
      revalidation(
        "https://example.test/public/programme/event?track=Current",
        "https://example.test/public/programme/event?track=Next",
      ),
    ).toBe(false);
    expect(
      revalidation(
        "https://example.test/embed/event?track=Current",
        "https://example.test/embed/event?track=Next",
      ),
    ).toBe(true);
    expect(
      revalidation(
        "https://example.test/public/programme/event?track=Current",
        "https://example.test/public/programme/event?track=Next",
        "POST",
      ),
    ).toBe(true);
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

import { describe, expect, it, vi } from "vitest";

import {
  importSessionizeProfile,
  normalizeSessionizeProfileUrl,
  parseSessionizeProfileHtml,
  SessionizeProfileImportError,
} from "./sessionize-profile-import.server";

const PROFILE_HTML = `<!doctype html>
<html><body>
  <div class="c-s-speaker-info c-s-speaker-info--full">
    <h1 class="c-s-speaker-info__name">Avery Example</h1>
    <p class="c-s-speaker-info__tagline">Makes complex systems clear</p>
    <div class="c-s-speaker-info__bio">
      <p>Avery explains hard systems with practical examples &amp; honest lessons.</p>
    </div>
  </div>
</body></html>`;

describe("Sessionize public-profile import", () => {
  it("accepts only one exact public Sessionize profile path", () => {
    expect(normalizeSessionizeProfileUrl("avery-example")).toBe(
      "https://sessionize.com/avery-example/",
    );
    expect(
      normalizeSessionizeProfileUrl("https://sessionize.com/avery-example/"),
    ).toBe("https://sessionize.com/avery-example/");
    for (const unsafe of [
      "https://example.com/avery",
      "https://sessionize.com/avery/sessions",
      "https://sessionize.com/avery?next=https://internal.example",
      "https://sessionize.com@internal.example/avery",
    ]) {
      expect(() => normalizeSessionizeProfileUrl(unsafe)).toThrow(
        SessionizeProfileImportError,
      );
    }
  });

  it("extracts bounded public name, tagline and biography text", () => {
    expect(parseSessionizeProfileHtml(PROFILE_HTML)).toEqual({
      name: "Avery Example",
      tagline: "Makes complex systems clear",
      biography:
        "Avery explains hard systems with practical examples & honest lessons.",
    });
  });

  it("preserves biography text around nested markup", () => {
    const nested = PROFILE_HTML.replace(
      "<p>Avery explains hard systems with practical examples &amp; honest lessons.</p>",
      "<p>Before.</p><div><p>Nested detail.</p></div><p>After.</p>",
    );

    expect(parseSessionizeProfileHtml(nested).biography).toBe(
      "Before. Nested detail. After.",
    );
  });

  it("rejects an incomplete biography container instead of importing partial text", () => {
    const incomplete = PROFILE_HTML.replaceAll("</div>", "");

    expect(() => parseSessionizeProfileHtml(incomplete)).toThrow(
      "That Sessionize profile does not include a public biography to import.",
    );
  });

  it("replaces invalid numeric entities instead of leaking a parser failure", () => {
    expect(
      parseSessionizeProfileHtml(
        PROFILE_HTML.replace("Avery Example", "Avery &#99999999; Example"),
      ).name,
    ).toBe("Avery � Example");
  });

  it("fetches the canonical public page without following redirects", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(PROFILE_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    await expect(
      importSessionizeProfile("avery-example", fetcher),
    ).resolves.toEqual({
      name: "Avery Example",
      tagline: "Makes complex systems clear",
      biography:
        "Avery explains hard systems with practical examples & honest lessons.",
      sourceUrl: "https://sessionize.com/avery-example/",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://sessionize.com/avery-example/",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("fails explicitly when the provider markup is not a public profile", () => {
    expect(() =>
      parseSessionizeProfileHtml("<html>not a profile</html>"),
    ).toThrow(
      "Sessionize did not return a recognizable public speaker profile.",
    );
  });

  it("fails explicitly when the public profile has no biography", () => {
    expect(() =>
      parseSessionizeProfileHtml(
        PROFILE_HTML.replace(
          /<div class="c-s-speaker-info__bio">[\s\S]*?<\/div>/u,
          "",
        ),
      ),
    ).toThrow(
      "That Sessionize profile does not include a public biography to import.",
    );
  });

  it("classifies out-of-contract public profile details as provider failures", () => {
    const overlongProfile = PROFILE_HTML.replace(
      "Avery Example",
      "A".repeat(121),
    );
    try {
      parseSessionizeProfileHtml(overlongProfile);
      throw new Error("Expected the overlong provider response to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionizeProfileImportError);
      expect(error).toMatchObject({ kind: "provider" });
    }
  });

  it("rejects an oversized response before parsing it", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(PROFILE_HTML, {
        headers: {
          "content-length": "512001",
          "content-type": "text/html",
        },
      }),
    );
    await expect(
      importSessionizeProfile("avery-example", fetcher),
    ).rejects.toMatchObject({ kind: "provider" });
  });

  it("classifies fetch failures as provider failures", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("network unavailable"));

    await expect(
      importSessionizeProfile("avery-example", fetcher),
    ).rejects.toMatchObject({
      kind: "provider",
      message:
        "Sessionize could not be reached. No profile details were changed.",
    });
  });

  it("does not disguise unexpected implementation failures as provider errors", async () => {
    const failure = new Error("unexpected implementation failure");
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(failure);

    await expect(
      importSessionizeProfile("avery-example", fetcher),
    ).rejects.toBe(failure);
  });

  it("stops reading a chunked response as soon as it exceeds the bound", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(300_000));
        controller.enqueue(new Uint8Array(300_000));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(stream, { headers: { "content-type": "text/html" } }),
      );

    await expect(
      importSessionizeProfile("avery-example", fetcher),
    ).rejects.toMatchObject({ kind: "provider" });
    expect(cancelled).toBe(true);
  });
});

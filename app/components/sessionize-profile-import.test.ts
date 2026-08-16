import { describe, expect, it } from "vitest";

import { readProfileImportResponse } from "./sessionize-profile-import";

const profile = {
  name: "Avery Example",
  biography: "A public biography.",
  tagline: "Makes complex systems clear",
  sourceUrl: "https://sessionize.com/avery-example/",
};

describe("Sessionize profile-import response", () => {
  it("returns a complete JSON profile", async () => {
    const response = Response.json({ ok: true, profile });

    await expect(readProfileImportResponse(response)).resolves.toEqual(profile);
  });

  it("rejects a non-JSON endpoint response without reflecting its body", async () => {
    const response = new Response("internal proxy details", {
      headers: { "content-type": "text/plain" },
    });

    await expect(readProfileImportResponse(response)).rejects.toThrow(
      "Program Cue returned an invalid profile-import response. No details were changed.",
    );
  });

  it("rejects a successful JSON response with an incomplete profile", async () => {
    const response = Response.json({ ok: true, profile: { name: "Avery" } });

    await expect(readProfileImportResponse(response)).rejects.toThrow(
      "Program Cue returned an invalid profile-import response. No details were changed.",
    );
  });

  it("rejects a successful JSON response with blank required content", async () => {
    const response = Response.json({
      ok: true,
      profile: { ...profile, biography: " " },
    });

    await expect(readProfileImportResponse(response)).rejects.toThrow(
      "Program Cue returned an invalid profile-import response. No details were changed.",
    );
  });

  it("rejects a non-object JSON response as a contract violation", async () => {
    const response = Response.json(null);

    await expect(readProfileImportResponse(response)).rejects.toThrow(
      "Program Cue returned an invalid profile-import response. No details were changed.",
    );
  });

  it("uses a JSON error only for an unsuccessful response", async () => {
    const response = Response.json(
      { error: "Verify your email first." },
      { status: 401 },
    );

    await expect(readProfileImportResponse(response)).rejects.toThrow(
      "Verify your email first.",
    );
  });
});

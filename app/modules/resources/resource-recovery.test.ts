import { describe, expect, it } from "vitest";

import {
  emptyResourceExternalEmbedDraft,
  isResourceRecoveryPayload,
  parseResourceRecoveryPayload,
} from "./resource-recovery";

const validPayload = {
  title: "Speaker guide",
  slug: "speaker-guide",
  category: "Preparation",
  audienceScope: "all_speakers",
  audiencePersonIds: [],
  acknowledgementRequired: false,
  document: { type: "doc", content: [{ type: "paragraph" }] },
  externalEmbedDraft: emptyResourceExternalEmbedDraft,
};

describe("resource browser recovery", () => {
  it("accepts only complete current resource drafts", () => {
    expect(parseResourceRecoveryPayload(validPayload)).toEqual(validPayload);
    expect(isResourceRecoveryPayload(validPayload)).toBe(true);
  });

  it("rejects legacy, malformed and structurally invalid snapshots", () => {
    expect(
      isResourceRecoveryPayload({
        ...validPayload,
        externalEmbedDraft: undefined,
      }),
    ).toBe(false);
    expect(
      isResourceRecoveryPayload({
        ...validPayload,
        embedUrls: "https://example.com",
      }),
    ).toBe(false);
    expect(
      isResourceRecoveryPayload({
        ...validPayload,
        externalEmbedDraft: {
          ...emptyResourceExternalEmbedDraft,
          videoUrl: "https://youtu.be/dQw4w9WgXcQ",
          mapQuery: "Barbican Centre, London",
        },
      }),
    ).toBe(false);
    expect(
      isResourceRecoveryPayload({
        ...validPayload,
        document: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "embed", attrs: {} }],
            },
          ],
        },
      }),
    ).toBe(false);
  });
});

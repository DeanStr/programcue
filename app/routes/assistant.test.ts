import { describe, expect, it } from "vitest";

import { AiProviderError } from "~/modules/ai/openai-responses-provider.server";
import { providerFailureMessage } from "./assistant";

describe("assistant provider failure copy", () => {
  it("offers a retry for transport failures without an HTTP status", () => {
    const error = new AiProviderError(
      "Provider connection failed.",
      null,
      null,
      {
        failureKind: "transient",
      },
    );

    expect(providerFailureMessage(error)).toBe(
      "The AI provider is temporarily unavailable. Try again in a moment.",
    );
  });

  it("does not present an invalid provider response as transient", () => {
    expect(
      providerFailureMessage(
        new AiProviderError("Provider response did not match the contract."),
      ),
    ).toBe(
      "The AI provider returned a response Program Cue could not read. Report this if it keeps happening.",
    );
  });
});

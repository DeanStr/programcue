import { describe, expect, it } from "vitest";

import { AiProviderError } from "~/modules/ai/openai-responses-provider.server";
import {
  assistantPromptFromRequest,
  providerFailureMessage,
} from "./assistant";

describe("assistant prompt loading", () => {
  it("accepts prompts up to the domain limit", () => {
    const prompt = "a".repeat(4_000);
    expect(
      assistantPromptFromRequest(
        new Request(
          `http://program-cue.test/admin/assistant?prompt=${encodeURIComponent(prompt)}`,
        ),
      ),
    ).toBe(prompt);
  });

  it("rejects oversized prompts instead of truncating them", async () => {
    const prompt = "a".repeat(4_001);

    try {
      assistantPromptFromRequest(
        new Request(
          `http://program-cue.test/admin/assistant?prompt=${encodeURIComponent(prompt)}`,
        ),
      );
      throw new Error("Expected the oversized prompt to be rejected.");
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      const response = error as Response;
      expect(response.status).toBe(400);
      await expect(response.text()).resolves.toBe(
        "Assistant requests are limited to 4,000 characters.",
      );
    }
  });
});

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

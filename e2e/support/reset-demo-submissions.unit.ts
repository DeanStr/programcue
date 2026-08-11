import type { APIRequestContext, APIResponse } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";

// Keep this Vitest-only file outside Playwright's default *.test.ts discovery.

import {
  isRetryableResetTransportError,
  resetDemoSubmissions,
} from "./reset-demo-submissions";

function successfulResetResponse() {
  return {
    json: async () => ({
      ok: true,
      baseline: {
        versionCount: 2,
        publishedVersionCount: 1,
        draftVersionCount: 1,
        submissionCount: 0,
        senderFixtureConfigured: false,
      },
    }),
    ok: () => true,
  } as APIResponse;
}

function requestContext(post: APIRequestContext["post"]) {
  return {
    post,
    get: vi.fn(async () => ({ ok: () => true }) as APIResponse),
  } as unknown as APIRequestContext;
}

describe("demo submission reset transport retries", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    Object.assign(new Error("read failed"), { code: "ECONNRESET" }),
    new Error("apiRequestContext.post: socket hang up"),
    new Error("apiRequestContext.post: read ECONNRESET"),
    new Error("outer failure", {
      cause: Object.assign(new Error("read failed"), { code: "ECONNRESET" }),
    }),
  ])("recognises a reset connection failure", (error) => {
    expect(isRetryableResetTransportError(error)).toBe(true);
  });

  it.each([
    new Error("Request timed out"),
    Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }),
    new SyntaxError("Unexpected end of JSON input"),
    { code: "HTTP_503", message: "Service unavailable" },
  ])("rejects a non-reset transport failure", (error) => {
    expect(isRetryableResetTransportError(error)).toBe(false);
  });

  it("retries a connection reset and then validates the successful reset", async () => {
    vi.useFakeTimers();
    const post = vi
      .fn<APIRequestContext["post"]>()
      .mockRejectedValueOnce(
        Object.assign(new Error("read failed"), { code: "ECONNRESET" }),
      )
      .mockResolvedValueOnce(successfulResetResponse());
    const reset = resetDemoSubmissions(requestContext(post));

    await vi.advanceTimersByTimeAsync(250);
    await reset;

    expect(post).toHaveBeenCalledTimes(2);
  });

  it("does not retry an HTTP product error", async () => {
    const post = vi.fn<APIRequestContext["post"]>().mockResolvedValue({
      json: async () => ({ ok: false, code: "RESET_REJECTED" }),
      ok: () => false,
      status: () => 503,
    } as APIResponse);

    await expect(resetDemoSubmissions(requestContext(post))).rejects.toThrow(
      'Demo submission reset failed with 503: {"ok":false,"code":"RESET_REJECTED"}',
    );
    expect(post).toHaveBeenCalledOnce();
  });

  it("does not retry a response JSON failure", async () => {
    const jsonError = new SyntaxError("Unexpected end of JSON input");
    const post = vi.fn<APIRequestContext["post"]>().mockResolvedValue({
      json: async () => {
        throw jsonError;
      },
    } as unknown as APIResponse);

    await expect(resetDemoSubmissions(requestContext(post))).rejects.toBe(
      jsonError,
    );
    expect(post).toHaveBeenCalledOnce();
  });
});

import { expect, type APIRequestContext } from "@playwright/test";

import { e2eOrigin } from "./e2e-origin";

const resetConfirmation = "reset-submissions-demo";
const resetTimeoutMs = 15_000;
const resetRetryIntervalMs = 250;
const sameOriginHeaders = { origin: e2eOrigin };

type ResetResponse = {
  ok?: boolean;
  code?: string;
  activeOperationCount?: number;
  baseline?: {
    versionCount?: number;
    publishedVersionCount?: number;
    draftVersionCount?: number;
    submissionCount?: number;
    senderFixtureConfigured?: boolean;
  };
};

export function isRetryableResetTransportError(error: unknown) {
  const visited = new Set<object>();
  let candidate = error;

  while (typeof candidate === "object" && candidate !== null) {
    if (visited.has(candidate)) {
      return false;
    }
    visited.add(candidate);

    const transportError = candidate as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (
      transportError.code === "ECONNRESET" ||
      (typeof transportError.message === "string" &&
        /(?:ECONNRESET|socket hang up)/iu.test(transportError.message))
    ) {
      return true;
    }
    candidate = transportError.cause;
  }

  return false;
}

async function waitForRetry(deadline: number) {
  const remainingMs = deadline - Date.now();
  if (remainingMs > 0) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(resetRetryIntervalMs, remainingMs)),
    );
  }
}

export async function resetDemoSubmissions(
  request: APIRequestContext,
  options: { verifiedLocalSender?: boolean } = {},
) {
  const deadline = Date.now() + resetTimeoutMs;
  let lastTransportError: unknown;
  while (true) {
    if (lastTransportError && Date.now() >= deadline) {
      throw lastTransportError;
    }

    let response: Awaited<ReturnType<APIRequestContext["post"]>>;
    try {
      response = await request.post("/demo/reset/submissions", {
        form: {
          confirm: resetConfirmation,
          ...(options.verifiedLocalSender
            ? { senderFixture: "verified_local_capture" }
            : {}),
        },
        headers: sameOriginHeaders,
        timeout: Math.max(1, deadline - Date.now()),
      });
    } catch (error) {
      if (!isRetryableResetTransportError(error) || Date.now() >= deadline) {
        throw error;
      }
      lastTransportError = error;
      await waitForRetry(deadline);
      continue;
    }
    lastTransportError = undefined;

    const body = (await response.json()) as ResetResponse;
    if (response.ok()) {
      expect(body).toMatchObject({
        ok: true,
        baseline: {
          versionCount: 2,
          publishedVersionCount: 1,
          draftVersionCount: 1,
          submissionCount: 0,
          senderFixtureConfigured: Boolean(options.verifiedLocalSender),
        },
      });
      expect((await request.get("/apply/form")).ok()).toBeTruthy();
      return;
    }
    if (
      response.status() !== 409 ||
      body.code !== "ACTIVE_SUBMISSION_OPERATIONS"
    ) {
      throw new Error(
        `Demo submission reset failed with ${response.status()}: ${JSON.stringify(body)}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Demo submission reset timed out with ${body.activeOperationCount ?? "unknown"} active operation(s).`,
      );
    }
    await waitForRetry(deadline);
  }
}

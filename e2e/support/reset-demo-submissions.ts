import { expect, type APIRequestContext } from "@playwright/test";

const resetConfirmation = "reset-submissions-demo";
const resetTimeoutMs = 15_000;
const sameOriginHeaders = { origin: "http://127.0.0.1:5173" };

type ResetResponse = {
  ok?: boolean;
  code?: string;
  activeOperationCount?: number;
  baseline?: {
    versionCount?: number;
    publishedVersionCount?: number;
    draftVersionCount?: number;
    submissionCount?: number;
  };
};

export async function resetDemoSubmissions(request: APIRequestContext) {
  const deadline = Date.now() + resetTimeoutMs;
  while (true) {
    const response = await request.post("/demo/reset/submissions", {
      form: { confirm: resetConfirmation },
      headers: sameOriginHeaders,
    });
    const body = await response.json() as ResetResponse;
    if (response.ok()) {
      expect(body).toMatchObject({
        ok: true,
        baseline: {
          versionCount: 2,
          publishedVersionCount: 1,
          draftVersionCount: 1,
          submissionCount: 0,
        },
      });
      expect((await request.get("/apply/form")).ok()).toBeTruthy();
      return;
    }
    if (response.status() !== 409 || body.code !== "ACTIVE_SUBMISSION_OPERATIONS") {
      throw new Error(`Demo submission reset failed with ${response.status()}: ${JSON.stringify(body)}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Demo submission reset timed out with ${body.activeOperationCount ?? "unknown"} active operation(s).`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

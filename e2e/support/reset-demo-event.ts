import { expect, type APIRequestContext } from "@playwright/test";
import { UNSAFE_decodeViaTurboStream } from "react-router";

import { e2eOrigin } from "./e2e-origin";

const confirmation = "Future of Events 2027";
const sameOriginHeaders = { origin: e2eOrigin };

export async function resetDemoEvent(request: APIRequestContext) {
  const deadline = Date.now() + 30_000;
  while (true) {
    const response = await request.post("/demo.data", {
      form: { intent: "reset", confirmation },
      headers: sameOriginHeaders,
    });
    if (response.status() === 200 || response.status() === 207) {
      const bytes = await response.body();
      const decoded = await UNSAFE_decodeViaTurboStream(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        globalThis,
      );
      await decoded.done;
      const decodedValue = decoded.value as {
        data?: {
          committed?: boolean;
          result?: { baseline?: { publishedSchedules?: number } };
        };
      };
      const body = decodedValue.data ?? {};
      expect(body.committed).toBe(true);
      expect(body.result?.baseline?.publishedSchedules).toBe(1);
      return;
    }
    if (response.status() !== 409 || Date.now() >= deadline) {
      throw new Error(
        `Demo reset failed with ${response.status()}: ${await response.text()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

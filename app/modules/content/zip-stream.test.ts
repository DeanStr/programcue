import { describe, expect, it } from "vitest";

import { createStoredZipStream } from "./zip-stream.server";

function storedEntry(
  body: ReadableStream<Uint8Array>,
  size: number,
  path = "Session/slides.pdf",
) {
  return {
    path,
    modifiedAt: 1_735_689_600,
    object: { body, size } as R2ObjectBody,
  };
}

describe("stored ZIP stream", () => {
  it("reads R2 data only as downstream demand creates room", async () => {
    const chunks = Array.from({ length: 12 }, (_, index) =>
      new Uint8Array([index]),
    );
    let bodyPulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = chunks[bodyPulls];
          bodyPulls += 1;
          if (chunk) controller.enqueue(chunk);
          if (bodyPulls >= chunks.length) controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const reader = createStoredZipStream([
      storedEntry(body, chunks.length),
    ]).getReader();

    expect(bodyPulls).toBe(0);
    const header = await reader.read();
    expect(header.done).toBe(false);
    await Promise.resolve();
    expect(bodyPulls).toBeLessThan(chunks.length);

    const firstBodyChunk = await reader.read();
    expect(firstBodyChunk.value).toEqual(chunks[0]);
    await Promise.resolve();
    expect(bodyPulls).toBeLessThan(chunks.length);

    await reader.cancel("slow consumer stopped");
  });

  it("cancels the active R2 reader when the response is cancelled", async () => {
    let cancelledWith: unknown;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
        cancel(reason) {
          cancelledWith = reason;
        },
      },
      { highWaterMark: 0 },
    );
    const reader = createStoredZipStream([storedEntry(body, 100)]).getReader();

    await reader.read();
    await reader.cancel("client disconnected");

    expect(cancelledWith).toBe("client disconnected");
  });

  it("fails before emitting bytes beyond the declared R2 object size", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const reader = createStoredZipStream([storedEntry(body, 1)]).getReader();

    expect((await reader.read()).done).toBe(false);
    await expect(reader.read()).rejects.toThrow(/changed during ZIP generation/i);
    expect(cancelled).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { createStoredZipStream } from "./zip-stream.server";

function storedEntry(
  body: ReadableStream<Uint8Array>,
  size: number,
  path = "Session/slides.pdf",
  onOpen?: () => void,
) {
  return {
    path,
    modifiedAt: 1_735_689_600,
    expectedSize: size,
    open: async () => {
      onOpen?.();
      return { body, size } as R2ObjectBody;
    },
  };
}

describe("stored ZIP stream", () => {
  it("reads R2 data only as downstream demand creates room", async () => {
    const chunks = Array.from(
      { length: 12 },
      (_, index) => new Uint8Array([index]),
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
    let opens = 0;
    const reader = createStoredZipStream([
      storedEntry(body, chunks.length, undefined, () => {
        opens += 1;
      }),
    ]).getReader();

    expect(bodyPulls).toBe(0);
    expect(opens).toBe(0);
    const header = await reader.read();
    expect(header.done).toBe(false);
    expect(opens).toBe(1);
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

  it("cancels an R2 body acquired while the response is being cancelled", async () => {
    let resolveOpen: ((object: R2ObjectBody) => void) | undefined;
    let cancelledWith: unknown;
    const body = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancelledWith = reason;
      },
    });
    const stream = createStoredZipStream([
      {
        path: "Session/slides.pdf",
        expectedSize: 1,
        modifiedAt: 1_735_689_600,
        open: () =>
          new Promise<R2ObjectBody>((resolve) => {
            resolveOpen = resolve;
          }),
      },
    ]);
    const reader = stream.getReader();
    const pendingRead = reader.read();
    await Promise.resolve();
    const cancellation = reader.cancel("client disconnected during open");
    resolveOpen?.({ body, size: 1 } as R2ObjectBody);

    await cancellation;
    await expect(pendingRead).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(cancelledWith).toBe("client disconnected during open");
  });

  it("opens only the entry reached by downstream consumption", async () => {
    const firstBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const secondBody = new ReadableStream<Uint8Array>();
    const opened: string[] = [];
    const reader = createStoredZipStream([
      storedEntry(firstBody, 1, "Session/first.pdf", () => {
        opened.push("first");
      }),
      storedEntry(secondBody, 0, "Session/second.pdf", () => {
        opened.push("second");
      }),
    ]).getReader();

    expect(opened).toEqual([]);
    await reader.read();
    expect(opened).toEqual(["first"]);
    await reader.cancel("stop before the second entry");
    expect(opened).toEqual(["first"]);
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
    await expect(reader.read()).rejects.toThrow(
      /changed during ZIP generation/i,
    );
    expect(cancelled).toBe(true);
  });

  it("cancels a newly opened body whose size no longer matches", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const reader = createStoredZipStream([
      {
        path: "Session/slides.pdf",
        expectedSize: 1,
        modifiedAt: 1_735_689_600,
        open: async () => ({ body, size: 2 }) as R2ObjectBody,
      },
    ]).getReader();

    await expect(reader.read()).rejects.toThrow(
      /changed during ZIP generation/i,
    );
    expect(cancelled).toBe(true);
  });
});

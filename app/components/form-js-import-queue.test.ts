import { describe, expect, it } from "vitest";

import { createFormJsImportQueue } from "./form-js-import-queue";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("form-js import queue", () => {
  it("serializes imports and coalesces pending schemas to the latest request", async () => {
    const first = deferred();
    const calls: string[] = [];
    const queue = createFormJsImportQueue();

    queue.enqueue({
      fingerprint: "first",
      run: async () => {
        calls.push("first:start");
        await first.promise;
        calls.push("first:end");
      },
    });
    queue.enqueue({
      fingerprint: "superseded",
      run: async () => {
        calls.push("superseded");
      },
    });
    queue.enqueue({
      fingerprint: "latest",
      run: async () => {
        calls.push("latest");
      },
    });

    expect(calls).toEqual(["first:start"]);
    first.resolve();
    await first.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual(["first:start", "first:end", "latest"]);
  });

  it("drops queued work after disposal", async () => {
    const first = deferred();
    const calls: string[] = [];
    const queue = createFormJsImportQueue();

    queue.enqueue({
      fingerprint: "first",
      run: async () => {
        calls.push("first");
        await first.promise;
      },
    });
    queue.enqueue({
      fingerprint: "pending",
      run: async () => {
        calls.push("pending");
      },
    });
    queue.dispose();
    first.resolve();
    await first.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual(["first"]);
  });
});

import { describe, expect, it } from "vitest";

import { processWithConcurrency } from "./bounded-concurrency";

describe("bounded Queue concurrency", () => {
  it("never exceeds the configured concurrency and processes every item", async () => {
    let active = 0;
    let maximumActive = 0;
    const processed: number[] = [];
    await processWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      processed.push(item);
      active -= 1;
    });
    expect(maximumActive).toBe(3);
    expect(processed.sort((left, right) => left - right)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it("finishes independent items before reporting one handler failure", async () => {
    const processed: number[] = [];
    await expect(
      processWithConcurrency([1, 2, 3, 4], 2, async (item) => {
        processed.push(item);
        if (item === 2) throw new Error("deliberate failure");
      }),
    ).rejects.toThrow("deliberate failure");
    expect(processed.sort((left, right) => left - right)).toEqual([1, 2, 3, 4]);
  });

  it("does not swallow an undefined rejection reason", async () => {
    let rejected = false;
    try {
      await processWithConcurrency([1], 1, async () => {
        throw undefined;
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});

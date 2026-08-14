export async function processWithConcurrency<T>(
  items: readonly T[],
  maximumConcurrency: number,
  process: (item: T) => Promise<void>,
) {
  if (!Number.isInteger(maximumConcurrency) || maximumConcurrency < 1) {
    throw new RangeError("Maximum concurrency must be a positive integer.");
  }
  let nextIndex = 0;
  let firstError: unknown;
  let failed = false;
  const run = async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      if (item === undefined) continue;
      try {
        await process(item);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(maximumConcurrency, items.length) }, run),
  );
  if (failed) throw firstError;
}

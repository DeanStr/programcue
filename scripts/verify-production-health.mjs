import { fileURLToPath } from "node:url";

import { readReleaseRevision } from "./validate-release-state.mjs";

const HEALTH_URL = "https://app.programcue.com/api/v1/health";
const MAX_ATTEMPTS = 12;
const RETRY_DELAY_MS = 5_000;

export function validateProductionHealth(payload, expectedSourceRevision) {
  if (
    payload?.ok !== true ||
    payload?.service !== "program-cue" ||
    payload?.environment !== "production" ||
    payload?.sourceRevision !== expectedSourceRevision
  ) {
    throw new Error(
      "Production health did not report the deployed Program Cue source revision.",
    );
  }
}

async function readHealth() {
  const response = await fetch(HEALTH_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Production health returned HTTP ${response.status}.`);
  }
  return response.json();
}

async function run() {
  const expectedSourceRevision = readReleaseRevision();
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      validateProductionHealth(await readHealth(), expectedSourceRevision);
      console.log(
        `Production health reports deployed source ${expectedSourceRevision}.`,
      );
      return;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolveRetry) =>
          setTimeout(resolveRetry, RETRY_DELAY_MS),
        );
      }
    }
  }
  throw lastError;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

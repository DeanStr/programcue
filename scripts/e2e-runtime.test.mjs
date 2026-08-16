import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveE2eRuntime,
  resolveE2eShardCount,
  resolveE2eShardRuntimes,
} from "./e2e-runtime.mjs";

test("E2E runtime isolates a configured port and Wrangler state directory", () => {
  const runtime = resolveE2eRuntime({
    PROGRAM_CUE_E2E_PORT: "5184",
    PROGRAM_CUE_E2E_INSPECTOR_PORT: "15184",
    PROGRAM_CUE_E2E_STATE: ".wrangler/e2e-state-shard-2",
  });

  assert.equal(runtime.port, 5184);
  assert.equal(runtime.inspectorPort, 15184);
  assert.equal(runtime.origin, "http://127.0.0.1:5184");
  assert.equal(runtime.statePathFromRepository, ".wrangler/e2e-state-shard-2");
});

test("E2E runtime rejects state outside the repository Wrangler directory", () => {
  assert.throws(
    () => resolveE2eRuntime({ PROGRAM_CUE_E2E_STATE: "../shared-state" }),
    /directly inside \.wrangler/,
  );
  assert.throws(
    () =>
      resolveE2eRuntime({
        PROGRAM_CUE_E2E_STATE: ".wrangler/e2e-state/nested",
      }),
    /directly inside \.wrangler/,
  );
  assert.throws(
    () => resolveE2eRuntime({ PROGRAM_CUE_E2E_STATE: ".wrangler/cache" }),
    /must be an e2e-state path/,
  );
});

test("E2E runtime validates ports and shard counts", () => {
  assert.throws(
    () => resolveE2eRuntime({ PROGRAM_CUE_E2E_PORT: "65536" }),
    /PROGRAM_CUE_E2E_PORT must be an integer/,
  );
  assert.throws(
    () => resolveE2eRuntime({ PROGRAM_CUE_E2E_INSPECTOR_PORT: "not-a-port" }),
    /PROGRAM_CUE_E2E_INSPECTOR_PORT must be an integer/,
  );
  assert.equal(resolveE2eShardCount({}), 5);
  assert.equal(resolveE2eShardCount({ PROGRAM_CUE_E2E_SHARDS: "2" }), 2);
  assert.throws(
    () => resolveE2eShardCount({ PROGRAM_CUE_E2E_SHARDS: "9" }),
    /PROGRAM_CUE_E2E_SHARDS must be an integer/,
  );
  assert.equal(
    resolveE2eRuntime({ PROGRAM_CUE_E2E_PORT: "5184" }).inspectorPort,
    15184,
  );
});

test("E2E shard runtimes reserve distinct HTTP, inspector and state values", () => {
  const runtimes = resolveE2eShardRuntimes({
    PROGRAM_CUE_E2E_PORT: "5184",
    PROGRAM_CUE_E2E_INSPECTOR_PORT: "15184",
    PROGRAM_CUE_E2E_SHARDS: "2",
    PROGRAM_CUE_E2E_STATE: ".wrangler/e2e-state-review",
  });

  assert.deepEqual(
    runtimes.map(({ inspectorPort, port, shard, statePathFromRepository }) => ({
      inspectorPort,
      port,
      shard,
      statePathFromRepository,
    })),
    [
      {
        inspectorPort: 15184,
        port: 5184,
        shard: 1,
        statePathFromRepository: ".wrangler/e2e-state-review-5184",
      },
      {
        inspectorPort: 15185,
        port: 5185,
        shard: 2,
        statePathFromRepository: ".wrangler/e2e-state-review-5185",
      },
    ],
  );
});

test("E2E shard runtimes reject exhausted or overlapping port ranges", () => {
  assert.throws(
    () =>
      resolveE2eShardRuntimes({
        PROGRAM_CUE_E2E_PORT: "65534",
        PROGRAM_CUE_E2E_SHARDS: "3",
      }),
    /cannot reserve 3 consecutive ports/,
  );
  assert.throws(
    () =>
      resolveE2eShardRuntimes({
        PROGRAM_CUE_E2E_PORT: "5184",
        PROGRAM_CUE_E2E_INSPECTOR_PORT: "65535",
        PROGRAM_CUE_E2E_SHARDS: "2",
      }),
    /INSPECTOR_PORT 65535 cannot reserve 2 consecutive ports/,
  );
  assert.throws(
    () =>
      resolveE2eShardRuntimes({
        PROGRAM_CUE_E2E_PORT: "5184",
        PROGRAM_CUE_E2E_INSPECTOR_PORT: "5185",
        PROGRAM_CUE_E2E_SHARDS: "2",
      }),
    /must not overlap/,
  );
});

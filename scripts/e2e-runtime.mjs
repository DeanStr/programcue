import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

function parseBoundedInteger(value, name, { defaultValue, min, max }) {
  const configured = value?.trim() || String(defaultValue);
  const parsed = Number(configured);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `${name} must be an integer from ${min} to ${max}; received ${JSON.stringify(configured)}.`,
    );
  }
  return parsed;
}

function defaultInspectorPort(port) {
  return port <= 55_528 ? port + 10_000 : port - 10_000;
}

export function resolveE2eRuntime(environment = process.env) {
  const port = parseBoundedInteger(
    environment.PROGRAM_CUE_E2E_PORT,
    "PROGRAM_CUE_E2E_PORT",
    {
      defaultValue: 5173,
      min: 1,
      max: 65_535,
    },
  );
  const wranglerRoot = resolve(repositoryRoot, ".wrangler");
  const inspectorPort = parseBoundedInteger(
    environment.PROGRAM_CUE_E2E_INSPECTOR_PORT,
    "PROGRAM_CUE_E2E_INSPECTOR_PORT",
    { defaultValue: defaultInspectorPort(port), min: 1, max: 65_535 },
  );
  const configuredState =
    environment.PROGRAM_CUE_E2E_STATE?.trim() || ".wrangler/e2e-state";
  const statePath = resolve(repositoryRoot, configuredState);

  if (
    dirname(statePath) !== wranglerRoot ||
    !/^e2e-state(?:-[A-Za-z0-9._-]+)?$/u.test(basename(statePath))
  ) {
    throw new Error(
      `PROGRAM_CUE_E2E_STATE must be an e2e-state path directly inside .wrangler; received ${JSON.stringify(configuredState)}.`,
    );
  }

  return {
    origin: `http://127.0.0.1:${port}`,
    inspectorPort,
    port,
    statePath,
    statePathFromRepository: relative(repositoryRoot, statePath),
  };
}

export function resolveE2eShardCount(environment = process.env) {
  return parseBoundedInteger(
    environment.PROGRAM_CUE_E2E_SHARDS,
    "PROGRAM_CUE_E2E_SHARDS",
    { defaultValue: 5, min: 1, max: 8 },
  );
}

export function resolveE2eShardRuntimes(environment = process.env) {
  const base = resolveE2eRuntime(environment);
  const shardCount = resolveE2eShardCount(environment);
  const lastPort = base.port + shardCount - 1;
  const lastInspectorPort = base.inspectorPort + shardCount - 1;

  if (lastPort > 65_535) {
    throw new Error(
      `PROGRAM_CUE_E2E_PORT ${base.port} cannot reserve ${shardCount} consecutive ports.`,
    );
  }
  if (lastInspectorPort > 65_535) {
    throw new Error(
      `PROGRAM_CUE_E2E_INSPECTOR_PORT ${base.inspectorPort} cannot reserve ${shardCount} consecutive ports.`,
    );
  }
  if (base.port <= lastInspectorPort && base.inspectorPort <= lastPort) {
    throw new Error("E2E HTTP and inspector port ranges must not overlap.");
  }

  const stateName = basename(base.statePath);
  const stateDirectory = dirname(base.statePath);
  return Array.from({ length: shardCount }, (_, index) => {
    const port = base.port + index;
    const statePath = resolve(stateDirectory, `${stateName}-${port}`);
    return {
      inspectorPort: base.inspectorPort + index,
      port,
      shard: index + 1,
      shardCount,
      statePath,
      statePathFromRepository: relative(repositoryRoot, statePath),
    };
  });
}

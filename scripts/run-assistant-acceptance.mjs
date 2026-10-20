import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { unstable_readConfig } from "wrangler";
import { resolvePackageExecutable } from "./package-executable.mjs";

const artifactRoot = ".artifacts/assistant-workflow/live";
const directory = `${artifactRoot}/${new Date().toISOString().replace(/[.:]/g, "-")}-${randomUUID().slice(0, 8)}`;
await mkdir(directory, { recursive: true });
await writeFile(
  `${artifactRoot}/latest.json`,
  JSON.stringify({ directory }, null, 2),
);
const envFile = process.env.PROGRAM_CUE_ACCEPTANCE_ENV_FILE ?? ".dev.vars";
const configured = {
  ...(existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {}),
  ...process.env,
};
const provider = configured.PROGRAM_CUE_ACCEPTANCE_PROVIDER ?? "workers_ai";
const workersAiModel = "@cf/deepseek-ai/deepseek-v4-flash-0731";
const model =
  configured.PROGRAM_CUE_ACCEPTANCE_MODEL ??
  (provider === "workers_ai" ? workersAiModel : undefined);
const credential =
  provider === "openai"
    ? configured.OPENAI_API_KEY
    : provider === "anthropic"
      ? configured.ANTHROPIC_API_KEY
      : null;
let reason =
  !["workers_ai", "openai", "anthropic"].includes(provider) || !model
    ? "Select workers_ai, openai or anthropic and an exact model with PROGRAM_CUE_ACCEPTANCE_PROVIDER and PROGRAM_CUE_ACCEPTANCE_MODEL."
    : provider === "workers_ai" && model !== workersAiModel
      ? `Workers AI requires the application's configured model ${workersAiModel}.`
      : provider !== "workers_ai" && !credential?.trim()
        ? `The selected ${provider} provider credential is unavailable.`
        : null;
configured.PROGRAM_CUE_ACCEPTANCE_PROVIDER = provider;
configured.PROGRAM_CUE_ACCEPTANCE_MODEL = model;
if (!reason && provider === "workers_ai") {
  let authenticated = false;
  try {
    const identity = JSON.parse(
      execFileSync(
        resolvePackageExecutable("wrangler", "wrangler"),
        ["whoami", "--json"],
        {
          env: { ...configured, CI: "true", WRANGLER_SEND_METRICS: "false" },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
        },
      ),
    );
    authenticated = identity.loggedIn === true;
  } catch {
    // Never print credential-bearing process errors or report a simulated success.
  }
  if (!authenticated) {
    reason =
      "Cloudflare authentication could not be verified. Run npx wrangler login or configure CLOUDFLARE_API_TOKEN, then retry.";
  } else {
    const deployment = unstable_readConfig(
      { config: "wrangler.jsonc" },
      { hideWarnings: true },
    );
    const accountId =
      configured.CLOUDFLARE_ACCOUNT_ID?.trim() ||
      deployment.vars?.CLOUDFLARE_ACCOUNT_ID;
    if (!accountId || typeof accountId !== "string") {
      reason = "Set CLOUDFLARE_ACCOUNT_ID to the account used for Workers AI.";
    } else {
      const configPath = `${directory}/wrangler.json`;
      // Only AI is remote. Database/storage bindings come from the local test pool.
      await writeFile(
        configPath,
        JSON.stringify(
          {
            name: "program-cue-assistant-acceptance",
            account_id: accountId,
            compatibility_date: deployment.compatibility_date,
            compatibility_flags: deployment.compatibility_flags,
            ai: { binding: "AI", remote: true },
          },
          null,
          2,
        ),
      );
      configured.PROGRAM_CUE_ACCEPTANCE_WRANGLER_CONFIG = configPath;
    }
  }
}
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const untracked = execFileSync(
  "git",
  ["ls-files", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)
  .sort()
  .map((path) => [
    path,
    createHash("sha256").update(readFileSync(path)).digest("hex"),
  ]);
const workingDiffSha256 = createHash("sha256")
  .update(execFileSync("git", ["diff", "HEAD"], { encoding: "utf8" }))
  .update(JSON.stringify(untracked))
  .digest("hex");
await writeFile(
  `${directory}/preflight.json`,
  JSON.stringify(
    {
      mode: "live acceptance",
      phase: "preflight",
      sourceRevision,
      workingDiffSha256,
      generatedAt: new Date().toISOString(),
      provider: provider ?? null,
      model: model ?? null,
      providerCalled: false,
      status: reason ? "blocked" : "ready",
      reason,
      scenarios: [
        "success",
        "insufficient_information",
        "no_blockers",
        "stale_before_approval",
        "provider_failure",
      ].map((scenario) => ({ scenario, status: "not attempted" })),
    },
    null,
    2,
  ),
);
configured.PROGRAM_CUE_ACCEPTANCE_SOURCE = `${sourceRevision}+${workingDiffSha256.slice(0, 12)}`;
if (reason) {
  console.error(
    `Assistant live acceptance blocked: ${reason} No model was called. Evidence: ${directory}/preflight.json`,
  );
  process.exitCode = 1;
} else {
  const child = spawn(
    resolvePackageExecutable("vitest", "vitest"),
    [
      "run",
      "--config",
      "vitest.assistant-acceptance.config.ts",
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${directory}/test-results.json`,
    ],
    {
      env: { ...configured, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = [];
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output.push(chunk);
      process.stdout.write(chunk);
    });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  await writeFile(`${directory}/run.log`, Buffer.concat(output));
  const reports = Buffer.concat(output)
    .toString("utf8")
    .split("\n")
    .flatMap((line) => {
      const index = line.indexOf("ASSISTANT_ACCEPTANCE_REPORT ");
      return index === -1
        ? []
        : [
            JSON.parse(
              line.slice(index + "ASSISTANT_ACCEPTANCE_REPORT ".length),
            ),
          ];
    });
  await writeFile(
    `${directory}/scenarios.json`,
    JSON.stringify(
      {
        mode: "live acceptance",
        sourceRevision,
        workingDiffSha256,
        provider,
        model,
        scenarios: reports,
      },
      null,
      2,
    ),
  );
  process.exitCode = typeof code === "number" ? code : 1;
}

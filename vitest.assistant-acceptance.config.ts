import { workerTestProject } from "./vitest.worker.config.ts";

const provider = process.env.PROGRAM_CUE_ACCEPTANCE_PROVIDER;
const model = process.env.PROGRAM_CUE_ACCEPTANCE_MODEL;
const sourceRevision = process.env.PROGRAM_CUE_ACCEPTANCE_SOURCE?.trim();
if (!sourceRevision)
  throw new Error(
    "Assistant acceptance requires a recorded source revision. Use npm run acceptance:assistant to record the source fingerprint before any provider call.",
  );
if (!model || !["workers_ai", "openai", "anthropic"].includes(provider ?? "")) {
  throw new Error(
    "Use npm run acceptance:assistant with an explicit provider, model and configured credentials.",
  );
}
const wranglerConfig = process.env.PROGRAM_CUE_ACCEPTANCE_WRANGLER_CONFIG;
if (provider === "workers_ai" && !wranglerConfig)
  throw new Error(
    "Use npm run acceptance:assistant to configure the real Workers AI binding.",
  );
const bindings = Object.fromEntries(
  [
    "OPENAI_API_KEY",
    "OPENAI_RESPONSES_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MESSAGES_URL",
    "AI_INFERENCE_PRICING",
  ].flatMap((key) =>
    process.env[key] ? [[key, process.env[key] as string]] : [],
  ),
);
const config = workerTestProject(
  {
    ...bindings,
    SOURCE_REVISION: sourceRevision,
    ASSISTANT_ACCEPTANCE_PROVIDER: provider as string,
    ASSISTANT_ACCEPTANCE_MODEL: model,
  },
  provider === "workers_ai" ? wranglerConfig : undefined,
);
config.test = {
  ...config.test,
  name: "assistant-live-acceptance",
  include: ["app/modules/ai/ai-readiness-live.acceptance.ts"],
  testTimeout: 180_000,
  hookTimeout: 60_000,
};
export default config;

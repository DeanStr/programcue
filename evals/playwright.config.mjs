import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "@playwright/test";
import { origin, root } from "./scripts/runtime.mjs";

const sessions = JSON.parse(
  fs.readFileSync(path.join(root, ".agent-eval/local-sessions.json"), "utf8"),
);
const output = process.env.PROGRAM_CUE_LOCAL_FILES === "1" ? "file-smoke" : "product-smoke";
export default defineConfig({
  testDir: "./smokes",
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  outputDir: `.agent-eval/${output}/artifacts`,
  reporter: [
    ["line"],
    ["json", { outputFile: path.join(root, `.agent-eval/${output}/results.json`) }],
  ],
  use: {
    baseURL: origin,
    storageState: sessions.organizer,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});

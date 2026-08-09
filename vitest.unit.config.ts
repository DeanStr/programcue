import { resolve } from "node:path";

import { defineProject } from "vitest/config";

import { nodeOnlyTestFiles } from "./vitest.test-files.ts";

export default defineProject({
  resolve: {
    alias: {
      "~": resolve(import.meta.dirname, "app"),
    },
  },
  test: {
    name: "unit",
    environment: "node",
    include: [...nodeOnlyTestFiles],
  },
});

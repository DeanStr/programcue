import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig(({ command, mode, isPreview }) => {
  const localServe = command === "serve" && !isPreview;
  const configPath = localServe && mode === "development"
    ? "./wrangler.development.jsonc"
    : localServe && ["demo", "e2e"].includes(mode)
      ? "./wrangler.demo.jsonc"
      : "./wrangler.jsonc";
  return {
    plugins: [
      cloudflare({
        configPath,
        persistState: { path: mode === "e2e" ? ".wrangler/e2e-state" : ".wrangler/state" },
        viteEnvironment: { name: "ssr" },
      }),
      tailwindcss(),
      reactRouter(),
    ],
    resolve: { tsconfigPaths: true },
  };
});

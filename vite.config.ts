import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig(({ command, mode, isPreview }) => {
  const demoDevelopment = command === "serve"
    && !isPreview
    && ["development", "demo", "e2e"].includes(mode);
  return {
    plugins: [
      cloudflare({
        configPath: demoDevelopment ? "./wrangler.demo.jsonc" : "./wrangler.jsonc",
        persistState: { path: mode === "e2e" ? ".wrangler/e2e-state" : ".wrangler/state" },
        viteEnvironment: { name: "ssr" },
      }),
      tailwindcss(),
      reactRouter(),
    ],
    resolve: { tsconfigPaths: true },
  };
});

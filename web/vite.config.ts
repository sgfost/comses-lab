import { defineConfig } from "vite";
import { demoAssets } from "../scripts/demo-assets.ts";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";
import { config, projectRoot } from "../scripts/config.mjs";
export default defineConfig(({ mode }) => {
const demo = mode === "demo";
const c = demo ? { appPort: 5200, apiPort: 5201 } : config();
return {
  base: demo ? (process.env.DEMO_BASE || "./") : "/",
  publicDir: demo ? demoAssets(projectRoot) : resolve(projectRoot, "web/public"),
  root: resolve(projectRoot, "web"),
  plugins: [vue()],
  server: {
    host: "127.0.0.1",
    port: c.appPort,
    strictPort: true,
    fs: {
      strict: true,
      allow: [
        resolve(projectRoot, "web"),
        resolve(projectRoot, "shared"),
        resolve(projectRoot, "node_modules"),
      ],
      deny: [
        "**/.lab/**",
        "**/.git/**",
        "**/.env*",
        "**/*.{pem,crt,key}",
        "**/server/**",
        "**/scripts/**",
      ],
    },
    allowedHosts: ["localhost"],
    proxy: demo ? undefined : { "/api": { target: `http://127.0.0.1:${c.apiPort}` } },
    headers: {
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  },
  build: { outDir: demo ? "dist-demo" : "dist" },
};
});

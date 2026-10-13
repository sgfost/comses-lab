import { defineConfig } from "@playwright/test";
import { config, instance } from "./scripts/config.mjs";
if (!instance.startsWith("test-"))
  throw new Error(
    "Browser tests require a test-* LAB_INSTANCE; use npm run test:e2e",
  );
const c = config();
export default defineConfig({
  testDir: "./e2e",
  testIgnore: "**/demo/**",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: c.appOrigin,
    colorScheme: "light",
    viewport: { width: 1440, height: 950 },
    trace: "off",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: `${c.appOrigin}/api/health`,
    reuseExistingServer: false,
    timeout: 30000,
  },
});

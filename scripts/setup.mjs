import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { instance, stateDir } from "./config.mjs";
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const target = resolve(stateDir, "config.json");
if (existsSync(target)) {
  console.log(`Keeping existing ${target}`);
  process.exit(0);
}
const base = Number(process.env.LAB_PORT_BASE || 5100);
if (!Number.isInteger(base) || base < 1024 || base > 65000)
  throw new Error("LAB_PORT_BASE must be 1024–65000");
const config = {
  instance,
  appPort: base,
  apiPort: base + 1,
  runtimePort: base + 2,
  forgejoPort: base + 3,
  composeProject: `comses-lab-${instance}`,
  appOrigin: `http://localhost:${base}`,
  runtimeOrigin: `http://127.0.0.1:${base + 2}`,
  forgejoUrl: `http://127.0.0.1:${base + 3}`,
};
writeFileSync(target, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
console.log(`Configured ${instance}: ${config.appOrigin}; state ${stateDir}`);

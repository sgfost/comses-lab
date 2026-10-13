import { spawnSync } from "node:child_process";
import { config } from "./config.mjs";
const c = config();
const args = process.argv.slice(2);
const result = spawnSync(
  "docker",
  ["compose", "-p", c.composeProject, ...(args.length ? args : ["up", "-d"])],
  {
    stdio: "inherit",
    env: { ...process.env, LAB_FORGEJO_PORT: String(c.forgejoPort) },
  },
);
process.exit(result.status ?? 1);

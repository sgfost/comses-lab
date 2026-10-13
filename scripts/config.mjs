import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const instance = process.env.LAB_INSTANCE || "dev";
if (!/^[a-z][a-z0-9-]{0,30}$/.test(instance))
  throw new Error("Invalid LAB_INSTANCE");
export const stateDir = resolve(projectRoot, ".lab", instance);
export function config() {
  return JSON.parse(readFileSync(resolve(stateDir, "config.json"), "utf8"));
}

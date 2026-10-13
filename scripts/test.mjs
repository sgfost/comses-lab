import { spawnSync } from "node:child_process";
const instance = process.env.LAB_INSTANCE || "test-foundation";
if (!instance.startsWith("test-"))
  throw new Error("Tests require an isolated test-* instance");
const env = {
  ...process.env,
  LAB_INSTANCE: instance,
  LAB_PORT_BASE: process.env.LAB_PORT_BASE || "5510",
};
for (const args of [
  ["run", "setup"],
  ["run", "forgejo"],
  ["run", "bootstrap"],
  ["exec", "playwright", "test", "--", ...process.argv.slice(2)],
]) {
  const result = spawnSync("npm", args, { stdio: "inherit", env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

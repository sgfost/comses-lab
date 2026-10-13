import { spawn } from "node:child_process";
import { config } from "./config.mjs";
const c = config();
const children = [
  spawn(process.execPath, ["--import", "tsx", "--watch", "server/index.ts"], {
    stdio: "inherit",
  }),
  spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--config", "web/vite.config.ts"],
    { stdio: "inherit" },
  ),
];
let closing = false;
function close(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
}
for (const child of children) child.on("exit", (code) => close(code ?? 1));
process.on("SIGINT", () => close());
process.on("SIGTERM", () => close());
console.log(`Open ${c.appOrigin}`);

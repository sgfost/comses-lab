import { spawn as originalSpawn } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
const boundary = process.env.LAB_TEST_AUTHORING_BOUNDARY;
if (!process.env.LAB_INSTANCE?.startsWith("test-")) throw new Error("Authoring interruption requires an isolated test instance");
const originalFetch = globalThis.fetch;
const spawnChild = originalSpawn;
globalThis.fetch = async (input, init) => {
  const response = await originalFetch(input, init);
  if (boundary === "unknown-create" && String(input).endsWith("/api/v1/user/repos") && init?.method === "POST" && response.ok) process.kill(process.pid, "SIGKILL");
  return response;
};
if (boundary === "after-push" || boundary === "before-push") {
  childProcess.spawn = (...args) => {
    if (boundary === "before-push" && args[0] === "git" && args[1].includes("push")) process.kill(process.pid, "SIGKILL");
    const child = spawnChild(...args);
    if (args[0] === "git" && args[1].includes("push")) child.prependOnceListener("close", (status) => { if (status === 0) process.kill(process.pid, "SIGKILL"); });
    return child;
  };
  syncBuiltinESMExports();
}
if (boundary === "before-finalize") {
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    if (sql === "INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?,?)") {
      statement.run = () => process.kill(process.pid, "SIGKILL");
    }
    return statement;
  };
}

import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

function processIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid recorded guard process");
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return null;
    throw new Error("Cannot verify recorded guard process termination");
  }
  try {
    const value = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (!value) throw new Error();
    return value;
  } catch { throw new Error("Cannot establish recorded guard process identity"); }
}
export function acquireInstanceGuard(directory: string) {
  const file = resolve(directory, "instance-guard.sqlite");
  const ownerFile = resolve(directory, "instance-guard-owner.json");
  const lock = new DatabaseSync(file);
  chmodSync(file, 0o600);
  try { lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE"); }
  catch { lock.close(); throw new Error("This instance is held by another native API or credential recovery process"); }
  const nonce = randomUUID();
  try {
    if (existsSync(ownerFile)) {
      const old = JSON.parse(readFileSync(ownerFile, "utf8"));
      if (typeof old.identity !== "string") throw new Error("Cannot establish recorded guard ownership");
      const current = processIdentity(old.pid);
      if (current === old.identity) throw new Error("The recorded instance owner is still running");
    }
    writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid), nonce }), { mode: 0o600 });
  } catch (error) { lock.exec("ROLLBACK"); lock.close(); throw error; }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (JSON.parse(readFileSync(ownerFile, "utf8")).nonce === nonce) rmSync(ownerFile);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }
  };
  process.once("exit", release);
  return release;
}

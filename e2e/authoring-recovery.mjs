import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { config, stateDir, projectRoot, instance } from "../scripts/config.mjs";
if (!instance.startsWith("test-")) throw new Error("Isolated test instance required");
const settings = config();
const origin = `http://127.0.0.1:${settings.apiPort}`;
try { await fetch(`${origin}/api/health`); throw new Error("Stop this test instance's native services first"); }
catch (error) { if (error.message.startsWith("Stop")) throw error; }
const accounts = JSON.parse(readFileSync(resolve(stateDir, "credentials.json"), "utf8"));
const owner = accounts.users.find((user) => user.username === "ada");
const database = new DatabaseSync(resolve(stateDir, "lab.sqlite"));
const actorId = database.prepare("SELECT id FROM users WHERE username=?").get(owner.username).id;
const provider = async (path, method = "GET") => fetch(`${settings.forgejoUrl}/api/v1${path}`, { method, headers: { Authorization: `Basic ${Buffer.from(`${owner.username}:${owner.password}`).toString("base64")}` } });
function main(row) {
  const value = execFileSync("git", ["ls-remote", "--refs", `${settings.forgejoUrl}/${owner.username}/${row.repo_name}.git`, "refs/heads/main"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${owner.username}:${owner.password}`).toString("base64")}` },
  }).trim();
  return value ? value.split("\t")[0] : null;
}
let processHandle;
let diagnostics = "";
async function stop() {
  if (!processHandle || processHandle.exitCode !== null || processHandle.signalCode !== null) return;
  const done = new Promise((done) => processHandle.once("exit", done));
  processHandle.kill("SIGTERM"); await done;
}
async function start(boundary = "") {
  diagnostics = "";
  processHandle = spawn(process.execPath, ["--import", "tsx", ...(boundary ? ["--import", "./e2e/fixtures/interrupt-authoring.mjs"] : []), "server/index.ts"], {
    cwd: projectRoot, env: { ...process.env, LAB_TEST_AUTHORING_BOUNDARY: boundary }, stdio: ["ignore", "ignore", "pipe"],
  });
  processHandle.stderr.on("data", (chunk) => { diagnostics += chunk.toString(); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) throw new Error("Test API exited before health check");
    try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Test API did not become healthy");
}
let cookie;
async function request(path, data) {
  return fetch(`${origin}/api${path}`, { method: "POST", headers: { Origin: settings.appOrigin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(data) });
}
const reserved = [];
try {
  for (const boundary of ["unknown-create", "before-push", "after-push", "before-finalize"]) {
    await start(boundary);
    const login = await request("/session", owner);
    assert.equal(login.status, 200);
    cookie = login.headers.get("set-cookie").split(";")[0];
    const intent = { requestId: randomUUID(), templateId: "worker", title: `Recovery ${boundary}`, visibility: "private" };
    const exit = new Promise((done) => processHandle.once("exit", done));
    try {
      const unexpected = await request("/projects", intent);
      throw new Error(`Boundary ${boundary} returned HTTP ${unexpected.status}: ${await unexpected.text()}\n${diagnostics}`);
    } catch (error) {
      if (error.message.startsWith("Boundary")) throw error;
    }
    await exit;
    const row = database.prepare("SELECT * FROM project_provisions WHERE actor_id=? AND request_id=?").get(actorId, intent.requestId);
    assert.ok(row);
    reserved.push(row);
    assert.equal(database.prepare("SELECT id FROM projects WHERE id=?").get(row.project_id), undefined);
    const remote = await provider(`/repos/${owner.username}/${row.repo_name}`);
    assert.equal(remote.status, 200);
    const remoteBefore = await remote.json();
    assert.equal(remoteBefore.private, true);
    assert.equal(main(row), ["unknown-create", "before-push"].includes(boundary) ? null : row.prepared_commit);
    await start();
    const retried = await request("/projects", intent);
    if (boundary === "unknown-create") {
      assert.equal(retried.status, 409);
      assert.equal((await retried.json()).error.code, "provision_identity_unknown");
      const pending = database.prepare("SELECT * FROM project_provisions WHERE actor_id=? AND request_id=?").get(actorId, intent.requestId);
      assert.equal(pending.project_id, row.project_id);
      assert.equal(pending.provider_id, null);
      assert.equal(database.prepare("SELECT id FROM projects WHERE id=?").get(row.project_id), undefined);
    } else {
      assert.equal(retried.status, 201, await retried.clone().text());
      const completed = await retried.json();
      assert.equal(completed.project.id, row.project_id);
      assert.equal(completed.project.forgejoId, row.provider_id);
      assert.equal(completed.commit, row.prepared_commit);
      const replay = await request("/projects", intent);
      assert.equal(replay.status, 200);
      assert.equal((await replay.json()).commit, row.prepared_commit);
    }
    const remoteAfter = await (await provider(`/repos/${owner.username}/${row.repo_name}`)).json();
    assert.equal(remoteAfter.id, remoteBefore.id);
    assert.equal(remoteAfter.private, true);
    assert.equal(main(row), boundary === "unknown-create" ? null : row.prepared_commit);
    await stop();
    console.log(`PASS ${boundary}: reserved identity and private source preserved`);
  }
} finally {
  await stop();
  for (const row of reserved) {
    database.prepare("DELETE FROM project_metadata WHERE project_id=?").run(row.project_id);
    database.prepare("DELETE FROM project_access WHERE project_id=?").run(row.project_id);
    database.prepare("DELETE FROM project_provisions WHERE project_id=?").run(row.project_id);
    database.prepare("DELETE FROM projects WHERE id=?").run(row.project_id);
    await provider(`/repos/${owner.username}/${row.repo_name}`, "DELETE");
  }
  if (cookie) {
    const { createHash } = await import("node:crypto");
    database.prepare("DELETE FROM sessions WHERE token_hash=?").run(createHash("sha256").update(cookie.split("=")[1]).digest("hex"));
  }
  database.close();
}

import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import { config, instance, projectRoot, stateDir } from "../scripts/config.mjs";

if (!instance.startsWith("test-")) throw new Error("Use an isolated test instance");
const settings = config();
const owner = JSON.parse(readFileSync(join(stateDir, "credentials.json"))).users.find((user) => user.username === "ada");
assert.ok(owner);
const base = `http://127.0.0.1:${settings.apiPort}`;
try {
  await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) });
  throw new Error("Stop this instance's native services before the refs probe");
} catch (error) { if (error.message.startsWith("Stop this")) throw error; }
const directory = mkdtempSync(join(stateDir, "refs-race-"));
const id = randomUUID(), repo = `refs-race-${id}`;
const authorization = "Basic " + Buffer.from(`${owner.username}:${owner.password}`).toString("base64");
async function provider(path, method = "GET", body) {
  return fetch(settings.forgejoUrl + "/api/v1" + path, { method,
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
}
async function request(path, method = "GET", body) {
  return fetch(base + path, { method, headers: { Cookie: cookie ?? "", Origin: settings.appOrigin, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
}
async function waitFor(condition, message) {
  const deadline = Date.now() + 15000;
  while (!(await condition())) { assert.ok(Date.now() < deadline, message); await setTimeout(30); }
}
const gitEnvironment = { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: ${authorization}` };
function git(args) {
  try { return execFileSync("git", args, { cwd: directory, env: gitEnvironment, timeout: 15000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { throw new Error("Fixture Git operation failed"); }
}
let child, exited, cookie, pending, created = false;
try {
  const response = await provider("/user/repos", "POST", { name: repo, private: true, auto_init: false, default_branch: "main" });
  assert.equal(response.status, 201);
  const repository = await response.json();
  created = true;
  const db = new DatabaseSync(join(stateDir, "lab.sqlite"));
  try {
    const user = db.prepare("SELECT id FROM users WHERE username='ada'").get();
    db.prepare("INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, "Refs race", "", "private", user.id, "index.html", "MIT", "ada", repo, repository.id);
  } finally { db.close(); }
  git(["init", "-b", "main"]);
  writeFileSync(join(directory, "index.html"), "<!doctype html><title>Actual first push</title><p>Ready</p>");
  git(["add", "index.html"]);
  git(["-c", "user.name=Refs fixture", "-c", "user.email=refs@lab.invalid", "commit", "-m", "Initial ordinary model"]);
  const commit = git(["rev-parse", "HEAD"]);
  const unicodeRef = "refs/heads/unicode-\u00a0";
  child = spawn(process.execPath, ["--import", "./e2e/fixtures/delay-ref-metadata.mjs", "--import", "tsx", "server/index.ts"], {
    cwd: projectRoot, env: { ...process.env, LAB_INSTANCE: instance, LAB_TEST_REFS_GATE: directory, LAB_TEST_REFS_REPO: repo }, stdio: "ignore" });
  exited = once(child, "exit");
  await waitFor(async () => { assert.equal(child.exitCode, null); try { return (await request("/api/health")).ok; } catch { return false; } }, "API readiness timed out");
  const login = await request("/api/session", "POST", { username: owner.username, password: owner.password });
  assert.equal(login.status, 200); cookie = login.headers.get("set-cookie").split(";")[0];
  pending = request(`/api/projects/${id}/refs?kind=branch&page=1&limit=25`); pending.catch(() => {});
  await waitFor(() => existsSync(join(directory, "ready")), "Real empty metadata was not held");
  assert.equal(JSON.parse(readFileSync(join(directory, "ready"))).empty, true);
  const empty = await request(`/api/projects/${id}/refs?kind=tag`);
  assert.equal(empty.status, 409);
  assert.equal((await empty.json()).error.code, "empty_repository", "Actual absent refs preserve the empty diagnostic");
  const remote = `${settings.forgejoUrl}/ada/${repo}.git`;
  git(["push", remote, "HEAD:refs/heads/main"]);
  git(["push", remote, `HEAD:${unicodeRef}`]);
  assert.equal(git(["ls-remote", remote, "refs/heads/main"]).split("\t")[0], commit);
  writeFileSync(join(directory, "release"), "release");
  const refs = await pending; assert.equal(refs.status, 200);
  assert.deepEqual((await refs.json()).refs, [{ name: "main", ref: "refs/heads/main", commit }, { name: "unicode-\u00a0", ref: unicodeRef, commit }]);
  const file = await request(`/api/projects/${id}/file?commit=${commit}&path=index.html`); assert.equal(file.status, 200);
  const launchResponse = await request(`/api/projects/${id}/launch`, "POST", { commit }); assert.equal(launchResponse.status, 200);
  const launch = await launchResponse.json(); assert.equal((await fetch(launch.url)).status, 200);
  assert.equal((await request(`/api/launches/${launch.id}`, "DELETE")).status, 200);
  const tags = await request(`/api/projects/${id}/refs?kind=tag&page=1&limit=25`); assert.equal(tags.status, 200); assert.deepEqual((await tags.json()).refs, []);
  console.log("Real empty metadata held across first Git push: exact refs, source and launch passed");
} finally {
  writeFileSync(join(directory, "release"), "release");
  await pending?.catch(() => {});
  if (cookie) await request("/api/session", "DELETE").catch(() => {});
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  if (exited) {
    const timer = globalThis.setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await exited; } finally { globalThis.clearTimeout(timer); }
  }
  const db = new DatabaseSync(join(stateDir, "lab.sqlite"));
  try { db.prepare("DELETE FROM projects WHERE id=?").run(id); } finally { db.close(); }
  if (created) assert.equal((await provider(`/repos/ada/${repo}`, "DELETE")).status, 204);
  rmSync(directory, { recursive: true, force: true });
}

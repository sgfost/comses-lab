import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { config, instance, projectRoot, stateDir } from "../scripts/config.mjs";

if (!instance.startsWith("test-")) throw new Error("Group acceptance requires an isolated test instance");
const settings = config(), base = `http://127.0.0.1:${settings.apiPort}`;
const accounts = JSON.parse(readFileSync(join(stateDir, "credentials.json"))).users;
const directory = mkdtempSync(join(stateDir, "access-groups-"));
const sessions = new Map();
let child, exited, originalMembers, groupId, project, grantId, providerStopped = false;
async function request(path, username = "ada", method = "GET", body) {
  return fetch(base + path, { method, headers: { Origin: settings.appOrigin, "Content-Type": "application/json", ...(sessions.has(username) ? { Cookie: sessions.get(username) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
}
async function json(path, username = "ada") { const response = await request(path, username); assert.equal(response.status, 200, path); return response.json(); }
async function waitFor(condition) {
  const deadline = Date.now() + 30000;
  while (!(await condition())) { assert.ok(Date.now() < deadline, "Readiness timed out"); await setTimeout(50); }
}
async function start() {
  try { await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) }); throw new Error("Stop this instance's native services before group acceptance"); }
  catch (error) { if (error.message.startsWith("Stop this")) throw error; }
  child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], { cwd: projectRoot, env: { ...process.env, LAB_INSTANCE: instance }, stdio: "ignore" });
  exited = once(child, "exit");
  await waitFor(async () => { assert.equal(child.exitCode, null); try { return (await request("/api/health")).ok; } catch { return false; } });
}
async function stop() {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  const timer = globalThis.setTimeout(() => child.kill("SIGKILL"), 5000);
  try { await exited; } finally { globalThis.clearTimeout(timer); child = undefined; }
}
function run(args) { execFileSync(process.execPath, args, { cwd: projectRoot, env: { ...process.env, LAB_INSTANCE: instance }, timeout: 60000, stdio: "ignore" }); }
async function providerReady() {
  await waitFor(async () => { try { return (await fetch(settings.forgejoUrl + "/api/healthz", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } });
}
function git(username, args, cwd = directory, allowedFailure = false) {
  const account = accounts.find(account => account.username === username);
  const env = { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: "Authorization: Basic " + Buffer.from(`${account.username}:${account.password}`).toString("base64") };
  try { return { ok: true, text: execFileSync("git", args, { cwd, env, timeout: 20000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() }; }
  catch { if (allowedFailure) return { ok: false, text: "" }; throw new Error("Actual fixture Git operation failed"); }
}
async function replaceMembers(members) {
  const group = await json(`/api/groups/${groupId}`);
  const response = await request(`/api/groups/${groupId}/members`, "ada", "PUT", { requestId: randomUUID(), expectedVersion: group.group.version, members });
  assert.equal(response.status, 200); return response.json();
}
try {
  await start();
  for (const username of ["ada", "ben", "cy", "dee"]) {
    const account = accounts.find(account => account.username === username); assert.ok(account);
    const response = await request("/api/session", username, "POST", { username, password: account.password });
    assert.equal(response.status, 200); sessions.set(username, response.headers.get("set-cookie").split(";")[0]);
  }
  const groups = await json("/api/groups");
  groupId = groups.groups.find(group => group.permission === "admin").id;
  const group = await json(`/api/groups/${groupId}`);
  originalMembers = group.members.map(({ userId, permission }) => ({ userId, permission }));
  const candidates = (await json(`/api/groups/${groupId}/candidates`)).users;
  assert.ok(candidates.every(user => user.id !== group.group.ownerId && Object.keys(user).sort().join() === "displayName,id,username"));
  assert.equal((await request(`/api/groups/${groupId}/candidates`, "ben")).status, 404);
  const ben = candidates.find(user => user.username === "ben"), cy = candidates.find(user => user.username === "cy");
  await replaceMembers([{ userId: ben.id, permission: "write" }, { userId: cy.id, permission: "read" }]);
  const create = await request("/api/projects", "ada", "POST", { requestId: randomUUID(), templateId: "commons", title: `Group acceptance ${randomUUID().slice(0, 8)}`, visibility: "private" });
  assert.equal(create.status, 201); project = await create.json();
  const accessPath = `/api/projects/${project.project.id}/access`;
  let policy = await json(accessPath);
  const attachRequest = { requestId: randomUUID(), expectedVersion: policy.version, visibility: "private", groupId };
  const attached = await request(accessPath, "ada", "PUT", attachRequest); assert.equal(attached.status, 200);
  policy = await attached.json(); assert.equal(policy.version, attachRequest.expectedVersion + 1);
  const separateCreate = await request("/api/projects", "cy", "POST", { requestId: randomUUID(), templateId: "worker", title: `Separate project owner ${randomUUID().slice(0, 8)}`, visibility: "private" });
  assert.equal(separateCreate.status, 201);
  const separate = await separateCreate.json(), separateAccess = `/api/projects/${separate.project.id}/access`;
  const separatePolicy = await json(separateAccess, "cy");
  assert.equal((await request(separateAccess, "cy", "PUT", { requestId: randomUUID(), expectedVersion: separatePolicy.version, visibility: "private", groupId })).status, 200);
  // Issuance is a later slice; an isolated durable fixture exercises bearer fencing.
  const token = randomBytes(32).toString("base64url"); grantId = randomUUID();
  const grantDb = new DatabaseSync(join(stateDir, "lab.sqlite"));
  try {
    grantDb.prepare("INSERT INTO agent_grants(id,owner_id,name,token_hash,state) VALUES (?,?,?,?,?)").run(grantId, cy.id, "Retry route fence fixture", createHash("sha256").update(token).digest("hex"), "active");
    grantDb.prepare("INSERT INTO agent_project_scopes(grant_id,project_id,permission) VALUES (?,?,'write')").run(grantId, separate.project.id);
  } finally { grantDb.close(); }
  for (const path of [`/api/groups/${groupId}/retry`, `${separateAccess}/retry`]) {
    const response = await fetch(base + path, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ operationId: randomUUID() }) });
    assert.equal(response.status, 403, "Scoped bearer cannot trigger access administration");
  }
  assert.equal((await request(accessPath, "ada", "PUT", attachRequest)).status, 200, "Same accepted intent replays before old version check");
  assert.equal((await request(accessPath, "ada", "PUT", { ...attachRequest, visibility: "public", confirmPublic: true })).status, 409);
  assert.equal((await request(accessPath, "ada", "PUT", { ...attachRequest, requestId: randomUUID() })).status, 409);
  for (const [username, permission] of [["ada", "admin"], ["ben", "write"], ["cy", "read"]]) {
    assert.equal((await json(`/api/projects/${project.project.id}`, username)).project.permission, permission);
    assert.equal((await request(`/api/projects/${project.project.id}/file?commit=${project.commit}&path=index.html`, username)).status, 200);
  }
  for (const username of ["dee", "anonymous"]) assert.equal((await request(`/api/projects/${project.project.id}`, username)).status, 404);
  assert.equal((await request(accessPath, "ben")).status, 404);
  const remote = `${settings.forgejoUrl}/ada/${project.project.forgejoRepo}.git`;
  const writerSave = await request(`/api/projects/${project.project.id}/commits`, "ben", "POST", { ref: "refs/heads/main", expectedCommit: project.commit, message: "Writer API save", changes: [{ operation: "create", path: "api-writer.txt", content: "Ordinary API save\n" }] });
  assert.equal(writerSave.status, 201);
  for (const username of ["ben", "cy"]) git(username, ["clone", remote, username]);
  assert.equal(git("dee", ["ls-remote", remote], directory, true).ok, false);
  const writer = join(directory, "ben"), reader = join(directory, "cy");
  writeFileSync(join(writer, "writer.txt"), "Real writer push\n"); git("ben", ["add", "writer.txt"], writer);
  git("ben", ["-c", "user.name=Group writer", "-c", "user.email=group@lab.invalid", "commit", "-m", "Writer direct Git push"], writer);
  git("ben", ["push", "origin", "main"], writer);
  const writerCommit = git("ben", ["rev-parse", "HEAD"], writer).text;
  assert.equal((await json(`/api/projects/${project.project.id}/refs`, "cy")).refs.find(ref => ref.name === "main").commit, writerCommit);
  git("cy", ["pull", "--ff-only"], reader);
  writeFileSync(join(reader, "reader.txt"), "Denied reader push\n"); git("cy", ["add", "reader.txt"], reader);
  git("cy", ["-c", "user.name=Group reader", "-c", "user.email=group@lab.invalid", "commit", "-m", "Reader denied Git push"], reader);
  assert.equal(git("cy", ["push", "origin", "main"], reader, true).ok, false);
  assert.equal(git("ada", ["ls-remote", remote, "refs/heads/main"]).text.split("\t")[0], writerCommit);
  const deniedSave = await request(`/api/projects/${project.project.id}/commits`, "cy", "POST", { ref: "refs/heads/main", expectedCommit: writerCommit, message: "Reader denied API save", changes: [{ operation: "create", path: "denied.txt", content: "denied" }] });
  assert.equal(deniedSave.status, 403);
  const previewResponse = await request(`/api/projects/${project.project.id}/launch`, "ben", "POST", { commit: writerCommit }); assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json(); assert.equal((await fetch(preview.url)).status, 200);
  const currentGroup = await json(`/api/groups/${groupId}`);
  const downgrade = { requestId: randomUUID(), expectedVersion: currentGroup.group.version, members: [{ userId: ben.id, permission: "read" }, { userId: cy.id, permission: "read" }] };
  run(["scripts/forgejo.mjs", "stop"]); providerStopped = true;
  const pendingResponse = await request(`/api/groups/${groupId}/members`, "ada", "PUT", downgrade); assert.equal(pendingResponse.status, 202);
  const pending = await pendingResponse.json(); assert.equal(pending.group.version, downgrade.expectedVersion + 1); assert.equal(pending.sync.state, "pending");
  assert.ok(pending.sync.blockedProjectIds.includes(project.project.id)); assert.ok(pending.sync.unconfirmedProjectIds.includes(project.project.id));
  assert.equal((await fetch(preview.url)).status, 404);
  assert.equal((await request(`/api/projects/${project.project.id}`, "ben")).status, 404);
  assert.deepEqual((await json("/api/groups", "ben")).groups, []);
  const pendingProject = await json(accessPath); assert.equal(pendingProject.effective.mode, "owner_read_only");
  assert.equal((await request(`/api/projects/${project.project.id}/forks`, "ada", "POST", { requestId: randomUUID(), commit: writerCommit, title: "Pending source fork", visibility: "private" })).status, 409);
  assert.equal((await request(`/api/projects/${project.project.id}/launch`, "ada", "POST", { commit: writerCommit })).status, 409);
  assert.equal((await request(accessPath, "ada", "PUT", { requestId: randomUUID(), expectedVersion: pendingProject.version, visibility: "private", groupId: null })).status, 409);
  await request("/api/session", "ada", "DELETE"); sessions.delete("ada");
  await stop();
  run(["scripts/forgejo.mjs", "up", "-d"]); providerStopped = false; await providerReady();
  await start();
  const account = accounts.find(account => account.username === "ada");
  const login = await request("/api/session", "ada", "POST", { username: "ada", password: account.password }); assert.equal(login.status, 200); sessions.set("ada", login.headers.get("set-cookie").split(";")[0]);
  await waitFor(async () => (await json(`/api/groups/${groupId}`)).sync.state === "ready");
  assert.equal((await json(`/api/projects/${project.project.id}`, "ben")).project.permission, "read");
  assert.equal((await json(accessPath)).version, pendingProject.version, "Restart completion does not increment accepted version again");
  assert.equal((await request(`/api/groups/${groupId}/members`, "ada", "PUT", downgrade)).status, 200);
  writeFileSync(join(writer, "after-downgrade.txt"), "Denied after downgrade\n"); git("ben", ["add", "after-downgrade.txt"], writer);
  git("ben", ["-c", "user.name=Group writer", "-c", "user.email=group@lab.invalid", "commit", "-m", "Denied downgraded writer"], writer);
  assert.equal(git("ben", ["push", "origin", "main"], writer, true).ok, false);
  const beforeRestart = await json(`/api/groups/${groupId}`);
  await stop(); run(["--import", "tsx", "scripts/bootstrap.ts"]); await start();
  const afterRestart = await json(`/api/groups/${groupId}`);
  assert.deepEqual(afterRestart.members, beforeRestart.members, "Bootstrap never restores removed/downgraded roles"); assert.equal(afterRestart.group.version, beforeRestart.group.version);
  // A reload has only GET status and operationId, not the original PUT body.
  run(["scripts/forgejo.mjs", "stop"]); providerStopped = true;
  const restoredRoles = await request(`/api/groups/${groupId}/members`, "ada", "PUT", { requestId: randomUUID(), expectedVersion: afterRestart.group.version,
    members: [{ userId: ben.id, permission: "write" }, { userId: cy.id, permission: "read" }] });
  assert.equal(restoredRoles.status, 202);
  await request("/api/session", "ada", "DELETE"); sessions.delete("ada");
  const freshLogin = await request("/api/session", "ada", "POST", { username: "ada", password: account.password });
  assert.equal(freshLogin.status, 200); sessions.set("ada", freshLogin.headers.get("set-cookie").split(";")[0]);
  const reloadedGroup = await json(`/api/groups/${groupId}`), reloadedProject = await json(separateAccess, "cy");
  const operationId = reloadedGroup.sync.operationId;
  assert.equal(reloadedProject.sync.operationId, operationId);
  for (const path of [`/api/groups/${groupId}/retry`, `${separateAccess}/retry`]) {
    const username = path === `${separateAccess}/retry` ? "cy" : "ada";
    assert.equal((await request(path, username, "POST", {})).status, 409);
    assert.equal((await request(path, username, "POST", { operationId: randomUUID() })).status, 409);
    assert.equal((await request(path, username, "POST", { operationId: "invalid" })).status, 400);
    assert.equal((await request(path, username, "POST", { operationId, visibility: "public" })).status, 400);
    assert.equal((await request(path, "ben", "POST", { operationId })).status, 404);
  }
  assert.equal((await request(`/api/groups/${groupId}/retry`, "cy", "POST", { operationId })).status, 404, "Project ownership cannot administer its attached group");
  const retryGroup = await request(`/api/groups/${groupId}/retry`, "ada", "POST", { operationId }); assert.equal(retryGroup.status, 202);
  assert.equal((await retryGroup.json()).group.version, reloadedGroup.group.version);
  const retryProject = await request(`${separateAccess}/retry`, "cy", "POST", { operationId }); assert.equal(retryProject.status, 202);
  const retryStatus = await retryProject.json(); assert.equal(retryStatus.version, reloadedProject.version);
  assert.deepEqual(retryStatus.sync.unconfirmedProjectIds, [separate.project.id], "Project-owner retry never exposes other affected projects");
  run(["scripts/forgejo.mjs", "up", "-d"]); providerStopped = false; await providerReady();
  const settledRetry = await request(`${separateAccess}/retry`, "cy", "POST", { operationId }); assert.equal(settledRetry.status, 200);
  assert.equal((await settledRetry.json()).version, reloadedProject.version);
  const settledGroup = await json(`/api/groups/${groupId}`); assert.equal(settledGroup.group.version, reloadedGroup.group.version); assert.equal(settledGroup.sync.state, "ready");
  assert.equal((await json(`/api/projects/${project.project.id}`, "ben")).project.permission, "write");
  git("ben", ["push", "origin", "main"], writer);
  for (const [path, username] of [[`/api/groups/${groupId}/retry`, "ada"], [`${separateAccess}/retry`, "cy"]]) {
    const completed = await request(path, username, "POST", { operationId }); assert.equal(completed.status, 409);
    assert.equal((await completed.json()).error.code, "stale_access_operation");
  }
  const detachedSeparate = await request(separateAccess, "cy", "PUT", { requestId: randomUUID(), expectedVersion: reloadedProject.version, visibility: "private", groupId: null }); assert.equal(detachedSeparate.status, 200);
  policy = await json(accessPath);
  assert.equal((await request(accessPath, "ada", "PUT", { requestId: randomUUID(), expectedVersion: policy.version, visibility: "public", groupId })).status, 400);
  const publicized = await request(accessPath, "ada", "PUT", { requestId: randomUUID(), expectedVersion: policy.version, visibility: "public", groupId, confirmPublic: true }); assert.equal(publicized.status, 200);
  assert.equal((await request(`/api/projects/${project.project.id}`, "anonymous")).status, 200);
  policy = await json(accessPath);
  const detached = await request(accessPath, "ada", "PUT", { requestId: randomUUID(), expectedVersion: policy.version, visibility: "private", groupId: null }); assert.equal(detached.status, 200);
  assert.equal((await request(`/api/projects/${project.project.id}`, "ben")).status, 404);
  assert.equal(git("ben", ["ls-remote", remote], directory, true).ok, false);
  console.log("Actual group HTTP/Git roles, outage/startup and fresh-session operation-ID retry, denial/no-version/disclosure checks, bootstrap persistence and visibility/detach passed");
} finally {
  if (providerStopped) { run(["scripts/forgejo.mjs", "up", "-d"]); await providerReady(); }
  if (!child && groupId) await start();
  if (originalMembers && sessions.has("ada")) await replaceMembers(originalMembers);
  for (const username of sessions.keys()) await request("/api/session", username, "DELETE").catch(() => {});
  await stop(); rmSync(directory, { recursive: true, force: true });
  if (grantId) {
    const db = new DatabaseSync(join(stateDir, "lab.sqlite"));
    try { db.prepare("DELETE FROM agent_project_scopes WHERE grant_id=?").run(grantId); db.prepare("DELETE FROM agent_grants WHERE id=?").run(grantId); }
    finally { db.close(); }
  }
}

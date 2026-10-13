import { test, expect } from "@playwright/test";
import { readFileSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { config, stateDir, instance } from "../scripts/config.mjs";

if (!instance.startsWith("test-")) throw new Error("Use an isolated test instance");
const settings = config();
const accounts = JSON.parse(readFileSync(resolve(stateDir, "credentials.json"), "utf8"));
const owner = accounts.users.find((user: { username: string }) => user.username === "ada");
const headers = { Origin: settings.appOrigin };

test("private durable draft CAS, library overlay, Git conflicts and retried version saves", async ({ request, playwright }) => {
  test.setTimeout(90_000);
  expect((await request.post("/api/session", { headers, data: owner })).ok()).toBe(true);
  async function create(templateId: string) {
    const response = await request.post("/api/projects", { headers, data: { requestId: randomUUID(), templateId, title: `Draft API ${randomUUID()}`, visibility: "public" } });
    expect(response.status(), await response.text()).toBe(201);
    return response.json();
  }
  const model = await create("commons");
  const library = await create("library-js");
  const path = `/api/projects/${model.project.id}`;
  const initial = { expectedVersion: 0, ref: model.ref, baseCommit: model.commit, changes: [{ operation: "create", path: "notes.txt", content: "Keep this draft\n" }] };
  const firstResponse = await request.put(`${path}/draft`, { headers, data: initial });
  expect(firstResponse.status(), await firstResponse.text()).toBe(200);
  const first = (await firstResponse.json()).draft;
  const competing = await request.put(`${path}/draft`, { headers, data: { ...initial, changes: [] } });
  expect(competing.status()).toBe(409);
  expect((await competing.json()).error.code).toBe("stale_draft");
  // A separate HTTP client sees the persisted draft; public readers do not.
  const second = await playwright.request.newContext({ baseURL: settings.appOrigin });
  try {
    expect((await second.get(`${path}/draft`)).status()).toBe(401);
    await second.post("/api/session", { headers, data: owner });
    expect((await (await second.get(`${path}/draft`)).json()).draft).toEqual(first);
  } finally { await second.dispose(); }
  const database = new DatabaseSync(resolve(stateDir, "lab.sqlite"));
  try {
    const stored = database.prepare("SELECT changes FROM project_drafts WHERE project_id=?").get(model.project.id) as { changes: string };
    expect(JSON.parse(stored.changes)).toEqual(initial.changes);
  } finally { database.close(); }
  const install = await request.post(`${path}/draft/libraries`, { headers, data: {
    expectedVersion: first.version, ref: model.ref, expectedCommit: model.commit, message: "Use a library",
    libraryId: library.project.id, commit: library.commit, paths: ["library.js", "LICENSE"], directory: "vendor/tool",
  } });
  expect(install.status(), await install.text()).toBe(200);
  const installed = (await install.json()).draft;
  expect(installed.changes.some((file: { path: string }) => file.path === "notes.txt")).toBe(true);
  expect(installed.changes.some((file: { path: string }) => file.path === "vendor/tool/library.js")).toBe(true);
  expect((await (await request.get(`${path}/tree?ref=main`)).json()).commit).toBe(model.commit);
  expect((await (await request.get(`${path}/libraries?draft=1`)).json()).libraries[0].project.id).toBe(library.project.id);
  expect((await (await request.get(`${path}/libraries?commit=${model.commit}`)).json()).libraries).toEqual([]);
  const save = await request.post(`${path}/draft/save`, { headers, data: { expectedVersion: installed.version, message: "Save model and dependency" } });
  expect(save.status(), await save.text()).toBe(201);
  const saved = await save.json();
  const retry = await request.post(`${path}/draft/save`, { headers, data: { expectedVersion: installed.version } });
  expect(retry.status(), await retry.text()).toBe(200);
  expect((await retry.json()).commit).toBe(saved.commit);
  const history = (await (await request.get(`${path}/history?commit=${saved.commit}`)).json()).commits;
  expect(history).toHaveLength(2);
  expect(history[0].parents).toEqual([model.commit]);
  expect((await (await request.get(`${path}/file?commit=${saved.commit}&path=notes.txt`)).json()).content).toBe("Keep this draft\n");
  expect(saved.draft.changes).toEqual([]);

  const next = await request.put(`${path}/draft`, { headers, data: { expectedVersion: saved.draft.version, ref: model.ref, baseCommit: saved.commit, changes: [{ operation: "update", path: "notes.txt", content: "New browser work\n" }] } });
  const edited = (await next.json()).draft;
  const external = await request.post(`${path}/commits`, { headers, data: { ref: model.ref, expectedCommit: saved.commit, message: "Agent pushed separately", changes: [{ operation: "create", path: "agent.txt", content: "External work\n" }] } });
  expect(external.status(), await external.text()).toBe(201);
  const externalCommit = (await external.json()).commit;
  const conflict = await request.post(`${path}/draft/save`, { headers, data: { expectedVersion: edited.version } });
  expect(conflict.status()).toBe(409);
  expect((await conflict.json()).error.currentCommit).toBe(externalCommit);
  const preserved = (await (await request.get(`${path}/draft`)).json()).draft;
  expect(preserved.changes).toEqual(edited.changes);
  expect(preserved.baseCommit).toBe(saved.commit);
  expect(preserved.savingCommit).toBe(null);
  // Deliberately reconcile on the caller's behalf; CAS prevents an intervening overwrite.
  const reconciled = await request.put(`${path}/draft`, { headers, data: { expectedVersion: preserved.version, ref: model.ref, baseCommit: externalCommit, changes: preserved.changes } });
  expect(reconciled.ok()).toBe(true);
  const final = await request.post(`${path}/draft/save`, { headers, data: { expectedVersion: (await reconciled.json()).draft.version } });
  expect(final.status(), await final.text()).toBe(201);
  const finalCommit = (await final.json()).commit;
  expect((await (await request.get(`${path}/file?commit=${finalCommit}&path=agent.txt`)).json()).content).toBe("External work\n");
  expect((await (await request.get(`${path}/file?commit=${finalCommit}&path=notes.txt`)).json()).content).toBe("New browser work\n");
});

test("a persisted pending version recovers an accepted Git push without duplicating history", async ({ request }) => {
  test.setTimeout(60_000);
  await request.post("/api/session", { headers, data: owner });
  const response = await request.post("/api/projects", { headers, data: { requestId: randomUUID(), templateId: "worker", title: "Interrupted draft save", visibility: "private" } });
  expect(response.status()).toBe(201);
  const model = await response.json();
  const path = `/api/projects/${model.project.id}`;
  const changes = [{ operation: "create", path: "recover.txt", content: "An accepted version\n" }];
  const draft = (await (await request.put(`${path}/draft`, { headers, data: { expectedVersion: 0, ref: model.ref, baseCommit: model.commit, changes } })).json()).draft;
  const accepted = await request.post(`${path}/commits`, { headers, data: { ref: model.ref, expectedCommit: model.commit, message: "Interrupted save", changes } });
  expect(accepted.status()).toBe(201);
  const commit = (await accepted.json()).commit;
  const directory = mkdtempSync(resolve(stateDir, "pending-save-"));
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${owner.username}:${owner.password}`).toString("base64")}` };
  try {
    execFileSync("git", ["clone", "--bare", "--quiet", `${settings.forgejoUrl}/${model.project.forgejoOwner}/${model.project.forgejoRepo}.git`, directory], { env, stdio: ["ignore", "pipe", "pipe"] });
    // Reproduce the durable boundary after push but before SQLite acknowledgement.
    const database = new DatabaseSync(resolve(stateDir, "lab.sqlite"));
    database.prepare("UPDATE project_drafts SET saving_commit=?,saving_directory=? WHERE project_id=?").run(commit, directory, model.project.id);
    database.close();
    expect((await (await request.get(`${path}/draft`)).json()).draft.savingCommit).toBe(commit);
    expect((await request.put(`${path}/draft`, { headers, data: { expectedVersion: draft.version, ref: model.ref, baseCommit: model.commit, changes: [] } })).status()).toBe(409);
    const recovered = await request.post(`${path}/draft/save`, { headers, data: { expectedVersion: draft.version } });
    expect(recovered.status(), await recovered.text()).toBe(201);
    const result = await recovered.json();
    expect(result.commit).toBe(commit);
    expect(result.draft.changes).toEqual([]);
    expect(result.draft.savingCommit).toBe(null);
    expect((await (await request.get(`${path}/history?commit=${commit}`)).json()).commits).toHaveLength(2);
    expect(existsSync(directory)).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

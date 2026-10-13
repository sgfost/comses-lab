import { test, expect } from "@playwright/test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { config, stateDir, instance } from "../scripts/config.mjs";
import type { CreateProjectResponse } from "../shared/contracts.ts";
const settings = config();
if (!instance.startsWith("test-")) throw new Error("Isolated test instance required");
const accounts = JSON.parse(readFileSync(resolve(stateDir, "credentials.json"), "utf8"));
const owner = accounts.users.find((user: { username: string }) => user.username === "ada");
const database = new DatabaseSync(resolve(stateDir, "lab.sqlite"));
const created: CreateProjectResponse[] = [];
const environment = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader",
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${owner.username}:${owner.password}`).toString("base64")}` };
test.afterAll(async () => {
  for (const { project } of created) {
    database.prepare("DELETE FROM project_metadata WHERE project_id=?").run(project.id);
    database.prepare("DELETE FROM project_access WHERE project_id=?").run(project.id);
    database.prepare("DELETE FROM project_provisions WHERE project_id=?").run(project.id);
  }
  // Remove children before parents because derivations intentionally retain their source ID.
  for (const { project } of created.reverse()) {
    database.prepare("DELETE FROM projects WHERE id=?").run(project.id);
    await fetch(`${settings.forgejoUrl}/api/v1/repos/${project.forgejoOwner}/${project.forgejoRepo}`, { method: "DELETE", headers: { Authorization: environment.GIT_CONFIG_VALUE_0.replace("Authorization: ", "") } });
  }
  database.close();
});
test("real HTTP/Git authoring, exact forks, leases, permissions and metadata CAS", async ({ request, playwright }) => {
  const login = await request.post("/api/session", { headers: { Origin: settings.appOrigin }, data: owner });
  expect(login.status()).toBe(200);
  const headers = { Origin: settings.appOrigin };
  const templates = await request.get("/api/templates");
  expect((await templates.json()).templates.map((template: { id: string }) => template.id)).toEqual(["commons", "worker", "python", "netlogo", "library-python", "library-js"]);
  const intent = { requestId: randomUUID(), templateId: "commons", title: "Authoring fixture", visibility: "private" };
  const response = await request.post("/api/projects", { headers, data: intent });
  expect(response.status(), await response.text()).toBe(201);
  const original = await response.json() as CreateProjectResponse;
  created.push(original);
  expect(original.project.permission).toBe("admin");
  expect(original.project.metadataVersion).toBe(1);
  const replay = await request.post("/api/projects", { headers, data: intent });
  expect(replay.status()).toBe(200);
  expect((await replay.json()).project.id).toBe(original.project.id);
  expect((await request.post("/api/projects", { headers, data: { ...intent, title: "Changed intent" } })).status()).toBe(409);
  const clone = mkdtempSync(resolve(stateDir, "authoring-clone-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", clone, ...args], { env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("clone", `${settings.forgejoUrl}/${original.project.forgejoOwner}/${original.project.forgejoRepo}.git`, ".");
    expect(git("rev-parse", "HEAD")).toBe(original.commit);
    const save = { ref: "refs/heads/main", expectedCommit: original.commit, message: "Edit several files", changes: [
      { operation: "create", path: "notes.txt", content: "Independent source fixture\n" },
      { operation: "update", path: "README.md", content: "# Edited garden\n" },
      { operation: "delete", path: "ecology.js" },
    ] };
    const saved = await request.post(`/api/projects/${original.project.id}/commits`, { headers, data: save });
    expect(saved.status(), await saved.text()).toBe(201);
    const head = (await saved.json()).commit;
    git("fetch", "origin");
    expect(git("rev-list", "--parents", "-n", "1", head)).toBe(`${head} ${original.commit}`);
    expect(git("show", `${head}:notes.txt`)).toBe("Independent source fixture");
    expect(git("show", `${head}:README.md`)).toBe("# Edited garden");
    expect(git("ls-tree", "-r", "--name-only", head).split("\n")).not.toContain("ecology.js");
    const stale = await request.post(`/api/projects/${original.project.id}/commits`, { headers, data: save });
    expect(stale.status()).toBe(409);
    expect((await stale.json()).error.currentCommit).toBe(head);
    // A lease must reject rewind and deletion, not just ordinary advancement.
    git("push", "origin", `${head}:refs/heads/race`);
    for (const mutation of ["rewind", "delete"] as const) {
      git("push", "--force", "origin", mutation === "rewind" ? `${original.commit}:refs/heads/race` : ":refs/heads/race");
      const rejected = await request.post(`/api/projects/${original.project.id}/commits`, { headers, data: { ...save, ref: "refs/heads/race", expectedCommit: head, changes: [{ operation: "create", path: "race.txt", content: "Must not land" }] } });
      expect(rejected.status(), await rejected.text()).toBe(409);
      expect((await rejected.json()).error.currentCommit).toBe(mutation === "rewind" ? original.commit : null);
      git("push", "--force", "origin", `${head}:refs/heads/race`);
    }
    for (let experiment = 0; experiment < 2; experiment++) {
      const fork = await request.post(`/api/projects/${original.project.id}/forks`, { headers, data: { requestId: randomUUID(), commit: original.commit, title: `Experiment ${experiment}`, visibility: "private" } });
      expect(fork.status(), await fork.text()).toBe(201);
      const result = await fork.json() as CreateProjectResponse;
      created.push(result);
      expect(result.commit).toBe(original.commit);
      expect(result.project.dataOrigins).toEqual([]);
      expect(result.project.forkedFrom).toEqual({ projectId: original.project.id, commit: original.commit });
      expect(git("ls-remote", `${settings.forgejoUrl}/${result.project.forgejoOwner}/${result.project.forgejoRepo}.git`, "refs/heads/main").split("\t")[0]).toBe(original.commit);
    }
    const forbidden = await request.post(`/api/projects/${original.project.id}/forks`, { headers, data: { requestId: randomUUID(), commit: original.commit, title: "Cannot publicize", visibility: "public" } });
    expect(forbidden.status()).toBe(400);
    const updated = await request.patch(`/api/projects/${original.project.id}`, { headers, data: { expectedMetadataVersion: 1, title: "Renamed experiment", dataOrigins: ["https://example.org"] } });
    expect(updated.status(), await updated.text()).toBe(200);
    expect((await updated.json()).project.metadataVersion).toBe(2);
    const metadataConflict = await request.patch(`/api/projects/${original.project.id}`, { headers, data: { expectedMetadataVersion: 1, title: "Stale name" } });
    expect(metadataConflict.status()).toBe(409);
    expect((await metadataConflict.json()).error.currentMetadataVersion).toBe(2);
    const outsider = await playwright.request.newContext({ baseURL: settings.appOrigin });
    try {
      expect((await outsider.get(`/api/projects/${original.project.id}`)).status()).toBe(404);
      expect((await outsider.post(`/api/projects/${original.project.id}/commits`, { headers, data: save })).status()).toBe(401);
    } finally { await outsider.dispose(); }
  } finally { rmSync(clone, { recursive: true, force: true }); }
});

test("fresh Python create and fork immediately expose exact source and launch bytes", async ({ request }) => {
  const headers = { Origin: settings.appOrigin };
  expect((await request.post("/api/session", { headers, data: owner })).status()).toBe(200);
  const expected = readFileSync(new URL("../examples/python/model.py", import.meta.url), "utf8");
  const response = await request.post("/api/projects", { headers, data: { requestId: randomUUID(), templateId: "python", title: "Immediate Python source", visibility: "private" } });
  expect(response.status()).toBe(201);
  const original = await response.json() as CreateProjectResponse;
  created.push(original);
  async function inspectAndLaunch(target: CreateProjectResponse) {
    const refs = await request.get(`/api/projects/${target.project.id}/refs`, { params: { kind: "branch", page: 1, limit: 25 } });
    expect(refs.status()).toBe(200);
    expect((await refs.json()).refs).toContainEqual({ name: "main", ref: "refs/heads/main", commit: target.commit });
    await Promise.all(Array.from({ length: 5 }, async () => {
      const file = await request.get(`/api/projects/${target.project.id}/file`, { params: { commit: target.commit, path: "model.py" } });
      expect(file.status()).toBe(200);
      expect((await file.json()).content).toBe(expected);
    }));
    const launched = await request.post(`/api/projects/${target.project.id}/launch`, { headers, data: { commit: target.commit } });
    expect(launched.status()).toBe(200);
    const launch = await launched.json();
    const model = await request.get(new URL("model.py", launch.url).href);
    expect(model.status()).toBe(200);
    expect(await model.text()).toBe(expected);
    expect((await request.delete(`/api/launches/${launch.id}`, { headers, data: {} })).status()).toBe(200);
  }
  await inspectAndLaunch(original);
  const forkResponse = await request.post(`/api/projects/${original.project.id}/forks`, { headers, data: { requestId: randomUUID(), commit: original.commit, title: "Immediate Python fork", visibility: "private" } });
  expect(forkResponse.status()).toBe(201);
  const fork = await forkResponse.json() as CreateProjectResponse;
  created.push(fork);
  await inspectAndLaunch(fork);
});

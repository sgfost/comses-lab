import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { config, stateDir } from "../scripts/config.mjs";
import type { GroupResponse, Group, Project, ProjectAccessResponse } from "../shared/contracts.js";
const settings = config();
let fixtureProjectIds: string[] = [];
let fixtureGroupId = "";
let users: { username: string; password: string }[];
function credentials() { return users ??= JSON.parse(readFileSync(resolve(stateDir, "credentials.json"), "utf8")).users; }
async function login(page: Page, username = "ada") {
  const user = credentials().find(user => user.username === username)!;
  expect((await page.request.post("/api/session", { headers: { Origin: settings.appOrigin }, data: user })).status()).toBe(200);
}
async function fixture(page: Page) {
  await login(page);
  const response = await page.request.post("/api/projects", { headers: { Origin: settings.appOrigin }, data: { requestId: randomUUID(), title: `Group UI ${randomUUID().slice(0, 8)}`, templateId: "commons", visibility: "private" } });
  expect(response.status()).toBe(201);
  const project: Project = (await response.json()).project;
  fixtureProjectIds.push(project.id);
  const groups: Group[] = (await (await page.request.get("/api/groups")).json()).groups;
  const group = groups.find(group => group.permission === "admin")!;
  fixtureGroupId = group.id;
  let groupState: GroupResponse = await (await page.request.get(`/api/groups/${group.id}`)).json();
  if (groupState.sync.state === "pending") {
    const recovery = await page.request.post(`/api/groups/${group.id}/retry`, { headers: { Origin: settings.appOrigin }, data: { operationId: groupState.sync.operationId }, timeout: 120000 });
    expect([200, 409]).toContain(recovery.status());
    groupState = await (await page.request.get(`/api/groups/${group.id}`)).json();
    expect(groupState.sync.state).toBe("ready");
  }
  await page.goto(`/#/project/${project.id}?edit=1`);
  await expect(page.getByLabel("Source code", { exact: true })).toHaveAttribute("aria-readonly", "false");
  await page.getByRole("button", { name: "About artifact", exact: true }).click();
  await expect(page.getByRole("region", { name: "Artifact access" })).toBeVisible();
  return { project, group };
}
async function saveAccess(page: Page) {
  const response = page.waitForResponse(response => response.url().endsWith("/access") && response.request().method() === "PUT");
  await page.getByRole("button", { name: "Save access", exact: true }).click();
  return response;
}
async function saveMembers(page: Page) {
  const started = Date.now();
  const response = page.waitForResponse(response => response.url().endsWith("/members") && response.request().method() === "PUT");
  await page.getByRole("button", { name: "Save members", exact: true }).click();
  const result = await response;
  console.log(`Member update HTTP ${result.status()}: ${Date.now() - started}ms`);
  return result;
}

test.beforeEach(() => { fixtureProjectIds = []; fixtureGroupId = ""; });
test.afterEach(async ({ page }) => {
  test.setTimeout(120000);
  await login(page);
  for (const id of fixtureProjectIds) {
    let access: ProjectAccessResponse = await (await page.request.get(`/api/projects/${id}/access`)).json();
    if (access.sync.state === "pending") {
      const retry = await page.request.post(`/api/projects/${id}/access/retry`, { headers: { Origin: settings.appOrigin }, timeout: 120000, data: { operationId: access.sync.operationId } });
      expect([200, 409]).toContain(retry.status());
      access = await (await page.request.get(`/api/projects/${id}/access`)).json();
    }
    expect(access.sync.state).toBe("ready");
    if (access.effective.groupId) {
      const detached = await page.request.put(`/api/projects/${id}/access`, { headers: { Origin: settings.appOrigin }, timeout: 120000, data: { requestId: randomUUID(), expectedVersion: access.version, visibility: access.effective.visibility, groupId: null } });
      expect(detached.status()).toBe(200);
    }
    console.log(`Retained fixture ${id}; group detached`);
  }
  if (fixtureGroupId) {
    const db = new DatabaseSync(resolve(stateDir, "lab.sqlite"), { readOnly: true });
    try {
      const row = db.prepare("SELECT count(*) AS count FROM project_access WHERE group_id=?").get(fixtureGroupId);
      console.log(`Group affected repositories after fixture cleanup: ${row?.count}`);
    } finally { db.close(); }
  }
});

test("attach group, writer saves, reader sees no admin controls, private source stays hidden", async ({ page, browser }) => {
  test.setTimeout(120000);
  const { project, group } = await fixture(page);
  const original: GroupResponse = await (await page.request.get(`/api/groups/${group.id}`)).json();
  const matrix = original.members.filter(member => member.username !== "dee").map(member => ({ userId: member.userId, permission: member.username === "ben" ? "write" : member.username === "cy" ? "read" : member.permission }));
  expect((await page.request.put(`/api/groups/${group.id}/members`, { headers: { Origin: settings.appOrigin }, timeout: 120000, data: { requestId: randomUUID(), expectedVersion: original.group.version, members: matrix } })).status()).toBe(200);
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await page.getByRole("button", { name: "Reload access form", exact: true }).click();
  await page.getByLabel("Artifact group", { exact: true }).selectOption(group.id);
  expect((await saveAccess(page)).status()).toBe(200);
  await expect(page.getByRole("region", { name: "Artifact access" })).toContainText("Research group");
  for (const [username, permission] of [["ben", "write"], ["cy", "read"], ["dee", "none"]]) {
    const context = await browser.newContext({ baseURL: settings.appOrigin });
    try {
      const member = await context.newPage();
      await login(member, username);
      await member.goto(`/#/project/${project.id}?edit=1`);
      if (permission === "none") {
        await expect(member.locator(".app-shell > [role=alert]")).toBeVisible();
        await expect(member.locator(".app-shell")).not.toContainText(project.title);
        expect((await member.request.get(`/api/projects/${project.id}`)).status()).toBe(404);
        continue;
      }
      await expect(member.getByLabel("Source code", { exact: true })).toHaveAttribute("aria-readonly", permission === "write" ? "false" : "true");
      await member.getByRole("button", { name: "About artifact", exact: true }).click();
      await expect(member.getByRole("region", { name: "Artifact access" })).toHaveCount(0);
      await expect(member.getByRole("button", { name: "Edit metadata", exact: true })).toHaveCount(0);
      if (permission === "write") {
        await member.getByRole("button", { name: "Files", exact: true }).click();
        await member.getByLabel("New file path", { exact: true }).fill("writer.txt");
        await member.getByRole("button", { name: "Create", exact: true }).click();
        await member.getByLabel("Source code", { exact: true }).click();
        await member.keyboard.insertText("Written by Ben");
        await member.getByLabel("What changed?", { exact: true }).fill("Add writer file");
        const response = member.waitForResponse(response => response.url().endsWith("/draft/save"));
        await member.getByRole("button", { name: "Save version", exact: true }).click();
        expect((await response).status()).toBe(201);
      } else {
        await member.getByRole("button", { name: "Groups", exact: true }).click();
        await expect(member.getByRole("dialog", { name: "Groups", exact: true })).toContainText("read");
        await expect(member.getByRole("button", { name: "Save members", exact: true })).toHaveCount(0);
      }
    } finally { await context.close(); }
  }
  const latest = await (await page.request.get(`/api/projects/${project.id}/tree`)).json();
  expect((await (await page.request.get(`/api/projects/${project.id}/file?commit=${latest.commit}&path=writer.txt`)).json()).content).toBe("Written by Ben");
  await page.getByLabel("Artifact visibility", { exact: true }).selectOption("public");
  await expect(page.getByRole("button", { name: "Save access", exact: true })).toBeDisabled();
  await page.getByLabel("Make all Git history public", { exact: true }).check();
  expect((await saveAccess(page)).status()).toBe(200);
  const anonymous = await browser.newContext({ baseURL: settings.appOrigin });
  try { expect((await anonymous.request.get(`/api/projects/${project.id}`)).status()).toBe(200); }
  finally { await anonymous.close(); }
  await page.getByLabel("Artifact visibility", { exact: true }).selectOption("private");
  expect((await saveAccess(page)).status()).toBe(200);
  await page.screenshot({ path: "test-results/access-owner-light.png" });
  const latestGroup: GroupResponse = await (await page.request.get(`/api/groups/${group.id}`)).json();
  expect((await page.request.put(`/api/groups/${group.id}/members`, { headers: { Origin: settings.appOrigin }, timeout: 120000, data: { requestId: randomUUID(), expectedVersion: latestGroup.group.version, members: original.members.map(({ userId, permission }) => ({ userId, permission })) } })).status()).toBe(200);
});

test("member candidates support role changes, removal and re-add; CAS conflicts retain form", async ({ page }) => {
  test.setTimeout(120000);
  const { project, group } = await fixture(page);
  const initial: GroupResponse = await (await page.request.get(`/api/groups/${group.id}`)).json();
  await page.getByRole("button", { name: "Groups", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Groups", exact: true });
  const oldPermission = initial.members.find(member => member.username === "ben")!.permission;
  const targetPermission = oldPermission === "write" ? "read" : "write";
  await expect(dialog.getByLabel("Permission for ben", { exact: true })).toHaveValue(oldPermission);
  await dialog.getByLabel("Permission for ben", { exact: true }).selectOption(targetPermission);
  const candidates = (await (await page.request.get(`/api/groups/${group.id}/candidates`)).json()).users;
  const dee = candidates.find((user: { username: string }) => user.username === "dee");
  const competing = await page.request.put(`/api/groups/${group.id}/members`, { headers: { Origin: settings.appOrigin }, timeout: 120000, data: { requestId: randomUUID(), expectedVersion: initial.group.version, members: initial.members.some(member => member.userId === dee.id) ? initial.members.filter(member => member.userId !== dee.id).map(({ userId, permission }) => ({ userId, permission })) : [...initial.members.map(({ userId, permission }) => ({ userId, permission })), { userId: dee.id, permission: "read" }] } });
  expect(competing.status()).toBe(200);
  expect((await saveMembers(page)).status()).toBe(409);
  await expect(dialog.getByLabel("Permission for ben", { exact: true })).toHaveValue(targetPermission);
  await dialog.getByRole("button", { name: "Refresh group status", exact: true }).click();
  await expect(dialog.getByLabel("Permission for ben", { exact: true })).toHaveValue(targetPermission);
  await dialog.getByRole("button", { name: "Reload member form", exact: true }).click();
  await dialog.getByLabel("Permission for ben", { exact: true }).selectOption(targetPermission);
  expect((await saveMembers(page)).status()).toBe(200);
  if (!(await dialog.getByRole("button", { name: "Remove dee", exact: true }).count())) {
    await dialog.getByLabel("Add group member", { exact: true }).selectOption(dee.id);
    await dialog.getByRole("button", { name: "Add member", exact: true }).click();
    expect((await saveMembers(page)).status()).toBe(200);
  }
  await dialog.getByRole("button", { name: "Remove dee", exact: true }).click();
  expect((await saveMembers(page)).status()).toBe(200);
  await dialog.getByLabel("Add group member", { exact: true }).selectOption(dee.id);
  await dialog.getByRole("button", { name: "Add member", exact: true }).click();
  await expect(dialog.getByLabel("Permission for dee", { exact: true })).toHaveValue("read");
  expect((await saveMembers(page)).status()).toBe(200);
  await dialog.getByRole("button", { name: "Close groups", exact: true }).click();
  const current: GroupResponse = await (await page.request.get(`/api/groups/${group.id}`)).json();
  expect((await page.request.put(`/api/groups/${group.id}/members`, { headers: { Origin: settings.appOrigin }, timeout: 120000, data: { requestId: randomUUID(), expectedVersion: current.group.version, members: initial.members.map(({ userId, permission }) => ({ userId, permission })) } })).status()).toBe(200);
  const status: ProjectAccessResponse = await (await page.request.get(`/api/projects/${project.id}/access`)).json();
  await page.getByLabel("Artifact group", { exact: true }).selectOption(group.id);
  const outOfBand = await page.request.put(`/api/projects/${project.id}/access`, { headers: { Origin: settings.appOrigin }, data: { requestId: randomUUID(), expectedVersion: status.version, visibility: "public", groupId: null, confirmPublic: true } });
  expect(outOfBand.status()).toBe(200);
  expect((await saveAccess(page)).status()).toBe(409);
  await expect(page.getByLabel("Artifact group", { exact: true })).toHaveValue(group.id);
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(page.getByLabel("Artifact group", { exact: true })).toHaveValue(group.id);
});


test("provider outage shows pending owner read-only and reload can retry the accepted intent", async ({ page }) => {
  test.setTimeout(120000);
  const { project, group } = await fixture(page);
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByLabel("New file path", { exact: true }).fill("pending-draft.txt");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByLabel("Source code", { exact: true }).click();
  await page.keyboard.insertText("Draft retained while Git access is unconfirmed");
  await page.getByRole("button", { name: "About artifact", exact: true }).click();
  await page.getByLabel("Artifact group", { exact: true }).selectOption(group.id);
  let providerStopped = false;
  try {
    execFileSync(process.execPath, ["scripts/forgejo.mjs", "stop"], { stdio: "pipe" });
    providerStopped = true;
    const response = await saveAccess(page);
    expect(response.status()).toBe(202);
    const accepted: ProjectAccessResponse = await response.json();
    expect(accepted.sync.state).toBe("pending");
    await expect(page.getByRole("region", { name: "Artifact access" })).toContainText("Confirmed: private · Group: None");
    await expect(page.getByRole("region", { name: "Artifact access" })).toContainText("Pending: private · Group: Research group");
    await expect(page.getByRole("region", { name: "Artifact access" })).toContainText("Direct Git access is unconfirmed");
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await expect(page.getByLabel("Source code", { exact: true })).toHaveAttribute("aria-readonly", "true");
    await expect(page.getByLabel("Source code", { exact: true })).toContainText("Draft retained");
    await expect(page.locator(".workspace-actions .launch-button")).toBeDisabled();
    page.on("dialog", dialog => dialog.accept());
    await page.reload();
    await page.getByRole("button", { name: "About artifact", exact: true }).click();
    await expect(page.getByRole("button", { name: "Retry access change", exact: true })).toBeVisible();
    execFileSync(process.execPath, ["scripts/forgejo.mjs", "up", "-d"], { stdio: "pipe" });
    providerStopped = false;
    await expect.poll(async () => {
      try { return (await page.request.get(settings.forgejoUrl)).status(); } catch { return 0; }
    }, { timeout: 30000 }).toBe(200);
    const retry = page.waitForResponse(response => response.url().endsWith("/access/retry") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Retry access change", exact: true }).click();
    const result = await retry;
    expect(result.status()).toBe(200);
    expect(result.request().postDataJSON()).toEqual({ operationId: accepted.sync.state === "pending" ? accepted.sync.operationId : "" });
    await expect(page.getByRole("region", { name: "Artifact access" })).toContainText("Confirmed: private · Group: Research group");
    await expect(page.getByRole("button", { name: "Retry access change", exact: true })).toHaveCount(0);
    const settled: ProjectAccessResponse = await (await page.request.get(`/api/projects/${project.id}/access`)).json();
    expect(settled.sync.state).toBe("ready");
    expect(settled.effective.mode).toBe("normal");
    expect(settled.version).toBe(accepted.version);
  } finally {
    if (providerStopped) execFileSync(process.execPath, ["scripts/forgejo.mjs", "up", "-d"], { stdio: "pipe" });
  }
});

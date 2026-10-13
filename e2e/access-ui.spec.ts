import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config, stateDir } from "../scripts/config.mjs";
import type { Project, Launch } from "../shared/contracts.js";
const settings = config();
const credentials = JSON.parse(readFileSync(resolve(stateDir, "credentials.json"), "utf8"));
const owner = credentials.users.find((user: { username: string }) => user.username === "ada");
async function openModel(page: Page) {
  expect((await page.request.post("/api/session", { headers: { Origin: settings.appOrigin }, data: { username: owner.username, password: owner.password } })).ok()).toBe(true);
  const projects: Project[] = (await (await page.request.get("/api/projects")).json()).projects;
  const project = projects.find(project => project.forgejoRepo === "random-walks")!;
  await page.goto(`/#/project/${project.id}?edit=1`);
  await expect(page.getByLabel("Source code", { exact: true })).toHaveAttribute("aria-readonly", "false");
  // Access tests control launch timing and keep drafts separate from the active run.
  await expect(page.frameLocator("iframe").locator("#status")).toHaveText("Ready");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator("iframe")).toHaveCount(0);
  return project;
}
async function runModel(page: Page) {
  const response = page.waitForResponse(response => response.url().endsWith("/launch") && response.request().method() === "POST");
  await page.locator(".workspace-actions .launch-button").click();
  const result = await response;
  expect(result.status()).toBe(200);
  const launch: Launch = await result.json();
  await expect(page.frameLocator("iframe").locator("#status")).toHaveText("Ready");
  return launch;
}
async function editOrigins(page: Page, value: string) {
  await page.getByRole("button", { name: "About artifact", exact: true }).click();
  await page.getByRole("button", { name: "Edit metadata", exact: true }).click();
  await page.locator(".metadata-form").getByLabel("Data origins", { exact: true }).fill(value);
}
async function saveMetadata(page: Page) {
  const response = page.waitForResponse(response => /\/api\/projects\/[^/]+$/.test(response.url()) && response.request().method() === "PATCH");
  await page.getByRole("button", { name: "Save metadata", exact: true }).click();
  return response;
}

test("data-origin CAS controls preserve drafts and narrowing stops the running preview", async ({ page }) => {
  const project = await openModel(page);
  const original = project.dataOrigins;
  const addedOrigin = `https://${randomUUID()}.example.org`;
  const initialLaunch = await runModel(page);
  const draftPath = `access-draft-${randomUUID()}.txt`;
  await page.getByLabel("New file path", { exact: true }).fill(draftPath);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const editor = page.getByLabel("Source code", { exact: true });
  await expect(page.getByRole("tab").filter({ hasText: draftPath })).toHaveAttribute("aria-selected", "true");
  await editor.click();
  await page.keyboard.insertText("Preserve this draft");
  await editOrigins(page, `${addedOrigin}/path`);
  expect((await saveMetadata(page)).status()).toBe(400);
  await expect(page.locator(".metadata-form [role=alert]")).toBeVisible();
  await expect(page.locator(".metadata-form").getByLabel("Data origins", { exact: true })).toHaveValue(`${addedOrigin}/path`);
  await page.locator(".metadata-form").getByLabel("Data origins", { exact: true }).fill([...original, addedOrigin].join("\n"));
  expect((await saveMetadata(page)).status()).toBe(200);
  expect((await page.request.get(`/api/launches/${initialLaunch.id}`)).status()).toBe(200);
  const initialResponse = await page.request.get(initialLaunch.url);
  expect(initialResponse.headers()["content-security-policy"]).not.toContain(addedOrigin);
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(editor).toContainText("Preserve this draft");
  const expanded = await runModel(page);
  const expandedResponse = await page.request.get(expanded.url);
  expect(expandedResponse.headers()["content-security-policy"]).toContain(addedOrigin);
  const closed = page.workers()[0]!.waitForEvent("close");
  await editOrigins(page, original.join("\n"));
  expect((await saveMetadata(page)).status()).toBe(200);
  await expect(page.locator("iframe")).toHaveCount(0, { timeout: 7000 });
  await closed;
  await expect(page.locator(".preview-pane [role=alert]")).toContainText("Preview access ended");
  expect((await page.request.get(`/api/launches/${expanded.id}`)).status()).toBe(404);
  expect((await page.request.get(expanded.url)).status()).toBe(404);
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(editor).toContainText("Preserve this draft");
  await expect(page.getByLabel("Unsaved files")).toContainText(draftPath);
});

test("session replacement tears down its old preview while another session keeps running", async ({ page, browser }) => {
  const other = await browser.newContext({ baseURL: settings.appOrigin });
  try {
    await openModel(page);
    const ownLaunch = await runModel(page);
    const otherPage = await other.newPage();
    await openModel(otherPage);
    const otherLaunch = await runModel(otherPage);
    const closed = page.workers()[0]!.waitForEvent("close");
    expect((await page.request.post("/api/session", { headers: { Origin: settings.appOrigin }, data: { username: owner.username, password: owner.password } })).ok()).toBe(true);
    await expect(page.locator("iframe")).toHaveCount(0, { timeout: 7000 });
    await closed;
    await expect(page.locator(".preview-pane [role=alert]")).toContainText("Preview access ended");
    expect((await page.request.get(ownLaunch.url)).status()).toBe(404);
    expect((await otherPage.request.get(`/api/launches/${otherLaunch.id}`)).status()).toBe(200);
    await otherPage.frameLocator("iframe").getByRole("button", { name: "Run", exact: true }).click();
    await expect(otherPage.frameLocator("iframe").locator("#status")).toHaveText("Mean squared displacement: 205.904");
  } finally { await other.close(); }
});

test("a delayed old launch status cannot stop a newer launch", async ({ page }) => {
  await openModel(page);
  let release!: () => void, captured!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { captured = resolve; });
  let oldId = "";
  await page.route("**/api/launches/*", async route => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (oldId) { await route.continue(); return; }
    oldId = id;
    captured();
    await gate;
    const response = await route.fetch();
    expect(response.status()).toBe(404);
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    const initial = await runModel(page);
    await started;
    expect(oldId).toBe(initial.id);
    const current = await runModel(page);
    expect(current.id).not.toBe(initial.id);
    release();
    await page.unrouteAll({ behavior: "wait" });
    await expect(page.locator("iframe")).toHaveCount(1);
    expect((await page.request.get(`/api/launches/${current.id}`)).status()).toBe(200);
    await page.frameLocator("iframe").getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.frameLocator("iframe").locator("#status")).toHaveText("Mean squared displacement: 205.904");
  } finally { release(); }
});

test("unchecked timeout stops the frame without overlapping status requests; Run retries explicitly", async ({ page }) => {
  await openModel(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let checks = 0;
  await page.route("**/api/launches/*", async route => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    checks++;
    await gate;
    const response = await route.fetch();
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await runModel(page);
    const closed = page.workers()[0]!.waitForEvent("close");
    await expect(page.locator("iframe")).toHaveCount(0, { timeout: 8000 });
    await closed;
    expect(checks).toBe(1);
    await expect(page.locator(".preview-pane [role=alert]")).toContainText("Preview connection failed");
    release();
    await page.unrouteAll({ behavior: "wait" });
    await runModel(page);
    await expect(page.locator("iframe")).toHaveCount(1);
  } finally { release(); }
});

import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config, stateDir } from "../scripts/config.mjs";
import type { Project } from "../shared/contracts.js";
const settings = config();
const credentials = JSON.parse(readFileSync(resolve(stateDir, "credentials.json"), "utf8"));
const owner = credentials.users.find((user: { username: string }) => user.username === "ada");
function git(...args: string[]) {
  return execFileSync("git", args, { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${owner.username}:${owner.password}`).toString("base64")}` } });
}
async function login(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill(owner.username);
  await page.getByLabel("Password", { exact: true }).fill(owner.password);
  await page.getByRole("dialog").getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}
async function text(page: Page, content: string) {
  const editor = page.getByLabel("Source code", { exact: true });
  await expect(editor).toHaveAttribute("aria-readonly", "false");
  await editor.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.insertText(content);
}
async function newModel(page: Page, template = "worker", visibility = "private") {
  await login(page);
  await page.getByRole("button", { name: "New artifact", exact: true }).click();
  const dialog = page.locator("dialog[open]");
  await dialog.getByLabel("Template", { exact: true }).selectOption(template);
  await dialog.getByLabel("Visibility", { exact: true }).selectOption(visibility);
  await dialog.getByLabel("Title", { exact: true }).fill(`Authoring ${randomUUID().slice(0, 8)}`);
  await dialog.getByRole("button", { name: "Create artifact", exact: true }).click();
  await expect(page.getByLabel("Source code", { exact: true })).toBeVisible();
  const id = new URL(page.url()).hash.match(/project\/([^?]+)/)![1]!;
  const project: Project = (await (await page.request.get(`/api/projects/${id}`)).json()).project;
  const clone = mkdtempSync(resolve(stateDir, "authoring-ui-"));
  git("clone", "--quiet", `${settings.forgejoUrl}/${project.forgejoOwner}/${project.forgejoRepo}.git`, clone);
  const commit = git("-C", clone, "rev-parse", "HEAD").trim();
  return { project, clone, commit };
}
async function addFile(page: Page, path: string, content: string) {
  await page.getByLabel("New file path", { exact: true }).fill(path);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByLabel("Source code", { exact: true })).toHaveText("");
  await text(page, content);
}
async function commit(page: Page, message: string, andRun = false) {
  await page.getByLabel("What changed?", { exact: true }).fill(message);
  const response = page.waitForResponse(response => response.url().endsWith("/draft/save") && response.request().method() === "POST");
  await page.getByRole("button", { name: andRun ? "Save version and run" : "Save version", exact: true }).click();
  const result = await response;
  expect(result.status()).toBe(201);
  return (await result.json()).commit as string;
}

test("create, multifile commit, continued typing, exact Git bytes and saved preview", async ({ page }) => {
  const { project, clone, commit: initial } = await newModel(page);
  await expect(page).toHaveURL(/branch=refs%2Fheads%2Fmain/);
  await addFile(page, "notes.md", "# First draft\n");
  await addFile(page, "empty.txt", "");
  await page.getByRole("treeitem", { name: "README.md", exact: false }).click();
  await page.getByRole("button", { name: "Delete file", exact: true }).click();
  await page.getByRole("treeitem", { name: "notes.md", exact: false }).click();
  await expect(page.getByLabel("Source code", { exact: true })).toContainText("First draft");
  let release!: () => void;
  let dispatched!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { dispatched = resolve; });
  await page.route(`**/api/projects/${project.id}/draft/save`, async route => {
    const response = await route.fetch();
    dispatched();
    await held;
    await route.fulfill({ response });
  });
  await page.getByLabel("What changed?", { exact: true }).fill("Add notes and empty file, remove readme");
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  await started;
  await text(page, "# Typed during commit\n");
  let releaseSource!: () => void, sourceStarted!: () => void;
  const sourceGate = new Promise<void>(resolve => { releaseSource = resolve; });
  const sourceCaptured = new Promise<void>(resolve => { sourceStarted = resolve; });
  await page.route(`**/api/projects/${project.id}/file?**`, async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") !== "walk.js" || url.searchParams.get("commit") !== initial) { await route.continue(); return; }
    const response = await route.fetch();
    sourceStarted();
    await sourceGate;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.getByRole("treeitem", { name: "walk.js", exact: false }).click();
  await sourceCaptured;
  release();
  await expect(page.getByLabel("Source code", { exact: true })).toContainText("const canvas");
  releaseSource();
  await expect(page.getByRole("button", { name: "Save version", exact: true })).toBeVisible();
  await page.unrouteAll({ behavior: "wait" });
  git("-C", clone, "fetch", "--quiet");
  const saved = git("-C", clone, "rev-parse", "origin/main").trim();
  expect(git("-C", clone, "show", "-s", "--format=%P", saved).trim()).toBe(initial);
  expect(git("-C", clone, "show", `${saved}:notes.md`)).toBe("# First draft\n");
  expect(git("-C", clone, "show", `${saved}:empty.txt`)).toBe("");
  expect(git("-C", clone, "ls-tree", "--name-only", saved)).not.toContain("README.md");
  await page.getByRole("treeitem", { name: "notes.md", exact: false }).click();
  await expect(page.getByLabel("Source code", { exact: true })).toContainText("Typed during commit");
  await expect(page.getByLabel("Unsaved files")).toContainText("notes.md");
  await page.getByRole("treeitem", { name: "walk.js", exact: false }).click();
  await text(page, readFileSync(resolve(clone, "walk.js"), "utf8").replace("Mean squared displacement:", "Saved displacement:"));
  const next = await commit(page, "Keep typing and update saved JS output", true);
  await expect(page.frameLocator("iframe").locator("#status")).toHaveText("Ready");
  await page.frameLocator("iframe").getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.frameLocator("iframe").locator("#status")).toHaveText("Saved displacement: 205.904");
  git("-C", clone, "fetch", "--quiet");
  expect(git("-C", clone, "show", "-s", "--format=%P", next).trim()).toBe(saved);
  expect(git("-C", clone, "show", `${next}:notes.md`)).toBe("# Typed during commit\n");
  await page.screenshot({ path: "test-results/authoring-light.png" });
});

test("stale and unknown saves retain drafts; exact fork and persisted navigation", async ({ page }) => {
  const { project, clone, commit: initial } = await newModel(page);
  await addFile(page, "notes.md", "browser draft\n");
  writeFileSync(resolve(clone, "agent.txt"), "remote advance\n");
  git("-C", clone, "add", "agent.txt");
  git("-C", clone, "-c", "user.name=UI acceptance", "-c", "user.email=ui@lab.invalid", "commit", "--quiet", "-m", "Competing agent advance");
  git("-C", clone, "push", "--quiet", "origin", "main");
  const advanced = git("-C", clone, "rev-parse", "HEAD").trim();
  await page.getByLabel("What changed?", { exact: true }).fill("Browser edit");
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  await expect(page.locator(".workspace-root .error-banner")).toContainText("Latest version");
  await expect(page.getByLabel("Source code", { exact: true })).toContainText("browser draft");
  await expect(page.getByLabel("What changed?", { exact: true })).toHaveValue("Browser edit");
  await expect(page.getByLabel("Selected commit", { exact: true })).toHaveText(initial.slice(0, 12));
  expect(git("-C", clone, "ls-remote", "origin", "refs/heads/main").split(/\s/)[0]).toBe(advanced);
  await page.getByRole("link", { name: "Explore", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^Artifacts/ })).toBeVisible();
  await page.goto(`/#/project/${project.id}?edit=1`);
  await page.getByRole("treeitem", { name: "notes.md", exact: false }).click();
  await expect(page.getByLabel("Source code", { exact: true })).toContainText("browser draft");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  await expect(page.locator(".workspace-root .error-banner")).toContainText("Latest version");
  await page.getByRole("button", { name: "Check latest version", exact: true }).click();
  await expect(page.locator(".error-banner code")).toHaveText(advanced);
  await page.getByRole("button", { name: "Discard draft and use latest", exact: true }).click();
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page.getByLabel("Selected commit", { exact: true })).toHaveText(advanced.slice(0, 12));
  await addFile(page, "unknown.txt", "accepted but response lost\n");
  let requests = 0;
  await page.route(`**/api/projects/${project.id}/draft/save`, async route => {
    requests++;
    await route.fetch();
    await route.abort("failed");
  });
  await page.getByLabel("What changed?", { exact: true }).fill("Uncertain result");
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  await expect(page.locator(".workspace-root .error-banner")).toContainText("outcome unknown");
  expect(requests).toBe(1);
  await page.unrouteAll({ behavior: "wait" });
  await expect(page.getByLabel("Source code", { exact: true })).toContainText("accepted but response lost");
  await expect(page.getByLabel("What changed?", { exact: true })).toHaveValue("Uncertain result");
  git("-C", clone, "fetch", "--quiet");
  expect(git("-C", clone, "show", "origin/main:unknown.txt")).toBe("accepted but response lost\n");
  const accepted = git("-C", clone, "rev-parse", "origin/main").trim();
  const recovered = page.waitForResponse(response => response.url().endsWith("/draft/save"));
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  expect((await recovered).status()).toBe(200);
  await expect(page.getByLabel("Selected commit", { exact: true })).toHaveText(accepted.slice(0, 12));
  expect(git("-C", clone, "ls-remote", "origin", "refs/heads/main").split(/\s/)[0]).toBe(accepted);
  await page.getByRole("button", { name: "Git details", exact: true }).click();
  await page.getByLabel("Revision", { exact: true }).fill(initial);
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await expect(page.getByLabel("Source code", { exact: true })).toHaveAttribute("aria-readonly", "true");
  await page.getByRole("button", { name: "Fork", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Fork artifact", exact: true });
  await dialog.getByLabel("Title", { exact: true }).fill(`Exact fork ${randomUUID().slice(0, 8)}`);
  await dialog.getByRole("button", { name: "Fork artifact", exact: true }).click();
  await expect(page).not.toHaveURL(new RegExp(project.id));
  await expect(page.getByLabel("Selected commit", { exact: true })).toHaveText(initial.slice(0, 12));
  const forkId = new URL(page.url()).hash.match(/project\/([^?]+)/)![1]!;
  const fork: Project = (await (await page.request.get(`/api/projects/${forkId}`)).json()).project;
  expect(fork.forkedFrom).toEqual({ projectId: project.id, commit: initial });
  expect(git("ls-remote", `${settings.forgejoUrl}/${fork.forgejoOwner}/${fork.forgejoRepo}.git`, "refs/heads/main").split(/\s/)[0]).toBe(initial);
  await addFile(page, "private-draft.txt", "persist on logout\n");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /^Artifacts/ })).toBeVisible();
  await login(page);
  await page.goto(`/#/project/${forkId}?edit=1`);
  await page.getByRole("treeitem", { name: "private-draft.txt", exact: false }).click();
  await expect(page.getByLabel("Source code", { exact: true })).toContainText("persist on logout");
  expect(git("ls-remote", `${settings.forgejoUrl}/${fork.forgejoOwner}/${fork.forgejoRepo}.git`, "refs/heads/main").split(/\s/)[0]).toBe(initial);
});

test("metadata CAS preserves conflicted form and Python saved launch", async ({ page }) => {
  test.setTimeout(60000);
  const { project, clone } = await newModel(page, "python");
  await page.getByRole("button", { name: "About artifact", exact: true }).click();
  await page.getByRole("button", { name: "Edit metadata", exact: true }).click();
  await page.locator(".metadata-form").getByLabel("Title", { exact: true }).fill("Browser metadata draft");
  const competing = await page.request.patch(`/api/projects/${project.id}`, { headers: { Origin: settings.appOrigin }, data: { expectedMetadataVersion: project.metadataVersion, description: "Competing metadata edit" } });
  expect(competing.status()).toBe(200);
  await page.getByRole("button", { name: "Save metadata", exact: true }).click();
  await expect(page.locator(".metadata-form [role=alert]")).toBeVisible();
  await expect(page.locator(".metadata-form").getByLabel("Title", { exact: true })).toHaveValue("Browser metadata draft");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "About artifact", exact: true }).click();
  await page.getByRole("button", { name: "Edit metadata", exact: true }).click();
  await page.locator(".metadata-form").getByLabel("Title", { exact: true }).fill("Updated Python model");
  await page.getByRole("button", { name: "Save metadata", exact: true }).click();
  await expect(page.locator(".about h2")).toHaveText("Updated Python model");
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await addFile(page, "notes.md", "Python saved revision\n");
  await page.getByRole("treeitem", { name: "model.py", exact: false }).click();
  await text(page, readFileSync(resolve(clone, "model.py"), "utf8").replace("100.0 if", "50.0 if"));
  const saved = await commit(page, "Change Python heat and add notes", true);
  await expect(page.frameLocator("iframe").locator("#status")).toHaveText("Python ready · Pyodide 0.29.5", { timeout: 30000 });
  await page.frameLocator("iframe").getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.frameLocator("iframe").locator("#status")).toHaveText("Peak temperature: 44.268 · Total heat: 1000.000");
  git("-C", clone, "fetch", "--quiet");
  expect(git("-C", clone, "show", `${saved}:model.py`)).toContain("50.0 if");
});


test("exact text endings survive edits and real authentication failures retain drafts", async ({ page }) => {
  const { project, clone } = await newModel(page, "worker", "public");
  const files = { "bom.txt": "\ufeffBOM\n", "crlf.txt": "first\r\nsecond\r\n", "mixed.txt": "first\r\nsecond\nthird\r\n" };
  for (const [path, content] of Object.entries(files)) writeFileSync(resolve(clone, path), content);
  git("-C", clone, "add", ".");
  git("-C", clone, "-c", "user.name=UI acceptance", "-c", "user.email=ui@lab.invalid", "commit", "--quiet", "-m", "Text endings fixtures");
  git("-C", clone, "push", "--quiet", "origin", "main");
  await page.getByRole("button", { name: "Refresh latest version", exact: true }).click();
  for (const path of Object.keys(files)) {
    await page.getByRole("treeitem", { name: path, exact: false }).click();
    const editor = page.getByLabel("Source code", { exact: true });
    await expect(editor).toHaveAttribute("aria-readonly", "false");
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.insertText("saved");
  }
  const saved = await commit(page, "Preserve text bytes while appending");
  git("-C", clone, "fetch", "--quiet");
  for (const [path, content] of Object.entries(files)) expect(git("-C", clone, "show", `${saved}:${path}`)).toBe(content + "saved");
  await addFile(page, "retained.txt", "keep despite denied saves\n");
  await page.getByLabel("What changed?", { exact: true }).fill("Retained message");
  await expect.poll(async () => (await (await page.request.get(`/api/projects/${project.id}/draft`)).json()).draft?.changes.some((change: { path: string }) => change.path === "retained.txt")).toBe(true);
  expect((await page.request.delete("/api/session", { headers: { Origin: settings.appOrigin, "Content-Type": "application/json" } })).ok()).toBe(true);
  let response = page.waitForResponse(response => response.url().endsWith("/draft/save"));
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  expect((await response).status()).toBe(401);
  await expect(page.getByLabel("Source code", { exact: true })).toContainText("keep despite denied saves");
  await expect(page.getByLabel("What changed?", { exact: true })).toHaveValue("Retained message");
  const unrelated = credentials.users.find((user: { username: string }) => user.username === "cy");
  expect((await page.request.post("/api/session", { headers: { Origin: settings.appOrigin }, data: { username: unrelated.username, password: unrelated.password } })).ok()).toBe(true);
  response = page.waitForResponse(response => response.url().endsWith("/draft/save"));
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  expect((await response).status()).toBe(403);
  await expect(page.getByLabel("Source code", { exact: true })).toContainText("keep despite denied saves");
  await expect(page.getByLabel("What changed?", { exact: true })).toHaveValue("Retained message");
  expect(git("-C", clone, "ls-remote", "origin", "refs/heads/main").split(/\s/)[0]).toBe(saved);
  await expect(page.getByLabel("Selected commit", { exact: true })).toHaveText(saved.slice(0, 12));
});

test("creation retry recovers one project without resetting later Git work", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "New artifact", exact: true }).click();
  const dialog = page.locator("dialog[open]");
  const title = `Recover creation ${randomUUID().slice(0, 8)}`;
  await dialog.getByLabel("Title", { exact: true }).fill(title);
  let first: { project: Project; commit: string } | undefined;
  let firstRequest = "";
  await page.route("**/api/projects", async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    firstRequest = route.request().postDataJSON().requestId;
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    first = await response.json();
    await route.abort("failed");
  });
  await dialog.getByRole("button", { name: "Create artifact", exact: true }).click();
  await expect(dialog.locator("[role=alert]")).toBeVisible();
  await page.unrouteAll({ behavior: "wait" });
  expect(first).toBeTruthy();
  const clone = mkdtempSync(resolve(stateDir, "authoring-retry-"));
  git("clone", "--quiet", `${settings.forgejoUrl}/${first!.project.forgejoOwner}/${first!.project.forgejoRepo}.git`, clone);
  writeFileSync(resolve(clone, "agent.txt"), "later work survives retry\n");
  git("-C", clone, "add", "agent.txt");
  git("-C", clone, "-c", "user.name=UI acceptance", "-c", "user.email=ui@lab.invalid", "commit", "--quiet", "-m", "Advance before creation retry");
  git("-C", clone, "push", "--quiet", "origin", "main");
  const advanced = git("-C", clone, "rev-parse", "HEAD").trim();
  const replay = page.waitForResponse(response => response.url().endsWith("/api/projects") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Create artifact", exact: true }).click();
  const response = await replay;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON().requestId).toBe(firstRequest);
  expect((await response.json()).project.id).toBe(first!.project.id);
  await expect(page.getByLabel("Selected commit", { exact: true })).toHaveText(advanced.slice(0, 12));
  await expect(page.getByRole("treeitem", { name: "agent.txt", exact: false })).toBeVisible();
  expect(git("-C", clone, "ls-remote", "origin", "refs/heads/main").split(/\s/)[0]).toBe(advanced);
  const projects: Project[] = (await (await page.request.get("/api/projects")).json()).projects;
  expect(projects.filter(project => project.title === title)).toHaveLength(1);
});

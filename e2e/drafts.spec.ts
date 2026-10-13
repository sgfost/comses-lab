import { test, expect, type Page } from "@playwright/test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config, stateDir } from "../scripts/config.mjs";
const settings = config();
const credentials = JSON.parse(readFileSync(resolve(stateDir, "credentials.json"), "utf8"));
const owner = credentials.users.find((user: { username: string }) => user.username === "ada");
async function login(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill(owner.username);
  await page.getByLabel("Password", { exact: true }).fill(owner.password);
  await page.getByRole("dialog").getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}
async function create(page: Page, visibility = "private") {
  await login(page);
  await page.getByRole("button", { name: "New artifact", exact: true }).click();
  const dialog = page.locator("dialog[open]");
  await dialog.getByLabel("Title", { exact: true }).fill(`Draft ${randomUUID().slice(0, 8)}`);
  await dialog.getByLabel("Visibility", { exact: true }).selectOption(visibility);
  await dialog.getByRole("button", { name: "Create artifact", exact: true }).click();
  await expect(page.getByLabel("Source code", { exact: true })).toBeVisible();
  const id = new URL(page.url()).hash.match(/project\/([^?]+)/)![1]!;
  const tree = await (await page.request.get(`/api/projects/${id}/tree?ref=refs/heads/main`)).json();
  return { id, initial: tree.commit as string };
}
async function edit(page: Page, text: string) {
  const editor = page.getByLabel("Source code", { exact: true });
  await expect(editor).toHaveAttribute("aria-readonly", "false");
  await editor.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.insertText(text);
}
async function add(page: Page, path: string, text: string) {
  await page.getByLabel("New file path", { exact: true }).fill(path);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await edit(page, text);
}
test("signing in on an open project restores the owner's editable draft", async ({ page }) => {
  const { id } = await create(page, "public");
  await add(page, "resume.txt", "Resume after sign-in\n");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^Artifacts/ })).toBeVisible();
  await page.goto(`/#/project/${id}?edit=1`);
  await expect(page.getByLabel("Source code", { exact: true })).toHaveAttribute("aria-readonly", "true");
  await page.getByRole("button", { name: "Sign in", exact: true }).first().click();
  const dialog = page.locator("dialog[open]");
  await dialog.getByLabel("Username", { exact: true }).fill(owner.username);
  await dialog.getByLabel("Password", { exact: true }).fill(owner.password);
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByLabel("Source code", { exact: true })).toHaveAttribute("aria-readonly", "false");
  await page.getByRole("treeitem", { name: "resume.txt", exact: false }).click();
  await expect(page.getByLabel("Source code", { exact: true })).toContainText("Resume after sign-in");
});

test("inspecting another Git branch leaves the working draft on its original branch", async ({ page }) => {
  const { id, initial } = await create(page);
  const project = (await (await page.request.get(`/api/projects/${id}`)).json()).project;
  const directory = mkdtempSync(resolve(stateDir, "draft-branches-"));
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${owner.username}:${owner.password}`).toString("base64")}` };
  try {
    execFileSync("git", ["clone", "--bare", "--quiet", `${settings.forgejoUrl}/${project.forgejoOwner}/${project.forgejoRepo}.git`, directory], { env, stdio: "pipe" });
    execFileSync("git", ["--git-dir", directory, "push", "origin", `${initial}:refs/heads/alternate`], { env, stdio: "pipe" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
  await add(page, "main-draft.txt", "Keep on main\n");
  async function alternate() {
    await page.getByRole("button", { name: "Git details", exact: true }).click();
    await page.getByLabel("Revision", { exact: true }).fill("refs/heads/alternate");
    await page.getByRole("button", { name: "Go", exact: true }).click();
  }
  await alternate();
  await expect(page.getByRole("button", { name: "Back to draft", exact: true })).toBeVisible();
  await expect(page.getByLabel("Source code", { exact: true })).toHaveAttribute("aria-readonly", "true");
  const draft = (await (await page.request.get(`/api/projects/${id}/draft`)).json()).draft;
  expect(draft.ref).toBe("refs/heads/main");
  expect(draft.changes[0].path).toBe("main-draft.txt");
  await page.getByRole("button", { name: "Back to draft", exact: true }).click();
  await page.getByRole("treeitem", { name: "main-draft.txt", exact: false }).click();
  await expect(page.getByLabel("Source code", { exact: true })).toContainText("Keep on main");
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save version", exact: true })).toBeDisabled();
  await alternate();
  await expect(page.getByLabel("Source code", { exact: true })).toHaveAttribute("aria-readonly", "false");
  await expect.poll(async () => (await (await page.request.get(`/api/projects/${id}/draft`)).json()).draft.ref).toBe("refs/heads/alternate");
});
test("autosave survives reload and history without a Git version until Save version", async ({ page }) => {
  const { id, initial } = await create(page);
  await add(page, "draft.txt", "first draft\n");
  await expect.poll(async () => (await (await page.request.get(`/api/projects/${id}/draft`)).json()).draft?.changes.some((change: { path: string; content?: string }) => change.path === "draft.txt" && change.content === "first draft\n")).toBe(true);
  await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Draft saved");
  expect((await (await page.request.get(`/api/projects/${id}/tree?ref=refs/heads/main`)).json()).commit).toBe(initial);
  await page.reload();
  await page.getByRole("treeitem", { name: "draft.txt", exact: false }).click();
  await expect(page.getByLabel("Source code", { exact: true })).toContainText("first draft");
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.locator(`.history-entry[data-commit="${initial}"] .history-select`).click();
  await expect(page.getByLabel("Source code", { exact: true })).toHaveAttribute("aria-readonly", "true");
  await page.getByRole("button", { name: "Back to draft", exact: true }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("treeitem", { name: "draft.txt", exact: false }).click();
  await expect(page.getByLabel("Source code", { exact: true })).toContainText("first draft");
  await page.getByLabel("What changed?", { exact: true }).fill("Save the draft");
  const saved = page.waitForResponse(response => response.url().endsWith("/draft/save") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  const result = await (await saved).json();
  expect(result.commit).not.toBe(initial);
  await expect(page.locator(".commit-toolbar")).toContainText("Version saved");
  await expect.poll(async () => (await (await page.request.get(`/api/projects/${id}/draft`)).json()).draft.changes).toEqual([]);
  expect((await (await page.request.get(`/api/projects/${id}/file?commit=${result.commit}&path=draft.txt`)).json()).content).toBe("first draft\n");
});
test("competing draft writes preserve local text and offer recovery", async ({ page }) => {
  const { id, initial } = await create(page);
  await add(page, "draft.txt", "browser acknowledged\n");
  await expect.poll(async () => (await (await page.request.get(`/api/projects/${id}/draft`)).json()).draft?.version ?? 0).toBeGreaterThan(0);
  const first = (await (await page.request.get(`/api/projects/${id}/draft`)).json()).draft;
  const competing = await page.request.put(`/api/projects/${id}/draft`, { headers: { Origin: settings.appOrigin }, data: { expectedVersion: first.version, ref: first.ref, baseCommit: initial, changes: [{ operation: "create", path: "agent.txt", content: "agent draft\n" }] } });
  expect(competing.ok()).toBe(true);
  await edit(page, "browser unacknowledged\n");
  await expect(page.getByRole("button", { name: "Download recovery", exact: true })).toBeVisible();
  await expect(page.getByLabel("Source code", { exact: true })).toContainText("browser unacknowledged");
  const actual = (await (await page.request.get(`/api/projects/${id}/draft`)).json()).draft;
  expect(actual.changes).toEqual([{ operation: "create", path: "agent.txt", content: "agent draft\n" }]);
  await page.getByRole("button", { name: "Reload saved draft", exact: true }).click();
  await expect(page.getByRole("treeitem", { name: "agent.txt", exact: false })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "draft.txt", exact: false })).toHaveCount(0);
});

test("typing during Save version is autosaved after the committed snapshot", async ({ page }) => {
  const { id } = await create(page);
  await add(page, "draft.txt", "committed snapshot\n");
  let release!: () => void;
  let dispatched!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { dispatched = resolve; });
  let commit = "";
  await page.route(`**/api/projects/${id}/draft/save`, async route => {
    const response = await route.fetch();
    commit = (await response.json()).commit;
    dispatched();
    await held;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  await started;
  await edit(page, "later typing\n");
  release();
  await expect.poll(async () => (await (await page.request.get(`/api/projects/${id}/draft`)).json()).draft.changes.find((change: { path: string }) => change.path === "draft.txt")?.content).toBe("later typing\n");
  expect((await (await page.request.get(`/api/projects/${id}/file?commit=${commit}&path=draft.txt`)).json()).content).toBe("committed snapshot\n");
  await page.getByRole("link", { name: "Explore", exact: true }).click();
  await page.goto(`/#/project/${id}?edit=1`);
  await page.getByRole("treeitem", { name: "draft.txt", exact: false }).click();
  await expect(page.getByLabel("Source code", { exact: true })).toContainText("later typing");
});

test("library installation changes the autosaved draft until Save version", async ({ page }) => {
  const { id, initial } = await create(page);
  const created = await page.request.post("/api/projects", { headers: { Origin: settings.appOrigin }, data: { requestId: randomUUID(), templateId: "library-js", title: `Draft library ${randomUUID().slice(0, 8)}`, visibility: "private" } });
  expect(created.status()).toBe(201);
  const library = (await created.json()).project;
  await add(page, "draft.txt", "keep before library install\n");
  await page.getByRole("button", { name: "Add library", exact: true }).click();
  const dialog = page.locator("dialog[open]");
  await dialog.getByRole("combobox", { name: "Library", exact: true }).selectOption(library.id);
  const installed = page.waitForResponse(response => response.url().endsWith("/draft/libraries") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Add to artifact", exact: true }).click();
  expect((await installed).ok()).toBe(true);
  await expect(page.locator(".libraries-panel").getByRole("link", { name: library.title, exact: true })).toBeVisible();
  expect((await (await page.request.get(`/api/projects/${id}/tree?ref=refs/heads/main`)).json()).commit).toBe(initial);
  await page.reload();
  await expect(page.locator(".libraries-panel").getByRole("link", { name: library.title, exact: true })).toBeVisible();
  await page.getByRole("treeitem", { name: "draft.txt", exact: false }).click();
  await expect(page.getByLabel("Source code", { exact: true })).toContainText("keep before library install");
  const saved = page.waitForResponse(response => response.url().endsWith("/draft/save") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  const commit = (await (await saved).json()).commit;
  const libraries = await (await page.request.get(`/api/projects/${id}/libraries?commit=${commit}`)).json();
  expect(libraries.libraries[0].projectId).toBe(library.id);
});

test("a lost Save version response can be retried while preserving later typing", async ({ page }) => {
  const { id } = await create(page);
  await add(page, "draft.txt", "saved once\n");
  let release!: () => void;
  let dispatched!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { dispatched = resolve; });
  let commit = "";
  await page.route(`**/api/projects/${id}/draft/save`, async route => {
    const response = await route.fetch();
    commit = (await response.json()).commit;
    dispatched();
    await held;
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  await started;
  await edit(page, "later unsent typing\n");
  release();
  await expect(page.locator(".workspace-root .error-banner")).toContainText("outcome unknown");
  await page.unrouteAll({ behavior: "wait" });
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  await expect.poll(async () => (await (await page.request.get(`/api/projects/${id}/draft`)).json()).draft.changes.find((change: { path: string }) => change.path === "draft.txt")?.content).toBe("later unsent typing\n");
  expect((await (await page.request.get(`/api/projects/${id}/tree?ref=refs/heads/main`)).json()).commit).toBe(commit);
  expect((await (await page.request.get(`/api/projects/${id}/file?commit=${commit}&path=draft.txt`)).json()).content).toBe("saved once\n");
});

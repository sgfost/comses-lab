import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config, stateDir, instance } from "../scripts/config.mjs";
if (!instance.startsWith("test-")) throw new Error("Isolated test instance required");
const settings = config();
const credentials = JSON.parse(readFileSync(resolve(stateDir, "credentials.json"), "utf8"));
const owner = credentials.users.find((user: { username: string }) => user.username === "ada");
const model = readFileSync(resolve("examples/netlogo/model.nlogox"), "utf8");
async function login(page: Page) {
  const response = await page.request.post("/api/session", { headers: { Origin: settings.appOrigin }, data: owner });
  expect(response.status()).toBe(200);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}
const editor = (page: Page) => page.locator(".netlogo-source-editor .cm-content");
async function edit(page: Page, content: string) {
  await expect(editor(page)).toHaveAttribute("aria-readonly", "false");
  await editor(page).click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.insertText(content);
}
const projectId = (page: Page) => new URL(page.url()).hash.match(/project\/([^?]+)/)![1]!;
async function savedSource(page: Page, id: string, commit: string, path: string) {
  const response = await page.request.get(`/api/projects/${id}/file?commit=${commit}&path=${encodeURIComponent(path)}`);
  expect(response.status()).toBe(200);
  return (await response.json()).content as string;
}
async function draftSource(page: Page, id: string, path: string) {
  const draft = (await (await page.request.get(`/api/projects/${id}/draft`)).json()).draft;
  return draft?.changes.find((change: { path: string }) => change.path === path)?.content as string | undefined;
}
async function createFixture(page: Page, name: string, content: string) {
  const response = await page.request.post("/api/projects", {
    headers: { Origin: settings.appOrigin },
    data: { requestId: randomUUID(), templateId: "netlogo", title: `NetLogo ${randomUUID().slice(0, 8)}`, visibility: "private", netlogoFile: { name, content } },
  });
  expect(response.status()).toBe(201);
  const result = await response.json();
  await page.goto(`/#/project/${result.project.id}?edit=1`);
  await page.getByRole("treeitem", { name, exact: false }).click();
  await expect(editor(page)).toBeVisible();
  return result.project.id as string;
}

test("NetLogo upload preserves bytes, code edits autosave, saved versions and forks preserve the interface", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "New artifact", exact: true }).click();
  const dialog = page.locator("dialog[open]");
  await dialog.getByLabel("Template", { exact: true }).selectOption("netlogo");
  // Include a BOM and CRLF outside code: import and later code editing must preserve them.
  const original = "\ufeff" + model.replaceAll("\n", "\r\n");
  await dialog.getByLabel("Import model (optional)").setInputFiles({ name: "My walks.nlogox", mimeType: "text/plain", buffer: Buffer.from(original) });
  await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue("My walks");
  await dialog.getByLabel("Title", { exact: true }).fill(`Walks ${randomUUID().slice(0, 8)}`);
  await dialog.getByRole("button", { name: "Create artifact", exact: true }).click();
  await expect(editor(page)).toBeVisible();
  const id = projectId(page);
  const initial = (await (await page.request.get(`/api/projects/${id}/tree?ref=refs/heads/main`)).json()).commit;
  expect(await savedSource(page, id, initial, "My walks.nlogox")).toBe(original);
  const code = original.match(/<code><!\[CDATA\[([\s\S]*?)\]\]><\/code>/)![1]!.replaceAll("\r\n", "\n");
  await expect(page.getByRole("button", { name: "Code", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(editor(page)).not.toContainText("<model");
  const editedCode = `; Keep literal ]]> and <code> in strings/comments\n${code.replace("set size 1.1", "set size 1.7")}`;
  await edit(page, editedCode);
  await expect.poll(() => draftSource(page, id, "My walks.nlogox")).toContain("set size 1.7");
  const drafted = (await draftSource(page, id, "My walks.nlogox"))!;
  expect(drafted.slice(0, drafted.indexOf("<code>"))).toBe(original.slice(0, original.indexOf("<code>")));
  expect(drafted.slice(drafted.indexOf("</code>") + 7)).toBe(original.slice(original.indexOf("</code>") + 7));
  const parsed = await page.evaluate(source => {
    const xml = new DOMParser().parseFromString(source.replace(/^\uFEFF/, ""), "application/xml");
    return { invalid: !!xml.querySelector("parsererror"), code: xml.querySelector("code")?.textContent };
  }, drafted);
  expect(parsed).toEqual({ invalid: false, code: editedCode });
  await page.reload();
  await page.getByRole("treeitem", { name: "My walks.nlogox", exact: false }).click();
  await expect(editor(page)).toContainText("set size 1.7");
  await expect(page.getByRole("button", { name: "Code", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("What changed?", { exact: true }).fill("Change turtle size");
  const saving = page.waitForResponse(response => response.url().endsWith("/draft/save") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  const saved = await saving;
  expect(saved.status()).toBe(201);
  const commit = (await saved.json()).commit;
  expect(await savedSource(page, id, commit, "My walks.nlogox")).toBe(drafted);
  await page.getByRole("button", { name: "Fork", exact: true }).click();
  const fork = page.getByRole("dialog", { name: "Fork artifact", exact: true });
  await fork.getByRole("button", { name: "Fork artifact", exact: true }).click();
  await expect(page).not.toHaveURL(new RegExp(id));
  expect(await savedSource(page, projectId(page), commit, "My walks.nlogox")).toBe(drafted);
});

test("invalid uploads are actionable and never silently create a starter model", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "New artifact", exact: true }).click();
  const dialog = page.locator("dialog[open]");
  await dialog.getByLabel("Template", { exact: true }).selectOption("netlogo");
  await dialog.getByLabel("Title", { exact: true }).fill("My chosen title");
  await dialog.getByLabel("Import model (optional)").setInputFiles({ name: "broken.nlogox", mimeType: "text/plain", buffer: Buffer.from([0xc3, 0x28]) });
  await expect(dialog.getByRole("alert")).toContainText("UTF-8");
  await expect(dialog.getByRole("button", { name: "Create artifact", exact: true })).toBeDisabled();
  await dialog.getByLabel("Import model (optional)").setInputFiles({ name: "large.nlogo", mimeType: "text/plain", buffer: Buffer.alloc(2_000_001, 32) });
  await expect(dialog.getByRole("alert")).toContainText("2 MB");
  await dialog.getByRole("button", { name: "Use example instead" }).click();
  await expect(dialog.getByRole("button", { name: "Create artifact", exact: true })).toBeEnabled();
  await dialog.getByLabel("Import model (optional)").setInputFiles({ name: "walks.nlogox", mimeType: "text/plain", buffer: Buffer.from(model) });
  await expect(dialog).toContainText("walks.nlogox");
  await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue("My chosen title");
  await dialog.getByLabel("Template", { exact: true }).selectOption("worker");
  await dialog.getByLabel("Template", { exact: true }).selectOption("netlogo");
  await expect(dialog).not.toContainText("walks.nlogox");
});

test("malformed model XML stays editable and code view recovers after repair", async ({ page }) => {
  await login(page);
  const id = await createFixture(page, "repair.nlogox", model.replace("</model>", "</broken>"));
  await expect(page.getByRole("status").filter({ hasText: "model XML is invalid" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Full model", exact: true })).toHaveAttribute("aria-pressed", "true");
  await edit(page, model);
  await expect.poll(() => draftSource(page, id, "repair.nlogox")).toBe(model);
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect(editor(page)).toContainText("to setup");
  await expect(editor(page)).not.toContainText("<model");
});

test("legacy model code editing preserves every remaining model section", async ({ page }) => {
  await login(page);
  const rest = "@#$#@#$#@\r\nGRAPHICS-WINDOW\r\n0\r\n0\r\n@#$#@#$#@\r\n## WHAT IS IT?\r\nPreserve this text.\r\n@#$#@#$#@\r\ndefault\r\ntrue\r\n0\r\nPolygon -7500403 true true 150 5 40 250 150 205 260 250\r\n@#$#@#$#@\r\nNetLogo 6.4.0\r\n@#$#@#$#@\r\nsetup\r\n@#$#@#$#@\r\n@#$#@#$#@\r\n@#$#@#$#@\r\n@#$#@#$#@\r\n0\r\n@#$#@#$#@\r\n";
  const id = await createFixture(page, "legacy.nlogo", "to setup\r\n clear-all\r\nend\r\n" + rest);
  await expect(editor(page)).not.toContainText("GRAPHICS-WINDOW");
  await edit(page, "to setup\n clear-all\n create-turtles 12\nend\n");
  await expect.poll(() => draftSource(page, id, "legacy.nlogo")).toContain("create-turtles 12");
  const draft = (await draftSource(page, id, "legacy.nlogo"))!;
  expect(draft.slice(draft.indexOf("@#$#@#$#@"))).toBe(rest);
  await page.getByRole("button", { name: "Full model", exact: true }).click();
  await expect(editor(page)).toContainText("GRAPHICS-WINDOW");
});

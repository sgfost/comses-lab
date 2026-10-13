import { test, expect, type Page, type FrameLocator } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config, stateDir, instance } from "../scripts/config.mjs";
if (!instance.startsWith("test-")) throw new Error("Isolated test instance required");
const settings = config();
const credentials = JSON.parse(readFileSync(resolve(stateDir, "credentials.json"), "utf8"));
const owner = credentials.users.find((user: { username: string }) => user.username === "ada");
const starter = readFileSync(resolve("examples/netlogo/model.nlogox"), "utf8");
const legacy = readFileSync(resolve("e2e/fixtures/netlogo-legacy.nlogo"), "utf8");
test.beforeEach(async ({ page }) => {
  page.on("dialog", async dialog => {
    expect(dialog.type()).toBe("beforeunload");
    await dialog.accept();
  });
});
async function open(page: Page, source = starter, name = "model.nlogox") {
  const signedIn = await page.request.post("/api/session", { headers: { Origin: settings.appOrigin }, data: owner });
  expect(signedIn.status()).toBe(200);
  const response = await page.request.post("/api/projects", {
    headers: { Origin: settings.appOrigin },
    data: { requestId: randomUUID(), templateId: "netlogo", title: `Interface ${randomUUID().slice(0, 8)}`, visibility: "private", netlogoFile: { name, content: source } },
  });
  expect(response.status()).toBe(201);
  const { project, commit } = await response.json();
  await page.goto(`/#/project/${project.id}?edit=1`);
  await expect(page.getByRole("button", { name: "Edit interface", exact: true })).toBeEnabled();
  return { project, commit };
}
const frame = (page: Page) => page.frameLocator('iframe[title="Artifact preview"]');
async function changePopulation(preview: FrameLocator, value: string) {
  const id = await preview.locator(".netlogo-slider").filter({ hasText: "population" }).getAttribute("id");
  const widget = id!.match(/(\d+)$/)![1];
  const overlay = preview.getByRole("button", { name: `Editable overlay for widget ${widget} of type slider`, exact: true });
  await overlay.focus();
  await expect(overlay).toHaveClass(/selected/);
  await overlay.press("Enter");
  const properties = preview.locator(".widget-edit-form");
  await expect(properties).toBeVisible();
  await properties.getByLabel("Default value:", { exact: true }).fill(value);
  await properties.getByRole("button", { name: "OK", exact: true }).click();
  await expect(properties).toBeHidden();
}
async function draft(page: Page, id: string) {
  return (await (await page.request.get(`/api/projects/${id}/draft`)).json()).draft;
}
async function head(page: Page, id: string) {
  return (await (await page.request.get(`/api/projects/${id}/tree?ref=refs/heads/main`)).json()).commit as string;
}
async function file(page: Page, id: string, commit: string, path: string) {
  const response = await page.request.get(`/api/projects/${id}/file?commit=${commit}&path=${encodeURIComponent(path)}`);
  expect(response.status()).toBe(200);
  return (await response.json()).content as string;
}
async function modelValues(page: Page, source: string) {
  return page.evaluate(source => {
    const xml = new DOMParser().parseFromString(source.replace(/^\uFEFF/, ""), "application/xml");
    return { population: xml.querySelector('slider[variable="population"]')?.getAttribute("default"), info: xml.querySelector("info")?.textContent, valid: !xml.querySelector("parsererror") };
  }, source);
}

test("actual NetLogo slider and Info edits autosave, reload, commit and fork", async ({ page }) => {
  test.setTimeout(90000);
  const { project } = await open(page);
  const initial = await head(page, project.id);
  await page.getByLabel("Live preview", { exact: true }).uncheck();
  const codeEditor = page.locator(".netlogo-source-editor .cm-content");
  await codeEditor.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
  await page.keyboard.insertText("\n; Fresh code with live preview disabled\n");
  await expect.poll(async () => (await draft(page, project.id))?.changes[0]?.content).toContain("Fresh code with live preview disabled");
  await page.getByRole("button", { name: "Edit interface", exact: true }).click();
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  await changePopulation(frame(page), "73");
  await expect.poll(async () => {
    const content = (await draft(page, project.id))?.changes.find((change: { path: string }) => change.path === "model.nlogox")?.content;
    return content ? (await modelValues(page, content)).population : undefined;
  }).toBe("73");
  await frame(page).getByRole("tab", { name: "Model Info", exact: true }).click();
  const infoEditor = frame(page).locator(".netlogo-info-editor .CodeMirror");
  await expect(infoEditor).toBeVisible();
  await infoEditor.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.insertText("## Field notes\nInterface edits belong to this saved model.\n");
  await expect.poll(async () => {
    const content = (await draft(page, project.id))?.changes.find((change: { path: string }) => change.path === "model.nlogox")?.content;
    return content ? (await modelValues(page, content)).info : undefined;
  }).toContain("Interface edits belong to this saved model.");
  await expect(page.getByRole("status").filter({ hasText: "Interface saved to draft" })).toBeVisible();
  expect(await head(page, project.id)).toBe(initial);
  // Done must capture the last keystroke even before upstream change debounce fires.
  await infoEditor.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
  await page.keyboard.insertText("Final note just before Done.");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit interface", exact: true })).toBeEnabled();
  const changed = (await draft(page, project.id)).changes.find((change: { path: string }) => change.path === "model.nlogox").content;
  expect(changed).toContain("Fresh code with live preview disabled");
  expect((await modelValues(page, changed)).info).toContain("Final note just before Done.");
  await page.reload();
  await expect(page.getByRole("button", { name: "Edit interface", exact: true })).toBeEnabled();
  await expect(frame(page).locator(".netlogo-slider").filter({ hasText: "population" }).locator('input[type="number"]')).toHaveValue("73");
  await frame(page).getByRole("tab", { name: "Model Info", exact: true }).click();
  await expect(frame(page).locator(".netlogo-info-markdown")).toContainText("Interface edits belong to this saved model.");
  await page.getByLabel("What changed?", { exact: true }).fill("Set population and add field notes");
  const saving = page.waitForResponse(response => response.url().endsWith("/draft/save") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  const saved = await saving;
  expect(saved.status()).toBe(201);
  const commit = (await saved.json()).commit;
  expect(await file(page, project.id, commit, "model.nlogox")).toBe(changed);
  await page.getByRole("button", { name: "Fork", exact: true }).click();
  const forkResponse = page.waitForResponse(response => response.url().endsWith(`/api/projects/${project.id}/forks`) && response.request().method() === "POST");
  await page.getByRole("dialog", { name: "Fork artifact", exact: true }).getByRole("button", { name: "Fork artifact", exact: true }).click();
  expect((await forkResponse).status()).toBe(201);
  await expect(page).not.toHaveURL(new RegExp(project.id));
  const forkId = new URL(page.url()).hash.match(/project\/([^?]+)/)![1]!;
  expect(await file(page, forkId, commit, "model.nlogox")).toBe(changed);
});

test("legacy conversion commits a new model before switching entrypoint and preserves original bytes", async ({ page }) => {
  test.setTimeout(60000);
  const source = legacy.replaceAll("\n", "\r\n");
  const { project } = await open(page, source, "legacy.nlogo");
  const initial = await head(page, project.id);
  let checkedBeforePatch = false;
  await page.route(`**/api/projects/${project.id}`, async route => {
    if (route.request().method() !== "PATCH") { await route.continue(); return; }
    const body = route.request().postDataJSON();
    expect(body.entrypoint).toBe("legacy.nlogox");
    expect(body.expectedMetadataVersion).toBe(project.metadataVersion);
    const commit = await head(page, project.id);
    expect(commit).not.toBe(initial);
    expect(await file(page, project.id, commit, "legacy.nlogo")).toBe(source);
    const converted = await file(page, project.id, commit, "legacy.nlogox");
    expect(converted).toContain("<model version=");
    expect(converted).toContain("create-turtles 12");
    checkedBeforePatch = true;
    await route.continue();
  });
  await page.getByRole("button", { name: "Edit interface", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Convert for interface editing" });
  await expect(dialog).toContainText("original .nlogo file stays");
  const converted = page.waitForResponse(response => response.url().endsWith(`/api/projects/${project.id}`) && response.request().method() === "PATCH");
  await dialog.getByRole("button", { name: "Convert model", exact: true }).click();
  expect((await converted).status()).toBe(200);
  await expect(dialog).toBeHidden();
  expect(checkedBeforePatch).toBe(true);
  const updated = (await (await page.request.get(`/api/projects/${project.id}`)).json()).project;
  expect(updated.entrypoint).toBe("legacy.nlogox");
  await page.reload();
  await expect(page.getByRole("button", { name: "Edit interface", exact: true })).toBeEnabled();
  await frame(page).locator(".netlogo-button").filter({ hasText: /^\s*setup\s*$/ }).click();
  await frame(page).locator(".netlogo-button").filter({ hasText: /^\s*go\s*$/ }).click();
  await expect.poll(() => frame(page).locator("body").evaluate(() => (window as any).world.ticker.tickCount())).toBeGreaterThan(2);
  await page.getByRole("button", { name: "Edit interface", exact: true }).click();
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  await expect(dialog).toBeHidden();
});

test("visual authoring cannot overwrite a draft advanced in another editor", async ({ page }) => {
  test.setTimeout(60000);
  const { project } = await open(page);
  await page.getByRole("button", { name: "Edit interface", exact: true }).click();
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  const prior = await draft(page, project.id);
  const competing = [
    { operation: "update", path: "model.nlogox", content: starter.replace('default="40" variable="population"', 'default="22" variable="population"') },
    { operation: "create", path: "field-notes.txt", content: "Another editor's saved draft.\n" },
  ];
  const response = await page.request.put(`/api/projects/${project.id}/draft`, {
    headers: { Origin: settings.appOrigin },
    data: { expectedVersion: prior?.version ?? 0, ref: "refs/heads/main", baseCommit: await head(page, project.id), changes: competing },
  });
  expect(response.status()).toBe(200);
  await changePopulation(frame(page), "89");
  await expect(page.getByRole("alert").filter({ hasText: "draft changed in another editor" }).first()).toBeVisible();
  expect((await draft(page, project.id)).changes).toEqual(competing);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  expect((await draft(page, project.id)).changes).toEqual(competing);
  // This final edit can still be inside the upstream debounce when recovery begins.
  await changePopulation(frame(page), "91");
  await page.getByRole("button", { name: "Reload saved draft", exact: true }).click();
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Edit interface", exact: true })).toBeEnabled();
  await expect(frame(page).locator(".netlogo-slider").filter({ hasText: "population" }).locator('input[type="number"]')).toHaveValue("22");
  expect((await draft(page, project.id)).changes).toEqual(competing);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download recovery", exact: true }).click();
  const recovery = JSON.parse(readFileSync((await (await download).path())!, "utf8"));
  const local = recovery.changes.find((change: { path: string }) => change.path === "model.nlogox");
  expect((await modelValues(page, local.content)).population).toBe("91");
  await page.reload();
  await expect(page.getByRole("button", { name: "Edit interface", exact: true })).toBeEnabled();
  await expect(frame(page).locator(".netlogo-slider").filter({ hasText: "population" }).locator('input[type="number"]')).toHaveValue("22");
  expect((await draft(page, project.id)).changes).toEqual(competing);
  const afterReload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download recovery", exact: true }).click();
  const persisted = JSON.parse(readFileSync((await (await afterReload).path())!, "utf8"));
  expect(persisted).toEqual(recovery);
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  const preview = page.locator('iframe[title="Artifact preview"]');
  const previewUrl = (await preview.getAttribute("src"))!;
  const setup = frame(page).locator(".netlogo-button").filter({ hasText: /^\s*setup\s*$/ });
  const go = frame(page).locator(".netlogo-button").filter({ hasText: /^\s*go\s*$/ });
  await expect(setup).toBeEnabled();
  await setup.focus();
  await setup.press("Enter");
  await expect.poll(() => frame(page).locator("body").evaluate(() => (window as any).world.ticker.tickCount())).toBe(0);
  await expect(preview).toHaveAttribute("src", previewUrl);
  await expect(go).toBeEnabled();
  await go.focus();
  await go.press("Enter");
  await expect.poll(() => frame(page).locator("body").evaluate(() => (window as any).world.ticker.tickCount())).toBeGreaterThan(2);
  await expect(preview).toHaveAttribute("src", previewUrl);
  await go.press("Enter");
  await page.screenshot({ path: "/tmp/netlogo-full-view.png" });
});

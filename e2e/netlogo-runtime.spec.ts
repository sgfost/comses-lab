import { test, expect, type Page, type Frame } from "@playwright/test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { config, stateDir, instance } from "../scripts/config.mjs";
import type { Launch } from "../shared/contracts.ts";

if (!instance.startsWith("test-")) throw new Error("Isolated test instance required");
const c = config();
const owner = JSON.parse(readFileSync(resolve(stateDir, "credentials.json"), "utf8")).users[0];
const starter = readFileSync(resolve("examples/netlogo/model.nlogox"), "utf8");
// Original fixture with its own code, shape, and controls.
const legacy = readFileSync(resolve("e2e/fixtures/netlogo-legacy.nlogo"), "utf8");

async function login(page: Page) {
  const response = await page.request.post("/api/session", {
    headers: { Origin: c.appOrigin }, data: { username: owner.username, password: owner.password },
  });
  expect(response.status()).toBe(200);
}
async function open(page: Page, source = starter, name = "model.nlogox", files: { path: string; content: string }[] = []) {
  const created = await page.request.post("/api/projects", {
    headers: { Origin: c.appOrigin },
    data: { requestId: randomUUID(), templateId: "netlogo", title: `Runtime ${randomUUID().slice(0, 8)}`, visibility: "private", netlogoFile: { name, content: source } },
  });
  expect(created.status()).toBe(201);
  const { project, commit } = await created.json();
  if (files.length) {
    const saved = await page.request.post(`/api/projects/${project.id}/commits`, {
      headers: { Origin: c.appOrigin },
      data: { ref: "refs/heads/main", expectedCommit: commit, message: "Add model data", changes: files.map(file => ({ operation: "create", ...file })) },
    });
    expect(saved.status()).toBe(201);
  }
  const launched = page.waitForResponse(r => r.url().endsWith("/launch") && r.request().method() === "POST");
  await page.goto(`/#/project/${project.id}?edit=1`);
  const launch = await (await launched).json() as Launch;
  await expect(page.locator('iframe[title="Artifact preview"]')).toBeVisible();
  const origin = new URL(launch.url).origin;
  await expect.poll(() => page.frames().find(f => f.url().startsWith(origin))?.url()).toBeTruthy();
  const frame = page.frames().find(f => f.url().startsWith(origin))!;
  return { launch, frame, project };
}
async function run(frame: Frame) {
  await expect(frame.locator(".netlogo-button").filter({ hasText: /^\s*setup\s*$/ })).toBeVisible();
  await frame.locator(".netlogo-button").filter({ hasText: /^\s*setup\s*$/ }).click();
  await frame.locator(".netlogo-button").filter({ hasText: /^\s*go\s*$/ }).click();
  await expect.poll(() => frame.evaluate(() => (window as any).world.ticker.tickCount())).toBeGreaterThan(2);
  await frame.locator(".netlogo-button").filter({ hasText: /^\s*go\s*$/ }).click();
}
async function runtimeResponse(page: Page, launch: Launch, raw = false, headers: Record<string, string> = {}) {
  const url = new URL(launch.url);
  if (raw) url.search = "";
  return page.request.get(`${c.runtimeOrigin}${url.pathname}${url.search}`, { headers: { Host: url.host, ...headers } });
}

const dialogModel = starter.replace(
  "]]></code>",
  'to ask-user\n let answer user-input "Your name?"\n if user-yes-or-no? "Continue?" [ print word "Hello " answer ]\nend\nto crash\n error "Intentional NetLogo runtime error"\nend\n]]></code>',
).replace("<widgets>", `<widgets>
  <button x="750" y="10" width="100" height="36" kind="Observer" forever="false" disableUntilTicks="false" display="ask">ask-user</button>
  <button x="750" y="60" width="100" height="36" kind="Observer" forever="false" disableUntilTicks="false" display="crash">crash</button>`);

test("NetLogo controls, plots, native dialogs, runtime errors, and portable downloads work", async ({ page, context }) => {
  test.setTimeout(60000);
  await login(page);
  const { frame } = await open(page, dialogModel);
  await run(frame);
  await expect(frame.locator(".highcharts-container")).toBeVisible();
  await expect.poll(() => frame.evaluate(() => (window as any).Highcharts.charts.filter(Boolean)[0].series.find((series: any) => series.name === "distance")?.data.length ?? 0)).toBeGreaterThan(0);
  await frame.locator("#netlogo-slider-5-input-field").fill("1");
  await frame.locator("#netlogo-slider-5-input-field").press("Enter");
  const prompts: string[] = [];
  page.on("dialog", async dialog => {
    prompts.push(dialog.type());
    await dialog.accept(dialog.type() === "prompt" ? (dialog.message() === "Your name?" ? "Ada" : "exported-model") : undefined);
  });
  await frame.locator(".netlogo-button").filter({ hasText: /^\s*ask\s*$/ }).click();
  expect(prompts.slice(0, 2)).toEqual(["prompt", "confirm"]);
  await page.getByRole("button", { name: "Console", exact: true }).click();
  const modelDownload = page.waitForEvent("download");
  await frame.locator('[aria-label="Export Options"]').getByRole("button", { name: "NetLogo", exact: true }).click();
  const exported = readFileSync((await (await modelDownload).path())!, "utf8");
  expect(exported).toContain('<model version="NetLogo');
  expect(exported).toContain("to ask-user");
  const htmlDownload = page.waitForEvent("download");
  await frame.locator('[aria-label="Export Options"]').getByRole("button", { name: "HTML", exact: true }).click();
  const exportDir = mkdtempSync(resolve(tmpdir(), "lab-netlogo-export-"));
  const htmlPath = resolve(exportDir, "model.html");
  await (await htmlDownload).saveAs(htmlPath);
  const html = readFileSync(htmlPath, "utf8");
  expect(html).not.toContain("installNetLogoBridge");
  const standalone = await context.newPage();
  await standalone.goto(pathToFileURL(htmlPath).href);
  await run(standalone.mainFrame());
  await standalone.close();
  rmSync(exportDir, { recursive: true, force: true });
  await frame.locator(".netlogo-button").filter({ hasText: /^\s*crash\s*$/ }).click();
  await expect(page.getByRole("log", { name: "Artifact console" })).toContainText("Intentional NetLogo runtime error");
  const roundtrip = await open(page, exported, "roundtrip.nlogox");
  await run(roundtrip.frame);
});

test("legacy NetLogo source runs unchanged and raw downloads preserve bytes", async ({ page }) => {
  await login(page);
  const source = "\ufeff" + legacy.replaceAll("\n", "\r\n");
  const { frame, launch } = await open(page, source, "legacy.nlogo");
  await run(frame);
  const raw = await runtimeResponse(page, launch, true);
  expect(raw.status()).toBe(200);
  expect(await raw.body()).toEqual(Buffer.from(source));
});

test("NetLogo gets isolated origins and a scoped compiler policy without app access", async ({ page }) => {
  await login(page);
  const { frame, launch } = await open(page);
  await run(frame);
  const response = await runtimeResponse(page, launch);
  const policy = response.headers()["content-security-policy"]!;
  expect(policy).toContain("'unsafe-eval'");
  expect(policy).toContain("form-action 'none'");
  expect(policy).toContain("allow-forms");
  expect(new URL(launch.url).origin).not.toBe(c.runtimeOrigin);
  const wrongHost = await page.request.get(`${c.runtimeOrigin}${new URL(launch.url).pathname}?lab-entry=1`);
  expect(wrongHost.status()).toBe(403);
  expect((await runtimeResponse(page, launch, false, { "Service-Worker": "script" })).status()).toBe(403);
  const result = await frame.evaluate(async appOrigin => {
    const denied = async (operation: () => unknown) => { try { await operation(); return false; } catch { return true; } };
    localStorage.setItem("netlogo-isolation-probe", "first launch");
    return {
      parent: await denied(() => parent.document.body),
      app: await denied(() => fetch(`${appOrigin}/api/session`, { credentials: "include" })),
      external: await denied(() => fetch("https://example.com/netlogo-probe")),
      serviceWorker: await denied(() => navigator.serviceWorker.register("/forbidden-worker.js")),
      cookies: document.cookie,
    };
  }, c.appOrigin);
  expect(result).toEqual({ parent: true, app: true, external: true, serviceWorker: true, cookies: "" });
  const before = await frame.evaluate(() => (window as any).session.widgetController.code());
  await page.evaluate(() => document.querySelector("iframe")!.contentWindow!.postMessage({ type: "nlw-set-model-code", codeTabContents: "this is forged", autoRecompile: true }, "*"));
  await frame.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
  expect(await frame.evaluate(() => (window as any).session.widgetController.code())).toBe(before);
  const reload = page.waitForResponse(r => r.url().endsWith("/launch") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  const next = await (await reload).json() as Launch;
  expect(new URL(next.url).origin).not.toBe(new URL(launch.url).origin);
  await expect.poll(() => page.frames().find(f => f.url().startsWith(new URL(next.url).origin))?.url()).toBeTruthy();
  const nextFrame = page.frames().find(f => f.url().startsWith(new URL(next.url).origin))!;
  await run(nextFrame);
  expect(await nextFrame.evaluate(() => localStorage.getItem("netlogo-isolation-probe"))).toBeNull();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(async () => (await runtimeResponse(page, next)).status()).toBe(404);
});

test("initial compiler and malformed-file failures surface in the host console", async ({ page }) => {
  await login(page);
  await open(page, starter.replace("forward step-length", "missing-netlogo-command"));
  await page.getByRole("button", { name: "Console", exact: true }).click();
  await expect(page.getByRole("log", { name: "Artifact console" })).toContainText(/compile|MISSING-NETLOGO-COMMAND/i);
  await open(page, "invalid model contents", "broken.nlogox");
  await page.getByRole("button", { name: "Console", exact: true }).click();
  await expect(page.getByRole("log", { name: "Artifact console" })).toContainText(/NetLogo|compile|file|sections/i);
});


const extensionModel = starter.replace(/<code>[\s\S]*?<\/code>/, `<code><![CDATA[
extensions [array table csv matrix store fetch]
globals [extension-result file-result store-result external-result]
to setup
  clear-all
  let values array:from-list [3 5 8]
  array:set values 1 7
  let totals table:make
  table:put totals "total" sum array:to-list values
  let rows csv:from-string "name,value\\nalpha,11\\n"
  let determinant matrix:det matrix:from-row-list [[1 2] [3 4]]
  set extension-result (list (table:get totals "total") (item 1 item 1 rows) determinant)
  set file-result "waiting"
  set store-result "waiting"
  set external-result "waiting"
  store:put "probe" "stored value" [ store:get "probe" [ value -> set store-result value ] ]
  fetch:url-async "data/values.csv" [ text -> set file-result csv:from-string text ]
  reset-ticks
end
to go
  tick
end
to external-data
  fetch:url-async "https://netlogo-data.example/values.csv" [ text -> set external-result csv:from-string text ]
end
]]></code>`).replace("</widgets>", `
  <button x="750" y="10" width="140" height="36" kind="Observer" forever="false" disableUntilTicks="false" display="external data">external-data</button>
  <monitor x="750" y="65" width="210" height="50" fontSize="11" precision="3" display="extension results">extension-result</monitor>
  <monitor x="750" y="125" width="210" height="50" fontSize="11" precision="3" display="companion data">file-result</monitor>
  <monitor x="750" y="185" width="210" height="50" fontSize="11" precision="3" display="stored data">store-result</monitor>
  <monitor x="750" y="245" width="210" height="50" fontSize="11" precision="3" display="external results">external-result</monitor>
</widgets>`);

test("bundled extensions read companion Git data and only explicitly allowed external data", async ({ page }) => {
  test.setTimeout(60000);
  await login(page);
  let externalRequests = 0;
  await page.route("https://netlogo-data.example/**", async route => {
    externalRequests++;
    await route.fulfill({ status: 200, contentType: "text/csv", headers: { "Access-Control-Allow-Origin": "*" }, body: "external,23\n" });
  });
  const { frame, project } = await open(page, extensionModel, "extensions.nlogox", [{ path: "data/values.csv", content: "local,17\n" }]);
  await run(frame);
  const results = frame.locator(".netlogo-monitor").filter({ hasText: "extension results" });
  await expect(results).toContainText("[18 11 ");
  const determinant = Number((await results.innerText()).match(/\[18 11 ([^\]]+)\]/)![1]);
  expect(determinant).toBeCloseTo(-2, 5);
  await expect(frame.locator(".netlogo-monitor").filter({ hasText: "companion data" })).toContainText('[[local 17]]');
  await expect(frame.locator(".netlogo-monitor").filter({ hasText: "stored data" })).toContainText("stored value");
  await frame.locator(".netlogo-button").filter({ hasText: /^\s*external data\s*$/ }).click();
  await expect(frame.locator("#alert-container")).toContainText("Could not fetch resource");
  expect(externalRequests).toBe(0);
  const allowed = await page.request.patch(`/api/projects/${project.id}`, {
    headers: { Origin: c.appOrigin }, data: { expectedMetadataVersion: project.metadataVersion, dataOrigins: ["https://netlogo-data.example"] },
  });
  expect(allowed.status()).toBe(200);
  const launched = page.waitForResponse(r => r.url().endsWith("/launch") && r.request().method() === "POST");
  await page.reload();
  const launch = await (await launched).json() as Launch;
  await expect.poll(() => page.frames().find(f => f.url().startsWith(new URL(launch.url).origin))?.url()).toBeTruthy();
  const permitted = page.frames().find(f => f.url().startsWith(new URL(launch.url).origin))!;
  await run(permitted);
  await permitted.locator(".netlogo-button").filter({ hasText: /^\s*external data\s*$/ }).click();
  await expect(permitted.locator(".netlogo-monitor").filter({ hasText: "external results" })).toContainText('[[external 23]]');
  expect(externalRequests).toBe(1);
});

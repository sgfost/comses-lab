import { test, expect } from "@playwright/test";
import { readFileSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { config, stateDir, projectRoot } from "../scripts/config.mjs";
const c = config();
const local = JSON.parse(
  readFileSync(resolve(stateDir, "credentials.json"), "utf8"),
);
const owner = local.users.find(
  (u: { username: string }) => u.username === "ada",
);
async function signIn(page: import("@playwright/test").Page, name = "ada") {
  const account = local.users.find(
    (u: { username: string }) => u.username === name,
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill(account.username);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}
test("real source, ordinary model UI, navigation and isolation", async ({
  page,
  request,
}) => {
  const anonymous = await request.get("/api/projects");
  expect(anonymous.ok()).toBeTruthy();
  const { projects } = await anonymous.json();
  expect(projects.every((project: { visibility: string }) => project.visibility === "public")).toBe(true);
  const project = projects.find((project: { forgejoRepo: string }) => project.forgejoRepo === "commons-garden");
  expect(project).toBeDefined();
  const id = project.id;
  const source = await request.get(`/api/projects/${id}/tree`);
  expect(source.ok()).toBeTruthy();
  const tree = await source.json();
  expect(tree.commit).toMatch(/^[a-f0-9]{40}$/);
  const file = await request.get(
    `/api/projects/${id}/file?commit=${tree.commit}&path=ecology.js`,
  );
  expect((await file.json()).content).toBe(
    readFileSync(resolve(projectRoot, "examples/commons/ecology.js"), "utf8"),
  );
  const clone = mkdtempSync(resolve(stateDir, "git-check-"));
  execFileSync(
    "git",
    [
      "clone",
      "--quiet",
      "--no-checkout",
      `${c.forgejoUrl}/ada/commons-garden.git`,
      clone,
    ],
    {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${owner.username}:${owner.password}`).toString("base64")}`,
      },
    },
  );
  const gitSource = execFileSync(
    "git",
    ["-C", clone, "show", `${tree.commit}:ecology.js`],
    { encoding: "utf8" },
  );
  expect((await file.json()).content).toBe(gitSource);
  const traversal = await request.get(
    `/api/projects/${id}/file?commit=${tree.commit}&path=${encodeURIComponent("../../private-garden/contents/index.html")}`,
  );
  expect(traversal.status()).toBe(400);
  await signIn(page);
  await page
    .getByRole("link")
    .filter({
      has: page.getByRole("heading", {
        name: "The commons garden",
        exact: true,
      }),
    })
    .click();
  await expect(page.getByLabel("Source code")).toContainText(
    "The commons garden",
  );
  // Existing dark preferences must not obscure the light-only workspace.
  await page.evaluate(() => localStorage.setItem("lab-theme", "dark"));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  await expect(page.getByLabel("Source code")).toContainText("The commons garden");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  await expect(page.getByRole("button", { name: /Switch to .* mode/ })).toHaveCount(0);
  await page.screenshot({
    path: "test-results/foundation-light.png",
    fullPage: true,
  });
  await expect(page.locator('iframe[title="Artifact preview"]')).toBeVisible();
  const frame = page.frameLocator('iframe[title="Artifact preview"]');
  await expect(
    frame.getByRole("heading", { name: "The commons garden" }),
  ).toBeVisible();
  await expect(frame.locator("#season")).toHaveText("0");
  await frame.getByRole("button", { name: "Next season" }).click();
  await expect(frame.locator("#season")).toHaveText("1");
  const modelFrame = page
    .frames()
    .find((f) => f.url().startsWith(c.runtimeOrigin))!;
  const probe = await modelFrame.evaluate(async (appOrigin) => {
    const denied = (fn: () => unknown) => {
      try {
        fn();
        return false;
      } catch {
        return true;
      }
    };
    const parentDenied = denied(() => parent.document.body.innerHTML);
    const cookieDenied = denied(() => document.cookie);
    const storageDenied = denied(() => localStorage.getItem("probe"));
    let apiDenied = false;
    try {
      await fetch(`${appOrigin}/api/session`, { credentials: "include" });
    } catch {
      apiDenied = true;
    }
    parent.postMessage(
      { type: "lab-admin", action: "delete", id: "forged" },
      "*",
    );
    return { parentDenied, cookieDenied, storageDenied, apiDenied };
  }, c.appOrigin);
  expect(probe).toEqual({
    parentDenied: true,
    cookieDenied: true,
    storageDenied: true,
    apiDenied: true,
  });
  const cookie = (await page.context().cookies()).find(
    (item) => item.name === "lab_session",
  )!;
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe("Strict");
  expect(cookie.domain).toBe("localhost");
  expect(cookie.path).toBe("/api");
  expect(await page.context().cookies(c.runtimeOrigin)).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollHeight <= innerHeight,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/foundation-workspace.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(frame.locator("#season")).toHaveText("0");
  await page.getByRole("link", { name: "Explore", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^Artifacts/ })).toBeVisible();
});
test("source permissions, session revocation, cross-origin rejection and dev secrets", async ({
  page,
  request,
}) => {
  await signIn(page);
  const projects = await (await page.request.get("/api/projects")).json();
  const privateProject = projects.projects.find(
    (p: { forgejoRepo: string }) => p.forgejoRepo === "private-garden",
  );
  expect(privateProject).toBeTruthy();
  const privateTree = await (
    await page.request.get(`/api/projects/${privateProject.id}/tree`)
  ).json();
  const ownerSession = (await page.context().cookies()).find(
    (item) => item.name === "lab_session",
  )!.value;
  for (const path of [
    `/api/projects/${privateProject.id}`,
    `/api/projects/${privateProject.id}/tree`,
    `/api/projects/${privateProject.id}/file?commit=${privateTree.commit}&path=index.html`,
  ])
    expect((await request.get(path)).status()).toBe(404);
  const forbidden = await page.request.post(
    `/api/projects/${privateProject.id}/launch`,
    {
      headers: { Origin: c.runtimeOrigin },
      data: { commit: privateTree.commit },
    },
  );
  expect(forbidden.status()).toBe(403);
  for (const suffix of ["", "?raw", "?url"]) {
    for (const path of [
      `/@fs/${stateDir}/credentials.json${suffix}`,
      `/@fs/${stateDir}/lab.sqlite${suffix}`,
      `/@fs/${projectRoot}/server/config.ts${suffix}`,
    ]) {
      const response = await request.get(path);
      expect(response.status()).toBeGreaterThanOrEqual(400);
    }
  }
  await page.getByRole("button", { name: "Sign out" }).click();
  const revoked = await request.get("/api/session", {
    headers: { Cookie: `lab_session=${ownerSession}` },
  });
  expect((await revoked.json()).user).toBeNull();
  await signIn(page, "cy");
  expect(
    (
      await page.request.get(`/api/projects/${privateProject.id}/tree`)
    ).status(),
  ).toBe(404);
  expect(
    (
      await page.request.post(`/api/projects/${privateProject.id}/launch`, {
        headers: { Origin: c.appOrigin },
        data: { commit: privateTree.commit },
      })
    ).status(),
  ).toBe(404);
});

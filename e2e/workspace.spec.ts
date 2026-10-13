import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config, stateDir, instance } from "../scripts/config.mjs";
if (!instance.startsWith("test-"))
  throw new Error("Workspace acceptance requires an isolated test instance");
const settings = config();
const credentials = JSON.parse(
  readFileSync(resolve(stateDir, "credentials.json"), "utf8"),
);
const owner = credentials.users.find(
  (user: { username: string }) => user.username === "ada",
);
const runId = randomUUID().slice(0, 8);
const branch = `workspace/${runId}`;
let projectId: string;
let clone: string;
let firstCommit: string;
let latestCommit: string;
let stressCommit: string;
let expectedSource: string;
let expectedPatch: string;
function git(...args: string[]) {
  return execFileSync("git", args, {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${owner.username}:${owner.password}`).toString("base64")}`,
    },
  });
}
async function login(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill(owner.username);
  await page.getByLabel("Password", { exact: true }).fill(owner.password);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}
async function revision(page: Page, value: string) {
  await page
    .getByRole("button", { name: "Git details", exact: true })
    .click();
  await page.getByLabel("Revision", { exact: true }).fill(value);
  await page.getByRole("button", { name: "Go", exact: true }).click();
}
async function openProject(page: Page) {
  await page.goto(
    `/#/project/${projectId}?edit=1&ref=${encodeURIComponent(`refs/heads/${branch}`)}`,
  );
  await expect(page.getByLabel("Selected commit", { exact: true })).toHaveText(
    latestCommit.slice(0, 12),
  );
  await page.getByRole("button", { name: "Console", exact: true }).click();
}

test.beforeAll(async ({ request }) => {
  const projects = await (await request.get("/api/projects")).json();
  projectId = projects.projects.find(
    (project: { forgejoRepo: string }) =>
      project.forgejoRepo === "commons-garden",
  ).id;
  clone = mkdtempSync(resolve(stateDir, "workspace-check-"));
  git(
    "clone",
    "--quiet",
    `${settings.forgejoUrl}/ada/commons-garden.git`,
    clone,
  );
  git("-C", clone, "checkout", "--quiet", "-b", branch);
  mkdirSync(resolve(clone, "nested"), { recursive: true });
  writeFileSync(
    resolve(clone, "nested/notes.md"),
    `# Workspace notes\n\nFixture ${runId}.\n`,
  );
  writeFileSync(resolve(clone, "empty.txt"), "");
  writeFileSync(resolve(clone, "binary.bin"), Buffer.from([0, 255, 3, 128]));
  writeFileSync(
    resolve(clone, "long-file.js"),
    Array.from(
      { length: 400 },
      (_, index) => `export const value${index} = ${index};`,
    ).join("\n") + "\n",
  );
  const original = readFileSync(resolve(clone, "ecology.js"), "utf8");
  writeFileSync(
    resolve(clone, "ecology.js"),
    original + `\n// baseline ${runId}\n`,
  );
  git("-C", clone, "add", ".");
  git(
    "-C",
    clone,
    "-c",
    "user.name=Workspace acceptance",
    "-c",
    "user.email=workspace@lab.invalid",
    "commit",
    "--quiet",
    "-m",
    `Workspace baseline ${runId}`,
  );
  firstCommit = git("-C", clone, "rev-parse", "HEAD").trim();
  git("-C", clone, "tag", branch);
  writeFileSync(
    resolve(clone, "ecology.js"),
    original + `\n// selected revision ${runId}\n`,
  );
  git("-C", clone, "add", "ecology.js");
  git(
    "-C",
    clone,
    "-c",
    "user.name=Workspace acceptance",
    "-c",
    "user.email=workspace@lab.invalid",
    "commit",
    "--quiet",
    "-m",
    `Workspace change ${runId}`,
  );
  latestCommit = git("-C", clone, "rev-parse", "HEAD").trim();
  git(
    "-C",
    clone,
    "push",
    "--quiet",
    "origin",
    `refs/heads/${branch}`,
    `refs/tags/${branch}`,
  );
  expectedSource = git("-C", clone, "show", `${latestCommit}:ecology.js`);
  expectedPatch = git(
    "-C",
    clone,
    "-c",
    "core.quotePath=false",
    "diff",
    firstCommit,
    latestCommit,
  );
  git("-C", clone, "checkout", "--quiet", "-b", `${branch}-stress`);
  writeFileSync(
    resolve(clone, "large-patch.txt"),
    "x\n".repeat(300_000) + "LAST_PATCH_LINE\n",
  );
  git("-C", clone, "add", "large-patch.txt");
  git(
    "-C",
    clone,
    "-c",
    "user.name=Workspace acceptance",
    "-c",
    "user.email=workspace@lab.invalid",
    "commit",
    "--quiet",
    "-m",
    `Large patch ${runId}`,
  );
  stressCommit = git("-C", clone, "rev-parse", "HEAD").trim();
  git("-C", clone, "push", "--quiet", "origin", `refs/heads/${branch}-stress`);
});

test("select exact source, history, first-parent diff, branch and tag", async ({
  page,
}) => {
  await login(page);
  await openProject(page);
  await page
    .getByRole("treeitem", { name: "ecology.js", exact: false })
    .click();
  await expect(page.getByLabel("Source code", { exact: true })).toContainText(
    `selected revision ${runId}`,
  );
  expect(
    (await page.locator(".cm-content .cm-line").allTextContents()).join("\n"),
  ).toBe(expectedSource);
  await page.getByRole("button", { name: "Find in file", exact: true }).click();
  await expect(page.locator(".cm-search")).toBeVisible();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(
    page.getByRole("button", { name: new RegExp(`^Workspace change ${runId}`) }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: `Compare Workspace change ${runId}`,
      exact: true,
    })
    .click();
  await expect(page.getByLabel("Commit diff")).toContainText(
    `+// selected revision ${runId}`,
  );
  const visiblePatch = (
    await page.getByLabel("Commit diff").locator(".cm-line").allTextContents()
  ).join("\n");
  expect(visiblePatch?.trimEnd()).toBe(expectedPatch.trimEnd());
  await page
    .getByRole("button", { name: new RegExp(`^Workspace baseline ${runId}`) })
    .click();
  await expect(page.getByLabel("Selected commit", { exact: true })).toHaveText(
    firstCommit.slice(0, 12),
  );
  await expect(page.getByLabel("Source code", { exact: true })).toContainText(
    `baseline ${runId}`,
  );
  await page.reload();
  await expect(page.getByLabel("Selected commit", { exact: true })).toHaveText(
    firstCommit.slice(0, 12),
  );
  await page
    .getByRole("treeitem", { name: "ecology.js", exact: false })
    .click();
  await expect(page.getByLabel("Source code", { exact: true })).toContainText(
    `baseline ${runId}`,
  );
  await revision(page, `refs/heads/${branch}`);
  await expect(page.getByLabel("Selected commit", { exact: true })).toHaveText(
    latestCommit.slice(0, 12),
  );
  await page
    .getByRole("button", { name: "Git details", exact: true })
    .click();
  await page.getByRole("button", { name: "Tags", exact: true }).click();
  await expect(page.locator(".revision-menu [role=status]")).toHaveCount(0);
  const tagOption = page
    .locator(".revision-option")
    .filter({ hasText: branch });
  while ((await tagOption.count()) === 0) {
    const more = page.getByRole("button", { name: "Load more", exact: true });
    await expect(more).toBeVisible();
    await more.click();
    await expect(page.locator(".revision-menu [role=status]")).toHaveCount(0);
  }
  await tagOption.click();
  await expect(page.getByLabel("Selected commit", { exact: true })).toHaveText(
    firstCommit.slice(0, 12),
  );
  await expect(page.locator('iframe[title="Artifact preview"]')).toBeVisible();
  await expect(
    page.frameLocator("iframe").getByRole("button", { name: "Next season" }),
  ).toBeVisible();
  await expect(page.locator(".version-context")).toContainText("Earlier version");
  await page.getByRole("link", { name: "Explore", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^Artifacts/ })).toBeVisible();
});

test("file states, Find, stale responses and all pane boundaries", async ({
  page,
}) => {
  await openProject(page);
  await page.getByRole("treeitem", { name: "nested", exact: false }).click();
  await page.getByRole("treeitem", { name: "notes.md", exact: false }).click();
  await expect(page.getByLabel("Source code", { exact: true })).toContainText(
    `# Workspace notes`,
  );
  await page.getByRole("treeitem", { name: "empty.txt", exact: false }).click();
  await expect(page.getByText("Empty file", { exact: true })).toBeVisible();
  await page
    .getByRole("treeitem", { name: "binary.bin", exact: false })
    .click();
  await expect(page.locator(".code-pane [role=alert]")).toBeVisible();
  await expect(page.locator(".code-pane")).not.toContainText("Loading file");
  let release!: () => void, captured!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    captured = resolve;
  });
  await page.route(/\/file\?.*path=ecology\.js/, async (route) => {
    const response = await route.fetch();
    captured();
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  await page
    .getByRole("treeitem", { name: "ecology.js", exact: false })
    .click();
  await started;
  await page.getByRole("treeitem", { name: "notes.md", exact: false }).click();
  await expect(page.getByLabel("Source code", { exact: true })).toContainText(
    "Workspace notes",
  );
  release();
  await page.unrouteAll({ behavior: "wait" });
  await expect(page.getByLabel("Source code", { exact: true })).toContainText(
    "Workspace notes",
  );
  await page
    .getByRole("treeitem", { name: "long-file.js", exact: false })
    .click();
  await expect(page.getByLabel("Source code", { exact: true })).toContainText(
    "value0",
  );
  await page.locator(".cm-scroller").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByLabel("Source code", { exact: true })).toContainText(
    "value399",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollHeight <= innerHeight,
    ),
  ).toBe(true);
  const code = page.locator(".code-pane");
  const before = await code.boundingBox();
  const horizontal = page.getByRole("separator", {
    name: "Resize code and console",
    exact: true,
  });
  await horizontal.focus();
  await page.keyboard.press("ArrowUp");
  expect((await code.boundingBox())!.height).toBeLessThan(before!.height);
  const boundary = await horizontal.boundingBox();
  await page.mouse.move(boundary!.x + boundary!.width / 2, boundary!.y + 2);
  await page.mouse.down();
  await page.mouse.move(boundary!.x + boundary!.width / 2, boundary!.y - 60);
  await page.mouse.up();
  expect((await code.boundingBox())!.height).toBeLessThan(before!.height - 30);
  await page
    .getByRole("separator", { name: "Resize sidebar", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  await page
    .getByRole("separator", { name: "Resize source and preview", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("button", { name: "About artifact", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Open README.md", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Open README.md", exact: true })
    .click();
  await expect(page.getByLabel("Source code", { exact: true })).toContainText(
    "The commons garden",
  );
  await page.screenshot({
    path: "test-results/workspace-light.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 960, height: 720 });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.documentElement.scrollHeight <= innerHeight,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/workspace-light-narrow.png",
    fullPage: true,
  });
  const sidebarToggle = page.getByRole("button", {
    name: "Files",
    exact: true,
  });
  await sidebarToggle.click();
  await expect(page.locator("aside.sidebar")).toHaveCount(0);
  await sidebarToggle.click();
  await expect(page.locator("aside.sidebar")).toBeVisible();
});

test("host console rejects foreign or malformed messages and bounds model output", async ({
  page,
  request,
}) => {
  await login(page);
  await openProject(page);
  await expect(page.locator('iframe[title="Artifact preview"]')).toBeVisible();
  const iframe = page.frameLocator('iframe[title="Artifact preview"]');
  await expect(
    iframe.getByRole("button", { name: "Next season" }),
  ).toBeVisible();
  const model = page
    .frames()
    .find((frame) => frame.url().startsWith(settings.runtimeOrigin))!;
  const url = model.url();
  const launchId = new URL(url).pathname.split("/")[2]!;
  const base = { channel: "lab-runtime", version: 1, launchId };
  await page.evaluate(
    (data) =>
      window.postMessage(
        { ...data, type: "console", level: "log", text: "FOREIGN_WINDOW" },
        "*",
      ),
    base,
  );
  await model.evaluate((data) => {
    parent.postMessage(
      {
        ...data,
        type: "console",
        level: "log",
        text: "MALFORMED_EVENT",
        extra: true,
      },
      "*",
    );
    parent.postMessage(
      {
        ...data,
        launchId: "x".repeat(43),
        type: "console",
        level: "log",
        text: "WRONG_LAUNCH",
      },
      "*",
    );
    parent.postMessage(
      { ...data, type: "console", level: "log", text: "VALID_MODEL_MESSAGE" },
      "*",
    );
    parent.postMessage(
      { ...data, type: "error", text: "MODEL_ERROR_TEXT" },
      "*",
    );
    parent.postMessage(
      { ...data, type: "console", level: "log", text: "OVERSIZED".repeat(600) },
      "*",
    );
    const channel = new MessageChannel();
    parent.postMessage(
      { ...data, type: "console", level: "log", text: "TRANSFERRED_PORT" },
      "*",
      [channel.port1],
    );
    channel.port2.close();
  }, base);
  const output = page.getByRole("log", { name: "Artifact console", exact: true });
  await expect(output).toContainText("VALID_MODEL_MESSAGE");
  await expect(output).toContainText("MODEL_ERROR_TEXT");
  await expect(output).not.toContainText("FOREIGN_WINDOW");
  await expect(output).not.toContainText("MALFORMED_EVENT");
  await expect(output).not.toContainText("WRONG_LAUNCH");
  await expect(output).not.toContainText("OVERSIZED");
  await expect(output).not.toContainText("TRANSFERRED_PORT");
  await page.getByLabel("Filter console", { exact: true }).fill("MODEL_ERROR");
  await expect(output).not.toContainText("VALID_MODEL_MESSAGE");
  await page.getByLabel("Filter console", { exact: true }).fill("");
  await model.evaluate((data) => {
    for (let n = 0; n < 240; n++)
      parent.postMessage(
        {
          ...data,
          type: "console",
          level: "log",
          text: `${n} multiline\n`.repeat(10),
        },
        "*",
      );
  }, base);
  await expect(output).toContainText("Console rate limit reached");
  expect(await output.locator(":scope > div").count()).toBeLessThanOrEqual(
    1000,
  );
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator("iframe")).toHaveCount(0, { timeout: 1000 });
  await expect.poll(async () => (await request.get(url)).status()).toBe(404);
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(
    iframe.getByRole("button", { name: "Next season" }),
  ).toBeVisible();
  await expect(output).not.toContainText("MODEL_ERROR_TEXT");
});

test("explicit selection wins delayed initialization and large diffs stay usable", async ({
  page,
}) => {
  let release!: () => void;
  let reached!: () => void;
  let fulfilled!: () => void;
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = new Promise<void>((resolve) => {
    fulfilled = resolve;
  });
  await page.route(
    `**/api/projects/${projectId}/refs?kind=branch*`,
    async (route) => {
      const response = await route.fetch();
      reached();
      await gate;
      await route.fulfill({ response });
      fulfilled();
    },
    { times: 1 },
  );
  await page.goto(`/#/project/${projectId}?edit=1&ref=${latestCommit}`);
  await waiting;
  await revision(page, firstCommit);
  await expect(page.getByLabel("Selected commit", { exact: true })).toHaveText(
    firstCommit.slice(0, 12),
  );
  release();
  await done;
  await expect(page.locator(".revision-menu [role=status]")).toHaveCount(0);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: new RegExp(`^Workspace baseline ${runId}`),
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Selected commit", { exact: true })).toHaveText(
    firstCommit.slice(0, 12),
  );
  await revision(page, stressCommit);
  await page
    .getByRole("button", {
      name: `Compare Large patch ${runId}`,
      exact: true,
    })
    .click();
  const diff = page.getByLabel("Commit diff");
  await expect(diff).toContainText("diff --git");
  expect(await diff.locator(".cm-line").count()).toBeLessThan(200);
  await diff.focus();
  await diff.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
  await expect(diff).toContainText("+LAST_PATCH_LINE");
  expect(await diff.locator(".cm-line").count()).toBeLessThan(200);
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(
    page.getByRole("treeitem", { name: "large-patch.txt", exact: false }),
  ).toBeVisible();
});

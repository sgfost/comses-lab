import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config, stateDir } from "../scripts/config.mjs";

// The dialog briefly displays a credential; never capture it in screenshots or traces.
test.use({ screenshot: "off", trace: "off" });
const settings = config();
const owner = JSON.parse(readFileSync(resolve(stateDir, "credentials.json"), "utf8")).users.find((user: { username: string }) => user.username === "ada");
const headers = { Origin: settings.appOrigin };
test("Agents dialog issues explicit scopes, hides the secret after closing, and revokes", async ({ page }) => {
  test.setTimeout(60_000);
  await page.request.post("/api/session", { headers, data: owner });
  const name = `Local agent ${randomUUID().slice(0, 8)}`;
  const created = await page.request.post("/api/projects", { headers, data: { requestId: randomUUID(), templateId: "worker", title: name, visibility: "private" } });
  expect(created.status()).toBe(201);
  const project = (await created.json()).project;
  await page.goto("/");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByText("Create a token manually", { exact: true }).click();
  await page.getByLabel(`Agent permission for ${name}`, { exact: true }).selectOption("write");
  await page.getByLabel("Token name", { exact: true }).fill(name);
  await page.getByLabel("Allow creation of artifacts and libraries", { exact: true }).check();
  const issuing = page.waitForResponse(response => response.url().endsWith("/api/agent-grants") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  const response = await issuing;
  expect(response.status()).toBe(201);
  const result = await response.json();
  try {
    expect(result.grant.projects).toEqual([{ projectId: project.id, permission: "write" }]);
    expect(result.grant.allowCreate).toBe(true);
    await expect(page.getByRole("region", { name: "New agent token" })).toBeVisible();
    // Compare booleans so a failed assertion cannot print the one-time secret.
    expect((await page.locator(".secret").textContent()) === result.token && result.token.length === 43).toBe(true);
    await page.getByRole("button", { name: "Close agents", exact: true }).click();
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await expect(page.getByRole("region", { name: "New agent token" })).toHaveCount(0);
    const row = page.locator(".grant-row").filter({ hasText: name });
    await row.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(row).toContainText("revoked");
    const guide = await page.request.get("/api/agent-guide");
    expect(guide.status()).toBe(200);
    expect(await guide.text()).toContain("Normal Git workflow");
  } finally {
    await page.request.delete(`/api/agent-grants/${result.grant.id}`, { headers });
    await page.request.delete("/api/session", { headers });
  }
});

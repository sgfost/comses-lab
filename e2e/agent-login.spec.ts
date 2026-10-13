import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { config, stateDir } from "../scripts/config.mjs";

test.use({ screenshot: "off", trace: "off" });
const settings = config();
const accounts = JSON.parse(readFileSync(resolve(stateDir, "credentials.json"), "utf8"));
const owner = accounts.users.find((user: { username: string }) => user.username === "ada");
const headers = { Origin: settings.appOrigin };

test("agent starts login, human signs in and approves, agent forks and uses Git, human revokes", async ({ page, playwright }) => {
  test.setTimeout(60_000);
  const client = await playwright.request.newContext({ baseURL: settings.appOrigin });
  const human = await playwright.request.newContext({ baseURL: settings.appOrigin });
  let grantId = "";
  try {
    await human.post("/api/session", { headers, data: owner });
    const made = await human.post("/api/projects", { headers, data: { requestId: randomUUID(), templateId: "worker", title: `Login source ${randomUUID().slice(0, 8)}`, visibility: "private" } });
    expect(made.status()).toBe(201);
    const source = await made.json();
    const start = await client.post("/api/agent-login", { data: { name: "Local research agent", allowCreate: true, projects: [{ projectId: source.project.id, permission: "read" }] } });
    expect(start.status()).toBe(201);
    const login = await start.json();
    // Assert booleans so assertion output cannot reveal the private device code.
    expect(login.device_code.length === 43 && !login.verification_uri_complete.includes(login.device_code)).toBe(true);
    await page.goto(login.verification_uri_complete);
    await page.getByRole("button", { name: "Sign in to approve", exact: true }).click();
    await page.getByLabel("Username", { exact: true }).fill(owner.username);
    await page.getByLabel("Password", { exact: true }).fill(owner.password);
    await page.getByRole("dialog").getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText(`@${owner.username}`, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Allow access", exact: true })).toBeDisabled();
    await expect(page.getByLabel(`Agent permission for ${source.project.title}`, { exact: true })).toHaveValue("read");
    await page.getByLabel("This matches the code shown by my agent", { exact: true }).check();
    await page.getByRole("button", { name: "Allow access", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Access approved");
    expect((await page.locator("body").textContent())?.includes(login.device_code)).toBe(false);
    const delivered = await client.post("/api/agent-login/token", { data: { device_code: login.device_code } });
    expect(delivered.status()).toBe(200);
    const auth = await delivered.json();
    grantId = auth.grant.id;
    expect(auth.grant.projects).toEqual([{ projectId: source.project.id, permission: "read" }]);
    const agent = await playwright.request.newContext({ baseURL: settings.appOrigin, extraHTTPHeaders: { Authorization: `Bearer ${auth.token}` } });
    try {
      expect((await (await agent.get("/api/agent")).json()).user.username).toBe(owner.username);
      const forked = await agent.post(`/api/projects/${source.project.id}/forks`, { data: { requestId: randomUUID(), commit: source.commit, title: "Browser-approved fork", visibility: "private" } });
      expect(forked.status()).toBe(201);
      const fork = await forked.json();
      const issued = await agent.post(`/api/agent-grants/${grantId}/git-credentials`, { data: { requestId: randomUUID(), projectId: fork.project.id, permission: "write" } });
      expect(issued.status()).toBe(201);
      const git = await issued.json();
      const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${git.credential.username}:${git.token}`).toString("base64")}` };
      expect(spawnSync("git", ["-c", "credential.helper=", "ls-remote", git.credential.url], { env, timeout: 15000 }).status).toBe(0);
      await page.getByRole("button", { name: "Agents", exact: true }).click();
      const row = page.locator(".grant-row").filter({ hasText: "Local research agent" });
      await row.getByRole("button", { name: "Revoke", exact: true }).click();
      await expect(row).toContainText("revoked");
      expect((await agent.get("/api/agent")).status()).toBe(401);
      expect(spawnSync("git", ["-c", "credential.helper=", "ls-remote", git.credential.url], { env, timeout: 15000 }).status).not.toBe(0);
    } finally { await agent.dispose(); }
    const again = await client.post("/api/agent-login/token", { data: { device_code: login.device_code } });
    expect((await again.json()).error.code).toBe("authorization_consumed");
  } finally {
    if (grantId) await human.delete(`/api/agent-grants/${grantId}`, { headers });
    await human.dispose();
    await client.dispose();
  }
});

test("pending polling backs off; denial and expiry never issue credentials", async ({ page, playwright }) => {
  const client = await playwright.request.newContext({ baseURL: settings.appOrigin });
  const database = new DatabaseSync(resolve(stateDir, "lab.sqlite"));
  try {
    const login = await (await client.post("/api/agent-login", { data: { name: "Denied agent" } })).json();
    const poll = () => client.post("/api/agent-login/token", { data: { device_code: login.device_code } });
    expect((await (await poll()).json()).error.code).toBe("authorization_pending");
    const early = await poll();
    expect(early.status()).toBe(429);
    expect((await early.json()).interval).toBe(10);
    expect(early.headers()["retry-after"]).toBe("10");
    await page.request.post("/api/session", { headers, data: owner });
    await page.goto(login.verification_uri_complete);
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Access denied.");
    expect((await (await poll()).json()).error.code).toBe("access_denied");
    const second = await (await client.post("/api/agent-login", { data: { name: "Expired agent" } })).json();
    database.prepare("UPDATE agent_logins SET expires_at=? WHERE device_hash=?").run(Date.now() - 1, createHash("sha256").update(second.device_code).digest("hex"));
    const expired = await client.post("/api/agent-login/token", { data: { device_code: second.device_code } });
    expect((await expired.json()).error.code).toBe("expired_token");
    await page.goto(second.verification_uri_complete);
    await expect(page.getByRole("alert")).toContainText("invalid or expired");
    expect(database.prepare("SELECT count(*) AS n FROM agent_logins WHERE user_code IN (?,?) AND grant_id IS NOT NULL").get(login.user_code.replaceAll("-", ""), second.user_code.replaceAll("-", ""))?.n).toBe(0);
  } finally { database.close(); await client.dispose(); }
});

test("approval requires a human session and origin, scopes can be narrowed, and tokens are handed off once", async ({ request, playwright }) => {
  const client = await playwright.request.newContext({ baseURL: settings.appOrigin });
  let grantId = "";
  const database = new DatabaseSync(resolve(stateDir, "lab.sqlite"));
  try {
    const login = await (await client.post("/api/agent-login", { data: { name: "Restricted agent", allowCreate: true } })).json();
    const path = `/api/agent-login/requests/${login.user_code}`;
    const decision = { decision: "approve", name: "Restricted agent", allowCreate: false, projects: [] };
    expect((await client.get(path)).status()).toBe(401);
    expect((await client.post(path, { headers, data: decision })).status()).toBe(401);
    expect((await client.post("/api/agent-login", { headers: { Origin: "https://foreign.invalid" }, data: { name: "Foreign" } })).status()).toBe(403);
    await request.post("/api/session", { headers, data: owner });
    expect((await request.post("/api/agent-login", { headers, data: { name: "Cookie mixed in" } })).status()).toBe(400);
    expect((await request.post(path, { data: decision })).status()).toBe(403);
    expect((await request.post(path, { headers, data: { ...decision, projects: [{ projectId: "unknown", permission: "write" }] } })).status()).toBe(403);
    expect((await request.post(path, { headers, data: decision })).status()).toBe(200);
    expect((await request.post(path, { headers, data: decision })).status()).toBe(409);
    const responses = await Promise.all([1, 2].map(() => client.post("/api/agent-login/token", { data: { device_code: login.device_code } })));
    expect(responses.map(response => response.status()).sort()).toEqual([200, 400]);
    const auth = await responses.find(response => response.status() === 200)!.json();
    grantId = auth.grant.id;
    expect(auth.grant.allowCreate).toBe(false);
    expect(auth.grant.projects).toEqual([]);
    const row = database.prepare("SELECT token_hash FROM agent_grants WHERE id=?").get(grantId);
    expect(row?.token_hash === createHash("sha256").update(auth.token).digest("hex")).toBe(true);
    const agent = await playwright.request.newContext({ baseURL: settings.appOrigin, extraHTTPHeaders: { Authorization: `Bearer ${auth.token}` } });
    try {
      expect((await agent.post(path, { data: decision })).status()).toBe(403);
      expect((await agent.post("/api/agent-login", { data: { name: "Self approval" } })).status()).toBe(403);
      expect((await agent.post("/api/projects", { data: { requestId: randomUUID(), templateId: "worker", title: "Denied", visibility: "private" } })).status()).toBe(403);
    } finally { await agent.dispose(); }
  } finally {
    if (grantId) await request.delete(`/api/agent-grants/${grantId}`, { headers });
    database.close();
    await client.dispose();
  }
});

test("switching browser accounts keeps the approval link and collection rechecks current access", async ({ page, playwright }) => {
  test.setTimeout(60_000);
  const client = await playwright.request.newContext({ baseURL: settings.appOrigin });
  const human = await playwright.request.newContext({ baseURL: settings.appOrigin });
  const reader = accounts.users.find((user: { username: string }) => user.username === "ben");
  try {
    await human.post("/api/session", { headers, data: owner });
    const made = await human.post("/api/projects", { headers, data: { requestId: randomUUID(), templateId: "worker", title: `Changing access ${randomUUID().slice(0, 8)}`, visibility: "public" } });
    expect(made.status()).toBe(201);
    const source = await made.json();
    const login = await (await client.post("/api/agent-login", { data: { name: "Account switch", projects: [{ projectId: source.project.id, permission: "read" }] } })).json();
    await page.request.post("/api/session", { headers, data: owner });
    await page.goto(login.verification_uri_complete);
    await expect(page.getByText(`@${owner.username}`, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sign in to approve", exact: true })).toBeVisible();
    expect(page.url()).toBe(login.verification_uri_complete);
    await page.getByRole("button", { name: "Sign in to approve", exact: true }).click();
    await page.getByLabel("Username", { exact: true }).fill(reader.username);
    await page.getByLabel("Password", { exact: true }).fill(reader.password);
    await page.getByRole("dialog").getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText(`@${reader.username}`, { exact: true })).toBeVisible();
    await expect(page.getByLabel(`Agent permission for ${source.project.title}`, { exact: true })).toHaveValue("read");
    await page.getByLabel("This matches the code shown by my agent", { exact: true }).check();
    await page.getByRole("button", { name: "Allow access", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Access approved");
    const access = await (await human.get(`/api/projects/${source.project.id}/access`)).json();
    const changed = await human.put(`/api/projects/${source.project.id}/access`, { headers, data: {
      requestId: randomUUID(), expectedVersion: access.version, visibility: "private", groupId: null,
    } });
    expect(changed.status()).toBe(200);
    const collected = await client.post("/api/agent-login/token", { data: { device_code: login.device_code } });
    expect(collected.status()).toBe(403);
    expect((await collected.json()).error.code).toBe("forbidden");
  } finally { await human.dispose(); await client.dispose(); }
});

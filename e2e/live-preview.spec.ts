import { test, expect, type Page } from '@playwright/test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, stateDir } from '../scripts/config.mjs';
import type { CreateProjectResponse, Launch } from '../shared/contracts.ts';
const settings = config();
const accounts = JSON.parse(readFileSync(resolve(stateDir, 'credentials.json'), 'utf8')).users;
const owner = accounts.find((user: { username: string }) => user.username === 'ada');
const headers = { Origin: settings.appOrigin };
const initial = 'export const value = "saved";\n';
async function fixture(page: Page) {
  expect((await page.request.post('/api/session', { headers, data: owner })).status()).toBe(200);
  const response = await page.request.post('/api/projects', { headers, data: { requestId: randomUUID(), templateId: 'commons', title: `Live preview ${randomUUID().slice(0, 8)}`, visibility: 'public' } });
  expect(response.status()).toBe(201);
  const result = await response.json() as CreateProjectResponse;
  const saved = await page.request.post(`/api/projects/${result.project.id}/commits`, { headers, data: { ref: result.ref, expectedCommit: result.commit, message: 'Add live preview fixture', changes: [
    { operation: 'create', path: 'live.js', content: initial },
    { operation: 'update', path: 'index.html', content: '<!doctype html><output></output><script type="module">import {value} from "./live.js";document.querySelector("output").textContent=value;</script>' },
  ] } });
  expect(saved.status()).toBe(201); result.commit = (await saved.json()).commit;
  return result;
}
async function edit(page: Page, value: string) {
  const editor = page.getByLabel('Source code', { exact: true });
  await editor.click(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText(value);
}
test('automatic and live previews use drafts without writing Git, and can be paused', async ({ page }) => {
  test.setTimeout(60000);
  const model = await fixture(page);
  let launches = 0;
  page.on('request', request => { if (request.url().endsWith('/launch') && request.method() === 'POST') launches++; });
  const firstResponse = page.waitForResponse(response => response.url().endsWith('/launch'));
  await page.goto(`/#/project/${model.project.id}?edit=1`);
  const first = await (await firstResponse).json() as Launch;
  const frame = page.frameLocator('iframe[title="Artifact preview"]');
  await expect(frame.locator('output')).toHaveText('saved');
  expect(first.draft).toBeUndefined(); expect(launches).toBe(1);
  await expect(page.getByRole('button', { name: 'Run model', exact: true })).toHaveCount(0);
  await page.getByRole('treeitem', { name: 'live.js', exact: false }).click();
  await expect(page.getByLabel('Source code', { exact: true })).toContainText('saved');
  const changed = page.waitForResponse(response => response.url().endsWith('/launch'));
  await edit(page, 'export const value = "draft";\n');
  await expect(frame.locator('output')).toHaveText('draft');
  const draft = await (await changed).json() as Launch;
  expect(draft.draft).toBe(true); expect(draft.commit).toBe(model.commit);
  await expect(page.locator('.preview-draft')).toHaveText('· Draft');
  expect((await page.request.get(first.url)).status()).toBe(404);
  await page.getByLabel('Live preview', { exact: true }).uncheck();
  await edit(page, 'export const value = "paused edit";\n');
  const count = launches;
  await page.waitForTimeout(1000);
  expect(launches).toBe(count); await expect(frame.locator('output')).toHaveText('draft');
  await page.getByLabel('Live preview', { exact: true }).check();
  await expect(frame.locator('output')).toHaveText('paused edit');
  await edit(page, initial);
  await expect(frame.locator('output')).toHaveText('saved');
  await expect(page.locator('.preview-draft')).toHaveCount(0);
  const clone = mkdtempSync(resolve(stateDir, 'live-git-'));
  try {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${owner.username}:${owner.password}`).toString('base64')}` };
    execFileSync('git', ['clone', '--bare', `${settings.forgejoUrl}/${model.project.forgejoOwner}/${model.project.forgejoRepo}.git`, clone], { env, stdio: 'pipe' });
    expect(execFileSync('git', ['--git-dir', clone, 'rev-parse', 'HEAD'], { env, encoding: 'utf8' }).trim()).toBe(model.commit);
    expect(execFileSync('git', ['--git-dir', clone, 'show', 'HEAD:live.js'], { env, encoding: 'utf8' })).toBe(initial);
  } finally { rmSync(clone, { recursive: true, force: true }); }
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.waitForTimeout(1000);
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.getByLabel('Live preview', { exact: true })).not.toBeChecked();
});

test('stale draft responses are discarded; draft paths, access and ephemeral files are enforced', async ({ page, playwright }) => {
  test.setTimeout(60000);
  const model = await fixture(page);
  await page.goto(`/#/project/${model.project.id}?edit=1`);
  const frame = page.frameLocator('iframe[title="Artifact preview"]');
  await expect(frame.locator('output')).toHaveText('saved');
  await page.getByRole('treeitem', { name: 'live.js', exact: false }).click();
  await expect(page.getByLabel('Source code', { exact: true })).toContainText('saved');
  let release!: () => void, captured!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { captured = resolve; });
  let old: Launch | undefined;
  await page.route('**/api/projects/*/launch', async route => {
    if (route.request().postDataJSON().changes?.some((change: { content?: string }) => change.content?.includes('older draft'))) {
      const response = await route.fetch(); old = await response.json(); captured(); await held; await route.fulfill({ response });
    } else await route.continue();
  });
  await edit(page, 'export const value = "older draft";\n'); await ready;
  await edit(page, 'export const value = "newer draft";\n');
  await expect(frame.locator('output')).toHaveText('newer draft'); release();
  await expect.poll(async () => (await page.request.get(old!.url)).status()).toBe(404);
  await expect(frame.locator('output')).toHaveText('newer draft');
  const endpoint = `/api/projects/${model.project.id}/launch`;
  const invalid = await page.request.post(endpoint, { headers, data: { commit: model.commit, changes: [{ operation: 'create', path: '../escape.js', content: 'bad' }] } });
  expect(invalid.status()).toBe(400);
  const overlay = await page.request.post(endpoint, { headers, data: { commit: model.commit, changes: [
    { operation: 'delete', path: 'live.js' }, { operation: 'create', path: 'extra.js', content: 'export const value = "extra";' },
    { operation: 'update', path: 'index.html', content: '<!doctype html><script type="module" src="./extra.js"></script>' },
  ] } });
  expect(overlay.status()).toBe(200); const temporary = await overlay.json() as Launch;
  expect((await page.request.get(`${settings.runtimeOrigin}/preview/${temporary.id}/live.js`)).status()).toBe(404);
  expect(await (await page.request.get(`${settings.runtimeOrigin}/preview/${temporary.id}/extra.js`)).text()).toContain('extra');
  const reader = await playwright.request.newContext({ baseURL: settings.appOrigin });
  try {
    expect((await reader.post('/api/session', { headers, data: accounts.find((user: {username: string}) => user.username === 'ben') })).status()).toBe(200);
    expect((await reader.post(endpoint, { headers, data: { commit: model.commit, changes: [{ operation: 'update', path: 'live.js', content: 'no' }] } })).status()).toBe(403);
  } finally { await reader.dispose(); }
  await page.request.delete(`/api/launches/${temporary.id}`, { headers: { ...headers, 'Content-Type': 'application/json' } });
});

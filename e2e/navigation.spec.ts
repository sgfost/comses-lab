import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, stateDir } from '../scripts/config.mjs';
const settings = config();
const users = JSON.parse(readFileSync(resolve(stateDir, 'credentials.json'), 'utf8')).users;
const headers = { Origin: settings.appOrigin };
async function login(page: Page, username = 'ada') {
  const response = await page.request.post('/api/session', { headers, data: users.find((user: { username: string }) => user.username === username) });
  expect(response.ok()).toBe(true);
  return (await response.json()).user;
}
const card = (page: Page, title: string) => page.getByRole('link').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

test('visitors see files immediately and can open and dismiss code without editing permission', async ({ page }) => {
  await page.goto('/#/explore/artifacts');
  await card(page, 'Random walks').click();
  await expect(page.getByRole('tree', { name: 'Source files' })).toBeVisible();
  await expect(page.locator('.code-console')).toBeHidden();
  await page.getByRole('treeitem', { name: 'README.md', exact: false }).click();
  await expect(page.getByLabel('Source code', { exact: true })).toHaveAttribute('aria-readonly', 'true');
  await page.getByRole('button', { name: 'Close code view', exact: true }).click();
  await expect(page.locator('.code-console')).toBeHidden();
  await expect(page.getByRole('tree', { name: 'Source files' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Files', exact: true })).toBeFocused();
  await page.getByRole('link', { name: 'My artifacts', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in to your workspace' })).toBeVisible();
  await expect(page.locator('.model-row')).toHaveCount(0);
});

test('owners edit by default; closing tabs or dragging closes code without losing a draft', async ({ page }) => {
  await login(page);
  const created = await page.request.post('/api/projects', { headers, data: { requestId: randomUUID(), templateId: 'worker', title: `Navigation ${randomUUID().slice(0,8)}`, visibility: 'private' } });
  expect(created.status()).toBe(201);
  const { project, commit } = await created.json();
  await page.goto(`/#/project/${project.id}`);
  await expect(page.getByLabel('Source code', { exact: true })).toHaveAttribute('aria-readonly', 'false');
  await page.getByLabel('New file path').fill('notes.md');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.keyboard.insertText('Draft survives closing code.');
  await expect.poll(async () => (await (await page.request.get(`/api/projects/${project.id}/draft`)).json()).draft?.changes.find((change: { path: string }) => change.path === 'notes.md')?.content).toBe('Draft survives closing code.');
  const previewBefore = await page.locator('.preview-pane').boundingBox();
  while (await page.locator('.tab-close').count()) await page.locator('.tab-close').first().click();
  await expect(page.locator('.code-console')).toBeHidden();
  expect((await page.locator('.preview-pane').boundingBox())!.width).toBeGreaterThan(previewBefore!.width);
  await page.reload();
  await expect(page.locator('.code-console')).toBeHidden();
  await page.getByRole('treeitem', { name: 'notes.md', exact: false }).click();
  await expect(page.getByLabel('Source code', { exact: true })).toHaveText('Draft survives closing code.');
  const pane = (await page.locator('.work-panes').boundingBox())!;
  const divider = (await page.getByRole('separator', { name: 'Resize source and preview', exact: true }).boundingBox())!;
  await page.mouse.move(divider.x + divider.width / 2, divider.y + 20);
  await page.mouse.down();
  await page.mouse.move(pane.x + 20, divider.y + 20, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('.code-console')).toBeHidden();
  await page.getByRole('treeitem', { name: 'README.md', exact: false }).click();
  await expect(page.getByLabel('Source code', { exact: true })).toHaveText('Draft survives closing code.');
  expect((await (await page.request.get(`/api/projects/${project.id}/tree?ref=refs/heads/main`)).json()).commit).toBe(commit);
});

for (const [username, permission] of [['ben', 'write'], ['cy', 'read']]) {
  test(`${permission} collaborators find shared artifacts at home with the appropriate default view`, async ({ page }) => {
    await login(page, username);
    await page.goto('/');
    await expect(card(page, 'Group garden study')).toBeVisible();
    await expect(card(page, 'Private garden study')).toHaveCount(0);
    await card(page, 'Group garden study').click();
    await expect(page.getByRole('tree', { name: 'Source files' })).toBeVisible();
    if (permission === 'read') {
      await expect(page.locator('.code-console')).toBeHidden();
      await page.getByRole('treeitem', { name: 'README.md', exact: false }).click();
    }
    await expect(page.getByLabel('Source code', { exact: true })).toHaveAttribute('aria-readonly', permission === 'read' ? 'true' : 'false');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('link', { name: 'My artifacts', exact: true }).click();
    await expect(card(page, 'Group garden study')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}


test('signing in on your artifact opens the editor unless you explicitly chose a view', async ({ page }) => {
  await page.goto('/#/explore/artifacts');
  await card(page, 'Random walks').click();
  await expect(page.locator('.code-console')).toBeHidden();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign in', exact: true });
  const owner = users.find((user: { username: string }) => user.username === 'ada');
  await dialog.getByLabel('Username', { exact: true }).fill(owner.username);
  await dialog.getByLabel('Password', { exact: true }).fill(owner.password);
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('Source code', { exact: true })).toHaveAttribute('aria-readonly', 'false');
  await expect(page.locator('.code-console')).toBeVisible();
});

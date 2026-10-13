import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config, stateDir } from '../scripts/config.mjs';
import type { Project } from '../shared/contracts.js';
const settings = config();
const users = JSON.parse(readFileSync(resolve(stateDir, 'credentials.json'), 'utf8')).users;
const headers = { Origin: settings.appOrigin };
async function login(page: Page, username = 'ada') {
  const response = await page.request.post('/api/session', { headers, data: users.find((user: { username: string }) => user.username === username) });
  expect(response.ok()).toBe(true);
  return (await response.json()).user;
}
const card = (page: Page, title: string) => page.getByRole('link').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

test('personal home separates owned/shared projects from public Explore and remembers each catalog', async ({ page }) => {
  const user = await login(page);
  const projects: Project[] = (await (await page.request.get('/api/projects')).json()).projects;
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /^My artifacts/ })).toBeVisible();
  const mine = projects.filter(item => item.kind === 'model' && (item.ownerId === user.id || item.sharedWithMe));
  await expect(page.locator('.model-row')).toHaveCount(mine.length);
  await page.getByLabel('Project visibility').selectOption('private');
  await page.getByRole('searchbox').fill('Private garden study');
  await card(page, 'Private garden study').click();
  await page.getByRole('link', { name: 'My artifacts', exact: true }).click();
  await expect(page.getByRole('searchbox')).toHaveValue('Private garden study');
  await expect(page.getByLabel('Project visibility')).toHaveValue('private');
  await page.reload();
  await expect(page.getByRole('searchbox')).toHaveValue('Private garden study');
  await page.getByRole('link', { name: 'Explore', exact: true }).click();
  await expect(page.getByLabel('Project visibility')).toHaveCount(0);
  await expect(page.locator('.model-row')).toHaveCount(projects.filter(item => item.kind === 'model' && item.visibility === 'public').length);
  await expect(card(page, 'Private garden study')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Search both catalogs' }).check();
  await page.getByRole('searchbox').fill('Private garden study');
  await expect(page.locator('.model-row')).toHaveCount(0);
  await page.getByRole('link', { name: 'My libraries', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^My libraries/ })).toBeVisible();
  await expect(page.locator('.model-row')).toHaveCount(projects.filter(item => item.kind === 'library' && (item.ownerId === user.id || item.sharedWithMe)).length);
});

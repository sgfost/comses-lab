import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, stateDir } from '../scripts/config.mjs';
import type { Project } from '../shared/contracts.js';
const settings = config();
const owner = JSON.parse(readFileSync(resolve(stateDir, 'credentials.json'), 'utf8')).users.find((user: { username: string }) => user.username === 'ada');
const frame = (page: Page) => page.frameLocator('iframe[title="Artifact preview"]');
async function open(page: Page, title: string) {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.request.post('/api/session', { headers: { Origin: settings.appOrigin }, data: owner });
  const projects: Project[] = (await (await page.request.get('/api/projects')).json()).projects;
  const project = projects.find(item => item.title === title)!;
  const launched = page.waitForResponse(response => response.url().endsWith('/launch') && response.request().method() === 'POST');
  await page.goto(`/#/project/${project.id}?edit=0`);
  expect((await launched).ok()).toBe(true);
  await expect(frame(page).locator('html')).toHaveClass(/lab-preview-fit/);
  return project;
}
async function fits(page: Page) {
  await expect.poll(() => frame(page).locator('body').evaluate(element => {
    const body = element as HTMLElement;
    const bounds = body.getBoundingClientRect();
    const scale = Number.parseFloat(getComputedStyle(body).zoom) || 1;
    return bounds.left >= -1 && bounds.top >= -1 && bounds.left + Math.max(body.offsetWidth, body.scrollWidth) * scale <= innerWidth + 1 && bounds.top + Math.max(body.offsetHeight, body.scrollHeight) * scale <= innerHeight + 1;
  })).toBe(true);
  expect(await frame(page).locator('html').evaluate(root => getComputedStyle(root).overflow)).toBe('hidden');
}

test('the garden fits a laptop pane, remains interactive, and switches to original size without a reload', async ({ page }) => {
  const project = await open(page, 'The commons garden');
  await expect(frame(page).getByRole('button', { name: 'Next season' })).toBeVisible();
  await fits(page);
  await frame(page).getByRole('button', { name: 'Next season' }).click();
  await expect(frame(page).locator('#season')).toHaveText('1');
  const src = await page.locator('iframe').getAttribute('src');
  await page.getByRole('combobox', { name: 'Preview size' }).selectOption('actual');
  await expect(frame(page).locator('html')).not.toHaveClass(/lab-preview-fit/);
  expect(await frame(page).locator('body').evaluate(body => body.scrollHeight > innerHeight)).toBe(true);
  await page.getByRole('combobox', { name: 'Preview size' }).selectOption('fit');
  await fits(page);
  await expect(frame(page).locator('#season')).toHaveText('1');
  await expect(page.locator('iframe')).toHaveAttribute('src', src!);
  await page.getByRole('treeitem', { name: 'README.md', exact: false }).click();
  await fits(page);
  await page.setViewportSize({ width: 1024, height: 640 });
  await fits(page);
  await frame(page).getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(frame(page).locator('#season')).toHaveText('0');
  const tree = await (await page.request.get(`/api/projects/${project.id}/tree`)).json();
  const source = await (await page.request.get(`/api/projects/${project.id}/file?commit=${tree.commit}&path=index.html`)).json();
  expect(source.content).not.toContain('lab-preview-fit');
});

test('worker controls and expanded diagnostics remain reachable in Fit', async ({ page }) => {
  await open(page, 'Random walks');
  await expect(frame(page).locator('#status')).toHaveText('Ready');
  await fits(page);
  await frame(page).getByRole('button', { name: 'Run', exact: true }).click();
  await expect(frame(page).locator('#status')).toContainText('Mean squared displacement:');
  await frame(page).locator('summary').click();
  await fits(page);
  await expect(frame(page).getByRole('button', { name: 'Throw worker error' })).toBeVisible();
});

test('Python output fits after interpreter loading and plot updates', async ({ page }) => {
  test.setTimeout(60000);
  await open(page, 'Heat diffusion');
  await expect(frame(page).getByRole('button', { name: 'Run', exact: true })).toBeEnabled({ timeout: 45000 });
  await frame(page).getByRole('button', { name: 'Run', exact: true }).click();
  await expect(frame(page).locator('#status')).toContainText('Peak temperature');
  await fits(page);
});

test('NetLogo fits fixed widgets, retains working controls, and uses actual size for interface authoring', async ({ page }) => {
  await open(page, 'NetLogo walks');
  const setup = frame(page).locator('.netlogo-button').filter({ hasText: /^\s*setup\s*$/ });
  await expect(setup).toBeVisible();
  await fits(page);
  await setup.click();
  const go = frame(page).locator('.netlogo-button').filter({ hasText: /^\s*go\s*$/ });
  await go.click();
  await expect.poll(() => frame(page).locator('body').evaluate(() => (window as any).world.ticker.tickCount())).toBeGreaterThan(1);
  await go.click();
  await page.getByRole('treeitem', { name: 'README.md', exact: false }).click();
  await fits(page);
  await page.setViewportSize({ width: 1024, height: 640 });
  await fits(page);
  await page.getByRole('button', { name: 'Edit interface', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await expect(frame(page).locator('html')).not.toHaveClass(/lab-preview-fit/);
  await expect(page.getByRole('combobox', { name: 'Preview size' })).toHaveValue('actual');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(frame(page).locator('html')).toHaveClass(/lab-preview-fit/);
  await fits(page);
});


test('viewport-height layouts fit without a resize loop and retain exact saved source', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const headers = { Origin: settings.appOrigin };
  await page.request.post('/api/session', { headers, data: owner });
  const result = await page.request.post('/api/projects', { headers, data: { requestId: randomUUID(), templateId: 'worker', title: 'Viewport fit fixture', visibility: 'private' } });
  expect(result.status()).toBe(201);
  const created = await result.json();
  const content = '<!doctype html><style>html,body{margin:0;height:100%}main{height:100vh;background:#eee;display:grid;place-items:center}section{display:none;height:700px}</style><main><button onclick="document.querySelector(\'section\').style.display=\'block\'">Expand</button></main><section>Additional output</section>';
  const saved = await page.request.post(`/api/projects/${created.project.id}/commits`, { headers, data: { ref: created.ref, expectedCommit: created.commit, message: 'Use a viewport-height document', changes: [{ operation: 'update', path: 'index.html', content }] } });
  expect(saved.status()).toBe(201);
  const launched = page.waitForResponse(response => response.url().endsWith('/launch') && response.request().method() === 'POST');
  await page.goto(`/#/project/${created.project.id}?edit=0`);
  expect((await launched).ok()).toBe(true);
  await expect(frame(page).locator('html')).toHaveClass(/lab-preview-fit/);
  await fits(page);
  await frame(page).getByRole('button', { name: 'Expand' }).click();
  await fits(page);
  await expect(frame(page).locator('section')).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 640 });
  await fits(page);
  const commit = (await saved.json()).commit;
  const source = await (await page.request.get(`/api/projects/${created.project.id}/file?commit=${commit}&path=index.html`)).json();
  expect(source.content).toBe(content);
});

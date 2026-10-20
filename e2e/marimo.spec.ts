import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, stateDir, instance } from '../scripts/config.mjs';

if (!instance.startsWith('test-')) throw new Error('Isolated test instance required');
const settings = config();
const owner = JSON.parse(readFileSync(resolve(stateDir, 'credentials.json'), 'utf8')).users[0];
test('notebook imports project code, reacts, and saves the final edit through Git', async ({ page }) => {
  test.setTimeout(180_000);
  const login = await page.request.post('/api/session', { headers: { Origin: settings.appOrigin }, data: owner });
  expect(login.status()).toBe(200);
  const created = await page.request.post('/api/projects', {
    headers: { Origin: settings.appOrigin },
    data: { requestId: randomUUID(), templateId: 'marimo', title: `Notebook ${randomUUID().slice(0, 8)}`, visibility: 'public' },
  });
  expect(created.status()).toBe(201);
  const { project } = await created.json();
  await page.goto(`/#/project/${project.id}?edit=1`);
  const frame = page.frameLocator('iframe[title="Artifact preview"]');
  await expect(frame.getByText(/^Final population:/)).toBeVisible({ timeout: 90_000 });
  const initial = await frame.getByText(/^Final population:/).innerText();
  await frame.getByRole('slider').focus();
  await page.keyboard.press('ArrowRight');
  await expect(frame.getByText(/^Final population:/)).not.toHaveText(initial);
  await page.getByRole('button', { name: 'Edit notebook', exact: true }).click();
  const cell = frame.locator('.cm-content').first();
  await expect(cell).toContainText('from model import simulate', { timeout: 90_000 });
  await cell.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.insertText('import marimo as mo\nfrom model import simulate\n# Autosaved cell');
  await expect.poll(async () => {
    const draft = (await (await page.request.get(`/api/projects/${project.id}/draft`)).json()).draft;
    return draft?.changes.find((change: { path: string }) => change.path === 'notebook.py')?.content ?? '';
  }, { timeout: 20_000 }).toContain('# Autosaved cell');
  const draftBeforeConfig = (await (await page.request.get(`/api/projects/${project.id}/draft`)).json()).draft;
  expect(draftBeforeConfig.changes.find((change: { path: string }) => change.path === 'notebook.py').content).toContain('width="medium"');
  await frame.getByTestId('app-config-button').click();
  await frame.getByLabel('Width', { exact: true }).selectOption('full');
  await expect.poll(async () => {
    const draft = (await (await page.request.get(`/api/projects/${project.id}/draft`)).json()).draft;
    return draft?.changes.find((change: { path: string }) => change.path === 'notebook.py')?.content ?? '';
  }, { timeout: 20_000 }).toContain('width="full"');
  await page.keyboard.press('Escape');
  await cell.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.insertText('import marimo as mo\nfrom model import simulate\n# Last keystroke survives Save version');
  const versionSaved = page.waitForResponse(response => response.url().endsWith('/draft/save') && response.request().method() === 'POST', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  expect((await versionSaved).status()).toBe(201);
  const tree = await (await page.request.get(`/api/projects/${project.id}/tree?ref=refs/heads/main`)).json();
  const saved = await (await page.request.get(`/api/projects/${project.id}/file?commit=${tree.commit}&path=notebook.py`)).json();
  expect(saved.content).toContain('# Last keystroke survives Save version');
  expect(saved.content).toContain('@app.cell');
  expect(saved.content).toContain('width="full"');
  const viewing = page.waitForResponse(response => response.url().endsWith('/launch') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'View notebook', exact: true }).click();
  const viewLaunch = await (await viewing).json();
  await expect(page.locator('iframe[title="Artifact preview"]')).toHaveAttribute('src', viewLaunch.url);
  await expect(frame.getByText(/^Final population:/)).toBeVisible({ timeout: 90_000 });
  await page.screenshot({ path: 'test-results/marimo-notebook.png' });
  await page.reload();
  await expect(frame.getByText(/^Final population:/)).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Edit notebook', exact: true }).click();
  await expect(frame.locator('.cm-content').first()).toContainText('# Last keystroke survives Save version', { timeout: 90_000 });
});

test('companion notebooks read project files without changing the entrypoint; readers cannot edit', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const headers = { Origin: settings.appOrigin };
  await page.request.post('/api/session', { headers, data: owner });
  const created = await page.request.post('/api/projects', { headers, data: {
    requestId: randomUUID(), templateId: 'worker', title: `Companion ${randomUUID().slice(0, 8)}`, visibility: 'public',
  } });
  expect(created.status()).toBe(201);
  const { project, commit } = await created.json();
  const content = `import marimo
app = marimo.App()
@app.cell
def _():
    import marimo as mo
    from helper import scale
    from vendor.library import offset
    from pathlib import Path
    result = int(Path("data/count.txt").read_text()) * scale + offset
    mo.md(f"Companion result: {result}")
    return
if __name__ == "__main__":
    app.run()
`;
  const changes = [
    { path: 'analysis/experiment.py', content },
    { path: 'analysis/helper.py', content: 'scale = 3\n' },
    { path: 'vendor/library.py', content: 'offset = 2\n' },
    { path: 'data/count.txt', content: '7\n' },
  ].map(file => ({ operation: 'create', ...file }));
  const committed = await page.request.post(`/api/projects/${project.id}/commits`, { headers, data: {
    ref: 'refs/heads/main', expectedCommit: commit, message: 'Add experiment and data', changes,
  } });
  expect(committed.status()).toBe(201);
  const savedCommit = (await committed.json()).commit;
  await page.goto(`/#/project/${project.id}?edit=1`);
  await page.getByLabel('Preview file', { exact: true }).selectOption('analysis/experiment.py');
  const frame = page.frameLocator('iframe[title="Artifact preview"]');
  await expect(frame.getByText('Companion result: 23', { exact: true })).toBeVisible({ timeout: 90_000 });
  expect((await (await page.request.get(`/api/projects/${project.id}`)).json()).project.entrypoint).toBe('index.html');
  const reader = JSON.parse(readFileSync(resolve(stateDir, 'credentials.json'), 'utf8')).users.find((user: { username: string }) => user.username === 'dee');
  const context = await browser.newContext();
  try {
    await context.request.post(`${settings.appOrigin}/api/session`, { headers, data: reader });
    const denied = await context.request.post(`${settings.appOrigin}/api/projects/${project.id}/launch`, { headers, data: {
      commit: savedCommit, entrypoint: 'analysis/experiment.py', edit: true,
    } });
    expect(denied.status()).toBe(403);
    const read = await context.request.post(`${settings.appOrigin}/api/projects/${project.id}/launch`, { headers, data: {
      commit: savedCommit, entrypoint: 'analysis/experiment.py',
    } });
    expect(read.status()).toBe(200);
    expect((await read.json()).runtime).toBe('marimo');
    const missing = await context.request.post(`${settings.appOrigin}/api/projects/${project.id}/launch`, { headers, data: {
      commit: savedCommit, entrypoint: 'missing.py',
    } });
    expect(missing.status()).toBe(422);
  } finally { await context.close(); }
});

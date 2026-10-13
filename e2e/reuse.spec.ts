import { test, expect, type Page } from '@playwright/test';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { config, stateDir, instance, projectRoot } from '../scripts/config.mjs';
import type { Project, CreateProjectResponse, Launch } from '../shared/contracts.ts';
const settings = config();
if (!instance.startsWith('test-')) throw new Error('Reuse acceptance requires an isolated test instance');
const owner = JSON.parse(readFileSync(resolve(stateDir, 'credentials.json'), 'utf8')).users.find((user: { username: string }) => user.username === 'ada');
const headers = { Origin: settings.appOrigin };
const directories = ['python-pulse', 'python-alternating'];
const originalResults = ['Peak: 60.000 · Contrast: 60.000 · Total: 100.000', 'Peak: 60.000 · Contrast: 20.000 · Total: 300.000'];
const changedResults = ['Peak: 80.000 · Contrast: 80.000 · Total: 100.000', 'Peak: 80.000 · Contrast: 60.000 · Total: 300.000'];
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function run(page: Page, project: Project, result: string, bytes: Buffer) {
  const response = page.waitForResponse(response => response.url().endsWith(`/api/projects/${project.id}/launch`) && response.request().method() === 'POST');
  await page.goto(`/#/project/${project.id}`);
  const capability = await (await response).json() as Launch;
  const frame = page.frameLocator('iframe[title="Artifact preview"]');
  await expect(frame.locator('#status')).toHaveText('Python ready', { timeout: 30000 });
  await frame.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(frame.locator('#status')).toHaveText(result);
  const source = await page.request.get(`${settings.runtimeOrigin}/preview/${capability.id}/vendor/diffusion.py`);
  expect((await source.body()).equals(bytes)).toBe(true);
  const pin = await (await page.request.get(`${settings.runtimeOrigin}/preview/${capability.id}/component.json`)).json();
  expect(pin.sha256).toBe(hash(bytes));
  await expect(frame.locator('#component')).toContainText(pin.commit.slice(0, 12));
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
}
function files(root: string, directory: string) {
  const folder = join(root, 'examples', directory);
  return readdirSync(folder, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => ({
    path: resolve(entry.parentPath, entry.name).slice(folder.length + 1),
    content: readFileSync(resolve(entry.parentPath, entry.name), 'utf8'),
  }));
}

test('two Python models import identical pinned Git bytes and reproduce after an isolated component change', async ({ page }) => {
  test.setTimeout(120000);
  expect((await page.request.post('/api/session', { headers, data: owner })).status()).toBe(200);
  const pin = JSON.parse(readFileSync(resolve(projectRoot, 'examples/python-pulse/component.json'), 'utf8'));
  const canonicalBefore = readFileSync(resolve(projectRoot, pin.path));
  const upstream = execFileSync('git', ['-C', projectRoot, 'show', `${pin.commit}:${pin.path}`]);
  expect(hash(upstream)).toBe(pin.sha256);
  expect(JSON.parse(readFileSync(resolve(projectRoot, 'examples/python-alternating/component.json'), 'utf8'))).toEqual(pin);
  const { projects } = await (await page.request.get('/api/projects')).json() as { projects: Project[] };
  for (const [i, name] of ['heat-pulse', 'alternating-temperatures'].entries()) {
    const project = projects.find(project => project.forgejoRepo === name)!;
    expect(project).toBeTruthy();
    await run(page, project, originalResults[i]!, upstream);
  }
  const fixture = mkdtempSync(resolve(stateDir, 'reuse-git-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', fixture, ...args], { encoding: 'utf8' }).trim();
  const vend = (commit: string, repository: string) => execFileSync(process.execPath,
    [resolve(projectRoot, 'scripts/vendor-diffusion.mjs'), commit, repository, fixture], { encoding: 'utf8' });
  try {
    git('init', '--quiet');
    git('config', 'user.name', 'Reuse acceptance'); git('config', 'user.email', 'reuse@lab.invalid');
    mkdirSync(join(fixture, 'examples/python'), { recursive: true });
    writeFileSync(join(fixture, pin.path), upstream);
    git('add', pin.path); git('commit', '--quiet', '-m', 'Record original component');
    const changed = Buffer.from(upstream.toString().replace('    return [', '    diffusivity = diffusivity / 2\n    return ['));
    expect(changed.equals(upstream)).toBe(false);
    writeFileSync(join(fixture, pin.path), changed);
    git('add', pin.path); git('commit', '--quiet', '-m', 'Halve diffusion for isolated reproduction experiment');
    const changedCommit = git('rev-parse', 'HEAD');
    vend(changedCommit, fixture);
    const created: CreateProjectResponse[] = [];
    for (const [i, directory] of directories.entries()) {
      const response = await page.request.post('/api/projects', { headers, data: {
        requestId: randomUUID(), templateId: 'python', title: `Reuse experiment ${i + 1} ${randomUUID().slice(0, 8)}`, visibility: 'private',
      } });
      expect(response.status(), await response.text()).toBe(201);
      const project = await response.json() as CreateProjectResponse;
      const paths = files(projectRoot, directory).map(file => ({ ...file, content: ['vendor/diffusion.py', 'component.json'].includes(file.path)
        ? readFileSync(join(fixture, 'examples', directory, file.path), 'utf8') : file.content }));
      const responseSave = await page.request.post(`/api/projects/${project.project.id}/commits`, { headers, data: {
        ref: project.ref, expectedCommit: project.commit, message: 'Import changed component at exact fixture revision',
        changes: paths.map(file => ({ ...file, operation: ['index.html', 'model.py', 'python-worker.js', 'README.md'].includes(file.path) ? 'update' : 'create' })),
      } });
      expect(responseSave.status(), await responseSave.text()).toBe(201);
      project.commit = (await responseSave.json()).commit;
      created.push(project);
      await run(page, project.project, changedResults[i]!, changed);
    }
    // Re-vendor the original root commit after the fixture HEAD changed; moving HEAD is never used.
    vend(pin.commit, projectRoot);
    for (const [i, project] of created.entries()) {
      const directory = directories[i]!;
      const restoredPin = JSON.parse(readFileSync(join(fixture, 'examples', directory, 'component.json'), 'utf8'));
      expect(restoredPin).toEqual(pin);
      const restored = await page.request.post(`/api/projects/${project.project.id}/commits`, { headers, data: {
        ref: project.ref, expectedCommit: project.commit, message: 'Reproduce original pinned component',
        changes: ['vendor/diffusion.py', 'component.json'].map(path => ({ operation: 'update', path, content: readFileSync(join(fixture, 'examples', directory, path), 'utf8') })),
      } });
      expect(restored.status(), await restored.text()).toBe(201);
      await run(page, project.project, originalResults[i]!, upstream);
    }
    expect(readFileSync(resolve(projectRoot, pin.path)).equals(canonicalBefore)).toBe(true);
    console.log(`Shared module ${pin.commit}:${pin.path}; changed fixture ${changedCommit}; both original scenarios reproduced`);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    await page.request.delete('/api/session', { headers: { ...headers, 'Content-Type': 'application/json' } });
  }
});


test('repeat bootstrap preserves all existing project identities, metadata and Git heads', async ({ page }) => {
  test.setTimeout(60000);
  expect((await page.request.post('/api/session', { headers, data: owner })).status()).toBe(200);
  const snapshot = async () => {
    const { projects } = await (await page.request.get('/api/projects')).json() as { projects: Project[] };
    return Promise.all(projects.map(async project => ({ project,
      commit: (await (await page.request.get(`/api/projects/${project.id}/tree`)).json()).commit,
    })));
  };
  const before = await snapshot();
  expect(before.some(item => item.project.forgejoRepo === 'heat-pulse')).toBe(true);
  expect(before.some(item => item.project.forgejoRepo === 'alternating-temperatures')).toBe(true);
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/bootstrap.ts'], { cwd: projectRoot, env: process.env, stdio: 'pipe' });
  expect(await snapshot()).toEqual(before);
  await page.request.delete('/api/session', { headers: { ...headers, 'Content-Type': 'application/json' } });
});

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { config, stateDir } from '../scripts/config.mjs';
import type { Project, CreateProjectResponse, ProjectLibraries } from '../shared/contracts.ts';

const settings = config();
const owner = JSON.parse(readFileSync(resolve(stateDir, 'credentials.json'), 'utf8')).users.find((user: { username: string }) => user.username === 'ada');
const headers = { Origin: settings.appOrigin };
test.use({ actionTimeout: 15000 });
const name = (prefix: string) => `${prefix} ${randomUUID().slice(0, 8)}`;
async function signIn(request: APIRequestContext) {
  expect((await request.post('/api/session', { headers, data: owner })).status()).toBe(200);
}
async function create(request: APIRequestContext, templateId: string, title: string, visibility = 'private') {
  const response = await request.post('/api/projects', { headers, data: { requestId: randomUUID(), templateId, title, visibility } });
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as CreateProjectResponse;
}
async function save(request: APIRequestContext, project: CreateProjectResponse, path: string, content: string, operation = 'update') {
  const response = await request.post(`/api/projects/${project.project.id}/commits`, { headers, data: { ref: project.ref, expectedCommit: project.commit, message: 'Change library fixture', changes: [{ operation, path, content }] } });
  expect(response.status(), await response.text()).toBe(201);
  project.commit = (await response.json()).commit;
}
async function saveDraftVersion(page: Page) {
  const response = page.waitForResponse(response => response.url().endsWith('/draft/save') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  const saved = await response;
  expect(saved.status(), await saved.text()).toBe(201);
  return (await saved.json()).commit as string;
}
async function runAnswer(page: Page, model: CreateProjectResponse, commit: string, expected: string) {
  await page.goto(`/#/project/${model.project.id}?edit=1&ref=${commit}`);
  await expect(page.locator('iframe[title="Artifact preview"]')).toBeVisible();
  await expect(page.frameLocator('iframe[title="Artifact preview"]').locator('output')).toHaveText(expected);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
}

test('discover independent libraries and run a model with a two-level ordinary import hierarchy', async ({ page }) => {
  await signIn(page.request);
  const { projects } = await (await page.request.get('/api/projects')).json() as { projects: Project[] };
  const grid = projects.find(project => project.forgejoRepo === 'grid-walkers')!;
  const framework = projects.find(project => project.forgejoRepo === 'agent-grid')!;
  const kit = projects.find(project => project.forgejoRepo === 'browser-kit')!;
  expect(framework.kind).toBe('library'); expect(kit.kind).toBe('library');
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Explore', exact: true }).getByRole('link', { name: 'Libraries', exact: true }).click();
  await expect(page).toHaveURL(/#\/explore\/libraries$/);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Libraries');
  await expect(page.locator('.model-row').filter({ has: page.getByRole('heading', { name: 'Diffusion', exact: true }) })).toHaveCount(1);
  await expect(page.locator('.model-row').filter({ hasText: 'Grid walkers' })).toHaveCount(0);
  await page.getByRole('searchbox').fill('diffusion');
  await expect(page.locator('.model-row').filter({ has: page.getByRole('heading', { name: 'Heat diffusion', exact: true }) })).toHaveCount(0);
  await page.getByLabel('Search both catalogs', { exact: true }).check();
  await expect(page.locator('.model-row').filter({ has: page.getByRole('heading', { name: 'Heat diffusion', exact: true }) })).toHaveCount(1);
  await page.getByRole('searchbox').fill('');
  await page.goto(`/#/project/${grid.id}?edit=1`);
  await expect(page.locator('.libraries-panel').getByRole('link', { name: 'Agent grid', exact: true })).toBeVisible();
  await expect(page.locator('.libraries-panel').getByRole('link', { name: 'Browser kit', exact: true })).toBeVisible();
  const tree = await (await page.request.get(`/api/projects/${grid.id}/tree?ref=main`)).json();
  const dependencies = await (await page.request.get(`/api/projects/${grid.id}/libraries?commit=${tree.commit}`)).json() as ProjectLibraries;
  expect(dependencies.libraries[0]!.projectId).toBe(framework.id);
  expect(dependencies.libraries[0]!.children[0]!.projectId).toBe(kit.id);
  expect(dependencies.libraries[0]!.modified).toBe(false);
  await expect(page.locator('iframe[title="Artifact preview"]')).toBeVisible();
  const frame = page.frameLocator('iframe[title="Artifact preview"]');
  await expect(frame.locator('output')).toHaveText('Step: 0 · Agents: 200');
  await frame.getByRole('button', { name: 'Run 100 steps', exact: true }).click();
  await expect(frame.locator('output')).toHaveText('Step: 100 · Agents: 200');
  await frame.getByLabel('Agents', { exact: true }).fill('25');
  await frame.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(frame.locator('output')).toHaveText('Step: 0 · Agents: 25');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.locator('.libraries-panel').getByRole('link', { name: 'Agent grid', exact: true }).click();
  await expect(page.locator('iframe[title="Artifact preview"]')).toHaveCount(0);
  await expect(page.locator('.libraries-panel').getByRole('link', { name: 'Browser kit', exact: true })).toBeVisible();
  for (const repo of ['heat-pulse', 'alternating-temperatures']) {
    const project = projects.find(project => project.forgejoRepo === repo)!;
    const result = await (await page.request.get(`/api/projects/${project.id}/libraries`)).json() as ProjectLibraries;
    expect(result.libraries[0]!.project!.forgejoRepo).toBe('diffusion');
    expect(result.libraries[0]!.modified).toBe(false);
  }
});

test('library creation and saved-source extraction work through the browser', async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page.request); await page.goto('/#/explore/libraries');
  await page.getByRole('button', { name: 'New library', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Template', { exact: true }).selectOption('library-js');
  const title = name('Browser-created library');
  await dialog.getByLabel('Title', { exact: true }).fill(title);
  const response = page.waitForResponse(response => response.url().endsWith('/api/projects') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Create library', exact: true }).click();
  const created = await (await response).json() as CreateProjectResponse;
  expect(created.project.kind).toBe('library'); expect(created.project.entrypoint).toBe('');
  await expect(page.locator('.crumb')).toContainText(title);
  await expect(page.locator('iframe[title="Artifact preview"]')).toHaveCount(0);
  const model = await create(page.request, 'python', name('Extraction source'));
  await page.goto(`/#/project/${model.project.id}?edit=1`);
  await page.getByRole('button', { name: 'Extract library', exact: true }).click();
  await dialog.getByLabel('diffusion.py', { exact: true }).check();
  await dialog.getByLabel('Title', { exact: true }).fill(name('Extracted diffusion'));
  const extractedResponse = page.waitForResponse(response => response.url().endsWith('/extractions'));
  await dialog.getByRole('button', { name: 'Extract library', exact: true }).click();
  const extracted = await (await extractedResponse).json() as CreateProjectResponse;
  expect(extracted.project.extractedFrom).toEqual({ projectId: model.project.id, commit: model.commit });
  expect(extracted.project.kind).toBe('library'); expect(extracted.project.forkedFrom).toBeNull();
  const files = await (await page.request.get(`/api/projects/${extracted.project.id}/tree?ref=main`)).json();
  expect(files.files.map((file: { path: string }) => file.path)).toEqual(['diffusion.py']);
  expect((await (await page.request.get(`/api/projects/${model.project.id}/tree?ref=main`)).json()).commit).toBe(model.commit);
  await expect(page.locator('.crumb')).toContainText(extracted.project.title);
  await page.getByRole('button', { name: 'About library', exact: true }).click();
  await expect(page.locator('.sidebar')).toContainText('Extracted from');
  const fork = await page.request.post(`/api/projects/${extracted.project.id}/forks`, { headers, data: { requestId: randomUUID(), title: name('Library fork'), commit: extracted.commit, visibility: 'private' } });
  expect(fork.status()).toBe(201); expect((await fork.json()).project.kind).toBe('library');
});

test('explicit library updates reproduce old output and protect edits, permissions and concurrent heads', async ({ page, playwright }) => {
  test.setTimeout(120000);
  await signIn(page.request);
  const library = await create(page.request, 'library-js', name('Answer library'));
  await save(page.request, library, 'library.js', 'export const answer = 7;\n');
  const initialLibraryCommit = library.commit;
  const model = await create(page.request, 'commons', name('Answer model'));
  await save(page.request, model, 'index.html', '<!doctype html><output></output><script type="module">import {answer} from "./vendor/answer/library.js";document.querySelector("output").textContent=answer;</script>');
  await page.goto(`/#/project/${model.project.id}?edit=1`);
  await page.getByRole('button', { name: 'Add library', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Library', exact: true }).selectOption(library.project.id);
  await expect(dialog.getByLabel('Library revision', { exact: true })).toHaveValue(library.commit);
  await dialog.locator('.library-options summary').click();
  await dialog.getByLabel('Destination directory', { exact: true }).fill('vendor/answer');
  const installed = page.waitForResponse(response => response.url().endsWith('/libraries') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Add to artifact', exact: true }).click();
  expect((await installed).status()).toBe(200);
  expect((await (await page.request.get(`/api/projects/${model.project.id}/tree`)).json()).commit).toBe(model.commit);
  model.commit = await saveDraftVersion(page);
  const oldModelCommit = model.commit;
  await runAnswer(page, model, oldModelCommit, '7');
  await save(page.request, library, 'library.js', 'export const answer = 42;\n');
  await page.goto(`/#/project/${model.project.id}?edit=1`);
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(dialog.getByLabel('Library version', { exact: true })).toHaveValue(library.commit);
  await expect(dialog.getByLabel('Library revision', { exact: true })).toHaveValue(library.commit);
  const updated = page.waitForResponse(response => response.url().endsWith('/libraries') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Update library', exact: true }).click();
  expect((await updated).status()).toBe(200);
  expect((await (await page.request.get(`/api/projects/${model.project.id}/tree`)).json()).commit).toBe(oldModelCommit);
  model.commit = await saveDraftVersion(page);
  await runAnswer(page, model, model.commit, '42');
  await runAnswer(page, model, oldModelCommit, '7');
  const clone = mkdtempSync(resolve(stateDir, 'libraries-git-'));
  try {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${owner.username}:${owner.password}`).toString('base64')}` };
    execFileSync('git', ['clone', '--bare', `${settings.forgejoUrl}/${model.project.forgejoOwner}/${model.project.forgejoRepo}.git`, clone], { env, stdio: 'pipe' });
    const actual = execFileSync('git', ['--git-dir', clone, 'show', `${model.commit}:vendor/answer/library.js`], { env, encoding: 'utf8' });
    expect(actual).toBe('export const answer = 42;\n');
    const lock = JSON.parse(execFileSync('git', ['--git-dir', clone, 'show', `${model.commit}:lab.lock.json`], { env, encoding: 'utf8' }));
    expect(lock.libraries[0].commit).toBe(library.commit);
  } finally { rmSync(clone, { recursive: true, force: true }); }
  const mutate = (expectedCommit: string) => ({ ref: model.ref, expectedCommit, directory: 'vendor/answer', message: 'Remove dependency' });
  const stale = await page.request.delete(`/api/projects/${model.project.id}/libraries`, { headers, data: mutate(oldModelCommit) });
  expect(stale.status()).toBe(409);
  await save(page.request, model, 'vendor/answer/library.js', 'export const answer = 99;\n');
  const modified = await page.request.delete(`/api/projects/${model.project.id}/libraries`, { headers, data: mutate(model.commit) });
  expect(modified.status()).toBe(409); expect((await modified.json()).error.code).toBe('library_modified');
  await save(page.request, model, 'vendor/answer/library.js', 'export const answer = 42;\n');
  const removed = await page.request.delete(`/api/projects/${model.project.id}/libraries`, { headers, data: mutate(model.commit) });
  expect(removed.status()).toBe(201); model.commit = (await removed.json()).commit;
  const left = await (await page.request.get(`/api/projects/${model.project.id}/tree?ref=main`)).json();
  expect(left.files.some((file: { path: string }) => file.path.startsWith('vendor/answer/'))).toBe(false);
  const publicModel = await create(page.request, 'commons', name('Public consumer'), 'public');
  const denied = await page.request.post(`/api/projects/${publicModel.project.id}/libraries`, { headers, data: { ref: publicModel.ref, expectedCommit: publicModel.commit, directory: 'vendor/answer', message: 'Private dependency', libraryId: library.project.id, commit: library.commit, paths: ['library.js'] } });
  expect(denied.status()).toBe(422);
  const stranger = await playwright.request.newContext({ baseURL: settings.appOrigin });
  try { expect((await stranger.get(`/api/projects/${library.project.id}`)).status()).toBe(404); expect((await stranger.get(`/api/projects/${model.project.id}/libraries`)).status()).toBe(404); }
  finally { await stranger.dispose(); }
});

import { test, expect, type Page } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, stateDir, instance } from '../scripts/config.mjs';
import type { CreateProjectResponse, Launch, Project } from '../shared/contracts.ts';
import { startExternalData } from './fixtures/external-data.ts';

const settings = config();
if (!instance.startsWith('test-')) throw new Error('External-data acceptance requires an isolated test instance');
const owner = JSON.parse(readFileSync(resolve(stateDir, 'credentials.json'), 'utf8')).users.find((user: { username: string }) => user.username === 'ada');
const headers = { Origin: settings.appOrigin };
async function createFixture(page: Page) {
  expect((await page.request.post('/api/session', { headers, data: owner })).status()).toBe(200);
  const created = await page.request.post('/api/projects', { headers, data: {
    requestId: randomUUID(), templateId: 'commons', title: `External observations ${randomUUID().slice(0, 8)}`, visibility: 'private',
  } });
  expect(created.status(), await created.text()).toBe(201);
  const result = await created.json() as CreateProjectResponse;
  const source = resolve('examples/external-data');
  const changes = readdirSync(source).map(path => ({
    operation: ['index.html', 'README.md'].includes(path) ? 'update' : 'create',
    path, content: readFileSync(resolve(source, path), 'utf8'),
  }));
  const saved = await page.request.post(`/api/projects/${result.project.id}/commits`, { headers, data: {
    ref: result.ref, expectedCommit: result.commit, message: 'Add ordinary external observations application', changes,
  } });
  expect(saved.status(), await saved.text()).toBe(201);
  const commit = (await saved.json()).commit as string;
  return { project: result.project, commit };
}
async function runModel(page: Page, project: Project) {
  const response = page.waitForResponse(response => response.url().endsWith(`/api/projects/${project.id}/launch`) && response.request().method() === 'POST');
  await page.goto(`/#/project/${project.id}`);
  const launched = await response;
  expect(launched.status(), await launched.text()).toBe(200);
  const capability = await launched.json() as Launch;
  await expect(page.frameLocator('iframe[title="Artifact preview"]').locator('#javascript')).toBeEnabled();
  return capability;
}
async function origins(page: Page, project: Project, dataOrigins: string[]) {
  const updated = await page.request.patch(`/api/projects/${project.id}`, { headers, data: {
    expectedMetadataVersion: project.metadataVersion, dataOrigins,
  } });
  expect(updated.status(), await updated.text()).toBe(200);
  return (await updated.json()).project as Project;
}

test('ordinary JavaScript and Python fetch named CORS data while imports, redirects and unlisted origins stay denied', async ({ playwright }) => {
  test.setTimeout(90000);
  const fixture = await startExternalData();
  // DNS mapping is confined to this browser; application validation and CSP retain their ordinary behavior.
  const browser = await playwright.chromium.launch({ args: [
    '--host-resolver-rules=MAP data.lab-test.invalid 127.0.0.1, MAP blocked.lab-test.invalid 127.0.0.1',
    '--no-proxy-server',
  ] });
  const context = await browser.newContext({ baseURL: settings.appOrigin });
  context.setDefaultTimeout(15000);
  const page = await context.newPage();
  const modelRequests: Promise<Record<string, string>>[] = [];
  // CSP-denied requests have no transmitted headers; observe only completed network responses.
  page.on('response', response => {
    const request = response.request();
    if (request.url().startsWith(settings.runtimeOrigin) || request.url().startsWith(fixture.allowed) || request.url().startsWith(fixture.blocked))
      modelRequests.push(request.allHeaders());
  });
  let capability: Launch | undefined;
  try {
    let { project } = await createFixture(page);
    const initial = await runModel(page, project);
    const frame = page.frameLocator('iframe[title="Artifact preview"]');
    await frame.getByLabel('Dataset URL').fill(`${fixture.allowed}/observations.json`);
    await frame.getByRole('button', { name: 'Sum in JavaScript' }).click();
    await expect(frame.locator('#javascript-result')).toContainText('JavaScript failed:');
    expect(fixture.requests).toEqual([]);
    // Expansion cannot change a captured policy.
    project = await origins(page, project, [fixture.allowed]);
    const initialPolicy = (await page.request.get(initial.url)).headers()['content-security-policy'];
    expect(initialPolicy).not.toContain(fixture.allowed);
    await frame.getByRole('button', { name: 'Sum in JavaScript' }).click();
    await expect(frame.locator('#javascript-result')).toContainText('JavaScript failed:');
    expect(fixture.requests).toEqual([]);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    capability = await runModel(page, project);
    await frame.getByLabel('Dataset URL').fill(`${fixture.allowed}/observations.json`);
    await frame.getByRole('button', { name: 'Sum in JavaScript' }).click();
    await expect(frame.locator('#javascript-result')).toHaveText('JavaScript sum: 14');
    await expect(frame.locator('#python-result')).toHaveText('Python ready', { timeout: 30000 });
    await frame.getByRole('button', { name: 'Sum squares in Python' }).click();
    await expect(frame.locator('#python-result')).toHaveText('Python sum of squares: 84');
    fixture.setValues([3, 9, 12]);
    await frame.getByRole('button', { name: 'Sum in JavaScript' }).click();
    await expect(frame.locator('#javascript-result')).toHaveText('JavaScript sum: 24');
    await frame.getByRole('button', { name: 'Sum squares in Python' }).click();
    await expect(frame.locator('#python-result')).toHaveText('Python sum of squares: 234');
    expect(fixture.requests.filter(request => request.path === '/observations.json')).toHaveLength(4);
    for (const request of fixture.requests) {
      expect(request.host).toBe(new URL(fixture.allowed).host);
      expect(request.headers.origin).toBe('null');
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers.authorization).toBeUndefined();
    }
    for (const url of [`${fixture.blocked}/observations.json`, `${fixture.allowed}/redirect`]) {
      await frame.getByLabel('Dataset URL').fill(url);
      await frame.getByRole('button', { name: 'Sum in JavaScript' }).click();
      await expect(frame.locator('#javascript-result')).toContainText('JavaScript failed:');
      await frame.getByRole('button', { name: 'Sum squares in Python' }).click();
      await expect(frame.locator('#python-result')).toContainText('Python failed:');
    }
    expect(fixture.requests.filter(request => request.path === '/redirect')).toHaveLength(2);
    expect(fixture.requests.some(request => request.host === new URL(fixture.blocked).host)).toBe(false);

    const model = page.frames().find(frame => frame.url().startsWith(settings.runtimeOrigin))!;
    // Appending an actual model script tests CSP. DevTools evaluation alone can bypass script restrictions.
    await model.evaluate(origin => {
      const script = document.createElement('script');
      script.textContent = `
(async () => {
  const origin = ${JSON.stringify(origin)};
  const deniedCode = (src, module) => new Promise(resolve => {
    const script = document.createElement('script');
    if (module) script.type = 'module';
    script.src = src;
    script.onload = () => resolve(false);
    script.onerror = () => resolve(true);
    document.head.append(script);
  });
  const classicScript = await deniedCode(origin + '/module.js', false);
  const moduleScript = await deniedCode(origin + '/module.js', true);
  const workerCode = \`(async () => {
    const origin = \${JSON.stringify(origin)};
    let classicImport = false, moduleImport = false;
    try { importScripts(origin + '/worker.js'); } catch { classicImport = true; }
    try { await import(origin + '/module.js'); } catch { moduleImport = true; }
    postMessage({ classicImport, moduleImport });
  })();\`;
  const url = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
  const worker = new Worker(url);
  worker.onmessage = ({ data }) => {
    window.__dataCodeDenied = { classicScript, moduleScript, ...data, executed: window.externalCodeExecuted === true };
    worker.terminate(); URL.revokeObjectURL(url);
  };
})().catch(error => { window.__dataCodeDenied = { error: String(error) }; });
`;
      document.head.append(script);
    }, fixture.allowed);
    await expect.poll(() => model.evaluate(() => (window as any).__dataCodeDenied)).toEqual({
      classicScript: true, moduleScript: true, classicImport: true, moduleImport: true, executed: false,
    });
    expect(fixture.requests.some(request => ['/module.js', '/worker.js'].includes(request.path))).toBe(false);
    let headerTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const observedHeaders = await Promise.race([Promise.all(modelRequests), new Promise<never>((_, reject) => {
        headerTimer = setTimeout(() => reject(new Error('Completed request headers were not available within five seconds')), 5000);
      })]);
      for (const requestHeaders of observedHeaders) {
        expect(requestHeaders.cookie).toBeUndefined(); expect(requestHeaders.authorization).toBeUndefined();
      }
    } finally { clearTimeout(headerTimer); }
    expect(await context.cookies(settings.runtimeOrigin)).toEqual([]);
    const policy = (await page.request.get(capability.url)).headers()['content-security-policy'];
    expect(policy.split('connect-src ')[1]!.split(';')[0]).toBe(`${settings.runtimeOrigin} ${fixture.allowed}`);
    expect(policy).toContain(`script-src 'unsafe-inline' 'wasm-unsafe-eval' ${settings.runtimeOrigin};`);
    expect(policy).toContain(`worker-src blob: ${settings.runtimeOrigin};`);
    expect(policy).toContain('sandbox allow-scripts');
    expect((await page.request.get(`/api/launches/${capability.id}`)).status()).toBe(200);
    project = await origins(page, project, []);
    expect((await page.request.get(capability.url)).status()).toBe(404);
    expect((await page.request.get(`${settings.runtimeOrigin}/bridge/${capability.id}/bridge.js`)).status()).toBe(404);
    expect((await page.request.get(`/api/launches/${capability.id}`)).status()).toBe(404);
    console.log(`External-data fixture retained in isolated ${instance}: ${project.id}`);
  } finally {
    if (capability) await page.request.delete(`/api/launches/${capability.id}`, { headers: { ...headers, 'Content-Type': 'application/json' }, timeout: 5000 }).catch(() => {});
    await page.request.delete('/api/session', { headers: { ...headers, 'Content-Type': 'application/json' }, timeout: 5000 }).catch(() => {});
    await context.close(); await browser.close(); await fixture.close();
  }
});

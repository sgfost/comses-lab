import { test, expect, type Page, type Frame, type Worker } from '@playwright/test';
import { readFileSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config, stateDir } from '../scripts/config.mjs';
import type { Launch, Project } from '../shared/contracts.ts';
import type { RuntimeEvent } from '../shared/runtime.ts';
const c = config();
const owner = JSON.parse(readFileSync(resolve(stateDir, 'credentials.json'), 'utf8')).users[0];
const events = (page: Page) => page.evaluate(() => (window as any).__runtimeEvents as RuntimeEvent[]);
async function signIn(page: Page) {
  await page.addInitScript(() => {
    (window as any).__runtimeEvents = [];
    addEventListener('message', event => {
      if (event.source === document.querySelector('iframe')?.contentWindow && event.origin === 'null' && event.data?.channel === 'lab-runtime')
        (window as any).__runtimeEvents.push(event.data);
    });
  });
  const response = await page.request.post('/api/session', {
    headers: { Origin: c.appOrigin }, data: { username: owner.username, password: owner.password },
  });
  expect(response.ok()).toBe(true);
}
async function openProject(page: Page, repo: string) {
  const { projects } = await (await page.request.get('/api/projects')).json();
  const project = projects.find((p: Project) => p.forgejoRepo === repo) as Project;
  expect(project).toBeTruthy();
  await page.goto(`/#/project/${project.id}?edit=1`);
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Console', exact: true }).click();
  return project;
}
async function launch(page: Page) {
  const response = page.waitForResponse(r => r.url().includes('/launch') && r.request().method() === 'POST');
  await page.getByRole('button', { name: /^(Run|Reload)$/ }).click();
  const result = await (await response).json() as Launch;
  await expect.poll(async () => (await events(page)).some(e => e.type === 'ready' && e.launchId === result.id)).toBe(true);
  return result;
}
const preview = (page: Page) => page.frameLocator('iframe[title="Artifact preview"]');
function modelFrame(page: Page): Frame { return page.frames().find(frame => frame.url().startsWith(c.runtimeOrigin))!; }
async function stopped(page: Page, worker: Worker, capability: Launch) {
  const closed = worker.waitForEvent('close');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await closed;
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect.poll(async () => (await page.request.get(capability.url)).status()).toBe(404);
  expect((await page.request.get(`${c.runtimeOrigin}/bridge/${capability.id}/bridge.js`)).status()).toBe(404);
  expect((await events(page)).some(event => event.type === 'stopped' && event.launchId === capability.id && event.workers === 1)).toBe(true);
}

test('ordinary JavaScript modules, genuine console/errors, worker reset and runaway stop', async ({ page }) => {
  await signIn(page);
  await openProject(page, 'random-walks');
  const capability = await launch(page);
  const frame = preview(page);
  await expect(frame.locator('#status')).toHaveText('Ready');
  await page.evaluate(id => {
    const child = document.querySelector('iframe')!.contentWindow!;
    child.postMessage({channel:'lab-runtime',version:1,launchId:id,type:'stop',extra:true}, '*');
    child.postMessage({channel:'lab-runtime',version:1,launchId:'x'.repeat(43),type:'stop'}, '*');
  }, capability.id);
  await modelFrame(page).evaluate(id => window.postMessage({channel:'lab-runtime',version:1,launchId:id,type:'stop'}, '*'), capability.id);
  await frame.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(frame.locator('#status')).toHaveText('Mean squared displacement: 205.904');
  await expect(page.getByRole('log', { name: 'Artifact console' })).toContainText('Mean squared displacement 205.904');
  await expect.poll(async () => (await events(page)).some(e => e.type === 'console' && e.text === 'Mean squared displacement 205.904')).toBe(true);
  await frame.locator('summary').click();
  await frame.getByRole('button', { name: 'Throw worker error' }).click();
  await expect.poll(async () => (await events(page)).some(e => e.type === 'error' && e.text.includes('Intentional random-walk worker error'))).toBe(true);
  await expect(page.getByRole('log', { name: 'Artifact console' })).toContainText('Intentional random-walk worker error');
  let worker = page.workers()[0]!;
  const resetClosed = worker.waitForEvent('close');
  await frame.getByRole('button', { name: 'Reset', exact: true }).click();
  await resetClosed;
  await expect(frame.locator('#status')).toHaveText('Ready');
  worker = page.workers()[0]!;
  await frame.getByRole('button', { name: 'Runaway worker' }).click();
  await expect(frame.locator('#status')).toContainText('Worker busy');
  await stopped(page, worker, capability);
  await launch(page);
  await expect(frame.locator('#status')).toHaveText('Ready');
  await frame.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(frame.locator('#status')).toContainText('205.904');
});

test('Python local imports, adjustable plot, interpreter reset, errors and runaway recovery', async ({ page }) => {
  await signIn(page);
  await openProject(page, 'heat-diffusion');
  const capability = await launch(page);
  const frame = preview(page);
  await expect(frame.locator('#status')).toHaveText('Python ready · Pyodide 0.29.5', { timeout: 30000 });
  await frame.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(frame.locator('#status')).toHaveText('Peak temperature: 88.536 · Total heat: 2000.000');
  await expect(page.getByRole('log', { name: 'Artifact console' })).toContainText('Computed 100 steps; diffusivity 0.2');
  await page.screenshot({ path: 'test-results/runtime-python-workspace.png' });
  const firstPlot = await frame.locator('canvas').evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  await frame.getByLabel('Diffusivity', { exact: true }).fill('0');
  await frame.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(frame.locator('#status')).toHaveText('Peak temperature: 100.000 · Total heat: 2000.000');
  expect(await frame.locator('canvas').evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).not.toBe(firstPlot);
  await expect.poll(async () => (await events(page)).some(e => e.type === 'console' && e.text === 'Computed 100 steps; diffusivity 0')).toBe(true);
  await frame.locator('summary').click();
  await frame.getByRole('button', { name: 'Raise Python error' }).click();
  await expect(frame.locator('#status')).toContainText('ValueError: Intentional heat-diffusion error');
  await expect(page.getByRole('log', { name: 'Artifact console' })).toContainText('Intentional heat-diffusion error');
  await expect.poll(async () => (await events(page)).some(e => e.type === 'console' && e.level === 'error' && e.text.includes('Intentional heat-diffusion error'))).toBe(true);
  await frame.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(frame.locator('#status')).toContainText('Total heat: 2000.000');
  const firstWorker = page.workers()[0]!;
  await firstWorker.evaluate(() => { (globalThis as any).oldInterpreterMarker = true; });
  const closed = firstWorker.waitForEvent('close');
  await frame.getByRole('button', { name: 'Runaway Python' }).click();
  await expect(frame.locator('#status')).toContainText('Python busy');
  await frame.getByRole('button', { name: 'Reset interpreter' }).click();
  await closed;
  await expect(frame.locator('#status')).toHaveText('Python ready · Pyodide 0.29.5', { timeout: 30000 });
  const secondWorker = page.workers()[0]!;
  expect(await secondWorker.evaluate(() => (globalThis as any).oldInterpreterMarker)).toBeUndefined();
  await frame.getByRole('button', { name: 'Runaway Python' }).click();
  await expect(frame.locator('#status')).toContainText('Python busy');
  await stopped(page, secondWorker, capability);
  await launch(page);
  await expect(frame.locator('#status')).toHaveText('Python ready · Pyodide 0.29.5', { timeout: 30000 });
  await frame.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(frame.locator('#status')).toContainText('Total heat: 2000.000');
});

for (const repo of ['random-walks', 'heat-diffusion']) {
  test(`${repo} denies app credentials, external network and eval in page and worker`, async ({ page }) => {
    const requests: Promise<Record<string, string>>[] = [];
    const requestedUrls: string[] = [];
    page.on('request', request => { requestedUrls.push(request.url()); if (request.url().startsWith(c.runtimeOrigin)) requests.push(request.allHeaders()); });
    await signIn(page);
    const automaticLaunch = page.waitForResponse(response => response.url().endsWith('/launch') && response.request().method() === 'POST');
    await openProject(page, repo);
    const capability = await (await automaticLaunch).json() as Launch;
    await expect(preview(page).locator('#run')).toBeEnabled({ timeout: 30000 });
    const networkOrigins = [...new Set(requestedUrls.filter(url => !url.startsWith('blob:null/')).map(url => new URL(url).origin))];
    expect(networkOrigins.filter(origin => ![c.appOrigin, c.runtimeOrigin].includes(origin))).toEqual([]);
    if (repo === 'heat-diffusion') {
      const engineFiles = requestedUrls.filter(url => url.includes('/vendor/')).map(url => new URL(url).pathname.split('/').pop());
      expect([...new Set(engineFiles)].sort()).toEqual(['pyodide-lock.json', 'pyodide.asm.js', 'pyodide.asm.wasm', 'pyodide.mjs', 'python_stdlib.zip'].sort());
    }
    // Execute as actual model script. DevTools evaluate itself bypasses eval CSP checks.
    await modelFrame(page).evaluate(appOrigin => {
      const script = document.createElement('script');
      script.textContent = `(${async function (appOrigin: string) {
        await new Promise(resolve => setTimeout(resolve, 0));
        const denied = (action: () => unknown) => { try { action(); return false; } catch { return true; } };
        const deniedFetch = async (url: string) => { try { await fetch(url, { credentials: 'include' }); return false; } catch { return true; } };
        const probe = {
          parent: denied(() => parent.document.body), cookie: denied(() => document.cookie),
          storage: denied(() => localStorage.getItem('lab-theme')), eval: denied(() => eval('1 + 1')),
          api: await deniedFetch(`${appOrigin}/api/session`), external: await deniedFetch('https://example.com/probe'),
        };
        const code = `(${async function (appOrigin: string) {
          let evalDenied = false, apiDenied = false;
          try { eval('1 + 1'); } catch { evalDenied = true; }
          try { await fetch(`${appOrigin}/api/session`, { credentials: 'include' }); } catch { apiDenied = true; }
          postMessage({ evalDenied, apiDenied });
        }.toString()})(${JSON.stringify(appOrigin)})`;
        const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        const worker = new Worker(url);
        worker.onmessage = ({ data }) => {
          (window as any).__securityProbe = { probe, workerProbe: data };
          worker.terminate(); URL.revokeObjectURL(url);
        };
      }.toString()})(${JSON.stringify(appOrigin)})`;
      document.head.append(script);
    }, c.appOrigin);
    await expect.poll(() => modelFrame(page).evaluate(() => (window as any).__securityProbe)).toEqual({
      probe: { parent: true, cookie: true, storage: true, eval: true, api: true, external: true },
      workerProbe: { evalDenied: true, apiDenied: true },
    });
    for (const headers of await Promise.all(requests)) { expect(headers.cookie).toBeUndefined(); expect(headers.authorization).toBeUndefined(); }
    expect(await page.context().cookies(c.runtimeOrigin)).toEqual([]);
    const response = await page.request.get(capability.url);
    const policy = response.headers()['content-security-policy'];
    expect(policy).toContain("'wasm-unsafe-eval'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).toContain("sandbox allow-scripts");
    for (const file of ['package.json', 'README.md', 'pyodide.js', '../package.json'])
      expect((await page.request.get(`${c.runtimeOrigin}/vendor/pyodide/0.29.5/${file}`)).status()).toBe(404);
  });
}

async function probeProject(page: Page) {
  const name = `runtime-probe-${randomUUID().slice(0, 8)}`;
  const headers = { Authorization: `Basic ${Buffer.from(`${owner.username}:${owner.password}`).toString('base64')}` };
  const repo = await (await page.request.post(`${c.forgejoUrl}/api/v1/user/repos`, {
    headers, data: { name, private: true, auto_init: false, default_branch: 'main' },
  })).json();
  const html = Buffer.from('\ufeff<!-- model preamble --><!doctype html><html><head><script>console.log("First model script");</script></head><body><h1>Runtime probes</h1><script type="module" src="./nested/entry.js"></script></body></html>');
  const files = new Map([
    ['index.html', html],
    ['nested/entry.js', Buffer.from('import { answer } from "./module.js"; console.log("Local module", answer); fetch("./data/bytes.bin").then(r => r.arrayBuffer()).then(b => console.log("Binary bytes", new Uint8Array(b).join(",")));')],
    ['nested/module.js', Buffer.from('export const answer = 42;\r\n')],
    ['data/bytes.bin', Buffer.from([0, 255, 195, 40, 13, 10, 128])],
  ]);
  const save = await page.request.post(`${c.forgejoUrl}/api/v1/repos/${owner.username}/${name}/contents`, {
    headers, data: { branch: 'main', message: 'Add runtime acceptance fixture', files: [...files].map(([path, content]) => ({ operation: 'create', path, content: content.toString('base64') })) },
  });
  expect(save.ok()).toBe(true);
  const database = new DatabaseSync(resolve(stateDir, 'lab.sqlite'));
  const user = database.prepare('SELECT id FROM users WHERE username=?').get(owner.username) as { id: string };
  const id = randomUUID();
  database.prepare('INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, 'Runtime probes', 'Isolated acceptance fixture', 'private', user.id, 'index.html', 'MIT', owner.username, name, repo.id);
  database.close();
  return { id, name, files };
}

test('launch instrumentation precedes model scripts while retained HTML, imports and binary bytes match Git', async ({ page }) => {
  await signIn(page);
  const fixture = await probeProject(page);
  await openProject(page, fixture.name);
  const capability = await launch(page);
  await expect.poll(async () => (await events(page)).filter(e => e.type === 'console').map(e => e.text)).toContain('Binary bytes 0,255,195,40,13,10,128');
  const telemetry = await events(page);
  expect(telemetry[0]?.type).toBe('ready');
  expect(telemetry[1]).toMatchObject({ type: 'console', text: 'First model script' });
  expect(telemetry).toContainEqual(expect.objectContaining({ type: 'console', text: 'Local module 42' }));
  const clone = mkdtempSync(resolve(stateDir, 'runtime-git-'));
  execFileSync('git', ['clone', '--quiet', '--no-checkout', `${c.forgejoUrl}/${owner.username}/${fixture.name}.git`, clone], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${owner.username}:${owner.password}`).toString('base64')}` },
  });
  for (const [path, bytes] of fixture.files) {
    const source = execFileSync('git', ['-C', clone, 'show', `${capability.commit}:${path}`]);
    expect(source.equals(bytes)).toBe(true);
    const response = await page.request.get(`${c.runtimeOrigin}/preview/${capability.id}/${path}`);
    expect(response.ok()).toBe(true);
    expect((await response.body()).equals(source)).toBe(true);
  }
  expect((await page.request.get(capability.url)).headers()['content-type']).toContain('text/html');
});

test('native frame teardown terminates untracked parent and nested workers without a stop acknowledgement', async ({ page }) => {
  await signIn(page);
  const project = await openProject(page, 'random-walks');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('iframe')).toHaveCount(0);
  const { commit } = await (await page.request.get(`/api/projects/${project.id}/tree`)).json();
  const capability = await (await page.request.post(`/api/projects/${project.id}/launch`, {headers:{Origin:c.appOrigin}, data:{commit}})).json() as Launch;
  // This raw document deliberately has no Lab bridge or active host binding.
  await page.evaluate(url => { const frame = document.createElement('iframe'); frame.title = 'Artifact preview'; frame.sandbox.add('allow-scripts'); frame.src = url.split('?')[0]!; document.body.append(frame); }, capability.url);
  await expect(preview(page).locator('#status')).toHaveText('Ready');
  await page.evaluate(() => {
    (window as any).__heartbeats = 0;
    addEventListener('message', event => {
      if (event.source === document.querySelector('iframe')?.contentWindow && event.data?.type === 'heartbeat-port')
        event.ports[0]!.onmessage = () => (window as any).__heartbeats++;
    });
  });
  await modelFrame(page).evaluate(appOrigin => {
    // Bypass bridge tracking deliberately; the browser's document teardown is the fallback.
    const NativeWorker = Worker;
    const child = `onmessage = e => { const port = e.ports[0]; setInterval(() => port.postMessage('beat'), 30); postMessage('started'); };`;
    const parentCode = `const child = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(child)}], {type:'text/javascript'}))); onmessage = e => child.postMessage('port', [e.ports[0]]); child.onmessage = () => { while(true) {} };`;
    const worker = new NativeWorker(URL.createObjectURL(new Blob([parentCode], { type: 'text/javascript' })));
    const channel = new MessageChannel();
    parent.postMessage({ type: 'heartbeat-port' }, appOrigin, [channel.port1]);
    worker.postMessage('port', [channel.port2]);
  }, c.appOrigin);
  const heartbeats = () => page.evaluate(() => (window as any).__heartbeats as number);
  await expect.poll(heartbeats).toBeGreaterThan(3);
  // Send no stop command. Removing the owning document must terminate every descendant worker.
  await page.evaluate(() => document.querySelector('iframe')!.remove());
  await expect.poll(() => page.workers().length).toBe(0);
  await page.waitForTimeout(100);
  const afterTeardown = await heartbeats();
  await page.waitForTimeout(250);
  expect(await heartbeats()).toBe(afterTeardown);
  await page.request.delete(`/api/launches/${capability.id}`, { headers: { Origin: c.appOrigin, 'Content-Type': 'application/json' } });
  expect((await page.request.get(capability.url)).status()).toBe(404);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeEnabled();
  await launch(page);
  await expect(preview(page).locator('#status')).toHaveText('Ready');
});

test('repeat bootstrap preserves seeded project IDs, metadata and Git heads', async ({ page }) => {
  await signIn(page);
  const snapshots = async () => {
    const { projects } = await (await page.request.get('/api/projects')).json();
    const seeded = projects.filter((project: Project) => ['commons-garden', 'private-garden', 'random-walks', 'heat-diffusion'].includes(project.forgejoRepo)) as Project[];
    expect(seeded).toHaveLength(4);
    return Promise.all(seeded.map(async project => ({ project, commit: (await (await page.request.get(`/api/projects/${project.id}/tree`)).json()).commit })));
  };
  const before = await snapshots();
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/bootstrap.ts'], { env: process.env, stdio: 'pipe' });
  expect(await snapshots()).toEqual(before);
});

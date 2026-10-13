import { test, expect, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, stateDir, instance } from '../scripts/config.mjs';
import type { CreateProjectResponse, CreateGrantResponse, Group, Launch, ProjectAccessResponse } from '../shared/contracts.ts';

const settings = config();
if (!instance.startsWith('test-')) throw new Error('Revocation acceptance requires an isolated test instance');
const accounts = JSON.parse(readFileSync(resolve(stateDir, 'credentials.json'), 'utf8')).users as { username: string; password: string }[];
const headers = { Origin: settings.appOrigin, 'Content-Type': 'application/json' };
async function login(context: APIRequestContext, username = 'ada') {
  const account = accounts.find(user => user.username === username)!;
  expect((await context.post('/api/session', { headers, data: account })).status()).toBe(200);
}
async function launch(context: APIRequestContext, project: CreateProjectResponse, credentialHeaders: Record<string, string> = headers) {
  const response = await context.post(`/api/projects/${project.project.id}/launch`, { headers: credentialHeaders, data: { commit: project.commit } });
  expect(response.status(), await response.text()).toBe(200);
  return await response.json() as Launch;
}
async function grant(owner: APIRequestContext, projectId: string, name: string) {
  const response = await owner.post('/api/agent-grants', { headers, data: { name, projects: [{ projectId, permission: 'read' }] } });
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as CreateGrantResponse;
}
async function revoked(context: APIRequestContext, capability: Launch, credentialHeaders: Record<string, string> = headers) {
  expect((await context.get(capability.url)).status()).toBe(404);
  expect((await context.get(`${settings.runtimeOrigin}/bridge/${capability.id}/bridge.js`)).status()).toBe(404);
  expect((await context.get(`/api/launches/${capability.id}`, { headers: credentialHeaders })).status()).toBe(404);
}

test('exact session and grant ownership survives unrelated credential invalidation; access and grant revocation remove capabilities', async ({ playwright }) => {
  test.setTimeout(90000);
  const contexts = await Promise.all(Array.from({ length: 7 }, () => playwright.request.newContext({ baseURL: settings.appOrigin })));
  const [owner, secondSession, writer, reader, agentOne, agentTwo, anonymous] = contexts;
  const grants: CreateGrantResponse[] = [];
  try {
    await login(owner!); await login(secondSession!); await login(writer!, 'ben'); await login(reader!, 'cy');
    const response = await owner!.post('/api/projects', { headers, data: {
      requestId: randomUUID(), templateId: 'commons', title: `Runtime access ${randomUUID().slice(0, 8)}`, visibility: 'private',
    } });
    expect(response.status(), await response.text()).toBe(201);
    const project = await response.json() as CreateProjectResponse;
    const first = await launch(owner!, project);
    const second = await launch(secondSession!, project);
    expect((await owner!.get(`/api/launches/${first.id}`)).status()).toBe(200);
    expect((await secondSession!.get(`/api/launches/${first.id}`)).status()).toBe(404);
    expect((await secondSession!.delete(`/api/launches/${first.id}`, { headers })).status()).toBe(404);
    expect((await anonymous!.get(`/api/launches/${first.id}`)).status()).toBe(401);
    expect((await owner!.get(first.url)).status()).toBe(200);
    expect((await secondSession!.delete('/api/session', { headers })).status()).toBe(200);
    await revoked(owner!, second);
    expect((await owner!.get(`/api/launches/${first.id}`)).status()).toBe(200);

    const grantOne = await grant(owner!, project.project.id, 'Runtime credential one');
    const grantTwo = await grant(owner!, project.project.id, 'Runtime credential two');
    grants.push(grantOne, grantTwo);
    const oneHeaders = { Authorization: `Bearer ${grantOne.token}`, 'Content-Type': 'application/json' };
    const twoHeaders = { Authorization: `Bearer ${grantTwo.token}`, 'Content-Type': 'application/json' };
    const agentLaunchOne = await launch(agentOne!, project, oneHeaders);
    const agentLaunchTwo = await launch(agentTwo!, project, twoHeaders);
    expect((await agentOne!.get(`/api/launches/${agentLaunchOne.id}`, { headers: oneHeaders })).status()).toBe(200);
    expect((await owner!.get(`/api/launches/${agentLaunchOne.id}`)).status()).toBe(404);
    expect((await owner!.delete(`/api/launches/${agentLaunchOne.id}`, { headers })).status()).toBe(404);
    expect((await agentTwo!.get(`/api/launches/${agentLaunchOne.id}`, { headers: twoHeaders })).status()).toBe(404);
    expect((await agentTwo!.delete(`/api/launches/${agentLaunchOne.id}`, { headers: twoHeaders })).status()).toBe(404);
    expect((await owner!.delete(`/api/agent-grants/${grantOne.grant.id}`, { headers })).status()).toBe(200);
    expect((await agentOne!.get(agentLaunchOne.url)).status()).toBe(404);
    expect((await agentOne!.get(`${settings.runtimeOrigin}/bridge/${agentLaunchOne.id}/bridge.js`)).status()).toBe(404);
    expect((await agentOne!.get(`/api/launches/${agentLaunchOne.id}`, { headers: oneHeaders })).status()).toBe(401);
    expect((await agentTwo!.get(`/api/launches/${agentLaunchTwo.id}`, { headers: twoHeaders })).status()).toBe(200);
    expect((await owner!.get(`/api/launches/${first.id}`)).status()).toBe(200);

    const { groups } = await (await owner!.get('/api/groups')).json() as { groups: Group[] };
    const group = groups.find(group => group.permission === 'admin');
    expect(group).toBeTruthy();
    let access = await (await owner!.get(`/api/projects/${project.project.id}/access`)).json() as ProjectAccessResponse;
    let changed = await owner!.put(`/api/projects/${project.project.id}/access`, { headers, data: {
      requestId: randomUUID(), expectedVersion: access.version, visibility: 'private', groupId: group!.id,
    } });
    expect(changed.status(), await changed.text()).toBe(200);
    access = await changed.json() as ProjectAccessResponse;
    // Acceptance revokes all old project snapshots, including owner and active grant previews.
    await revoked(owner!, first); await revoked(agentTwo!, agentLaunchTwo, twoHeaders);
    const writerLaunch = await launch(writer!, project);
    const readerLaunch = await launch(reader!, project);
    const ownerLaunch = await launch(owner!, project);
    changed = await owner!.put(`/api/projects/${project.project.id}/access`, { headers, data: {
      requestId: randomUUID(), expectedVersion: access.version, visibility: 'private', groupId: null,
    } });
    expect(changed.status(), await changed.text()).toBe(200);
    for (const [context, capability] of [[writer!, writerLaunch], [reader!, readerLaunch], [owner!, ownerLaunch]] as const)
      await revoked(context, capability);
    expect((await writer!.get(`/api/projects/${project.project.id}/tree`)).status()).toBe(404);
    expect((await reader!.get(`/api/projects/${project.project.id}/tree`)).status()).toBe(404);
    const recovery = await launch(owner!, project);
    expect((await owner!.get(`/api/launches/${recovery.id}`)).status()).toBe(200);
    expect((await owner!.delete(`/api/launches/${recovery.id}`, { headers })).status()).toBe(200);
    await revoked(owner!, recovery);
    console.log(`Runtime revocation fixture retained in isolated ${instance}: ${project.project.id}`);
  } finally {
    for (const created of grants) await owner!.delete(`/api/agent-grants/${created.grant.id}`, { headers }).catch(() => {});
    for (const context of [owner!, writer!, reader!]) await context.delete('/api/session', { headers }).catch(() => {});
    await Promise.all(contexts.map(context => context.dispose()));
  }
});

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const instance = process.env.LAB_INSTANCE;
if (!instance || !/^test-[a-z0-9-]+$/.test(instance))
  throw new Error('Use an initialized isolated test-* instance');
const state = join(process.cwd(), '.lab', instance);
const config = JSON.parse(readFileSync(join(state, 'config.json'), 'utf8'));
assert.equal(config.instance, instance);
assert.equal(new URL(config.forgejoUrl).hostname, '127.0.0.1');
const credentials = JSON.parse(readFileSync(join(state, 'credentials.json'), 'utf8'));
const owner = credentials.users.find(u => u.username === 'ada');
const url = config.forgejoUrl;
const suffix = randomUUID().slice(0, 8);
const work = mkdtempSync(join(tmpdir(), 'lab-token-probe-'));
const report = [];
const issued = [];
function record(label, actual, expected) {
  report.push({ label, actual, expected });
  console.log(JSON.stringify(report.at(-1)));
  assert.equal(actual, expected, label);
}
async function api(path, secret, init = {}) {
  const authorization = secret === owner.password
    ? `Basic ${Buffer.from(`${owner.username}:${secret}`).toString('base64')}`
    : `token ${secret}`;
  return fetch(`${url}/api/v1${path}`, {
    ...init,
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
}
async function token(scope) {
  const r = await api(`/users/${owner.username}/tokens`, owner.password, {
    method: 'POST',
    body: JSON.stringify({ name: `lab-probe-${scope}-${suffix}`, scopes: [scope], repositories: [{ owner: owner.username, name: 'private-garden' }] }),
  });
  assert.equal(r.status, 201, 'token creation');
  const result = await r.json();
  issued.push(result.id);
  assert.equal(result.repositories.length, 1);
  return result;
}
function denied(label, result) {
  assert.notEqual(result.status, 0, label);
  assert.match(result.stderr ?? '', /403|404|401|Authentication failed|repository.*not found|not allowed|denied|could not read Username.*terminal prompts disabled/i, `${label}: expected an authorization failure`);
  record(label, 'denied', 'denied');
}
function git(args, secret, cwd = work) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${owner.username}:${secret}`).toString('base64')}`,
  });
  return spawnSync('git', ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, encoding: 'utf8', timeout: 30000 });
}
try {
  const other = `scope-private-${suffix}`;
  let r = await api('/user/repos', owner.password, { method: 'POST', body: JSON.stringify({ name: other, private: true, auto_init: true }) });
  record('create isolated out-of-scope private repository', r.status, 201);
  const write = await token('write:repository');
  const read = await token('read:repository');
  for (const [label, path, expected] of [
    ['selected private API read', '/repos/ada/private-garden', 200],
    ['other private API denied', `/repos/ada/${other}`, 404],
    ['unselected public API read', '/repos/ada/commons-garden', 200],
    ['token management API denied', '/users/ada/tokens', 403],
  ]) {
    r = await api(path, write.sha1);
    record(label, r.status, expected);
  }
  r = await api('/repos/ada/private-garden', write.sha1, { method: 'PATCH', body: JSON.stringify({ private: false }) });
  record('selected repository publicization denied', r.status, 403);
  r = await api('/repos/ada/private-garden/collaborators/ben', write.sha1, { method: 'PUT', body: JSON.stringify({ permission: 'write' }) });
  record('selected collaborator administration denied', r.status, 403);
  r = await api('/user/repos', write.sha1, { method: 'POST', body: JSON.stringify({ name: `denied-${suffix}`, private: true }) });
  record('account repository creation denied', r.status, 403);
  const selected = join(work, 'selected');
  record('selected private Git clone', git(['clone', `${url}/ada/private-garden.git`, selected], write.sha1).status, 0);
  denied('unselected private Git read denied', git(['ls-remote', `${url}/ada/${other}.git`], write.sha1));
  const publicRepo = join(work, 'public');
  record('unselected public Git clone', git(['clone', `${url}/ada/commons-garden.git`, publicRepo], write.sha1).status, 0);
  for (const cwd of [selected, publicRepo]) {
    writeFileSync(join(cwd, 'scope-probe.txt'), 'ordinary Git token probe\n');
    assert.equal(git(['add', 'scope-probe.txt'], write.sha1, cwd).status, 0);
    assert.equal(git(['-c', 'user.name=Token probe', '-c', 'user.email=probe@lab.invalid', 'commit', '-m', 'Probe scoped write'], write.sha1, cwd).status, 0);
  }
  record('selected Git write', git(['push', 'origin', `HEAD:refs/heads/probe-${suffix}`], write.sha1, selected).status, 0);
  denied('unselected public Git write denied', git(['push', 'origin', `HEAD:refs/heads/probe-${suffix}`], write.sha1, publicRepo));
  record('read-only selected Git read', git(['ls-remote', `${url}/ada/private-garden.git`], read.sha1).status, 0);
  denied('read-only selected Git write denied', git(['push', 'origin', `HEAD:refs/heads/read-denied-${suffix}`], read.sha1, selected));
  r = await api(`/users/ada/tokens/${write.id}`, owner.password, { method: 'DELETE' });
  record('revoke scoped write token', r.status, 204);
  r = await api('/repos/ada/private-garden', write.sha1);
  record('revoked token API denied', r.status, 401);
  r = await fetch(`${url}/ada/private-garden.git/info/refs?service=git-upload-pack`, {
    headers: { Authorization: `Basic ${Buffer.from(`${owner.username}:${write.sha1}`).toString('base64')}` },
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  record('revoked token Git HTTP authentication denied', r.status, 401);
  denied('revoked token Git read denied', git(['ls-remote', `${url}/ada/private-garden.git`], write.sha1));
  denied('revoked token Git write denied', git(['push', 'origin', `HEAD:refs/heads/revoked-${suffix}`], write.sha1, selected));
  record('unrelated read token still valid', git(['ls-remote', `${url}/ada/private-garden.git`], read.sha1).status, 0);
} finally {
  const cleanupErrors = [];
  for (const id of issued) {
    try {
      const r = await api(`/users/ada/tokens/${id}`, owner.password, { method: 'DELETE' });
      if (![204, 404].includes(r.status)) cleanupErrors.push(`Token ${id}: HTTP ${r.status}`);
    } catch {
      cleanupErrors.push(`Token ${id}: cleanup request failed`);
    }
  }
  try {
    writeFileSync(join(work, 'report.json'), JSON.stringify({ checks: report, cleanupErrors }, null, 2) + '\n');
    console.log(`Probe report: ${join(work, 'report.json')}`);
  } catch {
    cleanupErrors.push('Could not write probe report');
  }
  if (cleanupErrors.length) throw new Error(cleanupErrors.join('; '));
}

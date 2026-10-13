import type { DemoState, DemoSeed } from './types';
export const demoUser = { id: 'demo-local', username: 'you', displayName: 'You (this browser)' };
export const demoBase = new URL(import.meta.env.BASE_URL, document.baseURI);
const databaseName = `comses-lab-demo:${demoBase.pathname}`;
let database: Promise<IDBDatabase> | undefined;
export function openDatabase() {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspace');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Browser storage is unavailable. Allow site storage to use the demo.'));
  });
}
export async function readState(): Promise<DemoState> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('workspace').objectStore('workspace').get('state');
    request.onsuccess = () => resolve(request.result ?? { version: 1, projects: [], requests: {} });
    request.onerror = () => reject(request.error);
  });
}
export async function writeState(state: DemoState) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('workspace', 'readwrite');
    transaction.objectStore('workspace').put(state, 'state');
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(new Error('Could not save to browser storage. Export your workspace or free some space and retry.'));
  });
}
let seedPromise: Promise<DemoSeed> | undefined;
export function seed(): Promise<DemoSeed> {
  return seedPromise ??= fetch(new URL('demo-seed.json', demoBase)).then(async response => {
    if (!response.ok) throw new Error('Could not load demo examples. Reload to retry.');
    return response.json();
  }).catch(error => { seedPromise = undefined; throw error; });
}
export async function workspaceLock<T>(run: () => Promise<T>): Promise<T> {
  return await navigator.locks.request(databaseName, run);
}
export async function exportWorkspace() {
  return JSON.stringify(await readState(), null, 2);
}
export async function resetWorkspace() {
  await workspaceLock(() => writeState({ version: 1, projects: [], requests: {} }));
  // The existing editor's emergency recovery keys are separate from its API drafts.
  for (const key of Object.keys(localStorage)) if (key.startsWith(`lab-draft:${demoBase.pathname}:demo-local:`)) localStorage.removeItem(key);
}
export function validPath(path: string): boolean {
  return typeof path === 'string' && path.length > 0 && path.length <= 500 && !/[\\\x00-\x1f]/.test(path) && path.split('/').every(part => !!part && !['.', '..', '__proto__', 'constructor', 'prototype'].includes(part));
}
export function validateFiles(files: unknown): asserts files is Record<string,string> {
  if (!files || typeof files !== 'object' || Array.isArray(files) || Object.keys(files).length > 100) throw new Error('A project can contain up to 100 text files.');
  let total = 0;
  for (const [path, content] of Object.entries(files)) {
    if (!validPath(path) || typeof content !== 'string' || content.includes('\0') || new TextEncoder().encode(content).length > 2_000_000) throw new Error('Use ordinary relative paths and text files up to 2 MB.');
    total += new TextEncoder().encode(content).length;
  }
  if (total > 5_000_000) throw new Error('A project snapshot can contain up to 5 MB of text.');
}
export async function importWorkspace(text: string) {
  if (text.length > 50_000_000) throw new Error('Workspace export exceeds 50 MB.');
  const value = JSON.parse(text) as DemoState;
  if (value.version !== 1 || !Array.isArray(value.projects) || value.projects.length > 100) throw new Error('Choose a CoMSES Lab demo workspace export.');
  const ids = new Set<string>((await seed()).projects.map(p => p.project.id));
  for (const item of value.projects) {
    const p = item.project;
    if (!p || !/^local-[a-f0-9-]{36}$/.test(p.id) || ids.has(p.id) || typeof p.title !== 'string' || typeof p.description !== 'string' || typeof p.license !== 'string' || !['model','library'].includes(p.kind) || !(p.entrypoint === '' || validPath(p.entrypoint)) || !Number.isInteger(p.metadataVersion) || !Array.isArray(item.versions) || !item.versions.length || item.versions.length > 500) throw new Error('Invalid project in workspace export.');
    ids.add(p.id);
    const versions = new Set<string>();
    for (const v of item.versions) {
      if (!/^[a-f0-9]{40}$/.test(v.commit) || versions.has(v.commit) || !Array.isArray(v.parents) || v.parents.some(id => !/^[a-f0-9]{40}$/.test(id)) || typeof v.message !== 'string' || typeof v.author?.name !== 'string' || !Number.isFinite(Date.parse(v.author?.date))) throw new Error('Invalid version in workspace export.');
      validateFiles(v.files); versions.add(v.commit);
    }
    // Imported projects always belong to this browser; no imported identity grants authority.
    item.project = { ...p, ownerId: demoUser.id, ownerName: demoUser.displayName, permission: 'admin', visibility: 'public', dataOrigins: [], forgejoOwner: '', forgejoRepo: '', forgejoId: 0 };
    const d = item.draft;
    if (d && (!versions.has(d.baseCommit) || d.ref !== 'refs/heads/main' || !Number.isInteger(d.version) || !Array.isArray(d.changes))) throw new Error('Invalid draft in workspace export.');
    if (d) for (const change of d.changes) {
      if (!validPath(change.path) || !['create','update','delete'].includes(change.operation) || (change.operation !== 'delete' && typeof change.content !== 'string')) throw new Error('Invalid draft change in workspace export.');
    }
    if (d) {
      const files = { ...item.versions.find(v => v.commit === d.baseCommit)!.files };
      for (const change of d.changes) {
        if (change.operation === 'delete') delete files[change.path];
        else files[change.path] = change.content;
      }
      validateFiles(files);
    }
  }
  await workspaceLock(async () => {
    const current = await readState();
    if (value.projects.some(p => current.projects.some(existing => existing.project.id === p.project.id))) throw new Error('This workspace already contains an imported project. Reset the demo before restoring this backup.');
    await writeState({ ...current, projects: [...current.projects, ...value.projects] });
  });
}

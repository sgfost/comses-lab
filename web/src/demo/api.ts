import { createTwoFilesPatch } from 'diff';
import { ApiRequestError } from '../api';
import type { FileChange, LibraryPin, LibraryDependency, Project } from '../../../shared/contracts';
import type { DemoProject, Files, Version } from './types';
import { demoUser, readState, writeState, seed, workspaceLock, validPath, validateFiles } from './storage';
import { createDemoLaunch, getDemoLaunch, revokeDemoLaunch } from './preview';

function fail(status: number, code: string, message: string): never { throw new ApiRequestError(status, { code, message }); }
export async function hash(text: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2,'0')).join(''); }
function version(p: DemoProject, ref = 'main') {
  const value = ['main', 'refs/heads/main', ''].includes(ref) ? p.versions[0] : p.versions.find(v => v.commit === ref);
  if (!value) fail(404, 'not_found', 'Version not found in this browser.');
  return value;
}
function changes(base: Files, list: FileChange[]): Files {
  const files = { ...base };
  if (!Array.isArray(list)) fail(422, 'invalid_changes', 'Use a list of file changes.');
  for (const change of list) {
    if (!validPath(change.path)) fail(422, 'invalid_path', 'Use an ordinary relative file path.');
    if (change.operation === 'delete') delete files[change.path];
    else if (['create','update'].includes(change.operation) && typeof change.content === 'string') files[change.path] = change.content;
    else fail(422, 'invalid_changes', 'Invalid file change.');
  }
  validateFiles(files); return files;
}
function fileChanges(base: Files, next: Files): FileChange[] {
  return [...new Set([...Object.keys(base), ...Object.keys(next)])].filter(path => base[path] !== next[path]).map(path => next[path] === undefined ? { operation: 'delete', path } : { operation: base[path] === undefined ? 'create' : 'update', path, content: next[path]! });
}
async function saveVersion(p: DemoProject, files: Files, message: string) {
  validateFiles(files);
  const commit = (await hash(JSON.stringify({ files, nonce: crypto.randomUUID() }))).slice(0,40);
  const v: Version = { commit, parents: p.versions.length ? [p.versions[0]!.commit] : [], message: message || 'Save version', author: { name: demoUser.displayName, date: new Date().toISOString() }, files };
  p.versions.unshift(v); return { ref: 'refs/heads/main', commit };
}
function draft(p: DemoProject, expected: number) {
  if ((p.draft?.version ?? 0) !== expected) fail(409, 'stale_draft', 'This draft changed in another tab. Reload before editing.');
  return p.draft;
}
function setDraft(p: DemoProject, base: string, list: FileChange[]) {
  changes(version(p, base).files, list);
  return p.draft = { ref: 'refs/heads/main', baseCommit: base, version: (p.draft?.version ?? 0) + 1, changes: list, updatedAt: Date.now(), savingCommit: null };
}
function writable(p: DemoProject) { if (p.project.ownerId !== demoUser.id) fail(403, 'read_only', 'Fork this example to edit your own copy.'); }
function pins(files: Files, prefix = ''): LibraryPin[] {
  const raw = files[`${prefix}lab.lock.json`];
  if (!raw) return [];
  let value: { version: number; libraries: LibraryPin[] };
  try { value = JSON.parse(raw); } catch { fail(422, 'invalid_library', 'lab.lock.json must contain valid JSON.'); }
  if (value.version !== 1 || !Array.isArray(value.libraries) || value.libraries.length > 32) fail(422, 'invalid_library', 'Invalid library manifest.');
  for (const pin of value.libraries) if (!pin || !validPath(pin.directory) || typeof pin.projectId !== 'string' || !/^[a-f0-9]{40}$/.test(pin.commit) || !Array.isArray(pin.files) || pin.files.length > 90 || pin.files.some(f => !f || !validPath(f.source) || f.path !== `${pin.directory}/${f.source}` || !/^[a-f0-9]{64}$/.test(f.sha256))) fail(422, 'invalid_library', 'Invalid library pin.');
  return value.libraries;
}
async function unmodified(files: Files, pin: LibraryPin, prefix = '') {
  for (const f of pin.files) if (files[prefix+f.path] === undefined || await hash(files[prefix+f.path]!) !== f.sha256) return false;
  return true;
}
async function dependencies(all: DemoProject[], files: Files, prefix = '', depth = 0, budget = { count: 0 }): Promise<LibraryDependency[]> {
  if (depth > 8) fail(422, 'invalid_library', 'Library nesting exceeds 8 levels.');
  return Promise.all(pins(files, prefix).map(async pin => {
    if (++budget.count > 64) fail(422, 'invalid_library', 'Library hierarchy exceeds 64 entries.');
    return { ...pin, project: all.find(p => p.project.id === pin.projectId)?.project ?? null, modified: !await unmodified(files, pin, prefix), children: await dependencies(all, files, `${prefix}${pin.directory}/`, depth+1, budget) };
  }));
}

export async function demoApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  return workspaceLock(async () => {
    init.signal?.throwIfAborted();
    const state = await readState();
    const examples = await seed();
    const all = [...examples.projects, ...state.projects];
    const url = new URL(path, 'https://demo.invalid');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const query = url.searchParams;
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const find = (id: string) => { const p = all.find(p => p.project.id === id); if (!p) fail(404, 'not_found', 'Project not found. Local projects are available only in the browser where they were created.'); return p; };
    let changed = false;
    async function route(): Promise<unknown> {
      if (parts[0] === 'session' && method === 'GET') return { user: demoUser };
      if (parts[0] === 'templates') return { templates: examples.templates.map(({files, ...t}) => t) };
      if (parts[0] === 'launches') {
        if (method === 'DELETE') { revokeDemoLaunch(parts[1]!); return { ok: true }; }
        const launch = getDemoLaunch(parts[1]!); if (!launch) fail(404, 'not_found', 'Preview ended. Run it again.');
        return { id: launch.id, expiresAt: launch.expiresAt, state: 'active' };
      }
      if (parts[0] !== 'projects') fail(404, 'demo_unavailable', 'This feature requires the hosted Lab.');
      if (parts.length === 1 && method === 'GET') return { projects: all.map(p => p.project) };
      const p = parts[1] ? find(parts[1]) : undefined;
      const action = parts.slice(2).join('/');
      if (method === 'POST' && (!p || ['forks','extractions'].includes(action))) {
        const previous = state.requests[body.requestId];
        if (previous) { const result = find(previous); return { project: result.project, ref: 'refs/heads/main', commit: result.versions[0]!.commit }; }
        if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 120) fail(422, 'invalid_title', 'Enter a title up to 120 characters.');
        const template = examples.templates.find(t => t.id === body.templateId);
        if (!p && !template) fail(422, 'invalid_template', 'Select a template.');
        let files = { ...(p ? version(p, body.commit).files : template!.files) };
        if (action === 'extractions') files = Object.fromEntries((body.paths as string[]).map(path => { if (!validPath(path) || files[path] === undefined) fail(422, 'invalid_path', 'Select existing source files.'); return [path, files[path]!]; }));
        if (body.netlogoFile) files = { [body.netlogoFile.name]: body.netlogoFile.content };
        validateFiles(files);
        const id = `local-${crypto.randomUUID()}`;
        const origin = p ? { projectId: p.project.id, commit: version(p, body.commit).commit } : null;
        const project: Project = { id, kind: action === 'extractions' ? 'library' : p?.project.kind ?? template!.kind, title: body.title.trim(), description: body.description ?? p?.project.description ?? template?.description ?? '', entrypoint: action === 'extractions' ? '' : body.netlogoFile?.name ?? p?.project.entrypoint ?? template!.entrypoint, license: body.netlogoFile ? 'Unspecified' : p?.project.license ?? template!.license, permission: 'admin', visibility: 'public', ownerId: demoUser.id, ownerName: demoUser.displayName, metadataVersion: 0, dataOrigins: [], forkedFrom: action === 'forks' ? origin : null, extractedFrom: action === 'extractions' ? origin : null, forgejoOwner: '', forgejoRepo: '', forgejoId: 0 };
        const local: DemoProject = { project, versions: [], draft: null };
        const result = await saveVersion(local, files, p ? `Copy ${p.project.title}` : 'Create project');
        state.projects.push(local); if (typeof body.requestId === 'string') state.requests[body.requestId] = id;
        changed = true; return { project, ...result };
      }
      if (!p) fail(404, 'not_found', 'Project not found.');
      if (!action && method === 'GET') return { project: p.project };
      if (action === 'access' && method === 'GET') return { projectId: p.project.id, version: 0, effective: { visibility: 'public', groupId: null, mode: 'normal' }, sync: { state: 'ready' } };
      if (action === 'tree') { const v = version(p, query.get('ref') ?? 'main'); return { commit: v.commit, files: Object.entries(v.files).map(([path, content]) => ({ path, size: new TextEncoder().encode(content).length })) }; }
      if (action === 'file') { const v = version(p, query.get('commit') ?? 'main'); const path = query.get('path')!; if (!Object.hasOwn(v.files,path)) fail(404, 'not_found', 'File not found.'); return { commit: v.commit, path, content: v.files[path] }; }
      if (action === 'refs') return { kind: query.get('kind') ?? 'branch', defaultBranch: 'main', page: 1, limit: 50, nextPage: null, refs: query.get('kind') === 'tag' ? [] : [{ name: 'main', ref: 'refs/heads/main', commit: p.versions[0]!.commit }] };
      if (action === 'history') {
        const selected = version(p, query.get('commit') ?? 'main'); const page = Math.max(1, Number(query.get('page') || 1)); const limit = Math.min(100, Math.max(1, Number(query.get('limit') || 50)));
        const list = p.versions.slice(p.versions.indexOf(selected));
        return { commit: selected.commit, page, limit, nextPage: page*limit < list.length ? page+1 : null, commits: list.slice((page-1)*limit,page*limit).map(({files,...v}) => v) };
      }
      if (action === 'diff') {
        const v = version(p, query.get('commit') ?? 'main'); const previous = p.versions.find(x => x.commit === v.parents[0]);
        const before = previous?.files ?? {};
        const patch = [...new Set([...Object.keys(before), ...Object.keys(v.files)])].filter(path => before[path] !== v.files[path]).map(path => createTwoFilesPatch(`a/${path}`, `b/${path}`, before[path] ?? '', v.files[path] ?? '')).join('\n');
        return { commit: v.commit, base: previous?.commit ?? null, patch };
      }
      if (action === 'launch' && method === 'POST') { const v = version(p, body.commit); return createDemoLaunch({ ...p.project, entrypoint: body.entrypoint ?? p.project.entrypoint }, v.commit, changes(v.files, body.changes ?? []), !!body.changes?.length, body.edit === true && ['write', 'admin'].includes(p.project.permission)); }
      if (action === 'draft' && method === 'GET') return { draft: p.draft };
      if (action === 'libraries' && method === 'GET') {
        const d = query.get('draft') === '1' ? p.draft : null;
        const v = version(p, d?.baseCommit ?? query.get('commit') ?? 'main');
        return { commit: v.commit, libraries: await dependencies(all, changes(v.files, d?.changes ?? [])) };
      }
      writable(p);
      if (!action && method === 'PATCH') {
        if (body.expectedMetadataVersion !== p.project.metadataVersion) fail(409, 'stale_metadata', 'Project details changed. Reload and retry.');
        for (const [key, limit] of [['title',120],['description',4000],['license',100],['entrypoint',500]] as const) {
          if (body[key] !== undefined) {
            if (typeof body[key] !== 'string' || body[key].length > limit || (['title','license'].includes(key) && !body[key].trim())) fail(422,'invalid_metadata',`Invalid ${key}.`);
            p.project[key] = body[key];
          }
        }
        if (body.dataOrigins !== undefined) {
          if (!Array.isArray(body.dataOrigins) || body.dataOrigins.length > 16) fail(422,'invalid_metadata','Use up to 16 HTTP(S) data origins.');
          p.project.dataOrigins = body.dataOrigins.map((origin: unknown) => {
            let url: URL;
            try { url = new URL(String(origin)); } catch { fail(422,'invalid_metadata','Use HTTP(S) data origins.'); }
            if (!['http:','https:'].includes(url.protocol) || url.origin !== origin) fail(422,'invalid_metadata','Use canonical HTTP(S) origins without paths.');
            return url.origin;
          });
        }
        if (p.project.entrypoint && !validPath(p.project.entrypoint)) fail(422, 'invalid_entrypoint', 'Use a relative entrypoint path.');
        p.project.metadataVersion++; changed = true; return { project: p.project };
      }
      if (action === 'draft' && method === 'PUT') {
        draft(p, body.expectedVersion); if (body.ref !== 'refs/heads/main') fail(422, 'invalid_ref', 'The demo supports the main branch.');
        changed = true; return { draft: setDraft(p, body.baseCommit, body.changes) };
      }
      if (action === 'draft/save' && method === 'POST') {
        const d = draft(p, body.expectedVersion); if (!d) fail(409, 'no_draft', 'No draft to save.');
        if (d.baseCommit !== p.versions[0]!.commit) fail(409, 'stale_ref', 'A newer version exists. Reload before saving.');
        const result = await saveVersion(p, changes(version(p,d.baseCommit).files,d.changes), body.message);
        changed = true; return { ...result, draft: setDraft(p, result.commit, []) };
      }
      if (action === 'restores' && method === 'POST') {
        if (body.expectedCommit !== p.versions[0]!.commit) fail(409, 'stale_ref', 'A newer version exists. Reload before restoring.');
        changed = true; return saveVersion(p, { ...version(p, body.sourceCommit).files }, 'Restore version');
      }
      if (['libraries','draft/libraries'].includes(action) && ['POST','DELETE'].includes(method)) {
        const useDraft = action.startsWith('draft/');
        const d = useDraft ? draft(p, body.expectedVersion) : null;
        if ((d?.baseCommit ?? p.versions[0]!.commit) !== body.expectedCommit) fail(409, 'stale_ref', 'The project changed. Reload and retry.');
        const base = version(p,body.expectedCommit).files;
        const files = changes(base,d?.changes ?? []);
        const current = pins(files); const directory: string = body.directory;
        if (!validPath(directory) || directory === 'lab.lock.json') fail(422, 'invalid_library', 'Choose a relative directory.');
        const overlaps = (a: string,b: string) => a === b || a.startsWith(b+'/') || b.startsWith(a+'/');
        const previous = current.find(pin => pin.directory === directory);
        if (current.some(pin => pin !== previous && overlaps(pin.directory,directory))) fail(409,'library_overlap','Library directories overlap.');
        if (previous && !await unmodified(files,previous)) fail(409,'library_modified','Installed library files changed. Revert or preserve them before updating or removing.');
        if (previous) for (const f of previous.files) delete files[f.path];
        const next = current.filter(pin => pin !== previous);
        if (method === 'POST') {
          const library = find(body.libraryId); if (library.project.kind !== 'library') fail(422,'invalid_library','Choose a library.');
          if (previous && previous.projectId !== library.project.id) fail(409,'library_conflict','This directory belongs to a different library.');
          const v = version(library,body.commit);
          const paths = new Set<string>(body.paths);
          if (!paths.size) fail(422,'invalid_library','Select at least one file.');
          async function nested(prefix = '',depth = 0) {
            if (depth > 8) fail(422,'invalid_library','Library nesting exceeds 8 levels.');
            if (v.files[prefix+'lab.lock.json']) paths.add(prefix+'lab.lock.json');
            for (const pin of pins(v.files,prefix)) { if (!await unmodified(v.files,pin,prefix)) fail(409,'library_modified','Repair modified upstream dependencies first.'); for (const f of pin.files) paths.add(prefix+f.path); await nested(prefix+pin.directory+'/',depth+1); }
          }
          await nested();
          const pin: LibraryPin = { projectId: library.project.id, commit: v.commit, directory, files: [] };
          for (const path of paths) {
            const dest = `${directory}/${path}`;
            if (!validPath(path) || !Object.hasOwn(v.files,path)) fail(422,'invalid_library','Select existing library files.');
            if (Object.hasOwn(files,dest)) fail(409,'library_conflict',`File already exists: ${dest}`);
            files[dest] = v.files[path]!; pin.files.push({ source:path,path:dest,sha256:await hash(v.files[path]!) });
          }
          next.push(pin);
        }
        files['lab.lock.json'] = JSON.stringify({ version:1,libraries:next },null,2)+'\n';
        validateFiles(files); changed = true;
        return useDraft ? { ref:'refs/heads/main',commit:body.expectedCommit,draft:setDraft(p,body.expectedCommit,fileChanges(base,files)) } : saveVersion(p,files,body.message);
      }
      fail(404, 'demo_unavailable', 'This feature is not available in the static demo.');
    }
    const result = await route();
    init.signal?.throwIfAborted();
    if (changed) await writeState(state);
    return structuredClone(result) as T;
  });
}

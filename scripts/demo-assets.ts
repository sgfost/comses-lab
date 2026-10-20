import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { templates, showcaseTemplates } from '../shared/templates.ts';
import type { DemoProject, DemoSeed, Files } from '../web/src/demo/types.ts';

export function demoAssets(root: string) {
  const output = resolve(root, '.local/demo-public');
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  cpSync(resolve(root, 'web/public'), output, { recursive: true });
  function files(directory: string): Files {
    const result: Files = {};
    function walk(dir: string, prefix = '') {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = `${prefix}${entry.name}`;
        if (entry.isDirectory()) walk(join(dir, entry.name), `${path}/`);
        else result[path] = readFileSync(join(dir, entry.name), 'utf8');
      }
    }
    walk(resolve(root, 'examples', directory));
    return result;
  }
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const seed: DemoSeed = { projects: [], templates: templates.filter(t => t.id === 'marimo' || t.id === 'netlogo' || t.kind === 'library' || showcaseTemplates.some(example => example.id === t.id)).map(({files: paths, ...t}) => ({ ...t, files: Object.fromEntries(paths.map(path => [path, readFileSync(resolve(root, 'examples', t.id, path), 'utf8')])) })) };
  function add(id: string, title: string, directory: string, kind: 'model' | 'library', entrypoint: string, description: string, source = files(directory)) {
    const value: DemoProject = {
      project: { id, title, kind, description, entrypoint, visibility: 'public', ownerId: 'demo-examples', ownerName: 'CoMSES Lab examples', license: 'MIT', permission: 'read', metadataVersion: 0, dataOrigins: [], forkedFrom: null, extractedFrom: null, forgejoOwner: '', forgejoRepo: '', forgejoId: 0 },
      versions: [{ commit: hash(JSON.stringify(source)).slice(0,40), parents: [], message: 'Example source', author: { name: 'CoMSES Lab', date: '2026-10-01T00:00:00Z' }, files: source }], draft: null,
    };
    seed.projects.push(value); return value;
  }
  function include(target: Files, source: DemoProject, directory: string, paths = Object.keys(source.versions[0]!.files)) {
    const version = source.versions[0]!;
    for (const path of paths) target[`${directory}/${path}`] = version.files[path]!;
    target['lab.lock.json'] = JSON.stringify({ version: 1, libraries: [{ projectId: source.project.id, commit: version.commit, directory, files: paths.map(path => ({ source: path, path: `${directory}/${path}`, sha256: hash(version.files[path]!) })) }] }, null, 2) + '\n';
  }
  const kit = add('browser-kit', 'Browser kit', 'browser-kit', 'library', '', 'Canvas, controls and animation helpers.');
  const gridFiles = files('agent-grid'); include(gridFiles, kit, 'vendor/browser-kit');
  add('agent-grid', 'Agent grid', 'agent-grid', 'library', '', 'A small agent-based modeling library built on Browser kit.', gridFiles);
  for (const t of [...showcaseTemplates, templates.find(t => t.id === 'netlogo')!, templates.find(t => t.id === 'marimo')!]) {
    add(t.id, t.id === 'netlogo' ? 'NetLogo walks' : t.title, t.id, 'model', t.entrypoint, t.description);
  }
  writeFileSync(join(output, 'demo-seed.json'), JSON.stringify(seed));
  const pyodide = join(output, 'vendor/pyodide/0.29.5'); mkdirSync(pyodide, { recursive: true });
  for (const file of ['pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) cpSync(resolve(root, 'node_modules/pyodide', file), join(pyodide, file));
  const vendor = join(output, 'vendor');
  cpSync(resolve(root, 'node_modules/esbuild-wasm/esbuild.wasm'), join(vendor, 'esbuild.wasm'));
  cpSync(resolve(root, 'runtime/vendor/netlogo/2.15.3'), join(vendor, 'netlogo'), { recursive: true });
  cpSync(resolve(root, 'runtime/vendor/marimo/0.25.1/static'), join(vendor, 'marimo/0.25.1'), { recursive: true });
  writeFileSync(join(output, '.nojekyll'), '');
  return output;
}

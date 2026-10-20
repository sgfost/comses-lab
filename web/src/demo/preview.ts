import * as esbuild from 'esbuild-wasm';
import type { Launch, Project } from '../../../shared/contracts';
import type { Files } from './types';
import { demoBase } from './storage';
import { installBridge } from '../../../runtime/bridge.js';
import { installPreviewFit } from '../../../runtime/preview-fit.js';
import { installMarimoBridge } from '../../../runtime/marimo-bridge.js';
import { installNetLogoBridge } from '../../../runtime/netlogo-bridge.js';
import { installDemoIO, startDemoDocument, installDemoStorage } from './runtime.js';
import { MAX_RUNTIME_TEXT, MAX_RUNTIME_EVENTS_PER_SECOND, MAX_NETLOGO_SOURCE_BYTES } from '../../../shared/runtime';

const launches = new Map<string, Launch>();
const json = (value: unknown) => JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
let compiler: Promise<void> | undefined;
async function bundle(files: Files) {
  await (compiler ??= esbuild.initialize({ wasmURL: new URL('vendor/esbuild.wasm', demoBase).href }).catch(error => { compiler = undefined; throw error; }));
  const root = 'https://lab-demo.invalid/';
  const paths = Object.keys(files).filter(path => /\.[cm]?js$/.test(path));
  if (!paths.length) return {};
  const result = await esbuild.build({
    entryPoints: paths.map((path,i) => ({ in: path, out: `module-${i}` })),
    outdir: '/out', bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent',
    plugins: [{ name: 'demo-files', setup(build) {
      build.onResolve({ filter: /.*/ }, args => {
        if (args.path.startsWith('/vendor/')) return { path: new URL(args.path.slice(1),demoBase).href, external: true };
        const url = new URL(args.path, args.importer ? new URL(args.importer,root) : root);
        if (url.origin !== new URL(root).origin) throw new Error('External JavaScript imports are not supported in the demo. Add the module as a project file.');
        const path = decodeURIComponent(url.pathname.slice(1));
        if (!Object.hasOwn(files,path)) throw new Error(`Module not found: ${path}`);
        return { path, namespace: 'demo' };
      });
      build.onLoad({ filter: /.*/, namespace: 'demo' }, async args => {
        if (args.path.endsWith('.json')) return { contents: files[args.path], loader:'json' };
        const transformed = await esbuild.transform(files[args.path]!, { loader:'js', target:'es2022', define: { 'import.meta.url': json(new URL(args.path,root).href) } });
        return { contents: transformed.code, loader:'js' };
      });
    } }],
  });
  return Object.fromEntries(paths.map((path,i) => [path,result.outputFiles.find(file => file.path === `/out/module-${i}.js`)!.text]));
}
let netlogoPlayer: Promise<string> | undefined;
export function getDemoLaunch(id: string) { return launches.get(id); }
export function revokeDemoLaunch(id: string) { const value = launches.get(id); if (value) { URL.revokeObjectURL(value.url); launches.delete(id); } }
export async function createDemoLaunch(project: Project, commit: string, source: Files, draft: boolean, edit = false): Promise<Launch> {
  if (!Object.hasOwn(source, project.entrypoint)) throw new Error('The project entrypoint is missing. Choose an existing file in About.');
  const id = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const appOrigin = location.origin;
  const context = { launchId:id, appOrigin };
  const bridge = `(${installPreviewFit.toString()})(${json(context)});(${installBridge.toString()})(${json({ ...context,maxText:MAX_RUNTIME_TEXT,maxEvents:MAX_RUNTIME_EVENTS_PER_SECOND })});`;
  const assetBase = demoBase.href;
  const netlogo = /\.nlogox?$/i.test(project.entrypoint);
  // Firefox checks worker module imports against worker-src as well as script-src.
  const policy = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: ${demoBase.origin}; style-src 'unsafe-inline' blob:; img-src data: blob:; font-src data:; connect-src blob: ${demoBase.origin} ${project.dataOrigins.join(' ')}; worker-src blob: ${new URL("vendor/pyodide/", demoBase).href}; frame-src ${netlogo ? "blob: data:" : "'none'"}; object-src 'none'; base-uri 'none'; form-action 'none'`;
  let html: string;
  const marimo = /\.py$/i.test(project.entrypoint);
  if (marimo) {
    const assets = new URL('vendor/marimo/0.25.1/', demoBase);
    const response = await fetch(new URL('index.html', assets));
    if (!response.ok) throw new Error('Could not load Marimo. Run npm run setup:marimo and rebuild the demo.');
    const dependencies = 'https://cdn.jsdelivr.net https://wasm.marimo.app https://pypi.org https://files.pythonhosted.org';
    const notebookPolicy = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: data: ${demoBase.origin} ${dependencies}; style-src 'unsafe-inline' ${demoBase.origin}; img-src data: blob: ${demoBase.origin}; font-src data: ${demoBase.origin}; connect-src blob: data: ${demoBase.origin} ${dependencies} ${project.dataOrigins.join(' ')}; worker-src blob: data: ${demoBase.origin}; frame-src blob: data:; object-src 'none'; base-uri 'none'; form-action 'none'`;
    html = (await response.text()).replaceAll('./assets/', new URL('assets/', assets).href)
      .replace(/<script data-marimo="true">\s*Object.defineProperty[\s\S]*?<\/script>/, '')
      .replace('<head>', `<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${notebookPolicy}"><script>(${installDemoStorage.toString()})();${bridge}(${installMarimoBridge.toString()})(${json({ ...context, path: project.entrypoint, source: source[project.entrypoint], files: source, edit, version: '0.25.1' })});</script><marimo-wasm hidden></marimo-wasm>`);
  } else if (netlogo) {
    const player = await (netlogoPlayer ??= fetch(new URL('vendor/netlogo/player.html',demoBase)).then(r => { if (!r.ok) throw new Error('Could not load NetLogo.'); return r.text(); }).catch(e => {netlogoPlayer=undefined;throw e;}));
    const marker = '<script type="text/nlogo" id="nlogo-code" data-filename="model.nlogox"></script>';
    if (!player.includes(marker)) throw new Error('Unexpected NetLogo player.');
    html = player.replace(marker, () => `${marker}<script>document.getElementById('nlogo-code').textContent=${json(source[project.entrypoint]!.replace(/^\uFEFF/,''))};document.getElementById('nlogo-code').dataset.filename=${json(project.entrypoint)};</script>`)
      .replace('function bp(e){switch(e.type){','function bp(e){globalThis.__labNetLogoLoad(e);switch(e.type){')
      .replace(/<link\b[^>]*href=["']https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/gi,'')
      .replace(/<head(?:\s[^>]*)?>/i, head => `${head}<meta http-equiv="Content-Security-Policy" content="${policy}"><script>(${installDemoStorage.toString()})();${bridge}(${installNetLogoBridge.toString()})(${json({ ...context, path:project.entrypoint,standalone:false,maxSourceBytes:MAX_NETLOGO_SOURCE_BYTES,playerUrl:new URL("vendor/netlogo/player.html",demoBase).href })});</script>`);
  } else {
    const files = { ...source };
    const doc = new DOMParser().parseFromString(files[project.entrypoint]!, 'text/html');
    let i = 0;
    // Treat inline module scripts as source files so imports and import.meta keep working.
    for (const script of Array.from(doc.querySelectorAll('script[type="module"]:not([src])'))) {
      const prefix = project.entrypoint.includes('/') ? project.entrypoint.slice(0,project.entrypoint.lastIndexOf('/')+1) : '';
      const path = `${prefix}__demo_inline_${i++}.js`; files[path] = script.textContent ?? ''; script.textContent = ''; script.setAttribute('src',`./${path.slice(prefix.length)}`);
    }
    const modules = await bundle(files);
    const payload = { files, modules, html: doc.documentElement.outerHTML, entrypoint:project.entrypoint,assetBase,bridge,policy };
    html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><script>(${startDemoDocument.toString()})(${json(payload)},${installDemoIO.toString()});</script>`;
  }
  const url = URL.createObjectURL(new Blob([html],{type:'text/html'}));
  const launch: Launch = { id, commit, url, draft, expiresAt: Number.MAX_SAFE_INTEGER, ...(marimo ? { runtime:'marimo' as const } : netlogo ? { runtime:'netlogo' as const } : {}) };
  launches.set(id,launch); return launch;
}

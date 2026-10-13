// Runs only inside an opaque sandbox (and its workers), never in the application.
export function installDemoIO(resources, virtualBase, assetBase) {
  const NativeURL = globalThis.URL;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const resolve = (input, base = virtualBase) => {
    const url = new NativeURL(String(input), String(base));
    if (url.origin === 'https://lab-demo.invalid') {
      if (resources[url.href]) return resources[url.href];
      if (url.pathname.startsWith('/vendor/pyodide/')) return new NativeURL(url.pathname.slice(1), assetBase).href;
      return resources[url.href] || url.href;
    }
    return url.href;
  };
  // Preserve import.meta-relative resource access after module bundling.
  globalThis.URL = class extends NativeURL {
    constructor(input, base) { super(resolve(input, base)); }
  };
  globalThis.fetch = (input, init) => nativeFetch(input instanceof Request ? input : resolve(input), { ...init, credentials: 'omit' });
  const NativeWorker = globalThis.Worker;
  if (NativeWorker) globalThis.Worker = class extends NativeWorker {
    constructor(input, options) {
      const script = resolve(input);
      const code = `(${installDemoIO.toString()})(${JSON.stringify(resources)},${JSON.stringify(virtualBase)},${JSON.stringify(assetBase)});import(${JSON.stringify(script)}).catch(error=>{setTimeout(()=>{throw error})});`;
      const url = NativeURL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      super(url, { ...options, type: 'classic' });
      this.addEventListener('error', () => NativeURL.revokeObjectURL(url), { once: true });
    }
  };
  return resolve;
}

export function startDemoDocument({ files, modules, html, entrypoint, assetBase, bridge, policy }, installIO) {
  const virtualRoot = 'https://lab-demo.invalid/';
  const resources = {};
  const types = { js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', json: 'application/json', html: 'text/html' };
  for (const [path, content] of Object.entries({ ...files, ...modules })) {
    const type = types[path.split('.').pop()] || 'text/plain';
    resources[new URL(path, virtualRoot).href] = URL.createObjectURL(new Blob([content], { type }));
  }
  const base = new URL(entrypoint, virtualRoot).href;
  const resolve = installIO(resources, base, assetBase);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('base, meta[http-equiv="Content-Security-Policy" i]').forEach(el => el.remove());
  const css = (text, from = base) => text.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g, (_match, _quote, url) => `url(${JSON.stringify(resolve(url, from))})`);
  // Inline stylesheets so their relative assets resolve against the original file.
  for (const el of doc.querySelectorAll('link[rel="stylesheet"]')) {
    const href = el.getAttribute('href');
    const path = new URL(href, base).pathname.slice(1);
    if (files[path] !== undefined) { const style = doc.createElement('style'); style.textContent = css(files[path], new URL(path, virtualRoot).href); el.replaceWith(style); }
  }
  for (const el of doc.querySelectorAll('[src], [href], [poster]')) {
    for (const attr of ['src', 'href', 'poster']) {
      const value = el.getAttribute(attr);
      if (value && !value.startsWith('#')) el.setAttribute(attr, resolve(value));
    }
  }
  for (const style of doc.querySelectorAll('style')) style.textContent = css(style.textContent);
  for (const el of doc.querySelectorAll('[style]')) el.setAttribute('style',css(el.getAttribute('style')));
  const security = doc.createElement('meta'); security.httpEquiv = 'Content-Security-Policy'; security.content = policy; doc.head.prepend(security);
  const instrumentation = doc.createElement('script'); instrumentation.textContent = bridge; security.after(instrumentation);
  // document.write retains normal script order and DOMContentLoaded behavior.
  document.open();
  document.write('<!doctype html>' + doc.documentElement.outerHTML);
  document.close();
}

// NetLogo's standalone player expects storage, but a demo launch must not share
// the application's IndexedDB or localStorage. Give it disposable in-memory storage.
export function installDemoStorage() {
  for (const name of ['localStorage', 'sessionStorage']) {
    const data = new Map();
    Object.defineProperty(globalThis, name, { value: {
      get length() { return data.size; },
      key(index) { return [...data.keys()][index] ?? null; },
      getItem(key) { return data.get(String(key)) ?? null; },
      setItem(key, value) { data.set(String(key), String(value)); },
      removeItem(key) { data.delete(String(key)); },
      clear() { data.clear(); },
    } });
  }
}

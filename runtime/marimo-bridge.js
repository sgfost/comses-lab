// Adapter for the pinned Marimo build. Project files remain ordinary snapshot bytes.
export function installMarimoBridge(config) {
  const send = (type, fields = {}) => parent.postMessage({ channel: 'lab-runtime', version: 1, launchId: config.launchId, type, ...fields }, config.appOrigin);
  let bridge;
  let saveWorker;
  function saveAppConfiguration(config) {
    if (!saveWorker) return Promise.reject(new Error('Notebook save worker is not ready'));
    const worker = saveWorker;
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const done = event => {
        if (event.data?.type !== 'lab-marimo-config-saved' || event.data.id !== id) return;
        clearTimeout(timer);
        worker.removeEventListener('message', done);
        event.data.error ? reject(new Error(event.data.error)) : resolve();
      };
      const timer = setTimeout(() => { worker.removeEventListener('message', done); reject(new Error('Notebook configuration save timed out')); }, 20000);
      worker.addEventListener('message', done);
      worker.postMessage({ type: 'lab-marimo-config', id, config });
    });
  }
  let exportRequest;
  let exportTimer;
  Object.defineProperty(window, '_marimo_private_PyodideBridge', {
    get: () => bridge,
    set(value) {
      bridge = value;
      const configure = value.saveAppConfig.bind(value);
      value.saveAppConfig = async request => {
        await configure(request);
        await saveAppConfiguration(request.config);
        send('marimo-save', { source: (await value.readCode()).contents });
      };
      const save = value.sendSave.bind(value);
      value.sendSave = async request => {
        const requestId = exportRequest;
        exportRequest = undefined;
        try {
          await save(request);
          if (requestId) send('marimo-export', { requestId, source: (await value.readCode()).contents });
        } catch (error) {
          if (requestId) send('error', { text: String(error).slice(0, 4096) });
          throw error;
        } finally {
          if (requestId) { clearTimeout(exportTimer); document.getElementById('root')?.removeAttribute('inert'); }
        }
      };
    },
  });
  addEventListener('message', event => {
    const data = event.data;
    if (event.source !== parent || event.origin !== config.appOrigin || event.ports.length ||
        data?.channel !== 'lab-runtime' || data.version !== 1 || data.launchId !== config.launchId ||
        data.type !== 'marimo-export-request' || typeof data.requestId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(data.requestId) || !config.edit) return;
    const button = document.getElementById('save-button');
    if (!button || !bridge || exportRequest) return;
    exportRequest = data.requestId;
    button.click();
    document.getElementById('root')?.setAttribute('inert', '');
    clearTimeout(exportTimer);
    exportTimer = setTimeout(() => {
      if (exportRequest === data.requestId) exportRequest = undefined;
      document.getElementById('root')?.removeAttribute('inert');
    }, 20000);
  });
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      // Marimo uses a data-URL import wrapper in opaque sandboxes.
      let target = new URL(url, location.href);
      if (target.protocol === 'data:') {
        const wrapper = decodeURIComponent(target.href.slice(target.href.indexOf(',') + 1));
        const match = /^import ("[^"]+")$/.exec(wrapper);
        if (match) target = new URL(JSON.parse(match[1]));
      }
      const saving = target.pathname.includes('/assets/save-worker-');
      if (saving || target.pathname.includes('/assets/worker-')) {
        const bootstrap = `
          // Dynamic import yields before Marimo installs its RPC listener.
          const messages = [];
          const queue = event => { messages.push(event); event.stopImmediatePropagation(); };
          self.addEventListener('message', queue);
          let mounted;
          const ready = new Promise(resolve => { mounted = resolve; });
          self.addEventListener('message', async event => {
            const data = event.data;
            if (!${JSON.stringify(saving)} || data?.type !== 'lab-marimo-config') return;
            try {
              await ready;
              self.pyodide.globals.set('_lab_config', JSON.stringify(data.config));
              self.pyodide.runPython('import json\\nfrom marimo._session.notebook import AppFileManager\\nAppFileManager("/marimo/notebook.py").save_app_config(json.loads(_lab_config))\\ndel _lab_config');
              self.postMessage({ type: 'lab-marimo-config-saved', id: data.id });
            } catch (error) { self.postMessage({ type: 'lab-marimo-config-saved', id: data.id, error: String(error) }); }
          });
          let controller;
          Object.defineProperty(self, 'controller', {
            get: () => controller,
            set(value) {
              controller = value;
              const mount = value.mountFilesystem.bind(value);
              value.mountFilesystem = async (opts) => {
                const result = await mount(opts);
                const localFiles = ${JSON.stringify(config.files ?? null)};
                let files = localFiles;
                if (!files) {
                  const response = await fetch(${JSON.stringify(config.files ? '' : new URL(`/bridge/${config.launchId}/files.json`, location.href).href)}, { credentials: 'omit' });
                  if (!response.ok) throw new Error('Project snapshot expired. Run again.');
                  files = await response.json();
                }
                for (const [path, content] of Object.entries(files)) {
                  const full = '/marimo/' + path;
                  self.pyodide.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
                  self.pyodide.FS.writeFile(full, localFiles ? new TextEncoder().encode(content) : Uint8Array.from(atob(content), c => c.charCodeAt(0)));
                }
                // Marimo's save worker always serializes this filename.
                if (${JSON.stringify(saving)}) self.pyodide.FS.writeFile('/marimo/notebook.py', ${JSON.stringify(config.source)});
                mounted();
                self.pyodide.runPython(${JSON.stringify(`import sys
sys.path[:0] = ${JSON.stringify(['/marimo', '/marimo/' + config.path.split('/').slice(0, -1).join('/')])}`)});
                return result;
              };
            }
          });
          await import(${JSON.stringify(target.href)});
          self.removeEventListener('message', queue);
          for (const event of messages) self.dispatchEvent(new MessageEvent('message', { data: event.data, ports: event.ports }));
        `;
        const blob = globalThis.origin === 'null' ? 'data:application/javascript,' + encodeURIComponent(bootstrap) : URL.createObjectURL(new Blob([bootstrap], { type: 'text/javascript' }));
        super(blob, options);
        if (saving) saveWorker = this;
        URL.revokeObjectURL(blob);
      } else super(url, options);
    }
  };
  window.__MARIMO_MOUNT_CONFIG__ = {
    filename: '/marimo/' + config.path,
    code: config.source,
    version: config.version,
    mode: config.edit ? 'edit' : 'read',
    view: { showAppCode: false },
    config: {
      display: { theme: 'light' },
      runtime: { auto_instantiate: true, on_cell_change: 'autorun' },
      save: { autosave: 'after_delay', autosave_delay: 500, format_on_save: false },
      ai: { enabled: false },
    },
    fileStores: [{ readFile: () => config.source, saveFile: source => {
      if (config.edit && typeof source === 'string' && source.length <= 2_000_000) send('marimo-save', { source });
    } }],
  };
}

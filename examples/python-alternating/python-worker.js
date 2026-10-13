import { loadPyodide } from '/vendor/pyodide/0.29.5/pyodide.mjs';
const pyodide = await loadPyodide({ indexURL: new URL('/vendor/pyodide/0.29.5/', import.meta.url).href });
pyodide.FS.mkdir('vendor');
for (const path of ['vendor/diffusion.py', 'model.py']) {
  const response = await fetch(new URL(path, import.meta.url), { credentials: 'omit' });
  if (!response.ok) throw new Error(`Could not load ${path}`);
  pyodide.FS.writeFile(path, new Uint8Array(await response.arrayBuffer()));
}
pyodide.runPython('from model import simulate');
onmessage = ({ data }) => {
  try {
    pyodide.globals.set('steps', data.steps);
    pyodide.globals.set('diffusivity', data.diffusivity);
    const values = pyodide.runPython('simulate(steps, diffusivity)');
    try { postMessage({ type: 'result', values: values.toJs() }); }
    finally { values.destroy(); }
  } catch (error) { postMessage({ type: 'error', text: String(error) }); }
};
postMessage({ type: 'ready' });

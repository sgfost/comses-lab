import { loadPyodide } from '/vendor/pyodide/0.29.5/pyodide.mjs';
const pyodide = await loadPyodide({
  indexURL: new URL('/vendor/pyodide/0.29.5/', import.meta.url).href,
  stdout: text => postMessage({ type: 'stdout', text }),
  stderr: text => postMessage({ type: 'stderr', text }),
});
for (const filename of ['diffusion.py', 'model.py']) {
  const response = await fetch(new URL(filename, import.meta.url), { credentials: 'omit' });
  if (!response.ok) throw new Error(`Could not load ${filename}`);
  pyodide.FS.writeFile(filename, new Uint8Array(await response.arrayBuffer()));
}
pyodide.runPython('from model import simulate');
onmessage = ({ data }) => {
  try {
    if (data.action === 'error') pyodide.runPython('raise ValueError("Intentional heat-diffusion error")');
    if (data.action === 'runaway') {
      postMessage({ type: 'busy' });
      pyodide.runPython('while True: pass');
    }
    pyodide.globals.set('steps', data.steps);
    pyodide.globals.set('diffusivity', data.diffusivity);
    const result = pyodide.runPython('simulate(steps, diffusivity)');
    try { postMessage({ type: 'result', values: result.toJs() }); }
    finally { result.destroy(); }
  } catch (error) { postMessage({ type: 'error', text: String(error) }); }
};
postMessage({ type: 'ready', version: pyodide.version });

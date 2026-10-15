// Keep the interpreter and all agent state off the browser's UI thread.
import { loadPyodide } from '/vendor/pyodide/0.29.5/pyodide.mjs';
const pyodide = await loadPyodide({ indexURL: new URL('/vendor/pyodide/0.29.5/', import.meta.url).href });
const response = await fetch(new URL('./model.py', import.meta.url), { credentials: 'omit' });
if (!response.ok) throw new Error('Could not load model.py');
pyodide.FS.writeFile('model.py', await response.text());
pyodide.runPython('import json\nfrom model import command');
onmessage = ({ data }) => {
  try {
    pyodide.globals.set('request_json', JSON.stringify(data));
    const state = JSON.parse(pyodide.runPython('json.dumps(command(json.loads(request_json)))'));
    postMessage({ type: 'state', state });
  } catch (error) { postMessage({ type: 'error', text: String(error) }); }
};
console.info('Python interpreter ready; agent rules execute in model.py');
postMessage({ type: 'ready' });

import { loadPyodide } from '/vendor/pyodide/0.29.5/pyodide.mjs';
const pyodide = await loadPyodide({ indexURL: new URL('/vendor/pyodide/0.29.5/', import.meta.url).href });
onmessage = async ({ data }) => {
  try {
    pyodide.globals.set('dataset_url', data.url);
    const result = await pyodide.runPythonAsync(`
from pyodide.http import pyfetch
response = await pyfetch(dataset_url, credentials="omit")
if not response.ok:
    raise ValueError(f"Dataset returned {response.status}")
observations = await response.json()
sum(float(value) ** 2 for value in observations["values"])
`);
    postMessage({ type: 'result', value: result });
  } catch (error) { postMessage({ type: 'error', text: String(error) }); }
};
postMessage({ type: 'ready' });

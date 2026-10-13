const dataset = document.querySelector('#dataset');
const javascript = document.querySelector('#javascript');
const python = document.querySelector('#python');
const jsResult = document.querySelector('#javascript-result');
const pyResult = document.querySelector('#python-result');
javascript.onclick = async () => {
  javascript.disabled = true;
  try {
    const response = await fetch(dataset.value, { credentials: 'omit' });
    if (!response.ok) throw new Error(`Dataset returned ${response.status}`);
    const { values } = await response.json();
    if (!Array.isArray(values) || !values.every(Number.isFinite)) throw new Error('Expected numeric values');
    const total = values.reduce((sum, value) => sum + value, 0);
    jsResult.textContent = `JavaScript sum: ${total}`;
    console.info(jsResult.textContent);
  } catch (error) { jsResult.textContent = `JavaScript failed: ${error}`; }
  finally { javascript.disabled = false; }
};
const bootstrap = URL.createObjectURL(new Blob([
  `import(${JSON.stringify(new URL('./observations-worker.js', import.meta.url).href)}).catch(error => postMessage({type:'error',text:String(error)}));`,
], { type: 'text/javascript' }));
const worker = new Worker(bootstrap);
worker.onmessage = ({ data }) => {
  if (data.type === 'ready') {
    URL.revokeObjectURL(bootstrap);
    pyResult.textContent = 'Python ready';
    python.disabled = false;
  } else if (data.type === 'result') {
    pyResult.textContent = `Python sum of squares: ${data.value}`;
    console.info(pyResult.textContent);
    python.disabled = false;
  } else if (data.type === 'error') {
    pyResult.textContent = `Python failed: ${data.text}`;
    python.disabled = false;
  }
};
worker.onerror = event => { pyResult.textContent = `Python failed: ${event.message}`; };
python.onclick = () => {
  python.disabled = true;
  worker.postMessage({ url: dataset.value });
};

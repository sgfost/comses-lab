const canvas = document.querySelector('canvas');
const context = canvas.getContext('2d');
const status = document.querySelector('#status');
const run = document.querySelector('#run');
let worker;
function draw(values) {
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#b4866a';
  context.lineWidth = 2;
  context.beginPath();
  values.forEach((value, i) => {
    const x = 20 + i / Math.max(1, values.length - 1) * 560;
    const y = 340 - value * 3.2;
    if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
  });
  context.stroke();
}
function reset() {
  worker?.terminate();
  run.disabled = true;
  draw([]);
  status.textContent = 'Loading Python…';
  const url = URL.createObjectURL(new Blob([
    `import(${JSON.stringify(new URL('./python-worker.js', import.meta.url).href)}).catch(error => postMessage({type:'error',text:String(error)}));`,
  ], { type: 'text/javascript' }));
  const current = worker = new Worker(url);
  current.onmessage = ({ data }) => {
    if (worker !== current) return;
    if (data.type === 'ready') {
      URL.revokeObjectURL(url);
      run.disabled = false;
      status.textContent = `Python ready · Pyodide ${data.version}`;
      console.info(`Python interpreter ready · Pyodide ${data.version}`);
    } else if (data.type === 'stdout') console.log(data.text);
    else if (data.type === 'stderr' || data.type === 'error') {
      console.error(data.text);
      if (data.type === 'error') {
        URL.revokeObjectURL(url);
        status.textContent = data.text;
        run.disabled = false;
      }
    } else if (data.type === 'busy') {
      status.textContent = 'Python busy — reset or stop to terminate';
      console.info('Python worker entered an infinite loop');
    } else if (data.type === 'result') {
      draw(data.values);
      run.disabled = false;
      status.textContent = `Peak temperature: ${Math.max(...data.values).toFixed(3)} · Total heat: ${data.values.reduce((a, b) => a + b, 0).toFixed(3)}`;
    }
  };
  current.onerror = event => {
    if (worker !== current) return;
    URL.revokeObjectURL(url);
    status.textContent = event.message || 'Python worker failed';
    run.disabled = false;
  };
}
run.onclick = () => {
  const steps = Number(document.querySelector('#steps').value);
  const diffusivity = Number(document.querySelector('#diffusivity').value);
  if (!Number.isInteger(steps) || steps < 1 || steps > 10000 || !Number.isFinite(diffusivity) || diffusivity < 0 || diffusivity > 0.5) {
    status.textContent = 'Enter 1–10000 steps and diffusivity between 0 and 0.5'; return;
  }
  run.disabled = true;
  status.textContent = 'Computing…';
  worker.postMessage({ steps, diffusivity });
};
document.querySelector('#reset').onclick = reset;
document.querySelector('#error').onclick = () => worker.postMessage({ action: 'error' });
document.querySelector('#runaway').onclick = () => { run.disabled = true; worker.postMessage({ action: 'runaway' }); };
reset();

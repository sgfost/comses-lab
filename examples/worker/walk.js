const canvas = document.querySelector('canvas');
const context = canvas.getContext('2d');
const status = document.querySelector('#status');
const run = document.querySelector('#run');
let worker;
function draw(values) {
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#718ba5';
  context.lineWidth = 2;
  context.beginPath();
  const maximum = Math.max(1, ...values);
  values.forEach((value, i) => {
    const x = 20 + i / Math.max(1, values.length - 1) * 560;
    const y = 340 - value / maximum * 320;
    if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
  });
  context.stroke();
}
function reset() {
  worker?.terminate();
  run.disabled = true;
  draw([]);
  status.textContent = 'Starting worker…';
  // Classic blob workers support dynamic local modules in an opaque sandbox.
  const url = URL.createObjectURL(new Blob([
    `import(${JSON.stringify(new URL('./walk-worker.js', import.meta.url).href)}).catch(error => { throw error; });`,
  ], { type: 'text/javascript' }));
  const current = worker = new Worker(url);
  current.onmessage = ({ data }) => {
    if (worker !== current) return;
    if (data.type === 'ready') {
      URL.revokeObjectURL(url);
      run.disabled = false;
      status.textContent = 'Ready';
      console.info('Random-walk worker ready');
    } else if (data.type === 'busy') {
      status.textContent = 'Worker busy — reset or stop to terminate';
      console.info('Random-walk worker entered an infinite loop');
    } else if (data.type === 'result') {
      draw(data.displacement);
      run.disabled = false;
      const last = data.displacement.at(-1);
      status.textContent = `Mean squared displacement: ${last.toFixed(3)}`;
      console.log('Mean squared displacement', last);
    }
  };
  current.onerror = event => {
    if (worker !== current) return;
    URL.revokeObjectURL(url);
    status.textContent = event.message || 'Worker failed';
    run.disabled = false;
  };
}
run.onclick = () => {
  const walkers = Number(document.querySelector('#walkers').value);
  const steps = Number(document.querySelector('#steps').value);
  const seed = Number(document.querySelector('#seed').value);
  if (!Number.isInteger(walkers) || walkers < 1 || walkers > 10000 || !Number.isInteger(steps) || steps < 1 || steps > 10000 || !Number.isFinite(seed)) {
    status.textContent = 'Enter 1–10000 walkers and steps, and a finite seed'; return;
  }
  run.disabled = true;
  status.textContent = 'Computing…';
  worker.postMessage({ walkers, steps, seed });
};
document.querySelector('#reset').onclick = reset;
document.querySelector('#error').onclick = () => worker.postMessage({ action: 'error' });
document.querySelector('#runaway').onclick = () => { run.disabled = true; worker.postMessage({ action: 'runaway' }); };
reset();

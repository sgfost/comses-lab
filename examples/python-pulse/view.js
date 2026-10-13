const canvas = document.querySelector('canvas');
const context = canvas.getContext('2d');
const status = document.querySelector('#status');
const run = document.querySelector('#run');
const pin = await (await fetch('./component.json', { credentials: 'omit' })).json();
document.querySelector('#component').textContent = `${pin.path} · ${pin.commit.slice(0, 12)}`;
let worker;
function reset() {
  worker?.terminate();
  run.disabled = true;
  status.textContent = 'Loading Python…';
  const url = URL.createObjectURL(new Blob([
    `import(${JSON.stringify(new URL('./python-worker.js', import.meta.url).href)}).catch(error => postMessage({type:'error',text:String(error)}));`,
  ], { type: 'text/javascript' }));
  const current = worker = new Worker(url);
  current.onmessage = ({ data }) => {
    if (worker !== current) return;
    if (data.type === 'ready') {
      URL.revokeObjectURL(url);
      status.textContent = 'Python ready';
      run.disabled = false;
    } else if (data.type === 'result') {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.strokeStyle = '#8b7666';
      context.lineWidth = 2;
      context.beginPath();
      data.values.forEach((value, i) => {
        const x = 20 + i / Math.max(1, data.values.length - 1) * 560;
        const y = 340 - value * 3;
        if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
      });
      context.stroke();
      const peak = Math.max(...data.values), contrast = peak - Math.min(...data.values);
      status.textContent = `Peak: ${peak.toFixed(3)} · Contrast: ${contrast.toFixed(3)} · Total: ${data.values.reduce((a, b) => a + b, 0).toFixed(3)}`;
      console.info(status.textContent);
      run.disabled = false;
    } else if (data.type === 'error') {
      status.textContent = data.text;
      run.disabled = false;
    }
  };
  current.onerror = event => { status.textContent = event.message || 'Python worker failed'; };
}
run.onclick = () => {
  const steps = Number(document.querySelector('#steps').value);
  const diffusivity = Number(document.querySelector('#diffusivity').value);
  if (!Number.isInteger(steps) || steps < 1 || steps > 10000 || !Number.isFinite(diffusivity) || diffusivity < 0 || diffusivity > 0.5) {
    status.textContent = 'Enter 1–10000 steps and diffusivity between 0 and 0.5'; return;
  }
  run.disabled = true;
  worker.postMessage({ steps, diffusivity });
};
document.querySelector('#reset').onclick = reset;
reset();

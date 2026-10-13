// Optional browser UI helpers. Models can use any UI or execution loop instead.
export function createPanel(title, { width = 640, height = 400 } = {}) {
  const style = document.createElement('style');
  style.textContent = `
    :root { color-scheme: light dark; font: 13px system-ui, sans-serif; }
    body { margin: 20px; color: light-dark(#242424, #ddd); background: light-dark(#fff, #1e1e1e); }
    h1 { margin: 0 0 16px; font-size: 18px; font-weight: 500; }
    canvas { display: block; width: 100%; height: auto; border: 1px solid light-dark(#ddd, #444); }
    .controls { display: flex; gap: 10px; flex-wrap: wrap; align-items: end; margin: 14px 0; }
    label { display: grid; gap: 4px; } input { width: 80px; }
    button, input { font: inherit; padding: 5px 8px; }
    output { display: block; font-variant-numeric: tabular-nums; }
  `;
  document.head.append(style);
  const root = document.createElement('main');
  const heading = document.createElement('h1');
  heading.textContent = title;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.setAttribute('aria-label', `${title} simulation`);
  const controls = document.createElement('div');
  controls.className = 'controls';
  const status = document.createElement('output');
  status.setAttribute('role', 'status');
  root.append(heading, canvas, controls, status);
  document.body.append(root);
  return {
    canvas, context: canvas.getContext('2d'), status,
    number(name, value, min, max) {
      const label = document.createElement('label');
      label.append(name);
      const input = document.createElement('input');
      input.type = 'number'; input.value = value; input.min = min; input.max = max; input.step = '1';
      label.append(input); controls.append(label);
      return input;
    },
    button(name, action) {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = name; button.onclick = action;
      controls.append(button);
      return button;
    },
    dispose() { root.remove(); style.remove(); },
  };
}

export function createLoop(update, draw) {
  let frame = null;
  function tick() {
    update(); draw(); frame = requestAnimationFrame(tick);
  }
  return {
    start() { if (frame === null) frame = requestAnimationFrame(tick); },
    stop() { if (frame !== null) cancelAnimationFrame(frame); frame = null; },
  };
}

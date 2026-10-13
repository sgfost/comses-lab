import { createPanel, createLoop } from './vendor/browser-kit/index.js';

export function randomSequence(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(1664525, value) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

export function createWorld({ size = 40, count = 200, seed = 7 } = {}) {
  const random = randomSequence(seed);
  return {
    size, random, tick: 0,
    agents: Array.from({ length: count }, (_, id) => ({
      id, x: Math.floor(random() * size), y: Math.floor(random() * size),
    })),
  };
}

// Rules are ordinary functions; agents can have any additional state.
export function stepWorld(world, rule) {
  for (const agent of world.agents) rule(agent, world);
  world.tick++;
}

export function drawWorld(world, view) {
  const { context, canvas } = view;
  context.fillStyle = '#f4f4f1';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const cell = canvas.width / world.size;
  context.fillStyle = '#3d6667';
  for (const agent of world.agents) context.fillRect(agent.x * cell, agent.y * cell, Math.max(2, cell - 1), Math.max(2, cell - 1));
  view.status.textContent = `Step: ${world.tick} · Agents: ${world.agents.length}`;
}

// Optional example shell. createWorld/stepWorld also work without this UI.
export function mountGrid({ title = 'Agent grid', rule, size = 40, count = 200, seed = 7 }) {
  const view = createPanel(title, { width: 480, height: 480 });
  const population = view.number('Agents', count, 1, 2000);
  const seedInput = view.number('Seed', seed, 0, 4294967295);
  let world;
  const draw = () => drawWorld(world, view);
  const step = () => stepWorld(world, rule);
  const loop = createLoop(step, draw);
  function reset() {
    loop.stop();
    if (!population.checkValidity() || !seedInput.checkValidity()) {
      view.status.textContent = 'Enter valid agent and seed values.';
      return;
    }
    world = createWorld({ size, count: Number(population.value), seed: Number(seedInput.value) });
    draw();
  }
  view.button('Step', () => { loop.stop(); step(); draw(); });
  view.button('Run 100 steps', () => { loop.stop(); for (let i = 0; i < 100; i++) step(); draw(); });
  view.button('Play', () => loop.start());
  view.button('Pause', () => loop.stop());
  view.button('Reset', reset);
  reset();
  return { get world() { return world; }, stop: () => loop.stop(), dispose() { loop.stop(); view.dispose(); } };
}

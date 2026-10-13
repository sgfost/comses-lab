import { mountGrid } from './vendor/agent-grid/index.js';

mountGrid({
  title: 'Grid walkers',
  count: 200,
  seed: 7,
  rule(agent, world) {
    const direction = Math.floor(world.random() * 4);
    agent.x = (agent.x + (direction === 0 ? 1 : direction === 1 ? -1 : 0) + world.size) % world.size;
    agent.y = (agent.y + (direction === 2 ? 1 : direction === 3 ? -1 : 0) + world.size) % world.size;
  },
});

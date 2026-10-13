# Agent grid

A small optional agent-based modeling library: a seeded random generator, a grid of agents, and a sequential scheduler. Agents are ordinary objects; a rule is an ordinary function. It does not prescribe a model format.

`createWorld`, `stepWorld` and `randomSequence` can be used without the UI. `mountGrid` is an optional ready-made canvas and controls, built on the separately versioned **Browser kit** library in `vendor/browser-kit`. The dependency and its exact revision are recorded in `lab.lock.json` when seeded.

```js
import { mountGrid } from './vendor/agent-grid/index.js';
mountGrid({ title: 'My agents', rule(agent, world) {
  agent.x = (agent.x + 1) % world.size;
} });
```

Scheduling is sequential and allows multiple agents in one cell. This is a deliberately small starting point, not a general ABM engine. Fork it, add state/rules, or use another framework. No Lab SDK is required.

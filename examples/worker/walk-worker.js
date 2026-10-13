import { randomGenerator } from './random.js';
onmessage = ({ data }) => {
  if (data.action === 'error') throw new Error('Intentional random-walk worker error');
  if (data.action === 'runaway') { postMessage({ type: 'busy' }); while (true) {} }
  const random = randomGenerator(data.seed);
  const positions = new Int32Array(data.walkers);
  const displacement = [0];
  for (let step = 0; step < data.steps; step++) {
    let squared = 0;
    for (let i = 0; i < positions.length; i++) {
      positions[i] += random() < 0.5 ? -1 : 1;
      squared += positions[i] ** 2;
    }
    displacement.push(squared / positions.length);
  }
  postMessage({ type: 'result', displacement });
};
postMessage({ type: 'ready' });

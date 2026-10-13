# Browser kit

Ordinary JavaScript helpers for a canvas, numeric inputs, buttons, status output and a start/stop animation loop. No dependencies and no Lab API.

```js
import { createPanel, createLoop } from './vendor/browser-kit/index.js';
const view = createPanel('My model');
const count = view.number('Count', 100, 1, 1000);
view.button('Draw', () => { view.status.textContent = count.value; });
```

Use `view.context` for any canvas drawing. `createLoop(update, draw)` returns `start()` and `stop()`. `view.dispose()` removes the UI; stop your loop before disposing. You can instead build your own HTML, controls and execution loop.

Agent grid uses this library for its example UI. Installed dependencies are normal files at recorded Git revisions; relative imports work outside Lab too.

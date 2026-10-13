# Random walks

An ordinary HTML application with its own controls and canvas. `walk-worker.js` imports `random.js` and computes mean squared displacement for independent one-dimensional walkers with a seeded generator. There is no Lab SDK or model interface.

Run repeats the experiment with the chosen inputs. Reset terminates the worker and creates a fresh one. Worker diagnostics exercise an error and an infinite loop. Reset or Lab Stop terminates the supported worker computation; arbitrary main-thread JavaScript has no stop guarantee.

The sandbox supports a classic blob worker that dynamically imports the ordinary module. This is a browser loading detail, not a model format. Files and relative modules are ordinary JavaScript.

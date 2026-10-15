# Ant trails

Python agents find food and deposit pheromone. Local sensing produces trails between the nest and food patches.

## Run and explore

Click the landscape to add a food patch. Change persistence to see trails form or fade.

Use Pause to inspect, Step to advance one step, and Reset to restart. The seed and population controls apply on reset; the slider applies live. Python runs in a dedicated Pyodide worker. The JavaScript view only renders snapshots and sends commands. Change `model.py` to alter the rules.

## Model

Each ant samples three directions, follows a noisy pheromone gradient, and switches between searching and returning. Returning ants point toward the nest and deposit a decaying trail. Food is finite; depleted patches stop reinforcing their routes. The field evaporates and spreads to adjacent cells. This is a stylized collective-search ABM, not a fitted model of a particular ant species.

## Files

`index.html` and `style.css` define the interface. All assets are local; no external datasets or network services are required.

MIT licensed, CoMSES Lab contributors.

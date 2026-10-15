# Predator–prey landscape

A spatial Python model of grazing, predation, reproduction, and grass regrowth.

## Run and explore

Click the landscape to plant a patch of grass. Try slow regrowth and watch the delayed response.

Use Pause to inspect, Step to advance one step, and Reset to restart. The seed and population controls apply on reset; the slider applies live. Python runs in a dedicated Pyodide worker. The JavaScript view only renders snapshots and sends commands. Change `model.py` to alter the rules.

## Model

Agents act in shuffled order on a periodic grid. Grazers move toward grass, pay an energy cost, eat and reproduce above an energy threshold. Predators hunt nearby grazers, lose energy and reproduce after successful feeding. Starvation removes agents. The plot keeps the last 240 observations. The model is stochastic and uncalibrated; extinction is a possible outcome. Population is capped at 1,800 grazers and 350 predators to keep browser runs responsive.

## Files

`index.html` and `style.css` define the interface. All assets are local; no external datasets or network services are required.

MIT licensed, CoMSES Lab contributors.

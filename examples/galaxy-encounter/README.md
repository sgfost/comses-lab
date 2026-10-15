# Galaxy encounter

Two gravitational cores and 1,600 tracer stars. Compare tidal structures in prograde and retrograde encounters.

## Run and explore

Compare prograde and retrograde encounters. The orientation of a disk changes its tidal response.

Use Pause to inspect, Step to advance one step, and Reset to restart. Change the model in `model.js`; rendering and controls live in `view.js`.

## Model

A restricted gravitational model: 1,600 massless tracer stars orbit two massive, mutually attracting cores. Stars feel both cores but do not attract each other. Softened Newtonian gravity avoids singular accelerations, and kick–drift–kick leapfrog integration advances fixed time steps. There is no gas, stellar collision, dark-matter halo or dynamical friction; this illustrates tidal structure, not a full galaxy merger. Units are dimensionless.

## Files

`index.html` and `style.css` define the interface. All assets are local; no external datasets or network services are required.

MIT licensed, CoMSES Lab contributors.

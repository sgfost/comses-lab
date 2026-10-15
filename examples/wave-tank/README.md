# Wave interference

A two-dimensional wave equation with configurable sources and barriers. Compare single-slit and double-slit interference.

## Run and explore

Click anywhere in the water to drop a pulse. Change wavelength to spread or tighten the interference fringes.

Use Pause to inspect, Step to advance one step, and Reset to restart. Change the model in `model.js`; rendering and controls live in `view.js`.

## Model

A damped two-dimensional wave equation on a 180 × 108 lattice, advanced with a second-order finite-difference scheme. The Courant number is 0.45, below the two-dimensional stability limit. Fixed barrier cells reflect waves; a graded damping layer near the outside edges reduces reflections. A periodic source drives the tank. Colors represent signed displacement, not water depth or temperature. RMS amplitude is a relative measure, not conserved physical energy.

## Files

`index.html` and `style.css` define the interface. All assets are local; no external datasets or network services are required.

MIT licensed, CoMSES Lab contributors.

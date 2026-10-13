# Alternating temperatures

An ordinary Python model with its own HTML controls and Pyodide worker. `model.py` imports `vendor.diffusion`; the identical shared module is also used by the other reuse example. `component.json` records its exact CoMSES Lab source commit, path and SHA-256. The source lives in `examples/python/diffusion.py` in this repository. No Lab SDK or package registry is required.

Run one step at diffusivity 0.2. The six alternating cells produce [60,40,60,40,60,40], contrast 20 and total 300. Adjust the controls or reset the interpreter normally.

To explicitly refresh both example pins from an exact source revision, run `node scripts/vendor-diffusion.mjs <40-character-commit>` in the Lab checkout. Review and commit the changed vendored bytes and pin records. Bootstrap copies these checked-in files for new example repositories; it does not follow moving HEAD or update existing repositories.

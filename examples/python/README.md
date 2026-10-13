# Heat diffusion

`model.py` imports ordinary `diffusion.py` and simulates diffusion around a circular conductor. Its explicit finite-difference update conserves total heat; diffusivity between 0 and 0.5 keeps the update stable. The model can also be imported in a normal Python environment.

The HTML application owns all controls and plotting. `python-worker.js` loads Pyodide 0.29.5 from the locally installed distribution, copies the two ordinary Python source files into its browser filesystem, imports the model and relays results to the application's canvas. This example uses only Python's standard library. There is no Lab SDK, mandatory function signature or platform parameter schema.

Reset interpreter terminates the worker and initializes a new interpreter with no previous globals or modules. Diagnostics exercise Python exceptions and an infinite loop; reset and Lab Stop recover through worker termination. Runtime dependencies are pinned by Lab's npm lockfile. The model's own source is retained at the launched commit.

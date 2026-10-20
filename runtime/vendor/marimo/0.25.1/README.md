# Marimo 0.25.1

The browser assets come from the Apache-2.0 licensed upstream Python wheel. `provenance.json` pins its download URL, size, and SHA-256. Run `npm run setup:marimo` to download, verify, and extract them with Python's standard-library ZIP reader. Extracted assets are ignored by Git; no Python packages are installed and no notebook code is executed by this setup step. Upstream: https://github.com/marimo-team/marimo/tree/0.25.1

The adapter uses the build's `__MARIMO_MOUNT_CONFIG__.fileStores` hook and two private integration points: `window._marimo_private_PyodideBridge` for completing an explicit save and the worker's `self.controller.mountFilesystem` for populating project files before execution. Both execution and save workers receive the original notebook; configuration changes are mirrored to the save worker using Marimo’s `AppFileManager.save_app_config`. It triggers the pinned editor's `#save-button` to serialize the current cell state. Upgrades require running the browser acceptance test; these are not claimed to be stable upstream embedding APIs.

Python and package assets are fetched by the browser from Marimo/Pyodide and PyPI hosts. The complete Python environment is not vendored or frozen by this frontend pin.

The setup script applies one checked patch to `cells-CzugpTQu.js`: skip the default share-by-URL hash update when a custom file store is injected. Lab already saves through that store; Firefox rejects hash navigation on a parent-created blob URL in an opaque sandbox. The patch fails closed if the pinned upstream snippet changes. The adapter also unwraps Marimo’s data-URL module worker bootstrap in opaque frames to populate the project snapshot before execution.

# CoMSES Lab

An evolution of the comses.net model library as a separate app.

- Moving from an archive → download library towards an interactive one, based on git, where models/simulations are inspectable, forkable, and executable through the browser. Start with JS/Pyodide; later we can do cloud for non-JS/WASM stuff.
- AI-native, meaning good interfaces for local agents.
- Libraries or extracted components can be used to reuse functionality (e.g. an ABM framework, or a decision-making method).
- Frameworks and visualization tools should be libraries. Models can use them or do their own thing; we want flexibility, not DSLs or a required Lab model framework.
- Support for marimo notebooks as a way to document a model or explain experiments done with it (could import from models)
- Reproducibility: frozen releases, attested run data (? to be explored ?)

It may end up having domain separation (not hard segregation), and maybe labs/research groups within.

## Static demo

Build a browser-local demo for GitHub Pages with `npm run build:demo`, then run it locally with `npm run serve:demo`. See [static demo setup, behavior, and deployment](docs/STATIC-DEMO.md).

## Development

Initial stack: Vue + Vite, Hono on Node, SQLite, and Forgejo.

Run the frontend and API directly on the development machine. SQLite is a file managed by the API. Run Forgejo in Docker with its own database and persistent storage; Compose may be used for Forgejo alone.

The current app includes a code-editor workspace, Git revision/history/diff inspection, browser create/edit/commit/fork workflows, ordinary Git access, group permissions, and isolated JavaScript/Pyodide and native NetLogo Web models. NetLogo models keep their ordinary `.nlogo` or `.nlogox` source, with the upstream controls, plots and visual interface editor. Libraries are separate discoverable projects: create them, extract saved files, or install exact revisions into models and other libraries. See [local setup and acceptance commands](docs/LOCAL-DEVELOPMENT.md).

Saved results, frozen releases and marimo integration are deferred. Agents can connect through browser approval and use scoped Git credentials and the [Lab API](docs/AGENTS-API.md).

- [Development direction](docs/DEVELOPMENT.md)
- [UI guidelines](docs/UI.md)
- [API reference](docs/API.md)
- [Browser runtime](runtime/README.md)

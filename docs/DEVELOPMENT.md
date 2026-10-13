# Development direction

## Architecture

- A standalone repository for CoMSES Lab.
- Vue + Vite frontend and Hono on Node API, running natively in development.
- SQLite for Lab metadata; no separate database service.
- Forgejo in Docker, with its own SQLite database and persistent storage.
- No initial dependency on the existing CoMSES Django stack.
- Browser execution starts with JavaScript and Pyodide. Marimo supports explanations and publishing results alongside simulations.
- Code and small assets live in Git initially; large datasets may be hosted elsewhere.
- Frameworks and visualization tools are optional libraries. Models can provide their own code, UI, and execution logic; no required Lab model API or DSL. Runtime compatibility and isolation constrain execution, not the scientific structure of a model.
- The full application uses Forgejo. The static demo uses bundled examples and browser-local storage; see [static demo](STATIC-DEMO.md).

## Code layout

The application uses this layout:

```text
web/          Vue interface
server/       Hono, database, Forgejo integration
runtime/      Browser execution and isolation
shared/       Small set of API types and validation schemas
examples/     Models and reusable components
e2e/         Complete user workflows
```

Use one npm workspace and lockfile. A small Compose file may manage Forgejo alone. Development scripts should start Vite and Hono directly.

## Current implementation

The app supports artifact and library discovery, browser editing, drafts, saved versions, forks, reusable libraries, group permissions, and scoped agent access. JavaScript, Python/Pyodide, and NetLogo models execute in isolated browser previews.

See [local setup and integration tests](LOCAL-DEVELOPMENT.md), [API reference](API.md), and [runtime behavior](../runtime/README.md). Saved results, frozen releases, and marimo integration remain planned.

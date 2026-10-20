# Static demo (GitHub Pages)

The demo is a build mode of the existing Vue frontend. It needs no API, Forgejo, database server, credentials, or cloud functions. The normal development and production builds still use the existing backend.

## Build and run locally

Use the project's Node 24 / npm 11 toolchain:

```sh
npm ci
npm run setup:marimo
npm run build:demo
npm run serve:demo
```

Open **http://localhost:5200/comses-lab/**. This deliberately serves the output below a repository path, like GitHub Pages. The server serves files only; it has no API or fallback routes. `DEMO_PORT` and `DEMO_BASE` configure the local server, for example `DEMO_PORT=5300 DEMO_BASE=/ npm run serve:demo`.

For frontend development with hot reload:

```sh
npm run dev:demo
```

Open http://localhost:5200. Stop the static server first because these commands use the same port. Example/template assets are regenerated when Vite starts; restart after changing `examples/`.

## GitHub Pages output

The repository includes [`.github/workflows/pages.yml`](../.github/workflows/pages.yml). It builds the demo, checks types, and tests browser workflows before deploying only **`web/dist-demo/`**. It runs on pushes to `main` and can also be started from the Actions tab. No deployment secrets are needed.

To publish at **https://sgfost.github.io/comses-lab/**:

1. Review the repository and its Git history before changing visibility. Deleting a file in a new commit does not remove earlier copies from history.
2. Make `sgfost/comses-lab` public if using GitHub Free; private-repository Pages requires an eligible paid plan.
3. In **Settings → Pages → Build and deployment → Source**, choose **GitHub Actions**.
4. Commit and push the reviewed changes to `main`. If the workflow was already pushed before enabling Pages, run **Deploy demo to GitHub Pages** from the Actions tab on `main`.
5. Open the URL reported by the workflow’s `github-pages` deployment after it succeeds.

The workflow builds with `DEMO_BASE=/comses-lab/` on Node 24. A `gh-pages` branch, custom domain, backend, and database are not needed. For a different repository name, change that build path. Leave the generated output untracked; the workflow uploads it as a Pages artifact. Do not publish `.local/`, `.lab/`, or the normal `web/dist/` build.

See [GitHub’s custom Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) for the Pages source setting and deployment permissions.

Assets use relative URLs by default, so the same build works at `/comses-lab/`, a different repository name, or a custom domain's root. Routes use URL hashes, so direct project links need no server rewrites. An explicit build path can be supplied with `DEMO_BASE=/comses-lab/ npm run build:demo` if desired.

Serve over HTTPS, or localhost during development; browser storage coordination and the compiler require modern browser APIs. Opening `index.html` directly as a `file:` URL is not supported. The standard model runtime and JavaScript compiler assets are bundled. Marimo’s pinned frontend is also bundled; its Pyodide runtime and Python packages download from Marimo/Pyodide and PyPI hosts when needed. Notebook execution and editing run entirely in browser workers. The initial Marimo asset setup requires Python 3 only to extract the verified archive; no Python server is needed.

## What visitors can do

- Browse six examples: Ant trails and Predator–prey landscape (Python/Pyodide workers), Galaxy encounter and Wave interference (JavaScript/Canvas), NetLogo walks, and a Marimo population notebook. Browser kit and Agent grid remain as the two library examples.
- Fork an example into their own browser workspace, or create a project from a template.
- Edit files with live preview; autosave drafts; save versions, view history/diffs, and restore an earlier version.
- Create/extract libraries, install exact local versions, inspect nested dependencies, and update/remove unchanged installed files.
- Run Marimo notebooks, edit their cells, and save notebook source into browser-local drafts and versions. Companion Python modules and project data are available through Pyodide’s filesystem.
- Edit NetLogo code and interfaces, and import native NetLogo source through the creation dialog.
- Export their workspace as JSON and import it into another browser. Imports add projects; duplicate project IDs are refused instead of overwriting existing work. Reset removes local projects and restores the original catalog.

Examples remain read-only; fork them to edit. Local projects appear in My artifacts / My libraries, and alongside examples in Explore. A banner explains that changes stay in this browser and are never published. IndexedDB retains drafts and saved versions across refreshes. Clearing site data removes them; export is the backup/transfer mechanism. Storage is scoped to the site's origin and deployment path. Imported projects start with no allowed external data origins; re-enable needed origins in About after reviewing the imported source.

There are no accounts, private repositories, groups, permission management, shared edits, Git clone/push, or external agent connections. A local project's URL works only in a browser containing that project (or after importing its workspace). Versions are local snapshots, not Git commits; only `main` is supported. No server-executed models or hosted results are added by this mode.

## Preview behavior and boundaries

The JavaScript compiler runs in the host page's worker and bundles project modules without executing them. Each preview runs in an opaque sandboxed iframe. Its code cannot access the application's DOM or IndexedDB. The launcher supplies snapshot files through blob URLs, resolves `import.meta.url` resource paths, and prepares classic workers. Python uses the bundled Pyodide runtime. Runtime console, stop/reset, and live preview reuse the existing bridge.

The demo supports ordinary JavaScript modules, JSON imports, inline module scripts, local stylesheets, `new URL(path, import.meta.url)`, and fetches of project files. It is not a general web server: arbitrary computed module imports, server routes, package installation, CSS module imports, and external JavaScript imports are outside its supported scope. External data requires an allowed data origin in project metadata and CORS support from the data server. Snapshot files are UTF-8 text (up to 100 files / 5 MB per snapshot), matching the editable prototype's intended source workflow.

Marimo uses the same pinned frontend and save bridge as the full application. The launcher supplies the complete snapshot directly to both Pyodide workers, preserving project paths under `/marimo`; no import scanning or backend launch endpoint is involved. Its opaque iframe gets disposable storage and cannot read the host’s IndexedDB. Only notebook source returns to the host draft flow; arbitrary generated files are not persisted. Static hosts must serve frontend assets with CORS headers for the opaque iframe and module workers (GitHub Pages and the included static server do). Notebook dependencies must be Pyodide-compatible; this is not an offline Python environment.

NetLogo uses the same pinned compiler/player and interface bridge. Its preview gets disposable in-memory storage instead of the application's storage. NetLogo companion-file loading is not adapted to the demo's snapshot resources; the bundled NetLogo model is self-contained. The demo does not reproduce the backend runtime's per-launch hostnames, credential revocation, or standalone launch links. Native NetLogo/HTML export remains available in the player. Main-thread infinite loops have the same browser responsiveness limitation as the existing runtime.

## Verification

```sh
npx playwright install chromium firefox
npm run check
npm run test:demo
npm run build
```

The demo integration tests build the production output and serve it at `/comses-lab/` on port 5210. They exercise real browser execution, edits, local persistence, version history, workspace transfer, libraries, and NetLogo interface editing. They reject API requests so the tests cannot silently depend on a running development backend. Each test uses a fresh browser context and leaves development state untouched. Browser verification covers Chromium and Firefox.

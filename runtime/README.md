# Browser runtime

Models can be ordinary HTML applications with their own JavaScript, Python, controls and visualization, or native NetLogo files using the shared NetLogo Web player. Lab does not require a run/step/render function, parameter or output schema, model language, or SDK. The included worker and Python examples illustrate optional loading patterns.

## Source and launch documents

The API authorizes a project and exact Git commit before passing a complete byte snapshot to this server. A random, ten-minute capability addresses that snapshot. Each snapshot records its project, exact creating session hash or grant ID, and copied data-origin policy. Stop, session invalidation, project access changes, and grant revocation invalidate the matching capabilities; restart discards all snapshots. Launch status and deletion require the exact creating credential, even when another credential belongs to the same human. The runtime has no Lab credentials and runs on a different host from the application.

Launch URLs add `?lab-entry=1` to the configured entrypoint. For this one HTML response, the server removes a leading UTF-8 BOM and prepends a canonical HTML doctype plus a blocking bridge script. This deliberately normalizes the launched document to standards mode and installs telemetry before model scripts. Source views and Git retain the original HTML. Reading the snapshot without the launch query, or fetching any other asset, returns the original bytes, including binary data and line endings. Relative URLs keep their ordinary meaning.

The bridge route checks the same capability and expiry. It is ordinary JavaScript served by the runtime, not code fetched from the authenticated application origin. The bridge captures page console calls, uncaught page/worker errors and unhandled page promises. It limits events and text; the host independently limits incoming messages and visible lines. Arbitrary worker console calls are not intercepted automatically. Examples relay their own worker output to ordinary page console calls.

`ready` means the bridge is installed, not that a model has initialized. Console text and lifecycle acknowledgements are untrusted model telemetry. A model can fabricate its own messages or bypass worker tracking; these messages confer no authority or execution attestation. The host validates source window, the expected origin (opaque for HTML, unique for NetLogo), active launch ID, exact schema and absence of transferred ports. The bridge checks the configured parent application origin/window and exact stop command. See `shared/runtime.ts` for that internal protocol.

## Preview sizing

The bridge also installs display-only sizing in embedded previews. The host sends a validated `preview-fit` command after bridge readiness and when the sizing control changes. Fit measures the body and its overflowing content, scales down, and centers it within the iframe; resize observations update it as content or pane dimensions change. A stable layout width avoids feedback from responsive canvases. Actual size removes the sizing class without reloading. NetLogo interface authoring temporarily uses Actual size; standalone launches retain the original layout. This changes only the running document, never retained source or downloads.

## Workers and termination

A model may use normal browser Workers. In the tested Chromium opaque sandbox, classic blob workers can dynamically import ordinary local modules. Module-type blob workers failed before their initial module loaded, so examples use the verified classic-worker bootstrap. Workers improve responsiveness; the sandbox and credential-host separation supply isolation.

Stop asks the bridge to call native `Worker.terminate()` on tracked workers, then the host always removes the frame within its 250 ms teardown bound. The acknowledgement reports termination calls, not semantic completion. Removing the owning document also terminates its worker descendants; browser acceptance checks include an untracked worker in an infinite loop and a nested worker whose direct heartbeat stops after frame removal. A new launch or an example's Reset creates fresh workers; Python reset recreates the entire interpreter. Arbitrary JavaScript loops on the model page's main thread have no promised interruption bound.

## Python dependencies and network

The npm lockfile pins Pyodide 0.29.5. Exactly `pyodide.mjs`, `pyodide.asm.js`, `pyodide.asm.wasm`, `python_stdlib.zip` and `pyodide-lock.json` are served from `/vendor/pyodide/0.29.5/`. There is no CDN fallback, package downloader or arbitrary filesystem/proxy route. The first Python example uses only the standard library. All Python executes inside its browser worker; the API never evaluates Python or model JavaScript.

CSP allows WASM compilation through `wasm-unsafe-eval`, without general `unsafe-eval`. The sandbox stays opaque (`allow-scripts` only), with no authenticated app requests, storage, nested frames or script loading from external origins. Asset responses allow anonymous CORS because the document origin is opaque. Model execution requests must not contain Lab credentials.

Owners may allow up to 16 canonical HTTP(S) data origins in project metadata. The API validates origins and denies configured application, Forgejo and runtime credential hosts and prohibited local aliases. Each launch captures a copy of the current policy. Only `connect-src` expands; script/module and worker sources retain their runtime-only restrictions. Blob workers inherit the document policy. External servers must allow CORS from opaque `null` origins; examples omit credentials. The runner receives no Lab session, agent bearer or provider credentials.

Narrowing data permission revokes previous project snapshots. Expanding it does not widen already launched previews. This origin permission is not an intranet firewall or DNS-rebinding guarantee: owners trust allowed DNS names and their servers. Arbitrary model fetches may request third-party credentials for an explicitly allowed origin; fixture CORS does not permit them.

Runtime revocation denies subsequent snapshot and bridge reads immediately. It cannot erase bytes already delivered or forcibly stop arbitrary clients. The trusted host checks authenticated launch status and removes invalid or unchecked previews; browser throttling and connectivity affect its observation latency.

## NetLogo Web

Entrypoints ending in `.nlogo` or `.nlogox` use the pinned NetLogo Web 2.15.3 player in `runtime/vendor/netlogo/`. The launch response identifies `runtime: "netlogo"` and includes a `standaloneUrl` for opening the same snapshot in its own tab. Only the launch document is generated; ordinary source reads preserve the original bytes. A leading UTF-8 BOM is ignored for compilation only. The compiler, simulation, widgets, and embedded resources execute in the browser.

Each NetLogo launch has a distinct origin derived from its capability. Locally this is `<hash>.localhost` on the runtime port. A deployed runtime uses `<hash>.<runtime-host>` and requires wildcard DNS and TLS. The runtime host must use a separate domain from both the authenticated application and Forgejo. Configuration conservatively rejects either credential host sharing the runtime host’s final two hostname labels; this deliberately also rejects separate registrations such as `one.co.uk` and `two.co.uk`. Plain localhost/loopback development is exempt; Chromium checks verify that a launch cannot set a parent-domain cookie on `localhost`.

NetLogo documents allow general JavaScript evaluation for the compiler, same-origin access for browser storage, nested same-origin frames for the color picker, native dialogs, downloads, and JavaScript-handled form submissions. `form-action 'none'` still prevents network form submissions. These permissions apply to both the response sandbox and the application's NetLogo iframe; ordinary HTML/Pyodide previews retain the opaque policy above. Origin-agent clustering and a disabled `document-domain` policy prevent sibling-origin relaxation. Service-worker scripts are refused, and NetLogo worker sources are limited to blobs. Capability routes require the correct launch hostname. No application credentials or saving authority are exposed to the runtime.

The adapter filters incoming messages before upstream listeners, accepts only validated Lab commands from the configured parent, and permits the player's own internal messages. Visual changes and complete XML exports use the schema in `shared/runtime.ts`; export results are untrusted source text and carry a host-generated request ID. The host owns authorization, stale-source checks, draft saving, and commits. The standalone tab cannot write to Lab. Downloaded standalone HTML uses the clean pinned player, without Lab bridge code or expiring capability URLs.

The sandbox does not make main-thread NetLogo loops preemptible or prevent a standalone page from navigating itself. Models remain subject to the bundled NetLogo Web version's compatibility and browser restrictions. External data must satisfy the project's permitted origins and the destination server's CORS policy; NetLogo requests have their launch origin rather than the opaque `null` origin used by HTML previews.

The adapter does not supply desktop-only primitives or bypass upstream unsupported-extension errors. Browser integrations needing external frames, popup windows, camera/microphone access or cross-origin messaging are constrained by the sandbox even if the upstream engine declares their extension. Ordinary controls, plots, file import/export, native dialogs and the bundled array/table/CSV/matrix/store/fetch paths have browser acceptance coverage. Store data belongs to one launch origin; it is not durable Lab project storage.

## Marimo notebooks

A `.py` entrypoint launches the pinned Marimo 0.25.1 WASM frontend. Run `npm run setup:marimo` once before development/deployment to install its verified frontend assets (requires Python 3 for ZIP extraction). Lab never evaluates notebook Python on the API server.

In the full application, each launch uses the same distinct-origin scheme as NetLogo, so deployed runtime hosts need wildcard DNS/TLS on a domain separate from Lab and Forgejo. Marimo gets same-origin storage, module/blob workers, WASM/JavaScript evaluation and downloads. Its CSP permits dependency loading from `cdn.jsdelivr.net`, `wasm.marimo.app`, `pypi.org` and `files.pythonhosted.org`, in addition to the project's permitted data origins. Notebook dependencies must be compatible with Pyodide. The frontend is pinned; this is not a fully frozen/offline Python environment.

Before the notebook starts, the adapter writes the complete authorized project snapshot into Pyodide under `/marimo`, preserving paths and binary bytes, and adds `/marimo` to Python's import path. This includes installed Lab library files. Relative data paths use `/marimo` as the working directory. This is a per-launch working copy; arbitrary filesystem changes and generated results are not saved to Git.

The owner can run or edit a notebook, including a companion notebook selected without changing the project entrypoint. Cell edits return only the active notebook source through a validated message channel into Lab's normal draft flow. Before Save version, navigation, Stop or switching back to viewing, Lab requests an explicit Marimo save and waits for the corresponding source; failed saves keep the preview open. Source editing for that notebook is disabled while the cell editor is active. The host checks write permission and rejects stale source before updating the draft. Read-only launches cannot save to Lab.

The static GitHub Pages demo runs the same Marimo/Pyodide integration entirely in the browser, with an opaque iframe and project files supplied directly to its workers. Edits persist in browser-local drafts and versions. No API or runtime server is needed; see [static demo setup](../docs/STATIC-DEMO.md). See the [pinned adapter provenance](vendor/marimo/0.25.1/README.md) for upstream integration points and upgrade requirements.

# Run CoMSES Lab locally

Requires Node **24.13.1**, npm **11.8.0**, Git, and Docker with Compose. Frontend/API/runtime run natively. Only Forgejo runs in Docker. Node's built-in SQLite currently emits its experimental-feature notice.

From the repository root:

```sh
npm ci
npx playwright install chromium
npm run setup
npm run setup:marimo
npm run forgejo
npm run bootstrap
npm run dev
```

Open **http://localhost:5100**. Use `localhost` for the app, not `127.0.0.1`. Bootstrap creates `ada`, `ben`, `cy`, and `dee`; read their generated passwords from `.lab/dev/credentials.json` locally. Ada owns the seeded examples and research group; Ben starts with group write access, Cy with read access, and Dee is unrelated. Never copy this file into shared logs. The app signs in with actual sessions; source comes from real Forgejo Git repositories.

`npm run check` checks TypeScript/Vue and `npm run build` creates `web/dist`. Build output is not a deployment configuration.

## Try the prototype

1. Sign in as `ada` and open **Random walks**. The preview loads automatically; the model's own **Run** computes and plots it. Choose **Edit** (or **View source** for read-only access) to inspect files, open the console and resize panes. **View model** returns to the simulation.
2. Choose **Fork**, edit a file in the new project, let it autosave, then choose **Save version** or **Save version and run** when you want a history entry. **What changed?** is optional. Branch selection enables editing; a selected historical commit is read-only and can be forked.
3. Open **Heat pulse** and **Alternating temperatures**. Both import `vendor/diffusion.py`; inspect `component.json` for the same pinned source commit and checksum. Their default outputs are pulse peak **60** / total **100**, and alternating contrast **20** / total **300**.
4. Use **Groups** to inspect membership and the model's **About** panel to manage access. In the seeded group, Ben can edit, Cy can read/run, and Dee has no private access. Owner permission changes may remain pending while Forgejo is unavailable; the displayed Retry resumes the same change.

**Live preview** reloads the sandbox after a 700 ms pause in editing, including unsaved file additions, changes and deletions. It resets the simulation; turn it off to keep a run going while editing. Draft previews are labeled **Draft** and create no Git commits. Edits autosave to a private SQLite draft after a pause; **Saved** means the server acknowledged them. **Save version and run** launches a new committed version. **Stop** also turns off live updates; the toolbar can restart the preview. Source-only libraries do not launch, and signed-out visitors can sign in from the preview pane.

**History** lists saved versions by description, author and date. View a version or compare its changes; **Restore this version** saves its files as a new version without deleting later history. Restore does not change project metadata or access. Branches, tags and exact revision IDs remain under **Git details** in the source workspace.

## NetLogo models

Open **NetLogo walks**, or choose **New model → NetLogo**. You can start with the example or import an existing `.nlogo` or `.nlogox` file (UTF-8, up to 2 MB). Imported source is preserved; its license starts as **Unspecified** until the owner sets it. The app supplies the shared, pinned NetLogo Web 2.15.3 compiler, engine and interface, so repositories need no JavaScript wrapper or copied player.

Use the model's own setup/go buttons, sliders, monitors and plots. **Edit** opens the source: **Code** edits only NetLogo procedures while retaining other sections; **Full model** exposes the complete file. **Live preview** recompiles after source changes. Invalid models remain editable, with errors in the player and console.

**Edit interface** loads the current draft into NetLogo's visual editor. Widget and Info changes autosave to the same Lab draft. **Done** captures the final edits and returns to running the model; **Save version** creates a Git history entry. A legacy `.nlogo` needs explicit conversion for visual editing because this NetLogo Web version exports XML: the owner can convert on the default branch, saving a `.nlogox` copy and retaining the original. Code-only edits need no conversion. Readers can fork first.

**Open model ↗** opens this snapshot with NetLogo Web's full interface and file exports. Edits in that separate tab do not autosave to Lab; export a model and import it as a new project, or update the existing repository through Git. Standalone HTML exports work without Lab. Ordinary forks, history and agents operate on the native source files.

Compatibility follows the pinned **NetLogo Web** release, not every desktop NetLogo feature. Companion assets may live in Git within the existing snapshot limits (100 files / 5 MB total); permitted external data still requires CORS. Each launch gets fresh browser storage, so a store extension is not durable project storage. Arbitrary main-thread loops have no guaranteed interruption time. See [runtime isolation](../runtime/README.md#netlogo-web) and [upstream provenance and licenses](../runtime/vendor/netlogo/2.15.3/README.md), including the bundled Highcharts terms before deployment. No external CDN is needed for the player.

## Libraries

Open **Explore → Libraries** (`#/explore/libraries`); models have their own page at `#/explore/models`. Search within either catalog, or check **Search models and libraries** to search across both. **Diffusion**, **Browser kit** and **Agent grid** are independent Git repositories with their own files, history and forks. Use **New library** to start an ordinary Python or JavaScript module, or **Extract library** in a project to copy selected saved files into a new library. Extraction records its source revision and leaves the original files/imports unchanged.

On a library page, **Examples** finds accessible models using it, including through nested libraries. **Add to model** lets you choose a compatible model you can edit, then installs a saved version with a suggested folder. Installed libraries show an update action when a different default-branch version exists; file choices and revision IDs are under details.

Open **Grid walkers**, then **Edit**. The **Libraries** section beneath its file tree shows **Agent grid → Browser kit**, with descriptions and links to their pinned source. The model's small `model.js` defines movement; Agent grid supplies agents, a scheduler and grid rendering, while Browser kit supplies controls/canvas/animation helpers. All are optional ordinary JavaScript. Heat pulse and Alternating temperatures separately depend on **Diffusion**.

On an editable branch, choose **Add library**. Select the source library, review its version/files, and choose a destination such as `vendor/library`. Installation updates the same draft, preserving other edits. Choose **Save version** to include the files and pins in Git history. Write ordinary imports to those files. Nested dependencies travel with the selected library revision; no moving versions are resolved at launch. Libraries themselves use this same workflow.

Expand a dependency's **Details** for copied files and **Update**/**Remove**. **Update → Use latest version** selects the current source revision for the draft before an explicit version save; you can also load an older revision. Selecting an older model commit restores its pinned copies. Update/removal refuses to overwrite edited dependency files. **Remove** deletes recorded unchanged files; it does not rewrite your imports. A library without an HTML entrypoint opens as a source workspace; it can optionally add one for runnable examples.

Pins and file hashes live in Git as `lab.lock.json`, alongside the copied files. The prototype supports vendored UTF-8 source, not a package registry or automatic build system. Private libraries require private destinations. Copies already committed remain in the destination even if upstream permissions later change.

Bootstrap adds library/example repositories without replacing existing source. For the two earlier diffusion examples it adds only a lockfile commit when their existing module bytes match and no lockfile exists. Subsequent bootstrap runs leave those pins unchanged.

Ordinary Git uses Forgejo on `http://127.0.0.1:5103` and the same generated local account credentials. For example, `git clone http://127.0.0.1:5103/ada/heat-pulse.git` prompts for authentication. A pushed commit appears when you refresh the selected branch in Lab. Passwords belong in the prompt, not the URL.

To explicitly refresh both checked-in component copies from a known revision, use `node scripts/vendor-diffusion.mjs <full-commit-sha>` and review/commit the changed files. Existing seeded repositories are not overwritten by bootstrap; their copies can be changed through normal Git or browser authoring.

Stop `npm run dev` before reinstalling dependencies with `npm ci`, then start it again. Replacing `node_modules` while the watcher runs can leave the API waiting after a failed reload.

## Use your own agents

Give your agent the running app's guide: [http://localhost:5100/api/agent-guide](http://localhost:5100/api/agent-guide). It requests a connection and gives you a browser link and matching code. Sign in and approve the projects it can read/write, plus creation permission if it should fork or create projects. No token copying is needed. **Agents** in the top bar provides copyable instructions and lists connections for revocation; manual token creation remains available there.

The normal workflow is browser approval → Lab discovery/fork → repository-scoped Git credential → clone/edit/commit/push → Lab preview. Libraries can be created/extracted and installed/updated through the API too. Keep secrets in the agent's credential manager, outside chat, source files and remote URLs.

Browser drafts and local Git working directories are independent. An agent push does not overwrite a nonempty browser draft; saving that draft detects the changed branch and asks for reconciliation. Revoking the agent token also revokes its Git credentials and previews. The dialog shows pending revocation if Forgejo confirmation is unavailable; recovery retries automatically.

## Isolated instances

Set a unique instance name and base port for each worktree. Keep `LAB_INSTANCE` in subsequent commands:

```sh
export LAB_INSTANCE=foundation
LAB_PORT_BASE=5310 npm run setup
npm run forgejo
npm run bootstrap
npm run dev
```

The four consecutive ports are app, API, credential-free runtime, Forgejo. Setup records them in `.lab/<instance>/config.json` and does not replace an existing configuration. State and credentials live in `.lab/<instance>`; Forgejo uses a separate Compose project and named volume `comses-lab-<instance>_forgejo-data`. Use a unique instance name across worktrees because Docker project names are host-wide.

| Instance | App | API | Runtime | Forgejo |
| --- | --- | --- | --- | --- |
| Default `dev` | localhost:5100 | 127.0.0.1:5101 | 127.0.0.1:5102 | 127.0.0.1:5103 |
| Foundation author | localhost:5310 | 127.0.0.1:5311 | 127.0.0.1:5312 | 127.0.0.1:5313 |
| Default acceptance | localhost:5510 | 127.0.0.1:5511 | 127.0.0.1:5512 | 127.0.0.1:5513 |

Normal commands preserve state. Re-running bootstrap does not overwrite nonempty repositories, change passwords, or replace Lab IDs. If initialization is interrupted, rerun bootstrap. A failed Forgejo call reports an upstream error rather than an empty repository. Read `.lab/<instance>/config.json` to confirm the target before lifecycle commands.

Stop native services with Ctrl-C. `npm run forgejo -- stop` stops only this configured Forgejo service; `npm run forgejo -- up -d` starts it again. `npm run forgejo -- logs --tail=50` helps diagnose readiness. There is no automatic reset command. Do not delete volumes/databases to fix ordinary startup failures.

## Acceptance

```sh
npm run test:e2e
```

The command installs no packages. It creates/preserves the isolated `test-foundation` configuration, starts its own Forgejo volume, seeds accounts/repos, starts native services under Playwright, and shuts down those native services afterward. It refuses a `LAB_INSTANCE` without the `test-` prefix and refuses to reuse already-running web services. For another isolated acceptance target:

```sh
LAB_INSTANCE=test-review LAB_PORT_BASE=5610 npm run test:e2e
```

Browser: Playwright 1.63.0 Chromium / Chrome for Testing 153.0.8010.12. Tests cover source from Forgejo, the model's own HTML/module/control path, public/private read and launch checks, logout, foreign-origin requests, opaque-frame DOM/cookie/storage/API denials, runtime cookie absence, and Vite secret-file denials. `test-results/` contains screenshots, never credentials. Traces are off to avoid recording sign-in secrets.

The current app supports exact-revision source, branch/tag selection, history and diffs, browser file editing/commits with stale-save protection, template creation, exact-revision forks, group permissions, data-origin controls, and isolated HTML/JS/Pyodide previews with console output. Bootstrap adds Random walks (JavaScript worker), Heat diffusion (Python) and a private group example alongside the original public/private examples; existing repositories and metadata are preserved. Models have their own controls and code, with no mandatory Lab SDK. See [runtime behavior and limits](../runtime/README.md) and [source API documentation](API.md).

Saved results and frozen releases remain deferred. Scoped agent credentials, repository-specific Git credentials, and combined scoped-grant revocation testing are now included. Arbitrary main-thread code is not promised to be interruptible; supported worker paths have explicit stop/reset checks.

After the isolated browser suite has initialized its test state and stopped native services, run the durable launch/session race checks separately:

```sh
LAB_INSTANCE=test-foundation node e2e/launch-session.mjs
```

This refuses development instances and already-running APIs. It verifies logout, expiry, and replacement while a real source response is delayed, then checks valid-session recovery and revocation. Use the same `LAB_INSTANCE` as your initialized isolated test state.

Forgejo is pinned to **15.0.9 LTS**, verified against the [official release list](https://forgejo.org/releases/15.x/) on October 1, 2026. It remains sign-in protected; anonymous Lab public-source reads use a dedicated unprivileged reader account. Direct Forgejo access uses the generated local account credentials.

## Marimo notebooks

Choose **New artifact → Marimo notebook**, or add an ordinary Marimo `.py` file alongside a model. Use **Open notebook** in the source toolbar or the preview file selector. **Edit notebook** opens Marimo’s cell editor; edits autosave to Lab drafts, and **Save version** records the latest notebook source in Git. **View notebook** returns to the interactive app. The starter imports `model.py` and reruns its population plot when the growth slider changes.

Run `npm run setup:marimo` to install the pinned frontend assets. First launch downloads Python and compatible packages, so it requires internet access. Python files and data in the project are available under `/marimo`; generated files remain local to the running preview. See [runtime behavior](../runtime/README.md#marimo-notebooks).

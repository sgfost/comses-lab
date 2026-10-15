# UI guidelines

Design conventions for the catalog, workspace, and browser previews.

## Visual style and copy

- Use the flat **white-canvas Mosaic** design: white background, borderless light neutral gray cards and controls, and restrained CoMSES blue/green accents. Keep body text neutral, not blue tinted.
- Use Helvetica Neue, Helvetica, Arial, sans-serif, with regular (400) and bold (700) weights. Source code and technical values can use monospace.
- Use plain CSS and Vue components. Shared CSS variables define surfaces, text, interaction states, and editor colors. Do not add a component library without a concrete need.
- Light mode only for now; ignore system dark mode.
- Flat surfaces with modest rounding (usually 8px), generous catalog spacing, and compact functional workspace controls. Reserve shadows for floating menus and dialogs. Keep visible keyboard focus.
- Model preview images should be actual screenshots or uploaded/generated assets, independent of the app palette. Until the data model supports these, use content-only cards; do not fill the catalog with empty image panels or fabricate screenshots.
- Keep the source/console/preview as a shared resizable surface. Embedded models retain their own appearance.
- Text must describe content, actions, status, or errors. No slogans, marketing copy, cutesy empty states, or redundant explanations.

## Artifact detail page

Artifacts open with their file tree visible on desktop. Owners and collaborators with write access also see the code editor by default; readers start on the preview and can open any file. **Files** is always available, independently of the editor. The editor close button at the right end of its toolbar, closing its last tab, and dragging its divider left hide the code pane without discarding drafts. Opening a file reveals the code pane. An explicit closed view survives reload. On phones, the file drawer starts closed to leave content usable. Libraries open on their README/source.

Simulation previews default to **Fit**: scale down and center the complete interface inside the available preview pane, recalculating when the pane or content changes. **Actual size** restores the authored layout without restarting the simulation. NetLogo interface editing temporarily uses Actual size. Keep saved source unchanged.

Autosave drafts after a pause and show **Draft saved** only after server acknowledgement; show **Version saved** when the draft matches its saved version. Use **Save version** and **Save version and run** for deliberate history entries, with an optional **What changed?** note. Acknowledged drafts survive navigation, reload and sign-out; history views do not replace them. Keep **Fork**. History emphasizes change descriptions, people and dates; restore creates a new saved version. Hide branch/hash details under **Git details**. Show readable ancestry links when the original project is accessible.


- Fullscreen with scrollable containers rather than a scrollable page, like a code editor/IDE.
- A files sidebar, probably also including the other stuff like libraries and docs (notebook or otherwise).
- A code view, a console view, and a simulation/visualization view.
- Draggable boundaries between the views.
- One Files / History / About control group opens the sidebar. Avoid duplicate navigation. On phones, opening a file reveals its editor; Escape closes the drawer and returns focus.
- Forking and similar actions can go in a top bar.
- Live preview reloads unsaved source after a pause in editing. It can be turned off to keep a simulation running while editing. Label unsaved previews clearly; previewing must not create a Git commit.

CodeSandbox and molab (marimo) are references for the resizable workspace layout.

## Explore/search

Persistent navigation provides **Explore**, **My artifacts**, and **My libraries**. Signed-in home opens My artifacts. Personal catalogs contain owned work and explicitly shared work, including read-only collaboration. Explore displays only public projects. Preserve each catalog’s search context in its URL and when returning from detail pages; visibility filtering belongs to the personal catalogs. On phones, app navigation becomes a horizontal strip.

Libraries should have their own explore page, separate from artifacts, with an option to search both. On the detail page, make dependencies clear from the Files view, in a section below the file tree. Library links should include useful descriptions and show their relationships; keep file-level details and maintenance controls secondary.

Library pages offer **Examples** and **Add to artifact**. Installation chooses the latest saved version and a folder by default; exact revisions and file selection remain available in details. Updates remain explicit.

## Branding

Use only the original hexagon mark, from CoMSES.net’s `frontend/src/assets/images/comses-logo-small.png`, with Comses lab rendered as normal Helvetica text beside it. Do not use the full image wordmark. Icons come from `django/core/static/favicon/`; Lab app assets live in `web/public/branding/`. Do not invent a replacement brand mark.

## Product naming

Use **Artifacts** for the general runnable project catalog, creation, forks, access, and preview controls. Keep **Libraries** as a separate catalog. Use **NetLogo model** when referring to the actual format or its editor. Existing API kind values (`model`, `library`) and old explore URLs remain compatible. New navigation uses `#/explore/artifacts`.

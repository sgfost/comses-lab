# Local Lab API

The API lives at the configured app origin under `/api` (default `http://localhost:5100/api`). JSON response types are in `shared/contracts.ts`. This document describes inspection, sessions, authoring, persistent drafts, group access and agent credentials. Results and releases remain deferred. See [the agent guide](AGENTS-API.md) for the Git-first local development workflow.

## Access and sessions

`GET /session` returns `{ user: { id, username, displayName } | null }`. `POST /session` with `{ username, password }` creates a session; `DELETE /session` revokes it and the user's previews. Use a cookie jar for local HTTP clients. State-changing requests require `Origin: <configured app origin>` and `Content-Type: application/json`. All requests with a foreign Origin are rejected. No CORS access is granted.

The session cookie is host-only `localhost`, HttpOnly, SameSite=Strict, scoped to `/api`, and valid for seven days. This local HTTP setup does not use Secure cookies. Credentials are generated in the instance's ignored credentials file; never include them in logs, source, or command arguments.

Anonymous visitors may read public projects. A signed-in owner may also read their private projects. Assigned group members can read or write according to their project permission. Inaccessible and nonexistent project IDs both return `404 not_found`, before revision/path validation or any Forgejo request.

Lab project UUIDs are separate from Forgejo repository IDs. `GET /projects` returns `{ projects: Project[] }`, filtered by access. `GET /projects/:id` returns `{ project }`. Clients select a Lab project ID; they cannot substitute arbitrary provider locators. Public anonymous reads use an unprivileged Forgejo reader account; authenticated reads use the signed-in user's mapped Forgejo credentials. Direct Git permissions remain enforced by Forgejo.

## Source inspection

All routes below start with `/projects/:id`. Responses use `Cache-Control: no-store`.

| GET route  | Request                                      | Response                                                                                             |
| ---------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/refs`    | `kind=branch` or `tag`, `page=1`, `limit=25` | `{ kind, defaultBranch, refs: [{ name, ref, commit }], page, limit, nextPage }`                      |
| `/tree`    | `ref=main` by default                        | `{ commit, files: [{ path, size }] }`                                                                |
| `/file`    | required `commit`, `path`                    | `{ commit, path, content }`                                                                          |
| `/history` | required `commit`; `page=1`, `limit=25`      | `{ commit, commits: [{ commit, parents, message, author: { name, date } }], page, limit, nextPage }` |
| `/diff`    | required `commit`                            | `{ commit, base, patch }`                                                                            |

`commit` is always a full, lowercase, 40-character Git commit SHA. History, file and diff requests require that exact SHA; they do not accept branches, abbreviated SHAs, or annotated-tag object IDs. A client first resolves its selection with `/tree`, then uses the returned commit for all source, history, diff and launch requests. Later branch movement does not change requests pinned to that commit. This is a live development repository, not a retention guarantee against deletion and garbage collection; frozen publications are a later milestone.

Refs include a human-readable `name`, a qualified `ref` such as `refs/heads/experiment/slash` or `refs/tags/v1`, and the peeled commit SHA (including nested annotated tags). Use the qualified ref to avoid ambiguity. Tree accepts qualified branch/tag refs, bare branch/tag names, or full SHAs. Bare names prefer branches, then tags. Git revision expressions (`main~1`, `HEAD^`, reflogs), remote refs, path traversal and malformed names are rejected. A bare `HEAD` is only a literal branch/tag name; it does not select Git's symbolic HEAD. Names are limited to 200 characters excluding the qualified prefix.

Ref listings use actual Git heads/tags, sorted by their UTF-8 bytes; provider metadata supplies only `defaultBranch`. A stale provider empty flag cannot hide a successful push. Actual absent heads/tags return `empty_repository`; authentication/transport failures remain upstream errors. Ref names with invalid UTF-8 bytes return 422 `unsupported_refs` rather than aliasing another name.

Pagination is 1-based. `limit` is 1–50; `page` is 1–1,000,000. Invalid values are rejected, never silently clamped. `nextPage` is a number or `null`; an out-of-range page is an empty list with `nextPage: null`. History traverses all commits reachable from the selected commit in ordinary Git log order, including both sides of merges. It is not limited to the first-parent chain. Retain the same `commit` and `limit` across history pages. Ref listings are live; concurrent branch/tag changes can affect pagination, so refresh the list when needed. No total count or stable snapshot of refs is promised.

File paths are relative repository paths. URL-encode query values. Empty components, `.`, `..`, backslashes, control characters and paths over 500 characters are rejected. The source viewer returns ordinary UTF-8 text files up to 2,000,000 bytes, preserving a leading BOM. NUL-containing or invalid UTF-8 files return `422 unsupported_file`; the raw launch loader still supports binary assets. Symlinks and other nonordinary objects cannot be read through this endpoint. Paths containing U+FFFD (the replacement character), or ambiguous provider tree paths, also return 422: provider JSON cannot distinguish a literal replacement character from invalid Git filename bytes. Those names remain available through ordinary Git. File sizes in tree responses are bytes; an upstream truncated tree is rejected explicitly.

Diff is the selected commit compared with its **first parent**. Forgejo displays UTF-8 path names directly (`core.quotePath=false`). `base` is that parent's exact SHA or `null` for a root commit. A root diff compares against the empty tree. `patch` is UTF-8 unified diff text with normal Git binary markers, rename detection, paths and hunks; it may be empty for an empty change. It is text to display, never HTML to execute. There is no per-file diff schema. Invalid UTF-8 patches return `422 unsupported_diff`. Responses are limited to 2,000,000 upstream bytes and rejected with `413 diff_too_large` while streaming, never truncated into a successful patch. Root commit-message headers emitted by Forgejo are removed; they still count toward this limit.

The concrete boundary is `server/forgejo.ts`. It uses Forgejo 15.0.9's branches/tags, commits, recursive trees, Git blobs and commit `.diff` APIs. Source reads resolve an ordinary file in the exact committed tree, then load its blob. This avoids the contents endpoint’s temporary empty-list response while post-receive repository metadata is still initializing. Pagination reads provider Link metadata without following supplied URLs. Requests have a 15-second timeout and reject redirects. [Pinned Forgejo diff implementation](https://codeberg.org/forgejo/forgejo/src/tag/v15.0.9/modules/git/diff.go) uses first-parent `git diff -M` and root `git show`; Lab removes the root message header. No local model code runs in the API process.

## Launching an exact revision

`POST /projects/:id/launch` with `{ commit }` requires sign-in and project access. The original request session is revalidated after source loading; logout, expiry, or session replacement while loading returns `401 unauthorized` without creating a preview. It returns `{ id, commit, url, expiresAt }` after copying up to 100 ordinary files / 5 MB from that commit into an ephemeral preview. Each file must be at most 2 MB. `DELETE /launches/:id` revokes a preview owned by the session user.

For an unsaved preview, the same endpoint accepts optional `changes` using the existing create/update/delete file-change format. Drafts require current write access, checked again after source loading. The server overlays those files only in the ephemeral snapshot; it writes no Git commit or project metadata. The response includes `draft: true`, and `commit` identifies the base revision. Path/content validation matches ordinary commits, and the resulting snapshot must still fit 100 files / 5 MB. JSON requests are bounded to 12 MB. Runtime isolation, data-origin restrictions, expiry and revocation are unchanged.

The preview URL is a short-lived private-content capability, expires in ten minutes, and is revoked on logout/Stop. Do not log or share it. It grants no Lab session privileges. HTML/Pyodide models execute inside an opaque sandbox; native `.nlogo`/`.nlogox` entrypoints use a unique launch origin and the shared NetLogo Web player. Native launch responses add `runtime: "netlogo"` and `standaloneUrl` for the same snapshot in a separate tab. See [runtime isolation](../runtime/README.md).

Marimo launches accept optional `entrypoint` (an existing `.py` notebook path, or the configured entrypoint) and `edit: true` for users with write access. This selects a companion notebook without changing project metadata. The response includes `runtime: "marimo"`; the browser loads the pinned editor/runtime and mounts the same snapshot into Pyodide. Source edits still use the ordinary draft/save APIs. Read-only launches have no saving authority. See [Marimo runtime](../runtime/README.md#marimo-notebooks).

## Authoring

Native agent requests use `Authorization: Bearer <token>` and may omit Origin; a supplied foreign/opaque Origin is rejected. A bearer plus a session cookie is ambiguous and returns 401. Invalid bearers never fall back to anonymous reads. Bearers are restricted to their project scopes and receive read/write permission only; owner metadata and group/access/session administration remain human-only. Creation requires an explicit grant capability; newly created projects are enrolled in that grant. Public source visibility does not widen a grant's Lab project scope.

`GET /launches/:id` returns `{ id, state: "active", expiresAt }` only for the exact originating session or grant with current read rights. Missing/invalid authentication returns 401; absent/revoked/wrong-principal launches return 404. Delete uses the same ownership check. Logout revokes that session's snapshots. Launch creation rechecks the full principal, pending access and current metadata after source loading; data origins are copied immutably into connect-src only. Removing an origin revokes existing project snapshots. Grant and repository-scoped Git credential issuance are described in the agent guide.

Project responses include server-computed `permission` (`admin` for the owner, `write` for authorized writers, `read` for other authorized readers), `metadataVersion`, `dataOrigins`, and `forkedFrom` (source project ID and exact commit, or null). Inaccessible projects return 404; authenticated readers attempting writes return 403. Mutations require a valid original session throughout preparation.

`GET /templates` returns `{ templates: [{ id, title, description, entrypoint, license }] }`. Model templates (`commons`, `worker`, `python`, `marimo`, `netlogo`) and library templates (`library-js`, `library-python`) contain ordinary files and require no Lab model SDK.

`POST /projects` accepts `{ requestId, templateId, title, visibility, description? }`. Request IDs are UUIDs. Title is trimmed and limited to 120 characters; description is limited to 4000 characters and defaults to the template description. Visibility is `public` or `private`. Response is `{ project, ref: "refs/heads/main", commit }`: 201 for creation and 200 for a completed replay. Keep the same request ID when retrying an uncertain creation; a different payload under that ID returns 409 `request_id_reused`.

For `templateId: "netlogo"`, optional `netlogoFile: { name, content }` imports a native model instead of the starter. `name` is a valid relative source path ending in `.nlogo` or `.nlogox`; `content` is nonempty UTF-8 text without NUL, up to 2,000,000 bytes. The supplied file becomes the entrypoint, and source bytes (including BOM/line endings) are retained. Imported license metadata is `Unspecified`; imports are not relabeled MIT. Syntax errors do not prevent import: users can repair them in the source editor. Other templates reject this field. Git pushes, drafts, version saves, forks and launch endpoints work unchanged for native models.

`POST /projects/:id/forks` accepts `{ requestId, commit, title, visibility }`. The full commit SHA must identify a readable commit in the source repository. Each new request ID creates an independent repository, including multiple experiments by the same author. Its main branch points to that exact commit, without a copy commit or unrelated refs. Current scientific metadata is copied once; derivation is retained separately; data origins start empty. A private source requires a private fork (`400 private_fork`). Completed retries return the original fork commit and the current authorized target project without resetting source or metadata.

Creation/forking uses a durable reserved identity and private prepared Git objects. Provider repositories start private and are populated with an atomic expected-absent main update. Public targets become public only after the complete initial commit is confirmed. Pending projects stay out of listings. Recoverable failures resume the reserved identity and refuse changed provider IDs or unexpected main content (`409 provision_conflict`). If repository creation succeeded but its provider ID could not be recorded, retry returns `409 provision_identity_unknown` when the reserved name exists. An operator must resolve that identity explicitly; Lab never adopts or overwrites a repository based on name alone. There is no automatic deletion of partial repositories.

`POST /projects/:id/restores` accepts `{ ref, expectedCommit, sourceCommit }` and returns `{ ref, commit }` with 201. It requires a human session with current write access. Both exact commits must be readable from that project. The new commit uses the source version's complete Git tree (including binary files) and the expected current commit as its sole parent, then uses the same head lease and permission recheck as ordinary saves. It never rewinds history or changes project metadata/access. Identical trees return `422 no_changes`; concurrent head changes return `409 stale_head`.

The browser presents ordinary commits as **Save**, generating a short file-based message when its optional change note is empty. Native clients still supply the existing commit request format.

`POST /projects/:id/commits` accepts `{ ref, expectedCommit, message, changes }`. Ref is a literal full `refs/heads/...` name, at most 200 characters. The full expected SHA becomes the new commit's sole parent. Changes are one to 100 distinct, nonoverlapping paths: `{ operation: "create" | "update", path, content }` or `{ operation: "delete", path }`. Create requires absence; update/delete require an ordinary file. Unchanged content returns 422 `no_changes`. Existing executable modes and untouched binary files are preserved. Message is nonblank and at most 2000 characters. Text must be well-formed UTF-8 without NUL; each changed file is at most 2 MB, the batch at most 5 MB, and encoded JSON at most 12 MB. Paths reject traversal, controls, backslashes and `.git` components. Binary editing remains available through ordinary Git.

A successful save returns `{ ref, commit }` with status 201. Git plumbing creates the tree/commit without checkout, hooks, filters, submodules or model execution. One-ref push uses an explicit expected-SHA lease and checks its porcelain result. A stale branch (including rewind/deletion) returns 409 `stale_head` with `ref`, `expectedCommit`, and `currentCommit` (null if absent). That diagnostic SHA may move again. Preserve edited buffers; inspect/reload before another save. An already-applied `=` result is also a conflict. A timeout/unknown transport result returns 502 `save_outcome_unknown`; do not assume rollback or blindly retry. SHA comparison cannot detect movement away and back to the same SHA.

`PATCH /projects/:id` accepts `{ expectedMetadataVersion, title?, description?, license?, entrypoint?, dataOrigins? }`; at least one field must change. Owner/admin only. It returns `{ project }`, increments the metadata version once, and rejects stale versions with 409 `stale_metadata` plus `currentMetadataVersion`. An unchanged patch returns 422 `no_changes`. License is nonblank and at most 100 characters. Entrypoint is an ordinary relative path at most 500 characters; an absent entrypoint at a selected commit remains a launch error. Visibility changes are not accepted here.

`dataOrigins` stores at most 16 distinct canonical HTTP(S) origins and rejects credentials, paths/query/fragment, protected application/provider/runtime hosts, loopback and local aliases. Allowed origins expand only the launched snapshot’s `connect-src` policy. Removing an origin revokes existing project previews; existing previews retain their original policy when an origin is added. Destination servers must also allow CORS.

## Errors

Failures use `{ "error": { "code": "…", "message": "…" } }`. Messages are safe display text; callers should branch on status/code.

| Status | Code                                                         | Meaning                                                            |
| ------ | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| 400    | `invalid_ref`, `invalid_ref_kind`                            | Malformed or unsupported ref/kind                                  |
| 400    | `invalid_commit`, `invalid_source`                           | Missing/malformed exact SHA or file path                           |
| 400    | `invalid_pagination`                                         | Invalid page or limit                                              |
| 401    | `unauthorized`                                               | Sign-in required to launch                                         |
| 403    | `invalid_host`, `invalid_origin`, `invalid_request`          | Host/origin/request protections rejected the request               |
| 404    | `not_found`                                                  | Inaccessible/missing project, repository, revision or file         |
| 409    | `empty_repository`                                           | Repository has no commits                                          |
| 413    | `diff_too_large`, `tree_too_large`, `too_large`              | Diff, tree or launch exceeds the supported bound                   |
| 422    | `unsupported_file`, `unsupported_diff`, `missing_entrypoint` | Unsupported source representation or missing launch entrypoint     |
| 502    | `upstream_error`                                             | Forgejo credentials, connection, timeout or other upstream failure |

Upstream failures never become empty successful histories or patches. Missing files/exact commits return 404; actual absent Git heads/tags return 409. Ref and committed source reads do not trust Forgejo's stale initial-push empty flag.

## Group and project access

These routes require a human session. `GET /groups` lists owned groups and settled memberships. `GET /groups/:id` returns confirmed members and synchronization status. `GET /groups/:id/candidates` is group-owner only and lists existing Lab users excluding that owner. `PUT /groups/:id/members` replaces at most 32 distinct existing non-owner members with `{ requestId, expectedVersion, members: [{ userId, permission: "read" | "write" }] }`.

Project owners use `GET /projects/:id/access` and `PUT /projects/:id/access` with `{ requestId, expectedVersion, visibility, groupId, confirmPublic? }`. `groupId` is a settled group the owner belongs to, or `null`. Private-to-public requires `confirmPublic: true`; this exposes the full Git history. Group ownership contributes write rights but does not confer project administration. A settled no-op returns current state without a version change.

Acceptance increments versions once, persists the exact intent/provider identities, blocks non-owner Lab reads and all new project writes/forks/launches, and revokes existing project previews. Responses show historical `effective` policy with `owner_read_only`, desired policy and unconfirmed IDs while pending. Direct Git revocation remains pending until Forgejo confirms it. Mutations return 202 pending or 200 settled; GET status uses 200. Replay the same UUID/body to retry accepted reconciliation before stale-version checks. Changed reuse returns 409 `request_id_reused`; a new stale request returns `stale_access` with `currentVersion`; an overlapping operation returns `access_busy` with `operationId`.

Reconciliation continues after logout or startup, applies removals/downgrades/private visibility across affected repositories before additions/publicization, and activates Lab policy only after complete provider verification. It never substitutes changed repository/user identities or silently takes over unrelated provider grants. Pending messages report these boundaries. Startup makes one bounded reconciliation pass; unresolved operations remain pending for explicit replay.

After reload, owners can use the pending `operationId` from GET in `POST /groups/:id/retry` or `POST /projects/:id/access/retry` with only `{ operationId }`. A fresh owner session resumes that exact intent, without a new policy or version. A project owner can resume a group-origin operation through their project but sees only its project response. Non-owners receive 404; bearers are denied. Missing, different or completed operations return 409 `stale_access_operation`; malformed IDs/extra fields return 400. Responses remain 202 pending or 200 settled.

Bootstrap adds Dee and one new private research-group model (Ada owner, Ben writer, Cy reader). It preserves existing IDs/passwords/source and records setup progress. Completed setup never restores deliberately changed memberships on restart. Unknown initial repository creation fails explicitly for provider-ID recovery instead of adopting a replacement.

## Verification

With isolated native services stopped, `LAB_INSTANCE=test-api node e2e/access-groups.mjs` verifies actual writer/reader/unrelated HTTP and Git rights, role downgrade during a provider outage, preview denial, accepted reconciliation after logout/restart, replay/versioning, bootstrap role persistence and public/private/detach transitions. It starts/stops its own API/runtime, restores its deliberate group-role changes and keeps its uniquely named private project fixtures for inspection. Only the selected test Forgejo is stopped/restarted; existing storage is retained.

With the isolated test instance bootstrapped and native services stopped, `LAB_INSTANCE=test-api npx playwright test e2e/authoring-api.spec.ts e2e/authoring-git.spec.ts` exercises real HTTP/Git create/replay, multifile saves, exact forks, metadata CAS and Git lease races. `LAB_INSTANCE=test-api node e2e/authoring-recovery.mjs` starts its own native API and kills it at real creation/push/finalization boundaries, then checks durable recovery. The interrupt preload is test-only and never loaded by ordinary startup. Tests preserve existing instance data and create/remove their own UUID fixture repositories.

`LAB_INSTANCE=test-api LAB_PORT_BASE=5910 npm run test:e2e -- source-history.spec.ts` runs isolated HTTP/Git workflows: real pushes, qualified slash refs and annotated tags, exact source bytes, paginated merge history while the branch advances, root/merge/empty diffs against ordinary Git, private access denial, malformed input, binary assets, oversized diffs and upstream failure recovery. It creates and removes its own fixture repository and Lab row. The failure scenario briefly stops only that test instance's Forgejo and restores its test credential file in `finally`; never run it against development/shared state.

With that isolated instance bootstrapped and its native services stopped, run `LAB_INSTANCE=test-api node e2e/launch-session.mjs` for deterministic session interleavings. The script holds a real private Forgejo file response, invalidates the original session by logout, expiry, or replacement, then releases the response and requires 401. Each scenario also checks that a valid session can launch and that logout revokes its preview. The script refuses non-test instances and running API services; it starts and stops only its own native API/runtime processes, preserves Forgejo, and cleans its sessions and temporary gate files. The fetch-delay preload is test-only and is never used by normal startup.

## Libraries

Projects expose `kind: "model" | "library"`, and separate `extractedFrom` and
`forkedFrom` ancestry. Existing projects default to models. Templates include
`library-python` and `library-js`; libraries may have an empty entrypoint.

`POST /projects/:id/extractions` takes `{requestId, commit, title, visibility,
paths}` and returns the ordinary create response. The selected files are copied
from an exact saved commit into a new library repository. The source stays
unchanged. Private source requires private output. Retry incomplete provisioning
with the same request ID and request body.

`GET /projects/:id/libraries?commit=<revision>` reads dependencies from that Git
snapshot. The response is `{commit, libraries}`; entries contain `projectId`,
`commit`, `directory`, `files`, permission-filtered `project` (or null), `modified`,
and recursive `children`. Children come from vendored nested manifests in the
consumer snapshot; their paths are relative to their containing library root.

`POST /projects/:id/libraries` takes `{ref, expectedCommit, libraryId, commit,
directory, paths, message}`. `DELETE /projects/:id/libraries` takes `{ref,
expectedCommit, directory, message}`. Both return the ordinary commit response
and write one real Git commit using the expected-head lease. Reusing a directory
for the same library explicitly updates its pin; modified recorded files reject
update/removal. Identical unrecorded files can be adopted; differing files and
other path collisions reject installation. Private libraries require private
destinations. These mutations require a human session.

Dependencies are ordinary retained UTF-8 files plus versioned `lab.lock.json`:
`{version:1,libraries:[{projectId,commit,directory,files:[{source,path,sha256}]}]}`.
The full destination `path` equals `directory + "/" + source`. Installing a
library includes its declared dependency files and nested manifests from its
exact revision, preserving imports. It never resolves or fetches a newer child
revision. Hierarchies are bounded to eight levels and 64 dependency entries;
installations support at most 90 files and 4 MB total content. Extraction supports
90 files and 5 MB total. Malformed manifests and missing/changed upstream
vendored bytes require repair before installation. Removing upstream access does
not erase committed copies; upstream identity becomes unavailable to readers.

## Persistent browser drafts

A draft is private to the authenticated person and project. Their sessions and scoped write-capable agents share it; other collaborators have independent drafts. It is stored in SQLite, separate from Git. Existing Git clone/push and `/commits` remain available for local development.

| Route | Body | Result |
| --- | --- | --- |
| `GET /projects/:id/draft` | — | `{ draft: Draft \| null }` |
| `PUT /projects/:id/draft` | `{ expectedVersion, ref, baseCommit, changes }` | `{ draft }` |
| `DELETE /projects/:id/draft` | `{ expectedVersion }` | `{ draft }` with an empty overlay |
| `POST /projects/:id/draft/save` | `{ expectedVersion, message? }` | `{ ref, commit, draft }` |

`Draft` contains `ref`, `baseCommit`, `version`, `changes`, `updatedAt` (milliseconds), and `savingCommit` (null or a pending commit SHA). The first write uses `expectedVersion: 0`; subsequent writes use the acknowledged version. PUT replaces the **whole overlay**, including additions and deletions, not just the most recent edited file. Empty changes are valid. Existing text/path/count/size limits apply. All draft routes require current write permission.

Every write checks the draft version. `409 stale_draft` means another editor updated it; retain local edits and reload/reconcile explicitly. A caller may deliberately change the base/ref while replacing the overlay, using the same version check. This never automatically merges changes. An external Git push leaves a nonempty draft and its original base intact. Saving that draft returns `409 stale_head` until the user reconciles it or discards it in favor of the latest files.

Save version commits exactly the acknowledged draft, advances its base and clears its overlay. Later typing is autosaved against the resulting version. `409 draft_busy` means a version save is underway or pending recovery. After `502 save_outcome_unknown`, retry `/draft/save` with the **same expectedVersion**. The prepared Git object and pending identity are retained across API restart so a push whose commit is still the branch head can be reconciled without a duplicate commit. If the branch has moved again, the draft is preserved and reconciliation is required. A completed save replay returns the same commit while the draft has not subsequently changed. Do not blindly create a new commit after an uncertain outcome.

Library installation/removal in the editor uses `POST`/`DELETE /projects/:id/draft/libraries`, with the ordinary library request plus `expectedVersion`. It preserves existing draft edits and returns `{ draft }`, without pushing a commit. `GET /projects/:id/libraries?draft=1` reads the authenticated person's draft dependency tree. The original `/libraries` mutation endpoints remain useful for agents operating on saved Git revisions. Fork and extraction requests always use an exact **saved** commit; save a version first to include browser changes.

The editor keeps a browser recovery copy of unacknowledged edits and offers a download when it conflicts with the server draft. Autosaving does not create draft history; Git history changes only on deliberate version saves or ordinary Git pushes.

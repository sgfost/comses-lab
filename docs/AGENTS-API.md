# Agents API

## Connect through browser approval

Start without credentials. Use this app's origin as the base URL (locally `http://localhost:5100`). This is a device-style JSON API, not a general OAuth provider.

1. Send `POST /api/agent-login` with JSON, **no cookies or Authorization**, and a descriptive name. `projects` and `allowCreate` are optional and default to no access:

   ```json
   {"name":"Research assistant","allowCreate":true,"projects":[{"projectId":"PROJECT_ID","permission":"read"}]}
   ```

   The response includes `device_code`, `user_code`, `verification_uri`, `verification_uri_complete`, `expires_in` (600 seconds), and `interval` (5 seconds).
2. Show the human `verification_uri_complete` and `user_code`. Ask them to open the link, sign in, check the matching code, and approve permissions. The human can adjust the requested scopes. **Never sign in or approve on their behalf. Never request their password or session cookie.** Keep `device_code` private; never put it in a URL, chat message, or log.
3. Poll `POST /api/agent-login/token` with `{"device_code":"PRIVATE_DEVICE_CODE"}`, again without cookies or Authorization. Wait at least `interval` seconds between requests. A successful response is `{grant,token}`. Store the token in local secure credential storage; never print it or commit it. Call `GET /api/agent` with the bearer to confirm the approved permissions.

Polling errors use `{error:{code,message},interval?}`:

| Code | Action |
| --- | --- |
| `authorization_pending` (400) | Continue polling at the given interval. |
| `slow_down` (429) | Increase the interval to the returned value; respect `Retry-After`. |
| `rate_limited` (429) | Back off according to `Retry-After`, or at least 60 seconds if absent. |
| `access_denied`, `expired_token` (400) | Stop. Start a new request only if the human wants to retry. |
| `authorization_consumed` (400) | Stop. The credential was already delivered. |
| Other errors | Stop and report the non-secret error. |

Credentials are delivered once; the server stores only their hashes. If the successful response is lost, start a new login and have the human revoke the unused grant from **Agents**. Requests expire after ten minutes, including approved requests that have not been collected. Approval does not freeze permissions: current project rights are checked again when issuing the token. Keep polling until completion or expiry; do not busy-loop or retry terminal errors.

Read access to an original model plus `allowCreate` permits forking it; the new fork gets write scope automatically. Request only what the task needs. Existing project IDs can be discovered from public project links or `GET /api/projects` before login. The human can select private projects during approval.

## Grants and credentials

Grant objects include `id`, `name`, `state`, `allowCreate`, and `projects`. The signed-in human can list and revoke grants through **Agents**, `GET /api/agent-grants`, and `DELETE /api/agent-grants/:id`. Revocation also removes the grant's runtime previews. Issue a replacement grant to change scopes.

Manual token creation remains available under **Agents → Create a token manually** or `POST /api/agent-grants` with `{name,allowCreate,projects}`. Human mutations require the `lab_session` cookie, application `Origin`, and JSON. Browser approval uses `GET /api/agent-login/requests/:userCode` and `POST` on the same route with either `{decision:"deny"}` or `{decision:"approve",name,allowCreate,projects}`. These routes require a human session; agents cannot approve requests.

Agents send `Authorization: Bearer TOKEN` and JSON for mutations. Send no session cookie. A missing `Origin` is accepted; if supplied it must equal the application origin. No user password or manually provisioned Forgejo PAT is needed. Start with `GET /api/agent` to discover your grant ID and credential endpoint; `GET /api/agent-guide` returns this guide.

Scopes intersect the owner's current project permissions on every request. Read scope permits source inspection, previews and use as a fork/extraction/library source. Write scope also permits file commits, restores, draft changes and library attachment/removal. Public projects still need an explicit scope. `allowCreate` permits creating projects, forks and extracted libraries; each new project receives write scope in the creating grant. Fork/extraction sources must already be scoped. Access/group/grant administration and project metadata updates require a human session.

## Normal Git workflow

Use the Lab bearer for discovery, creating/forking projects, extracting libraries and previews. For ordinary development, request a repository-specific Git credential with `POST /api/agent-grants/:grantId/git-credentials`:

```json
{"requestId":"UUID","projectId":"PROJECT_ID","permission":"write"}
```

The response is `{credential,token}`; `credential` includes `id`, `grantId`, `projectId`, `permission`, `username`, `url`, `state`, and `recovery`. The token is returned once and never stored by Lab. Use `credential.username` and the token through a Git credential manager or an ephemeral environment-based HTTP authorization header. Clone `credential.url`, edit files locally, commit and push normally. Keep secrets out of Git remotes, command arguments and committed files. Read credentials permit clone/fetch only; write credentials also permit push to that selected repository. Forgejo may still allow reading unselected public repositories; their writes remain denied.

An agent can mint credentials only inside its own live grant and the owner's current permissions. Human owners can also mint within their grants. `GET /api/agent-grants/:id` lists credentials without secrets; `DELETE /api/agent-grants/:id/git-credentials/:credentialId` revokes one. Request IDs are one-shot: repeats return 409 and the original credential ID/state, never a fresh token. Revoke the original before requesting a replacement with a new ID.

Grant revocation immediately disables the Lab bearer and runtime previews. Git credentials remain `revocation_pending` until Forgejo confirms deletion; revocation returns 202 if confirmation remains pending. Startup and periodic recovery retry pending deletions. An unknown provider issuance can require operator recovery; absence from one listing alone does not prove that an interrupted creation finished. Access policy changes revoke project Git credentials before completing. Obtain replacement credentials after an accepted access change.

## HTTP workflow

1. Discover templates with `GET /api/templates` and scoped projects with `GET /api/projects`. Libraries are projects with `kind: "library"`.
2. Create through `POST /api/projects` with `{requestId, templateId, title, visibility}`. Templates include `commons`, `worker`, `python`, `netlogo`, `library-python`, and `library-js`. Visibility is `public` or `private`. The response is `{project, ref, commit}`.
3. Inspect `GET /api/projects/:id/tree?ref=main`, `file?commit=SHA&path=PATH`, `refs`, `history?commit=SHA`, `diff?commit=SHA`, or `libraries?commit=SHA`.
4. Fork through `POST /api/projects/:id/forks` with `{requestId, commit, title, visibility}`. Extract files into an independent library through `POST /api/projects/:id/extractions` with the same fields plus `paths: ["module.py"]`. A private source requires a private result.
5. Commit with `POST /api/projects/:id/commits`: `{ref:"refs/heads/main", expectedCommit:SHA, message:"Update model", changes:[{operation:"update",path:"model.py",content:"..."}]}`. Operations are `create`, `update`, or `delete` (omit content for deletion). The response is `{ref, commit}`. A stale head returns 409; inspect the new source before retrying.
6. Attach/update a library with `POST /api/projects/:id/libraries`: `{ref,expectedCommit,message,libraryId,commit,paths:["module.py"],directory:"lib/module"}`. Both projects must be scoped. Remove a saved attachment with `DELETE` on the same route using `{ref,expectedCommit,message,directory}`.
7. Launch with `POST /api/projects/:id/launch` using `{commit}`; inspect or stop through `GET` or `DELETE /api/launches/:id`. Runtime preview URLs are capabilities and belong to the issuing credential.

Create/fork/extraction requests require a UUID `requestId`. Retrying the same request and credential returns the existing result; changing its input, using another grant, or switching between a grant and a human session returns 409. Revoked grants cannot retry. Retries recheck current source access and creation capability, including completed operations.

Draft endpoints require write scope: `GET`, `PUT`, and `DELETE /api/projects/:id/draft`, `POST /api/projects/:id/draft/save`, and `POST`/`DELETE /api/projects/:id/draft/libraries`. See the draft API documentation for request shapes. Saved-source authoring above works independently of drafts.

For NetLogo, use native `.nlogo` or `.nlogox` files. `templateId: "netlogo"` creates an MIT example; add `netlogoFile: {name: "model.nlogox", content: "..."}` to import your own file, preserving its text and setting its license to `Unspecified`. Files must be UTF-8 without NUL, at most 2 MB. Clone/edit/commit/push normally; retain widget/shape/Info sections when changing code. No player bundle, HTML wrapper, Lab DSL or browser automation is needed. The native entrypoint selects the shared NetLogo Web 2.15.3 player. A launch returns `runtime: "netlogo"` and `standaloneUrl` as well as the ordinary fields; URLs are private capabilities. Browser visual edits autosave to a separate Lab draft and require **Save version** before Git clients see them. Changing the project-wide entrypoint remains an owner action. See [NetLogo workflow and limits](LOCAL-DEVELOPMENT.md#netlogo-models).

Errors use `{error:{code,message,...details}}`. Preserve request IDs and expected commit hashes; do not blindly replace them after an uncertain save or provisioning outcome.

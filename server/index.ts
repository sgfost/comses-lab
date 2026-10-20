import { releaseInstance } from "./instance.ts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validateCommitRequest } from "./git.ts";
import { serve } from "@hono/node-server";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { settings } from "./config.ts";
import { RuntimeConfigurationError } from "../runtime/origin.ts";
import { db, projectsForPrincipal, projectForPrincipal, accessPending } from "./db.ts";
import {
  cookieName,
  sessionUser,
  verifyPassword,
  createSession,
  tokenHash,
  readPrincipal,
  principalLive,
  launchPrincipal,
  AuthError,
  type Principal,
} from "./auth.ts";
import {
  ForgejoError,
  SourceError,
  sourceRefs,
  sourceHistory,
  sourceDiff,
  validSourceRef,
  validCommit,
  sourceTree,
  sourceFile,
  validSourcePath,
} from "./forgejo.ts";
import {
  runtime,
  createLaunch,
  revokeLaunch,
  revokeSessionLaunches,
  launchFor,
} from "../runtime/server.ts";
import type { User } from "../shared/contracts.ts";
import { resumeAgentCredentials } from "./agent-git.ts";
import { drafts } from "./drafts.ts";
import { agentGrants } from "./agent-grants.ts";
import { agentLogin } from "./agent-login.ts";
import { libraries } from "./libraries.ts";
import { authoring, AuthoringError } from "./authoring.ts";
import { access, resumeAccessUpdates } from "./access.ts";
const app = new Hono<{ Variables: { user: User | undefined; principal: Principal | undefined } }>();
app.use("*", async (c, next) => {
  const origin = c.req.header("Origin");
  const host = c.req.header("Host");
  if (
    host !== new URL(settings.appOrigin).host &&
    host !== `127.0.0.1:${settings.apiPort}`
  )
    return c.json(
      { error: { code: "invalid_host", message: "Invalid application host" } },
      403,
    );
  if (origin && origin !== settings.appOrigin)
    return c.json(
      {
        error: {
          code: "invalid_origin",
          message: "Cross-origin requests are not allowed",
        },
      },
      403,
    );
  const principal = readPrincipal(getCookie(c, cookieName), c.req.header("Authorization"));
  const loginBootstrap = c.req.method === "POST" && ["/api/agent-login", "/api/agent-login/token"].includes(c.req.path) &&
    getCookie(c, cookieName) === undefined && c.req.header("Authorization") === undefined;
  if (principal?.kind === "agent" && !agentRoute(c.req.method, c.req.path, principal.grantId))
    return c.json({ error: { code: "forbidden", message: "This route requires a human session" } }, 403);
  if (
    !["GET", "HEAD"].includes(c.req.method) &&
    ((principal?.kind !== "agent" && !loginBootstrap && origin !== settings.appOrigin) ||
      !c.req.header("Content-Type")?.startsWith("application/json"))
  )
    return c.json(
      {
        error: {
          code: "invalid_request",
          message: "Use the application origin and JSON requests",
        },
      },
      403,
    );
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.set("principal", principal);
  c.set("user", principal?.user);
  await next();
  if (principal?.kind === "agent" && !principalLive(principal)) return c.json({ error: { code: "unauthorized", message: "Agent credential is no longer valid" } }, 401);
});
function agentRoute(method: string, path: string, grantId: string) {
  if (method === "GET" && (/^\/api\/(?:templates|libraries|agent|agent-guide)$/.test(path) || /^\/api\/projects(?:\/[^/]+(?:\/(?:tree|file|refs|history|diff|libraries|draft))?)?$/.test(path) || /^\/api\/launches\/[^/]+$/.test(path))) return true;
  if (method === "POST" && (path === "/api/projects" || /^\/api\/projects\/[^/]+\/(?:commits|restores|launch|forks|extractions|libraries|draft\/(?:save|libraries))$/.test(path))) return true;
  if (method === "PUT" && /^\/api\/projects\/[^/]+\/draft$/.test(path)) return true;
  if (method === "DELETE" && (/^\/api\/launches\/[^/]+$/.test(path) || /^\/api\/projects\/[^/]+\/(?:libraries|draft(?:\/libraries)?)$/.test(path))) return true;
  const bound = `/api/agent-grants/${grantId}`;
  return (method === "GET" && path === bound) || (method === "POST" && path === `${bound}/git-credentials`) || (method === "DELETE" && path.startsWith(`${bound}/git-credentials/`));
}
app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api", drafts);
app.route("/api", agentGrants);
app.route("/api", agentLogin);
app.route("/api", authoring);
app.route("/api", libraries);
app.route("/api", access);
app.get("/api/session", (c) => c.json({ user: c.get("user") ?? null }));
const loginAttempts = new Map<string, { count: number; until: number }>();
app.post("/api/session", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (
    !body ||
    typeof body.username !== "string" ||
    typeof body.password !== "string" ||
    body.username.length > 100 ||
    body.password.length > 256
  )
    return c.json(
      {
        error: {
          code: "invalid_login",
          message: "Enter a username and password",
        },
      },
      400,
    );
  const key = body.username;
  const attempts = loginAttempts.get(key);
  if (attempts && attempts.until > Date.now() && attempts.count >= 10)
    return c.json(
      {
        error: {
          code: "rate_limited",
          message: "Wait a minute before trying again",
        },
      },
      429,
    );
  const row = db
    .prepare(
      "SELECT id,password_hash AS passwordHash FROM users WHERE username=?",
    )
    .get(body.username) as { id: string; passwordHash: string } | undefined;
  if (!row || !verifyPassword(body.password, row.passwordHash)) {
    loginAttempts.set(key, {
      count: attempts && attempts.until > Date.now() ? attempts.count + 1 : 1,
      until: Date.now() + 60000,
    });
    return c.json(
      {
        error: {
          code: "invalid_login",
          message: "Username or password is incorrect",
        },
      },
      401,
    );
  }
  loginAttempts.delete(key);
  const old = getCookie(c, cookieName);
  if (old) {
    db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash(old));
    revokeSessionLaunches(tokenHash(old));
  }
  const token = createSession(row.id);
  setCookie(c, cookieName, token, {
    httpOnly: true,
    sameSite: "Strict",
    path: "/api",
    maxAge: 7 * 86400,
  });
  return c.json({ user: sessionUser(token) });
});
app.delete("/api/session", (c) => {
  const token = getCookie(c, cookieName);
  if (token)
    db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash(token));
  if (token) revokeSessionLaunches(tokenHash(token));
  deleteCookie(c, cookieName, { path: "/api" });
  return c.json({ ok: true });
});
app.get("/api/projects", (c) =>
  c.json({ projects: projectsForPrincipal(c.get("principal")) }),
);
app.get("/api/projects/:id", (c) => {
  const project = projectForPrincipal(c.req.param("id"), c.get("principal"));
  return project
    ? c.json({ project })
    : c.json(
        { error: { code: "not_found", message: "Project not found" } },
        404,
      );
});
app.get("/api/projects/:id/tree", async (c) => {
  const project = projectForPrincipal(c.req.param("id"), c.get("principal"));
  if (!project)
    return c.json(
      { error: { code: "not_found", message: "Project not found" } },
      404,
    );
  const ref = c.req.query("ref") ?? "main";
  if (!validSourceRef(ref))
    return c.json(
      { error: { code: "invalid_ref", message: "Invalid revision" } },
      400,
    );
  return c.json(await sourceTree(project, ref, c.get("user")));
});
app.get("/api/projects/:id/file", async (c) => {
  const project = projectForPrincipal(c.req.param("id"), c.get("principal"));
  if (!project)
    return c.json(
      { error: { code: "not_found", message: "Project not found" } },
      404,
    );
  const commit = c.req.query("commit") ?? "",
    path = c.req.query("path") ?? "";
  if (!/^[a-f0-9]{40}$/.test(commit) || !validSourcePath(path))
    return c.json(
      {
        error: {
          code: "invalid_source",
          message: "An exact commit and file path are required",
        },
      },
      400,
    );
  const file = await sourceFile(project, commit, path, c.get("user"));
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      file,
    );
    if (content.includes("\0")) throw new Error("Binary file");
  } catch {
    throw new SourceError(
      422,
      "unsupported_file",
      "The source viewer supports UTF-8 text files only",
    );
  }
  return c.json({ commit, path, content });
});
function pagination(page = "1", limit = "25") {
  if (
    !/^[1-9][0-9]*$/.test(page) ||
    !/^[1-9][0-9]*$/.test(limit) ||
    Number(page) > 1000000 ||
    Number(limit) > 50
  )
    throw new SourceError(
      400,
      "invalid_pagination",
      "Use page 1–1000000 and limit 1–50",
    );
  return { page: Number(page), limit: Number(limit) };
}
app.get("/api/projects/:id/refs", async (c) => {
  const project = projectForPrincipal(c.req.param("id"), c.get("principal"));
  if (!project)
    return c.json(
      { error: { code: "not_found", message: "Project not found" } },
      404,
    );
  const kind = c.req.query("kind") ?? "branch";
  if (kind !== "branch" && kind !== "tag")
    throw new SourceError(
      400,
      "invalid_ref_kind",
      "Choose branch or tag references",
    );
  const { page, limit } = pagination(c.req.query("page"), c.req.query("limit"));
  return c.json(await sourceRefs(project, kind, page, limit, c.get("user")));
});
app.get("/api/projects/:id/history", async (c) => {
  const project = projectForPrincipal(c.req.param("id"), c.get("principal"));
  if (!project)
    return c.json(
      { error: { code: "not_found", message: "Project not found" } },
      404,
    );
  const commit = c.req.query("commit") ?? "";
  if (!validCommit(commit))
    throw new SourceError(
      400,
      "invalid_commit",
      "History requires an exact commit",
    );
  const { page, limit } = pagination(c.req.query("page"), c.req.query("limit"));
  return c.json(
    await sourceHistory(project, commit, page, limit, c.get("user")),
  );
});
app.get("/api/projects/:id/diff", async (c) => {
  const project = projectForPrincipal(c.req.param("id"), c.get("principal"));
  if (!project)
    return c.json(
      { error: { code: "not_found", message: "Project not found" } },
      404,
    );
  const commit = c.req.query("commit") ?? "";
  if (!validCommit(commit))
    throw new SourceError(
      400,
      "invalid_commit",
      "Diff requires an exact commit",
    );
  return c.json(await sourceDiff(project, commit, c.get("user")));
});
app.post("/api/projects/:id/launch", bodyLimit({ maxSize: 12_000_000 }), async (c) => {
  const principal = c.get("principal");
  const user = c.get("user");
  if (!user)
    return c.json(
      { error: { code: "unauthorized", message: "Sign in to launch a model" } },
      401,
    );
  const project = projectForPrincipal(c.req.param("id"), principal);
  if (!project)
    return c.json(
      { error: { code: "not_found", message: "Project not found" } },
      404,
    );
  if (accessPending(project.id)) return c.json({ error: { code: "access_pending", message: "Project access is being reconciled" } }, 409);
  const body = await c.req.json().catch(() => null);
  if (typeof body?.commit !== "string" || !/^[a-f0-9]{40}$/.test(body.commit))
    return c.json(
      {
        error: {
          code: "invalid_commit",
          message: "Launch requires an exact commit",
        },
      },
      400,
    );
  if (body.edit !== undefined && typeof body.edit !== "boolean")
    return c.json({ error: { code: "invalid_edit", message: "Notebook edit must be a boolean" } }, 400);
  const entrypoint = body.entrypoint ?? project.entrypoint;
  if (typeof entrypoint !== 'string' || (entrypoint !== project.entrypoint && !/\.py$/i.test(entrypoint)))
    return c.json({ error: { code: 'invalid_entrypoint', message: 'Choose a project notebook' } }, 400);
  if (body.edit && project.permission === 'read') return c.json({ error: { code: 'forbidden', message: 'Editing permission is required' } }, 403);
  // Draft previews use the same path, UTF-8 and size rules as file commits.
  const changes = body.changes === undefined ? [] : validateCommitRequest({
    ref: "refs/heads/main", expectedCommit: body.commit, message: "Draft preview", changes: body.changes,
  }).changes;
  if (changes.length && project.permission === "read") return c.json({ error: { code: "forbidden", message: "Editing permission is required for draft previews" } }, 403);
  const tree = await sourceTree(project, body.commit, user);
  if (tree.commit !== body.commit)
    throw new SourceError(
      400,
      "invalid_commit",
      "Use the resolved commit SHA, not a tag object",
    );
  if (
    tree.files.length > 100 ||
    tree.files.reduce((n, f) => n + f.size, 0) > 5_000_000
  )
    return c.json(
      {
        error: {
          code: "too_large",
          message: "Preview supports at most 100 files and 5 MB",
        },
      },
      413,
    );
  const files = new Map<string, Buffer>();
  for (const file of tree.files)
    files.set(
      file.path,
      await sourceFile(project, tree.commit, file.path, user),
    );
  for (const change of changes) {
    if (change.operation === "create" ? files.has(change.path) : !files.has(change.path))
      throw new SourceError(400, "invalid_preview_changes", "Create requires a new path; update/delete requires an existing file");
    if (change.operation === "create" && [...files.keys()].some(path => path.startsWith(`${change.path}/`) || change.path.startsWith(`${path}/`)))
      throw new SourceError(400, "invalid_preview_changes", "Draft file paths overlap existing files");
    if (change.operation === "delete") files.delete(change.path);
    else files.set(change.path, Buffer.from(change.content, "utf8"));
  }
  if (files.size > 100 || [...files.values()].reduce((size, bytes) => size + bytes.length, 0) > 5_000_000)
    return c.json({ error: { code: "too_large", message: "Preview supports at most 100 files and 5 MB" } }, 413);
  if (!files.has(entrypoint))
    return c.json(
      {
        error: {
          code: "missing_entrypoint",
          message: "The configured entrypoint is missing",
        },
      },
      422,
    );
  // Logout, expiry, or replacement may revoke this session during source loading.
  // Keep this check and capability creation synchronous with no intervening await.
  if (!principal || !principalLive(principal))
    return c.json(
      {
        error: {
          code: "unauthorized",
          message: "Sign in again to launch a model",
        },
      },
      401,
    );
  const current = projectForPrincipal(project.id, principal);
  if (!current) return c.json({ error: { code: "not_found", message: "Project not found" } }, 404);
  if (accessPending(project.id)) return c.json({ error: { code: "access_pending", message: "Project access is being reconciled" } }, 409);
  if (changes.length && current.permission === "read") return c.json({ error: { code: "forbidden", message: "Editing permission is required for draft previews" } }, 403);
  if (!files.has(body.entrypoint ?? current.entrypoint)) return c.json({ error: { code: "missing_entrypoint", message: "The configured entrypoint is missing" } }, 422);
  return c.json({ ...createLaunch({ projectId: current.id, commit: tree.commit, entrypoint: body.entrypoint ?? current.entrypoint, edit: body.edit === true && current.permission !== "read", files, principal: launchPrincipal(principal), dataOrigins: current.dataOrigins }), ...(changes.length ? { draft: true } : {}) });
});
app.get("/api/launches/:id", (c) => {
  const principal = c.get("principal");
  if (!principal) return c.json({ error: { code: "unauthorized", message: "Authentication is required" } }, 401);
  const launch = launchFor(c.req.param("id"), launchPrincipal(principal));
  if (!launch || !projectForPrincipal(launch.projectId, principal) || accessPending(launch.projectId)) return c.json({ error: { code: "not_found", message: "Launch not found" } }, 404);
  return c.json({ id: c.req.param("id"), state: "active", expiresAt: launch.expiresAt });
});
app.delete("/api/launches/:id", (c) => {
  const principal = c.get("principal");
  if (!principal) return c.json({ error: { code: "unauthorized", message: "Authentication is required" } }, 401);
  const launch = launchFor(c.req.param("id"), launchPrincipal(principal));
  if (!launch || !projectForPrincipal(launch.projectId, principal) || accessPending(launch.projectId)) return c.json({ error: { code: "not_found", message: "Launch not found" } }, 404);
  revokeLaunch(c.req.param("id"), launchPrincipal(principal));
  return c.json({ ok: true });
});
app.onError((error, c) => {
  if (error instanceof RuntimeConfigurationError) return c.json({ error: { code: "runtime_configuration", message: error.message } }, 503);
  if (error instanceof AuthError) return c.json({ error: { code: error.code, message: error.message } }, 401);
  if (error instanceof AuthoringError) return c.json({ error: { code: error.code, message: error.message, ...error.details } }, error.status);
  if (error instanceof SourceError)
    return c.json(
      { error: { code: error.code, message: error.message } },
      error.status,
    );
  if (error instanceof ForgejoError && error.status === 404)
    return c.json(
      {
        error: {
          code: "not_found",
          message: "Source not found at this revision",
        },
      },
      404,
    );
  console.error(error.message);
  return c.json(
    {
      error: {
        code: "upstream_error",
        message: "Could not load repository data. Check Forgejo and retry.",
      },
    },
    502,
  );
});
const apiServer = serve({
  fetch: app.fetch,
  hostname: "127.0.0.1",
  port: settings.apiPort,
});
const runtimeServer = serve({
  fetch: runtime.fetch,
  hostname: "127.0.0.1",
  port: settings.runtimePort,
});
let credentialRecoveryRunning = false;
async function recoverAgentCredentials() {
  if (credentialRecoveryRunning) return;
  credentialRecoveryRunning = true;
  try { await resumeAgentCredentials(); } catch { console.error("Agent credential recovery remains pending"); }
  finally { credentialRecoveryRunning = false; }
}
void recoverAgentCredentials();
const credentialRecovery = setInterval(() => { void recoverAgentCredentials(); }, 15000);
credentialRecovery.unref();
void resumeAccessUpdates().catch(() => console.error("Access reconciliation remains pending"));
console.log(
  `Lab API 127.0.0.1:${settings.apiPort}; credential-free runtime ${settings.runtimeOrigin}`,
);
function close() {
  apiServer.close();
  runtimeServer.close();
  db.close();
  releaseInstance();
  process.exit(0);
}
process.on("SIGTERM", close);
process.on("SIGINT", close);

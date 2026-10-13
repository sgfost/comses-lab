import { bodyLimit } from "hono/body-limit";
import { readFileSync } from "node:fs";
import { settings } from "./config.ts";
import { Hono, type Context } from "hono";
import { randomBytes, randomUUID } from "node:crypto";
import { db, projectById } from "./db.ts";
import { tokenHash, readPrincipal, cookieName, type Principal } from "./auth.ts";
import { getCookie } from "hono/cookie";
import { AuthoringError } from "./authoring.ts";
import { issueGitCredential, gitCredentials, revokeGitCredential, revokeAgentGrant } from "./agent-git.ts";
import type { User, CreateGrantRequest, Grant, GrantProject } from "../shared/contracts.ts";

type Variables = { user: User | undefined; principal: Principal | undefined };
type ApiContext = Context<{ Variables: Variables }>;
export const agentGrants = new Hono<{ Variables: Variables }>();
agentGrants.use("/agent-grants", bodyLimit({ maxSize: 100000, onError: c => c.json({ error: { code: "request_too_large", message: "Grant request exceeds 100 KB" } }, 413) }));
agentGrants.use("/agent-grants/*", bodyLimit({ maxSize: 100000, onError: c => c.json({ error: { code: "request_too_large", message: "Grant request exceeds 100 KB" } }, 413) }));
agentGrants.get("/agent-guide", c => c.text(readFileSync(new URL("../docs/AGENTS-API.md", import.meta.url), "utf8")));
agentGrants.get("/agent", c => {
  const principal = readPrincipal(getCookie(c, cookieName), c.req.header("Authorization"));
  if (!principal) throw new AuthoringError(401, "unauthorized", "Authentication is required");
  return c.json({ user: principal.user, grant: principal.kind === "agent" ? grant(principal.grantId, principal.user.id) : null,
    gitCredentialEndpoint: principal.kind === "agent" ? `${settings.appOrigin}/api/agent-grants/${principal.grantId}/git-credentials` : null,
    guideURL: `${settings.appOrigin}/api/agent-guide` });
});
export function human(c: ApiContext) {
  const principal = readPrincipal(getCookie(c, cookieName), c.req.header("Authorization"));
  if (!principal) throw new AuthoringError(401, "sign_in_required", "Sign in to manage agent grants");
  if (principal.kind !== "session") throw new AuthoringError(403, "forbidden", "Agent grants require a human session");
  return principal.user;
}
function grant(id: string, ownerId: string): Grant {
  const row = db.prepare("SELECT id,name,state,allow_create AS allowCreate FROM agent_grants WHERE id=? AND owner_id=?").get(id, ownerId) as { id: string; name: string; state: Grant["state"]; allowCreate: number } | undefined;
  if (!row) throw new AuthoringError(404, "not_found", "Agent grant not found");
  const projects = db.prepare("SELECT project_id AS projectId,permission FROM agent_project_scopes WHERE grant_id=? ORDER BY project_id").all(id) as unknown as GrantProject[];
  return { ...row, allowCreate: !!row.allowCreate, projects };
}
agentGrants.get("/agent-grants", (c) => {
  const user = human(c);
  const rows = db.prepare("SELECT id FROM agent_grants WHERE owner_id=? ORDER BY name,id").all(user.id) as { id: string }[];
  return c.json({ grants: rows.map(({ id }) => grant(id, user.id)) });
});
agentGrants.get("/agent-grants/:id", (c) => {
  const principal = readPrincipal(getCookie(c, cookieName), c.req.header("Authorization"));
  if (!principal) throw new AuthoringError(401, "sign_in_required", "Sign in to inspect agent grants");
  if (principal.kind === "agent" && principal.grantId !== c.req.param("id")) throw new AuthoringError(404, "not_found", "Agent grant not found");
  return c.json({ grant: grant(c.req.param("id"), principal.user.id), credentials: gitCredentials(c.req.param("id")) });
});
export function validateGrantRequest(value: any): CreateGrantRequest {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["name", "allowCreate", "projects"].includes(key)) ||
    typeof value.name !== "string" || !value.name.trim() || value.name.length > 120 || value.name.includes("\0") ||
    (value.allowCreate !== undefined && typeof value.allowCreate !== "boolean") || !Array.isArray(value.projects) || value.projects.length > 100)
    throw new AuthoringError(400, "invalid_grant", "Use a name, optional allowCreate boolean and at most 100 project scopes");
  const ids = new Set<string>();
  for (const scope of value.projects) {
    if (!scope || typeof scope !== "object" || Array.isArray(scope) || Object.keys(scope).some(key => !["projectId", "permission"].includes(key)) ||
      typeof scope.projectId !== "string" || !["read", "write"].includes(scope.permission) || ids.has(scope.projectId))
      throw new AuthoringError(400, "invalid_grant", "Use distinct project IDs with read or write permission");
    ids.add(scope.projectId);
  }
  return value as CreateGrantRequest;
}
export function validateGrantAccess(user: User, value: CreateGrantRequest) {
  for (const scope of value.projects) {
    const project = projectById(scope.projectId, user);
    if (!project || (scope.permission === "write" && project.permission === "read")) throw new AuthoringError(403, "forbidden", "You cannot grant access beyond your current project permissions");
  }
}
// Call inside the same transaction as the operation authorizing this grant.
export function insertGrant(user: User, value: CreateGrantRequest) {
  validateGrantAccess(user, value);
  const id = randomUUID(), token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO agent_grants(id,owner_id,name,token_hash,state,allow_create) VALUES (?,?,?,?,?,?)").run(id, user.id, value.name.trim(), tokenHash(token), "active", value.allowCreate ? 1 : 0);
  for (const scope of value.projects) db.prepare("INSERT INTO agent_project_scopes(grant_id,project_id,permission) VALUES (?,?,?)").run(id, scope.projectId, scope.permission);
  return { grant: grant(id, user.id), token };
}
agentGrants.post("/agent-grants", async (c) => {
  const initial = human(c);
  const value = validateGrantRequest(await c.req.json().catch(() => null));
  const user = human(c);
  if (user.id !== initial.id) throw new AuthoringError(401, "session_changed", "The original session is no longer valid");
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = insertGrant(user, value);
    db.exec("COMMIT");
    return c.json(result, 201);
  } catch (error) { db.exec("ROLLBACK"); throw error; }
});
agentGrants.delete("/agent-grants/:id", async (c) => {
  const user = human(c), id = c.req.param("id");
  grant(id, user.id);
  await revokeAgentGrant(id);
  const result = grant(id, user.id);
  return c.json({ grant: result }, result.state === "revoked" ? 200 : 202);
});

function credentialPrincipal(c: ApiContext) {
  const principal = readPrincipal(getCookie(c, cookieName), c.req.header("Authorization"));
  if (!principal) throw new AuthoringError(401, "unauthorized", "Authentication is required");
  const id = c.req.param("id")!;
  if (principal.kind === "agent" && principal.grantId !== id) throw new AuthoringError(404, "not_found", "Agent grant not found");
  grant(id, principal.user.id);
  return principal;
}
agentGrants.post("/agent-grants/:id/git-credentials", async c => {
  const principal = credentialPrincipal(c);
  const value = await c.req.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthoringError(400, "invalid_git_credential", "Use a JSON object");
  return c.json(await issueGitCredential(principal, c.req.param("id"), value), 201);
});
agentGrants.delete("/agent-grants/:id/git-credentials/:credentialId", async c => {
  credentialPrincipal(c);
  const id = c.req.param("credentialId"), grantId = c.req.param("id");
  if (!db.prepare("SELECT 1 FROM agent_git_credentials WHERE id=? AND grant_id=?").get(id, grantId)) throw new AuthoringError(404, "not_found", "Git credential not found");
  const confirmed = await revokeGitCredential(id);
  return c.json({ credential: gitCredentials(grantId).find(item => item.id === id) }, confirmed ? 200 : 202);
});

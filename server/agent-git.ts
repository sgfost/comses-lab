import { randomUUID, createHash } from "node:crypto";
import { db, projectForPrincipal, accessPending } from "./db.ts";
import { principalLive, type Principal } from "./auth.ts";
import { AuthoringError } from "./authoring.ts";
import { actor, forgejo, ForgejoError, repositoryUrl, providerUser, accessRepository } from "./forgejo.ts";
import { revokeGrantLaunches } from "../runtime/server.ts";
import type { User } from "../shared/contracts.ts";

type Credential = { id: string; grant_id: string; project_id: string; request_hash: string; permission: "read" | "write"; provider_user_id: number; provider_username: string; provider_repo_id: number; provider_owner: string; provider_repo: string; reserved_name: string; dispatched: number; state: string; operator_required: number };
type ProviderToken = { id: number; name: string; sha1?: string };
const issuing = new Set<string>();
const revoking = new Map<string, Promise<boolean>>();
function owner(row: Credential): User {
  return db.prepare("SELECT u.id,u.username,u.display_name AS displayName FROM users u JOIN agent_grants g ON g.owner_id=u.id WHERE g.id=?").get(row.grant_id) as unknown as User;
}
export function gitCredentials(grantId: string) {
  return (db.prepare("SELECT * FROM agent_git_credentials WHERE grant_id=? ORDER BY rowid").all(grantId) as Credential[]).map(row => ({ id: row.id, grantId, projectId: row.project_id, permission: row.permission, username: row.provider_username, url: repositoryUrl(row.provider_owner, row.provider_repo), state: row.state, recovery: row.operator_required ? "operator_required" : "none" }));
}
function allowed(principal: Principal, grantId: string, projectId: string, permission: string) {
  if (!principalLive(principal)) throw new AuthoringError(401, "unauthorized", "Credential is no longer valid");
  const grant = db.prepare("SELECT 1 FROM agent_grants WHERE id=? AND owner_id=? AND state='active'").get(grantId, principal.user.id);
  if (!grant || (principal.kind === "agent" && principal.grantId !== grantId)) throw new AuthoringError(404, "not_found", "Agent grant not found");
  const scope = db.prepare("SELECT permission FROM agent_project_scopes WHERE grant_id=? AND project_id=?").get(grantId, projectId) as { permission: string } | undefined;
  const project = projectForPrincipal(projectId, principal);
  if (!scope || !project || (permission === "write" && (scope.permission !== "write" || project.permission === "read"))) throw new AuthoringError(403, "forbidden", "Git credential exceeds current grant or project permissions");
  if (accessPending(projectId)) throw new AuthoringError(409, "access_pending", "Project access is being reconciled");
  return project;
}
export async function issueGitCredential(principal: Principal, grantId: string, value: Record<string, unknown>) {
  if (Object.keys(value).some(key => !["projectId", "permission", "requestId"].includes(key)) || typeof value.projectId !== "string" ||
    (value.permission !== "read" && value.permission !== "write") || typeof value.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestId))
    throw new AuthoringError(400, "invalid_git_credential", "Use projectId, read/write permission and a UUID requestId");
  const project = allowed(principal, grantId, value.projectId, value.permission);
  const hash = createHash("sha256").update(JSON.stringify([value.projectId, value.permission])).digest("hex"), requestId = value.requestId.toLowerCase();
  const previous = db.prepare("SELECT * FROM agent_git_credentials WHERE grant_id=? AND request_id=?").get(grantId, requestId) as Credential | undefined;
  if (previous) throw new AuthoringError(409, previous.request_hash === hash ? "credential_already_issued" : "request_id_reused", "This Git credential request was already accepted; inspect its state and revoke it before requesting a replacement", { credentialId: previous.id, state: previous.state });
  const id = randomUUID(), name = `lab-agent-${id}`;
  const providerId = (db.prepare("SELECT forgejo_id FROM users WHERE id=?").get(principal.user.id) as { forgejo_id: number }).forgejo_id;
  db.prepare("INSERT INTO agent_git_credentials(id,grant_id,project_id,request_id,request_hash,permission,provider_user_id,provider_username,provider_repo_id,provider_owner,provider_repo,reserved_name,state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, grantId, project.id, requestId, hash, value.permission, providerId, principal.user.username, project.forgejoId, project.forgejoOwner, project.forgejoRepo, name, "issuing");
  issuing.add(id);
  try {
    if ((await providerUser(principal.user.username, principal.user)).id !== providerId || (await accessRepository(project.forgejoOwner, project.forgejoRepo, principal.user)).id !== project.forgejoId)
      throw new AuthoringError(409, "provider_identity_changed", "Provider identity changed");
    allowed(principal, grantId, project.id, value.permission);
    db.prepare("UPDATE agent_git_credentials SET dispatched=1 WHERE id=?").run(id);
    const token = await forgejo<ProviderToken>(`/users/${encodeURIComponent(principal.user.username)}/tokens`, actor(principal.user), { method: "POST", body: JSON.stringify({ name, scopes: [`${value.permission}:repository`], repositories: [{ owner: project.forgejoOwner, name: project.forgejoRepo }] }) });
    if (!Number.isSafeInteger(token.id) || token.name !== name || typeof token.sha1 !== "string") throw new Error("Unexpected provider token response");
    db.prepare("INSERT OR IGNORE INTO agent_credential_token_ids(credential_id,provider_token_id) VALUES (?,?)").run(id, token.id);
    allowed(principal, grantId, project.id, value.permission);
    const row = db.prepare("SELECT state FROM agent_git_credentials WHERE id=?").get(id) as { state: string };
    if (row.state !== "issuing") throw new AuthoringError(409, "credential_revoked", "Git credential was revoked during issuance");
    db.prepare("UPDATE agent_git_credentials SET state='active' WHERE id=?").run(id);
    return { credential: gitCredentials(grantId).find(item => item.id === id)!, token: token.sha1 };
  } catch (error) {
    const row = db.prepare("SELECT dispatched FROM agent_git_credentials WHERE id=?").get(id) as { dispatched: number };
    if (!row.dispatched || (error instanceof ForgejoError && error.status >= 400 && error.status < 500)) {
      db.prepare("UPDATE agent_git_credentials SET state='revoked' WHERE id=?").run(id);
    } else {
      db.prepare("UPDATE agent_git_credentials SET state='revocation_pending' WHERE id=?").run(id);
    }
    if (error instanceof AuthoringError) throw error;
    throw new AuthoringError(502, "credential_issuance_unknown", "Git credential issuance did not complete; inspect and revoke this credential before retrying", { credentialId: id });
  } finally {
    issuing.delete(id);
    const row = db.prepare("SELECT state FROM agent_git_credentials WHERE id=?").get(id) as { state: string };
    if (row.state === "revocation_pending") await revokeGitCredential(id);
  }
}
async function providerTokens(path: string, user: User) {
  const tokens: ProviderToken[] = [];
  for (let page = 1; page <= 1000; page++) {
    const batch = await forgejo<ProviderToken[]>(`${path}?page=${page}&limit=50`, actor(user));
    tokens.push(...batch);
    if (batch.length < 50) return tokens;
  }
  throw new Error("Provider token listing exceeds recovery limit");
}
export function revokeGitCredential(id: string): Promise<boolean> {
  const existing = revoking.get(id); if (existing) return existing;
  const promise = revoke(id).finally(() => revoking.delete(id)); revoking.set(id, promise); return promise;
}
async function revoke(id: string) {
  const row = db.prepare("SELECT * FROM agent_git_credentials WHERE id=?").get(id) as Credential | undefined;
  if (!row || row.state === "revoked") return true;
  db.prepare("UPDATE agent_git_credentials SET state='revocation_pending' WHERE id=?").run(id);
  if (issuing.has(id)) return false;
  try {
    const user = owner(row);
    if ((await providerUser(row.provider_username, user)).id !== row.provider_user_id) throw new Error("Provider identity changed");
    const path = `/users/${encodeURIComponent(row.provider_username)}/tokens`;
    const tokens = await providerTokens(path, user);
    const matching = tokens.filter(token => token.name === row.reserved_name);
    for (const token of matching) db.prepare("INSERT OR IGNORE INTO agent_credential_token_ids(credential_id,provider_token_id) VALUES (?,?)").run(id, token.id);
    const ids = db.prepare("SELECT provider_token_id FROM agent_credential_token_ids WHERE credential_id=?").all(id) as { provider_token_id: number }[];
    // A dispatched response can be lost; absence alone cannot prove that creation finished.
    if (row.dispatched && !ids.length) { db.prepare("UPDATE agent_git_credentials SET operator_required=1 WHERE id=?").run(id); return false; }
    for (const token of ids) {
      try { await forgejo(`${path}/${token.provider_token_id}`, actor(user), { method: "DELETE" }); }
      catch (error) { if (!(error instanceof ForgejoError && error.status === 404)) throw error; }
      db.prepare("UPDATE agent_credential_token_ids SET deleted=1 WHERE credential_id=? AND provider_token_id=?").run(id, token.provider_token_id);
    }
    const remaining = await providerTokens(path, user);
    if (remaining.some(token => token.name === row.reserved_name || ids.some(item => item.provider_token_id === token.id))) return false;
    db.prepare("UPDATE agent_git_credentials SET state='revoked',operator_required=0 WHERE id=?").run(id);
    return true;
  } catch { return false; }
}
export async function revokeProjectGitCredentials(projectId: string) {
  const rows = db.prepare("SELECT id FROM agent_git_credentials WHERE project_id=? AND state<>'revoked'").all(projectId) as { id: string }[];
  db.prepare("UPDATE agent_git_credentials SET state='revocation_pending' WHERE project_id=? AND state<>'revoked'").run(projectId);
  let confirmed = true;
  for (const row of rows) if (!await revokeGitCredential(row.id)) confirmed = false;
  if (!confirmed) throw new Error("Agent Git credential revocation is unconfirmed");
}
export async function revokeAgentGrant(id: string) {
  db.prepare("UPDATE agent_grants SET state='revocation_pending' WHERE id=? AND state<>'revoked'").run(id);
  revokeGrantLaunches(id);
  const rows = db.prepare("SELECT id FROM agent_git_credentials WHERE grant_id=? AND state<>'revoked'").all(id) as { id: string }[];
  db.prepare("UPDATE agent_git_credentials SET state='revocation_pending' WHERE grant_id=? AND state<>'revoked'").run(id);
  for (const row of rows) await revokeGitCredential(row.id);
  if (!db.prepare("SELECT 1 FROM agent_git_credentials WHERE grant_id=? AND state<>'revoked'").get(id)) db.prepare("UPDATE agent_grants SET state='revoked' WHERE id=?").run(id);
}
export async function resumeAgentCredentials() {
  const rows = db.prepare("SELECT id FROM agent_git_credentials WHERE state IN ('issuing','issuance_unknown','revocation_pending')").all() as { id: string }[];
  for (const row of rows) if (!issuing.has(row.id)) await revokeGitCredential(row.id);
  const grants = db.prepare("SELECT id FROM agent_grants WHERE state='revocation_pending'").all() as { id: string }[];
  for (const row of grants) await revokeAgentGrant(row.id);
}

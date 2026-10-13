import { Hono, type Context } from "hono";
import { createHash, randomUUID } from "node:crypto";
import { db, projectById } from "./db.ts";
import { principalLive, type Principal } from "./auth.ts";
import { AuthoringError } from "./authoring.ts";
import { accessRepository, providerUser, collaboratorPermission, changeCollaborator, changeRepositoryVisibility } from "./forgejo.ts";
import { revokeProjectGitCredentials } from "./agent-git.ts";
import { revokeProjectLaunches } from "../runtime/server.ts";
import type { User, Group, GroupMember, GroupResponse, AccessPolicy, ProjectAccessResponse, MemberPermission } from "../shared/contracts.ts";

type ApiContext = Context<{ Variables: { user: User | undefined; principal: Principal | undefined } }>;
type GroupRow = { id: string; name: string; owner_id: string; version: number; pending_update_id: string | null };
type Update = { id: string; actor_id: string; request_id: string; request_hash: string; kind: "group" | "project"; target_id: string; desired: string; state: "pending" | "completed"; message: string };
type DesiredMember = { userId: string; username: string; providerId: number; permission: MemberPermission };
type DesiredProject = AccessPolicy & { members: DesiredMember[] };
type ProjectUpdate = { update_id: string; project_id: string; provider_id: number; provider_owner: string; provider_repo: string; desired: string; confirmed: number };
class AccessSyncError extends Error {}
export const access = new Hono<{ Variables: { user: User | undefined; principal: Principal | undefined } }>();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function invalid(): never { throw new AuthoringError(400, "invalid_access_request", "Use a valid access request"); }
function missing(): never { throw new AuthoringError(404, "not_found", "Resource not found"); }
function human(c: ApiContext) {
  const principal = c.get("principal");
  if (!principal || !principalLive(principal)) throw new AuthoringError(401, "sign_in_required", "Sign in to manage access");
  if (principal.kind !== "session") throw new AuthoringError(403, "forbidden", "A human session is required");
  return principal.user;
}
async function body(c: ApiContext, allowed: string[], versioned = true) {
  const reader = c.req.raw.body?.getReader();
  if (!reader) invalid();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 20000) { await reader.cancel(); throw new AuthoringError(413, "request_too_large", "Access request is too large"); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  let value: Record<string, unknown>;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { invalid(); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid();
  if (versioned && (typeof value.requestId !== "string" || !uuid.test(value.requestId) || !Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 1)) invalid();
  return value;
}
function groupRow(id: string) { return db.prepare("SELECT * FROM groups WHERE id=?").get(id) as GroupRow | undefined; }
function members(id: string): GroupMember[] {
  return db.prepare("SELECT m.user_id AS userId,u.username,u.display_name AS displayName,m.permission FROM group_members m JOIN users u ON u.id=m.user_id WHERE m.group_id=? ORDER BY m.user_id").all(id) as unknown as GroupMember[];
}
function groupPermission(row: GroupRow, user: User): Group["permission"] | undefined {
  if (row.owner_id === user.id) return "admin";
  if (row.pending_update_id) return;
  return (db.prepare("SELECT permission FROM group_members WHERE group_id=? AND user_id=?").get(row.id, user.id) as { permission: MemberPermission } | undefined)?.permission;
}
function groupResponse(id: string, user: User): GroupResponse {
  const row = groupRow(id), permission = row && groupPermission(row, user);
  if (!row || !permission) missing();
  const group: Group = { id, name: row.name, ownerId: row.owner_id, permission, version: row.version };
  if (!row.pending_update_id) return { group, members: members(id), sync: { state: "ready" } };
  const update = db.prepare("SELECT * FROM access_updates WHERE id=?").get(row.pending_update_id) as Update;
  const projects = db.prepare("SELECT project_id,confirmed FROM access_update_projects WHERE update_id=? ORDER BY project_id").all(update.id) as { project_id: string; confirmed: number }[];
  const desired = JSON.parse(update.desired) as GroupMember[];
  return { group, members: members(id), sync: { state: "pending", operationId: update.id, desiredMembers: desired, blockedProjectIds: projects.map(p => p.project_id), unconfirmedProjectIds: projects.filter(p => !p.confirmed).map(p => p.project_id), message: update.message || "Direct Git access is awaiting provider confirmation" } };
}
function projectResponse(id: string, user: User): ProjectAccessResponse {
  const project = projectById(id, user);
  if (!project || project.ownerId !== user.id) missing();
  const row = db.prepare("SELECT * FROM project_access WHERE project_id=?").get(id) as { version: number; group_id: string | null; pending_update_id: string | null } | undefined;
  const result: ProjectAccessResponse = { projectId: id, version: row?.version ?? 1, effective: { visibility: project.visibility, groupId: row?.group_id ?? null, mode: row?.pending_update_id ? "owner_read_only" : "normal" }, sync: { state: "ready" } };
  if (row?.pending_update_id) {
    const update = db.prepare("SELECT * FROM access_updates WHERE id=?").get(row.pending_update_id) as Update;
    const item = db.prepare("SELECT * FROM access_update_projects WHERE update_id=? AND project_id=?").get(update.id, id) as ProjectUpdate;
    const desired = JSON.parse(item.desired) as DesiredProject;
    result.sync = { state: "pending", operationId: update.id, desired: { visibility: desired.visibility, groupId: desired.groupId }, unconfirmedProjectIds: item.confirmed ? [] : [id], message: update.message || "Direct Git access is awaiting provider confirmation" };
  }
  return result;
}
function transaction(run: () => void) {
  db.exec("BEGIN IMMEDIATE");
  try { run(); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
}
function desiredMembers(groupId: string | null, replacement?: GroupMember[]): DesiredMember[] {
  if (!groupId) return [];
  const row = groupRow(groupId)!;
  return [...(replacement ?? members(groupId)), { userId: row.owner_id, permission: "write" as const }].map(member => {
    const user = db.prepare("SELECT username,forgejo_id FROM users WHERE id=?").get(member.userId) as { username: string; forgejo_id: number };
    return { userId: member.userId, permission: member.permission, username: user.username, providerId: user.forgejo_id };
  }).sort((a, b) => a.userId.localeCompare(b.userId));
}
function recordProjects(updateId: string, ids: string[], policy: (id: string) => DesiredProject) {
  for (const id of ids) {
    const project = db.prepare("SELECT forgejo_id,forgejo_owner,forgejo_repo FROM projects WHERE id=?").get(id) as { forgejo_id: number; forgejo_owner: string; forgejo_repo: string };
    db.prepare("INSERT OR IGNORE INTO project_access(project_id) VALUES (?)").run(id);
    db.prepare("UPDATE project_access SET version=version+1,pending_update_id=? WHERE project_id=?").run(updateId, id);
    db.prepare("INSERT INTO access_update_projects VALUES (?,?,?,?,?,?,0)").run(updateId, id, project.forgejo_id, project.forgejo_owner, project.forgejo_repo, JSON.stringify(policy(id)));
    revokeProjectLaunches(id);
  }
}
function replay(user: User, requestId: string, hash: string, kind: string, target: string) {
  const update = db.prepare("SELECT * FROM access_updates WHERE actor_id=? AND request_id=?").get(user.id, requestId) as Update | undefined;
  if (update && (update.request_hash !== hash || update.kind !== kind || update.target_id !== target)) throw new AuthoringError(409, "request_id_reused", "Request ID was already used for another change");
  return update;
}
function busy(operationId: string | null | undefined) {
  if (operationId) throw new AuthoringError(409, "access_busy", "An access change is still pending", { operationId });
}
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
access.get("/groups", c => {
  const user = human(c);
  const rows = db.prepare("SELECT * FROM groups ORDER BY name,id").all() as GroupRow[];
  return c.json({ groups: rows.filter(row => groupPermission(row, user)).map(row => ({ id: row.id, name: row.name, ownerId: row.owner_id, version: row.version, permission: groupPermission(row, user)! })) });
});
access.get("/groups/:id", c => c.json(groupResponse(c.req.param("id"), human(c))));
access.get("/groups/:id/candidates", c => {
  const user = human(c), row = groupRow(c.req.param("id"));
  if (!row || row.owner_id !== user.id) missing();
  return c.json({ users: db.prepare("SELECT id,username,display_name AS displayName FROM users WHERE id<>? ORDER BY username").all(row.owner_id) });
});
access.get("/projects/:id/access", c => c.json(projectResponse(c.req.param("id"), human(c))));
function pendingOperation(value: Record<string, unknown>, current: string | null | undefined) {
  if (value.operationId !== undefined && (typeof value.operationId !== "string" || !uuid.test(value.operationId))) invalid();
  const update = current ? db.prepare("SELECT state FROM access_updates WHERE id=?").get(current) as { state: string } | undefined : undefined;
  if (!current || value.operationId !== current || update?.state !== "pending")
    throw new AuthoringError(409, "stale_access_operation", "This access operation is no longer pending");
  return current;
}
access.post("/groups/:id/retry", async c => {
  const user = human(c), id = c.req.param("id"), row = groupRow(id);
  if (!row || row.owner_id !== user.id) missing();
  const value = await body(c, ["operationId"], false);
  human(c);
  const operationId = pendingOperation(value, groupRow(id)?.pending_update_id);
  await reconcileAccess(operationId);
  const result = groupResponse(id, user);
  return c.json(result, result.sync.state === "pending" ? 202 : 200);
});
access.post("/projects/:id/access/retry", async c => {
  const user = human(c), id = c.req.param("id");
  projectResponse(id, user);
  const value = await body(c, ["operationId"], false);
  human(c);
  const row = db.prepare("SELECT pending_update_id FROM project_access WHERE project_id=?").get(id) as { pending_update_id: string | null } | undefined;
  const operationId = pendingOperation(value, row?.pending_update_id);
  await reconcileAccess(operationId);
  const result = projectResponse(id, user);
  return c.json(result, result.sync.state === "pending" ? 202 : 200);
});
access.put("/groups/:id/members", async c => {
  const user = human(c), id = c.req.param("id");
  const value = await body(c, ["requestId", "expectedVersion", "members"]);
  const row = groupRow(id);
  if (!row || row.owner_id !== user.id) missing();
  if (!Array.isArray(value.members) || value.members.length > 32) invalid();
  const requested: GroupMember[] = value.members.map(member => {
    if (!member || typeof member !== "object" || Array.isArray(member) || Object.keys(member).some(key => !["userId", "permission"].includes(key)) || typeof member.userId !== "string" || !["read", "write"].includes(member.permission) || member.userId === row.owner_id) invalid();
    const target = db.prepare("SELECT id,username,display_name AS displayName FROM users WHERE id=?").get(member.userId) as User | undefined;
    if (!target) invalid();
    return { userId: target.id, username: target.username, displayName: target.displayName, permission: member.permission };
  }).sort((a, b) => a.userId.localeCompare(b.userId));
  if (new Set(requested.map(member => member.userId)).size !== requested.length) invalid();
  const fingerprint = hash(["group", id, value.expectedVersion, requested]);
  const previous = replay(user, value.requestId as string, fingerprint, "group", id);
  if (previous) { await reconcileAccess(previous.id); const result = groupResponse(id, user); return c.json(result, result.sync.state === "pending" ? 202 : 200); }
  busy(row.pending_update_id);
  if (row.version !== value.expectedVersion) throw new AuthoringError(409, "stale_access", "Group membership changed", { currentVersion: row.version });
  if (JSON.stringify(requested) === JSON.stringify(members(id))) return c.json(groupResponse(id, user));
  const projects = db.prepare("SELECT project_id,pending_update_id FROM project_access WHERE group_id=? ORDER BY project_id").all(id) as { project_id: string; pending_update_id: string | null }[];
  for (const project of projects) busy(project.pending_update_id);
  human(c);
  const updateId = randomUUID();
  transaction(() => {
    db.prepare("INSERT INTO access_updates VALUES (?,?,?,?,?,?,?,'pending','')").run(updateId, user.id, value.requestId as string, fingerprint, "group", id, JSON.stringify(requested));
    db.prepare("UPDATE groups SET version=version+1,pending_update_id=? WHERE id=?").run(updateId, id);
    recordProjects(updateId, projects.map(project => project.project_id), projectId => {
      const project = db.prepare("SELECT visibility FROM projects WHERE id=?").get(projectId) as { visibility: AccessPolicy["visibility"] };
      return { visibility: project.visibility, groupId: id, members: desiredMembers(id, requested) };
    });
  });
  await reconcileAccess(updateId);
  const result = groupResponse(id, user); return c.json(result, result.sync.state === "pending" ? 202 : 200);
});
access.put("/projects/:id/access", async c => {
  const user = human(c), id = c.req.param("id");
  const value = await body(c, ["requestId", "expectedVersion", "visibility", "groupId", "confirmPublic"]);
  if ((value.visibility !== "public" && value.visibility !== "private") || (value.groupId !== null && typeof value.groupId !== "string") || (value.confirmPublic !== undefined && value.confirmPublic !== true)) invalid();
  const current = projectResponse(id, user);
  const desired: AccessPolicy = { visibility: value.visibility, groupId: value.groupId as string | null };
  const fingerprint = hash(["project", id, value.expectedVersion, desired, value.confirmPublic ?? null]);
  const previous = replay(user, value.requestId as string, fingerprint, "project", id);
  if (previous) { await reconcileAccess(previous.id); const result = projectResponse(id, user); return c.json(result, result.sync.state === "pending" ? 202 : 200); }
  if (current.sync.state === "pending") busy(current.sync.operationId);
  if (current.version !== value.expectedVersion) throw new AuthoringError(409, "stale_access", "Project access changed", { currentVersion: current.version });
  if (current.effective.visibility === "private" && desired.visibility === "public" && value.confirmPublic !== true) throw new AuthoringError(400, "confirm_public_required", "Confirm that all Git history will become public");
  for (const groupId of [current.effective.groupId, desired.groupId].filter((id): id is string => !!id)) {
    const row = groupRow(groupId);
    if (!row) missing();
    busy(row.pending_update_id);
    if (groupId === desired.groupId && !groupPermission(row, user)) missing();
  }
  if (desired.visibility === current.effective.visibility && desired.groupId === current.effective.groupId) return c.json(current);
  human(c);
  const updateId = randomUUID();
  transaction(() => {
    db.prepare("INSERT INTO access_updates VALUES (?,?,?,?,?,?,?,'pending','')").run(updateId, user.id, value.requestId as string, fingerprint, "project", id, JSON.stringify(desired));
    recordProjects(updateId, [id], () => ({ ...desired, members: desiredMembers(desired.groupId) }));
  });
  await reconcileAccess(updateId);
  const result = projectResponse(id, user); return c.json(result, result.sync.state === "pending" ? 202 : 200);
});

const running = new Map<string, Promise<void>>();
export function reconcileAccess(id: string): Promise<void> {
  const existing = running.get(id); if (existing) return existing;
  const promise = reconcile(id).finally(() => running.delete(id));
  running.set(id, promise); return promise;
}
async function reconcile(id: string) {
  const update = db.prepare("SELECT * FROM access_updates WHERE id=?").get(id) as Update | undefined;
  if (!update || update.state === "completed") return;
  const projects = db.prepare("SELECT * FROM access_update_projects WHERE update_id=? ORDER BY project_id").all(id) as ProjectUpdate[];
  db.prepare("UPDATE access_update_projects SET confirmed=0 WHERE update_id=?").run(id);
  for (const phase of ["restrict", "complete"] as const) {
    for (const item of projects) {
      try {
        await reconcileProject(item, phase);
        if (phase === "complete") db.prepare("UPDATE access_update_projects SET confirmed=1 WHERE update_id=? AND project_id=?").run(id, item.project_id);
      } catch (error) {
        db.prepare("UPDATE access_updates SET message=? WHERE id=?").run(error instanceof AccessSyncError ? error.message : "Provider access is unconfirmed; retry this accepted change", id);
        return;
      }
    }
  }
  transaction(() => {
    if (update.kind === "group") {
      db.prepare("DELETE FROM group_members WHERE group_id=?").run(update.target_id);
      for (const member of JSON.parse(update.desired) as GroupMember[]) db.prepare("INSERT INTO group_members VALUES (?,?,?)").run(update.target_id, member.userId, member.permission);
      db.prepare("UPDATE groups SET pending_update_id=NULL WHERE id=? AND pending_update_id=?").run(update.target_id, id);
    }
    for (const item of projects) {
      const desired = JSON.parse(item.desired) as DesiredProject;
      const current = db.prepare("SELECT visibility FROM projects WHERE id=?").get(item.project_id) as { visibility: string };
      if (current.visibility !== desired.visibility) {
        db.prepare("INSERT OR IGNORE INTO project_metadata(project_id) VALUES (?)").run(item.project_id);
        db.prepare("UPDATE project_metadata SET version=version+1 WHERE project_id=?").run(item.project_id);
        db.prepare("UPDATE projects SET visibility=? WHERE id=?").run(desired.visibility, item.project_id);
      }
      db.prepare("UPDATE project_access SET group_id=?,pending_update_id=NULL WHERE project_id=? AND pending_update_id=?").run(desired.groupId, item.project_id, id);
    }
    db.prepare("UPDATE access_updates SET state='completed',message='' WHERE id=?").run(id);
  });
}
async function reconcileProject(item: ProjectUpdate, phase: "restrict" | "complete") {
  const desired = JSON.parse(item.desired) as DesiredProject;
  if (phase === "restrict") await revokeProjectGitCredentials(item.project_id);
  const project = db.prepare("SELECT owner_id FROM projects WHERE id=?").get(item.project_id) as { owner_id: string };
  const user = db.prepare("SELECT id,username,display_name AS displayName,forgejo_id FROM users WHERE id=?").get(project.owner_id) as unknown as User & { forgejo_id: number };
  const repo = await accessRepository(item.provider_owner, item.provider_repo, user);
  if (repo.id !== item.provider_id || repo.owner.id !== user.forgejo_id) throw new AccessSyncError("Repository identity changed; provider access is unconfirmed");
  if (desired.visibility === "private" && !repo.private) await changeRepositoryVisibility(item.provider_owner, item.provider_repo, "private", user);
  const wanted = desired.members.filter(member => member.userId !== user.id);
  const managed = db.prepare("SELECT m.user_id AS userId,m.provider_user_id AS providerId,m.permission,u.username FROM managed_collaborators m JOIN users u ON u.id=m.user_id WHERE m.project_id=? ORDER BY m.user_id").all(item.project_id) as DesiredMember[];
  // Remove/downgrade before granting anything. Exact identities are durable intent.
  for (const member of managed) {
    if ((await providerUser(member.username, user)).id !== member.providerId) throw new AccessSyncError("Collaborator identity changed; provider access is unconfirmed");
    const next = wanted.find(target => target.userId === member.userId);
    const permission = await collaboratorPermission(item.provider_owner, item.provider_repo, member.username, user);
    if (permission && permission !== member.permission && permission !== next?.permission) throw new AccessSyncError("A provider collaborator was changed outside Lab; reconciliation is pending");
    if (!next || (member.permission === "write" && next.permission === "read")) {
      if (permission !== (next?.permission ?? null)) await changeCollaborator(item.provider_owner, item.provider_repo, member.username, next?.permission ?? null, user);
      const confirmed = await collaboratorPermission(item.provider_owner, item.provider_repo, member.username, user);
      if (confirmed !== (next?.permission ?? null)) throw new AccessSyncError("Provider collaborator removal is unconfirmed");
      if (!next) db.prepare("DELETE FROM managed_collaborators WHERE project_id=? AND user_id=?").run(item.project_id, member.userId);
      else db.prepare("UPDATE managed_collaborators SET permission=? WHERE project_id=? AND user_id=?").run(next.permission, item.project_id, member.userId);
    }
  }
  if (phase === "restrict") return;
  for (const member of wanted) {
    if ((await providerUser(member.username, user)).id !== member.providerId) throw new AccessSyncError("Collaborator identity changed; provider access is unconfirmed");
    const tracked = db.prepare("SELECT permission FROM managed_collaborators WHERE project_id=? AND user_id=?").get(item.project_id, member.userId) as { permission: MemberPermission } | undefined;
    const permission = await collaboratorPermission(item.provider_owner, item.provider_repo, member.username, user);
    if (!tracked && permission) throw new AccessSyncError("An existing provider collaborator grant is not Lab-managed; reconciliation is pending");
    if (tracked && permission && permission !== tracked.permission && permission !== member.permission) throw new AccessSyncError("A provider collaborator was changed outside Lab; reconciliation is pending");
    // Reserve management before a possibly-dispatched grant, so restart can finish it.
    if (!tracked) db.prepare("INSERT INTO managed_collaborators VALUES (?,?,?,?)").run(item.project_id, member.userId, member.providerId, member.permission);
    if (permission !== member.permission) await changeCollaborator(item.provider_owner, item.provider_repo, member.username, member.permission, user);
    if (await collaboratorPermission(item.provider_owner, item.provider_repo, member.username, user) !== member.permission) throw new AccessSyncError("Provider collaborator grant is unconfirmed");
    db.prepare("UPDATE managed_collaborators SET permission=? WHERE project_id=? AND user_id=?").run(member.permission, item.project_id, member.userId);
  }
  if (desired.visibility === "public") await changeRepositoryVisibility(item.provider_owner, item.provider_repo, "public", user);
  const confirmed = await accessRepository(item.provider_owner, item.provider_repo, user);
  if (confirmed.id !== item.provider_id || confirmed.owner.id !== user.forgejo_id || confirmed.private !== (desired.visibility === "private")) throw new AccessSyncError("Provider repository policy is unconfirmed");
}
export async function resumeAccessUpdates() {
  const pending = db.prepare("SELECT id FROM access_updates WHERE state='pending' ORDER BY rowid LIMIT 32").all() as { id: string }[];
  for (const update of pending) await reconcileAccess(update.id);
}

export async function attachSeedGroup(projectId: string, groupId: string, ownerId: string) {
  const previous = db.prepare("SELECT id FROM access_updates WHERE actor_id=? AND request_id=?").get(ownerId, `seed:${projectId}`) as { id: string } | undefined;
  if (previous) { await reconcileAccess(previous.id); return; }
  const id = randomUUID();
  const desired: DesiredProject = { visibility: "private", groupId, members: desiredMembers(groupId) };
  transaction(() => {
    db.prepare("INSERT INTO access_updates VALUES (?,?,?,?,?,?,?,'pending','')").run(id, ownerId, `seed:${projectId}`, hash(desired), "project", projectId, JSON.stringify({ visibility: "private", groupId }));
    recordProjects(id, [projectId], () => desired);
  });
  await reconcileAccess(id);
}

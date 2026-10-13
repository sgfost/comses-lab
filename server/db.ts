import { DatabaseSync } from "node:sqlite";
import { readFileSync, chmodSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { stateDir } from "./config.ts";
import type { Project, User } from "../shared/contracts.ts";
import type { Principal } from "./auth.ts";
const file = resolve(stateDir, "lab.sqlite");
export const db = new DatabaseSync(file);
chmodSync(file, 0o600);
db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)");
for (const name of readdirSync(new URL("./migrations/", import.meta.url)).sort()) {
  if (!name.endsWith(".sql") || db.prepare("SELECT name FROM schema_migrations WHERE name=?").get(name)) continue;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8"));
    db.prepare("INSERT INTO schema_migrations VALUES (?)").run(name);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
const projectSql = `SELECT p.id,p.title,p.description,p.visibility,p.owner_id AS ownerId,u.display_name AS ownerName,p.entrypoint,p.license,p.forgejo_owner AS forgejoOwner,p.forgejo_repo AS forgejoRepo,p.forgejo_id AS forgejoId FROM projects p JOIN users u ON p.owner_id=u.id`;
export function listProjects(user?: User) {
  const rows = db.prepare(`${projectSql} ORDER BY p.title`).all() as unknown as Project[];
  return rows.map((row) => readableProject(row, user)).filter((row): row is Project => !!row);
}
export function projectById(id: string, user?: User) {
  const row = db.prepare(`${projectSql} WHERE p.id=?`).get(id) as unknown as Project | undefined;
  return row && readableProject(row, user);
}
function readableProject(project: Project, user?: User): Project | undefined {
  const access = db.prepare(`SELECT a.pending_update_id,g.owner_id,gm.permission FROM project_access a LEFT JOIN groups g ON g.id=a.group_id LEFT JOIN group_members gm ON gm.group_id=g.id AND gm.user_id=? WHERE a.project_id=?`).get(user?.id ?? "", project.id) as
    { pending_update_id: string | null; owner_id: string | null; permission: "read" | "write" | null } | undefined;
  const owner = project.ownerId === user?.id;
  if (access?.pending_update_id) return owner ? { ...projectMetadata(project, user), permission: "read" } : undefined;
  const memberPermission = user && access?.owner_id === user.id ? "write" : access?.permission;
  if (!owner && project.visibility !== "public" && !memberPermission) return;
  return { ...projectMetadata(project, user), permission: owner ? "admin" : memberPermission ?? "read", sharedWithMe: !owner && !!memberPermission };
}
export function projectForPrincipal(id: string, principal?: Principal): Project | undefined {
  const project = projectById(id, principal?.user);
  if (!project || principal?.kind !== "agent") return project;
  const scope = db.prepare(`SELECT s.permission FROM agent_project_scopes s JOIN agent_grants g ON g.id=s.grant_id WHERE s.project_id=? AND s.grant_id=? AND g.state='active' AND g.owner_id=? AND g.token_hash=?`).get(id, principal.grantId, principal.user.id, principal.credentialHash) as { permission: "read" | "write" } | undefined;
  if (!scope) return;
  return { ...project, permission: scope.permission === "write" && project.permission !== "read" ? "write" : "read" };
}
export function projectsForPrincipal(principal?: Principal) {
  return listProjects(principal?.user).map((project) => projectForPrincipal(project.id, principal)).filter((project): project is Project => !!project);
}
export function accessPending(projectId: string) {
  return !!db.prepare("SELECT 1 FROM project_access WHERE project_id=? AND pending_update_id IS NOT NULL").get(projectId);
}
function projectMetadata(project: Project, user?: User): Project {
  const metadata = db.prepare("SELECT version,data_origins,source_project_id,source_commit,kind,derivation FROM project_metadata WHERE project_id=?").get(project.id) as
    { version: number; data_origins: string; source_project_id: string | null; source_commit: string | null; kind: Project["kind"]; derivation: string } | undefined;
  return { ...project, permission: project.ownerId === user?.id ? "admin" : "read",
    metadataVersion: metadata?.version ?? 1,
    dataOrigins: JSON.parse(metadata?.data_origins ?? "[]"),
    kind: metadata?.kind ?? "model",
    extractedFrom: metadata?.derivation === "extraction" && metadata.source_project_id ? { projectId: metadata.source_project_id, commit: metadata.source_commit! } : null,
    forkedFrom: metadata?.derivation !== "extraction" && metadata?.source_project_id ? { projectId: metadata.source_project_id, commit: metadata.source_commit! } : null };
}

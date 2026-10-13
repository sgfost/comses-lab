import { templates } from "../shared/templates.ts";
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { db, projectById, projectForPrincipal, accessPending } from "./db.ts";
import { cookieName, readPrincipal, type Principal } from "./auth.ts";
import { revokeProjectLaunches } from "../runtime/server.ts";
import { settings } from "./config.ts";
import { actor, sourceTree, validCommit, repositoryUrl, lookupRepository, createRepository, publishRepository, sourceFile } from "./forgejo.ts";
import { authoringPath, validateCommitRequest, validateRestoreRequest, prepareRestore, operationRepository, removeRepository, fetchCommit, prepareCommit, pushCommit, remoteHead, templateCommit, GitError } from "./git.ts";
import { selectedPaths } from "./libraries.ts";
import type { Project, User } from "../shared/contracts.ts";

export class AuthoringError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 502, public code: string, message: string, public details: Record<string, unknown> = {}) { super(message); }
}
type Variables = { user: User | undefined; principal: Principal | undefined };
export type ApiContext = Context<{ Variables: Variables }>;
export const authoring = new Hono<{ Variables: Variables }>();

function fail(code: string, message: string): never { throw new AuthoringError(400, code, message); }
export async function body(c: ApiContext): Promise<Record<string, unknown>> {
  const reader = c.req.raw.body?.getReader();
  if (!reader) fail("invalid_body", "Use a JSON object");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 12_000_000) { await reader.cancel(); throw new AuthoringError(413, "request_too_large", "JSON request exceeds 12 MB"); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { fail("invalid_body", "Use a valid JSON object"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_body", "Use a JSON object");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((field) => !allowed.includes(field))) fail("invalid_body", "Unknown request field");
}
function text(value: unknown, field: string, max: number, nonblank = true) {
  if (typeof value !== "string") fail("invalid_metadata", `Invalid ${field}`);
  const normalized = nonblank ? value.trim() : value;
  if (normalized.length > max || normalized.includes("\0") || (nonblank && !normalized)) fail("invalid_metadata", `Invalid ${field}`);
  return normalized;
}
function netlogoFile(value: unknown): { name: string; content: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_netlogo_file", "Upload a .nlogo or .nlogox file");
  const file = value as Record<string, unknown>;
  if (Object.keys(file).some(key => !["name", "content"].includes(key)) || !authoringPath(file.name) || !/\.nlogox?$/i.test(file.name) ||
      typeof file.content !== "string" || !file.content.trim() || file.content.includes("\0") || Buffer.from(file.content).toString("utf8") !== file.content)
    fail("invalid_netlogo_file", "Use a .nlogo or .nlogox filename and UTF-8 model text");
  if (Buffer.byteLength(file.content) > 2_000_000) throw new AuthoringError(413, "content_too_large", "Model file exceeds 2 MB");
  return file as { name: string; content: string };
}
function signedIn(c: ApiContext) {
  const user = readPrincipal(getCookie(c, cookieName), c.req.header("Authorization"))?.user;
  if (!user) throw new AuthoringError(401, "sign_in_required", "Sign in to change projects");
  return user;
}
export function currentProject(c: ApiContext, id: string, access: "read" | "write" | "admin" = "read", original?: User) {
  const user = signedIn(c);
  if (original && user.id !== original.id) throw new AuthoringError(401, "session_changed", "The original session is no longer valid");
  const project = projectForPrincipal(id, readPrincipal(getCookie(c, cookieName), c.req.header("Authorization")));
  if (!project) throw new AuthoringError(404, "not_found", "Project not found");
  if (access !== "read" && project.permission === "read") throw new AuthoringError(403, "forbidden", "You cannot change this project");
  if (access === "admin" && project.permission !== "admin") throw new AuthoringError(403, "forbidden", "Project administration is required");
  return { user, project };
}
function originalSession(c: ApiContext, user: User) {
  if (signedIn(c).id !== user.id) throw new AuthoringError(401, "session_changed", "The original session is no longer valid");
}
authoring.get("/templates", (c) => c.json({ templates: templates.map(({ files, ...template }) => template) }));
async function saveFiles(c: ApiContext) {
  const id = c.req.param("id")!;
  const { user, project } = currentProject(c, id, "write");
  const value = await body(c);
  const request = c.req.path.endsWith("/restores") ? validateRestoreRequest(value) : validateCommitRequest(value);
  await sourceTree(project, request.expectedCommit, user);
  const repository = await operationRepository(actor(user));
  const url = repositoryUrl(project.forgejoOwner, project.forgejoRepo);
  try {
    await fetchCommit(repository, url, request.expectedCommit);
    if ("sourceCommit" in request) {
      await sourceTree(project, request.sourceCommit, user);
      await fetchCommit(repository, url, request.sourceCommit);
    }
    const commit = "sourceCommit" in request ? await prepareRestore(repository, request, user) : await prepareCommit(repository, request, user);
    currentProject(c, id, "write", user);
    let result;
    try { result = await pushCommit(repository, url, request.ref, request.expectedCommit, commit); }
    catch { throw new AuthoringError(502, "save_outcome_unknown", "The save outcome is unknown; inspect the branch before saving again"); }
    if (result === "conflict") {
      let currentCommit: string | null;
      try { currentCommit = await remoteHead(repository, url, request.ref); }
      catch { throw new AuthoringError(502, "save_outcome_unknown", "The branch could not be inspected after the rejected save"); }
      throw new AuthoringError(409, "stale_head", "The branch changed; keep your edits and inspect the current source", { ref: request.ref, expectedCommit: request.expectedCommit, currentCommit });
    }
    currentProject(c, id, "write", user);
    return c.json({ ref: request.ref, commit }, 201);
  } finally { await removeRepository(repository); }
}
authoring.post("/projects/:id/commits", saveFiles);
authoring.post("/projects/:id/restores", saveFiles);
function origins(value: unknown) {
  if (!Array.isArray(value) || value.length > 16 || new Set(value).size !== value.length) fail("invalid_origins", "Use at most 16 distinct HTTP(S) origins");
  const blocked = [settings.appOrigin, settings.runtimeOrigin, settings.forgejoUrl].map((origin) => new URL(origin).hostname.toLowerCase().replace(/\.$/, ""));
  return value.map((origin: unknown) => {
    if (typeof origin !== "string") fail("invalid_origins", "Invalid data origin");
    let url: URL;
    try { url = new URL(origin); } catch { fail("invalid_origins", "Invalid data origin"); }
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const address = host.replace(/^\[|\]$/g, "");
    const ipv6 = isIP(address) === 6;
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin || url.username || url.password || blocked.includes(host) ||
      host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || (!ipv6 && !host.includes(".")) ||
      /^(127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
      (ipv6 && /^(::(1$|$|ffff:)|f[cd]|fe[89ab])/.test(address))) fail("invalid_origins", "Use a canonical external HTTP(S) origin");
    return origin;
  });
}
authoring.patch("/projects/:id", async (c) => {
  const id = c.req.param("id");
  const { user, project: initial } = currentProject(c, id, "admin");
  const request = await body(c);
  fields(request, ["expectedMetadataVersion", "title", "description", "license", "entrypoint", "dataOrigins"]);
  if (!Number.isSafeInteger(request.expectedMetadataVersion) || Number(request.expectedMetadataVersion) < 1) fail("invalid_metadata", "Use a positive metadata version");
  if (Object.keys(request).length < 2) fail("invalid_metadata", "Change at least one metadata field");
  const patch: Partial<Project> = {};
  if (request.title !== undefined) patch.title = text(request.title, "title", 120);
  if (request.description !== undefined) patch.description = text(request.description, "description", 4000, false);
  if (request.license !== undefined) patch.license = text(request.license, "license", 100);
  if (request.entrypoint !== undefined) {
    if (!(request.entrypoint === "" && initial.kind === "library") && !authoringPath(request.entrypoint)) fail("invalid_metadata", "Use an ordinary relative entrypoint path");
    patch.entrypoint = request.entrypoint;
  }
  if (request.dataOrigins !== undefined) patch.dataOrigins = origins(request.dataOrigins);
  const { project } = currentProject(c, id, "admin", user);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT OR IGNORE INTO project_metadata(project_id) VALUES (?)").run(id);
    const current = projectById(id, user)!;
    if (current.metadataVersion !== request.expectedMetadataVersion) throw new AuthoringError(409, "stale_metadata", "The project metadata changed", { currentMetadataVersion: current.metadataVersion });
    if (Object.entries(patch).every(([key, value]) => JSON.stringify(current[key as keyof Project]) === JSON.stringify(value))) throw new AuthoringError(422, "no_changes", "The metadata has not changed");
    const next = { ...project, ...patch };
    db.prepare("UPDATE projects SET title=?,description=?,license=?,entrypoint=? WHERE id=?").run(next.title, next.description, next.license, next.entrypoint, id);
    db.prepare("UPDATE project_metadata SET version=version+1,data_origins=? WHERE project_id=? AND version=?").run(JSON.stringify(next.dataOrigins), id, request.expectedMetadataVersion as number);
    db.exec("COMMIT");
    if (current.dataOrigins.some((origin) => !next.dataOrigins.includes(origin))) revokeProjectLaunches(id);
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return c.json({ project: projectById(id, user)! });
});

interface Provision {
  actor_id: string; request_id: string; kind: string; request_hash: string; project_id: string; repo_name: string;
  prepared_commit: string; prepared_directory: string; metadata: string; source_project_id: string | null; source_commit: string | null;
  source_private: number; provider_id: number | null; stage: string; grant_id: string | null;
}
const pending = new Map<string, Promise<void>>();
async function serialized<T>(key: string, operation: () => Promise<T>) {
  const previous = pending.get(key) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => done);
  pending.set(key, tail);
  await previous;
  try { return await operation(); }
  finally { release(); if (pending.get(key) === tail) pending.delete(key); }
}
async function provision(c: ApiContext, kind: "create" | "fork" | "extraction", sourceId?: string) {
  const user = signedIn(c);
  const principal = readPrincipal(getCookie(c, cookieName), c.req.header("Authorization"))!;
  const grantId = principal.kind === "agent" ? principal.grantId : null;
  const request = await body(c);
  fields(request, kind === "create" ? ["requestId", "templateId", "title", "visibility", "description", "netlogoFile"] : ["requestId", "commit", "title", "visibility", ...(kind === "extraction" ? ["paths"] : [])]);
  if (typeof request.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.requestId)) fail("invalid_request_id", "Use a UUID request ID");
  const requestId = request.requestId.toLowerCase();
  const title = text(request.title, "title", 120);
  if (typeof request.visibility !== "string" || !["public", "private"].includes(request.visibility)) fail("invalid_visibility", "Use public or private visibility");
  const template = templates.find((item) => item.id === request.templateId);
  if (kind === "create" && !template) fail("invalid_template", "Select an available template");
  const imported = request.netlogoFile === undefined ? undefined : netlogoFile(request.netlogoFile);
  if (imported && (kind !== "create" || template?.id !== "netlogo")) fail("invalid_template", "Select NetLogo to import a model");
  if (kind === "create" && request.description !== undefined) text(request.description, "description", 4000, false);
  if (kind !== "create" && (typeof request.commit !== "string" || !validCommit(request.commit))) fail("invalid_commit", "Fork a full commit SHA");
  if (kind === "extraction") selectedPaths(request.paths);
  const hash = createHash("sha256").update(JSON.stringify({ kind, sourceId, ...Object.fromEntries(Object.entries(request).sort(([a], [b]) => a.localeCompare(b))) })).digest("hex");
  return serialized(`${user.id}:${requestId}`, async () => {
    const check = () => {
      originalSession(c, user);
      if (grantId && !db.prepare("SELECT 1 FROM agent_grants WHERE id=? AND owner_id=? AND state='active' AND allow_create=1").get(grantId, user.id))
        throw new AuthoringError(403, "forbidden", "This agent grant cannot create projects");
      if (sourceId) {
        const source = currentProject(c, sourceId, "read", user).project;
        if (accessPending(sourceId)) throw new AuthoringError(409, "access_pending", "Project access is being reconciled");
        if (source.visibility === "private" && request.visibility === "public") throw new AuthoringError(400, "private_fork", "A private source requires a private fork");
      }
    };
    check();
    let row = db.prepare("SELECT * FROM project_provisions WHERE actor_id=? AND request_id=?").get(user.id, requestId) as unknown as Provision | undefined;
    if (row && row.grant_id !== grantId) throw new AuthoringError(409, "request_id_reused", "This request ID belongs to another credential");
    if (row && row.request_hash !== hash) throw new AuthoringError(409, "request_id_reused", "This request ID belongs to another operation");
    if (row?.stage === "completed") {
      const project = projectForPrincipal(row.project_id, principal);
      if (!project) throw new AuthoringError(404, "not_found", "Project not found");
      return c.json({ project, ref: "refs/heads/main", commit: row.prepared_commit }, 200);
    }
    check();
    if (!row) {
      const source = sourceId ? currentProject(c, sourceId, "read", user).project : null;
      const metadata = { title, description: source?.description ?? request.description ?? template!.description,
        visibility: request.visibility, kind: kind === "extraction" ? "library" : source?.kind ?? template!.kind, derivation: kind === "extraction" ? "extraction" : "fork", entrypoint: kind === "extraction" ? "" : source?.entrypoint ?? imported?.name ?? template!.entrypoint, license: source?.license ?? (imported ? "Unspecified" : template!.license) };
      const repository = await operationRepository(actor(user));
      let commit: string;
      if (source) {
        await sourceTree(source, request.commit as string, user);
        await fetchCommit(repository, repositoryUrl(source.forgejoOwner, source.forgejoRepo), request.commit as string);
        if (kind === "extraction") {
          const files = await Promise.all(selectedPaths(request.paths).map(async (path) => ({ path, content: await sourceFile(source, request.commit as string, path, user) })));
          if (files.reduce((size, file) => size + file.content.length, 0) > 5_000_000) throw new AuthoringError(413, "content_too_large", "Extraction exceeds 5 MB");
          commit = await templateCommit(repository, files, user);
        } else commit = request.commit as string;
      } else {
        const files = imported ? [{ path: imported.name, content: Buffer.from(imported.content, "utf8") }] :
          await Promise.all(template!.files.map(async (path) => ({ path, content: await readFile(new URL(`../examples/${template!.id}/${path}`, import.meta.url)) })));
        commit = await templateCommit(repository, files, user);
      }
      const projectId = randomUUID();
      check();
      db.prepare("INSERT INTO project_provisions(actor_id,request_id,kind,request_hash,project_id,repo_name,prepared_commit,prepared_directory,metadata,source_project_id,source_commit,source_private,provider_id,stage,grant_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(user.id, requestId, kind === "extraction" ? "fork" : kind, hash, projectId, `lab-${projectId}`, commit, repository.directory, JSON.stringify(metadata), sourceId ?? null, source ? request.commit as string : null, source?.visibility === "private" ? 1 : 0, null, "prepared", grantId);
      row = db.prepare("SELECT * FROM project_provisions WHERE actor_id=? AND request_id=?").get(user.id, requestId) as unknown as Provision;
    }
    const operation = row;
    const update = (stage: string, providerId = operation.provider_id) => {
      db.prepare("UPDATE project_provisions SET stage=?,provider_id=? WHERE actor_id=? AND request_id=?").run(stage, providerId, user.id, requestId);
      operation.stage = stage; operation.provider_id = providerId;
    };
    let remote = await lookupRepository(user.username, operation.repo_name, user);
    if (operation.provider_id === null) {
      if (remote) throw new AuthoringError(409, "provision_identity_unknown", "Repository creation has an unknown identity; operator recovery is required");
      check();
      update("creating");
      remote = await createRepository(operation.repo_name, user);
      update("created", remote.id);
    } else if (!remote || remote.id !== operation.provider_id) {
      throw new AuthoringError(409, "provision_conflict", "The reserved repository identity changed");
    }
    const repository = await operationRepository(actor(user));
    const url = repositoryUrl(user.username, operation.repo_name);
    try {
      await fetchCommit(repository, operation.prepared_directory, operation.prepared_commit);
      const head = await remoteHead(repository, url, "refs/heads/main");
      if (head !== operation.prepared_commit) {
        if (head !== null) throw new AuthoringError(409, "provision_conflict", "The reserved repository contains unexpected source");
        check();
        const result = await pushCommit(repository, url, "refs/heads/main", "", operation.prepared_commit);
        if (result !== "updated" && await remoteHead(repository, url, "refs/heads/main") !== operation.prepared_commit) throw new AuthoringError(409, "provision_conflict", "The initial branch was changed concurrently");
      }
      update("populated");
      const metadata = JSON.parse(operation.metadata);
      if (metadata.visibility === "public") {
        const identity = await lookupRepository(user.username, operation.repo_name, user);
        if (identity?.id !== operation.provider_id) throw new AuthoringError(409, "provision_conflict", "The reserved repository identity changed");
        if (await remoteHead(repository, url, "refs/heads/main") !== operation.prepared_commit) throw new AuthoringError(409, "provision_conflict", "Source changed before public exposure");
        check();
        await publishRepository(user.username, operation.repo_name, user);
        update("public");
      }
      check();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?,?)").run(operation.project_id, metadata.title, metadata.description, metadata.visibility, user.id, metadata.entrypoint, metadata.license, user.username, operation.repo_name, operation.provider_id);
        db.prepare("INSERT INTO project_metadata(project_id,source_project_id,source_commit,source_private,kind,derivation) VALUES (?,?,?,?,?,?)").run(operation.project_id, operation.source_project_id, operation.source_commit, operation.source_private, metadata.kind ?? "model", metadata.derivation ?? "fork");
        db.prepare("INSERT INTO project_access(project_id) VALUES (?)").run(operation.project_id);
        if (grantId) db.prepare("INSERT INTO agent_project_scopes(grant_id,project_id,permission) VALUES (?,?,?)").run(grantId, operation.project_id, "write");
        update("completed");
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return c.json({ project: projectForPrincipal(operation.project_id, principal)!, ref: "refs/heads/main", commit: operation.prepared_commit }, 201);
    } catch (error) {
      if (error instanceof GitError) throw new AuthoringError(502, "provision_incomplete", "Provisioning is incomplete; retry with the same request ID");
      throw error;
    } finally { await removeRepository(repository); }
  });
}
authoring.post("/projects", (c) => provision(c, "create"));
authoring.post("/projects/:id/extractions", (c) => provision(c, "extraction", c.req.param("id")));
authoring.post("/projects/:id/forks", (c) => provision(c, "fork", c.req.param("id")));

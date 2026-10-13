import { Hono } from "hono";
import { db } from "./db.ts";
import { AuthoringError, body, currentProject, type ApiContext } from "./authoring.ts";
import { actor, repositoryUrl, sourceTree } from "./forgejo.ts";
import { fetchCommit, operationRepository, prepareCommit, pushCommit, remoteHead, removeRepository, validateCommitRequest } from "./git.ts";
import type { Draft, FileChange, User } from "../shared/contracts.ts";
import type { Principal } from "./auth.ts";

export const drafts = new Hono<{ Variables: { user: User | undefined; principal: Principal | undefined } }>();
interface DraftRow {
  ref: string; base_commit: string; version: number; changes: string; updated_at: number;
  saving_commit: string | null; saving_directory: string | null; last_saved_version: number | null;
}
function row(projectId: string, userId: string) {
  return db.prepare("SELECT * FROM project_drafts WHERE project_id=? AND user_id=?").get(projectId, userId) as unknown as DraftRow | undefined;
}
export function readDraft(projectId: string, userId: string): Draft | null {
  const value = row(projectId, userId);
  return value ? { ref: value.ref, baseCommit: value.base_commit, version: value.version,
    changes: JSON.parse(value.changes), updatedAt: value.updated_at, savingCommit: value.saving_commit } : null;
}
export function draftVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new AuthoringError(400, "invalid_draft", "Use a nonnegative expectedVersion");
  return value as number;
}
export function checkDraft(projectId: string, userId: string, expectedVersion: number, allowSaving = false) {
  const draft = readDraft(projectId, userId);
  if ((draft?.version ?? 0) !== expectedVersion) throw new AuthoringError(409, "stale_draft", "The draft changed in another editor. Reload it before making further changes.", { currentVersion: draft?.version ?? 0 });
  if (draft?.savingCommit && !allowSaving) throw new AuthoringError(409, "draft_busy", "A version save is pending. Retry Save version to finish it.");
  return draft;
}
// Full replacement plus a version check prevents a late autosave overwriting newer work.
export function writeDraft(projectId: string, userId: string, expectedVersion: number, ref: string, baseCommit: string, changes: FileChange[]) {
  checkDraft(projectId, userId, expectedVersion);
  db.prepare(`INSERT INTO project_drafts(project_id,user_id,ref,base_commit,version,changes,updated_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET
    ref=excluded.ref,base_commit=excluded.base_commit,version=excluded.version,changes=excluded.changes,updated_at=excluded.updated_at,last_saved_version=NULL`).run(
    projectId, userId, ref, baseCommit, expectedVersion + 1, JSON.stringify(changes), Date.now());
  return readDraft(projectId, userId)!;
}
function fields(value: Record<string, unknown>, names: string[]) {
  if (Object.keys(value).some(key => !names.includes(key))) throw new AuthoringError(400, "invalid_draft", "Unknown draft field");
}
export function validateDraftChanges(ref: unknown, baseCommit: unknown, changes: unknown) {
  if (!Array.isArray(changes)) throw new AuthoringError(400, "invalid_draft", "Use an array of file changes");
  validateCommitRequest({ ref, expectedCommit: baseCommit, message: "Draft", changes: changes.length ? changes : [{ operation: "create", path: "validation", content: "" }] });
  // Git's ref format rules, without invoking Git on every keystroke.
  if (typeof ref !== "string" || /[\x00-\x20\x7f~^:?*\[\\]/.test(ref) || ref.includes("..") || ref.includes("@{") || ref.endsWith(".") || ref.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock"))) throw new AuthoringError(400, "invalid_draft", "Use a valid branch ref");
  return changes as FileChange[];
}
drafts.get("/projects/:id/draft", c => {
  // Drafts belong to the person behind the session/token, never to public readers.
  const { user, project } = currentProject(c, c.req.param("id"), "write");
  return c.json({ draft: readDraft(project.id, user.id) });
});
drafts.put("/projects/:id/draft", async c => {
  const { user, project } = currentProject(c, c.req.param("id"), "write");
  const value = await body(c);
  fields(value, ["expectedVersion", "ref", "baseCommit", "changes"]);
  const version = draftVersion(value.expectedVersion);
  checkDraft(project.id, user.id, version);
  const changes = validateDraftChanges(value.ref, value.baseCommit, value.changes);
  const tree = await sourceTree(project, value.baseCommit as string, user);
  if (tree.commit !== value.baseCommit) throw new AuthoringError(400, "invalid_draft", "Use an exact base commit");
  const paths = new Set(tree.files.map(file => file.path));
  for (const change of changes) {
    if (change.operation === "create" ? paths.has(change.path) : !paths.has(change.path)) throw new AuthoringError(400, "invalid_draft", "Create requires a new path; update/delete requires an existing file");
    if (change.operation === "create" && tree.files.some(file => file.path.startsWith(`${change.path}/`) || change.path.startsWith(`${file.path}/`))) throw new AuthoringError(400, "invalid_draft", "A new file conflicts with the base tree");
  }
  currentProject(c, project.id, "write", user);
  return c.json({ draft: writeDraft(project.id, user.id, version, value.ref as string, tree.commit, changes) });
});
drafts.delete("/projects/:id/draft", async c => {
  const { user, project } = currentProject(c, c.req.param("id"), "write");
  const value = await body(c);
  fields(value, ["expectedVersion"]);
  const version = draftVersion(value.expectedVersion);
  const draft = checkDraft(project.id, user.id, version);
  currentProject(c, project.id, "write", user);
  return c.json({ draft: draft ? writeDraft(project.id, user.id, version, draft.ref, draft.baseCommit, []) : null });
});

const saves = new Set<string>();
drafts.post("/projects/:id/draft/save", async (c: ApiContext) => {
  const { user, project } = currentProject(c, c.req.param("id")!, "write");
  const value = await body(c);
  fields(value, ["expectedVersion", "message"]);
  const version = draftVersion(value.expectedVersion);
  const key = `${project.id}:${user.id}`;
  if (saves.has(key)) throw new AuthoringError(409, "draft_busy", "A version save is in progress");
  const existing = row(project.id, user.id);
  // A lost HTTP response can be retried without creating a second version.
  if (existing?.last_saved_version === version && existing.version === version + 1) return c.json({ ref: existing.ref, commit: existing.base_commit, draft: readDraft(project.id, user.id) });
  const draft = checkDraft(project.id, user.id, version, true);
  if (!draft?.changes.length) throw new AuthoringError(422, "no_changes", "The draft has no changes");
  const message = value.message === undefined || value.message === "" ? `Update ${draft.changes.length === 1 ? draft.changes[0]!.path : `${draft.changes.length} files`}` : value.message;
  const request = validateCommitRequest({ ref: draft.ref, expectedCommit: draft.baseCommit, changes: draft.changes, message });
  saves.add(key);
  const url = repositoryUrl(project.forgejoOwner, project.forgejoRepo);
  let repository: Awaited<ReturnType<typeof operationRepository>> | undefined;
  let retained = false;
  try {
    repository = await operationRepository(actor(user));
    await sourceTree(project, draft.baseCommit, user);
    if (existing?.saving_commit) {
      // Keep the prepared object until Git and SQLite agree, including across restart.
      await fetchCommit(repository, existing.saving_directory!, existing.saving_commit);
    } else {
      await fetchCommit(repository, url, draft.baseCommit);
    }
    const commit = existing?.saving_commit ?? await prepareCommit(repository, request, user);
    currentProject(c, project.id, "write", user);
    checkDraft(project.id, user.id, version, true);
    if (!existing?.saving_commit) {
      db.prepare("UPDATE project_drafts SET saving_commit=?,saving_directory=? WHERE project_id=? AND user_id=? AND version=?").run(commit, repository.directory, project.id, user.id, version);
      retained = true;
    }
    const head = await remoteHead(repository, url, draft.ref);
    if (head !== commit) {
      if (head !== draft.baseCommit) {
        db.prepare("UPDATE project_drafts SET saving_commit=NULL,saving_directory=NULL WHERE project_id=? AND user_id=? AND version=?").run(project.id, user.id, version);
        retained = false;
        if (existing?.saving_directory) await removeRepository({ ...repository, directory: existing.saving_directory });
        throw new AuthoringError(409, "stale_head", "The latest version changed. Your draft is preserved; reconcile it before saving a version.", { currentCommit: head });
      }
      currentProject(c, project.id, "write", user);
      let result;
      try { result = await pushCommit(repository, url, draft.ref, draft.baseCommit, commit); }
      catch { throw new AuthoringError(502, "save_outcome_unknown", "The save outcome is unknown. Retry this draft save to recover it."); }
      if (result !== "updated" && await remoteHead(repository, url, draft.ref) !== commit) throw new AuthoringError(409, "stale_head", "The latest version changed during save. Retry to inspect it; your draft is preserved.");
    }
    currentProject(c, project.id, "write", user);
    db.prepare(`UPDATE project_drafts SET base_commit=?,changes='[]',version=version+1,updated_at=?,
      saving_commit=NULL,saving_directory=NULL,last_saved_version=? WHERE project_id=? AND user_id=? AND version=?`).run(commit, Date.now(), version, project.id, user.id, version);
    retained = false;
    if (existing?.saving_directory) await removeRepository({ ...repository, directory: existing.saving_directory });
    return c.json({ ref: draft.ref, commit, draft: readDraft(project.id, user.id) }, 201);
  } finally {
    saves.delete(key);
    if (repository && !retained) await removeRepository(repository);
  }
});

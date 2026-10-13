import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { createHash } from "node:crypto";
import { cookieName, readPrincipal, type Principal } from "./auth.ts";
import { projectForPrincipal } from "./db.ts";
import { actor, repositoryUrl, sourceTree, SourceError, validCommit } from "./forgejo.ts";
import { authoringPath, fetchCommit, git, operationRepository, prepareCommit, pushCommit, remoteHead, removeRepository, validateCommitRequest, type GitRepository } from "./git.ts";
import { AuthoringError } from "./authoring.ts";
import { checkDraft, draftVersion, readDraft, validateDraftChanges, writeDraft } from "./drafts.ts";
import type { FileChange, LibraryPin, LibraryDependency, Project, User } from "../shared/contracts.ts";

type ApiContext = Context<{ Variables: { user: User | undefined; principal: Principal | undefined } }>;
export const libraries = new Hono<{ Variables: { user: User | undefined; principal: Principal | undefined } }>();
const lockPath = "lab.lock.json";
const libraryPath = (path: unknown): path is string => authoringPath(path) && !path.includes("\ufffd");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function invalid(message: string): never { throw new SourceError(422, "invalid_library", message); }
const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
export function selectedPaths(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 90 || value.some((path) => !libraryPath(path)) || new Set(value).size !== value.length) invalid("Select between 1 and 90 distinct ordinary relative file paths");
  return value as string[];
}
function principal(c: ApiContext) { return readPrincipal(getCookie(c, cookieName), c.req.header("Authorization")); }
function project(c: ApiContext, id: string, write = false, user?: User) {
  const session = principal(c);
  if (user && session?.user.id !== user.id) throw new AuthoringError(401, "session_changed", "The original session is no longer valid");
  const result = projectForPrincipal(id, session);
  if (!result) throw new AuthoringError(404, "not_found", "Project not found");
  if (write && (!session || result.permission === "read")) throw new AuthoringError(403, "forbidden", "You cannot change this project");
  return result;
}
interface Entry { mode: string; type: string; hash: string }
async function snapshot(repository: GitRepository, commit: string) {
  const entries = new Map<string, Entry>();
  const raw = (await git(repository, ["ls-tree", "-rz", "--full-tree", commit])).stdout;
  let offset = 0;
  while (offset < raw.length) {
    const end = raw.indexOf(0, offset);
    const record = raw.subarray(offset, end);
    offset = end + 1;
    const tab = record.indexOf(9);
    const pathBytes = record.subarray(tab + 1);
    const path = pathBytes.toString("utf8");
    // JSON cannot safely identify malformed UTF-8 names or replacement characters.
    if (!libraryPath(path) || !Buffer.from(path).equals(pathBytes)) continue;
    const [mode, type, hash] = record.subarray(0, tab).toString("ascii").split(" ");
    entries.set(path, { mode: mode!, type: type!, hash: hash! });
  }
  const cache = new Map<string, Buffer>();
  return {
    entries,
    async file(path: string) {
      const entry = entries.get(path);
      if (!entry || entry.type !== "blob" || !["100644", "100755"].includes(entry.mode) || !libraryPath(path)) invalid(`Missing or unsupported ordinary file: ${path}`);
      if (!cache.has(path)) {
        const bytes = (await git(repository, ["cat-file", "blob", entry.hash])).stdout;
        if (bytes.length > 2_000_000) throw new SourceError(413, "content_too_large", `File exceeds 2 MB: ${path}`);
        cache.set(path, bytes);
      }
      return cache.get(path)!;
    },
  };
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
function parseManifest(bytes: Buffer): LibraryPin[] {
  let value: any;
  try { value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)); } catch { invalid("lab.lock.json must contain valid UTF-8 JSON"); }
  if (!value || value.version !== 1 || Object.keys(value).some((key) => !["version", "libraries"].includes(key)) || !Array.isArray(value.libraries) || value.libraries.length > 32) invalid("lab.lock.json requires version 1 and at most 32 libraries");
  const directories: string[] = [];
  const paths: string[] = [];
  for (const pin of value.libraries) {
    if (!pin || Object.keys(pin).some((key) => !["projectId", "commit", "directory", "files"].includes(key)) || typeof pin.projectId !== "string" || !pin.projectId || typeof pin.commit !== "string" || !validCommit(pin.commit) || !libraryPath(pin.directory) || overlaps(pin.directory, lockPath) || directories.some((dir) => overlaps(dir, pin.directory)) || !Array.isArray(pin.files) || !pin.files.length || pin.files.length > 90) invalid("Invalid or overlapping library pin in lab.lock.json");
    directories.push(pin.directory);
    const sources = new Set<string>();
    for (const file of pin.files) {
      if (!file || Object.keys(file).some((key) => !["source", "path", "sha256"].includes(key)) || !libraryPath(file.source) || !libraryPath(file.path) || file.path !== `${pin.directory}/${file.source}` || !/^[a-f0-9]{64}$/.test(file.sha256) || sources.has(file.source) || paths.some((path) => overlaps(path, file.path))) invalid("Invalid, duplicate or overlapping library file in lab.lock.json");
      sources.add(file.source); paths.push(file.path);
    }
  }
  return value.libraries;
}
async function manifest(tree: Snapshot, prefix = "") {
  const path = `${prefix}${lockPath}`;
  return tree.entries.has(path) ? parseManifest(await tree.file(path)) : [];
}
async function unchanged(tree: Snapshot, pin: LibraryPin, prefix = "") {
  for (const file of pin.files) {
    const path = `${prefix}${file.path}`;
    if (!tree.entries.has(path) || sha256(await tree.file(path)) !== file.sha256) return false;
  }
  return true;
}
async function dependencies(c: ApiContext, tree: Snapshot, prefix = "", depth = 0, budget = { count: 0 }): Promise<LibraryDependency[]> {
  if (depth > 8) invalid("Library dependency hierarchy exceeds 8 levels");
  const pins = await manifest(tree, prefix);
  const results: LibraryDependency[] = [];
  for (const pin of pins) {
    if (++budget.count > 64) invalid("Library dependency hierarchy exceeds 64 entries");
    results.push({ ...pin, project: projectForPrincipal(pin.projectId, principal(c)) ?? null, modified: !await unchanged(tree, pin, prefix), children: await dependencies(c, tree, `${prefix}${pin.directory}/`, depth + 1, budget) });
  }
  return results;
}
function utf8(bytes: Buffer, path: string) {
  try {
    const content = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (content.includes("\0")) invalid(`File is not ordinary UTF-8 text: ${path}`);
    return content;
  } catch { invalid(`File is not ordinary UTF-8 text: ${path}`); }
}
async function requestBody(c: ApiContext) {
  // Bound bytes before parsing, including DELETE requests.
  const reader = c.req.raw.body?.getReader();
  if (!reader) invalid("Use a JSON request object");
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 100_000) { await reader.cancel(); throw new SourceError(413, "request_too_large", "Library request exceeds 100 KB"); } chunks.push(part.value); } } finally { reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { invalid("Use a valid JSON request object"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Use a JSON request object");
  return value as Record<string, unknown>;
}
libraries.get("/projects/:id/libraries", async (c) => {
  const useDraft = c.req.query("draft") === "1";
  const target = project(c, c.req.param("id"), useDraft);
  const draftUser = useDraft ? principal(c)!.user : undefined;
  const draft = draftUser ? readDraft(target.id, draftUser.id) : null;
  const ref = draft?.baseCommit ?? c.req.query("commit") ?? "main";
  const selected = await sourceTree(target, ref, c.get("user"));
  const repository = await operationRepository(actor(c.get("user")));
  try {
    await fetchCommit(repository, repositoryUrl(target.forgejoOwner, target.forgejoRepo), selected.commit);
    const commit = draft?.changes.length ? await draftSnapshot(repository, draft.ref, selected.commit, draft.changes, draftUser!) : selected.commit;
    const result = await dependencies(c, await snapshot(repository, commit));
    project(c, target.id, useDraft, draftUser);
    function refresh(items: LibraryDependency[]) {
      for (const item of items) {
        item.project = projectForPrincipal(item.projectId, principal(c)) ?? null;
        refresh(item.children);
      }
    }
    refresh(result);
    return c.json({ commit: selected.commit, libraries: result });
  } finally { await removeRepository(repository); }
});
async function draftSnapshot(repository: GitRepository, ref: string, base: string, changes: FileChange[], user: User) {
  try { return await prepareCommit(repository, { ref, expectedCommit: base, message: "Draft library operation", changes }, user); }
  catch (error) { if (error instanceof SourceError && error.code === "no_changes") return base; throw error; }
}
async function mutate(c: ApiContext, remove: boolean) {
  const target = project(c, c.req.param("id")!, true);
  const user = principal(c)!.user;
  const request = await requestBody(c);
  const useDraft = c.req.path.includes("/draft/");
  const allowed = ["ref", "expectedCommit", "directory", "message", ...(useDraft ? ["expectedVersion"] : []), ...(remove ? [] : ["libraryId", "commit", "paths"])];
  if (Object.keys(request).some((field) => !allowed.includes(field)) || !libraryPath(request.directory) || overlaps(request.directory, lockPath)) invalid("Use an ordinary destination directory and known request fields");
  const directory = request.directory;
  // Reuse ordinary commit validation for branch, SHA and message.
  validateCommitRequest({ ref: request.ref, expectedCommit: request.expectedCommit, message: request.message, changes: [{ operation: "create", path: "validation", content: "" }] });
  const expected = request.expectedCommit as string;
  const version = useDraft ? draftVersion(request.expectedVersion) : 0;
  const draft = useDraft ? checkDraft(target.id, user.id, version) : null;
  if (draft && (draft.baseCommit !== expected || draft.ref !== request.ref)) throw new AuthoringError(409, "stale_draft", "Use the current draft base and branch");
  await sourceTree(target, expected, user);
  const repository = await operationRepository(actor(user));
  const url = repositoryUrl(target.forgejoOwner, target.forgejoRepo);
  try {
    await fetchCommit(repository, url, expected);
    const currentCommit = draft?.changes.length ? await draftSnapshot(repository, draft.ref, expected, draft.changes, user) : expected;
    const tree = await snapshot(repository, currentCommit);
    const pins = await manifest(tree);
    const previous = pins.find((pin) => pin.directory === directory);
    if (previous && !await unchanged(tree, previous)) throw new AuthoringError(409, "library_modified", "Installed library files changed; preserve or revert your edits before updating or removing");
    if (pins.some((pin) => pin !== previous && overlaps(pin.directory, directory))) invalid("Library destination directories overlap");
    const changes: FileChange[] = [];
    let next: LibraryPin | undefined;
    let upstream: Project | undefined;
    if (!remove) {
      if (typeof request.libraryId !== "string" || typeof request.commit !== "string" || !validCommit(request.commit)) invalid("Select a library and exact commit SHA");
      upstream = project(c, request.libraryId);
      if (upstream.kind !== "library") invalid("Select a library project");
      if (upstream.visibility === "private" && target.visibility !== "private") invalid("A private library requires a private destination");
      if (previous && previous.projectId !== upstream.id) invalid("This directory belongs to another library; remove it explicitly first");
      await sourceTree(upstream, request.commit, user);
      await fetchCommit(repository, repositoryUrl(upstream.forgejoOwner, upstream.forgejoRepo), request.commit);
      const source = await snapshot(repository, request.commit);
      const paths = new Set(selectedPaths(request.paths));
      // Dependencies are already ordinary vendored source in the selected upstream revision.
      async function closure(prefix = "", depth = 0, count = { value: 0 }) {
        if (depth > 8) invalid("Library dependency hierarchy exceeds 8 levels");
        const nested = await manifest(source, prefix);
        if (source.entries.has(`${prefix}${lockPath}`)) paths.add(`${prefix}${lockPath}`);
        for (const pin of nested) {
          if (++count.value > 64) invalid("Library dependency hierarchy exceeds 64 entries");
          if (!await unchanged(source, pin, prefix)) invalid("Upstream library has missing or modified dependency files; repair its lock before installation");
          for (const file of pin.files) paths.add(`${prefix}${file.path}`);
          await closure(`${prefix}${pin.directory}/`, depth + 1, count);
        }
      }
      await closure();
      if (paths.size > 90) invalid("Library installation exceeds 90 files");
      const files: LibraryPin["files"] = []; let total = 0;
      for (const sourcePath of [...paths].sort()) {
        const bytes = await source.file(sourcePath); total += bytes.length;
        if (total > 4_000_000) throw new SourceError(413, "content_too_large", "Library installation exceeds 4 MB");
        const path = `${directory}/${sourcePath}`;
        if (!libraryPath(path)) invalid("Destination path exceeds the supported length");
        const existing = tree.entries.has(path);
        const recorded = previous?.files.some((file) => file.path === path);
        if (existing && !recorded && !bytes.equals(await tree.file(path))) throw new AuthoringError(409, "library_collision", `Destination file differs: ${path}`);
        if (!existing || !bytes.equals(await tree.file(path))) changes.push({ operation: existing ? "update" : "create", path, content: utf8(bytes, sourcePath) });
        else utf8(bytes, sourcePath);
        files.push({ source: sourcePath, path, sha256: sha256(bytes) });
      }
      next = { projectId: upstream.id, commit: request.commit, directory, files };
    } else if (!previous) invalid("No installed library uses this directory");
    for (const file of previous?.files ?? []) if (!next?.files.some((item) => item.path === file.path)) changes.push({ operation: "delete", path: file.path });
    const updated = pins.filter((pin) => pin !== previous);
    if (next) updated.push(next);
    changes.push({ operation: tree.entries.has(lockPath) ? "update" : "create", path: lockPath, content: JSON.stringify({ version: 1, libraries: updated }, null, 2) + "\n" });
    const commit = await prepareCommit(repository, validateCommitRequest({ ref: request.ref, expectedCommit: currentCommit, message: request.message, changes }), user);
    // Validate the complete proposed snapshot, including aggregate hierarchy limits.
    await dependencies(c, await snapshot(repository, commit));
    const current = project(c, target.id, true, user);
    if (upstream) {
      const source = project(c, upstream.id, false, user);
      if (source.visibility === "private" && current.visibility !== "private") invalid("A private library requires a private destination");
    }
    if (useDraft) {
      // Flatten the resulting source back into one overlay against its saved base.
      const base = await snapshot(repository, expected);
      const nextTree = await snapshot(repository, commit);
      const overlay: FileChange[] = [];
      for (const path of new Set([...base.entries.keys(), ...nextTree.entries.keys()])) {
        const before = base.entries.get(path), after = nextTree.entries.get(path);
        if (before?.hash === after?.hash) continue;
        if (!after) overlay.push({ operation: "delete", path });
        else overlay.push({ operation: before ? "update" : "create", path, content: utf8(await nextTree.file(path), path) });
      }
      validateDraftChanges(request.ref, expected, overlay);
      const destination = project(c, target.id, true, user);
      if (upstream && project(c, upstream.id, false, user).visibility === "private" && destination.visibility !== "private") invalid("A private library requires a private destination");
      return c.json({ draft: writeDraft(target.id, user.id, version, request.ref as string, expected, overlay) });
    }
    let result;
    try { result = await pushCommit(repository, url, request.ref as string, expected, commit); } catch { throw new AuthoringError(502, "save_outcome_unknown", "The save outcome is unknown; inspect the branch before saving again"); }
    if (result === "conflict") throw new AuthoringError(409, "stale_head", "The branch changed; keep your input and inspect the current source", { ref: request.ref, expectedCommit: expected, currentCommit: await remoteHead(repository, url, request.ref as string) });
    return c.json({ ref: request.ref, commit }, 201);
  } finally { await removeRepository(repository); }
}
libraries.post("/projects/:id/libraries", (c) => mutate(c, false));
libraries.delete("/projects/:id/libraries", (c) => mutate(c, true));
libraries.post("/projects/:id/draft/libraries", (c) => mutate(c, false));
libraries.delete("/projects/:id/draft/libraries", (c) => mutate(c, true));

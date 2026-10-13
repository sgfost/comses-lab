import { settings, credentials, type Credential } from "./config.ts";
import type {
  Project,
  User,
  SourceTree,
  RefKind,
  RefList,
  CommitHistory,
  CommitDiff,
} from "../shared/contracts.ts";
export class SourceError extends Error {
  constructor(
    public status: 400 | 409 | 413 | 422,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export class ForgejoError extends Error {
  constructor(public status: number) {
    super(`Forgejo request failed (${status})`);
  }
}
async function forgejoResponse(
  path: string,
  actor?: Pick<Credential, "username" | "password">,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (actor)
    headers.set(
      "Authorization",
      `Basic ${Buffer.from(`${actor.username}:${actor.password}`).toString("base64")}`,
    );
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${settings.forgejoUrl}/api/v1${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 409)
      throw new SourceError(
        409,
        "empty_repository",
        "The repository has no commits",
      );
    throw new ForgejoError(response.status);
  }
  return response;
}
export async function forgejo<T>(
  path: string,
  actor?: Pick<Credential, "username" | "password">,
  init: RequestInit = {},
): Promise<T> {
  const response = await forgejoResponse(path, actor, init);
  return response.status === 204
    ? (undefined as T)
    : ((await response.json()) as T);
}
export function actor(user?: User) {
  if (!user) return credentials().reader;
  const credential = credentials().users.find(
    (item) => item.username === user.username,
  );
  if (!credential) throw new Error("No Forgejo identity");
  return credential;
}
function repoPath(project: Project) {
  return `/repos/${encodeURIComponent(project.forgejoOwner)}/${encodeURIComponent(project.forgejoRepo)}`;
}
export async function sourceTree(
  project: Project,
  ref: string,
  user?: User,
): Promise<SourceTree> {
  const repo = repoPath(project);
  if (!validSourceRef(ref))
    throw new SourceError(
      400,
      "invalid_ref",
      "Use a branch, tag, or full commit",
    );
  let resolved;
  if (validCommit(ref) || ref.startsWith("refs/")) {
    resolved = await readCommit(project, ref, user);
  } else {
    try {
      resolved = await readCommit(project, `refs/heads/${ref}`, user);
    } catch (error) {
      if (!(error instanceof ForgejoError && error.status === 404)) throw error;
      resolved = await readCommit(project, `refs/tags/${ref}`, user);
    }
  }
  const commit = resolved;
  const tree = await forgejo<{
    tree: { path: string; type: string; size: number }[];
    truncated: boolean;
  }>(`${repo}/git/trees/${commit.sha}?recursive=true`, actor(user));
  if (tree.truncated)
    throw new SourceError(
      413,
      "tree_too_large",
      "Repository tree exceeds the supported size",
    );
  return {
    commit: commit.sha,
    files: tree.tree
      .filter((f) => f.type === "blob")
      .map(({ path, size }) => ({ path, size })),
  };
}
export function validSourcePath(path: string) {
  return (
    path.length > 0 &&
    path.length <= 500 &&
    !/[\\\x00-\x1f]/.test(path) &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}
export async function sourceFile(
  project: Project,
  commit: string,
  path: string,
  user?: User,
): Promise<Buffer> {
  if (!validCommit(commit) || !validSourcePath(path))
    throw new SourceError(
      400,
      "invalid_source",
      "An exact commit and file path are required",
    );
  await exactCommit(project, commit, user);
  // JSON cannot distinguish a literal replacement character from invalid Git
  // filename bytes. Keep those paths available through ordinary Git only.
  if (path.includes("\ufffd"))
    throw new SourceError(422, "unsupported_file", "This source path cannot be represented safely through the JSON API");
  // Contents can return [] while Forgejo's post-receive empty flag is stale.
  // Read the committed tree and blob directly instead of that mutable flag.
  const tree = await forgejo<{
    tree: { path: string; type: string; mode: string; sha: string; size: number }[];
    truncated: boolean;
  }>(`${repoPath(project)}/git/trees/${commit}?recursive=true`, actor(user));
  if (tree.truncated) throw new SourceError(413, "tree_too_large", "Repository tree exceeds the supported size");
  const matches = tree.tree.filter((entry) => entry.path === path);
  if (matches.length > 1) throw new SourceError(422, "unsupported_file", "The source path is ambiguous");
  const entry = matches[0];
  if (!entry) throw new ForgejoError(404);
  if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode) || entry.size > 2_000_000)
    throw new SourceError(422, "unsupported_file", "Only ordinary files up to 2 MB are supported");
  const file = await forgejo<{
    content: string;
    encoding: string;
    size: number;
  }>(
    `${repoPath(project)}/git/blobs/${entry.sha}`,
    actor(user),
  );
  if (
    file.encoding !== "base64" ||
    file.size > 2_000_000
  )
    throw new SourceError(
      422,
      "unsupported_file",
      "Only ordinary files up to 2 MB are supported",
    );
  return Buffer.from(file.content, "base64");
}

export function validCommit(commit: string) {
  return /^[a-f0-9]{40}$/.test(commit);
}
export function validSourceRef(ref: string) {
  if (validCommit(ref)) return true;
  if (ref.startsWith("refs/")) {
    if (!/^refs\/(heads|tags)\//.test(ref)) return false;
    ref = ref.replace(/^refs\/(heads|tags)\//, "");
  }
  return (
    ref.length > 0 &&
    ref.length <= 200 &&
    !/[\x00-\x20\x7f~^:?*\[\\]/.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("@{") &&
    ref !== "@" &&
    !ref.startsWith("-") &&
    !ref.endsWith(".") &&
    ref
      .split("/")
      .every(
        (part) =>
          part !== "" && !part.startsWith(".") && !part.endsWith(".lock"),
      )
  );
}
interface ForgejoCommit {
  sha: string;
  parents: { sha: string }[];
  commit: { message: string; author: { name: string; date: string } };
}
async function readCommit(
  project: Project,
  ref: string,
  user?: User,
): Promise<ForgejoCommit> {
  try {
    return await forgejo<ForgejoCommit>(
      `${repoPath(project)}/git/commits/${encodeURIComponent(ref)}?stat=false&files=false&verification=false`,
      actor(user),
    );
  } catch (error) {
    if (error instanceof ForgejoError && error.status === 404) {
      const repo = await forgejo<{ empty: boolean }>(
        repoPath(project),
        actor(user),
      );
      if (repo.empty)
        throw new SourceError(
          409,
          "empty_repository",
          "The repository has no commits",
        );
    }
    throw error;
  }
}
function nextPage(response: Response, page: number) {
  // Only inspect pagination metadata; never follow a provider-supplied URL.
  return /;\s*rel="next"/.test(response.headers.get("Link") ?? "")
    ? page + 1
    : null;
}
export async function sourceRefs(
  project: Project,
  kind: RefKind,
  page: number,
  limit: number,
  user?: User,
): Promise<RefList> {
  const repo = repoPath(project);
  const metadata = await forgejo<{ default_branch: string; empty: boolean }>(
    repo,
    actor(user),
  );
  // Forgejo's empty flag and branch index can lag a completed Git push.
  // Inspect real refs rather than interpreting that lag as an empty repository.
  const { operationRepository, git, removeRepository } = await import("./git.ts");
  const repository = await operationRepository(actor(user));
  let output: Buffer;
  try {
    output = (await git(repository, [
      "ls-remote", "--refs", "--",
      repositoryUrl(project.forgejoOwner, project.forgejoRepo),
      "refs/heads/*", "refs/tags/*",
    ])).stdout;
  } finally {
    await removeRepository(repository);
  }
  const decoded = output.toString("utf8");
  if (!Buffer.from(decoded).equals(output))
    throw new SourceError(422, "unsupported_refs", "Ref names must be well-formed UTF-8");
  const actual = decoded.split("\n").filter(Boolean).map((line) => {
    const [commit, ref] = line.split("\t");
    if (!commit || !validCommit(commit) || !ref || !/^refs\/(heads|tags)\//.test(ref))
      throw new Error("Invalid upstream Git ref response");
    return { commit, ref };
  });
  if (actual.length === 0)
    throw new SourceError(409, "empty_repository", "The repository has no commits");
  const prefix = kind === "branch" ? "refs/heads/" : "refs/tags/";
  const selected = actual.filter(({ ref }) => ref.startsWith(prefix))
    .sort((a, b) => Buffer.compare(Buffer.from(a.ref), Buffer.from(b.ref)));
  const start = (page - 1) * limit;
  const refs = selected.slice(start, start + limit);
  return {
    kind,
    defaultBranch: metadata.default_branch,
    page,
    limit,
    nextPage: start + limit < selected.length ? page + 1 : null,
    refs: await Promise.all(
      refs.map(async (ref) => ({
        name: ref.ref.slice(prefix.length),
        ref: ref.ref,
        // Annotated tags may point to other tags. Resolve the object, not its mutable name.
        commit:
          kind === "branch"
            ? ref.commit
            : (await readCommit(project, ref.commit, user)).sha,
      })),
    ),
  };
}
export async function sourceHistory(
  project: Project,
  commit: string,
  page: number,
  limit: number,
  user?: User,
): Promise<CommitHistory> {
  await exactCommit(project, commit, user);
  const response = await forgejoResponse(
    `${repoPath(project)}/commits?sha=${commit}&page=${page}&limit=${limit}&stat=false&files=false&verification=false`,
    actor(user),
  );
  const commits = (await response.json()) as ForgejoCommit[];
  return {
    commit,
    page,
    limit,
    nextPage: nextPage(response, page),
    commits: commits.map((item) => ({
      commit: item.sha,
      parents: item.parents.map((parent) => parent.sha),
      message: item.commit.message,
      author: { name: item.commit.author.name, date: item.commit.author.date },
    })),
  };
}
export async function sourceDiff(
  project: Project,
  commit: string,
  user?: User,
): Promise<CommitDiff> {
  const detail = await exactCommit(project, commit, user);
  const response = await forgejoResponse(
    `${repoPath(project)}/git/commits/${commit}.diff`,
    actor(user),
  );
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body!.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2_000_000) {
        await reader.cancel();
        throw new SourceError(
          413,
          "diff_too_large",
          "Diff exceeds the 2 MB display limit",
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  let patch: string;
  try {
    patch = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new SourceError(
      422,
      "unsupported_diff",
      "Diff contains text that is not UTF-8",
    );
  }
  const base = detail.parents[0]?.sha ?? null;
  // Forgejo uses git show for a root commit; omit its commit-message header.
  if (base === null) {
    const start = patch.search(/^diff --git /m);
    patch = start < 0 ? "" : patch.slice(start);
  }
  return { commit, base, patch };
}

async function exactCommit(project: Project, commit: string, user?: User) {
  const detail = await readCommit(project, commit, user);
  if (detail.sha !== commit)
    throw new SourceError(
      400,
      "invalid_commit",
      "Use the resolved commit SHA, not a tag object",
    );
  return detail;
}

export function repositoryUrl(owner: string, name: string) {
  return `${settings.forgejoUrl}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}.git`;
}
export async function lookupRepository(owner: string, name: string, user: User) {
  try {
    return await forgejo<{ id: number; private: boolean }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, actor(user));
  } catch (error) {
    if (error instanceof ForgejoError && error.status === 404) return null;
    throw error;
  }
}
export function createRepository(name: string, user: User) {
  return forgejo<{ id: number; private: boolean }>("/user/repos", actor(user), {
    method: "POST", body: JSON.stringify({ name, private: true, auto_init: false, default_branch: "main" }),
  });
}
export function publishRepository(owner: string, name: string, user: User) {
  return forgejo(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, actor(user), {
    method: "PATCH", body: JSON.stringify({ private: false }),
  });
}

export type AccessRepository = { id: number; private: boolean; owner: { id: number } };
export function accessRepository(owner: string, name: string, user: User) {
  return forgejo<AccessRepository>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, actor(user));
}
export function providerUser(username: string, user: User) {
  return forgejo<{ id: number }>(`/users/${encodeURIComponent(username)}`, actor(user));
}
export async function collaboratorPermission(owner: string, repo: string, username: string, user: User) {
  try {
    // Permission on a public repo can be "read" without a collaborator grant.
    await forgejo(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}`, actor(user));
    const result = await forgejo<{ permission: string }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}/permission`, actor(user));
    return result.permission === "none" ? null : result.permission;
  } catch (error) {
    if (error instanceof ForgejoError && error.status === 404) return null;
    throw error;
  }
}
export function changeCollaborator(owner: string, repo: string, username: string, permission: "read" | "write" | null, user: User) {
  return forgejo(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}`, actor(user), {
    method: permission ? "PUT" : "DELETE",
    ...(permission ? { body: JSON.stringify({ permission }) } : {}),
  });
}
export function changeRepositoryVisibility(owner: string, repo: string, visibility: "public" | "private", user: User) {
  return forgejo(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, actor(user), { method: "PATCH", body: JSON.stringify({ private: visibility === "private" }) });
}

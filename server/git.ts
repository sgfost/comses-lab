import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stateDir, type Credential } from "./config.ts";
import type { CommitRequest, RestoreRequest, User } from "../shared/contracts.ts";
import { SourceError, validCommit, validSourcePath } from "./forgejo.ts";

export class GitError extends Error {
  constructor(public unknown: boolean) { super("Git operation failed"); }
}
export interface GitRepository { directory: string; environment: NodeJS.ProcessEnv }

// Each operation has a private bare repository, index and credential helper.
export async function operationRepository(credential?: Pick<Credential, "username" | "password">): Promise<GitRepository> {
  const root = resolve(stateDir, "operations");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "git-"));
  const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: directory,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    GIT_INDEX_FILE: join(directory, "index"), LC_ALL: "C" };
  if (credential) {
    const helper = join(directory, "askpass");
    await writeFile(helper, '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "$LAB_GIT_USER" ;; *) printf "%s\\n" "$LAB_GIT_PASSWORD" ;; esac\n', { mode: 0o700 });
    environment.GIT_ASKPASS = helper;
    environment.LAB_GIT_USER = credential.username;
    environment.LAB_GIT_PASSWORD = credential.password;
  }
  const repository = { directory, environment };
  await git(repository, ["init", "--bare", directory]);
  return repository;
}
export async function removeRepository(repository: GitRepository) {
  await rm(repository.directory, { recursive: true, force: true });
}
export async function templateCommit(repository: GitRepository, files: { path: string; content: Buffer }[], user: User) {
  await git(repository, ["read-tree", "--empty"]);
  for (const file of files) {
    const hash = (await git(repository, ["hash-object", "-w", "--stdin"], file.content)).stdout.toString().trim();
    await git(repository, ["update-index", "-z", "--index-info"], `100644 ${hash}\t${file.path}\0`);
  }
  const tree = (await git(repository, ["write-tree"])).stdout.toString().trim();
  const identity = { ...repository, environment: { ...repository.environment,
    GIT_AUTHOR_NAME: user.displayName.replace(/[\r\n<>]/g, " "), GIT_AUTHOR_EMAIL: `${user.id}@lab.invalid`,
    GIT_COMMITTER_NAME: "CoMSES Lab", GIT_COMMITTER_EMAIL: "lab@lab.invalid" } };
  return (await git(identity, ["commit-tree", tree], "Create project from template")).stdout.toString().trim();
}
export async function git(repository: GitRepository, args: string[], input?: string | Buffer, allowFailure = false) {
  const result = await new Promise<{ status: number; stdout: Buffer }>((resolveResult, reject) => {
    const child = spawn("git", ["--git-dir", repository.directory, "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "http.followRedirects=false", ...args],
      { env: repository.environment, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const timer = setTimeout(() => { failed = true; child.kill("SIGKILL"); }, 30000);
    child.on("error", () => { clearTimeout(timer); reject(new GitError(false)); });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 20_000_000) { failed = true; child.kill("SIGKILL"); }
      else chunks.push(chunk);
    });
    // Provider diagnostics can contain credentials; never retain or log stderr.
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.on("close", (status) => {
      clearTimeout(timer);
      if (failed) reject(new GitError(true));
      else resolveResult({ status: status ?? 1, stdout: Buffer.concat(chunks) });
    });
  });
  if (result.status !== 0 && !allowFailure) throw new GitError(false);
  return result;
}
export async function fetchCommit(repository: GitRepository, url: string, commit: string) {
  await git(repository, ["fetch", "--no-tags", "--", url, commit]);
  const type = (await git(repository, ["cat-file", "-t", commit])).stdout.toString().trim();
  if (type !== "commit") throw new SourceError(400, "invalid_commit", "An exact commit SHA is required");
}
function invalid(message: string): never { throw new SourceError(400, "invalid_commit_request", message); }
export function authoringPath(path: unknown): path is string {
  return typeof path === "string" && Buffer.from(path).toString("utf8") === path && validSourcePath(path) && !/[\x7f-\x9f]/.test(path) &&
    !path.split("/").some((part) => part.toLowerCase() === ".git");
}
export function validateCommitRequest(value: unknown): CommitRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Use a commit request object");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["ref", "expectedCommit", "message", "changes"].includes(key))) invalid("Unknown commit field");
  if (typeof body.ref !== "string" || !body.ref.startsWith("refs/heads/") || body.ref.length > 200 || body.ref.includes("\0")) invalid("Use a full branch ref");
  if (typeof body.expectedCommit !== "string" || !validCommit(body.expectedCommit)) invalid("Use a full expected commit SHA");
  if (typeof body.message !== "string" || !body.message.trim() || body.message.length > 2000 || body.message.includes("\0")) invalid("Enter a commit message of at most 2000 characters");
  if (!Array.isArray(body.changes) || body.changes.length < 1 || body.changes.length > 100) invalid("Change between 1 and 100 files");
  const paths: string[] = [];
  let total = 0;
  for (const item of body.changes) {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalid("Invalid file change");
    const change = item as Record<string, unknown>;
    if (typeof change.operation !== "string" || !["create", "update", "delete"].includes(change.operation) || !authoringPath(change.path)) invalid("Invalid file operation or path");
    const allowed = change.operation === "delete" ? ["operation", "path"] : ["operation", "path", "content"];
    if (Object.keys(change).some((key) => !allowed.includes(key))) invalid("Unknown file change field");
    if (paths.some((path) => path === change.path || path.startsWith(`${change.path}/`) || (change.path as string).startsWith(`${path}/`))) invalid("File paths overlap");
    paths.push(change.path);
    if (change.operation !== "delete") {
      if (typeof change.content !== "string" || change.content.includes("\0") || Buffer.from(change.content).toString("utf8") !== change.content) invalid("Use well-formed UTF-8 text without NUL");
      const bytes = Buffer.byteLength(change.content);
      if (bytes > 2_000_000) throw new SourceError(413, "content_too_large", "File content exceeds 2 MB");
      total += bytes;
    }
  }
  if (total > 5_000_000) throw new SourceError(413, "content_too_large", "Changed content exceeds 5 MB");
  return body as unknown as CommitRequest;
}
export async function prepareCommit(repository: GitRepository, request: CommitRequest, user: User) {
  if ((await git(repository, ["check-ref-format", request.ref], undefined, true)).status !== 0) invalid("Invalid branch ref");
  const entries = new Map<string, { mode: string; type: string }>();
  const originalPaths: Buffer[] = [];
  const tree = (await git(repository, ["ls-tree", "-rz", "--full-tree", request.expectedCommit])).stdout;
  let offset = 0;
  while (offset < tree.length) {
    const end = tree.indexOf(0, offset);
    const entry = tree.subarray(offset, end);
    offset = end + 1;
    const tab = entry.indexOf(9);
    const [mode, type] = entry.subarray(0, tab).toString("ascii").split(" ");
    const bytes = entry.subarray(tab + 1);
    // Compare path bytes directly; Git names need not be valid UTF-8.
    entries.set(bytes.toString("hex"), { mode: mode!, type: type! });
    originalPaths.push(bytes);
  }
  await git(repository, ["read-tree", request.expectedCommit]);
  for (const change of request.changes) {
    const pathBytes = Buffer.from(change.path);
    const existing = entries.get(pathBytes.toString("hex"));
    if (change.operation === "create" ? !!existing : !existing || existing.type !== "blob" || !["100644", "100755"].includes(existing.mode))
      invalid("Create requires an absent path; update/delete requires an ordinary file");
    const startsWith = (path: Buffer, prefix: Buffer) => path.subarray(0, prefix.length).equals(prefix);
    if (change.operation === "create" && originalPaths.some((path) => startsWith(path, Buffer.concat([pathBytes, Buffer.from("/")])) || startsWith(pathBytes, Buffer.concat([path, Buffer.from("/")])))) invalid("File path collides with the existing tree");
    const record = change.operation === "delete" ? `0 ${"0".repeat(40)}\t${change.path}\0` :
      `${existing?.mode ?? "100644"} ${(await git(repository, ["hash-object", "-w", "--stdin"], change.content)).stdout.toString().trim()}\t${change.path}\0`;
    await git(repository, ["update-index", "-z", "--index-info"], record);
  }
  const newTree = (await git(repository, ["write-tree"])).stdout.toString().trim();
  const oldTree = (await git(repository, ["rev-parse", `${request.expectedCommit}^{tree}`])).stdout.toString().trim();
  if (newTree === oldTree) throw new SourceError(422, "no_changes", "The files have not changed");
  const identity = { ...repository, environment: { ...repository.environment,
    GIT_AUTHOR_NAME: user.displayName.replace(/[\r\n<>]/g, " "), GIT_AUTHOR_EMAIL: `${user.id}@lab.invalid`,
    GIT_COMMITTER_NAME: "CoMSES Lab", GIT_COMMITTER_EMAIL: "lab@lab.invalid" } };
  return (await git(identity, ["commit-tree", newTree, "-p", request.expectedCommit], request.message)).stdout.toString().trim();
}
export function validateRestoreRequest(value: Record<string, unknown>): RestoreRequest {
  if (Object.keys(value).some(key => !["ref", "expectedCommit", "sourceCommit"].includes(key))) invalid("Unknown restore field");
  if (typeof value.ref !== "string" || !value.ref.startsWith("refs/heads/") || value.ref.length > 200 || value.ref.includes("\0")) invalid("Use a full branch ref");
  if (typeof value.expectedCommit !== "string" || !validCommit(value.expectedCommit) || typeof value.sourceCommit !== "string" || !validCommit(value.sourceCommit)) invalid("Use exact source and expected revisions");
  return value as unknown as RestoreRequest;
}
export async function prepareRestore(repository: GitRepository, request: RestoreRequest, user: User) {
  if ((await git(repository, ["check-ref-format", request.ref], undefined, true)).status !== 0) invalid("Invalid branch ref");
  const tree = (await git(repository, ["rev-parse", `${request.sourceCommit}^{tree}`])).stdout.toString().trim();
  const currentTree = (await git(repository, ["rev-parse", `${request.expectedCommit}^{tree}`])).stdout.toString().trim();
  if (tree === currentTree) throw new SourceError(422, "no_changes", "This version already matches the latest files");
  const identity = { ...repository, environment: { ...repository.environment,
    GIT_AUTHOR_NAME: user.displayName.replace(/[\r\n<>]/g, " "), GIT_AUTHOR_EMAIL: `${user.id}@lab.invalid`,
    GIT_COMMITTER_NAME: "CoMSES Lab", GIT_COMMITTER_EMAIL: "lab@lab.invalid" } };
  return (await git(identity, ["commit-tree", tree, "-p", request.expectedCommit], `Restore earlier version\n\nSource: ${request.sourceCommit}`)).stdout.toString().trim();
}
export async function pushCommit(repository: GitRepository, url: string, ref: string, expected: string, commit: string) {
  const result = await git(repository, ["push", "--porcelain", `--force-with-lease=${ref}:${expected}`, "--", url, `${commit}:${ref}`], undefined, true);
  const lines = result.stdout.toString().split("\n");
  const line = lines.find((line) => line.split("\t")[1] === `${commit}:${ref}`);
  const flag = line?.split("\t")[0];
  if (result.status === 0 && (flag === " " || flag === "*" || flag === "+")) return "updated";
  if (flag === "=" || (flag === "!" && (line?.includes("[rejected]") || line?.includes("(failed to update ref)") || line?.includes("(incorrect old value provided)") || line?.includes("(reference does not exist)")))) return "conflict";
  throw new GitError(true);
}
export async function remoteHead(repository: GitRepository, url: string, ref: string) {
  const value = (await git(repository, ["ls-remote", "--refs", "--", url, ref])).stdout.toString().trim();
  return value ? value.split("\t")[0]! : null;
}

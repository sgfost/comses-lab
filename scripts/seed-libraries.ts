import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { db, projectById } from "../server/db.ts";
import { credentials } from "../server/config.ts";
import { forgejo, ForgejoError, repositoryUrl, sourceTree, sourceFile } from "../server/forgejo.ts";
import { operationRepository, removeRepository, remoteHead, templateCommit, pushCommit, fetchCommit, prepareCommit } from "../server/git.ts";
import type { Project, User } from "../shared/contracts.ts";

type Files = Map<string, Buffer>;
const license = `MIT License

Copyright (c) CoMSES Lab contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
const hash = (content: Buffer) => createHash("sha256").update(content).digest("hex");
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
async function example(directory: string, paths: string[]): Promise<Files> {
  const files: Files = new Map([["LICENSE", Buffer.from(license)]]);
  for (const path of paths) files.set(path, await readFile(new URL(`../examples/${directory}/${path}`, import.meta.url)));
  return files;
}
function dependency(project: Project, commit: string, files: Files, directory: string) {
  return { projectId: project.id, commit, directory, files: [...files].map(([source, content]) => ({ source, path: `${directory}/${source}`, sha256: hash(content) })) };
}
function include(files: Files, source: { project: Project; commit: string; files: Files }, directory: string) {
  for (const [path, content] of source.files) files.set(`${directory}/${path}`, content);
  files.set("lab.lock.json", json({ version: 1, libraries: [dependency(source.project, source.commit, source.files, directory)] }));
}

export async function seedLibraryExamples() {
  const owner = credentials().users.find(user => user.username === "ada")!;
  const user = db.prepare("SELECT id,username,display_name AS displayName FROM users WHERE username=?").get(owner.username) as unknown as User;

  async function ensure(name: string, title: string, kind: "model" | "library", initial: Files, description: string) {
    const existing = db.prepare("SELECT id,forgejo_id FROM projects WHERE forgejo_owner=? AND forgejo_repo=?").get(owner.username, name) as { id: string; forgejo_id: number } | undefined;
    let remote: { id: number } | undefined;
    try { remote = await forgejo(`/repos/${owner.username}/${name}`, owner); }
    catch (error) { if (!(error instanceof ForgejoError && error.status === 404)) throw error; }
    if (existing && (!remote || remote.id !== existing.forgejo_id)) throw new Error(`Seed repository identity changed: ${name}`);
    if (remote && !existing) throw new Error(`Refusing to adopt an untracked repository: ${name}`);
    if (!remote) remote = await forgejo("/user/repos", owner, { method: "POST", body: JSON.stringify({ name, private: false, auto_init: false, default_branch: "main" }) });
    if (!remote) throw new Error(`Could not create seed repository: ${name}`);
    const id = existing?.id ?? randomUUID();
    if (!existing) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, title, description, "public", user.id, kind === "model" ? "index.html" : "", "MIT", owner.username, name, remote.id);
        db.prepare("INSERT INTO project_metadata(project_id,kind) VALUES (?,?)").run(id, kind);
        db.prepare("INSERT INTO project_access(project_id) VALUES (?)").run(id);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    const project = projectById(id, user)!;
    const repo = await operationRepository(owner);
    let commit: string;
    try {
      const url = repositoryUrl(owner.username, name);
      const head = await remoteHead(repo, url, "refs/heads/main");
      if (head) commit = head;
      else {
        commit = await templateCommit(repo, [...initial].map(([path, content]) => ({ path, content })), user);
        if (await pushCommit(repo, url, "refs/heads/main", "", commit) !== "updated") throw new Error(`Seed branch changed: ${name}`);
      }
    } finally { await removeRepository(repo); }
    const tree = await sourceTree(project, commit, user);
    const files: Files = new Map();
    for (const file of tree.files) files.set(file.path, await sourceFile(project, commit, file.path, user));
    return { project, commit, files };
  }

  const diffusionFiles = await example("diffusion-library", ["README.md"]);
  diffusionFiles.set("diffusion.py", await readFile(new URL("../examples/python-pulse/vendor/diffusion.py", import.meta.url)));
  const diffusion = await ensure("diffusion", "Diffusion", "library", diffusionFiles, "Periodic one-dimensional diffusion in Python.");
  const kit = await ensure("browser-kit", "Browser kit", "library", await example("browser-kit", ["index.js", "README.md"]), "Canvas, controls and animation helpers for browser simulations.");
  const gridFiles = await example("agent-grid", ["index.js", "README.md"]);
  include(gridFiles, kit, "vendor/browser-kit");
  const grid = await ensure("agent-grid", "Agent grid", "library", gridFiles, "A minimal agent-based modeling library using Browser kit.");
  const walkersFiles = await example("grid-walkers", ["index.html", "model.js", "README.md"]);
  include(walkersFiles, grid, "vendor/agent-grid");
  await ensure("grid-walkers", "Grid walkers", "model", walkersFiles, "Seeded random movement using Agent grid and Browser kit.");

  // Adopt existing identical copies once; never replace user edits or an existing lockfile.
  for (const name of ["heat-pulse", "alternating-temperatures"]) {
    const row = db.prepare("SELECT id FROM projects WHERE forgejo_owner=? AND forgejo_repo=?").get(owner.username, name) as { id: string } | undefined;
    if (!row) continue;
    const project = projectById(row.id, user)!;
    const tree = await sourceTree(project, "refs/heads/main", user);
    if (tree.files.some(file => file.path === "lab.lock.json")) continue;
    const source = diffusion.files.get("diffusion.py");
    if (!source || !tree.files.some(file => file.path === "vendor/diffusion.py") || !(await sourceFile(project, tree.commit, "vendor/diffusion.py", user)).equals(source)) {
      console.log(`Library seed left ${name} unchanged: diffusion copy differs or is absent.`);
      continue;
    }
    const content = json({ version: 1, libraries: [dependency(diffusion.project, diffusion.commit, new Map([["diffusion.py", source]]), "vendor")] }).toString();
    const repo = await operationRepository(owner);
    try {
      const url = repositoryUrl(project.forgejoOwner, project.forgejoRepo);
      await fetchCommit(repo, url, tree.commit);
      const commit = await prepareCommit(repo, { ref: "refs/heads/main", expectedCommit: tree.commit, message: "Record existing diffusion library dependency", changes: [{ operation: "create", path: "lab.lock.json", content }] }, user);
      if (await pushCommit(repo, url, "refs/heads/main", tree.commit, commit) !== "updated") console.log(`Library seed left ${name} unchanged: branch changed concurrently.`);
    } finally { await removeRepository(repo); }
  }
}

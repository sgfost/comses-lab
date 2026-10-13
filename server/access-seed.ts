import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { db } from "./db.ts";
import { actor, createRepository, lookupRepository, repositoryUrl } from "./forgejo.ts";
import { operationRepository, templateCommit, remoteHead, pushCommit, removeRepository } from "./git.ts";
import { attachSeedGroup } from "./access.ts";
import type { User } from "../shared/contracts.ts";

type Seed = { group_id: string; project_id: string; stage: string; provider_id: number | null; prepared_commit: string | null; prepared_directory: string | null };
export async function seedGroupExample() {
  const owner = db.prepare("SELECT id,username,display_name AS displayName FROM users WHERE username='ada'").get() as unknown as User;
  let seed = db.prepare("SELECT * FROM access_seed WHERE singleton=1").get() as Seed | undefined;
  if (seed?.stage === "completed") return;
  if (!seed) {
    const groupId = randomUUID(), projectId = randomUUID();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO groups(id,name,owner_id) VALUES (?,?,?)").run(groupId, "Research group", owner.id);
      for (const [username, permission] of [["ben", "write"], ["cy", "read"]]) {
        const member = db.prepare("SELECT id FROM users WHERE username=?").get(username!) as { id: string };
        db.prepare("INSERT INTO group_members VALUES (?,?,?)").run(groupId, member.id, permission!);
      }
      db.prepare("INSERT INTO access_seed(singleton,group_id,project_id,stage) VALUES (1,?,?,'preparing')").run(groupId, projectId);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    seed = db.prepare("SELECT * FROM access_seed WHERE singleton=1").get() as Seed;
  }
  const name = `group-${seed.project_id}`;
  if (seed.stage === "preparing") {
    const repository = await operationRepository(actor(owner));
    const files = await Promise.all(["index.html", "garden.js", "ecology.js", "README.md"].map(async path => ({ path, content: await readFile(new URL(`../examples/commons/${path}`, import.meta.url)) })));
    const commit = await templateCommit(repository, files, owner);
    db.prepare("UPDATE access_seed SET stage='prepared',prepared_commit=?,prepared_directory=? WHERE singleton=1").run(commit, repository.directory);
    seed = db.prepare("SELECT * FROM access_seed WHERE singleton=1").get() as Seed;
  }
  if (seed.stage === "prepared") {
    if (await lookupRepository(owner.username, name, owner)) throw new Error("Reserved group seed repository already exists; verify its identity before recovery");
    db.prepare("UPDATE access_seed SET stage='creating' WHERE singleton=1").run();
    const repo = await createRepository(name, owner);
    db.prepare("UPDATE access_seed SET stage='created',provider_id=? WHERE singleton=1").run(repo.id);
    seed = db.prepare("SELECT * FROM access_seed WHERE singleton=1").get() as Seed;
  }
  if (seed.stage === "creating") throw new Error("Group seed repository creation outcome is unknown; verify and record its provider ID before continuing");
  const remote = await lookupRepository(owner.username, name, owner);
  if (!remote || remote.id !== seed.provider_id || !remote.private) throw new Error("Group seed repository identity or visibility changed");
  // Reconstruct only the non-secret subprocess environment; retain the prepared Git objects.
  const temporary = await operationRepository(actor(owner));
  const repository = { directory: seed.prepared_directory!, environment: temporary.environment };
  try {
    const url = repositoryUrl(owner.username, name);
    const head = await remoteHead(repository, url, "refs/heads/main");
    if (head !== seed.prepared_commit) {
      if (head !== null) throw new Error("Group seed already has different source; refusing to overwrite it");
      if (await pushCommit(repository, url, "refs/heads/main", "", seed.prepared_commit!) !== "updated") throw new Error("Group seed push was not confirmed");
    }
  } finally { await removeRepository(temporary); }
  db.prepare("INSERT OR IGNORE INTO projects VALUES (?,?,?,?,?,?,?,?,?,?)").run(seed.project_id, "Group garden study", "A private resource model shared with the research group.", "private", owner.id, "index.html", "MIT", owner.username, name, seed.provider_id!);
  db.prepare("INSERT OR IGNORE INTO project_metadata(project_id) VALUES (?)").run(seed.project_id);
  db.prepare("INSERT OR IGNORE INTO project_access(project_id) VALUES (?)").run(seed.project_id);
  await attachSeedGroup(seed.project_id, seed.group_id, owner.id);
  const access = db.prepare("SELECT pending_update_id,group_id FROM project_access WHERE project_id=?").get(seed.project_id) as { pending_update_id: string | null; group_id: string | null };
  if (access.pending_update_id || access.group_id !== seed.group_id) throw new Error("Group seed collaborator confirmation remains pending; rerun bootstrap to resume");
  db.prepare("UPDATE access_seed SET stage='completed' WHERE singleton=1").run();
  await removeRepository(repository);
}

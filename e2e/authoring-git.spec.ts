import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { stateDir, instance } from "../scripts/config.mjs";
import { operationRepository, removeRepository, git, templateCommit, prepareCommit, pushCommit, remoteHead, validateCommitRequest } from "../server/git.ts";
if (!instance.startsWith("test-")) throw new Error("Isolated test instance required");
test("real bare Git leases and exact one-parent multifile plumbing", async () => {
  const repository = await operationRepository();
  const remote = mkdtempSync(resolve(stateDir, "authoring-remote-"));
  const user = { id: "fixture", username: "fixture", displayName: "Fixture" };
  const command = (...args: string[]) => execFileSync("git", ["--git-dir", remote, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    command("init", "--bare", remote);
    const root = await templateCommit(repository, [{ path: "root.txt", content: Buffer.from("root\n") }], user);
    const request = (expectedCommit: string, content: string) => validateCommitRequest({ ref: "refs/heads/experiment", expectedCommit, message: content, changes: [{ operation: "create", path: "addition.txt", content }] });
    const expected = await prepareCommit(repository, request(root, "expected"), user);
    const proposed = await prepareCommit(repository, validateCommitRequest({ ref: "refs/heads/experiment", expectedCommit: expected, message: "proposed", changes: [{ operation: "update", path: "addition.txt", content: "proposed" }] }), user);
    const competing = await prepareCommit(repository, validateCommitRequest({ ref: "refs/heads/experiment", expectedCommit: expected, message: "competing", changes: [{ operation: "update", path: "addition.txt", content: "competing" }] }), user);
    // Transfer all fixtures without relying on a production branch.
    for (const commit of [root, expected, proposed, competing]) await git(repository, ["push", remote, `${commit}:refs/heads/objects/${commit}`]);
    expect(command("show", "-s", "--format=%P", proposed)).toBe(expected);
    const ref = "refs/heads/experiment";
    for (const [name, before] of [["unchanged", expected], ["advanced", competing], ["rewound", root], ["deleted", null], ["recreated elsewhere", competing], ["already applied equals", proposed]] as const) {
      command("update-ref", "-d", ref);
      if (before) command("update-ref", ref, before);
      const result = await pushCommit(repository, remote, ref, expected, proposed);
      expect(result, name).toBe(name === "unchanged" ? "updated" : "conflict");
      expect(await remoteHead(repository, remote, ref), name).toBe(name === "unchanged" ? proposed : before);
    }
    // Receive-side old-value validation rejects movement after advertisement.
    // Run the same lease directly so this fixture's server hook can execute;
    // production plumbing disables all inherited hooks.
    for (const replacement of [root, null]) {
      command("update-ref", ref, expected);
      const hook = resolve(remote, "hooks/pre-receive");
      writeFileSync(hook, `#!/bin/sh\nunset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES\ngit update-ref ${replacement ? `${ref} ${replacement}` : `-d ${ref}`}\n`, { mode: 0o700 });
      const result = spawnSync("git", ["--git-dir", repository.directory, "push", "--porcelain", `--force-with-lease=${ref}:${expected}`, "--", remote, `${proposed}:${ref}`], { env: { PATH: process.env.PATH, HOME: repository.directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("[remote rejected]");
      expect(await remoteHead(repository, remote, ref)).toBe(replacement);
      rmSync(hook);
    }
  } finally { await removeRepository(repository); rmSync(remote, { recursive: true, force: true }); }
});

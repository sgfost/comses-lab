import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { RefList } from "../shared/contracts.ts";
import { config, stateDir, instance } from "../scripts/config.mjs";

const c = config();
if (!instance.startsWith("test-"))
  throw new Error("Isolated test instance required");
const credentialsPath = resolve(stateDir, "credentials.json");
const credentialsText = readFileSync(credentialsPath, "utf8");
const local = JSON.parse(credentialsText);
const owner = local.users.find(
  (u: { username: string }) => u.username === "ada",
);
const db = new DatabaseSync(resolve(stateDir, "lab.sqlite"));
const ownerId = (
  db.prepare("SELECT id FROM users WHERE username='ada'").get() as {
    id: string;
  }
).id;
const repo = `inspection-${randomUUID()}`;
const id = randomUUID();
const clone = mkdtempSync(resolve(stateDir, "source-history-"));
const gitEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.extraHeader",
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${owner.username}:${owner.password}`).toString("base64")}`,
};
function git(...args: string[]) {
  return execFileSync("git", ["-C", clone, ...args], {
    env: gitEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
async function provider(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${c.forgejoUrl}/api/v1${path}`, {
    method,
    headers: {
      Authorization: gitEnv.GIT_CONFIG_VALUE_0.replace("Authorization: ", ""),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(
    response.ok,
    `Forgejo ${method} ${path}: ${response.status}`,
  ).toBeTruthy();
  return response.status === 204 ? undefined : response.json();
}
async function signedIn(request: APIRequestContext, name: string) {
  const account = local.users.find(
    (u: { username: string }) => u.username === name,
  );
  const response = await request.post("/api/session", {
    headers: { Origin: c.appOrigin },
    data: account,
  });
  expect(response.status()).toBe(200);
}
let root = "",
  main = "",
  merged = "",
  invalidCommit = "",
  tagObject = "";
test.beforeAll(async () => {
  const created = await provider("/user/repos", "POST", {
    name: repo,
    default_branch: "main",
    private: false,
  });
  db.prepare("INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    id,
    "Source inspection fixture",
    "",
    "public",
    ownerId,
    "index.html",
    "MIT",
    "ada",
    repo,
    created.id,
  );
  for (const suffix of [
    "refs",
    "tree",
    `history?commit=${"0".repeat(40)}`,
    `diff?commit=${"0".repeat(40)}`,
  ]) {
    const response = await fetch(`${c.appOrigin}/api/projects/${id}/${suffix}`);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("empty_repository");
  }
  git("init", "-b", "main");
  git("config", "user.name", "Source acceptance");
  git("config", "user.email", "source-acceptance@example.test");
  git("remote", "add", "origin", `${c.forgejoUrl}/ada/${repo}.git`);
  writeFileSync(
    resolve(clone, "index.html"),
    "<!doctype html><title>Inspection</title><img src=asset.png>\n",
  );
  writeFileSync(
    resolve(clone, "asset.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]),
  );
  writeFileSync(resolve(clone, "bom.txt"), "\ufeffsource with BOM\n");
  mkdirSync(resolve(clone, "nested"));
  writeFileSync(resolve(clone, "nested/é file.txt"), "initial\n");
  git("add", ".");
  git("commit", "-m", "Initial model");
  root = git("rev-parse", "HEAD").trim();
  git("checkout", "-b", "experiment/slash");
  writeFileSync(resolve(clone, "experiment.txt"), "experiment\n");
  git("add", ".");
  git("commit", "-m", "Add experiment");
  git("checkout", "main");
  writeFileSync(resolve(clone, "nested/é file.txt"), "changed\nsecond line\n");
  git("add", ".");
  git("commit", "-m", "Change source", "-m", "A full commit message.");
  main = git("rev-parse", "HEAD").trim();
  git("merge", "--no-ff", "experiment/slash", "-m", "Merge experiment");
  merged = git("rev-parse", "HEAD").trim();
  git("tag", "-a", "experiment/slash", root, "-m", "Root snapshot");
  git("tag", "empty", merged);
  git(
    "tag",
    "-a",
    "nested-tag",
    "refs/tags/experiment/slash",
    "-m",
    "Nested tag snapshot",
  );
  tagObject = git("rev-parse", "refs/tags/nested-tag").trim();
  git("checkout", "-b", "invalid-encoding");
  writeFileSync(resolve(clone, "invalid.txt"), Buffer.from([0xc3, 0x28]));
  git("add", ".");
  git("commit", "-m", "Non UTF-8 source");
  invalidCommit = git("rev-parse", "HEAD").trim();
  git("checkout", "main");
  git("push", "--all", "origin");
  git("push", "--tags", "origin");
  await expect
    .poll(async () => (await provider(`/repos/ada/${repo}`)).empty)
    .toBe(false);
});
test.afterAll(async () => {
  db.prepare("DELETE FROM projects WHERE id=?").run(id);
  db.close();
  await provider(`/repos/ada/${repo}`, "DELETE");
  rmSync(clone, { recursive: true, force: true });
});

test("qualified refs, pinned source/history and root/merge diff match Git", async ({
  request,
}) => {
  const base = `/api/projects/${id}`;
  for (const [kind, prefix] of [
    ["branch", "heads"],
    ["tag", "tags"],
  ]) {
    const seen: string[] = [];
    let page: number | null = 1;
    while (page !== null) {
      const response = await request.get(
        `${base}/refs?kind=${kind}&page=${page}&limit=1`,
      );
      expect(response.status()).toBe(200);
      const data: RefList = await response.json();
      expect(data.defaultBranch).toBe("main");
      expect(data.kind).toBe(kind);
      expect(data.page).toBe(page);
      expect(data.refs).toHaveLength(1);
      for (const ref of data.refs) {
        expect(ref.ref).toBe(`refs/${prefix}/${ref.name}`);
        expect(ref.commit).toBe(git("rev-parse", `${ref.ref}^{commit}`).trim());
        const tree = await (
          await request.get(`${base}/tree?ref=${encodeURIComponent(ref.ref)}`)
        ).json();
        expect(tree.commit).toBe(ref.commit);
        seen.push(ref.ref);
      }
      page = data.nextPage;
    }
    expect(seen.sort()).toEqual(
      git("for-each-ref", "--format=%(refname)", `refs/${prefix}`)
        .trim()
        .split("\n")
        .sort(),
    );
  }
  for (const suffix of ["refs?page=99", `history?commit=${merged}&page=99`]) {
    const response = await request.get(`${base}/${suffix}`);
    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data.refs ?? data.commits).toEqual([]);
    expect(data.nextPage).toBeNull();
  }
  const page1 = await (
    await request.get(`${base}/history?commit=${merged}&limit=2`)
  ).json();
  expect(page1.commit).toBe(merged);
  expect(page1.nextPage).toBe(2);
  writeFileSync(resolve(clone, "later.txt"), "new branch head\n");
  git("add", ".");
  git("commit", "-m", "Advance main after page one");
  git("push", "origin", "main");
  const page2 = await (
    await request.get(`${base}/history?commit=${merged}&limit=2&page=2`)
  ).json();
  expect(page2.nextPage).toBeNull();
  const commits = [...page1.commits, ...page2.commits];
  expect(commits.map((item) => item.commit)).toEqual(
    git("log", "--format=%H", merged).trim().split("\n"),
  );
  for (const item of commits) {
    expect(item.parents).toEqual(
      git("show", "-s", "--format=%P", item.commit)
        .trim()
        .split(" ")
        .filter(Boolean),
    );
    expect(item.message.trimEnd()).toBe(
      git("show", "-s", "--format=%B", item.commit).trimEnd(),
    );
    expect(item.author.name).toBe("Source acceptance");
    expect(Date.parse(item.author.date)).toBe(
      Date.parse(git("show", "-s", "--format=%aI", item.commit).trim()),
    );
  }
  const file = await (
    await request.get(
      `${base}/file?commit=${root}&path=${encodeURIComponent("nested/é file.txt")}`,
    )
  ).json();
  expect(file.content).toBe(git("show", `${root}:nested/é file.txt`));
  for (const commit of [root, main, merged]) {
    const response = await request.get(`${base}/diff?commit=${commit}`);
    expect(response.status()).toBe(200);
    const diff = await response.json();
    const parents = git("show", "-s", "--format=%P", commit)
      .trim()
      .split(" ")
      .filter(Boolean);
    expect(diff.commit).toBe(commit);
    expect(diff.base).toBe(parents[0] ?? null);
    const expected = parents.length
      ? git("-c", "core.quotePath=false", "diff", "-M", parents[0]!, commit)
      : git(
          "-c",
          "core.quotePath=false",
          "show",
          "--format=",
          "--root",
          commit,
        );
    expect(diff.patch).toBe(expected);
    if (commit === root) expect(diff.patch).toContain("Binary files");
  }
  git("commit", "--allow-empty", "-m", "Empty change");
  git("push", "origin", "main");
  const empty = await (
    await request.get(`${base}/diff?commit=${git("rev-parse", "HEAD").trim()}`)
  ).json();
  expect(empty.patch).toBe("");
});

test("access first, malformed inputs, binary text and bounded diff", async ({
  request,
  playwright,
}) => {
  const base = `/api/projects/${id}`;
  const ownerRequest = await playwright.request.newContext({
    baseURL: c.appOrigin,
  });
  const otherRequest = await playwright.request.newContext({
    baseURL: c.appOrigin,
  });
  try {
    await signedIn(ownerRequest, "ada");
    await signedIn(otherRequest, "cy");
    const projects = await (await ownerRequest.get("/api/projects")).json();
    const privateProject = projects.projects.find(
      (p: { forgejoRepo: string }) => p.forgejoRepo === "private-garden",
    );
    const privateId = privateProject.id;
    const unrelated = local.users.find(
      (u: { username: string }) => u.username === "cy",
    );
    let directGitDenied = false;
    try {
      execFileSync(
        "git",
        [
          "ls-remote",
          `${c.forgejoUrl}/${privateProject.forgejoOwner}/${privateProject.forgejoRepo}.git`,
        ],
        {
          stdio: "pipe",
          env: {
            ...gitEnv,
            GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${unrelated.username}:${unrelated.password}`).toString("base64")}`,
          },
        },
      );
    } catch {
      directGitDenied = true;
    }
    expect(directGitDenied).toBe(true);
    const privateTree = await (
      await ownerRequest.get(`/api/projects/${privateId}/tree`)
    ).json();
    for (const suffix of [
      "refs",
      "history?commit=" + privateTree.commit,
      "diff?commit=" + privateTree.commit,
      "tree?ref=..",
      "file?commit=bad&path=..",
    ])
      for (const caller of [request, otherRequest])
        expect(
          (await caller.get(`/api/projects/${privateId}/${suffix}`)).status(),
        ).toBe(404);
    for (const suffix of [
      "refs",
      "history?commit=" + privateTree.commit,
      "diff?commit=" + privateTree.commit,
    ])
      expect(
        (
          await ownerRequest.get(`/api/projects/${privateId}/${suffix}`)
        ).status(),
      ).toBe(200);
    for (const ref of [
      "../private-garden",
      "main~1",
      "main^",
      "a..b",
      "a\\b",
      "a\n",
      "refs/remotes/origin/main",
      "-main",
      "main@{0}",
      "a//b",
    ])
      expect(
        (
          await request.get(`${base}/tree?ref=${encodeURIComponent(ref)}`)
        ).status(),
        ref,
      ).toBe(400);
    for (const suffix of [
      "refs?kind=remote",
      "refs?limit=51",
      "refs?page=0",
      "history?commit=main",
      `history?commit=${root}&page=1.5`,
      `history?commit=${root}&limit=0`,
      "diff?commit=HEAD",
    ])
      expect((await request.get(`${base}/${suffix}`)).status(), suffix).toBe(
        400,
      );
    for (const path of [
      "../index.html",
      "/index.html",
      "nested//file",
      "a\u0000b",
      "a\\b",
    ])
      expect(
        (
          await request.get(
            `${base}/file?commit=${root}&path=${encodeURIComponent(path)}`,
          )
        ).status(),
      ).toBe(400);
    for (const suffix of [
      "tree?ref=absent-ref",
      `history?commit=${"0".repeat(40)}`,
      `diff?commit=${"0".repeat(40)}`,
      `file?commit=${root}&path=absent.txt`,
    ])
      expect((await request.get(`${base}/${suffix}`)).status(), suffix).toBe(
        404,
      );
    expect(
      (
        await request.get(`${base}/file?commit=${root}&path=asset.png`)
      ).status(),
    ).toBe(422);
    expect(
      (
        await request.get(
          `${base}/file?commit=${invalidCommit}&path=invalid.txt`,
        )
      ).status(),
    ).toBe(422);
    expect(
      (await request.get(`${base}/diff?commit=${invalidCommit}`)).status(),
    ).toBe(422);
    expect(
      (
        await (
          await request.get(`${base}/file?commit=${root}&path=bom.txt`)
        ).json()
      ).content,
    ).toBe(git("show", `${root}:bom.txt`));
    for (const suffix of [
      `file?commit=${tagObject}&path=index.html`,
      `history?commit=${tagObject}`,
      `diff?commit=${tagObject}`,
    ])
      expect((await request.get(`${base}/${suffix}`)).status()).toBe(400);
    expect(
      (
        await ownerRequest.post(`${base}/launch`, {
          headers: { Origin: c.appOrigin },
          data: { commit: tagObject },
        })
      ).status(),
    ).toBe(400);
    const launchResponse = await ownerRequest.post(`${base}/launch`, {
      headers: { Origin: c.appOrigin },
      data: { commit: root },
    });
    expect(launchResponse.status()).toBe(200);
    const launch = await launchResponse.json();
    const asset = await request.get(new URL("asset.png", launch.url).href);
    expect(await asset.body()).toEqual(
      readFileSync(resolve(clone, "asset.png")),
    );
    await ownerRequest.delete(`/api/launches/${launch.id}`, {
      headers: { Origin: c.appOrigin, "Content-Type": "application/json" },
    });
    writeFileSync(resolve(clone, "large.txt"), "a".repeat(2_100_000) + "\n");
    git("add", ".");
    git("commit", "-m", "Large patch");
    git("push", "origin", "main");
    const response = await request.get(
      `${base}/diff?commit=${git("rev-parse", "HEAD").trim()}`,
    );
    expect(response.status()).toBe(413);
    expect((await response.json()).error.code).toBe("diff_too_large");
  } finally {
    await ownerRequest.dispose();
    await otherRequest.dispose();
  }
});

test("upstream authentication and connection failures are explicit", async ({
  request,
}) => {
  test.setTimeout(60000);
  const paths = [
    "refs",
    `tree?ref=${root}`,
    `history?commit=${root}`,
    `diff?commit=${root}`,
    `file?commit=${root}&path=index.html`,
  ];
  try {
    const invalid = JSON.parse(credentialsText);
    invalid.reader.password = "deliberately-invalid-test-credential";
    writeFileSync(credentialsPath, JSON.stringify(invalid), { mode: 0o600 });
    for (const path of paths) {
      const response = await request.get(`/api/projects/${id}/${path}`);
      expect(response.status()).toBe(502);
      expect((await response.json()).error.code).toBe("upstream_error");
    }
  } finally {
    writeFileSync(credentialsPath, credentialsText, { mode: 0o600 });
  }
  try {
    execFileSync("npm", ["run", "forgejo", "--", "stop"], { stdio: "pipe" });
    for (const path of paths) {
      const response = await request.get(`/api/projects/${id}/${path}`);
      expect(response.status()).toBe(502);
      expect((await response.json()).error.code).toBe("upstream_error");
    }
  } finally {
    execFileSync("npm", ["run", "forgejo", "--", "up", "-d"], {
      stdio: "pipe",
    });
    await expect
      .poll(
        async () => {
          try {
            return (
              await fetch(`${c.forgejoUrl}/api/v1/version`, {
                headers: {
                  Authorization: gitEnv.GIT_CONFIG_VALUE_0.replace(
                    "Authorization: ",
                    "",
                  ),
                },
              })
            ).status;
          } catch {
            return 0;
          }
        },
        { timeout: 30000 },
      )
      .toBe(200);
  }
});

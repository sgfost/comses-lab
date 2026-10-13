import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import { config, instance, projectRoot, stateDir } from "../scripts/config.mjs";

if (!instance.startsWith("test-"))
  throw new Error(
    "Use an isolated test-* instance; run setup/forgejo/bootstrap first",
  );
const settings = config();
const local = JSON.parse(
  readFileSync(join(stateDir, "credentials.json"), "utf8"),
);
const owner = local.users.find((user) => user.username === "ada");
assert.ok(owner, "Seeded owner is required");
const base = `http://127.0.0.1:${settings.apiPort}`;
const headers = {
  Origin: settings.appOrigin,
  "Content-Type": "application/json",
};

async function request(path, cookie, method = "GET", body) {
  return fetch(base + path, {
    method,
    headers: cookie ? { ...headers, Cookie: cookie } : headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
}
async function login(cookie) {
  const response = await request("/api/session", cookie, "POST", {
    username: owner.username,
    password: owner.password,
  });
  assert.equal(response.status, 200, "Owner sign-in succeeds");
  return response.headers.get("set-cookie").split(";")[0];
}
async function waitFor(condition, message) {
  const deadline = Date.now() + 15000;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, message);
    await setTimeout(50);
  }
}
async function requireStopped() {
  try {
    await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) });
  } catch {
    return;
  }
  throw new Error(
    "Stop this test instance's native services before running the launch-session probe",
  );
}

for (const scenario of ["logout", "expiry", "replacement"]) {
  await requireStopped();
  const gate = mkdtempSync(join(stateDir, "launch-session-"));
  const child = spawn(
    process.execPath,
    [
      "--import",
      "./e2e/fixtures/delay-launch-fetch.mjs",
      "--import",
      "tsx",
      "server/index.ts",
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        LAB_INSTANCE: instance,
        LAB_TEST_LAUNCH_GATE: gate,
      },
      stdio: "ignore",
    },
  );
  const exited = once(child, "exit");
  let cookie, replacement, pending;
  try {
    await waitFor(async () => {
      assert.equal(child.exitCode, null, "Probe API must stay running");
      try {
        return (await request("/api/health")).ok;
      } catch {
        return false;
      }
    }, "Probe API readiness timed out");
    cookie = await login();
    const projects = await (await request("/api/projects", cookie)).json();
    const project = projects.projects.find(
      (project) => project.visibility === "private" &&
        project.forgejoOwner === owner.username && project.forgejoRepo === "private-garden",
    );
    assert.ok(project, "Seeded private project exists");
    const treeResponse = await request(
      `/api/projects/${project.id}/tree`,
      cookie,
    );
    assert.equal(treeResponse.status, 200);
    const tree = await treeResponse.json();
    pending = request(`/api/projects/${project.id}/launch`, cookie, "POST", {
      commit: tree.commit,
    });
    // Attach a rejection handler immediately while the controlled response is held.
    pending.catch(() => {});
    await waitFor(
      () => existsSync(join(gate, "ready")),
      "Real private source response was not held",
    );
    if (scenario === "logout") {
      assert.equal(
        (await request("/api/session", cookie, "DELETE")).status,
        200,
      );
    } else if (scenario === "replacement") {
      replacement = await login(cookie);
      assert.notEqual(replacement, cookie);
    } else {
      const token = cookie.slice(cookie.indexOf("=") + 1);
      const db = new DatabaseSync(join(stateDir, "lab.sqlite"));
      try {
        const result = db
          .prepare("UPDATE sessions SET expires_at=? WHERE token_hash=?")
          .run(
            Date.now() - 1,
            createHash("sha256").update(token).digest("hex"),
          );
        assert.equal(result.changes, 1);
      } finally {
        db.close();
      }
    }
    const session = await (await request("/api/session", cookie)).json();
    assert.equal(
      session.user,
      null,
      "Original session is invalid before the held response resumes",
    );
    writeFileSync(join(gate, "release"), "release");
    const response = await pending;
    assert.equal(
      response.status,
      401,
      `${scenario}: invalidated request cannot create a preview`,
    );
    const result = await response.json();
    assert.equal(result.error.code, "unauthorized");
    assert.equal(result.url, undefined);

    replacement ??= await login();
    const retry = await request(
      `/api/projects/${project.id}/launch`,
      replacement,
      "POST",
      { commit: tree.commit },
    );
    assert.equal(
      retry.status,
      200,
      "A valid replacement session can launch normally",
    );
    const launch = await retry.json();
    assert.equal((await fetch(launch.url)).status, 200);
    assert.equal(
      (await request("/api/session", replacement, "DELETE")).status,
      200,
    );
    assert.equal(
      (await fetch(launch.url)).status,
      404,
      "Logout revokes the valid preview",
    );
    console.log(
      `${scenario}: held private launch rejected with 401; valid-session recovery passed`,
    );
  } finally {
    writeFileSync(join(gate, "release"), "release");
    // Invalidate any session created by this probe, including on assertion failure.
    for (const session of [cookie, replacement].filter(Boolean))
      await request("/api/session", session, "DELETE").catch(() => {});
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    const forceStop = globalThis.setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      await exited;
    } finally {
      globalThis.clearTimeout(forceStop);
    }
    await pending?.catch(() => {});
    rmSync(gate, { recursive: true, force: true });
  }
}

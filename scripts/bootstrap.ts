import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  settings,
  stateDir,
  credentials,
  type Credential,
} from "../server/config.ts";
import { db } from "../server/db.ts";
import { hashPassword } from "../server/auth.ts";
import { forgejo, ForgejoError } from "../server/forgejo.ts";
import { seedGroupExample } from "../server/access-seed.ts";
import { seedLibraryExamples } from "./seed-libraries.ts";
const file = resolve(stateDir, "credentials.json");
if (!existsSync(file)) {
  const make = (username: string, displayName: string): Credential => ({
    username,
    displayName,
    password: randomBytes(24).toString("base64url"),
  });
  writeFileSync(
    file,
    JSON.stringify(
      {
        admin: make("lab-admin", "Local administrator"),
        reader: make("lab-reader", "Public source reader"),
        users: [
          make("ada", "Ada Moreno"),
          make("ben", "Ben Okafor"),
          make("cy", "Cy Lee"),
        ],
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
}
const c = credentials();
if (!c.users.some(user => user.username === "dee")) {
  c.users.push({ username: "dee", displayName: "Dee Morgan", password: randomBytes(24).toString("base64url") });
  writeFileSync(file, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
}
if (!c.reader) {
  c.reader = {
    username: "lab-reader",
    displayName: "Public source reader",
    password: randomBytes(24).toString("base64url"),
  };
  writeFileSync(file, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
}
for (let attempt = 0; ; attempt++) {
  try {
    const response = await fetch(`${settings.forgejoUrl}/api/healthz`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error("Not ready");
    break;
  } catch {
    if (attempt >= 60)
      throw new Error(
        "Forgejo is not ready. Run npm run forgejo and inspect its logs.",
      );
    await new Promise((r) => setTimeout(r, 1000));
  }
}
try {
  await forgejo("/user", c.admin);
} catch {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "-p",
      settings.composeProject,
      "exec",
      "-T",
      "--user",
      "git",
      "forgejo",
      "forgejo",
      "admin",
      "user",
      "create",
      "--username",
      c.admin.username,
      "--password",
      c.admin.password,
      "--email",
      "admin@lab.invalid",
      "--admin",
      "--must-change-password=false",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, LAB_FORGEJO_PORT: String(settings.forgejoPort) },
    },
  );
  if (result.status !== 0)
    throw new Error(
      "Could not initialize Forgejo administrator. Inspect the local container configuration; credentials are preserved.",
    );
  await forgejo("/user", c.admin);
}
for (const user of [c.reader, ...c.users]) {
  let remote: { id: number };
  try {
    remote = await forgejo(`/users/${user.username}`, c.admin);
  } catch (error) {
    if (!(error instanceof ForgejoError) || error.status !== 404) throw error;
    remote = await forgejo("/admin/users", c.admin, {
      method: "POST",
      body: JSON.stringify({
        username: user.username,
        full_name: user.displayName,
        password: user.password,
        email: `${user.username}@lab.invalid`,
        must_change_password: false,
      }),
    });
  }
  if (user !== c.reader)
    db.prepare("INSERT OR IGNORE INTO users VALUES (?,?,?,?,?)").run(
      randomUUID(),
      user.username,
      user.displayName,
      hashPassword(user.password),
      remote.id,
    );
}
const owner = c.users[0]!;
const ownerId = (
  db.prepare("SELECT id FROM users WHERE username=?").get(owner.username) as {
    id: string;
  }
).id;
const examples = [
  {
    name: "commons-garden",
    title: "The commons garden",
    description: "A resource regeneration and harvesting model.",
    visibility: "public",
    directory: "examples/commons",
    files: ["index.html", "garden.js", "ecology.js", "README.md"],
  },
  {
    name: "private-garden",
    title: "Private garden study",
    description: "A resource regeneration and harvesting model.",
    visibility: "private",
    directory: "examples/commons",
    files: ["index.html", "garden.js", "ecology.js", "README.md"],
  },
  {
    name: "random-walks",
    title: "Random walks",
    description: "Random walks computed in a JavaScript worker.",
    visibility: "public",
    directory: "examples/worker",
    files: ["index.html", "walk.js", "walk-worker.js", "random.js", "README.md"],
  },
  {
    name: "heat-diffusion",
    title: "Heat diffusion",
    description: "Heat diffusion computed in Python with Pyodide.",
    visibility: "public",
    directory: "examples/python",
    files: ["index.html", "heat.js", "python-worker.js", "model.py", "diffusion.py", "README.md"],
  },
  {
    name: "netlogo-walks",
    title: "NetLogo walks",
    description: "Random walks with NetLogo's own controls and world view.",
    visibility: "public",
    directory: "examples/netlogo",
    entrypoint: "model.nlogox",
    files: ["model.nlogox", "README.md", "LICENSE"],
  },
  ...[
    { name: "heat-pulse", title: "Heat pulse", directory: "examples/python-pulse" },
    { name: "alternating-temperatures", title: "Alternating temperatures", directory: "examples/python-alternating" },
  ].map(example => ({
    ...example,
    description: "A Python scenario importing the pinned shared diffusion module.",
    visibility: "public",
    files: ["index.html", "view.js", "python-worker.js", "model.py", "vendor/diffusion.py", "component.json", "README.md"],
  })),
];
for (const example of examples) {
  const { name, visibility } = example;
  let repo: { id: number; empty: boolean };
  try {
    repo = await forgejo(`/repos/${owner.username}/${name}`, owner);
  } catch (error) {
    if (!(error instanceof ForgejoError) || error.status !== 404) throw error;
    repo = await forgejo("/user/repos", owner, {
      method: "POST",
      body: JSON.stringify({
        name,
        private: visibility === "private",
        auto_init: false,
        default_branch: "main",
      }),
    });
  }
  if (repo.empty) {
    const files = example.files.map((path) => ({
      operation: "create",
      path,
      content: readFileSync(resolve(example.directory, path)).toString("base64"),
    }));
    await forgejo(`/repos/${owner.username}/${name}/contents`, owner, {
      method: "POST",
      body: JSON.stringify({
        branch: "main",
        message: `Seed ${example.title}`,
        files,
      }),
    });
  }
  db.prepare("INSERT OR IGNORE INTO projects VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    randomUUID(),
    example.title,
    example.description,
    visibility,
    ownerId,
    ("entrypoint" in example ? example.entrypoint : undefined) ?? "index.html",
    "MIT",
    owner.username,
    name,
    repo.id,
  );
}
db.prepare("INSERT OR IGNORE INTO project_metadata(project_id) SELECT id FROM projects").run();
db.prepare("INSERT OR IGNORE INTO project_access(project_id) SELECT id FROM projects").run();
await seedGroupExample();
await seedLibraryExamples();
console.log(
  `Bootstrap complete. Accounts: ${c.users.map((u) => u.username).join(", ")}. Local passwords: ${file}`,
);
db.close();

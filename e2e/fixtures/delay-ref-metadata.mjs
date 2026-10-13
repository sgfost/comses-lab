import { access, rename, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { join } from "node:path";

const directory = process.env.LAB_TEST_REFS_GATE;
const repository = process.env.LAB_TEST_REFS_REPO;
if (!process.env.LAB_INSTANCE?.startsWith("test-") || !directory || !/^refs-race-[a-f0-9-]+$/.test(repository ?? ""))
  throw new Error("Refs interleaving requires an isolated test fixture");
const originalFetch = globalThis.fetch;
let held = false;
globalThis.fetch = async (input, init) => {
  const response = await originalFetch(input, init);
  if (!held && new URL(String(input)).pathname === `/api/v1/repos/ada/${repository}`) {
    held = true;
    // Retain the real empty-repository response while Git receives its first push.
    if (!response.ok) throw new Error("Fixture metadata was not readable");
    const body = await response.arrayBuffer();
    const metadata = JSON.parse(Buffer.from(body).toString());
    if (metadata.empty !== true) throw new Error("Fixture must actually be empty before push");
    await writeFile(join(directory, "ready.tmp"), JSON.stringify({ id: metadata.id, empty: metadata.empty }));
    await rename(join(directory, "ready.tmp"), join(directory, "ready"));
    const deadline = Date.now() + 20000;
    while (true) {
      try { await access(join(directory, "release")); break; }
      catch {
        if (Date.now() >= deadline) throw new Error("Refs metadata gate was not released");
        await setTimeout(20);
      }
    }
    return new Response(body, { status: response.status, headers: response.headers });
  }
  return response;
};

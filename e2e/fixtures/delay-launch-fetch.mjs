import { access, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { join } from "node:path";

const directory = process.env.LAB_TEST_LAUNCH_GATE;
if (!process.env.LAB_INSTANCE?.startsWith("test-") || !directory)
  throw new Error("Launch interleaving requires an isolated test instance");

const originalFetch = globalThis.fetch;
let held = false;
globalThis.fetch = async (input, init) => {
  const response = await originalFetch(input, init);
  const url = new URL(String(input));
  if (
    !held &&
    /^\/api\/v1\/repos\/ada\/private-garden\/git\/blobs\/[a-f0-9]{40}$/.test(url.pathname)
  ) {
    held = true;
    // Hold a real successful source response; do not mock its data or permissions.
    if (!response.ok)
      throw new Error("Private fixture source was not readable");
    const body = await response.arrayBuffer();
    await writeFile(join(directory, "ready"), "ready");
    const deadline = Date.now() + 20000;
    while (true) {
      try {
        await access(join(directory, "release"));
        break;
      } catch {
        if (Date.now() >= deadline)
          throw new Error("Launch gate was not released");
        await setTimeout(20);
      }
    }
    return new Response(body, {
      status: response.status,
      headers: response.headers,
    });
  }
  return response;
};

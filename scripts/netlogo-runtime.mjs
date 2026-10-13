import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const directory = new URL("../runtime/vendor/netlogo/2.15.3/", import.meta.url);
const provenance = JSON.parse(await readFile(new URL("provenance.json", directory), "utf8"));
const download = process.argv.includes("--download");
if (process.argv.slice(2).some((arg) => arg !== "--download")) {
  throw new Error("Usage: node scripts/netlogo-runtime.mjs [--download]");
}
const path = new URL("player.html", directory);
let bytes;
if (download) {
  const response = await fetch(provenance.url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`NetLogo download failed: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
} else {
  bytes = await readFile(path);
}
const sha256 = createHash("sha256").update(bytes).digest("hex");
if (sha256 !== provenance.sha256 || bytes.length !== provenance.bytes) {
  throw new Error(`NetLogo ${provenance.version} integrity mismatch: ${sha256}, ${bytes.length} bytes`);
}
if (download) await writeFile(path, bytes);
console.log(`NetLogo Web ${provenance.version}: verified ${bytes.length} bytes (${sha256}).`);

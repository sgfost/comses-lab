import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { installNetLogoBridge } from "./netlogo-bridge.js";
import { MAX_NETLOGO_SOURCE_BYTES } from "../shared/runtime.ts";

export const NETLOGO_VERSION = "2.15.3";
export const isNetLogo = (path: string) => /\.nlogox?$/i.test(path);
export class NetLogoConfigurationError extends Error {}

export function assertNetLogoOrigins(appOrigin: string, runtimeOrigin: string): void {
  const app = new URL(appOrigin).hostname.toLowerCase().replace(/\.$/, "");
  const runtime = new URL(runtimeOrigin).hostname.toLowerCase().replace(/\.$/, "");
  const local = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (local.has(app) && local.has(runtime)) return;
  // Conservative without a public-suffix database: even separate *.co.uk sites
  // must use runtime domains with different final two labels.
  if (app.split(".").slice(-2).join(".") === runtime.split(".").slice(-2).join("."))
    throw new NetLogoConfigurationError("NetLogo runtime configuration requires an isolated domain: application/Forgejo and runtime hosts must have different final two hostname labels (except local development on localhost/loopback).");
}

export function netLogoOrigin(id: string, runtimeOrigin: string): string {
  const url = new URL(runtimeOrigin);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  url.hostname = `${createHash("sha256").update(id).digest("hex").slice(0, 40)}.${local ? "localhost" : url.hostname}`;
  return url.origin;
}

function scriptJSON(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

let player: string | undefined;
export function netLogoPlayer(): string {
  player ??= readFileSync(new URL(`./vendor/netlogo/${NETLOGO_VERSION}/player.html`, import.meta.url), "utf8")
    .replace(/<link\b[^>]*\bhref=["']https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/gi, "");
  return player;
}
export function netLogoDocument(input: {
  launchId: string;
  appOrigin: string;
  path: string;
  source: string;
  standalone: boolean;
}): string {
  const player = netLogoPlayer();
  const marker = '<script type="text/nlogo" id="nlogo-code" data-filename="model.nlogox"></script>';
  if (!player.includes(marker)) throw new Error("The pinned NetLogo player has an unexpected model placeholder");
  const loadResult = "function bp(e){switch(e.type){";
  if (!player.includes(loadResult)) throw new Error("The pinned NetLogo player has an unexpected load-result handler");
  // Ignore only a leading UTF-8 BOM for compilation; snapshot/source reads remain exact.
  const source = `${marker}<script>document.getElementById("nlogo-code").textContent=${scriptJSON(input.source.replace(/^\uFEFF/, ""))};document.getElementById("nlogo-code").dataset.filename=${scriptJSON(input.path)};</script>`;
  const bridge = `<script src="/bridge/${input.launchId}/bridge.js"></script><script>(${installNetLogoBridge.toString()})(${scriptJSON({ ...input, source: undefined, maxSourceBytes: MAX_NETLOGO_SOURCE_BYTES })});</script>`;
  return player.replace(marker, () => source)
    .replace(loadResult, "function bp(e){globalThis.__labNetLogoLoad(e);switch(e.type){")
    .replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${bridge}`);
}

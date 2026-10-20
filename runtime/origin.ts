import { createHash } from "node:crypto";

export class RuntimeConfigurationError extends Error {}

export function assertRuntimeOrigins(appOrigin: string, runtimeOrigin: string): void {
  const app = new URL(appOrigin).hostname.toLowerCase().replace(/\.$/, "");
  const runtime = new URL(runtimeOrigin).hostname.toLowerCase().replace(/\.$/, "");
  const local = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (local.has(app) && local.has(runtime)) return;
  // Conservative without a public-suffix database: even separate *.co.uk sites
  // must use runtime domains with different final two labels.
  if (app.split(".").slice(-2).join(".") === runtime.split(".").slice(-2).join("."))
    throw new RuntimeConfigurationError("Browser runtime configuration requires an isolated domain: application/Forgejo and runtime hosts must have different final two hostname labels (except local development on localhost/loopback).");
}

export function isolatedRuntimeOrigin(id: string, runtimeOrigin: string): string {
  const url = new URL(runtimeOrigin);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  url.hostname = `${createHash("sha256").update(id).digest("hex").slice(0, 40)}.${local ? "localhost" : url.hostname}`;
  return url.origin;
}


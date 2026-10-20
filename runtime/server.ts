import { isMarimo, marimoDocument, marimoAssets, MARIMO_VERSION } from './marimo.ts';
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { installPreviewFit } from "./preview-fit.js";
import { installBridge } from "./bridge.js";
import { RuntimeConfigurationError, assertRuntimeOrigins, isolatedRuntimeOrigin } from "./origin.ts";
import { isNetLogo, netLogoDocument, netLogoPlayer } from "./netlogo.ts";
import { MAX_RUNTIME_TEXT, MAX_RUNTIME_EVENTS_PER_SECOND } from "../shared/runtime.ts";
import { settings } from "../server/config.ts";
import type { Launch } from "../shared/contracts.ts";
export type LaunchPrincipal =
  | { kind: "session"; userId: string; sessionId: string }
  | { kind: "agent"; userId: string; grantId: string };
type Snapshot = {
  launch: Launch;
  projectId: string;
  principal: LaunchPrincipal;
  dataOrigins: readonly string[];
  entrypoint: string;
  files: Map<string, Buffer>;
  origin: string;
  edit: boolean;
};
const snapshots = new Map<string, Snapshot>();
function samePrincipal(a: LaunchPrincipal, b: LaunchPrincipal) {
  return a.userId === b.userId && a.kind === b.kind &&
    (a.kind === "session" && b.kind === "session"
      ? a.sessionId === b.sessionId
      : a.kind === "agent" && b.kind === "agent" && a.grantId === b.grantId);
}
export function createLaunch(input: {
  projectId: string;
  commit: string;
  entrypoint: string;
  files: Map<string, Buffer>;
  principal: LaunchPrincipal;
  dataOrigins: readonly string[];
  edit?: boolean;
}): Launch {
  for (const [id, snapshot] of snapshots)
    if (snapshot.launch.expiresAt <= Date.now()) snapshots.delete(id);
  if (snapshots.size >= 100)
    throw new Error("Too many active previews. Stop a preview and retry.");
  const id = randomBytes(32).toString("base64url");
  const netlogo = isNetLogo(input.entrypoint);
  const marimo = isMarimo(input.entrypoint);
  if (marimo && !existsSync(new URL("index.html", marimoAssets)))
    throw new RuntimeConfigurationError("Marimo assets are missing. Run npm run setup:marimo on the Lab server.");
  if (netlogo || marimo) {
    assertRuntimeOrigins(settings.appOrigin, settings.runtimeOrigin);
    assertRuntimeOrigins(settings.forgejoUrl, settings.runtimeOrigin);
  }
  const origin = netlogo || marimo ? isolatedRuntimeOrigin(id, settings.runtimeOrigin) : settings.runtimeOrigin;
  const url = `${origin}/preview/${id}/${input.entrypoint.split("/").map(encodeURIComponent).join("/")}?lab-entry=1${netlogo ? "&disableWorkInProgress" : ""}`;
  const launch = {
    id,
    commit: input.commit,
    url,
    ...(netlogo ? { runtime: "netlogo" as const, standaloneUrl: `${url}&standalone=1` } : {}),
    ...(marimo ? { runtime: "marimo" as const } : {}),
    expiresAt: Date.now() + 10 * 60_000,
  };
  snapshots.set(id, {
    launch, projectId: input.projectId, entrypoint: input.entrypoint,
    files: new Map([...input.files].map(([path, bytes]) => [path, Buffer.from(bytes)])),
    principal: { ...input.principal }, dataOrigins: [...input.dataOrigins], origin, edit: input.edit ?? false,
  });
  return { ...launch };
}
export function launchFor(id: string, principal: LaunchPrincipal) {
  const snapshot = snapshotFor(id);
  return snapshot && samePrincipal(snapshot.principal, principal)
    ? { projectId: snapshot.projectId, expiresAt: snapshot.launch.expiresAt }
    : undefined;
}
export function revokeLaunch(id: string, principal: LaunchPrincipal): boolean {
  if (!launchFor(id, principal)) return false;
  return snapshots.delete(id);
}
export function revokeSessionLaunches(sessionId: string): void {
  for (const [id, snapshot] of snapshots)
    if (snapshot.principal.kind === "session" && snapshot.principal.sessionId === sessionId)
      snapshots.delete(id);
}
export function revokeProjectLaunches(projectId: string): void {
  for (const [id, snapshot] of snapshots)
    if (snapshot.projectId === projectId) snapshots.delete(id);
}
export function revokeUserProjectLaunches(userId: string, projectId: string): void {
  for (const [id, snapshot] of snapshots)
    if (snapshot.principal.userId === userId && snapshot.projectId === projectId)
      snapshots.delete(id);
}
export function revokeGrantLaunches(grantId: string): void {
  for (const [id, snapshot] of snapshots)
    if (snapshot.principal.kind === "agent" && snapshot.principal.grantId === grantId)
      snapshots.delete(id);
}
const types: Record<string, string> = {
  html: "text/html",
  js: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  txt: "text/plain",
  md: "text/plain",
  py: "text/plain",
  wasm: "application/wasm",
  zip: "application/zip",
  nlogo: "text/plain",
  nlogox: "application/xml",
};
export const runtime = new Hono();
runtime.use("*", async (c, next) => {
  const host = c.req.header("host");
  const id = /^\/(?:preview|bridge)\/([^/]+)\//.exec(c.req.path)?.[1];
  const snapshot = id ? snapshotFor(id) : undefined;
  const hostSnapshot = snapshot ?? (host !== new URL(settings.runtimeOrigin).host
    ? [...snapshots.values()].find((value) => value.launch.expiresAt > Date.now() && new URL(value.origin).host === host)
    : undefined);
  // Expired capability URLs still reach the ordinary "Preview expired" response.
  const expiredIsolatedHost = !snapshot && id && host === new URL(isolatedRuntimeOrigin(id, settings.runtimeOrigin)).host;
  if (snapshot ? host !== new URL(snapshot.origin).host : host !== new URL(settings.runtimeOrigin).host && !hostSnapshot && !expiredIsolatedHost)
    return c.text("Invalid host", 403);
  if (c.req.header("sec-fetch-dest") === "serviceworker" || c.req.header("service-worker") === "script")
    return c.text("Service workers are not supported", 403);
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  // Blob workers inherit the launch document's policy; data permission affects only fetches.
  const dataOrigins = hostSnapshot?.dataOrigins ?? [];
  const netlogo = !!hostSnapshot && isNetLogo(hostSnapshot.entrypoint);
  const marimo = !!hostSnapshot && isMarimo(hostSnapshot.entrypoint);
  if (netlogo || marimo) {
    c.header("Origin-Agent-Cluster", "?1");
    c.header("Cross-Origin-Opener-Policy", "same-origin");
    c.header("Permissions-Policy", "document-domain=(), camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), payment=()");
  }
  c.header(
    "Content-Security-Policy",
    marimo
      ? `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'self' blob: https://cdn.jsdelivr.net; style-src 'unsafe-inline' 'self'; img-src data: blob: 'self'; font-src data: 'self'; connect-src 'self' https://cdn.jsdelivr.net https://wasm.marimo.app https://pypi.org https://files.pythonhosted.org ${dataOrigins.join(" ")}; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${settings.appOrigin}; sandbox allow-scripts allow-same-origin allow-downloads`
      : netlogo
      ? `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'self' ${settings.runtimeOrigin}; style-src 'unsafe-inline' 'self'; img-src data: blob: 'self'; font-src data: 'self'; connect-src ${["'self'", settings.runtimeOrigin, ...dataOrigins].join(" ")}; worker-src blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${settings.appOrigin}; sandbox allow-scripts allow-same-origin allow-downloads allow-modals allow-forms`
      : `default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' ${settings.runtimeOrigin}; style-src 'unsafe-inline' ${settings.runtimeOrigin}; img-src data: blob: ${settings.runtimeOrigin}; font-src ${settings.runtimeOrigin}; connect-src ${[settings.runtimeOrigin, ...dataOrigins].join(" ")}; worker-src blob: ${settings.runtimeOrigin}; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${settings.appOrigin}; sandbox allow-scripts`,
  );
  await next();
});
runtime.get(`/vendor/marimo/${MARIMO_VERSION}/assets/:file`, (c) => {
  const file = c.req.param('file');
  if (!/^[A-Za-z0-9_.-]+$/.test(file)) return c.text('Not found', 404);
  try {
    const bytes = readFileSync(new URL(`assets/${file}`, marimoAssets));
    c.header('Content-Type', types[file.split('.').pop()!] ?? (file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream'));
    return c.body(new Uint8Array(bytes));
  } catch { return c.text('Marimo assets missing. Run npm run setup:marimo.', 404); }
});
runtime.get('/bridge/:id/files.json', (c) => {
  const snapshot = snapshotFor(c.req.param('id'));
  if (!snapshot || !isMarimo(snapshot.entrypoint)) return c.text('Preview expired', 404);
  return c.json(Object.fromEntries([...snapshot.files].map(([path, bytes]) => [path, bytes.toString('base64')])));
});
const pyodideFiles = new Set([
  "pyodide.mjs", "pyodide.asm.js", "pyodide.asm.wasm",
  "python_stdlib.zip", "pyodide-lock.json",
]);
runtime.get("/vendor/pyodide/0.29.5/:file", (c) => {
  const file = c.req.param("file");
  if (!pyodideFiles.has(file)) return c.text("File not found", 404);
  const data = readFileSync(new URL(`../node_modules/pyodide/${file}`, import.meta.url));
  c.header("Content-Type", types[file.split(".").pop()!] ?? "application/octet-stream");
  return c.body(new Uint8Array(data));
});
function snapshotFor(id: string) {
  const snapshot = snapshots.get(id);
  if (!snapshot || snapshot.launch.expiresAt <= Date.now()) {
    snapshots.delete(id);
    return undefined;
  }
  return snapshot;
}
runtime.get("/bridge/:id/bridge.js", (c) => {
  const snapshot = snapshotFor(c.req.param("id"));
  if (!snapshot) return c.text("Preview expired. Launch again from Lab.", 404);
  c.header("Content-Type", "text/javascript; charset=utf-8");
  return c.body(`(${installPreviewFit.toString()})(${JSON.stringify({ launchId: snapshot.launch.id, appOrigin: settings.appOrigin })});(${installBridge.toString()})(${JSON.stringify({
    launchId: snapshot.launch.id,
    appOrigin: settings.appOrigin,
    maxText: MAX_RUNTIME_TEXT,
    maxEvents: MAX_RUNTIME_EVENTS_PER_SECOND,
  })});`);
});
runtime.get("/bridge/:id/netlogo-player.html", (c) => {
  const snapshot = snapshotFor(c.req.param("id"));
  if (!snapshot || !isNetLogo(snapshot.entrypoint)) return c.text("Preview expired. Launch again from Lab.", 404);
  c.header("Content-Type", "text/html; charset=utf-8");
  return c.body(netLogoPlayer());
});
runtime.get("/preview/:id/*", (c) => {
  const snapshot = snapshotFor(c.req.param("id"));
  if (!snapshot) {
    return c.text("Preview expired. Launch again from Lab.", 404);
  }
  const rawPath = new URL(c.req.url).pathname.split("/").slice(3).join("/");
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return c.text("Invalid path", 400);
  }
  const file = snapshot.files.get(path);
  if (!file) return c.text("File not found", 404);
  if (path === snapshot.entrypoint && isNetLogo(path) && c.req.query("lab-entry") === "1") {
    c.header("Content-Type", "text/html; charset=utf-8");
    return c.body(netLogoDocument({ launchId: snapshot.launch.id, appOrigin: settings.appOrigin,
      path, source: file.toString("utf8"), standalone: c.req.query("standalone") === "1" }));
  }
  if (path === snapshot.entrypoint && isMarimo(path) && c.req.query("lab-entry") === "1") {
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(marimoDocument({ launchId: snapshot.launch.id, appOrigin: settings.appOrigin,
      path, source: file.toString('utf8'), edit: snapshot.edit }));
  }
  const type = types[path.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";
  c.header(
    "Content-Type",
    `${type}${type.startsWith("text/") ? "; charset=utf-8" : ""}`,
  );
  if (path === snapshot.entrypoint && type === "text/html" && c.req.query("lab-entry") === "1") {
    // Only the launch document is transformed. Source and ordinary asset reads remain exact.
    const body = file.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? file.subarray(3) : file;
    const prefix = Buffer.from(`<!doctype html><script src="/bridge/${snapshot.launch.id}/bridge.js"></script>`);
    return c.body(new Uint8Array(Buffer.concat([prefix, body])));
  }
  return c.body(new Uint8Array(file));
});

export const RUNTIME_CHANNEL = "lab-runtime";
export const RUNTIME_VERSION = 1;
export const MAX_RUNTIME_TEXT = 4096;
export const MAX_RUNTIME_EVENTS_PER_SECOND = 200;
export const MAX_RUNTIME_LINES = 1000;
export const RUNTIME_STOP_TIMEOUT_MS = 250;
export const MAX_NETLOGO_SOURCE_BYTES = 2_000_000;

interface RuntimeEnvelope {
  channel: typeof RUNTIME_CHANNEL;
  version: typeof RUNTIME_VERSION;
  launchId: string;
}

export type RuntimeEvent = RuntimeEnvelope &
  (
    | { type: "ready" }
    | {
        type: "console";
        level: "debug" | "info" | "log" | "warn" | "error";
        text: string;
      }
    | { type: "error"; text: string }
    | { type: "stopped"; workers: number }
    | { type: "marimo-save"; source: string }
    | { type: "marimo-export"; requestId: string; source: string }
    | { type: "netlogo-ready" }
    | { type: "netlogo-change" }
    | { type: "netlogo-open-required"; text: string }
    | { type: "netlogo-error"; text: string }
    | { type: "netlogo-export"; requestId: string; source: string }
  );

export type RuntimeStop = RuntimeEnvelope & { type: "stop" };
export type NetLogoCommand = RuntimeEnvelope & (
  | { type: "netlogo-export-request"; requestId: string }
  | { type: "netlogo-authoring"; enabled: boolean }
);

function envelope(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return (
    data.channel === RUNTIME_CHANNEL &&
    data.version === RUNTIME_VERSION &&
    typeof data.launchId === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(data.launchId)
  );
}

function keys(data: Record<string, unknown>, fields: string[]): boolean {
  const expected = ["channel", "version", "launchId", "type", ...fields];
  const actual = Object.keys(data);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_RUNTIME_TEXT;
}

// Callers also check source window, origin, active launch and message ports.
export function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  if (!envelope(value)) return false;
  switch (value.type) {
    case "ready":
    case "netlogo-ready":
    case "netlogo-change":
      return keys(value, []);
    case "console":
      return (
        keys(value, ["level", "text"]) &&
        ["debug", "info", "log", "warn", "error"].includes(value.level as string) &&
        text(value.text)
      );
    case "error":
    case "netlogo-error":
    case "netlogo-open-required":
      return keys(value, ["text"]) && text(value.text);
    case "marimo-save":
      return keys(value, ["source"]) && typeof value.source === "string" && value.source.length <= MAX_NETLOGO_SOURCE_BYTES && new TextEncoder().encode(value.source).length <= MAX_NETLOGO_SOURCE_BYTES;
    case "marimo-export":
    case "netlogo-export":
      return keys(value, ["requestId", "source"]) && requestId(value.requestId) &&
        typeof value.source === "string" && value.source.length <= MAX_NETLOGO_SOURCE_BYTES &&
        new TextEncoder().encode(value.source).length <= MAX_NETLOGO_SOURCE_BYTES;
    case "stopped":
      return (
        keys(value, ["workers"]) &&
        typeof value.workers === "number" &&
        Number.isInteger(value.workers) &&
        value.workers >= 0 &&
        value.workers <= 1000
      );
    default:
      return false;
  }
}

export function isRuntimeStop(value: unknown): value is RuntimeStop {
  return envelope(value) && value.type === "stop" && keys(value, []);
}

function requestId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

export function isNetLogoCommand(value: unknown): value is NetLogoCommand {
  if (!envelope(value)) return false;
  return value.type === "netlogo-export-request"
    ? keys(value, ["requestId"]) && requestId(value.requestId)
    : value.type === "netlogo-authoring" && keys(value, ["enabled"]) && typeof value.enabled === "boolean";
}

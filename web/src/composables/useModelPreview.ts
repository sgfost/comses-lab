import { ref, watch, onUnmounted, type Ref } from "vue";
import type { Launch, LaunchStatus, FileChange } from "../../../shared/contracts";
import {
  RUNTIME_CHANNEL,
  RUNTIME_VERSION,
  MAX_RUNTIME_EVENTS_PER_SECOND,
  MAX_RUNTIME_LINES,
  RUNTIME_STOP_TIMEOUT_MS,
  isRuntimeEvent,
  type RuntimeEvent,
} from "../../../shared/runtime";
import { api, ApiRequestError, demoMode } from "../api";
type Level = Extract<RuntimeEvent, { type: "console" }>["level"];
export interface ConsoleLine {
  id: number;
  time: string;
  level: Level;
  text: string;
}
export function useModelPreview(options: {
  projectId: string;
  iframe: Ref<HTMLIFrameElement | undefined>;
  commit: () => string | undefined;
  signedIn: () => boolean;
  signIn: () => void;
  changes: () => FileChange[];
  netlogoChanged?: () => void;
}) {
  const launch = ref<Launch | null>(null);
  const launching = ref(false);
  const stopping = ref(false);
  const error = ref("");
  const lines = ref<ConsoleLine[]>([]);
  const activity = ref<{ time: string; text: string }[]>([]);
  const netlogoReady = ref(false);
  const netlogoNotice = ref("");
  let fitPreview = true;
  let pendingExport: { id: string; resolve: (source: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  let generation = 0;
  let disposed = false;
  let lineId = 0;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  let statusRequest: { id: string; controller: AbortController } | undefined;
  let checkAgain = false;
  function clearStatusCheck() {
    clearTimeout(statusTimer);
    statusTimer = undefined;
    statusRequest?.controller.abort();
    statusRequest = undefined;
    checkAgain = false;
  }
  function endUncheckedPreview(value: Launch, message: string) {
    if (launch.value?.id !== value.id) return;
    clearStatusCheck();
    deactivate();
    launch.value = null;
    error.value = message;
    record(message);
    void revoke(value);
  }
  async function checkStatus() {
    clearTimeout(statusTimer);
    statusTimer = undefined;
    const value = launch.value;
    if (!value || disposed || stopping.value) return;
    if (statusRequest) { checkAgain = true; return; }
    const request = { id: value.id, controller: new AbortController() };
    statusRequest = request;
    const timeout = setTimeout(() => request.controller.abort(), 5000);
    try {
      const result = await api<LaunchStatus>(`/launches/${value.id}`, { signal: request.controller.signal });
      if (statusRequest !== request || launch.value?.id !== value.id || disposed) return;
      if (result.id !== value.id || result.state !== "active" || !Number.isFinite(result.expiresAt)) throw new Error("Invalid launch status");
    } catch (cause) {
      if (statusRequest !== request || launch.value?.id !== value.id || disposed) return;
      const revoked = cause instanceof ApiRequestError && (cause.status === 401 || cause.status === 404);
      endUncheckedPreview(value, revoked ? "Preview access ended. Run again." : "Preview connection failed. Run again.");
    } finally {
      clearTimeout(timeout);
      if (statusRequest === request) {
        statusRequest = undefined;
        if (launch.value?.id === value.id && !disposed && !stopping.value) {
          const delay = checkAgain ? 0 : 2000;
          checkAgain = false;
          statusTimer = setTimeout(() => void checkStatus(), delay);
        }
      }
    }
  }
  function visible() {
    if (document.visibilityState === "visible") void checkStatus();
  }
  let active:
    | {
        id: string;
        window: Window;
        origin: string;
        ready: boolean;
        started: number;
        count: number;
        suppressed: boolean;
      }
    | undefined;
  let pendingStop: Promise<void> | undefined;
  let finishStop: (() => void) | undefined;
  function record(text: string) {
    activity.value.push({
      time: new Date().toLocaleTimeString([], { hour12: false }),
      text,
    });
    if (activity.value.length > 500) activity.value.shift();
  }
  function append(level: Level, text: string) {
    const time = new Date().toLocaleTimeString([], { hour12: false });
    const added = text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .slice(-MAX_RUNTIME_LINES)
      .map((text) => ({ id: ++lineId, time, level, text }));
    lines.value = [...lines.value, ...added].slice(-MAX_RUNTIME_LINES);
  }
  function receive(event: MessageEvent) {
    if (!active || event.source !== active.window || event.origin !== active.origin)
      return;
    if (event.ports.length) {
      for (const port of event.ports) port.close();
      return;
    }
    const now = performance.now();
    if (now - active.started >= 1000) {
      active.started = now;
      active.count = 0;
      active.suppressed = false;
    }
    if (++active.count > MAX_RUNTIME_EVENTS_PER_SECOND) {
      if (!active.suppressed) {
        active.suppressed = true;
        append(
          "warn",
          "Console rate limit reached; further messages are suppressed for this second.",
        );
      }
      return;
    }
    if (!isRuntimeEvent(event.data) || event.data.launchId !== active.id)
      return;
    const data = event.data;
    if (data.type.startsWith("netlogo-") && launch.value?.runtime !== "netlogo") return;
    if (data.type === "ready") {
      if (!active.ready) {
        active.ready = true;
        record("Runtime bridge ready");
        setPreviewFit(fitPreview);
      }
    } else if (data.type === "netlogo-ready") netlogoReady.value = true;
    else if (data.type === "netlogo-change") options.netlogoChanged?.();
    else if (data.type === "netlogo-open-required") netlogoNotice.value = data.text;
    else if (data.type === "netlogo-export" && pendingExport?.id === data.requestId) {
      const pending = pendingExport;
      pendingExport = undefined;
      clearTimeout(pending.timer);
      pending.resolve(data.source);
    } else if (data.type === "netlogo-error") {
      append("error", data.text);
      if (pendingExport) { clearTimeout(pendingExport.timer); pendingExport.reject(new Error(data.text)); pendingExport = undefined; }
    } else if (data.type === "console") append(data.level, data.text);
    else if (data.type === "error") append("error", data.text);
    // A model's unsolicited stopped report cannot stop a host preview.
  }
  function deactivate() {
    netlogoReady.value = false;
    netlogoNotice.value = "";
    if (pendingExport) { clearTimeout(pendingExport.timer); pendingExport.reject(new Error("The preview changed before its model could be read")); pendingExport = undefined; }
    active = undefined;
    window.removeEventListener("message", receive);
  }
  watch(
    options.iframe,
    (element) => {
      deactivate();
      if (
        !disposed &&
        !stopping.value &&
        launch.value &&
        element?.contentWindow
      ) {
        active = {
          id: launch.value.id,
          window: element.contentWindow,
          origin: !demoMode && launch.value.runtime === "netlogo" ? new URL(launch.value.url).origin : "null",
          ready: false,
          started: performance.now(),
          count: 0,
          suppressed: false,
        };
        window.addEventListener("message", receive);
      }
    },
    { flush: "post" },
  );
  async function revoke(value: Launch) {
    await api(`/launches/${value.id}`, {
      method: "DELETE",
      keepalive: true,
    }).catch(() => {});
  }
  function waitForStop(value: Launch, child: Window) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        window.removeEventListener("message", acknowledge);
        if (finishStop === done) finishStop = undefined;
        resolve();
      };
      const acknowledge = (event: MessageEvent) => {
        if (
          event.source !== child ||
          event.origin !== (!demoMode && value.runtime === "netlogo" ? new URL(value.url).origin : "null") ||
          event.ports.length ||
          event.data?.type !== "stopped"
        )
          return;
        if (isRuntimeEvent(event.data) && event.data.launchId === value.id)
          done();
      };
      const timer = setTimeout(done, RUNTIME_STOP_TIMEOUT_MS);
      finishStop = done;
      window.addEventListener("message", acknowledge);
      try {
        child.postMessage(
          {
            channel: RUNTIME_CHANNEL,
            version: RUNTIME_VERSION,
            launchId: value.id,
            type: "stop",
          },
          "*",
        );
      } catch {
        done();
      }
    });
  }
  function stop(): Promise<void> {
    clearStatusCheck();
    generation++;
    launching.value = false;
    deactivate();
    if (pendingStop) return pendingStop;
    const value = launch.value;
    if (!value) return Promise.resolve();
    stopping.value = true;
    const child = options.iframe.value?.contentWindow;
    pendingStop = (async () => {
      if (child && !disposed) await waitForStop(value, child);
      if (launch.value?.id === value.id) launch.value = null;
      record("Stopped");
      stopping.value = false;
      void revoke(value);
    })().finally(() => {
      pendingStop = undefined;
    });
    return pendingStop;
  }
  function cancelPending() {
    generation++;
    launching.value = false;
  }
  function setPreviewFit(enabled: boolean) {
    fitPreview = enabled;
    if (!active?.ready) return;
    active.window.postMessage({ channel: RUNTIME_CHANNEL, version: RUNTIME_VERSION, launchId: active.id, type: "preview-fit", enabled }, active.origin === "null" ? "*" : active.origin);
  }
  function netlogoCommand(fields: Record<string, unknown>) {
    if (!active || !netlogoReady.value || launch.value?.runtime !== "netlogo") throw new Error("NetLogo is not ready");
    active.window.postMessage({ channel: RUNTIME_CHANNEL, version: RUNTIME_VERSION, launchId: active.id, ...fields }, active.origin === "null" ? "*" : active.origin);
  }
  function setNetlogoAuthoring(enabled: boolean) {
    if (netlogoReady.value) netlogoCommand({ type: "netlogo-authoring", enabled });
  }
  function waitForNetlogo(): Promise<void> {
    if (!launch.value || launch.value.runtime !== "netlogo") return Promise.reject(new Error(error.value || "The NetLogo preview did not start."));
    if (netlogoReady.value) return Promise.resolve();
    const id = launch.value.id;
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); unwatch(); error ? reject(error) : resolve(); };
      const timer = setTimeout(() => finish(new Error("NetLogo did not become ready. Check the model's error in the preview.")), 15000);
      const unwatch = watch([netlogoReady, launch], () => {
        if (launch.value?.id !== id) finish(new Error("The preview changed. Try again."));
        else if (netlogoReady.value) finish();
      });
    });
  }
  function exportNetlogo(): Promise<string> {
    if (pendingExport) return Promise.reject(new Error("A model export is already in progress"));
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { if (pendingExport?.id === id) { pendingExport = undefined; reject(new Error("NetLogo did not return its model. Try again or export from Open model.")); } }, 5000);
      pendingExport = { id, resolve, reject, timer };
      try { netlogoCommand({ type: "netlogo-export-request", requestId: id }); }
      catch (cause) { clearTimeout(timer); pendingExport = undefined; reject(cause); }
    });
  }
  const run = () => start(options.changes());
  const runSaved = () => start([]);
  async function start(changes: FileChange[]) {
    if (!options.signedIn()) {
      options.signIn();
      return;
    }
    const commit = options.commit();
    if (!commit) return;
    const stoppedGeneration = generation + 1;
    await stop();
    if (disposed || generation !== stoppedGeneration || options.commit() !== commit) return;
    const request = ++generation;
    launching.value = true;
    error.value = "";
    try {
      const result = await api<Launch>(
        `/projects/${options.projectId}/launch`,
        { method: "POST", body: JSON.stringify({ commit, ...(changes.length ? { changes } : {}) }) },
      );
      if (disposed || request !== generation || options.commit() !== commit) {
        await revoke(result);
        return;
      }
      lines.value = [];
      launch.value = result;
      void checkStatus();
      record(`Started ${commit.slice(0, 8)}`);
    } catch (cause) {
      if (!disposed && request === generation)
        error.value = (cause as Error).message;
    } finally {
      if (request === generation) launching.value = false;
    }
  }
  function teardown() {
    disposed = true;
    clearStatusCheck();
    generation++;
    deactivate();
    finishStop?.();
    const value = launch.value;
    launch.value = null;
    if (value) void revoke(value);
  }
  function restore(event: PageTransitionEvent) {
    if (event.persisted) disposed = false;
    visible();
  }
  document.addEventListener("visibilitychange", visible);
  window.addEventListener("pagehide", teardown);
  window.addEventListener("pageshow", restore);
  onUnmounted(() => {
    document.removeEventListener("visibilitychange", visible);
    window.removeEventListener("pagehide", teardown);
    window.removeEventListener("pageshow", restore);
    teardown();
  });
  return { launch, launching, stopping, error, lines, activity, run, runSaved, stop, cancelPending, netlogoReady, netlogoNotice, exportNetlogo, setNetlogoAuthoring, waitForNetlogo, setPreviewFit };
}

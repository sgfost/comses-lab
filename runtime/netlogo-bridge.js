// Serialized into the pinned player before upstream scripts. It has no Lab credentials.
export function installNetLogoBridge({ launchId, appOrigin, standalone, maxSourceBytes, playerUrl }) {
  const envelope = { channel: "lab-runtime", version: 1, launchId };
  const send = (event) => {
    if (!standalone && parent !== window) parent.postMessage({ ...envelope, ...event }, appOrigin);
  };
  const fail = (error) => send({ type: "netlogo-error", text: String(error?.message || error).slice(0, 4096) });
  let session;
  let authoring = false;
  let changedTimer;
  let stopped = false;
  // The generated player calls this at its pinned load-result boundary, including
  // parse failures that never create a session or emit a JavaScript error.
  globalThis.__labNetLogoLoad = (result) => {
    if (result.type !== "success") {
      const errors = Array.isArray(result.errors) ? result.errors.map((error) => typeof error === "string" ? error : error.message || JSON.stringify(error)).join("\n") : "";
      fail(errors || "NetLogo could not load this model. Check the error shown in the player.");
    }
  };

  // Upstream accepts arbitrary nlw-* messages. Only its own internal messages may
  // reach those listeners; Lab commands are handled here, never forwarded verbatim.
  addEventListener("message", (event) => {
    if (event.source === window && event.ports.length === 0) return;
    const data = event.data;
    if (standalone || event.source !== parent || event.origin !== appOrigin || event.ports.length ||
        !data || typeof data !== "object" || Array.isArray(data) || data.channel !== envelope.channel ||
        data.version !== envelope.version || data.launchId !== launchId) {
      for (const port of event.ports) port.close();
      event.stopImmediatePropagation();
      return;
    }
    const exact = (fields) => {
      const keys = ["channel", "version", "launchId", "type", ...fields];
      return Object.keys(data).length === keys.length && Object.keys(data).every((key) => keys.includes(key));
    };
    if (data.type === "stop" && exact([])) {
      stopped = true;
      clearTimeout(changedTimer);
      session?.widgetController.pauseForevers();
      return; // The ordinary runtime bridge acknowledges and terminates workers.
    }
    event.stopImmediatePropagation();
    if (stopped) return;
    try {
      if (data.type === "netlogo-export-request" && exact(["requestId"]) &&
          typeof data.requestId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(data.requestId)) {
        if (!session) throw new Error("The NetLogo model is not ready to export.");
        const result = session.getNlogo();
        if (!result.success || typeof result.result !== "string") throw new Error("NetLogo could not export the current model. Check its code and interface.");
        if (new TextEncoder().encode(result.result).length > maxSourceBytes) throw new Error("The edited model exceeds the 2 MB source limit.");
        send({ type: "netlogo-export", requestId: data.requestId, source: result.result });
      } else if (data.type === "netlogo-authoring" && exact(["enabled"]) && typeof data.enabled === "boolean") {
        authoring = data.enabled;
        applyAuthoring();
      }
    } catch (error) { fail(error); }
  }, true);

  function applyAuthoring() {
    document.documentElement.classList.toggle("lab-netlogo-authoring", authoring);
    if (session && !standalone) session.widgetController.ractive.set("isEditing", authoring);
  }
  function changed() {
    if (stopped || !authoring) return;
    clearTimeout(changedTimer);
    changedTimer = setTimeout(() => send({ type: "netlogo-change" }), 100);
  }
  function attach() {
    if (stopped) return;
    if (globalThis.session && globalThis.session !== session) {
      session = globalThis.session;
      const ractive = session.widgetController.ractive;
      if (!standalone) ractive.observe("isEditing", (enabled) => {
        if (enabled !== authoring) ractive.set("isEditing", authoring);
      });
      // The standalone bundle already contains its color picker. Upstream's HTML
      // export otherwise tries to fetch an asset from the Galapagos web server.
      session.widgetController.onBeforeExportHTMLFetch = async () => {};
      window.standaloneURL = playerUrl || `/bridge/${launchId}/netlogo-player.html`;
      for (const name of ["code-changed", "new-widget-finalized", "widget-updated", "widget-deleted", "widget-moved", "info-updated", "title-changed"])
        ractive.on(`*.${name}`, changed);
      // Info's editor updates this value while typing; its upstream event only
      // fires after leaving authoring mode, which is too late for draft capture.
      ractive.observe("info", changed, { init: false });
      ractive.on("*.runtime-error", (_event, _context, error) => fail(error || "NetLogo reported a runtime error."));
      ractive.on("*.compiler-error", () => fail("NetLogo could not compile the model. Check the error shown in the player."));
      applyAuthoring();
      send({ type: "netlogo-ready" });
    }
  }
  const check = setInterval(attach, 100);
  addEventListener("pagehide", () => { clearInterval(check); clearTimeout(changedTimer); });
  addEventListener("DOMContentLoaded", () => {
    document.documentElement.classList.add("lab-netlogo");
    if (!standalone) {
      const style = document.createElement("style");
      style.textContent = ".lab-netlogo:not(.lab-netlogo-authoring) #netlogo-code-tab,.lab-netlogo:not(.lab-netlogo-authoring) #tab-code{display:none!important} .lab-netlogo #authoring-lock,.lab-netlogo [aria-label='File Options']{display:none!important}";
      document.head.append(style);
    }
    attach();
  });
}

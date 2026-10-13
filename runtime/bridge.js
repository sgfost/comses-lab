// Serialized into a classic script by the runtime server. Keep this function self-contained.
export function installBridge({ launchId, appOrigin, maxText, maxEvents }) {
  const sendToParent = parent.postMessage.bind(parent);
  const nativeTerminate = Worker.prototype.terminate;
  const workers = new Set();
  let stopped = false;
  let interval = performance.now();
  let count = 0;
  const envelope = { channel: 'lab-runtime', version: 1, launchId };
  function send(event) {
    sendToParent({ ...envelope, ...event }, appOrigin);
  }
  function output(event) {
    if (stopped) return;
    const now = performance.now();
    if (now - interval >= 1000) { interval = now; count = 0; }
    count++;
    if (count < maxEvents) send(event);
    else if (count === maxEvents)
      send({ type: 'console', level: 'warn', text: 'Console output rate exceeded; further messages suppressed for this second.' });
  }
  function format(value, depth = 0) {
    if (typeof value === 'string') return value.slice(0, maxText);
    if (value instanceof Error) return String(value.stack || value.message).slice(0, maxText);
    if (value === null || typeof value !== 'object') return String(value).slice(0, maxText);
    if (depth >= 2) return Array.isArray(value) ? '[…]' : '{…}';
    try {
      // Do not invoke user getters while inspecting console arguments.
      const parts = Object.keys(value).slice(0, 20).map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return `${key}: ${descriptor && 'value' in descriptor ? format(descriptor.value, depth + 1) : '[Getter]'}`;
      });
      return `{${parts.join(', ')}}`.slice(0, maxText);
    } catch { return '[Uninspectable value]'; }
  }
  for (const level of ['debug', 'info', 'log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      try {
        output({ type: 'console', level, text: args.slice(0, 20).map(value => format(value)).join(' ').slice(0, maxText) });
      } catch { /* Model objects may throw during inspection. */ }
    };
  }
  const reportError = event => output({ type: 'error', text: String(event.message || 'Worker script failed').slice(0, maxText) });
  addEventListener('error', reportError);
  addEventListener('unhandledrejection', event => {
    output({ type: 'error', text: format(event.reason).slice(0, maxText) });
  });
  const NativeWorker = Worker;
  globalThis.Worker = class extends NativeWorker {
    constructor(...args) {
      if (stopped || workers.size >= 1000) throw new Error('Worker limit reached or preview stopped');
      super(...args);
      workers.add(this);
      this.addEventListener('error', reportError);
    }
    terminate() {
      workers.delete(this);
      return nativeTerminate.call(this);
    }
  };
  addEventListener('message', event => {
    if (stopped || event.source !== parent || event.origin !== appOrigin || event.ports.length) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        Object.keys(data).length !== 4 || data.channel !== envelope.channel ||
        data.version !== envelope.version || data.launchId !== launchId || data.type !== 'stop') return;
    stopped = true;
    const count = workers.size;
    for (const worker of workers) nativeTerminate.call(worker);
    workers.clear();
    send({ type: 'stopped', workers: count });
  });
  send({ type: 'ready' });
}

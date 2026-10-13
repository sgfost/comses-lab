// Display-only sizing in the isolated launch document; saved source stays untouched.
export function installPreviewFit({ launchId, appOrigin }) {
  let enabled = false;
  let frame = 0;
  let observer;
  let style;
  const root = document.documentElement;
  function schedule() {
    if (enabled && !frame) frame = requestAnimationFrame(fit);
  }
  function fit() {
    frame = 0;
    if (!enabled || !document.body || !style) return;
    const width = Math.max(1, innerWidth - 24);
    // A fixed layout width keeps responsive canvases from growing as we zoom out.
    const rules = `html.lab-preview-fit{height:100%!important;overflow:hidden!important;display:grid!important;place-items:center!important}
      .lab-preview-fit body{box-sizing:border-box!important;width:${width}px!important;margin:0!important;zoom:var(--lab-preview-scale,1)!important;translate:var(--lab-preview-offset,0 0)!important}`;
    if (style.textContent !== rules) style.textContent = rules;
    root.classList.add('lab-preview-fit');
    const body = document.body;
    const naturalWidth = Math.max(body.offsetWidth, body.scrollWidth, 1);
    const naturalHeight = Math.max(body.offsetHeight, body.scrollHeight, 1);
    const scale = Math.min(1, Math.max(1, innerWidth - 24) / naturalWidth, Math.max(1, innerHeight - 24) / naturalHeight);
    // Grid centers the body box; include overflowing fixed-width widgets as well.
    const offset = `${(body.offsetWidth - naturalWidth) / 2}px ${(body.offsetHeight - naturalHeight) / 2}px`;
    if (root.style.getPropertyValue('--lab-preview-offset') !== offset) root.style.setProperty('--lab-preview-offset', offset);
    const value = String(scale);
    if (root.style.getPropertyValue('--lab-preview-scale') !== value) root.style.setProperty('--lab-preview-scale', value);
  }
  function start() {
    if (!document.body || style) return;
    style = document.createElement('style');
    document.head.append(style);
    observer = new ResizeObserver(schedule);
    observer.observe(document.body);
    for (const child of document.body.children) observer.observe(child);
    schedule();
  }
  addEventListener('message', event => {
    if (event.source !== parent || event.origin !== appOrigin || event.ports.length) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        Object.keys(data).length !== 5 || data.channel !== 'lab-runtime' || data.version !== 1 ||
        data.launchId !== launchId || data.type !== 'preview-fit' || typeof data.enabled !== 'boolean') return;
    event.stopImmediatePropagation();
    enabled = data.enabled;
    root.classList.toggle('lab-preview-fit', enabled);
    if (enabled) { start(); schedule(); }
  }, true);
  addEventListener('DOMContentLoaded', start, { once: true });
  addEventListener('resize', schedule);
  addEventListener('pagehide', () => { observer?.disconnect(); cancelAnimationFrame(frame); });
}

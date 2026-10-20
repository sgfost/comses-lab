import { readFileSync } from 'node:fs';
import { installMarimoBridge } from './marimo-bridge.js';

export const MARIMO_VERSION = '0.25.1';
export const marimoAssets = new URL(`./vendor/marimo/${MARIMO_VERSION}/static/`, import.meta.url);
export const isMarimo = (path: string) => /\.py$/i.test(path);
const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

export function marimoDocument(input: { launchId: string; appOrigin: string; path: string; source: string; edit: boolean }) {
  let html = readFileSync(new URL('index.html', marimoAssets), 'utf8');
  html = html.replaceAll('./assets/', `/vendor/marimo/${MARIMO_VERSION}/assets/`);
  html = html.replace(/<script data-marimo="true">\s*Object.defineProperty[\s\S]*?<\/script>/, '');
  return html.replace('<head>', `<head><meta charset="utf-8"><script src="/bridge/${input.launchId}/bridge.js"></script><script>(${installMarimoBridge.toString()})(${json({ ...input, version: MARIMO_VERSION })});</script><marimo-wasm hidden></marimo-wasm>`);
}

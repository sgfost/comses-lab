// A plain static host, also used to verify deployment below a GitHub Pages repo path.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = resolve('web/dist-demo');
const base = process.env.DEMO_BASE || '/comses-lab/';
if (!/^\/(?:[\w-]+\/)*$/.test(base)) throw new Error('DEMO_BASE must be an absolute directory path ending in /');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml' };
const port = Number(process.env.DEMO_PORT || 5200);
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/' && base !== '/') { res.writeHead(302, { Location: base }); res.end(); return; }
    if (!url.pathname.startsWith(base)) throw new Error('Missing');
    let path = resolve(root, decodeURIComponent(url.pathname.slice(base.length)) || 'index.html');
    if (!path.startsWith(root + sep)) throw new Error('Invalid path');
    if ((await stat(path)).isDirectory()) path = resolve(path, 'index.html');
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
    res.end(await readFile(path));
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`Static demo: http://localhost:${port}${base}`));

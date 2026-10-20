import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const directory = new URL('../runtime/vendor/marimo/0.25.1/', import.meta.url);
const provenance = JSON.parse(await readFile(new URL('provenance.json', directory), 'utf8'));
const response = await fetch(provenance.url, { signal: AbortSignal.timeout(120_000) });
if (!response.ok) throw new Error(`Marimo download failed: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (bytes.length !== provenance.bytes || createHash('sha256').update(bytes).digest('hex') !== provenance.sha256)
  throw new Error('Marimo wheel integrity mismatch');
const temporary = await mkdtemp(join(tmpdir(), 'lab-marimo-'));
try {
  const wheel = join(temporary, 'marimo.whl');
  await writeFile(wheel, bytes);
  await mkdir(new URL('static/', directory), { recursive: true });
  execFileSync('python3', ['-c', `
import pathlib, sys, zipfile
root = pathlib.Path(sys.argv[2])
with zipfile.ZipFile(sys.argv[1]) as wheel:
    for item in wheel.infolist():
        prefix = 'marimo/_static/'
        if not item.filename.startswith(prefix) or item.is_dir(): continue
        relative = pathlib.PurePosixPath(item.filename[len(prefix):])
        if relative.is_absolute() or '..' in relative.parts: raise ValueError('Unsafe wheel path')
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(wheel.read(item))
`, wheel, fileURLToPath(new URL('static/', directory))], { stdio: 'inherit' });
} finally { await rm(temporary, { recursive: true, force: true }); }
// Embedded notebooks save through Lab, not Marimo's share-by-URL fallback.
// Updating a parent-created blob URL's hash throws in Firefox's opaque sandbox.
const router = new URL('static/assets/cells-CzugpTQu.js', directory);
const upstream = await readFile(router, 'utf8');
const original = 'setCodeForHash(e){window.location.hash=`#code/${e}`}';
if (upstream.split(original).length !== 2) throw new Error('Marimo URL store changed; review the pinned adapter');
await writeFile(router, upstream.replace(original, 'setCodeForHash(e){if(!window.__MARIMO_MOUNT_CONFIG__?.fileStores?.length)window.location.hash=`#code/${e}`}'));
console.log(`Marimo ${provenance.version}: verified and extracted browser assets.`);

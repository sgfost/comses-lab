import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const [commit, repository = root, destination = root] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(commit ?? ''))
  throw new Error('Use an exact 40-character Git commit: node scripts/vendor-diffusion.mjs <commit> [repository] [destination]');
const objectType = execFileSync('git', ['-C', resolve(repository), 'cat-file', '-t', commit], { encoding: 'utf8' }).trim();
if (objectType !== 'commit') throw new Error('The source revision must identify a Git commit');
const path = 'examples/python/diffusion.py';
const bytes = execFileSync('git', ['-C', resolve(repository), 'show', `${commit}:${path}`]);
const pin = { source: 'comses-lab', commit, path, sha256: createHash('sha256').update(bytes).digest('hex') };
for (const directory of ['python-pulse', 'python-alternating']) {
  const target = resolve(destination, 'examples', directory);
  mkdirSync(resolve(target, 'vendor'), { recursive: true });
  writeFileSync(resolve(target, 'vendor/diffusion.py'), bytes);
  writeFileSync(resolve(target, 'component.json'), JSON.stringify(pin, null, 2) + '\n');
}
console.log(`Vendored ${path} at ${commit}; SHA-256 ${pin.sha256}`);

// Produces a Firefox-compatible build from the Chrome `dist/` output.
//
// @crxjs targets Chrome and emits an MV3 `background.service_worker`. Firefox
// MV3 uses a non-persistent background `scripts` entry instead and requires a
// `browser_specific_settings.gecko` block. Rather than fight the bundler, we
// take the finished Chrome build and rewrite only the manifest for Firefox.
//
// Usage: node scripts/build-firefox.mjs   (run `npm run build` first)

import { cpSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'dist');
const out = resolve(root, 'dist-firefox');

if (!existsSync(resolve(src, 'manifest.json'))) {
  console.error('dist/manifest.json not found — run `npm run build` first.');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });

const manifest = JSON.parse(readFileSync(resolve(out, 'manifest.json'), 'utf8'));

// service_worker → background.scripts (keep the module type). The bundled
// worker file is a valid ES module, which Firefox loads as a background script.
const worker = manifest.background?.service_worker;
if (worker) {
  manifest.background = { scripts: [worker], type: manifest.background.type ?? 'module' };
}

// Firefox requires an add-on id for MV3.
manifest.browser_specific_settings = {
  gecko: {
    id: 'refindery-capture@refindery',
    strict_min_version: '128.0',
  },
};

writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log(`Firefox build written to ${out}`);
console.log('Load it via about:debugging → This Firefox → Load Temporary Add-on → manifest.json');

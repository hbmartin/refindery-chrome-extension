import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(rootDir, 'dist');

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const [pkg, manifest] = await Promise.all([
  readJson(path.join(rootDir, 'package.json')),
  readJson(path.join(distDir, 'manifest.json')),
]);

if (manifest.manifest_version !== 3) {
  throw new Error(`Expected a Manifest V3 build, received ${manifest.manifest_version}`);
}

if (manifest.version !== pkg.version) {
  throw new Error(
    `Manifest version ${manifest.version} does not match package version ${pkg.version}`,
  );
}

const declaredAssets = new Set();
const add = (value) => {
  if (typeof value === 'string' && value.length > 0) declaredAssets.add(value);
};
const addValues = (record) => Object.values(record ?? {}).forEach(add);

addValues(manifest.icons);
addValues(manifest.action?.default_icon);
add(manifest.action?.default_popup);
add(manifest.options_page);
add(manifest.options_ui?.page);
add(manifest.background?.service_worker);
add(manifest.devtools_page);
add(manifest.side_panel?.default_path);
addValues(manifest.chrome_url_overrides);

for (const script of manifest.content_scripts ?? []) {
  script.js?.forEach(add);
  script.css?.forEach(add);
}

for (const resourceGroup of manifest.web_accessible_resources ?? []) {
  resourceGroup.resources?.forEach(add);
}

for (const asset of declaredAssets) {
  const normalized = path.posix.normalize(asset);
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Manifest asset escapes dist/: ${asset}`);
  }

  const assetPath = path.resolve(distDir, normalized);
  if (!assetPath.startsWith(`${distDir}${path.sep}`)) {
    throw new Error(`Manifest asset escapes dist/: ${asset}`);
  }

  const assetStat = await stat(assetPath).catch(() => null);
  if (!assetStat?.isFile()) {
    throw new Error(`Manifest asset is missing from dist/: ${asset}`);
  }
}

console.log(`Validated Manifest V3 package with ${declaredAssets.size} declared assets.`);

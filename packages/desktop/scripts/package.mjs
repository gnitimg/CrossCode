import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Produces a portable Windows build without repacking Electron.
 *
 * `electron-builder` copies the Electron runtime and then deletes
 * `default_app.asar`; on machines where antivirus/indexers hold that file the
 * delete fails with EBUSY. This script copies the runtime instead (skipping
 * that file) and drops the app into `resources/app`, which is exactly the
 * layout Electron loads, so the result is a normal portable app.
 *
 * Layout:
 *   release/CrossCode/CrossCode.exe
 *   release/CrossCode/resources/app/{main.cjs,preload.cjs,package.json}
 *   release/CrossCode/resources/build/tray.png
 *   release/CrossCode/resources/web/**            (workbench build)
 */

const root = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(root, '..');
const electronDist = path.join(packageRoot, 'node_modules/electron/dist');
const webDist = path.resolve(packageRoot, '../web/dist');
const outDir = path.join(packageRoot, 'release/CrossCode');

function fail(message) {
  console.error(`[package] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(electronDist)) {
  fail(`Electron runtime not found at ${electronDist} — run "pnpm install" first.`);
}
if (!fs.existsSync(path.join(webDist, 'index.html'))) {
  fail(`Workbench build not found at ${webDist} — run "pnpm --filter @crosscode/web build" first.`);
}
if (!fs.existsSync(path.join(packageRoot, 'build/tray.png'))) {
  const generated = spawnSync(process.execPath, [path.join(root, 'make-icons.mjs')], { stdio: 'inherit' });
  if (generated.status !== 0) fail('icon generation failed');
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// 1. Electron runtime, skipping the bundled default app.
fs.cpSync(electronDist, outDir, {
  recursive: true,
  filter: (src) => path.basename(src) !== 'default_app.asar',
});

const electronExe = path.join(outDir, 'electron.exe');
if (fs.existsSync(electronExe)) {
  fs.renameSync(electronExe, path.join(outDir, 'CrossCode.exe'));
}

// 2. Application payload.
const appDir = path.join(outDir, 'resources/app');
fs.mkdirSync(appDir, { recursive: true });
fs.copyFileSync(path.join(packageRoot, 'dist/main.cjs'), path.join(appDir, 'main.cjs'));
fs.copyFileSync(path.join(packageRoot, 'dist/preload.cjs'), path.join(appDir, 'preload.cjs'));

const manifest = {
  name: 'crosscode',
  productName: 'CrossCode',
  version: JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version,
  description: 'CrossCode desktop shell',
  main: 'main.cjs',
};
fs.writeFileSync(path.join(appDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const buildDir = path.join(outDir, 'resources/build');
fs.mkdirSync(buildDir, { recursive: true });
fs.copyFileSync(path.join(packageRoot, 'build/tray.png'), path.join(buildDir, 'tray.png'));
if (fs.existsSync(path.join(packageRoot, 'build/icon.png'))) {
  fs.copyFileSync(path.join(packageRoot, 'build/icon.png'), path.join(buildDir, 'icon.png'));
}

// 3. Workbench build (served by the embedded daemon).
fs.cpSync(webDist, path.join(outDir, 'resources/web'), { recursive: true });

console.log(`[package] portable build ready: ${outDir}`);
